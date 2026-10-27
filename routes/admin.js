'use strict';
/* Admin control room (mounted at the hidden ADMIN_PATH).
   Every action is audit-logged. Players can never reach these routes
   (requireRole('admin')), and player routes only ever query the
   logged-in user's own rows — role separation is enforced server-side. */
const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { now, randHex, sha256, hashPassword, validEmail, toMinor, esc, fromMinor } = require('../lib/util');
const { getS, getBool, setSetting, getCurrencies, getSettings } = require('../lib/settings');
const { requireLogin, requireRole, createSession, destroySession, destroyUserSessions, verifyTotp } = require('../lib/auth');
const { decideDeposit, decideWithdrawal, getBalances, postLedger } = require('../lib/money');
const { RAILS, getRail, isBlockedRail } = require('../lib/rails');
const { getExtensions, setExtension, EXTENSION_FIELDS } = require('../lib/extensions');
const { ensureUpcomingDraws, createTestDraw, settleDraw, publicDrawInfo } = require('../lib/draws');
const { runNow } = require('../lib/cron');
const notify = require('../lib/notify');
const audit = require('../lib/audit');
const ui = require('../lib/admin-ui');

/* STEALTH: the admin panel must not exist for anyone but a logged-in admin.
   Logged-out visitors used to be redirected to /login and logged-in players
   got 403 — both responses CONFIRM an admin area lives at this URL. Now any
   non-admin request to any admin path gets a plain 404, identical to a
   nonexistent page: no login form, no "access denied", no signal at all.
   Probes are recorded in the audit trail. The existing guards stay behind
   this as a second layer. */
router.use(async (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    try {
      await audit.log(req.db, { actorId: null, actorRole: 'anonymous', action: 'admin.probe', entity: 'admin', entityId: '', detail: { path: req.path }, ip: req.ip });
    } catch (e) { /* audit failure must never reveal the panel */ }
    return res.status(404).render('error', { status: 404, message: 'Page not found.' });
  }
  next();
});
router.use(requireLogin, requireRole('admin'));

/* ---------- helpers ---------- */
function adminPath(req) { return req.adminPath; }
function R(req, p) { return adminPath(req) + p; }
function pageOf(req, def = 1) { return Math.max(1, parseInt(req.query.page, 10) || def); }
const PER = 25;
function dateRange(req) {
  const to = req.query.to ? new Date(req.query.to + 'T23:59:59').getTime() : now();
  const from = req.query.from ? new Date(req.query.from + 'T00:00:00').getTime() : to - 30 * 86400000;
  return { from, to };
}
function fmtDateInput(ms) { return new Date(ms).toISOString().slice(0, 10); }
function d(ms) { return ms ? new Date(ms).toLocaleString() : '—'; }
function money(req, minor, cur) { return req.fmt(minor, cur); }
async function csrf(req) { return req.csrfToken; }

function shell(req, section, title, body) {
  return ui.layout({ adminPath: adminPath(req), section, title, body, csrf: req.csrfToken, flash: req.flashData || {}, assetV: req.app.locals.assetV || '1' });
}
const notFound = (req, res, msg) => res.status(404).send(shell(req, '', 'Not found', `<div class="alert a-err">${esc(msg)}</div>`));

/* ============================================================
   DASHBOARD — exposure + profit projections (admin only)
   ============================================================ */
router.get('/', async (req, res) => {
  const t = now(), day = t - 86400000;
  const users = await req.db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'player'");
  const ticketsToday = await req.db.get('SELECT COUNT(*) AS c, COALESCE(SUM(total),0) AS s FROM tickets WHERE created_at > ?', [day]);
  const winsToday = await req.db.get("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE type = 'win' AND created_at > ?", [day]);
  const pendDep = await req.db.get("SELECT COUNT(*) AS c FROM deposits WHERE status = 'pending'");
  const pendWd = await req.db.get("SELECT COUNT(*) AS c FROM withdrawals WHERE status = 'pending'");
  const openSup = await req.db.get("SELECT COUNT(*) AS c FROM support_tickets WHERE status = 'open'");

  // Exposure: money staked per number on upcoming (unscheduled-settled) draws
  const upcoming = await req.db.query("SELECT * FROM draws WHERE status = 'scheduled' ORDER BY close_at LIMIT 14");
  const expRows = [];
  for (const dr of upcoming) {
    const entries = await req.db.query(
      `SELECT t.pops, t.wager FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id
       WHERE te.draw_id = ? AND te.status = 'pending'`, [dr.id]);
    const per = Array(16).fill(0); let staked = 0;
    for (const e of entries) {
      const pops = JSON.parse(e.pops || '[]');
      for (const p of pops) per[p] += e.wager;
      staked += pops.length * e.wager;
    }
    expRows.push({ draw: dr, per, staked });
  }
  // Profit projection per upcoming draw: expected payout = staked * avg(mult/15)
  const prizes = await req.db.query('SELECT pops_count, multiplier FROM prize_table');
  const avgRtp = prizes.reduce((a, r) => a + r.multiplier / 15, 0) / Math.max(1, prizes.length);
  const expTable = ui.table(
    ['Draw', 'Staked', 'Top exposure #', 'Top exposure', 'Proj. payout', 'Proj. profit'],
    expRows.map(({ draw: dr, per, staked }) => {
      let topN = 1, topV = 0;
      for (let n = 1; n <= 15; n++) if (per[n] > topV) { topV = per[n]; topN = n; }
      const payout = Math.round(staked * avgRtp), profit = staked - payout;
      return [
        `${dr.draw_type} ${esc(dr.draw_date)}`,
        money(req, staked, getS(req.settings, 'base_currency', 'USD')),
        `<span class="ball-sm">${topN}</span>`,
        money(req, topV, getS(req.settings, 'base_currency', 'USD')),
        money(req, payout, getS(req.settings, 'base_currency', 'USD')),
        `<strong class="${profit >= 0 ? 'pos' : 'neg'}">${money(req, profit, getS(req.settings, 'base_currency', 'USD'))}</strong>`,
      ];
    })
  );
  // Per-number exposure heat for the nearest draw
  let heat = '';
  if (expRows.length) {
    const { draw: dr, per } = expRows[0];
    const max = Math.max(1, ...per.slice(1));
    heat = `<div class="heat">${per.slice(1).map((v, i) =>
      `<div class="heat-cell" style="--w:${Math.round(v / max * 100)}" title="#${i + 1}: ${money(req, v, getS(req.settings, 'base_currency', 'USD'))}"><span>${i + 1}</span></div>`).join('')}</div>
      <p class="muted">Exposure per number — nearest draw: ${dr.draw_type} ${esc(dr.draw_date)}</p>`;
  }

  // Operator P&L (ViserLab-style): all-time sold vs given prize vs profit/loss
  const soldAll = await req.db.get('SELECT COALESCE(SUM(total),0) AS s FROM tickets');
  const prizeAll = await req.db.get("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE type = 'win'");
  const overdueDraws = await req.db.get("SELECT COUNT(*) AS c FROM draws WHERE status = 'scheduled' AND close_at < ?", [now()]);
  // Settled-only RTP: never show a projected percentage as if it were real.
  // Until a draw has actually settled with real stakes, the honest value is "—".
  const settled = await req.db.get(
    `SELECT COALESCE(SUM(t.wager),0) AS staked, COALESCE(SUM(te.win_amount),0) AS paid
     FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id JOIN draws d ON d.id = te.draw_id
     WHERE d.status = 'settled' AND te.status IN ('won','lost')`);
  const rtpValue = settled.staked > 0 ? (settled.paid / settled.staked * 100).toFixed(1) + '%' : '—';
  // Login breakdown, last 30 days, from real login_history rows. Country is
  // NOT recorded (no geo-IP service is configured), so only browser + OS are
  // shown — no invented country donut.
  const loginRows = await req.db.query('SELECT browser, os FROM login_history WHERE created_at > ?', [now() - 30 * 86400000]);
  const share = (key) => { const m = {}; for (const r of loginRows) { const k = r[key] || 'Unknown'; m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 6); };
  const shareBars = (title, entries) => loginRows.length
    ? ui.card(title, entries.map(([k, c]) => `<div class="share-row"><span class="share-k">${esc(k)}</span><span class="share-bar"><span style="width:${Math.round(c / loginRows.length * 100)}%"></span></span><span class="share-v">${c} (${Math.round(c / loginRows.length * 100)}%)</span></div>`).join(''))
    : ui.card(title, '<p class="muted">No logins in the last 30 days.</p>');
  const loginCards = `<div class="grid2">${shareBars('Logins by browser (last 30 days)', share('browser'))}${shareBars('Logins by OS (last 30 days)', share('os'))}</div>
    <p class="muted">Country breakdown is not shown: logins do not record a country (no geo-IP service configured) — nothing is guessed.</p>`;
  const body = `
    ${ui.kpis([
      { n: money(req, soldAll.s, getS(req.settings, 'base_currency', 'USD')), l: 'Sold amount (all time)', href: R(req, '/reports?type=business') },
      { n: money(req, prizeAll.s, getS(req.settings, 'base_currency', 'USD')), l: 'Given prize (all time)', href: R(req, '/reports?type=business') },
      { n: money(req, soldAll.s - prizeAll.s, getS(req.settings, 'base_currency', 'USD')), l: (soldAll.s - prizeAll.s) >= 0 ? 'Profit (sold − prize)' : 'Loss (sold − prize)', href: R(req, '/reports?type=business') },
      { n: overdueDraws.c, l: 'Overdue draws — settle now', href: R(req, '/draws') },
      { n: users.c, l: 'Players', href: R(req, '/users') },
      { n: ticketsToday.c, l: 'Tickets (24h)', href: R(req, '/tickets') },
      { n: money(req, ticketsToday.s, getS(req.settings, 'base_currency', 'USD')), l: 'Staked (24h)', href: R(req, '/reports?type=business') },
      { n: money(req, winsToday.s, getS(req.settings, 'base_currency', 'USD')), l: 'Paid out (24h)', href: R(req, '/reports?type=business') },
      { n: pendDep.c, l: 'Pending deposits', href: R(req, '/deposits?status=pending') },
      { n: pendWd.c, l: 'Pending withdrawals', href: R(req, '/withdrawals?status=pending') },
      { n: openSup.c, l: 'Open support tickets', href: R(req, '/support?status=open') },
      { n: rtpValue, l: 'RTP (settled draws only)', href: R(req, '/reports?type=business') },
    ])}
    ${loginCards}
    ${ui.card('Exposure & profit projection', heat + expTable)}
    ${ui.card('Recent audit activity', ui.table(['Time', 'Actor', 'Action', 'Detail'],
      (await req.db.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 8')).map(a =>
        [d(a.created_at), esc(a.actor_role) + ' #' + (a.actor_id || '—'), esc(a.action), `<span class="code">${esc(String(a.detail).slice(0, 80))}</span>`])))}`;
  res.send(shell(req, '', 'Dashboard', body));
});

/* ============================================================ DRAWS */
router.get('/draws', async (req, res) => {
  const draws = await req.db.query('SELECT * FROM draws ORDER BY close_at DESC LIMIT 60');
  // Pending Draw queue (ViserLab-style): overdue scheduled draws first, one-click Settle now
  const overdue = draws.filter(x => x.status === 'scheduled' && x.close_at < now());
  const pendingCard = overdue.length ? ui.card('⏰ Pending draws — overdue, settle now',
    ui.table(['ID', 'Type', 'Date', 'Closes', 'Overdue by', ''],
      overdue.map(dr => [
        dr.id, dr.draw_type + (dr.is_test ? ' ' + ui.badge('TEST', 'warn') : ''), esc(dr.draw_date), d(dr.close_at),
        Math.max(0, Math.round((now() - dr.close_at) / 60000)) + ' min',
        `<form method="POST" action="${R(req, '/draws/' + dr.id + '/settle')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm btn-p" data-confirm="Settle this draw now?">Draw Now</button></form>`,
      ]))) : '';
  const body = `
    ${pendingCard}
    ${ui.card('Upcoming draws', ui.table(['ID', 'Type', 'Date', 'Closes', 'Status', 'Seed hash', 'Winning #', ''],
      draws.filter(x => x.status === 'scheduled').map(dr => [
        dr.id, dr.draw_type + (dr.is_test ? ' ' + ui.badge('TEST', 'warn') : ''), esc(dr.draw_date), d(dr.close_at),
        ui.statusBadge(dr.status), `<span class="code">${esc(String(dr.seed_hash).slice(0, 16))}…</span>`, dr.winning_number || '—',
        `<form method="POST" action="${R(req, '/draws/' + dr.id + '/settle')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm" data-confirm="Settle this draw now?">Settle now</button></form>`,
      ])))}
    ${ui.card('Create TEST draw', `<p class="muted">Test draws never affect real players' money flow visibility — they are labeled TEST everywhere. A fixed winning number may be set <strong>only</strong> here, and it is audit-logged.</p>` +
      ui.formHtml(R(req, '/draws/test'), [
        { key: 'date', label: 'Date', type: 'date', required: true },
        { key: 'time', label: 'Time', type: 'text', value: '12:00', help: 'HH:MM, 24h' },
        { key: 'override_number', label: 'Fixed winning number (1–15, optional)', type: 'number', help: 'Leave empty for random. Only for TEST draws.' },
      ], { csrf: req.csrfToken, submit: 'Create test draw' }))}
    ${ui.card('Recent settled draws', ui.table(['ID', 'Type', 'Date', 'Winning #', 'Test'],
      draws.filter(x => x.status === 'settled').map(dr => [
        dr.id, dr.draw_type, esc(dr.draw_date),
        `<span class="ball-sm">${dr.winning_number}</span>`,
        dr.is_test ? ui.badge('TEST', 'warn') : '—',
      ])))}`;
  res.send(shell(req, '/draws', 'Draws', body));
});

router.post('/draws/test', async (req, res) => {
  if (!req.body.date) { await req.setFlash('error', 'Date required.'); return res.redirect(R(req, '/draws')); }
  const ex = await req.db.get('SELECT id FROM draws WHERE draw_type = ? AND draw_date = ?', ['TEST', req.body.date]);
  if (ex) { await req.setFlash('error', 'A TEST draw already exists for that date.'); return res.redirect(R(req, '/draws')); }
  const id = await createTestDraw(req.db, {
    dateStr: req.body.date, timeStr: req.body.time || '12:00',
    overrideNumber: req.body.override_number || null, adminId: req.user.id, ip: req.ip,
  });
  await req.setFlash('success', 'TEST draw #' + id + ' created.');
  res.redirect(R(req, '/draws'));
});

/* Draw detail: P&L + per-ticket winner breakdown (ViserLab-style winning history) */
router.get('/draws/:id', async (req, res) => {
  const dr = await req.db.get('SELECT * FROM draws WHERE id = ?', [req.params.id]);
  if (!dr) return notFound(req, res, 'Draw not found.');
  const sold = await req.db.get(
    `SELECT COALESCE(SUM(t.wager),0) AS s, COUNT(DISTINCT te.ticket_id) AS tickets
     FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id WHERE te.draw_id = ?`, [dr.id]);
  const paid = await req.db.get(
    `SELECT COALESCE(SUM(win_amount),0) AS s, COUNT(*) AS c FROM ticket_entries WHERE draw_id = ? AND status = 'won'`, [dr.id]);
  const winners = await req.db.query(
    `SELECT te.win_amount, te.id AS entry_id, t.public_id, t.pops, u.email, u.name
     FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id JOIN users u ON u.id = t.user_id
     WHERE te.draw_id = ? AND te.status = 'won' ORDER BY te.win_amount DESC`, [dr.id]);
  const body = `
    ${ui.kpis([
      { n: money(req, sold.s, getS(req.settings, 'base_currency', 'USD')), l: 'Sold amount' },
      { n: money(req, paid.s, getS(req.settings, 'base_currency', 'USD')), l: 'Given prize' },
      { n: money(req, sold.s - paid.s, getS(req.settings, 'base_currency', 'USD')), l: (sold.s - paid.s) >= 0 ? 'Profit' : 'Loss' },
      { n: paid.c + ' / ' + sold.tickets, l: 'Winning tickets / tickets' },
    ])}
    ${ui.card('Draw — ' + esc(dr.draw_type) + ' ' + esc(dr.draw_date), `<p class="muted">Status: ${ui.statusBadge(dr.status)} · Winning number: <strong>${dr.winning_number || '—'}</strong> · Seed hash: <span class="code">${esc(String(dr.seed_hash || '').slice(0, 32))}…</span></p>`)}
    ${ui.card('Winners — per-ticket breakdown', ui.table(['Player', 'Ticket', 'Pops picked', 'Prize'],
      winners.map(w => [esc(w.name || w.email), `<span class="code">${esc(w.public_id)}</span>`, esc(w.pops), money(req, w.win_amount, getS(req.settings, 'base_currency', 'USD'))])))}`;
  res.send(shell(req, '/draws', 'Draw #' + dr.id, body));
});
router.post('/draws/:id/settle', async (req, res) => {
  try {
    const r = await settleDraw(req.db, parseInt(req.params.id, 10), req.settings, { actorId: req.user.id, ip: req.ip });
    req.flashData = { success: `Draw settled. Winning number: ${r.winning}. Winners: ${r.winners}.` };
  } catch (e) { req.flashData = { error: 'Settle failed: ' + e.message }; }
  res.redirect(R(req, '/draws'));
});

/* ============================================================ TICKETS */
router.get('/tickets', async (req, res) => {
  const page = pageOf(req);
  const where = [], params = [];
  if (req.query.status) { where.push('t.status = ?'); params.push(req.query.status); }
  if (req.query.q) { where.push('(t.public_id LIKE ? OR u.email LIKE ?)'); params.push('%' + req.query.q + '%', '%' + req.query.q + '%'); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await req.db.get(`SELECT COUNT(*) AS c FROM tickets t JOIN users u ON u.id = t.user_id ${w}`, params)).c;
  const rows = await req.db.query(
    `SELECT t.*, u.email FROM tickets t JOIN users u ON u.id = t.user_id ${w} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
    [...params, PER, (page - 1) * PER]);
  const body = ui.filtersHtml(R(req, '/tickets'), [
    { key: 'status', label: 'Status', type: 'select', options: ['active', 'settled', 'cancelled'] },
    { key: 'q', label: 'Ticket ID or email' },
  ], req.query) + ui.table(['Ticket', 'Player', 'Pops', 'Wager', 'Draws', 'Total', 'Status', 'HMAC', 'Bought'],
    rows.map(t => [
      `<span class="code">${esc(t.public_id)}</span>`, esc(t.email),
      JSON.parse(t.pops || '[]').join(', '), money(req, t.wager, t.currency),
      `${t.draw_type} ×${t.num_draws}`, money(req, t.total, t.currency),
      ui.statusBadge(t.status), `<span class="code">${esc(t.hmac.slice(0, 10))}…</span>`, d(t.created_at),
    ])) + ui.paginate(R(req, '/tickets'), page, PER, total);
  res.send(shell(req, '/tickets', 'Tickets', body));
});

