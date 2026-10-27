'use strict';
const express = require('express');
const playerRouter = express.Router();
const adminRouter = express.Router();
const { requireLogin, requireRole, rateLimit } = require('../lib/auth');
const { now, randHex, sha256, toMinor, esc } = require('../lib/util');
const ui = require('../lib/admin-ui');
const { buyTicket, revealTicket, launchSeries, responsibleStatus, logEvent } = require('../lib/scratch');

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
  const tickets = await req.db.query(
    `SELECT st.public_id,st.currency,st.price,st.status,st.prize,st.purchased_at,st.revealed_at,s.title,s.game_type
     FROM scratch_tickets st JOIN scratch_series s ON s.id=st.series_id
     WHERE st.user_id=? AND ${where} ORDER BY st.purchased_at DESC LIMIT 200`, [req.user.id]);
  const counts = await req.db.get(
    `SELECT SUM(CASE WHEN status='purchased' THEN 1 ELSE 0 END) AS unscratched,
      SUM(CASE WHEN status='revealed' THEN 1 ELSE 0 END) AS scratched, COUNT(*) AS history
     FROM scratch_tickets WHERE user_id=?`, [req.user.id]);
  res.render('scratch_tickets', { metaTitle: 'My Scratch Tickets', metaDesc: '', tickets, counts: counts || {}, tab });
});

playerRouter.get('/scratch/responsible-play', requireLogin, async (req, res) => {
  const limits = await responsibleStatus(req.db, req.user.id);
  res.render('scratch_responsible', { metaTitle: 'Scratch Play Limits', metaDesc: '', limits });
});

playerRouter.post('/scratch/responsible-play', requireLogin, async (req, res) => {
  const daily = Math.max(0, toMinor(req.body.daily_loss_limit) || 0);
  const session = Math.max(0, Math.min(1440, parseInt(req.body.session_limit_minutes, 10) || 0));
  const coolHours = Math.max(0, Math.min(720, parseInt(req.body.cooling_off_hours, 10) || 0));
  const exclusionDays = Math.max(0, Math.min(3650, parseInt(req.body.self_exclusion_days, 10) || 0));
  const current = await responsibleStatus(req.db, req.user.id);
  const coolingUntil = Math.max(Number(current.cooling_off_until || 0), coolHours ? now() + coolHours * 3600000 : 0);
  const excludedUntil = Math.max(Number(current.self_excluded_until || 0), exclusionDays ? now() + exclusionDays * 86400000 : 0);
  const existing = await req.db.get('SELECT user_id FROM responsible_play WHERE user_id=?', [req.user.id]);
  if (existing) await req.db.run(
    'UPDATE responsible_play SET daily_loss_limit=?,session_limit_minutes=?,cooling_off_until=?,self_excluded_until=?,updated_at=? WHERE user_id=?',
    [daily, session, coolingUntil, excludedUntil, now(), req.user.id]);
  else await req.db.run(
    'INSERT INTO responsible_play (user_id,daily_loss_limit,session_limit_minutes,cooling_off_until,self_excluded_until,updated_at) VALUES (?,?,?,?,?,?)',
    [req.user.id, daily, session, coolingUntil, excludedUntil, now()]);
  await logEvent(req.db, req.user.id, 'responsible_play.updated', 'user', req.user.id, { daily, session, coolingUntil, excludedUntil });
  await req.setFlash('success', 'Scratch play limits updated. Cooling-off and self-exclusion can only be extended, not shortened.');
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
      res.redirect('/scratch/ticket/' + encodeURIComponent(req.params.publicId));
    } catch (e) {
      res.status(400).render('error', { status: 400, message: e.message });
    }
  });

