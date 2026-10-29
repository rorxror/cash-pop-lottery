'use strict';
/* Agent panel: dashboard, player management (incl. unassigned-player picker),
   delegated user creation, float-funded wallet transfers, commissions. */
const express = require('express');
const router = express.Router();
const { now, randHex, validEmail, hashPassword, normalizeEmail, normalizePhone, toMinor, decimalsFor } = require('../lib/util');
const { getS, getBool, getCurrencies } = require('../lib/settings');
const { requireLogin, requireRole, touchSession } = require('../lib/auth');
const { getBalances, postLedger } = require('../lib/money');
const audit = require('../lib/audit');

router.use(requireLogin, requireRole('agent', 'admin'));

/* Agents see their own panel; admins get read access via the same routes.
   R-012: the old agentId() let ANY admin-role user — including support /
   risk / finance sub-roles that admin RBAC blocks from money actions —
   WRITE as any agent (transfer from that agent's float, claim/create
   players) via ?as=. Now: agents always act as themselves; ?as= is
   honoured ONLY for super admins (read and write); any non-super admin
   POST to an agent route is refused outright (the agent router has no
   rbacMiddleware, so this guard is the role check). */
function isSuperAdmin(req) { return req.user.role === 'admin' && (req.user.admin_role || 'super') === 'super'; }
function agentId(req) {
  if (req.user.role === 'agent') return req.user.id;
  if (isSuperAdmin(req)) return parseInt(req.query.as, 10) || req.user.id;
  return req.user.id; // non-super admin: ?as= is ignored, never honoured
}
router.use((req, res, next) => {
  if (req.method === 'POST' && req.user.role === 'admin' && !isSuperAdmin(req)) {
    return res.status(403).render('error', { status: 403, message: 'Your staff role does not permit agent actions.' });
  }
  next();
});

router.get('/', async (req, res) => {
  const aid = agentId(req);
  const players = await req.db.get('SELECT COUNT(*) AS c FROM users WHERE agent_id = ?', [aid]);
  const week = await req.db.get(
    'SELECT COUNT(*) AS c FROM tickets t JOIN users u ON u.id = t.user_id WHERE u.agent_id = ? AND t.created_at > ?', [aid, now() - 7 * 86400000]);
  // R-118: the old dashboard summed every currency into one number.
  // Commissions now group by currency; the template renders each total in
  // its own currency instead of one mixed sum.
  const commByCur = await req.db.query('SELECT currency, COALESCE(SUM(amount),0) AS s FROM commissions WHERE agent_id = ? GROUP BY currency', [aid]);
  const floats = await req.db.query('SELECT currency, balance FROM agent_floats WHERE agent_id = ?', [aid]);
  const recent = await req.db.query(
    `SELECT c.*, u.name AS user_name FROM commissions c JOIN users u ON u.id = c.user_id
     WHERE c.agent_id = ? ORDER BY c.created_at DESC LIMIT 10`, [aid]);
  res.render('agent/dashboard', {
    metaTitle: 'Agent Panel', metaDesc: '',
    stats: { players: players.c, tickets_week: week.c, commissions_by_currency: commByCur },
    floats, recent,
  });
});

router.get('/players', async (req, res) => {
  const aid = agentId(req);
  // R-069: one GROUP BY query instead of one ticket-count query per player.
  const players = await req.db.query(
    `SELECT u.id, u.name, u.email, u.created_at, u.status, COUNT(t.id) AS tickets
     FROM users u LEFT JOIN tickets t ON t.user_id = u.id
     WHERE u.agent_id = ? AND u.role = 'player' GROUP BY u.id ORDER BY u.created_at DESC`, [aid]);
  // Unassigned-player picker (item 33): players with no agent can be delegated
  const unassigned = req.user.role === 'admin'
    // Unassigned players (names + emails) used to render to EVERY agent, even
    // agents with no relationship to those players. Only operators (admins)
    // may see the unclaimed pool; agents see only their own players.
    ? await req.db.query("SELECT id, name, email, created_at FROM users WHERE role = 'player' AND agent_id IS NULL ORDER BY created_at DESC LIMIT 100")
    : [];
  res.render('agent/players', { metaTitle: 'My Players', metaDesc: '', players, unassigned });
});