module.exports = router;

/* ============================================================ USERS */
const USER_FILTERS = [
  ['all', 'All'], ['active', 'Active'], ['banned', 'Banned'], ['pending_review', 'Pending review'],
  ['email_unverified', 'Email unverified'], ['mobile_unverified', 'Mobile unverified'],
  ['kyc_pending', 'KYC pending'], ['with_balance', 'With balance'],
];
router.get('/users', async (req, res) => {
  const page = pageOf(req);
  const f = req.query.f || 'all', q = req.query.q || '';
  const where = ["u.role = 'player'"], params = [];
  if (f === 'active') where.push("u.status = 'active'");
  else if (f === 'banned') where.push("u.status = 'banned'");
  else if (f === 'pending_review') where.push("u.status = 'pending_review'");
  else if (f === 'email_unverified') where.push('COALESCE(u.email_verified,0) = 0');
  else if (f === 'mobile_unverified') where.push('COALESCE(u.mobile_verified,0) = 0');
  else if (f === 'with_balance') where.push('EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = u.id AND w.balance > 0)');
  else if (f === 'kyc_pending') where.push("u.kyc_status = 'pending'");
  if (q) { where.push('(u.email LIKE ? OR u.name LIKE ? OR u.phone LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const w = 'WHERE ' + where.join(' AND ');
  // live badges
  const badges = {};
  for (const [key] of USER_FILTERS) {
    let ww = ["u.role = 'player'"];
    if (key === 'active') ww.push("u.status = 'active'");
    else if (key === 'banned') ww.push("u.status = 'banned'");
    else if (key === 'pending_review') ww.push("u.status = 'pending_review'");
    else if (key === 'email_unverified') ww.push('u.email_verified = 0');
    else if (key === 'mobile_unverified') ww.push('u.mobile_verified = 0');
    else if (key === 'kyc_pending') ww.push("u.kyc_status = 'pending'");
    else if (key === 'with_balance') ww.push('EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = u.id AND w.balance > 0)');
    badges[key] = (await req.db.get(`SELECT COUNT(*) AS c FROM users u WHERE ${ww.join(' AND ')}`)).c;
  }
  const total = (await req.db.get(`SELECT COUNT(*) AS c FROM users u ${w}`, params)).c;
  const rows = await req.db.query(`SELECT u.* FROM users u ${w} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, [...params, PER, (page - 1) * PER]);
  const tabs = USER_FILTERS.map(([key, label]) =>
    `<a class="tab${f === key ? ' active' : ''}" href="${R(req, '/users')}?f=${key}">${esc(label)} <span class="count">${badges[key]}</span></a>`).join('');
  const body = `<div class="tabs">${tabs}</div>` +
    ui.filtersHtml(R(req, '/users'), [{ key: 'q', label: 'Search name/email/phone' }], { q, f }) +
    ui.table(['ID', 'Name', 'Email', 'Status', 'KYC', 'Agent', 'Joined', ''],
      rows.map(u => [
        u.id, esc(u.name), esc(u.email), ui.statusBadge(u.status), ui.statusBadge(u.kyc_status),
        u.agent_id ? '#' + u.agent_id : '<span class="muted">unassigned</span>', d(u.created_at),
        `<a class="btn btn-sm" href="${R(req, '/users/' + u.id)}">Manage</a>`,
      ])) + ui.paginate(`${R(req, '/users')}?f=${f}&q=${encodeURIComponent(q)}`, page, PER, total);
  res.send(shell(req, '/users', 'Users', body));
});

router.get('/users/:id', async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u) return notFound(req, res, 'User not found.');
  const wallets = await getBalances(req.db, u.id);
  const txs = await req.db.query('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 15', [u.id]);
  const logins = await req.db.query('SELECT * FROM login_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [u.id]);
  const acts = await req.db.query('SELECT * FROM audit_log WHERE actor_id = ? ORDER BY created_at DESC LIMIT 15', [u.id]);
  const tickets = await req.db.query('SELECT * FROM tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [u.id]);
  const agents = await req.db.query("SELECT id, name FROM users WHERE role = 'agent' ORDER BY name");
  const body = `
  <div class="grid2">
    <div>${ui.card('Biodata', ui.formHtml(R(req, '/users/' + u.id), [
        { key: 'name', label: 'Name', type: 'text', value: u.name, required: true },
        { key: 'email', label: 'Email', type: 'text', value: u.email },
        { key: 'phone', label: 'Phone', type: 'text', value: u.phone },
        { key: 'address', label: 'Address', type: 'text', value: u.address },
        { key: 'city', label: 'City', type: 'text', value: u.city },
        { key: 'state', label: 'State', type: 'text', value: u.state },
        { key: 'zip', label: 'Zip / Postal code', type: 'text', value: u.zip },
        { key: 'country', label: 'Country', type: 'text', value: u.country },
        { key: 'kyc_status', label: 'KYC', type: 'select', options: ['none', 'pending', 'verified', 'rejected'], value: u.kyc_status },
        { key: 'agent_id', label: 'Agent (blank = unassigned)', type: 'text', value: u.agent_id || '' },
        { key: 'notes', label: 'Notes', type: 'textarea', value: u.notes },
      ], { csrf: req.csrfToken, submit: 'Save biodata' }) +
      ui.card('Controls', `
        <div class="btn-row">
          <form method="POST" action="${R(req, '/users/' + u.id + '/block')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}">
            <button class="btn ${u.status === 'banned' ? 'btn-p' : 'btn-d'}" data-confirm="Are you sure?">${u.status === 'banned' ? 'Unblock' : 'Block'}</button></form>
          <form method="POST" action="${R(req, '/users/' + u.id + '/reset-password')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}">
            <button class="btn" data-confirm="Reset this user's password?">Reset password</button></form>
          <form method="POST" action="${R(req, '/users/' + u.id + '/revoke-sessions')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}">
            <button class="btn" data-confirm="Sign this user out everywhere?">Revoke sessions</button></form>
          <form method="POST" action="${R(req, '/users/' + u.id + '/login-as')}" style="display:inline" target="_blank"><input type="hidden" name="_csrf" value="${req.csrfToken}">
            <button class="btn btn-g" data-confirm="Log in as this user? This is audit-logged.">Login as user</button></form>
        </div>
        <h4 class="mt">Balance adjustment (manual correction, audit-logged)</h4>
        <form method="POST" action="${R(req, '/users/' + u.id + '/adjust')}" class="adm-form" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;">
          <input type="hidden" name="_csrf" value="${req.csrfToken}">
          <div class="field"><label>Direction</label><select name="direction"><option value="add">+ Add balance</option><option value="subtract">− Subtract balance</option></select></div>
          <div class="field"><label>Amount (major units, e.g. 10.00)</label><input type="text" name="amount" required placeholder="10.00"></div>
          <div class="field"><label>Remark (required, shown in audit)</label><input type="text" name="remark" required maxlength="200" placeholder="Why this adjustment?"></div>
          <div class="mt"><button class="btn btn-p" type="submit" data-confirm="Apply this balance adjustment?">Apply adjustment</button></div>
        </form>
        <h4 class="mt">Deposit / withdrawal matrix</h4>
        ${ui.formHtml(R(req, '/users/' + u.id + '/matrix'), [
          { key: 'deposit_blocked', label: 'Block deposits', type: 'checkbox', value: u.deposit_blocked },
          { key: 'withdrawal_blocked', label: 'Block withdrawals', type: 'checkbox', value: u.withdrawal_blocked },
          { key: 'deposit_mode', label: 'Deposit mode (blank = global)', type: 'select', options: ['', 'auto', 'manual'], value: u.deposit_mode },
          { key: 'withdrawal_mode', label: 'Withdrawal mode (blank = global)', type: 'select', options: ['', 'auto', 'manual'], value: u.withdrawal_mode },
        ], { csrf: req.csrfToken, submit: 'Save matrix' })}`))}
    </div>
    <div>
      ${ui.card('Wallets', ui.table(['Currency', 'Balance'], wallets.map(w => [w.currency, money(req, w.balance, w.currency)])))}
      ${ui.card('Recent tickets', ui.table(['Ticket', 'Total', 'Status', 'When'], tickets.map(t =>
        [`<span class="code">${esc(t.public_id)}</span>`, money(req, t.total, t.currency), ui.statusBadge(t.status), d(t.created_at)])))}
      ${ui.card('Recent transactions', ui.table(['When', 'Type', 'Amount', 'Balance after'], txs.map(t =>
        [d(t.created_at), esc(t.type), `<span class="${t.amount >= 0 ? 'pos' : 'neg'}">${money(req, t.amount, t.currency)}</span>`, money(req, t.balance_after, t.currency)])))}
      ${ui.card('Login history', ui.table(['When', 'IP', 'Country', 'Browser', 'OS', 'OK'], logins.map(l =>
        [d(l.created_at), esc(l.ip), esc(l.country || '—'), esc(l.browser), esc(l.os), l.success ? '✓' : '✗'])))}
      ${ui.card('Activity timeline', ui.table(['When', 'Action', 'Detail'], acts.map(a =>
        [d(a.created_at), esc(a.action), `<span class="code">${esc(String(a.detail).slice(0, 100))}</span>`])))}
    </div>
  </div>`;
  res.send(shell(req, '/users', 'User #' + u.id + ' — ' + u.name, body));
});

router.post('/users/:id', async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u) return notFound(req, res, 'User not found.');
  await req.db.run('UPDATE users SET name = ?, phone = ?, address = ?, city = ?, state = ?, zip = ?, country = ?, kyc_status = ?, notes = ?, agent_id = ? WHERE id = ?',
    [req.body.name.trim(), String(req.body.phone || '').slice(0, 32),
     String(req.body.address || '').slice(0, 255), String(req.body.city || '').slice(0, 128),
     String(req.body.state || '').slice(0, 128), String(req.body.zip || '').slice(0, 32),
     String(req.body.country || '').slice(0, 64),
     req.body.kyc_status, String(req.body.notes || '').slice(0, 2000), req.body.agent_id ? parseInt(req.body.agent_id, 10) : null, u.id]);
  if (req.body.email && validEmail(req.body.email) && req.body.email.toLowerCase() !== u.email) {
    await req.db.run('UPDATE users SET email = ? WHERE id = ?', [req.body.email.trim().toLowerCase(), u.id]);
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'user.update', entity: 'user', entityId: u.id, detail: { by: req.user.id }, ip: req.ip });
  await req.setFlash('success', 'User updated.');
  res.redirect(R(req, '/users/' + u.id));
});

router.post('/users/:id/block', async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u || u.role === 'admin') return notFound(req, res, 'User not found.');
  const next = u.status === 'banned' ? 'active' : 'banned';
  await req.db.run('UPDATE users SET status = ? WHERE id = ?', [next, u.id]);
  if (next === 'banned') await destroyUserSessions(req.db, u.id);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: next === 'banned' ? 'user.block' : 'user.unblock', entity: 'user', entityId: u.id, detail: {}, ip: req.ip });
  await req.setFlash('success', `User ${next}.`);
  res.redirect(R(req, '/users/' + u.id));
});

router.post('/users/:id/reset-password', async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u) return notFound(req, res, 'User not found.');
  const pw = randHex(6);
  await req.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(pw), u.id]);
  await destroyUserSessions(req.db, u.id);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'user.password_reset_admin', entity: 'user', entityId: u.id, detail: {}, ip: req.ip });
  await req.setFlash('success', 'New temporary password: ' + pw + ' — share it with the user securely. It will not be shown again.');
  res.redirect(R(req, '/users/' + u.id));
});

router.post('/users/:id/revoke-sessions', async (req, res) => {
  await destroyUserSessions(req.db, parseInt(req.params.id, 10));
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'user.sessions_revoke', entity: 'user', entityId: req.params.id, detail: {}, ip: req.ip });
  await req.setFlash('success', 'All sessions revoked.');
  res.redirect(R(req, '/users/' + req.params.id));
});

/* Manual balance adjustment (+/- with remark, audit-logged) */
router.post('/users/:id/adjust', async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u) return notFound(req, res, 'User not found.');
  const { toMinor } = require('../lib/util');
  const amount = toMinor(req.body.amount);
  const remark = String(req.body.remark || '').trim();
  if (amount === null || amount <= 0 || !remark) { await req.setFlash('error', 'Enter a valid amount and a remark.'); return res.redirect(R(req, '/users/' + u.id)); }
  const signed = req.body.direction === 'subtract' ? -amount : amount;
  const currency = getS(req.settings, 'base_currency', 'USD');
  await req.db.transaction(async (tx) => {
    await postLedger(tx, { userId: u.id, currency, type: 'adjustment', amount: signed, refType: 'admin_adjustment', refId: 'ADJ' + now(), meta: { remark, admin_id: req.user.id, direction: req.body.direction } });
  });
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'user.balance_adjust', entity: 'user', entityId: u.id, detail: { amount: signed, currency, remark }, ip: req.ip });
  await req.setFlash('success', 'Balance adjusted by ' + money(req, signed, currency) + '.');
  res.redirect(R(req, '/users/' + u.id));
});
router.post('/users/:id/matrix', async (req, res) => {
  await req.db.run('UPDATE users SET deposit_blocked = ?, withdrawal_blocked = ?, deposit_mode = ?, withdrawal_mode = ? WHERE id = ?',
    [req.body.deposit_blocked ? 1 : 0, req.body.withdrawal_blocked ? 1 : 0,
     ['', 'auto', 'manual'].includes(req.body.deposit_mode) ? req.body.deposit_mode : '',
     ['', 'auto', 'manual'].includes(req.body.withdrawal_mode) ? req.body.withdrawal_mode : '', req.params.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'user.matrix_update', entity: 'user', entityId: req.params.id, detail: req.body, ip: req.ip });
  await req.setFlash('success', 'Control matrix saved.');
  res.redirect(R(req, '/users/' + req.params.id));
});

router.post('/users/:id/login-as', async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u || u.role === 'admin') return notFound(req, res, 'User not found.');
  const sid = await createSession(req.db, u.id, { ip: req.ip, ua: req.headers['user-agent'], extra: { impersonated_by: req.user.id, impersonated_name: req.user.name } });
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'user.login_as', entity: 'user', entityId: u.id, detail: {}, ip: req.ip });
  res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', secure: req.secure || getBool(req.settings, 'force_ssl', false), maxAge: 7 * 24 * 3600 * 1000 });
  res.redirect('/');
});

/* ============================================================ OTP CODES */
router.get('/otp', async (req, res) => {
  const codes = await req.db.query('SELECT * FROM otp_codes ORDER BY created_at DESC LIMIT 100');
  const body = ui.card('Issue signup code', `<p class="muted">Codes are single-use (or limited-use), hashed, and expire. Share a code with the player; they enter it at registration when OTP-gated registration is ON.</p>` +
    ui.formHtml(R(req, '/otp'), [
      { key: 'label', label: 'Label (e.g. player name)', type: 'text' },
      { key: 'max_uses', label: 'Max uses', type: 'number', value: '1' },
      { key: 'expires_hours', label: 'Expires in (hours)', type: 'number', value: '72' },
    ], { csrf: req.csrfToken, submit: 'Generate code' })) +
    ui.card('Codes', ui.table(['ID', 'Label', 'Uses', 'Expires', 'Revoked', 'Created', ''],
      codes.map(c => [c.id, esc(c.label), `${c.uses}/${c.max_uses}`, c.expires_at ? d(c.expires_at) : 'never',
        c.revoked ? ui.badge('revoked', 'err') : ui.badge('live', 'ok'), d(c.created_at),
        c.revoked ? '' : `<form method="POST" action="${R(req, '/otp/' + c.id + '/revoke')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm btn-d">Revoke</button></form>`])));
  res.send(shell(req, '/otp', 'OTP Signup Codes', body));
});

router.post('/otp', async (req, res) => {
  const code = randHex(4).toUpperCase().match(/.{4}/g).join('-');
  const hours = Math.max(1, parseInt(req.body.expires_hours, 10) || 72);
  await req.db.run('INSERT INTO otp_codes (code_hash, label, max_uses, uses, expires_at, created_by, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)',
    [sha256('otp:' + code), String(req.body.label || '').slice(0, 255), Math.max(1, parseInt(req.body.max_uses, 10) || 1), now() + hours * 3600000, req.user.id, now()]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'otp.issue', entity: 'otp', entityId: '', detail: { label: req.body.label }, ip: req.ip });
  await req.setFlash('success', 'New signup code: ' + code + ' — copy it now, it cannot be viewed again.');
  res.redirect(R(req, '/otp'));
});

router.post('/otp/:id/revoke', async (req, res) => {
  await req.db.run('UPDATE otp_codes SET revoked = 1 WHERE id = ?', [req.params.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'otp.revoke', entity: 'otp', entityId: req.params.id, detail: {}, ip: req.ip });
  await req.setFlash('success', 'Code revoked.');
  res.redirect(R(req, '/otp'));
});

/* ============================================================ AGENTS */
router.get('/agents', async (req, res) => {
  const agents = await req.db.query("SELECT * FROM users WHERE role = 'agent' ORDER BY created_at DESC");
  for (const a of agents) {
    a.players = (await req.db.get('SELECT COUNT(*) AS c FROM users WHERE agent_id = ?', [a.id])).c;
    a.floats = await req.db.query('SELECT currency, balance FROM agent_floats WHERE agent_id = ?', [a.id]);
    a.comm = (await req.db.get('SELECT COALESCE(SUM(amount),0) AS s FROM commissions WHERE agent_id = ?', [a.id])).s;
  }
  const body = ui.card('Create agent', ui.formHtml(R(req, '/agents'), [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'text', required: true },
    { key: 'password', label: 'Password', type: 'text', required: true },
  ], { csrf: req.csrfToken, submit: 'Create agent' })) +
    ui.card('Agents', ui.table(['ID', 'Name', 'Email', 'Players', 'Float', 'Commissions', 'Status', ''],
      agents.map(a => [a.id, esc(a.name), esc(a.email), a.players,
        a.floats.map(f => `${f.currency} ${money(req, f.balance, f.currency)}`).join('<br>') || '—',
        money(req, a.comm, getS(req.settings, 'base_currency', 'USD')), ui.statusBadge(a.status),
        `<a class="btn btn-sm" href="${R(req, '/agents/' + a.id)}">Manage</a>`])));
  res.send(shell(req, '/agents', 'Agents', body));
});

router.post('/agents', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !validEmail(email) || !password || password.length < 6) { await req.setFlash('error', 'Name, valid email and 6+ char password required.'); return res.redirect(R(req, '/agents')); }
  const dup = await req.db.get('SELECT id FROM users WHERE email = ?', [email.trim().toLowerCase()]);
  if (dup) { await req.setFlash('error', 'An account with that email already exists.'); return res.redirect(R(req, '/agents')); }
  const r = await req.db.run("INSERT INTO users (email, name, password_hash, role, status, created_at) VALUES (?, ?, ?, 'agent', 'active', ?)",
    [email.trim().toLowerCase(), name.trim(), hashPassword(password), now()]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'agent.create', entity: 'user', entityId: r.id, detail: {}, ip: req.ip });
  await req.setFlash('success', 'Agent created.');
  res.redirect(R(req, '/agents'));
});

router.get('/agents/:id', async (req, res) => {
  const a = await req.db.get("SELECT * FROM users WHERE id = ? AND role = 'agent'", [req.params.id]);
  if (!a) return notFound(req, res, 'Agent not found.');
  const floats = await req.db.query('SELECT currency, balance FROM agent_floats WHERE agent_id = ?', [a.id]);
  const players = await req.db.query("SELECT id, name, email, created_at FROM users WHERE agent_id = ? AND role = 'player'", [a.id]);
  const comms = await req.db.query('SELECT * FROM commissions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 25', [a.id]);
  const transfers = await req.db.query('SELECT * FROM agent_transfers WHERE from_agent = ? ORDER BY created_at DESC LIMIT 25', [a.id]);
  const body = `
  <div class="grid2"><div>
    ${ui.card('Fund float', `<p class="muted">Add house funds to this agent's float. Agents fund players from their float.</p>` +
      ui.formHtml(R(req, '/agents/' + a.id + '/fund'), [
        { key: 'currency', label: 'Currency', type: 'text', value: getS(req.settings, 'base_currency', 'USD'), required: true },
        { key: 'amount', label: 'Amount', type: 'text', required: true },
        { key: 'note', label: 'Note', type: 'text' },
      ], { csrf: req.csrfToken, submit: 'Add funds' }))}
    ${ui.card('Float balances', ui.table(['Currency', 'Balance'], floats.map(f => [f.currency, money(req, f.balance, f.currency)])))}
  </div><div>
    ${ui.card('Players (' + players.length + ')', ui.table(['ID', 'Name', 'Email', 'Joined'], players.map(p => [p.id, esc(p.name), esc(p.email), d(p.created_at)])))}
    ${ui.card('Commissions', ui.table(['When', 'Amount', 'Rate'], comms.map(c => [d(c.created_at), money(req, c.amount, c.currency), c.rate + '%'])))}
    ${ui.card('Transfers', ui.table(['When', 'To user', 'Amount', 'Note'], transfers.map(t => [d(t.created_at), '#' + t.to_user, money(req, t.amount, t.currency), esc(t.note)])))}
  </div></div>`;
  res.send(shell(req, '/agents', 'Agent — ' + a.name, body));
});

router.post('/agents/:id/fund', async (req, res) => {
  const amount = toMinor(req.body.amount);
  const currency = String(req.body.currency || '').toUpperCase().slice(0, 8);
  if (!amount || amount <= 0) { await req.setFlash('error', 'Invalid amount.'); return res.redirect(R(req, '/agents/' + req.params.id)); }
  const ex = await req.db.get('SELECT * FROM agent_floats WHERE agent_id = ? AND currency = ?', [req.params.id, currency]);
  if (ex) await req.db.run('UPDATE agent_floats SET balance = balance + ? WHERE agent_id = ? AND currency = ?', [amount, req.params.id, currency]);
  else await req.db.run('INSERT INTO agent_floats (agent_id, currency, balance) VALUES (?, ?, ?)', [req.params.id, currency, amount]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'agent.float_fund', entity: 'user', entityId: req.params.id, detail: { amount, currency, note: req.body.note }, ip: req.ip });
  await req.setFlash('success', 'Float funded.');
  res.redirect(R(req, '/agents/' + req.params.id));
});

/* ============================================================ DEPOSITS */
function moneyTabs(req, base, counts, active) {
  const tabs = [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['revoked', 'Revoked'], ['expired', 'Expired']];
  return `<div class="tabs"><a class="tab${!active ? ' active' : ''}" href="${base}">All <span class="count">${counts.all}</span></a>` +
    tabs.map(([k, l]) => `<a class="tab${active === k ? ' active' : ''}" href="${base}?status=${k}">${l} <span class="count">${counts[k] || 0}</span></a>`).join('') + '</div>';
}
router.get('/deposits', async (req, res) => {
  const page = pageOf(req), status = req.query.status || '';
  const counts = { all: (await req.db.get('SELECT COUNT(*) AS c FROM deposits')).c };
  for (const s of ['pending', 'approved', 'rejected', 'revoked', 'expired']) counts[s] = (await req.db.get('SELECT COUNT(*) AS c FROM deposits WHERE status = ?', [s])).c;
  const baseCur = getS(req.settings, 'base_currency', 'USD');
  const depSums = {};
  for (const s of ['pending', 'approved', 'rejected', 'revoked', 'expired']) depSums[s] = (await req.db.get('SELECT COALESCE(SUM(net),0) AS s FROM deposits WHERE status = ?', [s])).s;
  const depStrip = `<div class="sumstrip"><span>Successful: <strong>${money(req, depSums.approved, baseCur)}</strong></span><span>Pending: <strong>${money(req, depSums.pending, baseCur)}</strong></span><span>Rejected: <strong>${money(req, depSums.rejected, baseCur)}</strong></span><span>Revoked: <strong>${money(req, depSums.revoked, baseCur)}</strong></span><span>Expired: <strong>${money(req, depSums.expired, baseCur)}</strong></span></div>`;
  const where = status ? 'WHERE d.status = ?' : '', params = status ? [status] : [];
  const total = (await req.db.get(`SELECT COUNT(*) AS c FROM deposits d ${where}`, params)).c;
  const rows = await req.db.query(
    `SELECT d.*, u.email, m.name AS method_name FROM deposits d JOIN users u ON u.id = d.user_id LEFT JOIN payment_methods m ON m.id = d.method_id
     ${where} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`, [...params, PER, (page - 1) * PER]);
  const body = depStrip + moneyTabs(req, R(req, '/deposits'), counts, status) + ui.table(['ID', 'Player', 'Method', 'Amount', 'Charge', 'Net', 'Status', 'When', ''],
    rows.map(x => [`<span class="code">${esc(x.public_id)}</span>`, esc(x.email), esc(x.method_name || '—'),
      money(req, x.amount, x.currency), money(req, x.charge, x.currency), money(req, x.net, x.currency),
      ui.statusBadge(x.status), d(x.created_at), `<a class="btn btn-sm" href="${R(req, '/deposits/' + x.id)}">Review</a>`])) +
    ui.paginate(R(req, '/deposits') + (status ? '?status=' + status : ''), page, PER, total);
  res.send(shell(req, '/deposits', 'Deposits', body));
});

router.get('/deposits/:id', async (req, res) => {
  const x = await req.db.get(`SELECT d.*, u.email, u.name AS user_name, m.name AS method_name FROM deposits d JOIN users u ON u.id = d.user_id LEFT JOIN payment_methods m ON m.id = d.method_id WHERE d.id = ?`, [req.params.id]);
  if (!x) return notFound(req, res, 'Deposit not found.');
  let userData = {};
  try { userData = JSON.parse(x.user_data || '{}'); } catch {}
  const actions = x.status === 'pending'
    ? `<form method="POST" action="${R(req, '/deposits/' + x.id + '/approve')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-p" data-confirm="Approve and credit this deposit?">Approve & credit</button></form>
       <form method="POST" action="${R(req, '/deposits/' + x.id + '/reject')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-d" data-confirm="Reject this deposit?">Reject</button></form>`
    : x.status === 'approved'
    ? `<form method="POST" action="${R(req, '/deposits/' + x.id + '/revoke')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-d" data-confirm="Revoke? The credited amount will be debited.">Revoke</button></form>`
    : `<span class="muted">No actions available for ${esc(x.status)} deposits.</span>`;
  const body = ui.card('Deposit ' + x.public_id, `
    <div class="grid2"><div>
      ${ui.table(['Field', 'Value'], [
        ['Player', `${esc(x.user_name)} (${esc(x.email)})`], ['Method', esc(x.method_name || '—')],
        ['Amount', money(req, x.amount, x.currency)], ['Charge', money(req, x.charge, x.currency)],
        ['Net credited', money(req, x.net, x.currency)], ['Status', ui.statusBadge(x.status)],
        ['Created', d(x.created_at)], ['Decided', x.decided_at ? d(x.decided_at) : '—'],
      ])}
    </div><div>
      <h4>Player-submitted proof</h4>
      ${ui.table(['Field', 'Value'], Object.entries(userData).map(([k, v]) => [esc(k), esc(v)]))}
      <h4 class="mt">Admin note</h4>
      ${ui.formHtml(R(req, '/deposits/' + x.id + '/note'), [{ key: 'admin_note', label: 'Note', type: 'textarea', value: x.admin_note }], { csrf: req.csrfToken, submit: 'Save note', grid: false })}
    </div></div>
    <div class="btn-row mt">${actions}</div>`);
  res.send(shell(req, '/deposits', 'Deposit ' + x.public_id, body));
});

async function decideDep(req, res, decision) {
  try {
    const dep = await decideDeposit(req.db, parseInt(req.params.id, 10), decision, req.user.id);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'deposit.' + decision, entity: 'deposit', entityId: dep.public_id, detail: { amount: dep.net }, ip: req.ip });
    if (decision === 'approve') {
      const u = await req.db.get('SELECT email, name FROM users WHERE id = ?', [dep.user_id]);
      notify.send(req.db, req.settings, 'email', 'deposit_approved', u.email, { name: u.name, amount: money(req, dep.net, dep.currency) }).catch(() => {});
    }
    await req.setFlash('success', 'Deposit ' + decision + 'd.');
  } catch (e) { await req.setFlash('error', e.message); }
  res.redirect(R(req, '/deposits/' + req.params.id));
}
router.post('/deposits/:id/approve', (req, res) => decideDep(req, res, 'approve'));
router.post('/deposits/:id/reject', (req, res) => decideDep(req, res, 'reject'));
router.post('/deposits/:id/revoke', (req, res) => decideDep(req, res, 'revoke'));
router.post('/deposits/:id/note', async (req, res) => {
  await req.db.run('UPDATE deposits SET admin_note = ? WHERE id = ?', [String(req.body.admin_note || '').slice(0, 2000), req.params.id]);
  await req.setFlash('success', 'Note saved.');
  res.redirect(R(req, '/deposits/' + req.params.id));
});

/* ============================================================ WITHDRAWALS */
router.get('/withdrawals', async (req, res) => {
  const page = pageOf(req), status = req.query.status || '';
  const counts = { all: (await req.db.get('SELECT COUNT(*) AS c FROM withdrawals')).c };
  for (const s of ['pending', 'approved', 'rejected', 'revoked']) counts[s] = (await req.db.get('SELECT COUNT(*) AS c FROM withdrawals WHERE status = ?', [s])).c;
  const wdBaseCur = getS(req.settings, 'base_currency', 'USD');
  const wdSums = {};
  for (const s of ['pending', 'approved', 'rejected', 'revoked']) wdSums[s] = (await req.db.get('SELECT COALESCE(SUM(net),0) AS s FROM withdrawals WHERE status = ?', [s])).s;
  const wdStrip = `<div class="sumstrip"><span>Approved: <strong>${money(req, wdSums.approved, wdBaseCur)}</strong></span><span>Pending: <strong>${money(req, wdSums.pending, wdBaseCur)}</strong></span><span>Rejected: <strong>${money(req, wdSums.rejected, wdBaseCur)}</strong></span><span>Revoked: <strong>${money(req, wdSums.revoked, wdBaseCur)}</strong></span></div>`;
  const where = status ? 'WHERE w.status = ?' : '', params = status ? [status] : [];
  const total = (await req.db.get(`SELECT COUNT(*) AS c FROM withdrawals w ${where}`, params)).c;
  const rows = await req.db.query(
    `SELECT w.*, u.email, m.name AS method_name FROM withdrawals w JOIN users u ON u.id = w.user_id LEFT JOIN payment_methods m ON m.id = w.method_id
     ${where} ORDER BY w.created_at DESC LIMIT ? OFFSET ?`, [...params, PER, (page - 1) * PER]);
  const body = wdStrip + moneyTabs(req, R(req, '/withdrawals'), counts, status) + ui.table(['ID', 'Player', 'Method', 'Amount', 'Charge', 'Net payout', 'Status', 'When', ''],
    rows.map(x => [`<span class="code">${esc(x.public_id)}</span>`, esc(x.email), esc(x.method_name || '—'),
      money(req, x.amount, x.currency), money(req, x.charge, x.currency), money(req, x.net, x.currency),
      ui.statusBadge(x.status), d(x.created_at), `<a class="btn btn-sm" href="${R(req, '/withdrawals/' + x.id)}">Review</a>`])) +
    ui.paginate(R(req, '/withdrawals') + (status ? '?status=' + status : ''), page, PER, total);
  res.send(shell(req, '/withdrawals', 'Withdrawals', body));
});

router.get('/withdrawals/:id', async (req, res) => {
  const x = await req.db.get(`SELECT w.*, u.email, u.name AS user_name, m.name AS method_name FROM withdrawals w JOIN users u ON u.id = w.user_id LEFT JOIN payment_methods m ON m.id = w.method_id WHERE w.id = ?`, [req.params.id]);
  if (!x) return notFound(req, res, 'Withdrawal not found.');
  let userData = {};
  try { userData = JSON.parse(x.user_data || '{}'); } catch {}
  const actions = x.status === 'pending'
    ? `<form method="POST" action="${R(req, '/withdrawals/' + x.id + '/approve')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-p" data-confirm="Approve? Pay ${esc(money(req, x.net, x.currency))} to the player.">Approve & pay</button></form>
       <form method="POST" action="${R(req, '/withdrawals/' + x.id + '/reject')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-d" data-confirm="Reject and release the held amount?">Reject & release</button></form>`
    : x.status === 'approved'
    ? `<form method="POST" action="${R(req, '/withdrawals/' + x.id + '/revoke')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-d" data-confirm="Revoke? The payout will be credited back.">Revoke</button></form>`
    : `<span class="muted">No actions available.</span>`;
  const body = ui.card('Withdrawal ' + x.public_id, `
    <div class="grid2"><div>
      ${ui.table(['Field', 'Value'], [
        ['Player', `${esc(x.user_name)} (${esc(x.email)})`], ['Method', esc(x.method_name || '—')],
        ['Amount (held)', money(req, x.amount, x.currency)], ['Charge', money(req, x.charge, x.currency)],
        ['Net payout', money(req, x.net, x.currency)], ['Status', ui.statusBadge(x.status)],
        ['Created', d(x.created_at)], ['Decided', x.decided_at ? d(x.decided_at) : '—'],
      ])}
    </div><div>
      <h4>Player payout details</h4>
      ${ui.table(['Field', 'Value'], Object.entries(userData).map(([k, v]) => [esc(k), esc(v)]))}
      <h4 class="mt">Admin note</h4>
      ${ui.formHtml(R(req, '/withdrawals/' + x.id + '/note'), [{ key: 'admin_note', label: 'Note', type: 'textarea', value: x.admin_note }], { csrf: req.csrfToken, submit: 'Save note', grid: false })}
    </div></div>
    <div class="btn-row mt">${actions}</div>`);
  res.send(shell(req, '/withdrawals', 'Withdrawal ' + x.public_id, body));
});

async function decideWd(req, res, decision) {
  try {
    const w = await decideWithdrawal(req.db, parseInt(req.params.id, 10), decision, req.user.id);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'withdrawal.' + decision, entity: 'withdrawal', entityId: w.public_id, detail: { amount: w.net }, ip: req.ip });
    if (decision !== 'revoke' || true) {
      const u = await req.db.get('SELECT email, name FROM users WHERE id = ?', [w.user_id]);
      notify.send(req.db, req.settings, 'email', 'withdrawal_decided', u.email, { name: u.name, amount: money(req, w.net, w.currency), status: decision + 'd' }).catch(() => {});
    }
    await req.setFlash('success', 'Withdrawal ' + decision + 'd.');
  } catch (e) { await req.setFlash('error', e.message); }
  res.redirect(R(req, '/withdrawals/' + req.params.id));
}
router.post('/withdrawals/:id/approve', (req, res) => decideWd(req, res, 'approve'));
router.post('/withdrawals/:id/reject', (req, res) => decideWd(req, res, 'reject'));
router.post('/withdrawals/:id/revoke', (req, res) => decideWd(req, res, 'revoke'));
router.post('/withdrawals/:id/note', async (req, res) => {
  await req.db.run('UPDATE withdrawals SET admin_note = ? WHERE id = ?', [String(req.body.admin_note || '').slice(0, 2000), req.params.id]);
  await req.setFlash('success', 'Note saved.');
  res.redirect(R(req, '/withdrawals/' + req.params.id));
});

/* ============================================================ PAYMENT METHODS */
router.get('/methods', async (req, res) => {
  const methods = await req.db.query('SELECT * FROM payment_methods ORDER BY sort');
  const body = `<div class="btn-row" style="margin-bottom:16px"><a class="btn btn-p" href="${R(req, '/methods/new')}">+ New method</a></div>` +
    ui.table(['Logo', 'Name', 'Kind', 'Rail', 'Currency', 'Min / Max', 'Charge', 'Status', ''],
      methods.map(m => [
        m.logo_url ? `<img src="${esc(m.logo_url)}" alt="" style="height:28px">` : '<span class="muted">—</span>',
        esc(m.name), esc(m.kind), esc((getRail(m.rail) || {}).name || m.rail),
        esc(m.currency),
        `${money(req, m.min_amount, m.currency)} – ${m.max_amount ? money(req, m.max_amount, m.currency) : '∞'}`,
        `${money(req, m.fixed_charge, m.currency)} + ${m.percent_charge}%`,
        m.enabled ? ui.badge('enabled', 'ok') : ui.badge('disabled', 'muted'),
        `<a class="btn btn-sm" href="${R(req, '/methods/' + m.id)}">Edit</a>
         <a class="btn btn-sm" href="${R(req, '/methods/' + m.id + '/credentials')}">Credentials</a>
         <form method="POST" action="${R(req, '/methods/' + m.id + '/toggle')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">${m.enabled ? 'Disable' : 'Enable'}</button></form>`,
      ]));
  res.send(shell(req, '/methods', 'Payment Methods', body));
});

const METHOD_FIELDS = (m = {}) => [
  { key: 'name', label: 'Method name', type: 'text', value: m.name, required: true },
  { key: 'kind', label: 'Kind', type: 'select', options: ['deposit', 'withdrawal', 'both'], value: m.kind || 'both' },
  { key: 'rail', label: 'Rail', type: 'select', options: RAILS.map(r => r.key), value: m.rail || 'bank_transfer', help: 'EBT is blocked by policy and cannot be saved.' },
  { key: 'logo_url', label: 'Logo URL', type: 'text', value: m.logo_url },
  { key: 'currency', label: 'Currency', type: 'text', value: m.currency || 'USD', required: true },
  { key: 'rate', label: 'Rate to base currency', type: 'text', value: m.rate || '1' },
  { key: 'min_amount', label: 'Min amount (e.g. 5.00)', type: 'text', value: m.min_amount ? fromMinor(m.min_amount) : '' },
  { key: 'max_amount', label: 'Max amount (blank = no max)', type: 'text', value: m.max_amount ? fromMinor(m.max_amount) : '' },
  { key: 'fixed_charge', label: 'Fixed charge (e.g. 0.50)', type: 'text', value: m.fixed_charge ? fromMinor(m.fixed_charge) : '' },
  { key: 'percent_charge', label: 'Percent charge %', type: 'text', value: m.percent_charge || '' },
  { key: 'instruction', label: 'Instruction shown to player', type: 'textarea', value: m.instruction },
  { key: 'custom_fields', label: 'Custom user-data fields (JSON)', type: 'textarea', value: m.custom_fields || '[]', help: 'e.g. [{"key":"account","label":"Your account number","type":"text","required":true}]' },
  { key: 'enabled', label: 'Enabled', type: 'checkbox', value: m.enabled },
];
function parseCustomFields(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    if (!Array.isArray(arr)) throw new Error('not an array');
    return arr.filter(f => f.key && f.label).map(f => ({ key: String(f.key).slice(0, 40), label: String(f.label).slice(0, 80), type: ['text', 'number', 'textarea'].includes(f.type) ? f.type : 'text', required: !!f.required }));
  } catch { throw new Error('Custom fields must be valid JSON array.'); }
}
router.get('/methods/new', async (req, res) => {
  res.send(shell(req, '/methods', 'New Payment Method', ui.card('Method', ui.formHtml(R(req, '/methods/new'), METHOD_FIELDS(), { csrf: req.csrfToken, submit: 'Create method' }))));
});
router.post('/methods/new', async (req, res) => {
  if (isBlockedRail(req.body.rail)) { await req.setFlash('error', 'This rail is blocked by policy.'); return res.redirect(R(req, '/methods/new')); }
  try {
    const cf = parseCustomFields(req.body.custom_fields);
    const slug = 'm-' + randHex(4) + '-' + Date.now().toString(36);
    await req.db.run(`INSERT INTO payment_methods (kind, name, slug, rail, logo_url, currency, rate, min_amount, max_amount, fixed_charge, percent_charge, instruction, custom_fields, enabled, sort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.body.kind, req.body.name.trim(), slug, req.body.rail, req.body.logo_url || '', req.body.currency.toUpperCase(),
       parseFloat(req.body.rate) || 1, toMinor(req.body.min_amount) || 0, toMinor(req.body.max_amount) || 0,
       toMinor(req.body.fixed_charge) || 0, parseFloat(req.body.percent_charge) || 0,
       req.body.instruction || '', JSON.stringify(cf), req.body.enabled ? 1 : 0, 999]);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'method.create', entity: 'method', entityId: slug, detail: { name: req.body.name }, ip: req.ip });
    await req.setFlash('success', 'Method created.');
  } catch (e) { await req.setFlash('error', e.message); return res.redirect(R(req, '/methods/new')); }
  res.redirect(R(req, '/methods'));
});
router.get('/methods/:id', async (req, res) => {
  const m = await req.db.get('SELECT * FROM payment_methods WHERE id = ?', [req.params.id]);
  if (!m) return notFound(req, res, 'Method not found.');
  res.send(shell(req, '/methods', 'Edit — ' + m.name,
    ui.card('Method', ui.formHtml(R(req, '/methods/' + m.id), METHOD_FIELDS(m), { csrf: req.csrfToken, submit: 'Save' })) +
    `<form method="POST" action="${R(req, '/methods/' + m.id + '/delete')}" class="mt"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-d" data-confirm="Delete this method?">Delete method</button></form>`));
});
router.post('/methods/:id', async (req, res) => {
  if (isBlockedRail(req.body.rail)) { await req.setFlash('error', 'This rail is blocked by policy.'); return res.redirect(R(req, '/methods/' + req.params.id)); }
  try {
    const cf = parseCustomFields(req.body.custom_fields);
    await req.db.run(`UPDATE payment_methods SET kind=?, name=?, rail=?, logo_url=?, currency=?, rate=?, min_amount=?, max_amount=?, fixed_charge=?, percent_charge=?, instruction=?, custom_fields=?, enabled=? WHERE id=?`,
      [req.body.kind, req.body.name.trim(), req.body.rail, req.body.logo_url || '', req.body.currency.toUpperCase(),
       parseFloat(req.body.rate) || 1, toMinor(req.body.min_amount) || 0, toMinor(req.body.max_amount) || 0,
       toMinor(req.body.fixed_charge) || 0, parseFloat(req.body.percent_charge) || 0,
       req.body.instruction || '', JSON.stringify(cf), req.body.enabled ? 1 : 0, req.params.id]);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'method.update', entity: 'method', entityId: req.params.id, detail: {}, ip: req.ip });
    await req.setFlash('success', 'Method saved.');
  } catch (e) { await req.setFlash('error', e.message); }
  res.redirect(R(req, '/methods/' + req.params.id));
});
router.post('/methods/:id/toggle', async (req, res) => {
  await req.db.run('UPDATE payment_methods SET enabled = 1 - enabled WHERE id = ?', [req.params.id]);
  res.redirect(R(req, '/methods'));
});
router.post('/methods/:id/delete', async (req, res) => {
  await req.db.run('DELETE FROM payment_methods WHERE id = ?', [req.params.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'method.delete', entity: 'method', entityId: req.params.id, detail: {}, ip: req.ip });
  await req.setFlash('success', 'Method deleted.');
  res.redirect(R(req, '/methods'));
});
router.get('/methods/:id/credentials', async (req, res) => {
  const m = await req.db.get('SELECT * FROM payment_methods WHERE id = ?', [req.params.id]);
  if (!m) return notFound(req, res, 'Method not found.');
  const rail = getRail(m.rail);
  const saved = Object.fromEntries((await req.db.query('SELECT field_key, field_value FROM gateway_credentials WHERE method_id = ?', [m.id])).map(r => [r.field_key, r.field_value]));
  const fields = (rail ? rail.credentialFields : []).map(f => ({ ...f, value: saved[f.key] || '' }));
  const body = ui.card(`Gateway credentials — ${m.name} (${rail ? rail.name : m.rail})`,
    `<p class="muted">Credentials are stored server-side and never shown to players. ${rail && rail.webhook ? 'This rail supports provider webhooks with signature verification.' : 'This rail runs in manual mode: players submit proof, staff approves.'}</p>` +
    (fields.length ? ui.formHtml(R(req, '/methods/' + m.id + '/credentials'), fields.map(f =>
      f.type === 'select' ? { key: f.key, label: f.label, type: 'select', options: f.options, value: saved[f.key] || '' }
      : f.type === 'textarea' ? { key: f.key, label: f.label, type: 'textarea', value: saved[f.key] || '' }
      : { key: f.key, label: f.label, type: f.type === 'password' ? 'password' : 'text', value: f.type === 'password' ? '' : (saved[f.key] || ''), help: f.type === 'password' ? 'Leave blank to keep the saved value.' : '' }),
      { csrf: req.csrfToken, submit: 'Save credentials' })
    : '<p class="muted">This rail needs no credentials.</p>'));
  res.send(shell(req, '/methods', 'Credentials — ' + m.name, body));
});
router.post('/methods/:id/credentials', async (req, res) => {
  const m = await req.db.get('SELECT * FROM payment_methods WHERE id = ?', [req.params.id]);
  if (!m) return notFound(req, res, 'Method not found.');
  const rail = getRail(m.rail);
  for (const f of (rail ? rail.credentialFields : [])) {
    let v = String(req.body[f.key] || '');
    if (f.type === 'password' && !v) continue; // keep saved
    if (f.required && !v) { await req.setFlash('error', `"${f.label}" is required.`); return res.redirect(R(req, '/methods/' + m.id + '/credentials')); }
    const ex = await req.db.get('SELECT id FROM gateway_credentials WHERE method_id = ? AND field_key = ?', [m.id, f.key]);
    if (ex) await req.db.run('UPDATE gateway_credentials SET field_value = ?, updated_at = ? WHERE id = ?', [v, now(), ex.id]);
    else await req.db.run('INSERT INTO gateway_credentials (method_id, field_key, field_value, updated_at) VALUES (?, ?, ?, ?)', [m.id, f.key, v, now()]);
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'method.credentials', entity: 'method', entityId: m.id, detail: {}, ip: req.ip });
  await req.setFlash('success', 'Credentials saved.');
  res.redirect(R(req, '/methods/' + m.id + '/credentials'));
});

