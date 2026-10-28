'use strict';
/* Player site: playslip + ticket purchase (server-verified, HMAC-signed),
   tickets, wallet, deposits/withdrawals, transactions, profile, 2FA, support. */
const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { now, randHex, hmac, sha256, hashPassword, verifyPassword, toMinor, decimalsFor, esc, signTicket, normalizePhone, fmtMoney } = require('../lib/util');
const { getS, getBool, getCurrencies, getSettings } = require('../lib/settings');
const { requireLogin, rateLimit } = require('../lib/auth');
const { getBalances, postLedger, depositPolicy, withdrawalPolicy, chargeFor, createDeposit, createWithdrawal, checkWithdrawalRules, notePayoutDetails, notePendingPayoutChange, promotePayoutDetails, releaseReferralCredits, maybeAutoApproveWithdrawal } = require('../lib/money');
const kycLib = require('../lib/kyc');
const uploadLib = require('../lib/upload');
const { getRail, getReceivingDetails } = require('../lib/rails');
const { newTotpSecret, totpUri, verifyTotp, verifyTotpStep, newBackupCodes, hashBackupCodes, useBackupCode, destroyUserSessions } = require('../lib/auth');
const notify = require('../lib/notify');
const audit = require('../lib/audit');

const baseCurrency = (req) => getS(req.settings, 'base_currency', 'USD');

/* BP-22: after a withdrawal is created, give the system its chance to
   auto-approve it under the operator's limit (lib/money decides; any
   gate biting leaves it pending for manual review). On success the
   player gets the same 'withdrawal_decided' email a manual approval
   sends. Returns true when auto-approved. */
async function tryAutoApprove(req, publicId) {
  try {
    const r = await maybeAutoApproveWithdrawal(req.db, req.settings, publicId);
    if (!r.auto) return false;
    const w = await req.db.get('SELECT * FROM withdrawals WHERE public_id = ?', [publicId]);
    if (w && req.user.email && !String(req.user.email).endsWith('@phone.local')) {
      notify.send(req.db, req.settings, 'email', 'withdrawal_decided', req.user.email, { name: req.user.name, amount: fmtMoney(w.net !== null && w.net !== undefined ? w.net : w.amount, w.currency, getCurrencies(req.settings)), status: 'approved' }).catch(() => {});
    }
    return true;
  } catch { return false; }
}

/* ---------------- playslip ---------------- */
router.get('/play', requireLogin, async (req, res) => {
  const wagerOptions = req.wagerOptions;
  const prizeTable = await req.db.query('SELECT pops_count, multiplier FROM prize_table ORDER BY pops_count');
  const wallets = await getBalances(req.db, req.user.id);
  // R-071: the playslip offers every FUNDED wallet, not only the base
  // wallet — a EUR-funded player used to see $0.00 and could not play.
  const funded = wallets.filter(w => Number(w.balance) > 0).map(w => w.currency);
  const sel = funded.includes(String(req.query.currency || '').toUpperCase()) ? String(req.query.currency).toUpperCase() : (funded[0] || baseCurrency(req));
  const bal = (wallets.find(w => w.currency === sel) || { balance: 0 }).balance;
  res.render('play', {
    metaTitle: 'Play', metaDesc: 'Pick your pops and buy a Cash Pop ticket.',
    wagerOptions, prizeTable, maxDraws: parseInt(getS(req.settings, 'max_draws', '7'), 10) || 7, balance: bal,
    wallets, playCurrency: sel,
  });
});