router.post('/players/claim', async (req, res) => {
  /* U-20.5: the unassigned pool is operators-only BY DESIGN (the list
     handler hides it from agents for privacy), but this endpoint still
     let any agent claim ANY unassigned player by guessing their
     sequential user id — the list privacy was theatre while the action
     stayed open. Claim is an operator action; agents receive players by
     operator assignment or by creating them. */
  if (req.user.role !== 'admin') { await req.setFlash('error', 'Only operators can claim unassigned players. Ask an operator to assign this player to you.'); return res.redirect('/agent/players'); }
  const aid = agentId(req);
  const uid = parseInt(req.body.user_id, 10);
  const target = await req.db.get("SELECT * FROM users WHERE id = ? AND role = 'player'", [uid]);
  if (!target) { await req.setFlash('error', 'Player not found.'); return res.redirect('/agent/players'); }
  if (target.agent_id && req.user.role !== 'admin') { await req.setFlash('error', 'Player is already assigned to an agent.'); return res.redirect('/agent/players'); }
  await req.db.run('UPDATE users SET agent_id = ? WHERE id = ?', [aid, uid]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'agent.player_claim', entity: 'user', entityId: uid, detail: { agent_id: aid }, ip: req.ip });
  await req.setFlash('success', 'Player assigned to you.');
  res.redirect('/agent/players');
});

router.get('/players/new', async (req, res) => {
  res.render('agent/create_user', { metaTitle: 'Create Player', metaDesc: '' });
});

router.post('/players/new', async (req, res) => {
  const aid = agentId(req);
  const name = typeof req.body.name === 'string' ? req.body.name : ''; // B-08: type-confusion guards
  const email = typeof req.body.email === 'string' ? req.body.email : '';
  const phone = typeof req.body.phone === 'string' ? req.body.phone : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  // v14: player minimum is 8 (standing rule — the old 6 here was a hole).
  const { passwordError } = require('../lib/validate');
  const pwErr = passwordError(password, 'player', getBool(req.settings, 'secure_password', true));
  if (!name || !validEmail(email) || pwErr) {
    return res.render('agent/create_user', { metaTitle: 'Create Player', metaDesc: '', formError: pwErr || 'Name and valid email are required.' });
  }
  if (getBool(req.settings, 'breached_password_check', true)) {
    const { isBreached } = require('../lib/breached');
    if (await isBreached(password)) {
      return res.render('agent/create_user', { metaTitle: 'Create Player', metaDesc: '', formError: 'This password has appeared in a data breach. Please choose a different one.' });
    }
  }
  const emailLc = normalizeEmail(email);
  const phoneNorm = normalizePhone(phone);
  if (phoneNorm) {
    const { isBlockedPhone } = require('../lib/phone-countries');
    if (isBlockedPhone(req.settings, phoneNorm)) return res.render('agent/create_user', { metaTitle: 'Create Player', metaDesc: '', formError: 'Phone numbers from this country are not accepted on this platform.' });
  }
  const ex = await req.db.get('SELECT id FROM users WHERE email = ?', [emailLc]);
  if (ex) return res.render('agent/create_user', { metaTitle: 'Create Player', metaDesc: '', formError: 'Email already registered.' });
  if (phoneNorm) {
    const exPhone = await req.db.get('SELECT id FROM users WHERE phone = ?', [phoneNorm]);
    if (exPhone) return res.render('agent/create_user', { metaTitle: 'Create Player', metaDesc: '', formError: 'Phone number already registered.' });
  }
  const r = await req.db.run(
    'INSERT INTO users (email, phone, name, password_hash, role, status, agent_id, force_password_reset, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
    [emailLc, phoneNorm, name.trim(), hashPassword(password), 'player', 'active', aid, now()]);
  // The player MUST set their own password at first sign-in (server.js gate
  // redirects force_password_reset users to /force-reset). Previously the
  // creating agent kept the password they chose — full account access — and
  // controlled the player's email/phone, so withdrawal OTPs went to the agent.
  await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'agent.player_create', entity: 'user', entityId: r.id, detail: { email: emailLc, agent_id: aid }, ip: req.ip });
  await req.setFlash('success', 'Player account created.');
  res.redirect('/agent/players');
});