/* ============================================================ REPORTS */
router.get('/reports', async (req, res) => {
  const { from, to } = dateRange(req);
  const type = req.query.type || 'business';
  const tabs = [['business', 'Business'], ['login', 'Logins'], ['ticket', 'Tickets'], ['transaction', 'Transactions'], ['payment', 'Payments'], ['withdrawal', 'Withdrawals']]
    .map(([k, l]) => `<a class="tab${type === k ? ' active' : ''}" href="${R(req, '/reports')}?type=${k}&from=${fmtDateInput(from)}&to=${fmtDateInput(to)}">${l}</a>`).join('');
  const dateForm = `<form method="GET" action="${R(req, '/reports')}" class="filters"><input type="hidden" name="type" value="${type}">
    <input type="date" name="from" value="${fmtDateInput(from)}"><input type="date" name="to" value="${fmtDateInput(to)}">
    <button class="btn btn-sm" type="submit">Apply</button></form>`;
  let body = `<div class="tabs">${tabs}</div>` + dateForm;
  if (type === 'business') {
    const days = []; const bars = [];
    for (let ts = from; ts <= to; ts += 86400000) {
      const e = Math.min(ts + 86399999, to);
      const sales = (await req.db.get('SELECT COALESCE(SUM(total),0) AS s, COUNT(*) AS c FROM tickets WHERE created_at BETWEEN ? AND ?', [ts, e]));
      const wins = (await req.db.get("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE type='win' AND created_at BETWEEN ? AND ?", [ts, e])).s;
      const deps = (await req.db.get("SELECT COALESCE(SUM(net),0) AS s FROM deposits WHERE status='approved' AND decided_at BETWEEN ? AND ?", [ts, e])).s;
      const wds = (await req.db.get("SELECT COALESCE(SUM(net),0) AS s FROM withdrawals WHERE status='approved' AND decided_at BETWEEN ? AND ?", [ts, e])).s;
      const users = (await req.db.get("SELECT COUNT(*) AS c FROM users WHERE role='player' AND created_at BETWEEN ? AND ?", [ts, e])).c;
      days.push([new Date(ts).toISOString().slice(0, 10), sales.c, money(req, sales.s, 'USD'), money(req, wins, 'USD'), money(req, sales.s - wins, 'USD'), money(req, deps, 'USD'), money(req, wds, 'USD'), users]);
      bars.push({ date: new Date(ts).toISOString().slice(0, 10), staked: sales.s, paid: wins });
    }
    const maxBar = Math.max(1, ...bars.map(b => b.staked));
    const barsHtml = bars.length ? ui.card('Daily staked vs paid out', bars.map(b =>
      `<div class="daybar"><span class="daybar-d">${b.date}</span><span class="daybar-track"><span class="daybar-fill stake" style="width:${Math.round(b.staked / maxBar * 100)}%"></span><span class="daybar-fill paid" style="width:${Math.round(b.paid / maxBar * 100)}%"></span></span><span class="daybar-v">${money(req, b.staked, 'USD')} staked · ${money(req, b.paid, 'USD')} paid</span></div>`).join('')
      + '<p class="muted">Gold = staked, green = paid out. Bars are scaled to the biggest day in the selected range.</p>') : '';
    body += barsHtml + ui.card('Business report', ui.table(['Date', 'Tickets', 'Staked', 'Paid out', 'GGR', 'Deposits', 'Withdrawals', 'New users'], days));
  } else if (type === 'login') {
    const rows = await req.db.query('SELECT * FROM login_history WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 500', [from, to]);
    const grp = (key) => { const m = {}; for (const r of rows) m[r[key] || '—'] = (m[r[key] || '—'] || 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]); };
    body += `<div class="grid2"><div>${ui.card('By country', ui.table(['Country', 'Logins'], grp('country')))}</div>
      <div>${ui.card('By browser', ui.table(['Browser', 'Logins'], grp('browser')))}${ui.card('By OS', ui.table(['OS', 'Logins'], grp('os')))}</div></div>` +
      ui.card('Login attempts', ui.table(['When', 'Email', 'IP', 'Country', 'Browser', 'OS', 'Success'], rows.slice(0, 200).map(l =>
        [d(l.created_at), esc(l.email), esc(l.ip), esc(l.country || '—'), esc(l.browser), esc(l.os), l.success ? '✓' : '✗'])));
  } else if (type === 'ticket') {
    const rows = await req.db.query(`SELECT t.*, u.email FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.created_at BETWEEN ? AND ? ORDER BY t.created_at DESC LIMIT 500`, [from, to]);
    body += ui.card('Ticket report', ui.table(['When', 'Ticket', 'Player', 'Pops', 'Wager', 'Draws', 'Total', 'Status'], rows.map(t =>
      [d(t.created_at), `<span class="code">${esc(t.public_id)}</span>`, esc(t.email), JSON.parse(t.pops || '[]').join(','), money(req, t.wager, t.currency), `${t.draw_type}×${t.num_draws}`, money(req, t.total, t.currency), ui.statusBadge(t.status)])));
  } else if (type === 'transaction') {
    const rows = await req.db.query('SELECT tr.*, u.email FROM transactions tr JOIN users u ON u.id=tr.user_id WHERE tr.created_at BETWEEN ? AND ? ORDER BY tr.created_at DESC LIMIT 500', [from, to]);
    body += ui.card('Transaction report', ui.table(['When', 'Player', 'Type', 'Amount', 'Balance after'], rows.map(t =>
      [d(t.created_at), esc(t.email), esc(t.type), `<span class="${t.amount >= 0 ? 'pos' : 'neg'}">${money(req, t.amount, t.currency)}</span>`, money(req, t.balance_after, t.currency)])));
  } else if (type === 'payment') {
    const rows = await req.db.query(`SELECT d.*, u.email FROM deposits d JOIN users u ON u.id=d.user_id WHERE d.created_at BETWEEN ? AND ? ORDER BY d.created_at DESC LIMIT 500`, [from, to]);
    body += ui.card('Payment report', ui.table(['When', 'ID', 'Player', 'Amount', 'Charge', 'Net', 'Status'], rows.map(x =>
      [d(x.created_at), `<span class="code">${esc(x.public_id)}</span>`, esc(x.email), money(req, x.amount, x.currency), money(req, x.charge, x.currency), money(req, x.net, x.currency), ui.statusBadge(x.status)])));
  } else {
    const rows = await req.db.query(`SELECT w.*, u.email FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.created_at BETWEEN ? AND ? ORDER BY w.created_at DESC LIMIT 500`, [from, to]);
    body += ui.card('Withdrawal report', ui.table(['When', 'ID', 'Player', 'Amount', 'Charge', 'Net', 'Status'], rows.map(x =>
      [d(x.created_at), `<span class="code">${esc(x.public_id)}</span>`, esc(x.email), money(req, x.amount, x.currency), money(req, x.charge, x.currency), money(req, x.net, x.currency), ui.statusBadge(x.status)])));
  }
  res.send(shell(req, '/reports', 'Reports', body));
});