router.post('/play/buy', requireLogin, rateLimit({ windowMs: 60000, max: 10, keyFn: req => `lottery-buy:${req.user.id}` }), async (req, res) => { // R-073: buy rate limit mirroring scratch
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
    const { enforceAccountPlayable, responsibleStatus } = require('../lib/scratch');
    await enforceAccountPlayable(req.db, req.user.id);
    // R-024: session_limit_minutes is now enforced (session start = the
    // login session's created_at) instead of being a dead saved setting.
    const rp = await responsibleStatus(req.db, req.user.id);
    const lim = Number(rp.session_limit_minutes || 0);
    if (lim > 0 && req.sess && req.sess.created_at && (now() - Number(req.sess.created_at)) > lim * 60000)
      return fail('Your session limit has been reached. Please sign out and take a break before playing again.');
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
  // Multi-draw bundle discount: keyed on the number of draws the player
  // SELECTED (numDraws) - the same number the playslip shows. DS-023: the
  // old code keyed on drawIds.length (entry count), so "5 x Both" (10
  // entries) silently got NO discount while "5 x Day" got 12% off.
  let bundleDiscount = 0;
  const bundles = String(getS(req.settings, 'multi_draw_discounts', '') || '').split(',')
    .map(x => x.trim().split(':').map(Number)).filter(([n, pc]) => n > 0 && pc > 0 && pc < 100);
  const bundle = bundles.find(([n]) => n === numDraws);
  if (bundle) { bundleDiscount = bundle[1]; total = Math.round(total * (100 - bundleDiscount) / 100); }
  // R-071: buy in the requested currency when the player holds it (or
  // when it is a configured currency); otherwise the base currency.
  const reqCur = String(req.body.currency || '').toUpperCase();
  const currency = (reqCur && getCurrencies(req.settings).some(c => c.code === reqCur)) ? reqCur : baseCurrency(req);

  try {
    const publicId = 'T' + now().toString(36).toUpperCase() + randHex(4).toUpperCase();
    const secret = process.env.TICKET_HMAC_SECRET;
    if (!secret) throw new Error('TICKET_HMAC_SECRET is not configured');
    const ticket = {
      public_id: publicId, user_id: req.user.id, pops: JSON.stringify(pops),
      wager, draw_ids: JSON.stringify(drawIds), total, currency,
    };
    ticket.hmac = signTicket(secret, ticket);
    const ticketId = await req.db.transaction(async (tx) => {
      // v16: the draws were selected OUTSIDE this transaction. If the cron
      // settled one in between, entries inserted for it would sit 'pending'
      // forever on an already-settled draw — money taken, no outcome, no
      // re-settle. Re-check inside the txn: any non-scheduled draw fails
      // the whole purchase cleanly (the debit rolls back with it).
      for (const did of drawIds) {
        // R-072: re-check close_at INSIDE the txn, not just status — buys
        // used to succeed for up to ~60 min after close (hourly settle).
        const d = await tx.get("SELECT status, close_at FROM draws WHERE id = ?", [did]);
        if (!d || d.status !== 'scheduled' || Number(d.close_at) <= now()) throw new Error('A selected draw just closed — please buy again for the next draws.');
      }
      // R-073: per-draw per-player stake cap (setting, minor units, 0 = off),
      // enforced inside the txn alongside the loss limit.
      const stakeCap = parseInt(getS(settings, 'per_draw_stake_cap', '0'), 10) || 0;
      if (stakeCap > 0) {
        // DS-024: compare PER-DRAW shares. A ticket's stake on one draw is
        // total / its entry count. The old code summed FULL multi-draw
        // totals (once per overlapping selected draw), so ordinary small
        // buys were refused far below the real cap.
        const candShare = total / drawIds.length;
        for (const did of drawIds) {
          const staked = await tx.get("SELECT COALESCE(SUM(t.total * 1.0 / (SELECT COUNT(*) FROM ticket_entries te2 WHERE te2.ticket_id = t.id)),0) AS s FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id WHERE te.draw_id = ? AND t.user_id = ?", [did, req.user.id]);
          if (Number(staked.s) + candShare > stakeCap) throw new Error('This purchase would exceed your per-draw stake cap.');
        }
      }
      // Daily loss limit also applies to lottery buys (previously scratch
      // only). Checked inside the transaction so check + debit are atomic.
      const { enforceLotteryLossLimit } = require('../lib/scratch');
      await enforceLotteryLossLimit(tx, req.user.id, total, currency);
      // atomic debit
      await postLedger(tx, { userId: req.user.id, currency, type: 'ticket_purchase', amount: -total, refType: 'ticket', refId: publicId, meta: { pops, wager, draws: drawIds.length, bundle_discount: bundleDiscount } });
      req._bonusAccrue = (req._bonusAccrue || 0) + total;
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
          // R-124: banned/pending_review referrers do not accrue.
          const ref = await tx.get('SELECT status FROM users WHERE id = ?', [buyer.referred_by]);
          const comm = Math.round(total * rate / 100);
          if (ref && ref.status === 'active' && comm > 0) await tx.run('INSERT INTO referral_credits (referrer_id, referee_id, ticket_id, currency, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [buyer.referred_by, req.user.id, r.id, currency, comm, 'pending', now()]);
          else if (ref && ref.status !== 'active') await audit.log(tx, { actorId: req.user.id, actorRole: 'player', action: 'referral.skipped_inactive', entity: 'user', entityId: buyer.referred_by, detail: { status: ref.status }, ip: req.ip });
        }
      }
      // agent commission on purchase
      if (req.user.agent_id) {
        const rate = parseFloat(getS(settings, 'commission_rate', '5')) || 0;
        if (rate > 0) {
          const ag = await tx.get('SELECT status FROM users WHERE id = ?', [req.user.agent_id]);
          if (ag && ag.status === 'active') {
            const amt = Math.round(total * rate / 100);
            await tx.run('INSERT INTO commissions (agent_id, user_id, ticket_id, currency, amount, rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
              [req.user.agent_id, req.user.id, r.id, currency, amt, rate, now()]);
          } else if (ag && ag.status !== 'active') await audit.log(tx, { actorId: req.user.id, actorRole: 'player', action: 'commission.skipped_inactive', entity: 'user', entityId: req.user.agent_id, detail: { status: ag.status }, ip: req.ip });
        }
      }
      return r.id;
    });
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'player', action: 'ticket.buy', entity: 'ticket', entityId: publicId, detail: { pops, wager, drawType, numDraws, total }, ip: req.ip });
    // This purchase counts as wagering: release any pending referral credits
    // whose referee conditions are now met. Best-effort — a failure leaves
    // rows pending for the next trigger (deposit approval or next buy).
    try { await releaseReferralCredits(req.db, req.user.id, req.settings); } catch (e) { console.error('referral release failed:', e.message); }
    // SMART-ADMIN: this purchase counts toward bonus wagering progress, and
    // it may be the purchase that reaches a draw's entry threshold - the
    // threshold engine fires the draw immediately (provably-fair settle,
    // identical derivation to a time settle). Both best-effort.
    try { if (req._bonusAccrue) await require('../lib/bonus').accrueWagering(req.db, req.user.id, currency, req._bonusAccrue); } catch {}
    try { await require('../lib/draws').checkThresholdDraws(req.db, req.settings); } catch (e) { console.error('threshold check failed:', e.message); }
    res.redirect('/ticket/' + publicId);
  } catch (e) {
    console.error('[play/buy] failed:', e.message); res.status(400).render('error', { status: 400, message: 'Purchase failed. Please try again or contact support.' });
  }
});