router.get('/transfer', async (req, res) => {
  const aid = agentId(req);
  const floatRows = await req.db.query('SELECT currency, balance FROM agent_floats WHERE agent_id = ?', [aid]);
  /* AGENT-CURRENCY-01 (owner-reported): the currency dropdown used to
     render ONLY from agent_floats rows — an agent whose float was
     never funded had zero rows, so the select rendered EMPTY (owner:
     "currency ka option hai lekin show nahi hoti") and the form was
     silently unusable. The dropdown now always lists the site's
     enabled currencies, each annotated with this agent's float
     balance in it (0 where unfunded); a fully-empty float also gets
     a plain-language empty-state on the page. The POST guard below
     still refuses an underfunded transfer with the true reason. */
  const byCur = Object.fromEntries(floatRows.map(f => [f.currency, Number(f.balance) || 0]));
  const floats = getCurrencies(req.settings).map(c => ({ currency: c.code, balance: byCur[c.code] || 0 }));
  for (const f of floatRows) if (!floats.some(x => x.currency === f.currency)) floats.push({ currency: f.currency, balance: Number(f.balance) || 0 });
  const floatTotal = floats.reduce((a, f) => a + (f.balance > 0 ? f.balance : 0), 0);
  const players = await req.db.query("SELECT id, name FROM users WHERE agent_id = ? AND role = 'player' AND status = 'active' ORDER BY name", [aid]);
  /* D1-C7 (v20): every rendered transfer form carries a fresh one-time
     submission token, stored server-side in the session; the POST
     claims it in the DB (agent_transfers.idempotency_key UNIQUE,
     migration v21) inside the transfer transaction. */
  const transferToken = randHex(16);
  if (req.sess) await touchSession(req.db, req.sess.id, { transfer_token: transferToken });
  res.render('agent/transfer', { metaTitle: 'Fund Player', metaDesc: '', floats, players, transferToken, floatEmpty: floatTotal <= 0 });
});