/* ============================================================ SUPPORT */
router.get('/support', async (req, res) => {
  const status = req.query.status || '';
  const where = status ? 'WHERE s.status = ?' : '', params = status ? [status] : [];
  const rows = await req.db.query(`SELECT s.*, u.email FROM support_tickets s JOIN users u ON u.id=s.user_id ${where} ORDER BY s.updated_at DESC LIMIT 100`, params);
  const open = (await req.db.get("SELECT COUNT(*) AS c FROM support_tickets WHERE status='open'")).c;
  const prio = req.query.priority || '';
  const rowsP = prio ? rows.filter(t => (t.priority || 'medium') === prio) : rows;
  const body = `<div class="tabs"><a class="tab${!status ? ' active' : ''}" href="${R(req, '/support')}">All</a>
    <a class="tab${status === 'open' ? ' active' : ''}" href="${R(req, '/support')}?status=open">Open <span class="count">${open}</span></a>
    <a class="tab${status === 'answered' ? ' active' : ''}" href="${R(req, '/support')}?status=answered">Answered</a>
    <a class="tab${status === 'closed' ? ' active' : ''}" href="${R(req, '/support')}?status=closed">Closed</a></div>
    <div class="tabs"><span class="muted">Priority:</span>
    <a class="tab${!prio ? ' active' : ''}" href="${R(req, '/support')}">All</a>
    <a class="tab${prio === 'high' ? ' active' : ''}" href="${R(req, '/support')}?priority=high">High</a>
    <a class="tab${prio === 'medium' ? ' active' : ''}" href="${R(req, '/support')}?priority=medium">Medium</a>
    <a class="tab${prio === 'low' ? ' active' : ''}" href="${R(req, '/support')}?priority=low">Low</a></div>` +
    ui.table(['ID', 'Player', 'Subject', 'Priority', 'Status', 'Updated', ''], rowsP.map(t =>
      [`<span class="code">${esc(t.public_id)}</span>`, esc(t.email), esc(t.subject),
       (t.priority || 'medium') === 'high' ? ui.badge('high', 'err') : (t.priority || 'medium') === 'low' ? ui.badge('low', 'muted') : ui.badge('medium', 'info'),
       ui.statusBadge(t.status), d(t.updated_at),
       `<a class="btn btn-sm" href="${R(req, '/support/' + t.public_id)}">Open</a>`]));
  res.send(shell(req, '/support', 'Support Tickets', body));
});
router.get('/support/:publicId', async (req, res) => {
  const t = await req.db.get('SELECT s.*, u.email FROM support_tickets s JOIN users u ON u.id=s.user_id WHERE s.public_id = ?', [req.params.publicId]);
  if (!t) return notFound(req, res, 'Ticket not found.');
  const msgs = await req.db.query('SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY created_at', [t.id]);
  const body = ui.card('Ticket ' + t.public_id + ' — ' + t.subject, `
    <p class="muted">From: ${esc(t.email)} · Status: ${ui.statusBadge(t.status)}</p>
    <div class="msgs">${msgs.map(m => `<div class="msg${m.author_role !== 'player' ? ' staff' : ''}"><div class="msg-h">${esc(m.author_role)} · ${d(m.created_at)}</div><div>${esc(m.body)}</div></div>`).join('')}</div>
    ${t.status !== 'closed' ? ui.formHtml(R(req, '/support/' + t.public_id + '/reply'), [{ key: 'message', label: 'Reply', type: 'textarea' }], { csrf: req.csrfToken, submit: 'Send reply', grid: false }) : '<p class="muted">Ticket closed.</p>'}
    <div class="btn-row mt">
      ${t.status !== 'closed' ? `<form method="POST" action="${R(req, '/support/' + t.public_id + '/close')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">Close ticket</button></form>` : `<form method="POST" action="${R(req, '/support/' + t.public_id + '/reopen')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">Reopen</button></form>`}
    </div>`);
  res.send(shell(req, '/support', 'Support', body));
});
router.post('/support/:publicId/reply', async (req, res) => {
  const t = await req.db.get('SELECT * FROM support_tickets WHERE public_id = ?', [req.params.publicId]);
  if (!t || t.status === 'closed') return res.redirect(R(req, '/support'));
  const body = String(req.body.message || '').trim().slice(0, 5000);
  if (!body) return res.redirect(R(req, '/support/' + t.public_id));
  await req.db.run('INSERT INTO support_messages (ticket_id, author_id, author_role, body, created_at) VALUES (?, ?, ?, ?, ?)', [t.id, req.user.id, 'admin', body, now()]);
  await req.db.run("UPDATE support_tickets SET status='answered', updated_at=? WHERE id=?", [now(), t.id]);
  const u = await req.db.get('SELECT email, name FROM users WHERE id = ?', [t.user_id]);
  notify.send(req.db, req.settings, 'email', 'support_reply', u.email, { name: u.name, subject: t.subject }).catch(() => {});
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'support.reply', entity: 'support', entityId: t.public_id, detail: {}, ip: req.ip });
  res.redirect(R(req, '/support/' + t.public_id));
});
router.post('/support/:publicId/close', async (req, res) => {
  await req.db.run("UPDATE support_tickets SET status='closed', updated_at=? WHERE public_id=?", [now(), req.params.publicId]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'support.close', entity: 'support', entityId: req.params.publicId, detail: {}, ip: req.ip });
  res.redirect(R(req, '/support/' + req.params.publicId));
});
router.post('/support/:publicId/reopen', async (req, res) => {
  await req.db.run("UPDATE support_tickets SET status='open', updated_at=? WHERE public_id=?", [now(), req.params.publicId]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'support.reopen', entity: 'support', entityId: req.params.publicId, detail: {}, ip: req.ip });
  res.redirect(R(req, '/support/' + req.params.publicId));
});