/* ---------------- tickets ---------------- */
router.get('/tickets', requireLogin, async (req, res) => {
  // DS-058: paginated (was a hard LIMIT 100 with no way to reach older tickets).
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const totalRow = await req.db.get('SELECT COUNT(*) AS c FROM tickets WHERE user_id = ?', [req.user.id]);
  const totalPages = Math.max(1, Math.ceil(Number(totalRow.c) / 25));
  const tickets = await req.db.query('SELECT * FROM tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 25 OFFSET ?', [req.user.id, (page - 1) * 25]);
  for (const t of tickets) {
    // CASE WHEN, not SUM(status = ?): SQLite/MySQL treat a comparison as
    // 1/0, but Postgres returns a boolean and sum(boolean) does not exist
    // (this 500'd /tickets on Postgres with error 42883).
    const c = await req.db.get('SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN status = ? THEN 1 ELSE 0 END),0) AS w FROM ticket_entries WHERE ticket_id = ?', ['won', t.id]);
    t.entry_count = c.n; t.won_count = c.w || 0;
    t.pops = JSON.parse(t.pops || '[]');
  }
  res.render('tickets', { metaTitle: 'My Tickets', metaDesc: '', tickets, page, totalPages });
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
  // DS-054: a brand-new player has no wallet rows yet - show a real $0.00
  // base-currency row instead of an empty Balances section.
  if (!wallets.length) wallets.push({ currency: baseCurrency(req), balance: 0 });
  const depositMethods = await req.db.query("SELECT id, name, rail, min_amount, max_amount, currency FROM payment_methods WHERE enabled = 1 AND kind IN ('deposit','both') ORDER BY sort");
  const withdrawMethods = await req.db.query("SELECT id, name, rail, min_amount, max_amount, currency FROM payment_methods WHERE enabled = 1 AND kind IN ('withdrawal','both') ORDER BY sort");
  // DS-051: this card is "Pending requests" - decided items do not belong.
  const deps = await req.db.query("SELECT public_id, amount, currency, status, created_at FROM deposits WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 10", [req.user.id]);
  const wds = await req.db.query("SELECT public_id, amount, currency, status, created_at FROM withdrawals WHERE user_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 10", [req.user.id]);
  const pending = [
    ...deps.map(d => ({ ...d, kind: 'deposit' })),
    ...wds.map(d => ({ ...d, kind: 'withdrawal' })),
  ].sort((a, b) => b.created_at - a.created_at);
  const kycW = kycLib.kycBlock(req.settings, req.user, 'withdraw');
  const kycD = kycLib.kycBlock(req.settings, req.user, 'deposit');
  const kycSt = kycLib.kycStatusOf(req.user);
  const kycNotice = (kycW.required || kycD.required || kycSt !== 'none')
    ? { status: kycSt, statusLabel: kycLib.STATUS_LABELS[kycSt], withdrawBlocked: kycW.blocked, depositBlocked: kycD.blocked, note: req.user.kyc_note || '' } : null;
  res.render('wallet', { metaTitle: 'Wallet', metaDesc: 'Your balances, deposits and withdrawals.', wallets, depositMethods, withdrawMethods, pending, kycNotice });
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
  // DS-008: self-exclusion/cooling-off blocks funding too, not just play.
  try { const { enforceAccountPlayable } = require('../lib/scratch'); await enforceAccountPlayable(req.db, req.user.id); }
  catch (e) { return res.status(403).render('error', { status: 403, message: 'Deposits are unavailable during your self-exclusion or cooling-off period.' }); }
  // BP-21: KYC gate (only bites when the operator's gate scope covers deposits).
  if (kycLib.kycBlock(req.settings, req.user, 'deposit').blocked) return res.status(403).render('error', { status: 403, message: kycLib.KYC_MESSAGES.deposit, cta: { href: '/kyc', label: 'Go to the KYC page' } });
  const methods = await req.db.query("SELECT * FROM payment_methods WHERE enabled = 1 AND kind IN ('deposit','both') ORDER BY sort");
  if (!methods.length) return res.render('deposit_new', { metaTitle: 'Deposit', metaDesc: '', methods: [], method: null, noMethods: true });
  const method = methods.find(m => m.id === parseInt(req.query.m, 10)) || methods[0];
  // DS-005: show the player WHERE to pay (receiving details from the
  // method's stored credentials - public payment addresses, never secrets).
  const receiving = await getReceivingDetails(req.db, method);
  res.render('deposit_new', {
    metaTitle: 'Deposit', metaDesc: '', methods, receiving,
    method: { ...method, custom_fields: methodCustomFields(method) },
    methodDec: decimalsFor(method.currency, req.currencies),
  });
});

router.post('/deposit/new', requireLogin, rateLimit({ windowMs: 60000, max: 10, keyFn: req => `deposit:${req.user.id}` }), async (req, res) => { // DS-050: pending-deposit spam cap
  const policy = depositPolicy(req.settings, req.user);
  if (!policy.allowed) return res.status(403).render('error', { status: 403, message: policy.reason });
  // DS-008: self-exclusion/cooling-off blocks funding too, not just play.
  try { const { enforceAccountPlayable } = require('../lib/scratch'); await enforceAccountPlayable(req.db, req.user.id); }
  catch (e) { return res.status(403).render('error', { status: 403, message: 'Deposits are unavailable during your self-exclusion or cooling-off period.' }); }
  // BP-21: KYC gate (only bites when the operator's gate scope covers deposits).
  if (kycLib.kycBlock(req.settings, req.user, 'deposit').blocked) return res.status(403).render('error', { status: 403, message: kycLib.KYC_MESSAGES.deposit, cta: { href: '/kyc', label: 'Go to the KYC page' } });
  const methodId = parseInt(req.body.method_id, 10);
  if (!methodId) return res.status(400).render('error', { status: 400, message: 'Invalid deposit method.' });
  const method = await req.db.get("SELECT * FROM payment_methods WHERE id = ? AND enabled = 1 AND kind IN ('deposit','both')", [methodId]);
  if (!method) return res.status(400).render('error', { status: 400, message: 'Invalid deposit method.' });
  const amount = toMinor(req.body.amount, decimalsFor(method.currency, getCurrencies(req.settings)));
  if (amount === null || amount <= 0) return res.status(400).render('error', { status: 400, message: 'Enter a valid amount.' });
  if (method.min_amount && amount < method.min_amount) return res.status(400).render('error', { status: 400, message: 'Amount is below the minimum for this method.' });
  if (method.max_amount && amount > method.max_amount) return res.status(400).render('error', { status: 400, message: 'Amount exceeds the maximum for this method.' });
  // DS-018: player-set daily deposit limit (per currency, UTC day; pending
  // and approved requests both count, so it cannot be split around).
  const rpRow = await req.db.get('SELECT daily_deposit_limit FROM responsible_play WHERE user_id = ?', [req.user.id]);
  const depLimit = rpRow ? Number(rpRow.daily_deposit_limit || 0) : 0;
  if (depLimit > 0) {
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const depRow = await req.db.get(`SELECT COALESCE(SUM(amount),0) AS s FROM deposits WHERE user_id = ? AND currency = ? AND status IN ('pending','approved') AND created_at >= ?`, [req.user.id, method.currency, dayStart.getTime()]);
    if (Number(depRow.s) + amount > depLimit) return res.status(400).render('error', { status: 400, message: 'That deposit would exceed your daily deposit limit.' });
  }
  const userData = {};
  for (const f of methodCustomFields(method)) {
    // R-116: per-field length cap (was unbounded up to the 2MB body limit).
    const v = String(req.body['custom_' + f.key] || '').trim().slice(0, 2000);
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
    console.error('[deposit] failed:', e.message); res.status(400).render('error', { status: 400, message: 'Deposit failed. Please try again or contact support.' });
  }
});

router.get('/withdraw/new', requireLogin, async (req, res) => {
  const policy = withdrawalPolicy(req.settings, req.user);
  if (!policy.allowed) return res.status(403).render('error', { status: 403, message: policy.reason });
  // BP-21: KYC gate — honest, specific message, never a generic error.
  if (kycLib.kycBlock(req.settings, req.user, 'withdraw').blocked) return res.status(403).render('error', { status: 403, message: kycLib.KYC_MESSAGES.withdraw, cta: { href: '/kyc', label: 'Go to the KYC page' } });
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
    methodDec: decimalsFor(method.currency, req.currencies),
  });
});