playerRouter.post('/scratch/:id/buy', requireLogin,
  rateLimit({ windowMs: 60000, max: 10, keyFn: req => `scratch-buy:${req.user.id}` }),
  async (req, res) => {
    try {
      const bought = await buyTicket(req.db, req.user.id, parseInt(req.params.id, 10), req.ip);
      res.redirect('/scratch/ticket/' + encodeURIComponent(bought.publicId));
    } catch (e) {
      res.status(400).render('error', { status: 400, message: 'Scratch purchase failed: ' + e.message });
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
  const fmt = (minor, cur) => (Number(minor || 0) / 100).toFixed(2) + ' ' + (cur || 'USD');
  const base = req.adminPath + '/scratch';
  const body = ui.card('Scratch series', ui.table(['Title', 'Game', 'Price', 'Sold / total', 'Revenue', 'Paid out', 'Prize pool', 'Status', 'Enabled', 'Actions'],
    series.map(s => [
      esc(s.title), esc(s.game_type), fmt(s.price, s.currency), `${s.sold} / ${s.total_tickets}`,
      fmt(s.revenue, s.currency), fmt(s.paid, s.currency), fmt(s.prize_pool, s.currency),
      ui.statusBadge(s.status), s.enabled ? ui.badge('on', 'ok') : ui.badge('off', 'muted'),
      `<form method="POST" action="${base}/${s.id}/launch" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm" data-confirm="Launch this series? Outcomes lock on launch.">Launch</button></form>
       <form method="POST" action="${base}/${s.id}/toggle" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">${s.enabled ? 'Disable' : 'Enable'}</button></form>
       <form method="POST" action="${base}/${s.id}/stop" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm btn-d" data-confirm="Stop this series?">Stop</button></form>`,
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
      ], { csrf: req.csrfToken, submit: 'Create draft' }));
  res.send(ui.layout({ adminPath: req.adminPath, section: '/scratch', title: 'Scratch', body, csrf: req.csrfToken, flash: req.flashData || {}, assetV: req.app.locals.assetV || '1' }));
});

adminRouter.post('/create', async (req, res) => {
  try {
    const title = String(req.body.title || '').trim().slice(0, 120);
    const slug = String(req.body.slug || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
    const gameType = ['single', 'match3', 'six', 'bonus'].includes(req.body.game_type) ? req.body.game_type : 'single';
    const currency = String(req.body.currency || 'USD').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
    const price = toMinor(req.body.price);
    const totalTickets = Math.max(1, Math.min(1000000, parseInt(req.body.total_tickets, 10) || 0));
    if (!title || !slug || !price || price < 1) throw new Error('Title, slug, price and inventory are required.');
    const tiers = [];
    for (const line of String(req.body.tiers || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [amountText, quantityText, labelText] = line.split(':');
      const amount = toMinor(amountText);
      const quantity = parseInt(quantityText, 10);
      if (amount === null || amount < 0 || !Number.isInteger(quantity) || quantity < 1) throw new Error('Each prize tier must use amount:quantity:label format.');
      tiers.push({ amount, quantity, label: String(labelText || '').trim().slice(0, 120) });
    }
    if (!tiers.length) throw new Error('Add at least one prize tier.');
    if (tiers.reduce((n, t) => n + t.quantity, 0) > totalTickets) throw new Error('Prize quantities exceed total inventory.');
    const seed = randHex(32);
    const created = await req.db.transaction(async tx => {
      const r = await tx.run(
        `INSERT INTO scratch_series (title,slug,game_type,currency,price,total_tickets,status,enabled,rules,server_seed,seed_hash,created_by,created_at)
         VALUES (?,?,?,?,?,?,'draft',0,?,?,?,?,?)`,
        [title, slug, gameType, currency, price, totalTickets, String(req.body.rules || '').slice(0, 2000), seed, sha256(seed), req.user.id, now()]);
      for (const tier of tiers) await tx.run('INSERT INTO scratch_prize_tiers (series_id,amount,quantity,label) VALUES (?,?,?,?)', [r.id, tier.amount, tier.quantity, tier.label]);
      return r.id;
    });
    await logEvent(req.db, req.user.id, 'series.created', 'series', created, { title, gameType, totalTickets });
    await req.setFlash('success', 'Scratch series created as a draft. Review the payout math, then launch it.');
    res.redirect(req.adminPath + '/scratch');
  } catch (e) {
    res.status(400).render('error', { status: 400, message: e.message });
  }
});

adminRouter.post('/:id/launch', async (req, res) => {
  try { await launchSeries(req.db, parseInt(req.params.id, 10), req.user.id); await req.setFlash('success', 'Series launched with locked shuffled outcomes.'); }
  catch (e) { await req.setFlash('error', e.message); }
  res.redirect(req.adminPath + '/scratch');
});

adminRouter.post('/:id/toggle', async (req, res) => {
  const s = await req.db.get('SELECT * FROM scratch_series WHERE id=?', [req.params.id]);
  if (s) {
    await req.db.run('UPDATE scratch_series SET enabled=? WHERE id=?', [s.enabled ? 0 : 1, s.id]);
    await logEvent(req.db, req.user.id, 'series.toggled', 'series', s.id, { enabled: !s.enabled });
  }
  res.redirect(req.adminPath + '/scratch');
});

adminRouter.post('/:id/stop', async (req, res) => {
  const s = await req.db.get('SELECT * FROM scratch_series WHERE id=?', [req.params.id]);
  if (s && s.status === 'live') {
    await req.db.run("UPDATE scratch_series SET status='stopped',enabled=0,stopped_at=? WHERE id=?", [now(), s.id]);
    await logEvent(req.db, req.user.id, 'series.stopped', 'series', s.id, { seedReveal: s.server_seed });
  }
  res.redirect(req.adminPath + '/scratch');
});

module.exports = { playerRouter, adminRouter };