/* ============================================================ EXTENSIONS */
router.get('/extensions', async (req, res) => {
  const exts = await getExtensions(req.db);
  const cards = Object.values(exts).map(e => {
    const fields = (EXTENSION_FIELDS[e.key] || []).map(f => `${f.label}: ${e.config[f.key] ? (f.type === 'password' ? '••••••' : esc(String(e.config[f.key]).slice(0, 60))) : '<span class="muted">not set</span>'}`).join('<br>');
    return `<div class="card"><div class="card-h"><h3>${esc(e.name)}</h3><div>${e.enabled ? ui.badge('enabled', 'ok') : ui.badge('disabled', 'muted')}</div></div>
      <div class="card-b">${fields || '<span class="muted">No settings.</span>'}
      <div class="btn-row mt">
        <a class="btn btn-sm" href="${R(req, '/extensions/' + e.key)}">Configure</a>
        <form method="POST" action="${R(req, '/extensions/' + e.key + '/toggle')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}">
          <button class="btn btn-sm">${e.enabled ? 'Disable' : 'Enable'}</button></form>
      </div></div></div>`;
  }).join('');
  res.send(shell(req, '/extensions', 'Extensions', `<div class="grid2">${cards}</div>
    <p class="muted">Every integration has an on/off switch. With an extension OFF or unconfigured, the site works fully — the feature is simply skipped.</p>`));
});
router.get('/extensions/:key', async (req, res) => {
  const e = (await getExtensions(req.db))[req.params.key];
  if (!e) return notFound(req, res, 'Extension not found.');
  const fields = (EXTENSION_FIELDS[e.key] || []).map(f =>
    f.type === 'select' ? { key: f.key, label: f.label, type: 'select', options: f.options, value: e.config[f.key] || '' }
    : f.type === 'textarea' ? { key: f.key, label: f.label, type: 'textarea', value: e.config[f.key] || '' }
    : { key: f.key, label: f.label, type: f.type === 'password' ? 'password' : 'text', value: f.type === 'password' ? '' : (e.config[f.key] || ''), help: f.type === 'password' ? 'Leave blank to keep saved value.' : '' });
  const body = ui.card('Configure — ' + e.name, ui.formHtml(R(req, '/extensions/' + e.key),
    [...fields, { key: 'enabled', label: 'Enabled', type: 'checkbox', value: e.enabled }],
    { csrf: req.csrfToken, submit: 'Save' }));
  res.send(shell(req, '/extensions', 'Extension — ' + e.name, body));
});
router.post('/extensions/:key', async (req, res) => {
  const exts = await getExtensions(req.db);
  const e = exts[req.params.key];
  if (!e) return notFound(req, res, 'Extension not found.');
  const config = {};
  for (const f of (EXTENSION_FIELDS[e.key] || [])) {
    const v = String(req.body[f.key] || '');
    if (f.type === 'password' && !v) continue;
    if (f.required && !v) { await req.setFlash('error', `"${f.label}" is required.`); return res.redirect(R(req, '/extensions/' + e.key)); }
    config[f.key] = v;
  }
  await setExtension(req.db, e.key, { enabled: !!req.body.enabled, config });
  // mirror well-known keys into env-backed settings where the frontend reads them
  if (e.key === 'recaptcha' && config.site_key) { process.env.RECAPTCHA_SITE_KEY = config.site_key; }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'extension.update', entity: 'extension', entityId: e.key, detail: { enabled: !!req.body.enabled }, ip: req.ip });
  await req.setFlash('success', 'Extension saved.');
  res.redirect(R(req, '/extensions'));
});
router.post('/extensions/:key/toggle', async (req, res) => {
  const e = (await getExtensions(req.db))[req.params.key];
  if (!e) return notFound(req, res, 'Extension not found.');
  await setExtension(req.db, e.key, { enabled: !e.enabled });
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'extension.toggle', entity: 'extension', entityId: e.key, detail: { enabled: !e.enabled }, ip: req.ip });
  res.redirect(R(req, '/extensions'));
});

