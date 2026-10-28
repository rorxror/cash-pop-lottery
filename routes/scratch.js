'use strict';
const express = require('express');
const playerRouter = express.Router();
const adminRouter = express.Router();
const { requireLogin, requireRole, rateLimit } = require('../lib/auth');
const { now, randHex, sha256, toMinor, decimalsFor, esc } = require('../lib/util');
const ui = require('../lib/admin-ui');
const { buyTicket, revealTicket, launchSeries, responsibleStatus, logEvent } = require('../lib/scratch');
const { getBalances } = require('../lib/money');
const { getCurrencies, getS } = require('../lib/settings');
const engine = require('../lib/prize-engine');
const audit = require('../lib/audit');

playerRouter.get('/scratch', async (req, res) => {
  const series = await req.db.query(
    `SELECT s.*, (SELECT COUNT(*) FROM scratch_outcomes o WHERE o.series_id=s.id AND o.ticket_id IS NULL) AS remaining,
      (SELECT MAX(amount) FROM scratch_prize_tiers p WHERE p.series_id=s.id) AS top_prize,
      (SELECT COALESCE(SUM(amount*quantity),0) FROM scratch_prize_tiers p WHERE p.series_id=s.id) AS total_prizes
     FROM scratch_series s WHERE s.status='live' AND s.enabled=1 ORDER BY s.launched_at DESC`);
  res.render('scratch_lobby', { metaTitle: 'Scratch Cards', metaDesc: 'Instant scratch games with locked outcomes and verifiable commitments.', series });
});

playerRouter.get('/scratch/my-tickets', requireLogin, async (req, res) => {
  const tab = ['unscratched', 'scratched', 'history'].includes(String(req.query.tab)) ? String(req.query.tab) : 'unscratched';
  let where = "st.status='purchased'";
  if (tab === 'scratched') where = "st.status='revealed'";
  if (tab === 'history') where = '1=1';
  // DS-058: paginated (was a hard LIMIT 200 with no way to reach older tickets).
  const totalRow = await req.db.get(
    `SELECT COUNT(*) AS c FROM scratch_tickets st WHERE st.user_id=? AND ${where}`, [req.user.id]);
  const totalPages = Math.max(1, Math.ceil(Number(totalRow.c) / 25));
  const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), totalPages); // D4-C2 clamp
  const tickets = await req.db.query(
    `SELECT st.public_id,st.currency,st.price,st.status,st.prize,st.purchased_at,st.revealed_at,s.title,s.game_type
     FROM scratch_tickets st JOIN scratch_series s ON s.id=st.series_id
     WHERE st.user_id=? AND ${where} ORDER BY st.purchased_at DESC LIMIT 25 OFFSET ?`, [req.user.id, (page - 1) * 25]);
  const counts = await req.db.get(
    `SELECT SUM(CASE WHEN status='purchased' THEN 1 ELSE 0 END) AS unscratched,
      SUM(CASE WHEN status='revealed' THEN 1 ELSE 0 END) AS scratched, COUNT(*) AS history
     FROM scratch_tickets WHERE user_id=?`, [req.user.id]);
  res.render('scratch_tickets', { metaTitle: 'My Scratch Tickets', metaDesc: '', tickets, counts: counts || {}, tab, page, totalPages });
});

playerRouter.get('/scratch/responsible-play', requireLogin, async (req, res) => {
  const limits = await responsibleStatus(req.db, req.user.id);
  res.render('scratch_responsible', { metaTitle: 'Scratch Play Limits', metaDesc: '', limits });
});