router.post('/withdraw/new', requireLogin, async (req, res) => {
  const policy = withdrawalPolicy(req.settings, req.user);
  if (!policy.allowed) return res.status(403).render('error', { status: 403, message: policy.reason });
  // BP-21: KYC gate — honest, specific message, never a generic error.
  if (kycLib.kycBlock(req.settings, req.user, 'withdraw').blocked) return res.status(403).render('error', { status: 403, message: kycLib.KYC_MESSAGES.withdraw, cta: { href: '/kyc', label: 'Go to the KYC page' } });
  const methodId = parseInt(req.body.method_id, 10);
  if (!methodId) return res.status(400).render('error', { status: 400, message: 'Invalid withdrawal method.' });
  const method = await req.db.get("SELECT * FROM payment_methods WHERE id = ? AND enabled = 1 AND kind IN ('withdrawal','both')", [methodId]);
  if (!method) return res.status(400).render('error', { status: 400, message: 'Invalid withdrawal method.' });
  const amount = toMinor(req.body.amount, decimalsFor(method.currency, getCurrencies(req.settings)));
  if (amount === null || amount <= 0) return res.status(400).render('error', { status: 400, message: 'Enter a valid amount.' });
  if (method.min_amount && amount < method.min_amount) return res.status(400).render('error', { status: 400, message: 'Amount is below the minimum for this method.' });
  if (method.max_amount && amount > method.max_amount) return res.status(400).render('error', { status: 400, message: 'Amount exceeds the maximum for this method.' });
  const userData = {};
  for (const f of methodCustomFields(method)) {
    // R-116: per-field length cap (was unbounded up to the 2MB body limit).
    const v = String(req.body['custom_' + f.key] || '').trim().slice(0, 2000);
    if (f.required && !v) return res.status(400).render('error', { status: 400, message: `Field "${f.label}" is required.` });
    userData[f.key] = v;
  }
  // v14 withdrawal rules (turnover, caps, payout lock, same-method) — checked
  // BEFORE the OTP step so a blocked withdrawal never sends a code.
  // R-114: balance check also happens BEFORE the OTP step, so a player
  // with insufficient balance is not sent a code for a doomed withdrawal.
  {
    const wallets0 = await getBalances(req.db, req.user.id);
    const bal0 = (wallets0.find(w => w.currency === method.currency) || { balance: 0 }).balance;
    if (Number(bal0) < amount) return res.status(400).render('error', { status: 400, message: 'Insufficient balance for this withdrawal.' });
  }
  const ruleCheck = await checkWithdrawalRules(req.db, req.settings, req.user, method, amount, userData);
  if (!ruleCheck.ok) {
    // RT-20: a blocked attempt records the change as PENDING - it must
    // never replace the active payout fingerprint or lock the original
    // details (the old code did both via notePayoutDetails(..., true)).
    if (ruleCheck.changeDetected) await notePendingPayoutChange(req.db, req.user.id, ruleCheck.fingerprint);
    return res.status(400).render('error', { status: 400, message: ruleCheck.reason });
  }
  // Withdrawal OTP (admin toggle `withdrawal_otp_enabled`, ON by default):
  // OTP is used ONLY here — never on login/register. When ON, the withdrawal is
  // held as pending until the player verifies a one-time code sent to their email/phone.
  if (getBool(req.settings, 'withdrawal_otp_enabled', true)) {
    const otpLib = require('../lib/otp');
    const realEmail = req.user.email && !String(req.user.email).endsWith('@phone.local') ? req.user.email : null;
    const channel = realEmail ? 'email' : 'phone';
    const identifier = channel === 'email' ? realEmail : req.user.phone;
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
    const { publicId } = await createWithdrawal(req.db, { userId: req.user.id, method, amountMinor: amount, userData, settings: req.settings, user: req.user });
    if (ruleCheck.promotePending) await promotePayoutDetails(req.db, req.user.id, ruleCheck.fingerprint);
    else await notePayoutDetails(req.db, req.user.id, ruleCheck.fingerprint, false);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'player', action: 'withdrawal.create', entity: 'withdrawal', entityId: publicId, detail: { amount, method: method.name }, ip: req.ip });
    const autoOk = await tryAutoApprove(req, publicId);
    await req.setFlash('success', autoOk
      ? 'Withdrawal submitted and approved. Your payout will be processed to your payment details.'
      : 'Withdrawal request submitted and amount held. It will be processed after review.');
    res.redirect('/wallet');
  } catch (e) {
    console.error('[withdraw] failed:', e.message); res.status(400).render('error', { status: 400, message: 'Withdrawal failed. Please try again or contact support.' });
  }
});

/* DS-055: resend the withdrawal code / cancel the pending withdrawal.
   Before this, an expired code stranded the player: the verify page had
   no resend and "Cancel" (a GET link) never cleared the pending state. */
router.post('/withdraw/verify/resend', requireLogin, async (req, res) => {
  const pending = req.sessionData.pending_withdrawal;
  if (!pending) return res.status(400).render('error', { status: 400, message: 'No pending withdrawal. Please start again.' });
  const method = await req.db.get("SELECT * FROM payment_methods WHERE id = ? AND enabled = 1 AND kind IN ('withdrawal','both')", [pending.method_id]);
  if (!method) return res.status(400).render('error', { status: 400, message: 'Withdrawal method no longer available.' });
  const otpLib = require('../lib/otp');
  const realEmail = req.user.email && !String(req.user.email).endsWith('@phone.local') ? req.user.email : null;
  const channel = realEmail ? 'email' : 'phone';
  const identifier = channel === 'email' ? realEmail : req.user.phone;
  if (!identifier) return res.status(400).render('error', { status: 400, message: 'Add an email or phone to your profile before withdrawing.' });
  let code;
  try { code = await otpLib.createOtp(req.db, identifier, channel); }
  catch (e) { return res.status(429).render('error', { status: 429, message: e.message }); }
  const sent = await otpLib.sendOtp(req.db, req.settings, identifier, channel, code);
  if (!sent.sent) return res.status(503).render('error', { status: 503, message: 'Could not send the verification code. Please try again later or contact support.' });
  await req.setFlash('success', 'A new verification code was sent.');
  return res.render('withdraw_verify', {
    metaTitle: 'Verify Withdrawal', metaDesc: '',
    methodName: method.name, amount: pending.amount, currency: method.currency, channel, identifier,
  });
});
router.post('/withdraw/verify/cancel', requireLogin, async (req, res) => {
  const { touchSession } = require('../lib/auth');
  await touchSession(req.db, req.sess.id, { pending_withdrawal: null });
  await req.setFlash('success', 'Withdrawal cancelled. No amount was held.');
  res.redirect('/wallet');
});