/* ============================================================ NOTIFICATIONS */
router.get('/notifications', async (req, res) => {
  const tab = req.query.tab || 'templates';
  const tabs = [['templates', 'Templates'], ['outbox', 'Outbox'], ['providers', 'Providers'], ['send', 'Send Notification']]
    .map(([k, l]) => `<a class="tab${tab === k ? ' active' : ''}" href="${R(req, '/notifications')}?tab=${k}">${l}</a>`).join('');
  let body = `<div class="tabs">${tabs}</div>`;
  if (tab === 'templates') {
    const rows = await req.db.query('SELECT * FROM notif_templates ORDER BY channel, slug');
    body += ui.table(['Channel', 'Slug', 'Subject', 'Status', ''], rows.map(t =>
      [ui.badge(t.channel, 'info'), `<span class="code">${esc(t.slug)}</span>`, esc(t.subject || '—'),
       t.enabled ? ui.badge('enabled', 'ok') : ui.badge('disabled', 'muted'),
       `<a class="btn btn-sm" href="${R(req, '/notifications/' + t.id)}">Edit</a>`]));
  } else if (tab === 'send') {
    const players = await req.db.query("SELECT id, email, name FROM users WHERE role = 'player' AND status = 'active' ORDER BY email LIMIT 500");
    body += ui.card('Send notification to players',
      `<form method="POST" action="${R(req, '/notifications/send')}" class="adm-form"><input type="hidden" name="_csrf" value="${req.csrfToken}">
      <div class="field"><label>Recipient</label><select name="to">
        <option value="all">All active players</option>
        <option value="seg:with_balance">With balance</option>
        <option value="seg:empty_balance">Empty balance</option>
        <option value="seg:deposited">Have deposited</option>
        <option value="seg:not_deposited">Never deposited</option>
        <option value="seg:pending_deposit">Pending deposit</option>
        <option value="seg:pending_withdrawal">Pending withdrawal</option>
        <option value="seg:top_depositors">Top 10 depositors</option>
        <option value="seg:inactive_7d">Inactive 7+ days (no login)</option>
        ${players.map(u => `<option value="${u.id}">${esc(u.email)} (${esc(u.name)})</option>`).join('')}
      </select></div>
      <div class="field"><label>Subject</label><input type="text" name="subject" required maxlength="150"></div>
      <div class="field"><label>Message</label><textarea name="message" rows="5" required></textarea></div>
      <div class="field"><label>Start from # (1 = first recipient in the audience list)</label><input type="number" name="start_from" value="1" min="1"></div>
      <div class="field"><label>Per batch (0 = send all at once)</label><input type="number" name="per_batch" value="0" min="0"></div>
      <div class="field"><label>Cooling period between batches (seconds, 0 = no batching)</label><input type="number" name="cooling" value="0" min="0"></div>
      <div class="mt"><button class="btn btn-p" type="submit">Send</button></div></form>
      <p class="muted">Batching: the first batch sends now; later batches are queued with cooling-period spacing and sent by the "Notification batches" cron job (every 5 minutes) or the "Process due now" button in the Outbox. Sends an email via the configured SMTP provider (or logs to the outbox when no provider is configured — nothing breaks).</p>`);
  } else if (tab === 'outbox') {
    const oq = (req.query.oq || '').trim(), ofrom = req.query.ofrom || '', oto = req.query.oto || '';
    const ow = [], op = [];
    if (oq) { ow.push('(to_addr LIKE ? OR subject LIKE ?)'); op.push('%' + oq + '%', '%' + oq + '%'); }
    if (ofrom) { ow.push('created_at >= ?'); op.push(new Date(ofrom + 'T00:00:00Z').getTime()); }
    if (oto) { ow.push('created_at <= ?'); op.push(new Date(oto + 'T23:59:59Z').getTime()); }
    const owq = ow.length ? 'WHERE ' + ow.join(' AND ') : '';
    const rows = await req.db.query(`SELECT * FROM notifications_log ${owq} ORDER BY created_at DESC LIMIT 100`, op);
    body += `<form method="GET" class="filters"><input type="hidden" name="tab" value="outbox">
      <input type="text" name="oq" value="${esc(oq)}" placeholder="Search email / subject">
      <input type="date" name="ofrom" value="${esc(ofrom)}"><input type="date" name="oto" value="${esc(oto)}">
      <button class="btn btn-sm" type="submit">Filter</button></form>
    <form method="POST" action="${R(req, '/notifications/process-due')}" style="margin-bottom:16px"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm" type="submit">Process due now (send queued batches whose cooling period elapsed)</button></form>` +
    ui.table(['When', 'Channel', 'To', 'Subject', 'Status', 'Error', ''], rows.map(l =>
      [d(l.created_at), esc(l.channel), esc(l.to_addr), esc(l.subject),
       ui.statusBadge(l.status) + (l.status === 'queued' && l.scheduled_at ? `<br><span class="muted">batch ${l.batch_no || '—'} · due ${d(l.scheduled_at)}</span>` : ''),
       esc(l.error || '—'),
       `<a class="btn btn-sm" href="${R(req, '/notifications/log/' + l.id)}">Detail</a>`]));
  } else {
    const smtp = !!process.env.SMTP_HOST, sms = !!(process.env.TWILIO_SID && process.env.TWILIO_TOKEN);
    body += ui.card('Email (SMTP)', `<p>${smtp ? ui.badge('configured', 'ok') + ' Host: ' + esc(process.env.SMTP_HOST) : ui.badge('not configured', 'warn') + ' — set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM in .env (see README).'}</p>`) +
      ui.card('SMS (Twilio)', `<p>${sms ? ui.badge('configured', 'ok') : ui.badge('not configured', 'warn') + ' — set TWILIO_SID/TWILIO_TOKEN/TWILIO_FROM in .env.'}</p>`) +
      ui.card('Push', `<p>${ui.badge('not configured', 'warn')} — plug an FCM/APNs provider into <span class="code">lib/notify.js</span>.</p>`) +
      `<p class="muted">When a provider is not configured, notifications are logged to the outbox and the site keeps working — nothing breaks.</p>`;
  }
  res.send(shell(req, '/notifications', 'Notifications', body));
});
router.get('/notifications/log/:id', async (req, res) => {
  const l = await req.db.get('SELECT * FROM notifications_log WHERE id = ?', [req.params.id]);
  if (!l) return notFound(req, res, 'Log entry not found.');
  const body = ui.card('Notification detail', `<p><strong>When:</strong> ${d(l.created_at)} · <strong>Channel:</strong> ${esc(l.channel)} · <strong>To:</strong> ${esc(l.to_addr)} · <strong>Status:</strong> ${ui.statusBadge(l.status)}</p>
    <p><strong>Subject:</strong> ${esc(l.subject)}</p>
    <div class="instruction"><p class="muted pre">${esc(l.body || '(no body stored)')}</p></div>
    ${l.error ? `<p><strong>Error:</strong> ${esc(l.error)}</p>` : ''}`);
  res.send(shell(req, '/notifications', 'Notification Detail', body));
});
router.post('/notifications/send', async (req, res) => {
  const notify = require('../lib/notify');
  const { subject, message } = req.body;
  if (!subject || !message) { await req.setFlash('error', 'Subject and message are required.'); return res.redirect(R(req, '/notifications?tab=send')); }
  let targets;
  if (req.body.to === 'all') targets = await req.db.query("SELECT id, email, name FROM users WHERE role = 'player' AND status = 'active' ORDER BY id");
  else if (req.body.to === 'seg:with_balance') targets = await req.db.query("SELECT u.id, u.email, u.name FROM users u WHERE u.role = 'player' AND u.status = 'active' AND EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = u.id AND w.balance > 0) ORDER BY u.id");
  else if (req.body.to === 'seg:empty_balance') targets = await req.db.query("SELECT u.id, u.email, u.name FROM users u WHERE u.role = 'player' AND u.status = 'active' AND NOT EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = u.id AND w.balance > 0) ORDER BY u.id");
  else if (req.body.to === 'seg:deposited') targets = await req.db.query("SELECT DISTINCT u.id, u.email, u.name FROM users u JOIN deposits dd ON dd.user_id = u.id AND dd.status = 'approved' WHERE u.role = 'player' AND u.status = 'active' ORDER BY u.id");
  else if (req.body.to === 'seg:not_deposited') targets = await req.db.query("SELECT u.id, u.email, u.name FROM users u WHERE u.role = 'player' AND u.status = 'active' AND NOT EXISTS (SELECT 1 FROM deposits dd WHERE dd.user_id = u.id AND dd.status = 'approved') ORDER BY u.id");
  else if (req.body.to === 'seg:pending_deposit') targets = await req.db.query("SELECT DISTINCT u.id, u.email, u.name FROM users u JOIN deposits dd ON dd.user_id = u.id AND dd.status = 'pending' WHERE u.role = 'player' AND u.status = 'active' ORDER BY u.id");
  else if (req.body.to === 'seg:pending_withdrawal') targets = await req.db.query("SELECT DISTINCT u.id, u.email, u.name FROM users u JOIN withdrawals ww ON ww.user_id = u.id AND ww.status = 'pending' WHERE u.role = 'player' AND u.status = 'active' ORDER BY u.id");
  else if (req.body.to === 'seg:top_depositors') targets = await req.db.query("SELECT u.id, u.email, u.name FROM users u JOIN deposits dd ON dd.user_id = u.id AND dd.status = 'approved' WHERE u.role = 'player' AND u.status = 'active' GROUP BY u.id ORDER BY SUM(dd.net) DESC LIMIT 10");
  else if (req.body.to === 'seg:inactive_7d') targets = await req.db.query("SELECT id, email, name FROM users WHERE role = 'player' AND status = 'active' AND (last_login_at IS NULL OR last_login_at < ?) ORDER BY id", [now() - 7 * 86400000]);
  else {
    const u = await req.db.get('SELECT id, email, name FROM users WHERE id = ?', [req.body.to]);
    targets = u ? [u] : [];
  }
  // Batching: start_from is a 1-based index into the audience list; per_batch
  // splits the remainder into batches; batch 1 sends now, later batches are
  // queued with cooling-period spacing (sent by cron or "Process due now").
  const startFrom = Math.max(1, parseInt(req.body.start_from, 10) || 1);
  const perBatch = Math.max(0, parseInt(req.body.per_batch, 10) || 0);
  const cooling = Math.max(0, parseInt(req.body.cooling, 10) || 0);
  const sliced = targets.slice(startFrom - 1);
  let sent = 0, failed = 0, queued = 0;
  if (!perBatch || cooling <= 0 || sliced.length <= perBatch) {
    for (const t of sliced) {
      const r = await notify.sendRaw(req.db, req.settings, 'email', t.email, subject, message);
      if (r.status === 'sent') sent++; else failed++;
    }
  } else {
    const batches = [];
    for (let i = 0; i < sliced.length; i += perBatch) batches.push(sliced.slice(i, i + perBatch));
    for (let bi = 0; bi < batches.length; bi++) {
      if (bi === 0) {
        for (const t of batches[bi]) {
          const r = await notify.sendRaw(req.db, req.settings, 'email', t.email, subject, message);
          if (r.status === 'sent') sent++; else failed++;
        }
      } else {
        const at = now() + cooling * 1000 * bi;
        for (const t of batches[bi]) {
          await req.db.run("INSERT INTO notifications_log (channel, to_addr, subject, body, status, error, created_at, batch_no, scheduled_at) VALUES ('email', ?, ?, ?, 'queued', '', ?, ?, ?)", [t.email, subject, message, now(), bi + 1, at]);
          queued++;
        }
      }
    }
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'notify.send', entity: 'notification', entityId: '', detail: { to: req.body.to, sent, failed, queued, startFrom, perBatch, cooling, subject }, ip: req.ip });
  await req.setFlash('success', `Notification processed for ${sliced.length} player(s): ${sent} sent, ${failed} failed, ${queued} queued in later batches (see Outbox for reasons).`);
  res.redirect(R(req, '/notifications?tab=outbox'));
});
router.post('/notifications/process-due', async (req, res) => {
  const notify = require('../lib/notify');
  const due = await req.db.query("SELECT * FROM notifications_log WHERE status = 'queued' AND scheduled_at > 0 AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 200", [now()]);
  let sent = 0, failed = 0;
  for (const row of due) {
    const r = await notify.sendQueued(req.db, req.settings, row);
    if (r.status === 'sent') sent++; else failed++;
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'notify.process_due', entity: 'notification', entityId: '', detail: { due: due.length, sent, failed }, ip: req.ip });
  await req.setFlash('success', `Due batches processed: ${sent} sent, ${failed} failed (${due.length} due).`);
  res.redirect(R(req, '/notifications?tab=outbox'));
});
router.get('/notifications/:id', async (req, res) => {
  const t = await req.db.get('SELECT * FROM notif_templates WHERE id = ?', [req.params.id]);
  if (!t) return notFound(req, res, 'Template not found.');
  const body = ui.card(`Template — ${t.channel}/${t.slug}`,
    `<p class="muted">Available variables: {{site}} {{name}} {{amount}} {{ticket}} {{code}} {{minutes}} {{status}} {{link}} {{subject}}</p>` +
    ui.formHtml(R(req, '/notifications/' + t.id), [
      { key: 'subject', label: 'Subject (email/push)', type: 'text', value: t.subject },
      { key: 'body', label: 'Body', type: 'textarea', value: t.body },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', value: t.enabled },
    ], { csrf: req.csrfToken, submit: 'Save template', grid: false }));
  res.send(shell(req, '/notifications', 'Edit Template', body));
});
router.post('/notifications/:id', async (req, res) => {
  await req.db.run('UPDATE notif_templates SET subject = ?, body = ?, enabled = ? WHERE id = ?',
    [String(req.body.subject || '').slice(0, 255), String(req.body.body || ''), req.body.enabled ? 1 : 0, req.params.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'notif.template_update', entity: 'template', entityId: req.params.id, detail: {}, ip: req.ip });
  await req.setFlash('success', 'Template saved.');
  res.redirect(R(req, '/notifications/' + req.params.id));
});