router.post('/transfer', async (req, res) => {
  const aid = agentId(req);
  const toUser = parseInt(req.body.to_user_id, 10);
  const currency = String(req.body.currency || '').toUpperCase().slice(0, 8);
  /* D1-C6 (v20): parse with the CURRENCY's decimals — the old bare
     toMinor() defaulted to 2, so a 0-decimal currency (JPY) moved
     100x the typed amount. */
  const amount = toMinor(req.body.amount, decimalsFor(currency, getCurrencies(req.settings)));
  const note = String(req.body.note || '').slice(0, 255);
  /* D1-C7 (v20): one-time submission. The token must match the one the
     GET issued for this session; the transfer row is INSERTed FIRST
     inside the transaction with the token as its UNIQUE
     idempotency_key, so two parallel identical POSTs cannot both
     apply: the second insert fails on the unique key and its whole
     transaction (float debit included) rolls back. A failed transfer
     (e.g. insufficient float) rolls the claim back too, so the same
     form can be corrected and resubmitted. */
  const token = String(req.body.transfer_token || '');
  const storedToken = req.sessionData && req.sessionData.transfer_token;
  if (!token || !storedToken || token !== storedToken) {
    let used = null;
    if (token) { try { used = await req.db.get('SELECT id FROM agent_transfers WHERE idempotency_key = ?', [token]); } catch {} }
    await req.setFlash('error', used ? 'This transfer was already submitted — check the transfer history.' : 'This transfer form has expired — reload the transfer page and try again.');
    return res.redirect('/agent/transfer');
  }
  // R-068: the transfer form only lists active players, but the POST
  // never enforced it — a crafted POST could fund a banned player.
  const target = await req.db.get("SELECT * FROM users WHERE id = ? AND agent_id = ? AND role = 'player' AND status = 'active'", [toUser, aid]);
  if (!target || !amount || amount <= 0) { await req.setFlash('error', 'Invalid player or amount.'); return res.redirect('/agent/transfer'); }
  try {
    await req.db.transaction(async (tx) => {
      // Claim the one-time token FIRST (UNIQUE idempotency_key, v21).
      const claim = await tx.run('INSERT INTO agent_transfers (from_agent, to_user, currency, amount, note, created_at, created_by, idempotency_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [aid, toUser, currency, amount, note, now(), req.user.id, token]);
      // Atomic float debit: the guarded UPDATE + affected-row check closes
      // the same double-spend race as the wallet ledger (two concurrent
      // transfers cannot both pass the balance check).
      const f = await tx.run('UPDATE agent_floats SET balance = balance - ? WHERE agent_id = ? AND currency = ? AND balance >= ?', [amount, aid, currency, amount]);
      if (f.changes === 0) throw new Error('Insufficient float balance.');
      await postLedger(tx, { userId: toUser, currency, type: 'agent_funding', amount, refType: 'agent_transfer', refId: String(aid), meta: { note, agent_id: aid, transfer_id: claim.id } });
    });
    if (req.sess) await touchSession(req.db, req.sess.id, { transfer_token: null });
    await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'agent.transfer', entity: 'user', entityId: toUser, detail: { amount, currency, note }, ip: req.ip });
    await req.setFlash('success', 'Transfer completed.');
  } catch (e) {
    if (/UNIQUE|duplicate/i.test(e.message)) await req.setFlash('error', 'This transfer was already submitted — check the transfer history.');
    else await req.setFlash('error', 'Transfer failed: ' + e.message);
  }
  res.redirect('/agent/transfer');
});

router.get('/commissions', async (req, res) => {
  const aid = agentId(req);
  const rows = await req.db.query(
    `SELECT c.*, u.name AS user_name, t.public_id AS ticket_public_id
     FROM commissions c JOIN users u ON u.id = c.user_id LEFT JOIN tickets t ON t.id = c.ticket_id
     WHERE c.agent_id = ? ORDER BY c.created_at DESC LIMIT 200`, [aid]);
  res.render('agent/commissions', { metaTitle: 'Commissions', metaDesc: '', rows });
});

/* DS-010: agents are the player's first support contact, but tickets only
   ever reached the admin panel - the agent router had no support routes at
   all. Agents now see and answer tickets from THEIR OWN players only
   (ownership is enforced by the users.agent_id join on every query). */
router.get('/support', async (req, res) => {
  const aid = agentId(req);
  const tickets = await req.db.query(
    `SELECT t.*, u.name AS player_name, u.email AS player_email FROM support_tickets t
     JOIN users u ON u.id = t.user_id WHERE u.agent_id = ? AND t.deleted_at IS NULL ORDER BY t.updated_at DESC LIMIT 200`, [aid]);
  res.render('agent/support', { metaTitle: 'Support', metaDesc: '', tickets });
});

/* U-25: agents only ever see LIVE tickets of their own players —
   soft-deleted rows are excluded here, so the detail view and the
   reply path treat them exactly like the admin side does. */
async function agentTicket(req) {
  const aid = agentId(req);
  return req.db.get(
    `SELECT t.*, u.name AS player_name, u.email AS player_email FROM support_tickets t
     JOIN users u ON u.id = t.user_id WHERE t.public_id = ? AND u.agent_id = ? AND t.deleted_at IS NULL`, [req.params.publicId, aid]);
}

