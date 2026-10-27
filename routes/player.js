'use strict';
/* Player site: playslip + ticket purchase (server-verified, HMAC-signed),
   tickets, wallet, deposits/withdrawals, transactions, profile, 2FA, support. */
const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { now, randHex, hmac, sha256, hashPassword, verifyPassword, toMinor, esc } = require('../lib/util');
const { getS, getBool, getCurrencies, getSettings } = require('../lib/settings');
const { requireLogin } = require('../lib/auth');
const { getBalances, postLedger, depositPolicy, withdrawalPolicy, chargeFor, createDeposit, createWithdrawal, checkWithdrawalRules, notePayoutDetails, releaseReferralCredits } = require('../lib/money');
const { getRail } = require('../lib/rails');
const { newTotpSecret, totpUri, verifyTotp, newBackupCodes, hashBackupCodes, destroyUserSessions } = require('../lib/auth');
const notify = require('../lib/notify');
const audit = require('../lib/audit');

const baseCurrency = (req) => getS(req.settings, 'base_currency', 'USD');

/* ---------------- playslip ---------------- */
router.get('/play', requireLogin, async (req, res) => {
  const wagerOptions = req.wagerOptions;
  const prizeTable = await req.db.query('SELECT pops_count, multiplier FROM prize_table ORDER BY pops_count');
  const wallets = await getBalances(req.db, req.user.id);
  const bal = (wallets.find(w => w.currency === baseCurrency(req)) || { balance: 0 }).balance;
  res.render('play', {
    metaTitle: 'Play', metaDesc: 'Pick your pops and buy a Cash Pop ticket.',
    wagerOptions, prizeTable, maxDraws: parseInt(getS(req.settings, 'max_draws', '7'), 10) || 7, balance: bal,
  });
});

function signTicket(secret, t) {
  return hmac(secret, [t.public_id, t.user_id, t.pops, t.wager, t.draw_ids, t.total, t.currency].join('|'));
}