/* Withdrawal OTP verification (second step when `withdrawal_otp_enabled` is ON) */
router.post('/withdraw/verify', requireLogin, async (req, res) => {
  const pending = req.sessionData.pending_withdrawal;
  if (!pending) return res.status(400).render('error', { status: 400, message: 'No pending withdrawal. Please start again.' });
  const otpLib = require('../lib/otp');
  const realEmail = req.user.email && !String(req.user.email).endsWith('@phone.local') ? req.user.email : null;
  const channel = realEmail ? 'email' : 'phone';
  const identifier = channel === 'email' ? realEmail : req.user.phone;
  const v = await otpLib.verifyOtp(req.db, identifier, channel, String(req.body.code || '').trim());
  if (!v.ok) return res.status(400).render('error', { status: 400, message: 'Withdrawal verification failed: ' + v.error });
  const method = await req.db.get("SELECT * FROM payment_methods WHERE id = ? AND enabled = 1 AND kind IN ('withdrawal','both')", [pending.method_id]);
  if (!method) return res.status(400).render('error', { status: 400, message: 'Withdrawal method no longer available.' });
  // R-113: re-check the global/per-user withdrawal policy at OTP-verify,
  // not just at OTP-request (admin may have disabled withdrawals since).
  {
    const pol = withdrawalPolicy(req.settings, req.user);
    if (!pol.allowed) {
      const { touchSession: tsP } = require('../lib/auth');
      await tsP(req.db, req.sess.id, { pending_withdrawal: null });
      return res.status(400).render('error', { status: 400, message: pol.reason });
    }
    // BP-21: KYC re-check at verify time too (requirement may have been
    // switched on while the code was in flight).
    if (kycLib.kycBlock(req.settings, req.user, 'withdraw').blocked) {
      const { touchSession: tsK } = require('../lib/auth');
      await tsK(req.db, req.sess.id, { pending_withdrawal: null });
      return res.status(403).render('error', { status: 403, message: kycLib.KYC_MESSAGES.withdraw, cta: { href: '/kyc', label: 'Go to the KYC page' } });
    }
  }
  // Re-check v14 rules: state may have changed since the OTP was requested
  // (e.g. a payout-detail change started a lock in the meantime).
  const ruleCheck2 = await checkWithdrawalRules(req.db, req.settings, req.user, method, pending.amount, pending.userData);
  if (!ruleCheck2.ok) {
    if (ruleCheck2.changeDetected) await notePendingPayoutChange(req.db, req.user.id, ruleCheck2.fingerprint);
    const { touchSession: ts2 } = require('../lib/auth');
    await ts2(req.db, req.sess.id, { pending_withdrawal: null });
    return res.status(400).render('error', { status: 400, message: ruleCheck2.reason });
  }
  const { touchSession } = require('../lib/auth');
  await touchSession(req.db, req.sess.id, { pending_withdrawal: null });
  try {
    const { publicId } = await createWithdrawal(req.db, { userId: req.user.id, method, amountMinor: pending.amount, userData: pending.userData, settings: req.settings, user: req.user });
    if (ruleCheck2.promotePending) await promotePayoutDetails(req.db, req.user.id, ruleCheck2.fingerprint);
    else await notePayoutDetails(req.db, req.user.id, ruleCheck2.fingerprint, false);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'player', action: 'withdrawal.create', entity: 'withdrawal', entityId: publicId, detail: { amount: pending.amount, method: method.name, otp_verified: true }, ip: req.ip });
    const autoOk = await tryAutoApprove(req, publicId);
    await req.setFlash('success', autoOk
      ? 'Withdrawal verified and approved. Your payout will be processed to your payment details.'
      : 'Withdrawal verified and submitted. Amount held — it will be processed after review.');
    res.redirect('/wallet');
  } catch (e) {
    console.error('[withdraw] failed:', e.message); res.status(400).render('error', { status: 400, message: 'Withdrawal failed. Please try again or contact support.' });
  }
});

/* ---------------- KYC (BP-21) ----------------
   The switchable identity-verification module. Status lives on
   users.kyc_status (none/pending/verified/rejected); documents live in
   kyc_documents with files in a private store (lib/upload). */