/* ============================================================ PAGES & CONTENT */
router.get('/pages', async (req, res) => {
  const tab = req.query.tab || 'pages';
  const tabs = [['pages', 'Manage Pages'], ['content', 'Frontend Content']]
    .map(([k, l]) => `<a class="tab${tab === k ? ' active' : ''}" href="${R(req, '/pages')}?tab=${k}">${l}</a>`).join('');
  let body = `<div class="tabs">${tabs}</div>`;
  if (tab === 'pages') {
    const rows = await req.db.query('SELECT * FROM pages ORDER BY sort, name');
    body += `<div class="btn-row" style="margin-bottom:16px"><a class="btn btn-p" href="${R(req, '/pages/new')}">+ New page</a></div>` +
      ui.table(['Name', 'Slug', 'Title', 'SEO title', 'Status', ''], rows.map(p =>
        [esc(p.name), `<span class="code">/page/${esc(p.slug)}</span>`, esc(p.title), esc(p.meta_title || '—'), ui.statusBadge(p.status),
         `<a class="btn btn-sm" href="${R(req, '/pages/' + p.id)}">Edit</a>`]));
  } else {
    const rows = await req.db.query('SELECT * FROM content_blocks ORDER BY `key`');
    body += ui.table(['Key', 'Title', 'Updated', ''], rows.map(b =>
      [`<span class="code">${esc(b.key)}</span>`, esc(b.title), d(b.updated_at), `<a class="btn btn-sm" href="${R(req, '/content/' + encodeURIComponent(b.key))}">Edit</a>`]));
  }
  res.send(shell(req, '/pages', 'Pages & Content', body));
});
const PAGE_FIELDS = (p = {}) => [
  { key: 'name', label: 'Name', type: 'text', value: p.name, required: true },
  { key: 'slug', label: 'Slug', type: 'text', value: p.slug, required: true, help: 'URL: /page/<slug> — lowercase letters, numbers, dashes.' },
  { key: 'title', label: 'Title', type: 'text', value: p.title, required: true },
  { key: 'meta_title', label: 'SEO meta title', type: 'text', value: p.meta_title },
  { key: 'meta_desc', label: 'SEO meta description', type: 'textarea', value: p.meta_desc },
  { key: 'body', label: 'Body (HTML). Use {{content:key}} to embed a content block.', type: 'textarea', value: p.body },
  { key: 'status', label: 'Status', type: 'select', options: ['published', 'draft'], value: p.status || 'published' },
];
router.get('/pages/new', (req, res) => res.send(shell(req, '/pages', 'New Page', ui.card('Page', ui.formHtml(R(req, '/pages/new'), PAGE_FIELDS(), { csrf: req.csrfToken, submit: 'Create page', grid: false })))));
router.post('/pages/new', async (req, res) => {
  const slug = req.body.slug.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) { await req.setFlash('error', 'Invalid slug.'); return res.redirect(R(req, '/pages/new')); }
  try {
    await req.db.run('INSERT INTO pages (name, slug, title, meta_title, meta_desc, body, status, sort) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
      [req.body.name.trim(), slug, req.body.title.trim(), req.body.meta_title || '', req.body.meta_desc || '', req.body.body || '', req.body.status]);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'page.create', entity: 'page', entityId: slug, detail: {}, ip: req.ip });
    await req.setFlash('success', 'Page created.');
  } catch (e) { await req.setFlash('error', 'Could not create page (slug may exist).'); return res.redirect(R(req, '/pages/new')); }
  res.redirect(R(req, '/pages'));
});
router.get('/pages/:id', async (req, res) => {
  const p = await req.db.get('SELECT * FROM pages WHERE id = ?', [req.params.id]);
  if (!p) return notFound(req, res, 'Page not found.');
  res.send(shell(req, '/pages', 'Edit — ' + p.name,
    ui.card('Page', ui.formHtml(R(req, '/pages/' + p.id), PAGE_FIELDS(p), { csrf: req.csrfToken, submit: 'Save page', grid: false })) +
    `<form method="POST" action="${R(req, '/pages/' + p.id + '/delete')}" class="mt"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-d" data-confirm="Delete this page?">Delete page</button></form>`));
});
router.post('/pages/:id', async (req, res) => {
  const slug = req.body.slug.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) { await req.setFlash('error', 'Invalid slug.'); return res.redirect(R(req, '/pages/' + req.params.id)); }
  try {
    await req.db.run('UPDATE pages SET name=?, slug=?, title=?, meta_title=?, meta_desc=?, body=?, status=? WHERE id=?',
      [req.body.name.trim(), slug, req.body.title.trim(), req.body.meta_title || '', req.body.meta_desc || '', req.body.body || '', req.body.status || 'draft', req.params.id]);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'page.update', entity: 'page', entityId: slug, detail: {}, ip: req.ip });
    await req.setFlash('success', 'Page saved.');
  } catch (e) { await req.setFlash('error', 'Could not save page: ' + e.message); }
  res.redirect(R(req, '/pages/' + req.params.id));
});
router.post('/pages/:id/delete', async (req, res) => {
  await req.db.run('DELETE FROM pages WHERE id = ?', [req.params.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'page.delete', entity: 'page', entityId: req.params.id, detail: {}, ip: req.ip });
  await req.setFlash('success', 'Page deleted.');
  res.redirect(R(req, '/pages'));
});
router.get('/content/:key', async (req, res) => {
  const b = await req.db.get('SELECT * FROM content_blocks WHERE `key` = ?', [req.params.key]);
  if (!b) return notFound(req, res, 'Content block not found.');
  res.send(shell(req, '/pages', 'Content — ' + b.key,
    ui.card('Content block', ui.formHtml(R(req, '/content/' + encodeURIComponent(b.key)), [
      { key: 'title', label: 'Title', type: 'text', value: b.title },
      { key: 'body', label: 'Body (HTML)', type: 'textarea', value: b.body },
    ], { csrf: req.csrfToken, submit: 'Save content', grid: false }))));
});
router.post('/content/:key', async (req, res) => {
  await req.db.run('UPDATE content_blocks SET title = ?, body = ?, updated_at = ? WHERE `key` = ?',
    [req.body.title || '', req.body.body || '', now(), req.params.key]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'content.update', entity: 'content', entityId: req.params.key, detail: {}, ip: req.ip });
  await req.setFlash('success', 'Content saved.');
  res.redirect(R(req, '/content/' + encodeURIComponent(req.params.key)));
});

/* ============================================================ CRON JOBS */
router.get('/cron', async (req, res) => {
  const jobs = await req.db.query('SELECT * FROM cron_jobs ORDER BY id');
  const body = ui.card('Scheduled jobs', `<p class="muted">The scheduler runs inside the app (every 60s). Pause/resume or run any job on demand.</p>` +
    ui.table(['Job', 'Every (min)', 'Next run', 'Last run', 'Last status', 'Message', 'Status', ''],
      jobs.map(j => [esc(j.name) + `<br><small class="muted">${esc(j.description || '')}</small>`, j.interval_minutes,
        j.next_run_at ? d(j.next_run_at) : '—', j.last_run_at ? d(j.last_run_at) : 'never',
        j.last_status ? ui.statusBadge(j.last_status) : '—', `<small>${esc(j.last_message || '')}</small>`,
        j.status === 'active' ? ui.badge('active', 'ok') : ui.badge('paused', 'muted'),
        `<form method="POST" action="${R(req, '/cron/' + j.id + '/run')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">Run now</button></form>
         <form method="POST" action="${R(req, '/cron/' + j.id + '/toggle')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">${j.status === 'active' ? 'Pause' : 'Resume'}</button></form>`])) +
    ui.card('Edit schedule', ui.formHtml(R(req, '/cron/schedule'),
      (await req.db.query('SELECT * FROM cron_jobs ORDER BY id')).map(j => ({ key: 'interval_' + j.id, label: j.name + ' (minutes)', type: 'number', value: String(j.interval_minutes) })),
      { csrf: req.csrfToken, submit: 'Save schedules' })));
  res.send(shell(req, '/cron', 'Cron Jobs', body));
});
router.post('/cron/schedule', async (req, res) => {
  const jobs = await req.db.query('SELECT * FROM cron_jobs');
  for (const j of jobs) {
    const v = Math.max(1, parseInt(req.body['interval_' + j.id], 10) || j.interval_minutes);
    await req.db.run('UPDATE cron_jobs SET interval_minutes = ?, next_run_at = ? WHERE id = ?', [v, now() + v * 60000, j.id]);
  }
  await req.setFlash('success', 'Schedules saved.');
  res.redirect(R(req, '/cron'));
});
router.post('/cron/:id/run', async (req, res) => {
  try {
    const msg = await runNow({ db: req.db, driver: req.driver }, req.params.id);
    await req.setFlash('success', 'Job ran: ' + msg);
  } catch (e) { await req.setFlash('error', 'Job failed: ' + e.message); }
  res.redirect(R(req, '/cron'));
});
router.post('/cron/:id/toggle', async (req, res) => {
  const j = await req.db.get('SELECT * FROM cron_jobs WHERE id = ?', [req.params.id]);
  if (j) await req.db.run("UPDATE cron_jobs SET status = CASE WHEN status='active' THEN 'paused' ELSE 'active' END, next_run_at = ? WHERE id = ?", [now() + j.interval_minutes * 60000, j.id]);
  res.redirect(R(req, '/cron'));
});