router.post('/play/buy', requireLogin, async (req, res) => {
  const settings = req.settings;
  const maxPops = parseInt(getS(settings, 'max_pops', '15'), 10) || 15;
  const maxDraws = parseInt(getS(settings, 'max_draws', '7'), 10) || 7;
  let pops = req.body.pops;
  if (!Array.isArray(pops)) pops = pops ? [pops] : [];
  pops = [...new Set(pops.map(p => parseInt(p, 10)).filter(p => p >= 1 && p <= 15))].sort((a, b) => a - b);
  const wager = parseInt(req.body.wager, 10);
  const drawType = String(req.body.draw_type || 'DAY').toUpperCase();
  const numDraws = Math.max(1, Math.min(maxDraws, parseInt(req.body.num_draws, 10) || 1));
  const fail = (msg) => res.status(400).render('error', { status: 400, message: msg });

  if (!pops.length || pops.length > maxPops) return fail(`Pick between 1 and ${maxPops} pops.`);
  if (!req.wagerOptions.includes(wager)) return fail('Invalid wager amount.');
  if (!['DAY', 'EVE', 'BOTH'].includes(drawType)) return fail('Invalid draw type.');

  // Responsible play: self-exclusion / cooling-off blocks the lottery too,
  // not just scratch (previously only scratch checked this).
  try {
    const { enforceAccountPlayable } = require('../lib/scratch');
    await enforceAccountPlayable(req.db, req.user.id);
  } catch (e) { return fail(e.message); }

  // find upcoming draws (server-side — never trust client draw ids)
  const types = drawType === 'BOTH' ? ['DAY', 'EVE'] : [drawType];
  const drawIds = [];
  for (const t of types) {
    const rows = await req.db.query(
      "SELECT id FROM draws WHERE draw_type = ? AND status = 'scheduled' AND close_at > ? ORDER BY close_at ASC LIMIT ?",
      [t, now(), numDraws]);
    if (rows.length < numDraws) return fail(`Not enough upcoming ${t} draws available. Try fewer draws.`);
    drawIds.push(...rows.map(r => r.id));
  }
  let total = pops.length * wager * drawIds.length;
  // Multi-draw bundle discount (ViserLab-style): exact N-draw bundles get N% off
  let bundleDiscount = 0;
  const bundles = String(getS(req.settings, 'multi_draw_discounts', '') || '').split(',')
    .map(x => x.trim().split(':').map(Number)).filter(([n, pc]) => n > 0 && pc > 0 && pc < 100);
  const bundle = bundles.find(([n]) => n === drawIds.length);
  if (bundle) { bundleDiscount = bundle[1]; total = Math.round(total * (100 - bundleDiscount) / 100); }
  const currency = baseCurrency(req);

  try {
    const publicId = 'T' + now().toString(36).toUpperCase() + randHex(4).toUpperCase();
    const secret = process.env.TICKET_HMAC_SECRET || 'dev-secret-change-me';
    const ticket = {
      public_id: publicId, user_id: req.user.id, pops: JSON.stringify(pops),
      wager, draw_ids: JSON.stringify(drawIds), total, currency,
    };
    ticket.hmac = signTicket(secret, ticket);
    const ticketId = await req.db.transaction(async (tx) => {
      // atomic debit
      await postLedger(tx, { userId: req.user.id, currency, type: 'ticket_purchase', amount: -total, refType: 'ticket', refId: publicId, meta: { pops, wager, draws: drawIds.length, bundle_discount: bundleDiscount } });
      const r = await tx.run(
        `INSERT INTO tickets (public_id, user_id, currency, pops, wager, num_draws, draw_type, draw_ids, total, status, hmac, ip, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [publicId, req.user.id, currency, ticket.pops, wager, numDraws, drawType, ticket.draw_ids, total, ticket.hmac, req.ip, now()]);
      for (const did of drawIds) {
        await tx.run("INSERT INTO ticket_entries (ticket_id, draw_id, status) VALUES (?, ?, 'pending')", [r.id, did]);
      }
      // Referral commission (v14): recorded as PENDING, not paid instantly.
      // It releases only after the referee's first approved deposit + any
      // wagering, up to the per-referee cap (see lib/money.js release).
      if (getBool(req.settings, 'referral_enabled', false)) {
        const rate = parseFloat(getS(req.settings, 'referral_rate', '5')) || 0;
        const buyer = await tx.get('SELECT referred_by FROM users WHERE id = ?', [req.user.id]);
        if (buyer && buyer.referred_by && rate > 0) {
          const comm = Math.round(total * rate / 100);
          if (comm > 0) await tx.run('INSERT INTO referral_credits (referrer_id, referee_id, ticket_id, currency, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [buyer.referred_by, req.user.id, r.id, currency, comm, 'pending', now()]);
        }
      }
      // agent commission on purchase
      if (req.user.agent_id) {
        const rate = parseFloat(getS(settings, 'commission_rate', '5')) || 0;
        if (rate > 0) {
          const amt = Math.round(total * rate / 100);
          await tx.run('INSERT INTO commissions (agent_id, user_id, ticket_id, currency, amount, rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [req.user.agent_id, req.user.id, r.id, currency, amt, rate, now()]);
        }
      }
      return r.id;
    });
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'player', action: 'ticket.buy', entity: 'ticket', entityId: publicId, detail: { pops, wager, drawType, numDraws, total }, ip: req.ip });
    // This purchase counts as wagering: release any pending referral credits
    // whose referee conditions are now met. Best-effort — a failure leaves
    // rows pending for the next trigger (deposit approval or next buy).
    try { await releaseReferralCredits(req.db, req.user.id, req.settings); } catch (e) { console.error('referral release failed:', e.message); }
    res.redirect('/ticket/' + publicId);
  } catch (e) {
    res.status(400).render('error', { status: 400, message: 'Purchase failed: ' + e.message });
  }
});

/* ---------------- tickets ---------------- */
router.get('/tickets', requireLogin, async (req, res) => {
  const tickets = await req.db.query('SELECT * FROM tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 100', [req.user.id]);
  for (const t of tickets) {
    const c = await req.db.get('SELECT COUNT(*) AS n, SUM(status = ?) AS w FROM ticket_entries WHERE ticket_id = ?', ['won', t.id]);
    t.entry_count = c.n; t.won_count = c.w || 0;
    t.pops = JSON.parse(t.pops || '[]');
  }
  res.render('tickets', { metaTitle: 'My Tickets', metaDesc: '', tickets });
});

router.get('/ticket/:publicId', requireLogin, async (req, res) => {
  const t = await req.db.get('SELECT * FROM tickets WHERE public_id = ? AND user_id = ?', [req.params.publicId, req.user.id]);
  if (!t) return res.status(404).render('error', { status: 404, message: 'Ticket not found.' });
  const entries = await req.db.query(
    `SELECT te.*, d.draw_type, d.draw_date, d.winning_number, d.status AS draw_status, d.is_test
     FROM ticket_entries te JOIN draws d ON d.id = te.draw_id WHERE te.ticket_id = ? ORDER BY d.close_at`, [t.id]);
  res.render('ticket', {
    metaTitle: 'Ticket ' + t.public_id, metaDesc: '',
    ticket: { ...t, pops: JSON.parse(t.pops || '[]'), hmac_short: t.hmac.slice(0, 16) },
    entries: entries.map(e => ({ draw_label: (e.draw_type === 'DAY' ? 'Day' : e.draw_type === 'EVE' ? 'Evening' : 'Test') + ' ' + e.draw_date, ...e })),
  });
});

/* ---------------- wallet / deposits / withdrawals ---------------- */
async function enabledMethods(db, kind) {
  const all = await db.query("SELECT * FROM payment_methods WHERE enabled = 1 AND (kind = ? OR kind = 'both') ORDER BY sort", [kind]);
  return all.filter(m => kind === 'deposit' ? true : true);
}

router.get('/wallet', requireLogin, async (req, res) => {
  const wallets = await getBalances(req.db, req.user.id);
  const depositMethods = await req.db.query("SELECT id, name, rail, min_amount, max_amount, currency FROM payment_methods WHERE enabled = 1 AND kind IN ('deposit','both') ORDER BY sort");
  const withdrawMethods = await req.db.query("SELECT id, name, rail, min_amount, max_amount, currency FROM payment_methods WHERE enabled = 1 AND kind IN ('withdrawal','both') ORDER BY sort");
  const deps = await req.db.query('SELECT public_id, amount, currency, status, created_at FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [req.user.id]);
  const wds = await req.db.query('SELECT public_id, amount, currency, status, created_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [req.user.id]);
  const pending = [
    ...deps.map(d => ({ ...d, kind: 'deposit' })),
    ...wds.map(d => ({ ...d, kind: 'withdrawal' })),
  ].sort((a, b) => b.created_at - a.created_at);
  res.render('wallet', { metaTitle: 'Wallet', metaDesc: 'Your balances, deposits and withdrawals.', wallets, depositMethods, withdrawMethods, pending });
});

function methodCustomFields(method) {
  let custom = [];
  try { custom = JSON.parse(method.custom_fields || '[]'); } catch {}
  const rail = getRail(method.rail);
  const railFields = rail ? (rail.userFields || []) : [];
  return [...custom, ...railFields];
}

router.get('/deposit/new', requireLogin, async (req, res) => {
  const policy = depositPolicy(req.settings, req.user);
  if (!policy.allowed) return res.status(403).render('error', { status: 403, message: policy.reason });
  const methods = await req.db.query("SELECT * FROM payment_methods WHERE enabled = 1 AND kind IN ('deposit','both') ORDER BY sort");
  if (!methods.length) return res.render('deposit_new', { metaTitle: 'Deposit', metaDesc: '', methods: [], method: null, noMethods: true });
  const method = methods.find(m => m.id === parseInt(req.query.m, 10)) || methods[0];
  res.render('deposit_new', {
    metaTitle: 'Deposit', metaDesc: '', methods,
    method: { ...method, custom_fields: methodCustomFields(method) },
  });
});

router.post('/deposit/new', requireLogin, async (req, res) => {
  const policy = depositPolicy(req.settings, req.user);
  if (!policy.allowed) return res.status(403).render('error', { status: 403, message: policy.reason });
  const method = await req.db.get("SELECT * FROM payment_methods WHERE id = ? AND enabled = 1 AND kind IN ('deposit','both')", [req.body.method_id]);
  if (!method) return res.status(400).render('error', { status: 400, message: 'Invalid deposit method.' });
  const amount = toMinor(req.body.amount);
  if (amount === null || amount <= 0) return res.status(400).render('error', { status: 400, message: 'Enter a valid amount.' });
  if (method.min_amount && amount < method.min_amount) return res.status(400).render('error', { status: 400, message: 'Amount is below the minimum for this method.' });
  if (method.max_amount && amount > method.max_amount) return res.status(400).render('error', { status: 400, message: 'Amount exceeds the maximum for this method.' });
  const userData = {};
  for (const f of methodCustomFields(method)) {
    const v = String(req.body['custom_' + f.key] || '').trim();
    if (f.required && !v) return res.status(400).render('error', { status: 400, message: `Field "${f.label}" is required.` });
    userData[f.key] = v;
  }
  try {
    const { publicId } = await createDeposit(req.db, { userId: req.user.id, method, amountMinor: amount, userData });
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'player', action: 'deposit.create', entity: 'deposit', entityId: publicId, detail: { amount, method: method.name }, ip: req.ip });
    // NO auto-approve: a deposit is credited ONLY by a verified provider
    // webhook or an admin approving against a bank statement entry. The old
    // code approved small "auto" deposits with zero payment verification —
    // free money for anyone who submitted a request.
    await req.setFlash('success', 'Deposit request submitted. It will be credited after review.');
    res.redirect('/wallet');
  } catch (e) {
    res.status(400).render('error', { status: 400, message: 'Deposit failed: ' + e.message });
  }
});

router.get('/withdraw/new', requireLogin, async (req, res) => {
  const policy = withdrawalPolicy(req.settings, req.user);
  if (!policy.allowed) return res.status(403).render('error', { status: 403, message: policy.reason });
  let methods = await req.db.query("SELECT * FROM payment_methods WHERE enabled = 1 AND kind IN ('withdrawal','both') ORDER BY sort");
  if (!methods.length) return res.render('withdraw_new', { metaTitle: 'Withdraw', metaDesc: '', methods: [], method: null, balance: 0, noMethods: true });
  // Same-method preference (v14): when withdrawal_same_method is ON, only
  // methods the player has deposited with are offered; otherwise
  // deposit-used methods are simply listed first (preference, not a rule).
  const used = await req.db.query("SELECT DISTINCT method_id FROM deposits WHERE user_id = ? AND status = 'approved'", [req.user.id]);
  const usedIds = new Set(used.map(u => u.method_id));
  if (getBool(req.settings, 'withdrawal_same_method', false)) {
    methods = methods.filter(m => usedIds.has(m.id));
    if (!methods.length) return res.render('withdraw_new', { metaTitle: 'Withdraw', metaDesc: '', methods: [], method: null, balance: 0, noMethods: true, noMethodsReason: 'Withdrawals are restricted to payment methods you have deposited with. Deposit first, then withdraw to the same method.' });
  } else {
    methods.sort((a, b) => (usedIds.has(b.id) ? 1 : 0) - (usedIds.has(a.id) ? 1 : 0) || (a.sort - b.sort));
  }
  const method = methods.find(m => m.id === parseInt(req.query.m, 10)) || methods[0];
  const wallets = await getBalances(req.db, req.user.id);
  const balance = (wallets.find(w => w.currency === method.currency) || { balance: 0 }).balance;
  res.render('withdraw_new', {
    metaTitle: 'Withdraw', metaDesc: '', methods,
    method: { ...method, custom_fields: methodCustomFields(method) }, balance,
  });
});

router.post('/withdraw/new', requireLogin, async (req, res) => {
  const policy = withdrawalPolicy(req.settings, req.user);
  if (!policy.allowed) return res.status(403).render('error', { status: 403, message: policy.reason });
  const method = await req.db.get("SELECT * FROM payment_methods WHERE id = ? AND enabled = 1 AND kind IN ('withdrawal','both')", [req.body.method_id]);
  if (!method) return res.status(400).render('error', { status: 400, message: 'Invalid withdrawal method.' });
  const amount = toMinor(req.body.amount);
  if (amount === null || amount <= 0) return res.status(400).render('error', { status: 400, message: 'Enter a valid amount.' });
  if (method.min_amount && amount < method.min_amount) return res.status(400).render('error', { status: 400, message: 'Amount is below the minimum for this method.' });
  if (method.max_amount && amount > method.max_amount) return res.status(400).render('error', { status: 400, message: 'Amount exceeds the maximum for this method.' });
  const userData = {};
  for (const f of methodCustomFields(method)) {
    const v = String(req.body['custom_' + f.key] || '').trim();
    if (f.required && !v) return res.status(400).render('error', { status: 400, message: `Field "${f.label}" is required.` });
    userData[f.key] = v;
  }
  // v14 withdrawal rules (turnover, caps, payout lock, same-method) — checked
  // BEFORE the OTP step so a blocked withdrawal never sends a code.
  const ruleCheck = await checkWithdrawalRules(req.db, req.settings, req.user, method, amount, userData);
  if (!ruleCheck.ok) {
    if (ruleCheck.changeDetected) await notePayoutDetails(req.db, req.user.id, ruleCheck.fingerprint, true);
    return res.status(400).render('error', { status: 400, message: ruleCheck.reason });
  }
  // Withdrawal OTP (admin toggle `withdrawal_otp_enabled`, ON by default):
  // OTP is used ONLY here — never on login/register. When ON, the withdrawal is
  // held as pending until the player verifies a one-time code sent to their email/phone.
  if (getBool(req.settings, 'withdrawal_otp_enabled', true)) {
    const otpLib = require('../lib/otp');
    const channel = req.user.email ? 'email' : 'phone';
    const identifier = channel === 'email' ? req.user.email : req.user.phone;
    if (!identifier) return res.status(400).render('error', { status: 400, message: 'Add an email or phone to your profile before withdrawing.' });
    let code;
    try {
      code = await otpLib.createOtp(req.db, identifier, channel);
    } catch (e) {
      return res.status(429).render('error', { status: 429, message: e.message });
    }
    const sent = await otpLib.sendOtp(req.db, req.settings, identifier, channel, code);
    // Fail closed: if the code could not be delivered, do NOT park the user
    // on a verify screen for a code that will never arrive.
    if (!sent.sent) return res.status(503).render('error', { status: 503, message: 'Could not send the verification code. Please try again later or contact support.' });
    const { touchSession } = require('../lib/auth');
    await touchSession(req.db, req.sess.id, { pending_withdrawal: { method_id: method.id, amount, userData } });
    return res.render('withdraw_verify', {
      metaTitle: 'Verify Withdrawal', metaDesc: '',
      methodName: method.name, amount, currency: method.currency, channel, identifier,
    });
  }
  try {
    const { publicId } = await createWithdrawal(req.db, { userId: req.user.id, method, amountMinor: amount, userData });
    await notePayoutDetails(req.db, req.user.id, ruleCheck.fingerprint, false);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'player', action: 'withdrawal.create', entity: 'withdrawal', entityId: publicId, detail: { amount, method: method.name }, ip: req.ip });
    await req.setFlash('success', 'Withdrawal request submitted and amount held. It will be processed after review.');
    res.redirect('/wallet');
  } catch (e) {
    res.status(400).render('error', { status: 400, message: 'Withdrawal failed: ' + e.message });
  }
});

/* Withdrawal OTP verification (second step when `withdrawal_otp_enabled` is ON) */
router.post('/withdraw/verify', requireLogin, async (req, res) => {
  const pending = req.sessionData.pending_withdrawal;
  if (!pending) return res.status(400).render('error', { status: 400, message: 'No pending withdrawal. Please start again.' });
  const otpLib = require('../lib/otp');
  const channel = req.user.email ? 'email' : 'phone';
  const identifier = channel === 'email' ? req.user.email : req.user.phone;
  const v = await otpLib.verifyOtp(req.db, identifier, channel, String(req.body.code || '').trim());
  if (!v.ok) return res.status(400).render('error', { status: 400, message: 'Withdrawal verification failed: ' + v.error });
  const method = await req.db.get("SELECT * FROM payment_methods WHERE id = ? AND enabled = 1 AND kind IN ('withdrawal','both')", [pending.method_id]);
  if (!method) return res.status(400).render('error', { status: 400, message: 'Withdrawal method no longer available.' });
  // Re-check v14 rules: state may have changed since the OTP was requested
  // (e.g. a payout-detail change started a lock in the meantime).
  const ruleCheck2 = await checkWithdrawalRules(req.db, req.settings, req.user, method, pending.amount, pending.userData);
  if (!ruleCheck2.ok) {
    if (ruleCheck2.changeDetected) await notePayoutDetails(req.db, req.user.id, ruleCheck2.fingerprint, true);
    const { touchSession: ts2 } = require('../lib/auth');
    await ts2(req.db, req.sess.id, { pending_withdrawal: null });
    return res.status(400).render('error', { status: 400, message: ruleCheck2.reason });
  }
  const { touchSession } = require('../lib/auth');
  await touchSession(req.db, req.sess.id, { pending_withdrawal: null });
  try {
    const { publicId } = await createWithdrawal(req.db, { userId: req.user.id, method, amountMinor: pending.amount, userData: pending.userData });
    await notePayoutDetails(req.db, req.user.id, ruleCheck2.fingerprint, false);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'player', action: 'withdrawal.create', entity: 'withdrawal', entityId: publicId, detail: { amount: pending.amount, method: method.name, otp_verified: true }, ip: req.ip });
    await req.setFlash('success', 'Withdrawal verified and submitted. Amount held — it will be processed after review.');
    res.redirect('/wallet');
  } catch (e) {
    res.status(400).render('error', { status: 400, message: 'Withdrawal failed: ' + e.message });
  }
});

/* ---------------- transactions ---------------- */
router.get('/transactions', requireLogin, async (req, res) => {
  const type = req.query.type || 'all';
  let sql = 'SELECT * FROM transactions WHERE user_id = ?';
  const params = [req.user.id];
  if (type === 'credit') sql += ' AND amount > 0';
  else if (type === 'debit') sql += ' AND amount < 0';
  sql += ' ORDER BY created_at DESC LIMIT 200';
  const txs = await req.db.query(sql, params);
  res.render('transactions', { metaTitle: 'Transactions', metaDesc: '', txs, filterType: type });
});

/* ---------------- profile ---------------- */
router.get('/profile', requireLogin, async (req, res) => {
  res.render('profile', { metaTitle: 'Profile', metaDesc: '', verifyPhone: req.query.verify_phone === '1' });
});
router.post('/profile', requireLogin, async (req, res) => {
  const { name, phone, country } = req.body;
  if (!name || name.trim().length < 2) { await req.setFlash('error', 'Name is required.'); return res.redirect('/profile'); }
  await req.db.run('UPDATE users SET name = ?, phone = ?, country = ? WHERE id = ?',
    [name.trim(), String(phone || '').trim().slice(0, 32), String(country || '').trim().slice(0, 64), req.user.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'user.profile_update', entity: 'user', entityId: req.user.id, detail: {}, ip: req.ip });
  await req.setFlash('success', 'Profile updated.');
  res.redirect('/profile');
});

/* ---------------- contact verification (v14) ---------------- */
// Email link + phone OTP verification mark email_verified / mobile_verified,
// which the deposit/withdrawal gate reads. Admins can also mark a contact
// verified from the user page (audited) when no provider is configured.
router.post('/profile/verify-email', requireLogin, async (req, res) => {
  const email = req.user.email;
  if (!email || email.endsWith('@phone.local')) { await req.setFlash('error', 'Add a real email to your profile first.'); return res.redirect('/profile'); }
  const token = randHex(24);
  await req.db.run('INSERT INTO email_verifications (user_id, new_email, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    [req.user.id, email, sha256('verify:' + token), now() + 24 * 3600 * 1000, now()]);
  const link = (process.env.BASE_URL || (req.protocol + '://' + req.get('host'))) + '/verify-email/' + token;
  const sent = await notify.send(req.db, req.settings, 'email', 'email_verification', email, { name: req.user.name, link });
  if (sent.status === 'sent') await req.setFlash('success', 'Verification link sent to ' + email + '.');
  else await req.setFlash('error', 'Could not send the verification email (no email provider configured). Ask support to mark your contact verified.');
  res.redirect('/profile');
});
router.post('/profile/verify-phone', requireLogin, async (req, res) => {
  const phone = req.user.phone;
  if (!phone) { await req.setFlash('error', 'Add a phone number to your profile first.'); return res.redirect('/profile'); }
  const otpLib = require('../lib/otp');
  let code;
  try { code = await otpLib.createOtp(req.db, phone, 'phone'); } catch (e) { await req.setFlash('error', e.message); return res.redirect('/profile'); }
  const sent = await otpLib.sendOtp(req.db, req.settings, phone, 'phone', code);
  if (!sent.sent) { await req.setFlash('error', 'Could not send the verification code. Try again later.'); return res.redirect('/profile'); }
  await req.setFlash('success', 'Verification code sent to ' + phone + '. Enter it below.');
  res.redirect('/profile?verify_phone=1');
});
router.post('/profile/verify-phone/confirm', requireLogin, async (req, res) => {
  const otpLib = require('../lib/otp');
  const v = await otpLib.verifyOtp(req.db, req.user.phone, 'phone', String(req.body.code || '').trim());
  if (!v.ok) { await req.setFlash('error', 'Phone verification failed: ' + v.error); return res.redirect('/profile?verify_phone=1'); }
  await req.db.run('UPDATE users SET mobile_verified = 1 WHERE id = ?', [req.user.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'player', action: 'user.phone_verified', entity: 'user', entityId: req.user.id, detail: {}, ip: req.ip });
  await req.setFlash('success', 'Phone verified.');
  res.redirect('/profile');
});

/* ---------------- forced password reset (v14) ---------------- */
// Agents created by an admin (or flagged by one) must set their own password
// before doing anything else. The server flag-gate redirects every other
// route here until the flag is cleared.
router.get('/force-reset', requireLogin, async (req, res) => {
  const u = await req.db.get('SELECT force_password_reset FROM users WHERE id = ?', [req.user.id]);
  if (!u || !u.force_password_reset) return res.redirect('/');
  res.render('force_reset', { metaTitle: 'Set Your Password', metaDesc: '' });
});
router.post('/force-reset', requireLogin, async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!u || !u.force_password_reset) return res.redirect('/');
  const { passwordError } = require('../lib/validate');
  const { isBreached } = require('../lib/breached');
  const pwErr = passwordError(req.body.password, u.role, getBool(req.settings, 'secure_password', true));
  if (pwErr || req.body.password !== req.body.password2) {
    return res.render('force_reset', { metaTitle: 'Set Your Password', metaDesc: '', formError: pwErr || 'Passwords do not match.' });
  }
  if (getBool(req.settings, 'breached_password_check', true) && await isBreached(req.body.password)) {
    return res.render('force_reset', { metaTitle: 'Set Your Password', metaDesc: '', formError: 'This password has appeared in a data breach. Please choose a different one.' });
  }
  await req.db.run('UPDATE users SET password_hash = ?, force_password_reset = 0 WHERE id = ?', [hashPassword(req.body.password), req.user.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: u.role, action: 'user.forced_reset_done', entity: 'user', entityId: req.user.id, detail: {}, ip: req.ip });
  // Kill every OTHER session (in case the temporary password leaked) but keep
  // this one: the user just proved control of it by setting the password.
  await destroyUserSessions(req.db, req.user.id, req.sess ? req.sess.id : null);
  await req.setFlash('success', 'Password set. You can continue now.');
  res.redirect(u.role === 'agent' ? '/agent' : '/');
});

/* ---------------- security / TOTP 2FA ---------------- */
router.get('/security', requireLogin, async (req, res) => {
  const u = await req.db.get('SELECT totp_secret FROM users WHERE id = ?', [req.user.id]);
  res.render('security', {
    metaTitle: 'Security', metaDesc: '',
    totpEnabled: !!u.totp_secret, showSetup: false, showBackup: false,
  });
});
router.post('/security/totp/start', requireLogin, async (req, res) => {
  const secret = newTotpSecret();
  const { touchSession } = require('../lib/auth');
  await touchSession(req.db, req.sess.id, { totp_pending: secret });
  const uri = totpUri(secret, req.user.email, getS(req.settings, 'site_name', 'Cash Pop'));
  const qrDataUrl = await QRCode.toDataURL(uri);
  res.render('security', { metaTitle: 'Security', metaDesc: '', totpEnabled: false, showSetup: true, setup: { qrDataUrl, secret }, showBackup: false });
});
router.post('/security/totp/confirm', requireLogin, async (req, res) => {
  const secret = req.sessionData.totp_pending;
  if (!secret) { await req.setFlash('error', 'Setup session expired. Start again.'); return res.redirect('/security'); }
  if (!verifyTotp(secret, req.body.totp_code)) {
    const uri = totpUri(secret, req.user.email, getS(req.settings, 'site_name', 'Cash Pop'));
    const qrDataUrl = await QRCode.toDataURL(uri);
    return res.render('security', { metaTitle: 'Security', metaDesc: '', totpEnabled: false, showSetup: true, setup: { qrDataUrl, secret }, showBackup: false, formError: 'Invalid code. Try again.' });
  }
  const codes = newBackupCodes(8);
  await req.db.run('UPDATE users SET totp_secret = ?, backup_codes = ? WHERE id = ?', [secret, hashBackupCodes(codes), req.user.id]);
  const { touchSession } = require('../lib/auth');
  await touchSession(req.db, req.sess.id, { totp_pending: null });
  await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'user.totp_enable', entity: 'user', entityId: req.user.id, detail: {}, ip: req.ip });
  res.render('security', { metaTitle: 'Security', metaDesc: '', totpEnabled: true, showSetup: false, showBackup: true, backupCodes: codes });
});
router.post('/security/totp/disable', requireLogin, async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!verifyPassword(req.body.password || '', u.password_hash || '')) { await req.setFlash('error', 'Wrong password.'); return res.redirect('/security'); }
  await req.db.run("UPDATE users SET totp_secret = '', backup_codes = '[]' WHERE id = ?", [req.user.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'user.totp_disable', entity: 'user', entityId: req.user.id, detail: {}, ip: req.ip });
  await req.setFlash('success', 'Two-factor authentication disabled.');
  res.redirect('/security');
});
router.post('/security/totp/backup', requireLogin, async (req, res) => {
  const codes = newBackupCodes(8);
  await req.db.run('UPDATE users SET backup_codes = ? WHERE id = ?', [hashBackupCodes(codes), req.user.id]);
  res.render('security', { metaTitle: 'Security', metaDesc: '', totpEnabled: true, showSetup: false, showBackup: true, backupCodes: codes });
});
router.post('/security/sessions/revoke', requireLogin, async (req, res) => {
  await destroyUserSessions(req.db, req.user.id, req.sess.id);
  await req.setFlash('success', 'All other sessions signed out.');
  res.redirect('/security');
});

/* ---------------- support tickets ---------------- */
router.get('/support', requireLogin, async (req, res) => {
  const stickets = await req.db.query('SELECT * FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC', [req.user.id]);
  res.render('support', { metaTitle: 'Support', metaDesc: 'Contact support.', stickets });
});
router.post('/support/new', requireLogin, async (req, res) => {
  const { subject, message } = req.body;
  if (!subject || !message) { await req.setFlash('error', 'Subject and message are required.'); return res.redirect('/support'); }
  const publicId = 'S' + now().toString(36).toUpperCase() + randHex(3).toUpperCase();
  const t = now();
  const prio = ['low', 'medium', 'high'].includes(String(req.body.priority || '')) ? String(req.body.priority) : 'medium';
  const r = await req.db.run('INSERT INTO support_tickets (public_id, user_id, subject, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [publicId, req.user.id, subject.trim().slice(0, 255), 'open', prio, t, t]);
  await req.db.run('INSERT INTO support_messages (ticket_id, author_id, author_role, body, created_at) VALUES (?, ?, ?, ?, ?)',
    [r.id, req.user.id, req.user.role, message.trim().slice(0, 5000), t]);
  res.redirect('/support/' + publicId);
});
router.get('/support/:publicId', requireLogin, async (req, res) => {
  const ticket = await req.db.get('SELECT * FROM support_tickets WHERE public_id = ? AND user_id = ?', [req.params.publicId, req.user.id]);
  if (!ticket) return res.status(404).render('error', { status: 404, message: 'Ticket not found.' });
  const messages = await req.db.query('SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY created_at', [ticket.id]);
  res.render('support_view', {
    metaTitle: 'Support', metaDesc: '', ticket,
    messages: messages.map(m => ({ ...m, mine: m.author_id === req.user.id })),
  });
});
router.post('/support/:publicId/reply', requireLogin, async (req, res) => {
  const ticket = await req.db.get('SELECT * FROM support_tickets WHERE public_id = ? AND user_id = ?', [req.params.publicId, req.user.id]);
  if (!ticket || ticket.status === 'closed') return res.redirect('/support');
  const body = String(req.body.message || '').trim().slice(0, 5000);
  if (!body) return res.redirect('/support/' + ticket.public_id);
  await req.db.run('INSERT INTO support_messages (ticket_id, author_id, author_role, body, created_at) VALUES (?, ?, ?, ?, ?)',
    [ticket.id, req.user.id, req.user.role, body, now()]);
  await req.db.run("UPDATE support_tickets SET status = 'open', updated_at = ? WHERE id = ?", [now(), ticket.id]);
  res.redirect('/support/' + ticket.public_id);
});

module.exports = router;