playerRouter.post('/scratch/responsible-play', requireLogin, async (req, res) => {
  const daily = Math.max(0, toMinor(req.body.daily_loss_limit) || 0);
  // DS-018: player-set daily deposit limit applies immediately (a player
  // lowering their own cap must not wait 24h for protection).
  const depLimit = Math.max(0, toMinor(req.body.daily_deposit_limit) || 0);
  const session = Math.max(0, Math.min(1440, parseInt(req.body.session_limit_minutes, 10) || 0));
  const coolHours = Math.max(0, Math.min(720, parseInt(req.body.cooling_off_hours, 10) || 0));
  const exclusionDays = Math.max(0, Math.min(3650, parseInt(req.body.self_exclusion_days, 10) || 0));
  const current = await responsibleStatus(req.db, req.user.id);
  const coolingUntil = Math.max(Number(current.cooling_off_until || 0), coolHours ? now() + coolHours * 3600000 : 0);
  const excludedUntil = Math.max(Number(current.self_excluded_until || 0), exclusionDays ? now() + exclusionDays * 86400000 : 0);
  // Limit DECREASES take 24h to take effect; increases apply immediately.
  // Previously a player could remove their own loss protection in one click
  // and spend freely the same day. Per field: requested >= current limit
  // applies immediately (and cancels any pending decrease for that field);
  // requested < current limit leaves the main row untouched and writes the
  // decrease to responsible_play_pending, applied by responsibleStatus once
  // effective_at passes. Cooling-off/self-exclusion stay extend-only.
  const curD = Number(current.daily_loss_limit || 0), curS = Number(current.session_limit_minutes || 0);
  const mainD = daily >= curD ? daily : curD, mainS = session >= curS ? session : curS;
  const pendD = daily < curD ? daily : null, pendS = session < curS ? session : null;
  const existing = await req.db.get('SELECT user_id FROM responsible_play WHERE user_id=?', [req.user.id]);
  if (existing) await req.db.run(
    'UPDATE responsible_play SET daily_loss_limit=?,session_limit_minutes=?,daily_deposit_limit=?,cooling_off_until=?,self_excluded_until=?,updated_at=? WHERE user_id=?',
    [mainD, mainS, depLimit, coolingUntil, excludedUntil, now(), req.user.id]);
  else await req.db.run(
    'INSERT INTO responsible_play (user_id,daily_loss_limit,daily_deposit_limit,session_limit_minutes,cooling_off_until,self_excluded_until,updated_at) VALUES (?,?,?,?,?,?,?)',
    [req.user.id, mainD, depLimit, mainS, coolingUntil, excludedUntil, now()]);
  await req.db.run('DELETE FROM responsible_play_pending WHERE user_id = ?', [req.user.id]);
  if (pendD !== null || pendS !== null) await req.db.run(
    'INSERT INTO responsible_play_pending (user_id,pending_daily_loss_limit,pending_session_limit_minutes,effective_at) VALUES (?,?,?,?)',
    [req.user.id, pendD, pendS, now() + 24 * 3600000]);
  await logEvent(req.db, req.user.id, 'responsible_play.updated', 'user', req.user.id, { daily: mainD, session: mainS, pendingDaily: pendD, pendingSession: pendS, coolingUntil, excludedUntil });
  await req.setFlash('success', (pendD !== null || pendS !== null)
    ? 'Limits updated. Increases apply immediately; decreases take effect after 24 hours. Cooling-off and self-exclusion can only be extended, not shortened.'
    : 'Scratch play limits updated. Cooling-off and self-exclusion can only be extended, not shortened.');
  res.redirect('/scratch/responsible-play');
});

playerRouter.get('/scratch/ticket/:publicId/verify', requireLogin, async (req, res) => {
  const ticket = await req.db.get(
    `SELECT st.*,so.nonce,so.ordinal,so.commitment,s.title FROM scratch_tickets st
     JOIN scratch_outcomes so ON so.id=st.outcome_id JOIN scratch_series s ON s.id=st.series_id
     WHERE st.public_id=? AND st.user_id=?`, [req.params.publicId, req.user.id]);
  if (!ticket) return res.status(404).render('error', { status: 404, message: 'Scratch ticket not found.' });
  const computed = ticket.status === 'revealed' ? sha256(`${ticket.series_id}|${ticket.ordinal}|${ticket.nonce}|${ticket.prize}`) : '';
  res.render('scratch_verify', { metaTitle: 'Verify Scratch Ticket', metaDesc: '', ticket, computed, valid: computed ? computed === ticket.commitment : null });
});

playerRouter.get('/scratch/ticket/:publicId', requireLogin, async (req, res) => {
  const ticket = await req.db.get(
    `SELECT st.*,s.title,s.game_type,s.rules,so.nonce,so.ordinal FROM scratch_tickets st
     JOIN scratch_series s ON s.id=st.series_id JOIN scratch_outcomes so ON so.id=st.outcome_id
     WHERE st.public_id=? AND st.user_id=?`, [req.params.publicId, req.user.id]);
  if (!ticket) return res.status(404).render('error', { status: 404, message: 'Scratch ticket not found.' });
  if (ticket.status !== 'revealed') { ticket.prize = null; ticket.nonce = null; ticket.ordinal = null; }
  res.render('scratch_ticket', { metaTitle: ticket.title, metaDesc: '', ticket });
});

playerRouter.post('/scratch/ticket/:publicId/reveal', requireLogin,
  rateLimit({ windowMs: 60000, max: 12, keyFn: req => `scratch-reveal:${req.user.id}` }),
  async (req, res) => {
    try {
      await revealTicket(req.db, req.user.id, req.params.publicId);
      // DS-027: scratch wins sent no notification on any channel (the win
      // templates only ever fired for lottery draws). Attempt all three;
      // notify.send logs each attempt to the outbox and never throws.
      try {
        const t = await req.db.get('SELECT * FROM scratch_tickets WHERE public_id = ?', [req.params.publicId]);
        if (t && Number(t.prize) > 0) {
          const notify = require('../lib/notify');
          const vars = { name: req.user.name, amount: req.fmt(t.prize, t.currency), ticket: t.public_id };
          if (req.user.email && await notify.emailPrefEnabled(req.db, req.user.id, 'win')) await notify.send(req.db, req.settings, 'email', 'win', req.user.email, vars);
          if (req.user.phone) await notify.send(req.db, req.settings, 'sms', 'win', req.user.phone, vars);
          await notify.send(req.db, req.settings, 'push', 'win', String(req.user.id), vars);
        }
      } catch (e) { console.error('[scratch/reveal] win notify failed:', e.message); }
      res.redirect('/scratch/ticket/' + encodeURIComponent(req.params.publicId));
    } catch (e) {
      // DS-076: never pass raw engine errors to players (a commitment
      // mismatch used to be shown verbatim). Log the real error server-side.
      console.error('[scratch/reveal] failed:', e.message);
      const msg = /not found/i.test(e.message) ? 'Scratch ticket not found.' : 'This ticket could not be revealed. Please contact support.';
      res.status(400).render('error', { status: 400, message: msg });
    }
  });