/* Global login history (ViserLab-style report: IP, browser, OS, success) */
router.get('/login-history', async (req, res) => {
  const page = pageOf(req), q = (req.query.q || '').trim();
  const where = q ? 'WHERE lh.email LIKE ?' : '', params = q ? ['%' + q + '%'] : [];
  const total = (await req.db.get(`SELECT COUNT(*) AS c FROM login_history lh ${where}`, params)).c;
  const rows = await req.db.query(
    `SELECT lh.*, u.name FROM login_history lh LEFT JOIN users u ON u.id = lh.user_id
     ${where} ORDER BY lh.created_at DESC LIMIT ? OFFSET ?`, [...params, PER, (page - 1) * PER]);
  const body = `<form method="GET" class="filters"><input type="text" name="q" value="${esc(q)}" placeholder="Search email"><button class="btn btn-sm" type="submit">Filter</button></form>` +
    ui.table(['User', 'Email', 'IP', 'Browser', 'OS', 'Result', 'When'],
      rows.map(r => [esc(r.name || '—'), esc(r.email || '—'), esc(r.ip || '—'), esc(r.browser || '—'), esc(r.os || '—'),
        r.success ? ui.badge('success', 'ok') : ui.badge('failed', 'err'), d(r.created_at)])) +
    ui.paginate(R(req, '/login-history') + (q ? '?q=' + encodeURIComponent(q) : ''), page, PER, total);
  res.send(shell(req, '/login-history', 'Login History', body));
});
/* Referrals: who referred whom + commission earned (ViserLab-style referral) */
router.get('/referrals', async (req, res) => {
  const page = pageOf(req);
  const total = (await req.db.get('SELECT COUNT(*) AS c FROM users WHERE referred_by IS NOT NULL')).c;
  const rows = await req.db.query(
    `SELECT u.email AS referred_email, u.name AS referred_name, u.created_at, r.email AS referrer_email,
       (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE user_id = r.id AND type = 'referral_commission') AS earned
     FROM users u JOIN users r ON r.id = u.referred_by ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
    [PER, (page - 1) * PER]);
  const body = ui.table(['Referred player', 'Referrer', 'Joined', 'Commission earned by referrer'],
    rows.map(x => [esc(x.referred_email) + ' (' + esc(x.referred_name) + ')', esc(x.referrer_email), d(x.created_at),
      money(req, x.earned, getS(req.settings, 'base_currency', 'USD'))])) +
    ui.paginate(R(req, '/referrals'), page, PER, total);
  res.send(shell(req, '/referrals', 'Referrals', body));
});
/* Clear settings cache (operator tool — settings cache is 5s TTL, this forces a reload) */
router.post('/settings/clear-cache', async (req, res) => {
  const { invalidate } = require('../lib/settings');
  invalidate();
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'settings.cache_clear', entity: 'settings', entityId: '', detail: {}, ip: req.ip });
  await req.setFlash('success', 'Settings cache cleared.');
  res.redirect(R(req, '/settings'));
});
/* ============================================================ SETTINGS */
const TOGGLES = [
  ['registration_enabled', 'Registration open', 'Allow new players to register.'],
  ['force_ssl', 'Force SSL', 'Mark cookies Secure (enable when serving HTTPS).'],
  ['policy_agreement', 'Policy agreement', 'Require players to accept terms at registration.'],
  ['secure_password', 'Secure password', 'Enforce strong passwords (8+ chars, upper/lower/number).'],
  ['kyc_required', 'KYC required', 'Flag for future KYC gating (currently informational).'],
  ['email_verification', 'Email verification', 'Require email verification (provider needed for auto-send).'],
  ['mobile_verification', 'Mobile verification', 'Require mobile verification (SMS provider needed).'],
  ['notifications_enabled', 'Notifications', 'Master switch for email/SMS/push notifications.'],
  ['otp_registration', 'OTP-gated registration', 'Require an operator-issued signup code to register.'],
  ['google_oauth_enabled', 'Google sign-in', 'Show Google sign-in (needs OAuth credentials).'],
  ['deposits_enabled', 'Deposits (global)', 'Master kill switch for deposits.'],
  ['withdrawals_enabled', 'Withdrawals (global)', 'Master kill switch for withdrawals.'],
  ['cookie_consent_enabled', 'Cookie consent banner', 'Show the GDPR cookie banner.'],
  ['phone_otp_enabled', 'Phone OTP login', 'Allow sign-in via SMS code (OFF by default; enable later from here)'],
  ['email_otp_enabled', 'Email OTP login', 'Allow sign-in via email code (OFF by default; enable later from here)'],
  ['withdrawal_otp_enabled', 'Withdrawal OTP', 'Require a one-time code on every withdrawal (ONLY place OTP is used; toggleable here)'],
  ['maintenance_mode', 'Maintenance mode', 'Block the player site with a maintenance page (admin panel + admin login still work).'],
  ['referral_enabled', 'Referral program', 'Players earn commission when referred friends buy tickets.'],
  ['facebook_oauth_enabled', 'Facebook login', 'Needs FACEBOOK_APP_ID/SECRET env vars'],
  ['google_oauth_enabled', 'Google login', 'Needs GOOGLE_CLIENT_ID/SECRET env vars'],
  ['password_login_enabled', 'Password login (legacy)', 'Keep old email+password as fallback'],
];
router.get('/settings', async (req, res) => {
  const s = req.settings;
  const prizes = await req.db.query('SELECT pops_count, multiplier FROM prize_table ORDER BY pops_count');
  const body = `
  ${ui.card('System configuration', ui.formHtml(R(req, '/settings/toggles'),
    TOGGLES.map(([k, label, help]) => ({ key: k, label, type: 'checkbox', value: getS(s, k, '0') === '1', help })),
    { csrf: req.csrfToken, submit: 'Save toggles' }))}
  ${ui.card('Operator tools', `<form method="POST" action="${R(req, '/settings/clear-cache')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-g" type="submit">Clear settings cache</button></form><p class="muted">Forces settings to reload from the database (cache is otherwise 5 seconds).</p>`)}
  ${ui.card('Game economy — every amount is set here', ui.formHtml(R(req, '/settings/economy'), [
      { key: 'wager_options', label: 'Wager options (e.g. 1,2,5,10)', type: 'text', value: getS(s, 'wager_options', '1,2,5,10') },
      { key: 'max_pops', label: 'Max pops per ticket', type: 'number', value: getS(s, 'max_pops', '15') },
      { key: 'max_draws', label: 'Max consecutive draws', type: 'number', value: getS(s, 'max_draws', '7') },
      { key: 'day_draw_time', label: 'Day draw time (HH:MM)', type: 'text', value: getS(s, 'day_draw_time', '14:00') },
      { key: 'eve_draw_time', label: 'Evening draw time (HH:MM)', type: 'text', value: getS(s, 'eve_draw_time', '21:00') },
      { key: 'commission_rate', label: 'Agent commission % on ticket sales', type: 'text', value: getS(s, 'commission_rate', '5') },
      { key: 'deposit_mode', label: 'Deposit mode', type: 'select', options: ['manual', 'auto'], value: getS(s, 'deposit_mode', 'manual') },
      { key: 'withdrawal_mode', label: 'Withdrawal mode', type: 'select', options: ['manual', 'auto'], value: getS(s, 'withdrawal_mode', 'manual') },
      { key: 'auto_approve_deposit_limit', label: 'Auto-approve deposits up to (e.g. 20.00; 0 = never)', type: 'text', value: getS(s, 'auto_approve_deposit_limit', '0') },
      { key: 'referral_rate', label: 'Referral commission % on referred ticket purchases', type: 'text', value: getS(s, 'referral_rate', '5') },
      { key: 'multi_draw_discounts', label: 'Multi-draw discounts (draws:percent, comma-separated, e.g. 5:12,8:14,12:20)', type: 'text', value: getS(s, 'multi_draw_discounts', ''), help: 'Exact-match bundles: buying exactly N draws gets N% off the ticket total.' },
    ], { csrf: req.csrfToken, submit: 'Save economy' }) +
    `<h4 class="mt">Prize table — multiplier per pops count (win = wager × multiplier)</h4>
     <form method="POST" action="${R(req, '/settings/prizes')}" class="adm-form"><input type="hidden" name="_csrf" value="${req.csrfToken}">
     <div class="prize-grid">${prizes.map(p => `<div class="field"><label>${p.pops_count} pop${p.pops_count > 1 ? 's' : ''} → ×</label><input type="number" name="mult_${p.pops_count}" value="${p.multiplier}" min="1"></div>`).join('')}</div>
     <div class="mt"><button class="btn btn-p" type="submit">Save prize table</button></div></form>`)}
  ${ui.card('Phone countries — dial codes & blocks', ui.formHtml(R(req, '/settings/phone-countries'), [
      { key: 'blocked_phone_countries', label: 'Blocked countries (ISO codes, comma-separated)', type: 'text', value: getS(s, 'blocked_phone_countries', ''), help: 'Example: PK,BD — players from these countries will NOT see their dial code in the phone dropdown and cannot register with that country number. Leave empty to allow all countries.' },
    ], { csrf: req.csrfToken, submit: 'Save phone countries' })) + `<p class="muted">The register and OTP phone fields show a country dial-code dropdown with all ${require('../lib/phone-countries').COUNTRIES.length} countries. Blocked countries are hidden from the dropdown and rejected server-side.</p>`}
  ${ui.card('Homepage hero stats', ui.formHtml(R(req, '/settings/hero-stats'), [
      { key: 'hero_stats_mode', label: 'Stats mode', type: 'select', options: ['real', 'marketing'], value: getS(s, 'hero_stats_mode', 'real'), help: 'Real = true DB counts. Marketing = base numbers below that tick up live.' },
      { key: 'hero_stats_players_base', label: 'Marketing base: players', type: 'number', value: getS(s, 'hero_stats_players_base', '1250') },
      { key: 'hero_stats_paid_base', label: 'Marketing base: paid out (cents)', type: 'number', value: getS(s, 'hero_stats_paid_base', '50000') },
    ], { csrf: req.csrfToken, submit: 'Save hero stats' }))}
  ${ui.card('Currencies', `<p class="muted">JSON list of supported currencies. <span class="code">rate</span> = units per 1 base unit. First currency is the display default.</p>` +
    ui.formHtml(R(req, '/settings/currencies'), [
      { key: 'currencies', label: 'Currencies JSON', type: 'textarea', value: getS(s, 'currencies', '[]') },
      { key: 'base_currency', label: 'Base currency code', type: 'text', value: getS(s, 'base_currency', 'USD') },
    ], { csrf: req.csrfToken, submit: 'Save currencies', grid: false }))}
  ${ui.card('Appearance & legal', ui.formHtml(R(req, '/settings/appearance'), [
      { key: 'site_name', label: 'Site name', type: 'text', value: getS(s, 'site_name', '') },
      { key: 'cookie_text', label: 'Cookie banner text', type: 'textarea', value: getS(s, 'cookie_text', '') },
      { key: 'custom_css', label: 'Custom CSS', type: 'textarea', value: getS(s, 'custom_css', '') },
      { key: 'language', label: 'Language', type: 'select', options: ['en'], value: getS(s, 'language', 'en'), help: 'More languages can be added on request.' },
    ], { csrf: req.csrfToken, submit: 'Save appearance', grid: false }))}`;
  res.send(shell(req, '/settings', 'Settings', body));
});
router.post('/settings/toggles', async (req, res) => {
  for (const [k] of TOGGLES) await setSetting(req.db, req.driver, k, req.body[k] ? '1' : '0');
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'settings.toggles', entity: 'settings', entityId: '', detail: {}, ip: req.ip });
  await req.setFlash('success', 'Toggles saved.');
  res.redirect(R(req, '/settings'));
});
router.post('/settings/economy', async (req, res) => {
  for (const k of ['wager_options', 'max_pops', 'max_draws', 'day_draw_time', 'eve_draw_time', 'commission_rate', 'deposit_mode', 'withdrawal_mode', 'auto_approve_deposit_limit', 'referral_rate', 'multi_draw_discounts'])
    await setSetting(req.db, req.driver, k, String(req.body[k] || ''));
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'settings.economy', entity: 'settings', entityId: '', detail: {}, ip: req.ip });
  await req.setFlash('success', 'Economy settings saved.');
  res.redirect(R(req, '/settings'));
});
router.post('/settings/phone-countries', async (req, res) => {
  const v = String(req.body.blocked_phone_countries || '').toUpperCase().replace(/[^A-Z,]/g, '');
  await setSetting(req.db, req.driver, 'blocked_phone_countries', v);
  await req.setFlash('success', 'Phone country settings saved.');
  res.redirect(R(req, '/settings'));
});
router.post('/settings/hero-stats', async (req, res) => {
  for (const k of ['hero_stats_mode', 'hero_stats_players_base', 'hero_stats_paid_base'])
    await setSetting(req.db, req.driver, k, String(req.body[k] || ''));
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'settings.hero-stats', entity: 'settings', entityId: '', detail: {}, ip: req.ip });
  await req.setFlash('success', 'Hero stats saved.');
  res.redirect(R(req, '/settings'));
});
router.post('/settings/prizes', async (req, res) => {
  // Multipliers are RTP: multiplier/15. Clamp to 1..15 (RTP <= 100%) — the
  // old code accepted any value >= 1, so an admin could set x100 and make
  // the house pay out 6.6x stakes. Audit old AND new values (was {}).
  const rows = await req.db.query('SELECT pops_count, multiplier FROM prize_table');
  const changes = {};
  for (const r of rows) {
    const v = Math.min(15, Math.max(1, parseInt(req.body['mult_' + r.pops_count], 10) || 5));
    if (v !== r.multiplier) changes[r.pops_count] = { from: r.multiplier, to: v };
    await req.db.run('UPDATE prize_table SET multiplier = ? WHERE pops_count = ?', [v, r.pops_count]);
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'settings.prizes', entity: 'settings', entityId: '', detail: { changes }, ip: req.ip });
  await req.setFlash('success', 'Prize table saved.');
  res.redirect(R(req, '/settings'));
});
router.post('/settings/currencies', async (req, res) => {
  try {
    const list = JSON.parse(req.body.currencies || '[]');
    if (!Array.isArray(list) || !list.length || !list.every(c => c.code && c.symbol)) throw new Error('Invalid list.');
    await setSetting(req.db, req.driver, 'currencies', JSON.stringify(list.map(c => ({ code: String(c.code).toUpperCase().slice(0, 8), symbol: String(c.symbol).slice(0, 8), rate: parseFloat(c.rate) || 1 }))));
    await setSetting(req.db, req.driver, 'base_currency', String(req.body.base_currency || 'USD').toUpperCase().slice(0, 8));
    await req.setFlash('success', 'Currencies saved.');
  } catch (e) { await req.setFlash('error', 'Invalid currencies JSON: ' + e.message); }
  res.redirect(R(req, '/settings'));
});
router.post('/settings/appearance', async (req, res) => {
  for (const k of ['site_name', 'cookie_text', 'custom_css', 'language'])
    await setSetting(req.db, req.driver, k, String(req.body[k] || ''));
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'settings.appearance', entity: 'settings', entityId: '', detail: {}, ip: req.ip });
  await req.setFlash('success', 'Appearance saved.');
  res.redirect(R(req, '/settings'));
});

/* ============================================================ AUDIT TRAIL */
router.get('/audit', async (req, res) => {
  const page = pageOf(req), q = req.query.q || '';
  const where = q ? 'WHERE action LIKE ? OR entity LIKE ? OR detail LIKE ?' : '';
  const params = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];
  const total = (await req.db.get(`SELECT COUNT(*) AS c FROM audit_log ${where}`, params)).c;
  const rows = await req.db.query(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, PER, (page - 1) * PER]);
  const body = ui.filtersHtml(R(req, '/audit'), [{ key: 'q', label: 'Search action/entity' }], req.query) +
    ui.table(['When', 'Actor', 'Action', 'Entity', 'IP', 'Detail'], rows.map(a =>
      [d(a.created_at), `${esc(a.actor_role || '?')} #${a.actor_id || '—'}`, esc(a.action), esc(a.entity) + ' ' + esc(a.entity_id), esc(a.ip), `<span class="code">${esc(String(a.detail).slice(0, 120))}</span>`])) +
    ui.paginate(`${R(req, '/audit')}?q=${encodeURIComponent(q)}`, page, PER, total);
  res.send(shell(req, '/audit', 'Audit Trail', body));
});

module.exports = router;