router.get('/kyc', requireLogin, async (req, res) => {
  const fresh = await req.db.get('SELECT kyc_status, kyc_note, kyc_override FROM users WHERE id = ?', [req.user.id]);
  const u = { ...req.user, ...(fresh || {}) };
  const docs = await req.db.query('SELECT id, doc_type, original_name, size_bytes, status, review_note, created_at, reviewed_at FROM kyc_documents WHERE user_id = ? ORDER BY id DESC', [req.user.id]);
  res.render('kyc', {
    metaTitle: 'Identity Verification', metaDesc: '',
    kyc: {
      status: kycLib.kycStatusOf(u), statusLabel: kycLib.STATUS_LABELS[kycLib.kycStatusOf(u)], note: u.kyc_note || '',
      withdraw: kycLib.kycBlock(req.settings, u, 'withdraw'), deposit: kycLib.kycBlock(req.settings, u, 'deposit'),
    },
    docs, docTypes: kycLib.DOC_TYPES, docLabels: kycLib.DOC_TYPE_LABELS, statusLabels: kycLib.STATUS_LABELS,
  });
});
router.post('/kyc', requireLogin, rateLimit({ windowMs: 60000, max: 10, keyFn: req => `kyc-submit:${req.user.id}` }), async (req, res) => {
  // The scoped multipart parser in server.js fills req.body / req.kycFile.
  if (req.kycUploadError) { await req.setFlash('error', req.kycUploadError); return res.redirect('/kyc'); }
  const docType = String(req.body.doc_type || '');
  if (!kycLib.DOC_TYPES.includes(docType)) { await req.setFlash('error', 'Choose a document type: national ID, passport or driving licence.'); return res.redirect('/kyc'); }
  /* SCAN fix (B-03): one pending submission at a time — the form hides
     itself while a review is pending, and the server now enforces the
     same rule (a direct POST could otherwise stack unlimited 5 MB
     uploads on the private store). */
  const pendingDoc = await req.db.get("SELECT id FROM kyc_documents WHERE user_id = ? AND status = 'pending' LIMIT 1", [req.user.id]);
  if (pendingDoc) { await req.setFlash('error', 'You already have a document under review. Wait for that decision before submitting another.'); return res.redirect('/kyc'); }
  const v = uploadLib.validateUpload(req.kycFile);
  if (!v.ok) { await req.setFlash('error', v.error); return res.redirect('/kyc'); }
  const original = String(req.kycFile.filename || 'document').replace(/[\r\n"]/g, '').slice(0, 120) || 'document';
  const stored = uploadLib.storeUpload(req.kycFile.data, v.ext);
  const ins = await req.db.run("INSERT INTO kyc_documents (user_id, doc_type, stored_name, original_name, content_type, size_bytes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
    [req.user.id, docType, stored, original, uploadLib.CONTENT_TYPES[v.ext], req.kycFile.data.length, now()]);
  /* SCAN fix (A-08/B-03): a verified player submitting an additional
     document keeps their verified status — the new document queues for
     review without demoting them (and re-blocking their withdrawals). */
  await req.db.run("UPDATE users SET kyc_status = 'pending' WHERE id = ? AND kyc_status != 'verified'", [req.user.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'player', action: 'kyc.submit', entity: 'kyc_document', entityId: String(ins.id), detail: { doc_type: docType, size_bytes: req.kycFile.data.length }, ip: req.ip });
  await req.setFlash('success', 'Document submitted. Our team will review it — you can check the status on this page.');
  res.redirect('/kyc');
});
router.get('/kyc/document/:id', requireLogin, async (req, res) => {
  // Owner-only: a document id belonging to anyone else is a plain 404.
  const doc = await req.db.get('SELECT * FROM kyc_documents WHERE id = ? AND user_id = ?', [parseInt(req.params.id, 10) || 0, req.user.id]);
  if (!doc) return res.status(404).render('error', { status: 404, message: 'Document not found.' });
  const data = uploadLib.readStored(doc.stored_name);
  if (!data) return res.status(404).render('error', { status: 404, message: 'Document file not found.' });
  res.set('Content-Type', doc.content_type || 'application/octet-stream');
  res.set('Content-Disposition', 'inline; filename="kyc-document"');
  res.set('Cache-Control', 'private, no-store');
  res.send(data);
});

/* ---------------- transactions ---------------- */
router.get('/transactions', requireLogin, async (req, res) => {
  const type = req.query.type || 'all';
  /* SCAN fix (A-17): paginate like /tickets — the old silent LIMIT 200
     made older ledger entries (incl. old wins) unreachable in the UI. */
  const PER = 50;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  let where = ' WHERE user_id = ?';
  const params = [req.user.id];
  if (type === 'credit') where += ' AND amount > 0';
  else if (type === 'debit') where += ' AND amount < 0';
  const total = (await req.db.get('SELECT COUNT(*) AS c FROM transactions' + where, params)).c;
  const totalPages = Math.max(1, Math.ceil(total / PER));
  const txs = await req.db.query('SELECT * FROM transactions' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?', params.concat([PER, (page - 1) * PER]));
  res.render('transactions', { metaTitle: 'Transactions', metaDesc: '', txs, filterType: type, page, totalPages, total });
});

/* ---------------- profile ---------------- */
router.get('/profile', requireLogin, async (req, res) => {
  // DS-052: referral earnings were invisible to players (admin-only data).
  const refRows = await req.db.query(
    `SELECT currency,
       COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END),0) AS pending,
       COALESCE(SUM(CASE WHEN status = 'released' THEN amount ELSE 0 END),0) AS released,
       COALESCE(SUM(CASE WHEN status = 'capped' THEN amount ELSE 0 END),0) AS capped
     FROM referral_credits WHERE referrer_id = ? GROUP BY currency`, [req.user.id]);
  const kycSt = kycLib.kycStatusOf(req.user);
  const kycW = kycLib.kycBlock(req.settings, req.user, 'withdraw');
  const kycD = kycLib.kycBlock(req.settings, req.user, 'deposit');
  const kycCard = (kycW.required || kycD.required || kycSt !== 'none')
    ? { status: kycSt, statusLabel: kycLib.STATUS_LABELS[kycSt], blocked: kycW.blocked || kycD.blocked, note: req.user.kyc_note || '' } : null;
  res.render('profile', { metaTitle: 'Profile', metaDesc: '', verifyPhone: req.query.verify_phone === '1', refSummary: refRows, kycCard });
});
router.post('/profile', requireLogin, async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name : ''; // B-08: type-confusion guards
  const phone = typeof req.body.phone === 'string' ? req.body.phone : '';
  const country = typeof req.body.country === 'string' ? req.body.country : '';
  if (!name || name.trim().length < 2) { await req.setFlash('error', 'Name is required.'); return res.redirect('/profile'); }
  // v17.1: store the canonical form (same normalizePhone as registration)
  // and refuse a number another account already uses (normalised both sides,
  // since older rows may hold raw spellings).
  const rawPhone = String(phone || '').trim();
  const newPhone = rawPhone ? normalizePhone(rawPhone).slice(0, 32) : '';
  if (rawPhone && !newPhone) { await req.setFlash('error', 'Enter a valid phone number or leave it blank.'); return res.redirect('/profile'); }
  if (newPhone) {
    const others = await req.db.query("SELECT phone FROM users WHERE id != ? AND phone IS NOT NULL AND phone != ''", [req.user.id]);
    if (others.some(u => normalizePhone(u.phone) === newPhone)) { await req.setFlash('error', 'This phone number is already used by another account.'); return res.redirect('/profile'); }
  }
  // Changing the phone number resets mobile_verified: previously a verified
  // account kept its verified status on a brand-new, never-verified number,
  // and the deposit/withdrawal verified-contact gate passed on it.
  const phoneChanged = newPhone !== normalizePhone(req.user.phone || '');
  await req.db.run('UPDATE users SET name = ?, phone = ?, country = ?, mobile_verified = ? WHERE id = ?',
    [name.trim(), newPhone, String(country || '').trim().slice(0, 64), phoneChanged ? 0 : (req.user.mobile_verified || 0), req.user.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'user.profile_update', entity: 'user', entityId: req.user.id, detail: {}, ip: req.ip });
  await req.setFlash('success', 'Profile updated.');
  res.redirect('/profile');
});

/* BP-13 (v19): per-player email notification preferences. Two checkboxes
   on /profile gate the win and support-reply EMAIL sends (migration v16
   columns, default on). Announcements are in-app only, so there is no
   announcement email to toggle. */
router.post('/profile/notifications', requireLogin, async (req, res) => {
  const win = req.body.notify_win_email ? 1 : 0;
  const support = req.body.notify_support_email ? 1 : 0;
  await req.db.run('UPDATE users SET notify_win_email = ?, notify_support_email = ? WHERE id = ?', [win, support, req.user.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'user.notify_prefs', entity: 'user', entityId: req.user.id, detail: { win_email: !!win, support_email: !!support }, ip: req.ip });
  await req.setFlash('success', 'Notification preferences saved.');
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
  else await req.setFlash('error', 'Could not send the verification email right now. Please try again later.');
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
/* SCAN fix (A-03): every render of the security view — including the
   TOTP setup/confirm/backup POST renders — must carry the full view
   model (hasPassword + sessions). The POST renders used to omit them,
   so the Active Sessions card vanished and passwordless accounts were
   shown a "Change password" form they can never pass. */
async function securityViewModel(req, extra = {}) {
  const u = await req.db.get('SELECT password_hash, totp_secret FROM users WHERE id = ?', [req.user.id]);
  const sessions = await req.db.query(
    'SELECT id, ip, user_agent, created_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC',
    [req.user.id, now()]);
  return Object.assign({
    metaTitle: 'Security', metaDesc: '',
    hasPassword: !!(u && u.password_hash),
    totpEnabled: !!(u && u.totp_secret), showSetup: false, showBackup: false,
    sessions, currentSessionId: req.sess ? req.sess.id : '',
  }, extra);
}

router.get('/security', requireLogin, async (req, res) => {
  // DS-044 + BP-14 via the shared view model: hasPassword drives the
  // "Set a password" variant; sessions is the BP-14 list.
  res.render('security', await securityViewModel(req));
});
router.post('/security/password', requireLogin, async (req, res) => {
  // R-122: logged-in password change (was only possible logged-out).
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!u) { await req.setFlash('error', 'Account not found.'); return res.redirect('/security'); }
  // DS-044: an account with NO password (Google/Facebook/OTP signup) is
  // SETTING one, not changing it - there is no current password to check.
  const isSet = !u.password_hash;
  if (!isSet && !verifyPassword(req.body.current_password || '', u.password_hash || '')) { await req.setFlash('error', 'Current password is incorrect.'); return res.redirect('/security'); }
  const { passwordError } = require('../lib/validate');
  const { isBreached } = require('../lib/breached');
  const pwErr = passwordError(req.body.password, u.role, getBool(req.settings, 'secure_password', true));
  if (pwErr || req.body.password !== req.body.password2) { await req.setFlash('error', pwErr || 'Passwords do not match.'); return res.redirect('/security'); }
  if (getBool(req.settings, 'breached_password_check', true) && await isBreached(req.body.password)) { await req.setFlash('error', 'This password has appeared in a data breach. Please choose a different one.'); return res.redirect('/security'); }
  await req.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(req.body.password), req.user.id]);
  await destroyUserSessions(req.db, req.user.id, req.sess ? req.sess.id : null);
  await audit.log(req.db, { actorId: req.user.id, actorRole: u.role, action: 'user.password_change', entity: 'user', entityId: req.user.id, detail: { other_sessions_revoked: true }, ip: req.ip });
  await req.setFlash('success', isSet ? 'Password set. You can now also sign in with your password.' : 'Password changed. Other sessions were signed out.');
  res.redirect('/security');
});
router.post('/security/totp/start', requireLogin, async (req, res) => {
  const secret = newTotpSecret();
  const { touchSession } = require('../lib/auth');
  await touchSession(req.db, req.sess.id, { totp_pending: secret });
  const uri = totpUri(secret, req.user.email, getS(req.settings, 'site_name', 'Cash Pop'));
  const qrDataUrl = await QRCode.toDataURL(uri);
  res.render('security', await securityViewModel(req, { totpEnabled: false, showSetup: true, setup: { qrDataUrl, secret } }));
});
router.post('/security/totp/confirm', requireLogin, async (req, res) => {
  const secret = req.sessionData.totp_pending;
  if (!secret) { await req.setFlash('error', 'Setup session expired. Start again.'); return res.redirect('/security'); }
  if (!verifyTotp(secret, req.body.totp_code)) {
    const uri = totpUri(secret, req.user.email, getS(req.settings, 'site_name', 'Cash Pop'));
    const qrDataUrl = await QRCode.toDataURL(uri);
    return res.render('security', await securityViewModel(req, { totpEnabled: false, showSetup: true, setup: { qrDataUrl, secret }, formError: 'Invalid code. Try again.' }));
  }
  const codes = newBackupCodes(8);
  const enrollStep = verifyTotpStep(secret, req.body.totp_code);
  if (enrollStep !== null) await req.db.run('UPDATE users SET totp_last_step = ? WHERE id = ?', [enrollStep, req.user.id]);
  await req.db.run('UPDATE users SET totp_secret = ?, backup_codes = ? WHERE id = ?', [secret, hashBackupCodes(codes), req.user.id]);
  const { touchSession } = require('../lib/auth');
  await touchSession(req.db, req.sess.id, { totp_pending: null });
  await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'user.totp_enable', entity: 'user', entityId: req.user.id, detail: {}, ip: req.ip });
  res.render('security', await securityViewModel(req, { totpEnabled: true, showBackup: true, backupCodes: codes }));
});
router.post('/security/totp/disable', requireLogin, async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!verifyPassword(req.body.password || '', u.password_hash || '')) { await req.setFlash('error', 'Wrong password.'); return res.redirect('/security'); }
  // A password alone must not defeat the second factor: require a current
  // authenticator code (or a backup code, which disable invalidates anyway).
  const code = String(req.body.totp_code || '').trim();
  let secondOk = !!(u.totp_secret && verifyTotp(u.totp_secret, code));
  if (!secondOk && u.backup_codes) secondOk = useBackupCode(u.backup_codes, code) !== null;
  if (!secondOk) { await req.setFlash('error', 'Invalid authenticator code.'); return res.redirect('/security'); }
  await req.db.run("UPDATE users SET totp_secret = '', backup_codes = '[]' WHERE id = ?", [req.user.id]);
  // R-123: disabling 2FA revokes other sessions (keep current).
  await destroyUserSessions(req.db, req.user.id, req.sess ? req.sess.id : null);
  await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'user.totp_disable', entity: 'user', entityId: req.user.id, detail: { other_sessions_revoked: true }, ip: req.ip });
  await req.setFlash('success', 'Two-factor authentication disabled.');
  res.redirect('/security');
});
router.post('/security/totp/backup', requireLogin, async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  // Regenerating recovery codes previously required neither password nor a
  // second factor and wrote no audit entry: anyone holding a session could
  // replace the user's codes and lock them out of 2FA recovery.
  if (!u || !verifyPassword(req.body.password || '', u.password_hash || '')) { await req.setFlash('error', 'Wrong password.'); return res.redirect('/security'); }
  const code = String(req.body.totp_code || '').trim();
  let secondOk = !!(u.totp_secret && verifyTotp(u.totp_secret, code));
  if (!secondOk && u.backup_codes) secondOk = useBackupCode(u.backup_codes, code) !== null;
  if (!secondOk) { await req.setFlash('error', 'Invalid authenticator code.'); return res.redirect('/security'); }
  const codes = newBackupCodes(8);
  await req.db.run('UPDATE users SET backup_codes = ? WHERE id = ?', [hashBackupCodes(codes), req.user.id]);
  await destroyUserSessions(req.db, req.user.id, req.sess ? req.sess.id : null);
  await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'user.totp_backup_regen', entity: 'user', entityId: req.user.id, detail: { other_sessions_revoked: true }, ip: req.ip });
  res.render('security', await securityViewModel(req, { totpEnabled: true, showBackup: true, backupCodes: codes }));
});
router.post('/security/sessions/revoke', requireLogin, async (req, res) => {
  const others = await req.db.get('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND id != ?', [req.user.id, req.sess.id]);
  await destroyUserSessions(req.db, req.user.id, req.sess.id);
  // BP-14: the revoke used to leave no audit trace; log it like the other
  // session-revoking actions (password change, 2FA disable).
  await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'user.sessions_revoke', entity: 'user', entityId: req.user.id, detail: { revoked: others ? Number(others.c) : 0 }, ip: req.ip });
  await req.setFlash('success', 'All other sessions signed out.');
  res.redirect('/security');
});

