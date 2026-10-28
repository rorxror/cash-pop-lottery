'use strict';
/* Agent panel: dashboard, player management (incl. unassigned-player picker),
   delegated user creation, float-funded wallet transfers, commissions. */
const express = require('express');
const router = express.Router();
const { now, randHex, validEmail, hashPassword, normalizeEmail, normalizePhone } = require('../lib/util');
const { getS, getBool } = require('../lib/settings');
const { requireLogin, requireRole } = require('../lib/auth');
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
  const { name, email, phone, password } = req.body;
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
  const floats = await req.db.query('SELECT currency, balance FROM agent_floats WHERE agent_id = ?', [aid]);
  const players = await req.db.query("SELECT id, name FROM users WHERE agent_id = ? AND role = 'player' AND status = 'active' ORDER BY name", [aid]);
  res.render('agent/transfer', { metaTitle: 'Fund Player', metaDesc: '', floats, players });
});

router.post('/transfer', async (req, res) => {
  const aid = agentId(req);
  const toUser = parseInt(req.body.to_user_id, 10);
  const currency = String(req.body.currency || '').toUpperCase().slice(0, 8);
  const { toMinor } = require('../lib/util');
  const amount = toMinor(req.body.amount);
  const note = String(req.body.note || '').slice(0, 255);
  // R-068: the transfer form only lists active players, but the POST
  // never enforced it — a crafted POST could fund a banned player.
  const target = await req.db.get("SELECT * FROM users WHERE id = ? AND agent_id = ? AND role = 'player' AND status = 'active'", [toUser, aid]);
  if (!target || !amount || amount <= 0) { await req.setFlash('error', 'Invalid player or amount.'); return res.redirect('/agent/transfer'); }
  try {
    await req.db.transaction(async (tx) => {
      // Atomic float debit: the guarded UPDATE + affected-row check closes
      // the same double-spend race as the wallet ledger (two concurrent
      // transfers cannot both pass the balance check).
      const f = await tx.run('UPDATE agent_floats SET balance = balance - ? WHERE agent_id = ? AND currency = ? AND balance >= ?', [amount, aid, currency, amount]);
      if (f.changes === 0) throw new Error('Insufficient float balance.');
      await postLedger(tx, { userId: toUser, currency, type: 'agent_funding', amount, refType: 'agent_transfer', refId: String(aid), meta: { note, agent_id: aid } });
      await tx.run('INSERT INTO agent_transfers (from_agent, to_user, currency, amount, note, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [aid, toUser, currency, amount, note, now(), req.user.id]);
    });
    await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'agent.transfer', entity: 'user', entityId: toUser, detail: { amount, currency, note }, ip: req.ip });
    await req.setFlash('success', 'Transfer completed.');
  } catch (e) {
    await req.setFlash('error', 'Transfer failed: ' + e.message);
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

module.exports = router;