/* U-02 (v20): a failed scratch buy re-renders the page the player was
   buying from (the series detail, or the lobby when the series itself
   is gone) with the TRUE reason in the flash local — the bare error
   page and the generic 'Scratch purchase failed' are gone. Every local
   the target view needs is rebuilt here, mirroring the GET handlers. */
async function renderScratchBuyError(req, res, seriesId, message) {
  const flash = { error: message, success: '' };
  const series = await req.db.get(
    `SELECT s.*, (SELECT COUNT(*) FROM scratch_outcomes o WHERE o.series_id=s.id AND o.ticket_id IS NULL) AS remaining,
      (SELECT MAX(amount) FROM scratch_prize_tiers p WHERE p.series_id=s.id) AS top_prize,
      (SELECT COALESCE(SUM(amount*quantity),0) FROM scratch_prize_tiers p WHERE p.series_id=s.id) AS total_prizes
     FROM scratch_series s WHERE s.id = ?`, [seriesId]);
  if (series) {
    const tiers = await req.db.query('SELECT amount,quantity,label FROM scratch_prize_tiers WHERE series_id=? ORDER BY amount DESC', [series.id]);
    return res.status(400).render('scratch_detail', { metaTitle: series.title, metaDesc: '', series, tiers, flash });
  }
  const list = await req.db.query(
    `SELECT s.*, (SELECT COUNT(*) FROM scratch_outcomes o WHERE o.series_id=s.id AND o.ticket_id IS NULL) AS remaining,
      (SELECT MAX(amount) FROM scratch_prize_tiers p WHERE p.series_id=s.id) AS top_prize,
      (SELECT COALESCE(SUM(amount*quantity),0) FROM scratch_prize_tiers p WHERE p.series_id=s.id) AS total_prizes
     FROM scratch_series s WHERE s.status='live' AND s.enabled=1 ORDER BY s.launched_at DESC`);
  return res.status(400).render('scratch_lobby', { metaTitle: 'Scratch Cards', metaDesc: 'Instant scratch games with locked outcomes and verifiable commitments.', series: list, flash });
}

playerRouter.post('/scratch/:id/buy', requireLogin,
  rateLimit({ windowMs: 60000, max: 10, keyFn: req => `scratch-buy:${req.user.id}` }),
  async (req, res) => {
    const seriesId = parseInt(req.params.id, 10);
    try {
      // R-024 (scratch half): the lottery buy enforces session_limit_minutes;
      // the scratch buy never did. Same rule, same session-start basis.
      const rp = await responsibleStatus(req.db, req.user.id);
      const lim = Number(rp.session_limit_minutes || 0);
      if (lim > 0 && req.sess && req.sess.created_at && (now() - Number(req.sess.created_at)) > lim * 60000)
        return renderScratchBuyError(req, res, seriesId, 'Your session limit has been reached. Please sign out and take a break before playing again.');
      const bought = await buyTicket(req.db, req.user.id, seriesId, req.ip);
      res.redirect('/scratch/ticket/' + encodeURIComponent(bought.publicId));
    } catch (e) {
      // U-02 (was R-117's generic message): map the engine's throw to
      // its true reason. buyTicket's own messages (not on sale, sold
      // out, responsible-play blocks, the outcome-claim race) pass
      // through verbatim; postLedger's 'Insufficient balance' is
      // enriched with the amounts; anything unknown states the one
      // true fact left — buyTicket is transactional, so a throw means
      // it rolled back and no money was taken. Driver text still never
      // reaches the player; the real error stays in the server log.
      console.error('scratch buy failed:', e.message);
      let msg = null;
      if (e.message === 'Insufficient balance') {
        const s = await req.db.get('SELECT * FROM scratch_series WHERE id = ?', [seriesId]);
        if (s) {
          const wallets = await getBalances(req.db, req.user.id);
          const bal = Number((wallets.find(w => w.currency === s.currency) || { balance: 0 }).balance);
          msg = `Not enough balance: this card costs ${req.fmt(s.price, s.currency)}, but your ${s.currency} wallet has ${req.fmt(bal, s.currency)} — you are ${req.fmt(Number(s.price) - bal, s.currency)} short. Add funds before buying.`;
        }
      }
      if (!msg) {
        msg = /not on sale|sold out|has ended|self-exclusion|cooling-off|daily loss limit|just claimed/.test(e.message)
          ? e.message
          : 'This scratch purchase could not be completed and no money was taken. Please contact support if this keeps happening.';
      }
      return renderScratchBuyError(req, res, seriesId, msg);
    }
  });