/* ---------------- support tickets ---------------- */
router.get('/support', requireLogin, async (req, res) => {
  const stickets = await req.db.query('SELECT * FROM support_tickets WHERE user_id = ? ORDER BY updated_at DESC', [req.user.id]);
  res.render('support', { metaTitle: 'Support', metaDesc: 'Contact support.', stickets });
});
router.post('/support/new', requireLogin, async (req, res) => {
  const subject = typeof req.body.subject === 'string' ? req.body.subject : ''; // B-08: type-confusion guard
  const message = typeof req.body.message === 'string' ? req.body.message : '';
  if (!subject || !message) { await req.setFlash('error', 'Subject and message are required.'); return res.redirect('/support'); }
  const publicId = 'S' + now().toString(36).toUpperCase() + randHex(3).toUpperCase();
  const t = now();
  const prio = ['low', 'medium', 'high'].includes(String(req.body.priority || '')) ? String(req.body.priority) : 'medium';
  const r = await req.db.run('INSERT INTO support_tickets (public_id, user_id, subject, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [publicId, req.user.id, subject.trim().slice(0, 255), 'open', prio, t, t]);
  await req.db.run('INSERT INTO support_messages (ticket_id, author_id, author_role, body, created_at) VALUES (?, ?, ?, ?, ?)',
    [r.id, req.user.id, req.user.role, message.trim().slice(0, 5000), t]);
  // DS-025: a new ticket must not land silently - audit row for the admin
  // audit trail + optional staff email when support_notify_email is set.
  try { await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'support.create', entity: 'support_ticket', entityId: r.id, detail: { public_id: publicId, priority: prio }, ip: req.ip }); } catch {}
  const notifyTo = String(getS(req.settings, 'support_notify_email', '') || '').trim();
  if (notifyTo) { try { await notify.sendRaw(req.db, req.settings, 'email', notifyTo, 'New support ticket ' + publicId, 'A player opened a support ticket: "' + subject.trim().slice(0, 255) + '" (priority: ' + prio + '). Sign in to the admin panel to reply.'); } catch {} }
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
  // DS-026: staff must learn a reply arrived (audit trail + optional email).
  try { await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'support.reply', entity: 'support_ticket', entityId: ticket.id, detail: { public_id: ticket.public_id }, ip: req.ip }); } catch {}
  const notifyTo2 = String(getS(req.settings, 'support_notify_email', '') || '').trim();
  if (notifyTo2) { try { await notify.sendRaw(req.db, req.settings, 'email', notifyTo2, 'New reply on ticket ' + ticket.public_id, 'A player replied to support ticket "' + ticket.subject + '". Sign in to the admin panel to read it.'); } catch {} }
  res.redirect('/support/' + ticket.public_id);
});
// DS-061: players can close and reopen their own tickets.
router.post('/support/:publicId/close', requireLogin, async (req, res) => {
  const ticket = await req.db.get('SELECT * FROM support_tickets WHERE public_id = ? AND user_id = ?', [req.params.publicId, req.user.id]);
  if (!ticket) return res.redirect('/support');
  if (ticket.status !== 'closed') {
    await req.db.run("UPDATE support_tickets SET status = 'closed', updated_at = ? WHERE id = ? AND status != 'closed'", [now(), ticket.id]);
    try { await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'support.close', entity: 'support_ticket', entityId: ticket.id, detail: { public_id: ticket.public_id, by: 'player' }, ip: req.ip }); } catch {}
  }
  res.redirect('/support/' + ticket.public_id);
});
router.post('/support/:publicId/reopen', requireLogin, async (req, res) => {
  const ticket = await req.db.get('SELECT * FROM support_tickets WHERE public_id = ? AND user_id = ?', [req.params.publicId, req.user.id]);
  if (!ticket) return res.redirect('/support');
  if (ticket.status === 'closed') {
    await req.db.run("UPDATE support_tickets SET status = 'open', updated_at = ? WHERE id = ? AND status = 'closed'", [now(), ticket.id]);
    try { await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'support.reopen', entity: 'support_ticket', entityId: ticket.id, detail: { public_id: ticket.public_id, by: 'player' }, ip: req.ip }); } catch {}
  }
  res.redirect('/support/' + ticket.public_id);
});

/* DS-028: announcements existed only as admin settings text with no
   reader. The announcements table (migration v12) + admin CRUD in the
   Notifications section feed this player page. */
router.get('/announcements', requireLogin, async (req, res) => {
  const announcements = await req.db.query('SELECT * FROM announcements WHERE active = 1 ORDER BY created_at DESC LIMIT 50');
  res.render('announcements', { metaTitle: 'Announcements', metaDesc: '', announcements });
});

module.exports = router;