router.get('/support/:publicId', async (req, res) => {
  const ticket = await agentTicket(req);
  if (!ticket) return res.status(404).render('error', { status: 404, message: 'Ticket not found.' });
  const rows = await req.db.query('SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY created_at', [ticket.id]);
  const messages = rows.map(m => ({ ...m, mine: m.author_role === 'agent' && m.author_id === req.user.id }));
  // BP-15 (v19): the same admin-managed canned replies are offered to
  // agents — one shared list, one shared picker (public/app.js).
  const canned = ticket.status !== 'closed'
    ? await req.db.query('SELECT id, title, body FROM canned_replies ORDER BY title, id')
    : [];
  res.render('agent/support_view', { metaTitle: 'Ticket ' + ticket.public_id, metaDesc: '', ticket, messages, canned });
});

/* U-25: agent soft delete — ONLY their own players' tickets (the same
   scope agentTicket enforces). Executes on click; sets
   deleted_at/deleted_by + audit row; sends NO notification. A ticket
   of another agent's player (or a missing/already-deleted one) gets
   the same 404 as the detail view, so existence is never leaked. */
router.post('/support/:publicId/delete', async (req, res) => {
  const ticket = await agentTicket(req);
  if (!ticket) return res.status(404).render('error', { status: 404, message: 'Ticket not found.' });
  const nowMs = Date.now();
  const r = await req.db.run('UPDATE support_tickets SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [nowMs, req.user.id, nowMs, ticket.id]);
  if (r.changes !== 1) { await req.setFlash('error', 'Ticket not found or already deleted.'); return res.redirect('/agent/support'); }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'agent', action: 'support.delete', entity: 'support', entityId: ticket.public_id, detail: { ticket_id: ticket.id, status_at_delete: ticket.status, via: 'agent' }, ip: req.ip });
  await req.setFlash('success', 'Ticket deleted. It is hidden from queues and kept for the operators as dispute evidence.');
  res.redirect('/agent/support');
});

router.post('/support/:publicId/reply', async (req, res) => {
  const ticket = await agentTicket(req);
  if (!ticket) {
    /* U-25: distinguish "deleted" from "not yours / missing" for own
       players so the agent gets the true reason — and the deleted
       ticket is never resurrected by a reply. */
    const aid = agentId(req);
    const deleted = await req.db.get(
      `SELECT t.public_id FROM support_tickets t JOIN users u ON u.id = t.user_id
       WHERE t.public_id = ? AND u.agent_id = ? AND t.deleted_at IS NOT NULL`, [req.params.publicId, aid]);
    if (deleted) { await req.setFlash('error', 'This ticket has been deleted and can no longer be replied to.'); return res.redirect('/agent/support'); }
    return res.status(404).render('error', { status: 404, message: 'Ticket not found.' });
  }
  if (ticket.status === 'closed') { await req.setFlash('error', 'This ticket is closed.'); return res.redirect('/agent/support/' + ticket.public_id); }
  const body = String(req.body.message || '').trim().slice(0, 5000);
  if (!body) return res.redirect('/agent/support/' + ticket.public_id);
  await req.db.run('INSERT INTO support_messages (ticket_id, author_id, author_role, body, created_at) VALUES (?, ?, ?, ?, ?)', [ticket.id, req.user.id, 'agent', body, now()]);
  await req.db.run("UPDATE support_tickets SET status = 'answered', updated_at = ? WHERE id = ?", [now(), ticket.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'agent', action: 'support.reply', entity: 'support', entityId: ticket.public_id, detail: {}, ip: req.ip });
  try {
    const notify = require('../lib/notify');
    // BP-13: support-reply email respects the player's preference.
    if (await notify.emailPrefEnabled(req.db, ticket.user_id, 'support_reply'))
      await notify.send(req.db, req.settings, 'email', 'support_reply', ticket.player_email, { name: ticket.player_name, subject: ticket.subject });
  } catch {}
  await req.setFlash('success', 'Reply sent.');
  res.redirect('/agent/support/' + ticket.public_id);
});

module.exports = router;