playerRouter.get('/scratch/:slug', async (req, res) => {
  const series = await req.db.get(
    `SELECT s.*, (SELECT COUNT(*) FROM scratch_outcomes o WHERE o.series_id=s.id AND o.ticket_id IS NULL) AS remaining,
      (SELECT MAX(amount) FROM scratch_prize_tiers p WHERE p.series_id=s.id) AS top_prize,
      (SELECT COALESCE(SUM(amount*quantity),0) FROM scratch_prize_tiers p WHERE p.series_id=s.id) AS total_prizes
     FROM scratch_series s WHERE s.slug=? AND s.status='live' AND s.enabled=1`, [req.params.slug]);
  if (!series) return res.status(404).render('error', { status: 404, message: 'Scratch series not found or not on sale.' });
  const tiers = await req.db.query('SELECT amount,quantity,label FROM scratch_prize_tiers WHERE series_id=? ORDER BY amount DESC', [series.id]);
  res.render('scratch_detail', { metaTitle: series.title, metaDesc: '', series, tiers });
});

/* STEALTH (same rule as routes/admin.js): non-admin requests to the scratch
   admin path get a plain 404 — never a login redirect or 403 — so the path
   reveals nothing to anyone guessing URLs. */
adminRouter.use(async (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    try {
      const audit = require('../lib/audit');
      await audit.log(req.db, { actorId: null, actorRole: 'anonymous', action: 'admin.probe', entity: 'admin', entityId: '', detail: { path: '/scratch' + req.path }, ip: req.ip });
    } catch (e) { /* audit failure must never reveal the panel */ }
    return res.status(404).render('error', { status: 404, message: 'Page not found.' });
  }
  next();
});
adminRouter.use(requireRole('admin'));
// RBAC (v14): scratch series actions move money (prize pools, RTP), so only
// super + finance may POST; views (GET) stay readable by all staff.
adminRouter.use((req, res, next) => {
  if (req.method !== 'GET') {
    const role = req.user.admin_role || 'super';
    if (!['super', 'finance'].includes(role)) {
      return res.status(403).render('error', { status: 403, message: 'Your staff role does not permit this action.' });
    }
  }
  next();
});
adminRouter.get('/', async (req, res) => {
  const series = await req.db.query(
    `SELECT s.*, (SELECT COUNT(*) FROM scratch_tickets t WHERE t.series_id=s.id) AS sold,
      (SELECT COUNT(*) FROM scratch_tickets t WHERE t.series_id=s.id AND t.status='revealed') AS revealed,
      (SELECT COALESCE(SUM(price),0) FROM scratch_tickets t WHERE t.series_id=s.id) AS revenue,
      (SELECT COALESCE(SUM(prize),0) FROM scratch_tickets t WHERE t.series_id=s.id AND t.status='revealed') AS paid,
      (SELECT COALESCE(SUM(amount*quantity),0) FROM scratch_prize_tiers p WHERE p.series_id=s.id) AS prize_pool
     FROM scratch_series s ORDER BY s.created_at DESC`);
  const fmt = (minor, cur) => { const dec = decimalsFor(cur || 'USD', getCurrencies(req.settings)); return (Number(minor || 0) / Math.pow(10, dec)).toFixed(dec) + ' ' + (cur || 'USD'); }; // SCAN fix (C-12): honour the currency's real decimals
  const base = req.adminPath + '/scratch';
  const body = ui.card('Scratch series', ui.table(['Title', 'Game', 'Price', 'Sold / total', 'Revenue', 'Paid out', 'Prize pool', 'Status', 'Enabled', 'Actions'],
    series.map(s => [
      esc(s.title), esc(s.game_type), fmt(s.price, s.currency), `${s.sold} / ${s.total_tickets}`,
      fmt(s.revenue, s.currency), fmt(s.paid, s.currency), fmt(s.prize_pool, s.currency),
      ui.statusBadge(s.status), s.enabled ? ui.badge('on', 'ok') : ui.badge('off', 'muted'),
      /* SCAN fix (C-13): actions render only for the statuses where
         they can succeed (Launch=draft, Toggle/Stop=live) — the old
         unconditional buttons were guaranteed errors or silent no-ops
         on the other rows. */
      `<a class="btn btn-sm" href="${base}/${s.id}">Detail</a>
       ${s.status === 'draft' ? `<form method="POST" action="${base}/${s.id}/launch" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">Launch</button></form>` : ''}
       ${s.status === 'live' ? `<form method="POST" action="${base}/${s.id}/toggle" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">${s.enabled ? 'Disable' : 'Enable'}</button></form>
       <form method="POST" action="${base}/${s.id}/stop" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm btn-d">Stop</button></form>` : ''}`,
    ]))) +
    ui.card('Create series', `<p class="muted">New series start as drafts. Review the payout math, then launch — outcomes lock on launch and are provably fair.</p>` +
      ui.formHtml(base + '/create', [
        { key: 'title', label: 'Title', type: 'text', required: true },
        { key: 'slug', label: 'Slug (blank = from title)', type: 'text' },
        { key: 'game_type', label: 'Game type', type: 'select', options: ['single', 'match3', 'six', 'bonus'] },
        { key: 'currency', label: 'Currency', type: 'text', value: 'USD' },
        { key: 'price', label: 'Ticket price (major units, e.g. 1.00)', type: 'text', required: true },
        { key: 'total_tickets', label: 'Total tickets', type: 'number', required: true },
        { key: 'tiers', label: 'Prize tiers (one per line: amount:quantity:label)', type: 'textarea', required: true },
        { key: 'rules', label: 'Rules', type: 'textarea' },
        { key: 'launch_at', label: 'Auto-launch at (optional, UTC e.g. 2026-11-01 10:00)', type: 'text' },
        { key: 'ends_at', label: 'Auto-stop at (optional, UTC e.g. 2026-12-01 10:00)', type: 'text' },
      ], { csrf: req.csrfToken, submit: 'Create draft' })) +
    ui.card('Prize Pool Planner', `<p class="muted">Set a price, an inventory and a target RTP — the planner generates a tier table whose total prize liability matches the target (see the rounding note on the preview). The plan creates a DRAFT: review it, hand-tune tiers via the series page if you like, then launch. Outcomes stay predetermined and committed at launch, exactly as with a hand-built series.</p>` +
      ui.formHtml(base + '/planner/preview', [
        { key: 'title', label: 'Title', type: 'text', required: true },
        { key: 'game_type', label: 'Game type', type: 'select', options: ['single', 'match3', 'six', 'bonus'] },
        { key: 'currency', label: 'Currency', type: 'text', value: 'USD' },
        { key: 'price', label: 'Ticket price (major units, e.g. 1.00)', type: 'text', required: true },
        { key: 'total_tickets', label: 'Total tickets', type: 'number', required: true },
        { key: 'target_rtp', label: 'Target RTP % (e.g. 75)', type: 'text', value: getS(req.settings, 'scratch_planner_target_rtp', '75'), required: true },
      ], { csrf: req.csrfToken, submit: 'Preview plan' }));
  res.send(ui.layout({ adminPath: req.adminPath, section: '/scratch', title: 'Scratch', body, csrf: req.csrfToken, flash: req.flashData || {}, assetV: req.app.locals.assetV || '1', role: (req.user && req.user.admin_role) || 'super' }));
});

/* BP-23(a): Prize Pool Planner — preview the generated tier table and
   the projected margins BEFORE anything is created, then create the
   draft with one click. The plan is recomputed server-side at create
   time from the same inputs (deterministic), never trusted from the
   form. Creating a draft does not launch it. */
function plannerInputs(req) {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const gameType = ['single', 'match3', 'six', 'bonus'].includes(req.body.game_type) ? req.body.game_type : 'single';
  const currency = String(req.body.currency || 'USD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
  if (!getCurrencies(req.settings).some(c => c.code === currency)) throw new Error('Currency must be one of the configured currencies (Settings → Currencies).');
  const price = toMinor(req.body.price, decimalsFor(currency, getCurrencies(req.settings)));
  const totalTickets = parseInt(String(req.body.total_tickets || ''), 10);
  const targetRtpPct = parseFloat(String(req.body.target_rtp || ''));
  if (!title) throw new Error('Title is required.');
  if (!price || price < 1) throw new Error('Ticket price is required.');
  return { title, gameType, currency, price, totalTickets, targetRtpPct };
}
adminRouter.post('/planner/preview', async (req, res) => {
  try {
    const inp = plannerInputs(req);
    const plan = engine.planPrizePool(inp);
    if (!plan.ok) throw new Error(plan.error);
    const fmt = (minor) => (Number(minor || 0) / Math.pow(10, decimalsFor(inp.currency, getCurrencies(req.settings)))).toFixed(decimalsFor(inp.currency, getCurrencies(req.settings))) + ' ' + inp.currency;
    const base = req.adminPath + '/scratch';
    const body = ui.card(`Prize plan — ${esc(inp.title)}`,
      `<p class="muted">Target RTP ${inp.targetRtpPct}% → target liability ${fmt(plan.targetLiability)}. Achieved liability ${fmt(plan.liability)} (achieved RTP ${plan.achievedRtpPct.toFixed(2)}%)${plan.unallocated ? ` — ${fmt(plan.unallocated)} unallocated (smaller than one ticket price after exact fill).` : ' — exact.'} Winning tickets: ${plan.winners} of ${inp.totalTickets}; the rest win nothing. Projected operator margin assumes random sale order (expected payout scales with sell-through).</p>` +
      ui.table(['Prize', 'Quantity', 'Tier liability'], plan.tiers.map(t => [fmt(t.amount), t.quantity, fmt(t.amount * t.quantity)])) +
      ui.table(['Projection', 'Gross sales', 'Expected payout', 'Projected margin'], [100, 50, 25].map(pct => [
        `Sell-through ${pct}%`, fmt(plan.gross * pct / 100), fmt(plan.liability * pct / 100), fmt(plan.marginAt(pct)),
      ])) +
      `<form method="POST" action="${base}/planner/create" class="adm-form">
        <input type="hidden" name="_csrf" value="${req.csrfToken}">
        <input type="hidden" name="title" value="${esc(inp.title)}">
        <input type="hidden" name="game_type" value="${esc(inp.gameType)}">
        <input type="hidden" name="currency" value="${esc(inp.currency)}">
        <input type="hidden" name="price" value="${esc(String(req.body.price))}">
        <input type="hidden" name="total_tickets" value="${inp.totalTickets}">
        <input type="hidden" name="target_rtp" value="${inp.targetRtpPct}">
        <div class="mt"><button class="btn btn-p" type="submit">Create draft series with this plan</button>
        <a class="btn" href="${base}">Cancel</a></div>
      </form>`);
    res.send(ui.layout({ adminPath: req.adminPath, section: '/scratch', title: 'Scratch — prize plan', body, csrf: req.csrfToken, flash: req.flashData || {}, assetV: req.app.locals.assetV || '1', role: (req.user && req.user.admin_role) || 'super' }));
  } catch (e) {
    res.status(400).render('error', { status: 400, message: e.message });
  }
});
adminRouter.post('/planner/create', async (req, res) => {
  try {
    const inp = plannerInputs(req);
    const plan = engine.planPrizePool(inp);
    if (!plan.ok) throw new Error(plan.error);
    const slugBase = inp.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'series';
    const slug = slugBase + '-' + now().toString(36);
    const seed = randHex(32);
    const created = await req.db.transaction(async (tx) => {
      const r = await tx.run(
        `INSERT INTO scratch_series (title,slug,game_type,currency,price,total_tickets,status,enabled,rules,server_seed,seed_hash,created_by,created_at)
         VALUES (?,?,?,?,?,?,'draft',0,'',?,?,?,?)`,
        [inp.title, slug, inp.gameType, inp.currency, inp.price, inp.totalTickets, seed, sha256(seed), req.user.id, now()]);
      for (const tier of plan.tiers) await tx.run('INSERT INTO scratch_prize_tiers (series_id,amount,quantity,label) VALUES (?,?,?,?)', [r.id, tier.amount, tier.quantity, 'Planner prize']);
      return r.id;
    });
    await logEvent(req.db, req.user.id, 'series.planned', 'series', created, { targetRtp: inp.targetRtpPct, liability: plan.liability, achievedRtpPct: Math.round(plan.achievedRtpPct * 100) / 100 });
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'scratch.series_planned', entity: 'series', entityId: created, detail: { title: inp.title, targetRtp: inp.targetRtpPct, liability: plan.liability, totalTickets: inp.totalTickets }, ip: req.ip });
    await req.setFlash('success', 'Planned series created as a draft. Review it, then launch.');
    res.redirect(req.adminPath + '/scratch/' + created);
  } catch (e) {
    res.status(400).render('error', { status: 400, message: e.message });
  }
});

/* v16: series detail — the inventory dashboard the list page never had.
   Per-AMOUNT breakdown (not per tier row: outcomes store a prize value, not
   a tier id, so two tiers sharing one amount cannot be told apart — the
   per-amount view is the accurate one), plus theoretical RTP (prize pool /
   total sales if sold out) and live RTP (actually paid / actually taken).
   A prize amount with 0 remaining is flagged: the operator can see a prize
   pool running dry before players do. */
adminRouter.get('/:id', async (req, res) => {
  const series = await req.db.get('SELECT * FROM scratch_series WHERE id = ?', [req.params.id]);
  const base = req.adminPath + '/scratch';
  if (!series) return res.status(404).send(ui.layout({ adminPath: req.adminPath, section: '/scratch', title: 'Scratch', body: ui.card('Not found', '<p class="muted">No such series.</p>'), csrf: req.csrfToken, flash: req.flashData || {}, assetV: req.app.locals.assetV || '1', role: (req.user && req.user.admin_role) || 'super' }));
  const tiers = await req.db.query('SELECT amount,quantity,label FROM scratch_prize_tiers WHERE series_id=? ORDER BY amount DESC', [series.id]);
  const breakdown = series.status === 'draft' ? [] : await req.db.query(
    `SELECT o.prize AS amount, COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN o.ticket_id IS NOT NULL THEN 1 ELSE 0 END),0) AS sold,
       COALESCE(SUM(CASE WHEN o.ticket_id IS NULL THEN 1 ELSE 0 END),0) AS remaining
     FROM scratch_outcomes o WHERE o.series_id=? GROUP BY o.prize ORDER BY o.prize DESC`, [series.id]);
  const st = await req.db.get(
    `SELECT (SELECT COUNT(*) FROM scratch_tickets t WHERE t.series_id=?) AS sold,
       (SELECT COUNT(*) FROM scratch_tickets t WHERE t.series_id=? AND t.status='revealed') AS revealed,
       (SELECT COALESCE(SUM(price),0) FROM scratch_tickets t WHERE t.series_id=?) AS revenue,
       (SELECT COALESCE(SUM(prize),0) FROM scratch_tickets t WHERE t.series_id=? AND t.status='revealed') AS paid,
       (SELECT COALESCE(SUM(amount*quantity),0) FROM scratch_prize_tiers p WHERE p.series_id=?) AS prize_pool`,
    [series.id, series.id, series.id, series.id, series.id]);
  const fmt = (minor, cur) => { const dec = decimalsFor(cur || 'USD', getCurrencies(req.settings)); return (Number(minor || 0) / Math.pow(10, dec)).toFixed(dec) + ' ' + (cur || 'USD'); }; // SCAN fix (C-12): honour the currency's real decimals
  const gross = Number(series.price) * Number(series.total_tickets);
  const theoretical = gross > 0 ? (Number(st.prize_pool) / gross * 100) : 0;
  const live = Number(st.revenue) > 0 ? (Number(st.paid) / Number(st.revenue) * 100) : 0;
  const exhausted = breakdown.filter(b => Number(b.amount) > 0 && Number(b.remaining) === 0);
  const warn = exhausted.length
    ? `<p><strong>⚠ Inventory warning:</strong> these prize amounts are exhausted (all claimed): ${exhausted.map(b => fmt(b.amount, series.currency)).join(', ')}. Remaining tickets can only win smaller prizes or nothing.</p>`
    : '<p class="muted">No prize amount exhausted.</p>';
  const body = ui.card(`Series — ${esc(series.title)}`, ui.table(['Field', 'Value'], [
    ['Game', esc(series.game_type)], ['Price', fmt(series.price, series.currency)],
    ['Tickets', `${st.sold} sold / ${series.total_tickets} total · ${st.revealed} revealed`],
    ['Status', ui.statusBadge(series.status)], ['Enabled', series.enabled ? 'on' : 'off'],
    ['Revenue (taken)', fmt(st.revenue, series.currency)],
    ['Paid out (revealed wins)', fmt(st.paid, series.currency)],
    ['Prize pool (all tiers)', fmt(st.prize_pool, series.currency)],
    ['Theoretical RTP (pool / full sales)', theoretical.toFixed(1) + '%'],
    ['Live RTP (paid / taken)', live.toFixed(1) + '%'],
  ]) + warn) +
    ui.card('Prize inventory by amount', series.status === 'draft'
      ? '<p class="muted">Draft series — outcomes lock on launch. Tier plan:</p>' + ui.table(['Prize', 'Quantity', 'Label'], tiers.map(t => [fmt(t.amount, series.currency), t.quantity, esc(t.label || '')]))
      : ui.table(['Prize', 'Total outcomes', 'Claimed (sold)', 'Remaining', 'Status'], breakdown.map(b => [
        fmt(b.amount, series.currency), b.total, b.sold, b.remaining,
        Number(b.amount) > 0 && Number(b.remaining) === 0 ? '⚠ exhausted' : (Number(b.remaining) === 0 ? 'gone' : 'live')]))) +
    ui.card('Tier plan', ui.table(['Prize', 'Quantity', 'Label'], tiers.map(t => [fmt(t.amount, series.currency), t.quantity, esc(t.label || '')]))) +
    `<p><a class="btn" href="${base}">← Back to series list</a></p>`;
  res.send(ui.layout({ adminPath: req.adminPath, section: '/scratch', title: 'Scratch — ' + series.title, body, csrf: req.csrfToken, flash: req.flashData || {}, assetV: req.app.locals.assetV || '1', role: (req.user && req.user.admin_role) || 'super' }));
});

adminRouter.post('/create', async (req, res) => {
  try {
    const title = String(req.body.title || '').trim().slice(0, 120);
    const slug = String(req.body.slug || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    const gameType = ['single', 'match3', 'six', 'bonus'].includes(req.body.game_type) ? req.body.game_type : 'single';
    // R-064 (route half): currency was only uppercased, never whitelisted —
    // a bogus-currency series could launch but never sell. Inventory was
    // silently clamped (garbage became 1, 2M became 1M). Tier labels were
    // truncated at the SECOND colon (100:5:Win:Big → Win). All three now
    // reject or preserve honestly.
    const currency = String(req.body.currency || 'USD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
    if (!getCurrencies(req.settings).some(c => c.code === currency)) throw new Error('Currency must be one of the configured currencies (Settings → Currencies).');
    const price = toMinor(req.body.price, decimalsFor(currency, getCurrencies(req.settings)));
    const totalRaw = String(req.body.total_tickets || '').trim();
    if (!/^\d+$/.test(totalRaw)) throw new Error('Total tickets must be a positive integer.');
    const totalTickets = parseInt(totalRaw, 10);
    if (totalTickets < 1 || totalTickets > 1000000) throw new Error('Total tickets must be between 1 and 1,000,000.');
    if (!title || !slug || !price || price < 1) throw new Error('Title, slug, price and inventory are required.');
    const tiers = [];
    for (const line of String(req.body.tiers || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const idx1 = line.indexOf(':');
      const idx2 = idx1 === -1 ? -1 : line.indexOf(':', idx1 + 1);
      if (idx1 === -1 || idx2 === -1) throw new Error('Each prize tier must use amount:quantity:label format.');
      const amountText = line.slice(0, idx1), quantityText = line.slice(idx1 + 1, idx2), labelText = line.slice(idx2 + 1);
      const amount = toMinor(amountText, decimalsFor(currency, getCurrencies(req.settings)));
      const quantity = parseInt(quantityText, 10);
      if (amount === null || amount < 0 || !/^\d+$/.test(quantityText.trim()) || quantity < 1) throw new Error('Each prize tier must use amount:quantity:label format.');
      tiers.push({ amount, quantity, label: labelText.trim().slice(0, 120) });
    }
    if (!tiers.length) throw new Error('Add at least one prize tier.');
    if (tiers.reduce((n, t) => n + t.quantity, 0) > totalTickets) throw new Error('Prize quantities exceed total inventory.');
    const seed = randHex(32);
    const created = await req.db.transaction(async tx => {
      const parseWhen = (v) => { const t = Date.parse(String(v || '').trim().replace(' ', 'T') + (String(v || '').includes('Z') ? '' : 'Z')); return Number.isFinite(t) && String(v || '').trim() ? t : null; };
      const launchAt = parseWhen(req.body.launch_at), endsAt = parseWhen(req.body.ends_at);
      const r = await tx.run(
        `INSERT INTO scratch_series (title,slug,game_type,currency,price,total_tickets,status,enabled,rules,server_seed,seed_hash,created_by,created_at,launch_at,ends_at)
         VALUES (?,?,?,?,?,?,'draft',0,?,?,?,?,?,?,?)`,
        [title, slug, gameType, currency, price, totalTickets, String(req.body.rules || '').slice(0, 2000), seed, sha256(seed), req.user.id, now(), launchAt, endsAt]);
      for (const tier of tiers) await tx.run('INSERT INTO scratch_prize_tiers (series_id,amount,quantity,label) VALUES (?,?,?,?)', [r.id, tier.amount, tier.quantity, tier.label]);
      return r.id;
    });
    await logEvent(req.db, req.user.id, 'series.created', 'series', created, { title, gameType, totalTickets });
    // R-066: scratch_events was write-only with no panel reader. Series
    // lifecycle now mirrors into audit_log (searchable in Admin → Audit).
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'scratch.series_created', entity: 'series', entityId: created, detail: { title, gameType, totalTickets }, ip: req.ip });
    await req.setFlash('success', 'Scratch series created as a draft. Review the payout math, then launch it.');
    res.redirect(req.adminPath + '/scratch');
  } catch (e) {
    res.status(400).render('error', { status: 400, message: e.message });
  }
});

adminRouter.post('/:id/launch', async (req, res) => {
  try {
    // BP-23 launch cap (when guardrails are on): refuse a launch whose
    // total prize liability exceeds the admin's cap % of sales value.
    const srow = await req.db.get('SELECT * FROM scratch_series WHERE id = ?', [parseInt(req.params.id, 10)]);
    if (srow) {
      const expo = await engine.seriesExposure(req.db, srow);
      const cap = engine.launchCapCheck(req.settings, srow, expo.totalLiability);
      if (cap.enforced && !cap.ok) {
        await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'scratch.guardrail_launch_blocked', entity: 'series', entityId: String(srow.id), detail: { liability: cap.liability, cap: cap.cap, capPct: cap.capPct }, ip: req.ip });
        await req.setFlash('error', `Launch refused by the prize guardrail: prize liability ${cap.liability} exceeds the cap of ${cap.capPct}% of full sales value (${cap.cap}). Lower the tiers or raise the cap in Automation → Scratch guardrails.`);
        return res.redirect(req.adminPath + '/scratch');
      }
    }
    await launchSeries(req.db, parseInt(req.params.id, 10), req.user.id);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'scratch.series_launched', entity: 'series', entityId: req.params.id, detail: {}, ip: req.ip });
    await req.setFlash('success', 'Series launched with locked shuffled outcomes.');
  }
  catch (e) { await req.setFlash('error', e.message); }
  res.redirect(req.adminPath + '/scratch');
});

adminRouter.post('/:id/toggle', async (req, res) => {
  const s = await req.db.get('SELECT * FROM scratch_series WHERE id=?', [req.params.id]);
  if (!s) { await req.setFlash('error', 'Series not found.'); return res.redirect(req.adminPath + '/scratch'); }
  // R-067: toggling a stopped or draft series flipped `enabled` with no
  // visible effect (the lobby only sells live+enabled series), so an
  // operator could believe a stopped series was back on sale. Refuse with
  // a clear message; launch is the path that makes a series live (and
  // launch sets enabled=1 itself).
  if (s.status === 'stopped' || s.status === 'draft') { await req.setFlash('error', `Cannot toggle a ${s.status} series — launch it to put it on sale.`); return res.redirect(req.adminPath + '/scratch'); }
  await req.db.run('UPDATE scratch_series SET enabled=? WHERE id=?', [s.enabled ? 0 : 1, s.id]);
  await logEvent(req.db, req.user.id, 'series.toggled', 'series', s.id, { enabled: !s.enabled });
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'scratch.series_toggled', entity: 'series', entityId: s.id, detail: { enabled: !s.enabled }, ip: req.ip });
  res.redirect(req.adminPath + '/scratch');
});

adminRouter.post('/:id/stop', async (req, res) => {
  const s = await req.db.get('SELECT * FROM scratch_series WHERE id=?', [req.params.id]);
  if (!s) { await req.setFlash('error', 'Series not found.'); return res.redirect(req.adminPath + '/scratch'); }
  if (s.status !== 'live') { await req.setFlash('error', 'Only a live series can be stopped.'); return res.redirect(req.adminPath + '/scratch'); }
  await req.db.run("UPDATE scratch_series SET status='stopped',enabled=0,stopped_at=? WHERE id=?", [now(), s.id]);
  // R-065: the old stop logged the FULL server seed in plaintext to
  // scratch_events — anyone reading the event log could forge outcomes
  // for unrevealed tickets. Only the seed hash is logged now.
  await logEvent(req.db, req.user.id, 'series.stopped', 'series', s.id, { seedHash: s.seed_hash });
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'scratch.series_stopped', entity: 'series', entityId: s.id, detail: { seedHash: s.seed_hash }, ip: req.ip });
  res.redirect(req.adminPath + '/scratch');
});

module.exports = { playerRouter, adminRouter };
