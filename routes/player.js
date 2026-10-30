'use strict';
/* Player site: playslip + ticket purchase (server-verified, HMAC-signed),
   tickets, wallet, deposits/withdrawals, transactions, profile, 2FA, support. */
const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { now, randHex, hmac, sha256, hashPassword, verifyPassword, toMinor, decimalsFor, esc, signTicket, normalizePhone, fmtMoney, convertMinor, normalizeEmail, validEmail, emailedLinkBase } = require('../lib/util');
const { getS, getBool, getCurrencies, getSettings } = require('../lib/settings');
const { requireLogin, rateLimit } = require('../lib/auth');
const { getBalances, postLedger, depositPolicy, withdrawalPolicy, chargeFor, createDeposit, createWithdrawal, checkWithdrawalRules, notePayoutDetails, notePendingPayoutChange, promotePayoutDetails, releaseReferralCredits, maybeAutoApproveWithdrawal, exchangeCurrency, exchangeQuote } = require('../lib/money');
const kycLib = require('../lib/kyc');
const uploadLib = require('../lib/upload');
const { getRail, getReceivingDetails, validateUserProof } = require('../lib/rails');
const railByKey = getRail;
const { newTotpSecret, totpUri, verifyTotp, verifyTotpStep, wrapTotpSecret, newBackupCodes, hashBackupCodes, useBackupCode, destroyUserSessions, parseUA } = require('../lib/auth');
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

/* U-02 (v20): map a createWithdrawal throw to its TRUE reason. The
   engine re-checks the v14 rules inside its transaction, so rule
   failures arrive here as the rule's own message — pass those through
   verbatim. The hold posts through postLedger, whose only money
   failure is 'Insufficient balance' — enrich it with amounts. Anything
   else rolled the hold back, so "no money was held" is the true fact. */
async function withdrawFailureMessage(req, e, method, amount) {
  if (e.message === 'Invalid withdrawal amount') return 'Enter a valid amount.';
  if (e.message === 'Insufficient balance' && method) {
    const wallets = await getBalances(req.db, req.user.id);
    const bal = Number((wallets.find(w => w.currency === method.currency) || { balance: 0 }).balance);
    return `Not enough balance: you asked to withdraw ${req.fmt(amount, method.currency)}, but your ${method.currency} wallet has ${req.fmt(bal, method.currency)} — you are ${req.fmt(amount - bal, method.currency)} short.`;
  }
  if (/Wagering requirement|bonus wagering|Daily withdrawal limit|Monthly withdrawal limit|Payout details|payment method you have deposited/.test(e.message)) return e.message;
  return 'Your withdrawal could not be submitted and no money was held. Please contact support if this keeps happening.';
}

/* ---------------- playslip ---------------- */
/* U-02 (v20): one view-model builder for GET /play AND for the failed-buy
   re-render, so a rejection can hand the player their playslip back with
   every local the view needs — never the bare error page. forceCurrency
   (the currency the buy actually attempted) wins over the funded-wallet
   heuristic so the re-rendered balance matches the wallet that was
   charged against. */
async function playViewModel(req, forceCurrency) {
  const wagerOptions = req.wagerOptions;
  const prizeTable = await req.db.query('SELECT pops_count, multiplier FROM prize_table ORDER BY pops_count');
  const wallets = await getBalances(req.db, req.user.id);
  // R-071: the playslip offers every FUNDED wallet, not only the base
  // wallet — a EUR-funded player used to see $0.00 and could not play.
  const funded = wallets.filter(w => Number(w.balance) > 0).map(w => w.currency);
  const forced = String(forceCurrency || '').toUpperCase();
  const sel = (forced && getCurrencies(req.settings).some(c => c.code === forced)) ? forced
    : funded.includes(String(req.query.currency || '').toUpperCase()) ? String(req.query.currency).toUpperCase() : (funded[0] || baseCurrency(req));
  const bal = (wallets.find(w => w.currency === sel) || { balance: 0 }).balance;
  return {
    wagerOptions, prizeTable, maxDraws: parseInt(getS(req.settings, 'max_draws', '7'), 10) || 7, balance: bal,
    wallets, playCurrency: sel,
    /* H1-17 (v23): the playslip renders the CONFIGURED max pops — the
       buy handler enforces settings max_pops, but the page hardcoded
       15 balls and "up to 15 numbers", so a lowered cap left the page
       offering picks the buy would reject. Clamped to the prize
       table's extent: the table defines the sellable game. */
    maxPops: Math.min(parseInt(getS(req.settings, 'max_pops', '15'), 10) || 15, prizeTable.length || 15),
  };
}
/* U-02: a failed buy re-renders the playslip (HTTP 400, the standing
   rejection contract) with the TRUE reason in the flash local — the
   layout prints flash.error at the top of the slip — and the player's
   selections in `slip` so the view can restore them. slip shape:
   { pops: number[], wager: number (minor), drawType, numDraws, currency }. */
async function renderPlayError(req, res, message, slip) {
  const vm = await playViewModel(req, slip && slip.currency);
  return res.status(400).render('play', {
    metaTitle: 'Play', metaDesc: 'Pick your pops and buy a Cash Pop ticket.',
    ...vm, slip: slip || null,
    flash: { error: message, success: '' },
  });
}

router.get('/play', requireLogin, async (req, res) => {
  const vm = await playViewModel(req);
  res.render('play', {
    metaTitle: 'Play', metaDesc: 'Pick your pops and buy a Cash Pop ticket.',
    ...vm, slip: null,
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
  // U-02: the selections the player just made, handed back on every
  // rejection so the re-rendered slip restores them (see renderPlayError).
  const slip = { pops, wager, drawType, numDraws, currency: String(req.body.currency || '').toUpperCase() || baseCurrency(req) };
  const fail = (msg) => renderPlayError(req, res, msg, slip);

  if (!pops.length || pops.length > maxPops) return fail(`Pick between 1 and ${maxPops} pops.`);
  if (!req.wagerOptions.includes(wager)) return fail('That wager is not available. Pick one of the wager amounts shown on the slip.');
  if (!['DAY', 'EVE', 'BOTH'].includes(drawType)) return fail('That draw choice is not available. Pick Day, Evening or Both.');

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
            /* D1-C2 (v20): the referral accrual above guards comm > 0;
               this insert did not — a sub-10-minor ticket at 5% created
               a ZERO commission row that later wedged the agent's whole
               settlement (postLedger refuses 0). No row for no money. */
            if (amt > 0) await tx.run('INSERT INTO commissions (agent_id, user_id, ticket_id, currency, amount, rate, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
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
    // U-02: never a generic "Purchase failed" again. Each rejection maps
    // to the check that actually threw (see audits/owner-fix-round/
    // adj-backend.md for the traced map); the unknown case states the
    // one true fact left — the buy is a single transaction, so a throw
    // means it rolled back and no money was taken.
    console.error('[play/buy] failed:', e.message);
    let msg;
    if (e.message === 'Insufficient balance') {
      const wallets = await getBalances(req.db, req.user.id);
      const bal = Number((wallets.find(w => w.currency === currency) || { balance: 0 }).balance);
      msg = `Not enough balance: this ticket costs ${req.fmt(total, currency)}, but your ${currency} wallet has ${req.fmt(bal, currency)} — you are ${req.fmt(total - bal, currency)} short. Add funds, or lower your wager or number of pops.`;
    } else if (/just closed|per-draw stake cap|daily loss limit/.test(e.message)) {
      msg = e.message;
    } else if (/TICKET_HMAC_SECRET/.test(e.message)) {
      msg = 'Ticket purchases are temporarily unavailable. Please contact support.';
    } else {
      msg = 'Your purchase could not be completed and no money was taken. Please contact support if this keeps happening.';
    }
    return renderPlayError(req, res, msg, slip);
  }
});

/* ---------------- tickets ---------------- */
router.get('/tickets', requireLogin, async (req, res) => {
  // DS-058: paginated (was a hard LIMIT 100 with no way to reach older tickets).
  const totalRow = await req.db.get('SELECT COUNT(*) AS c FROM tickets WHERE user_id = ?', [req.user.id]);
  const totalPages = Math.max(1, Math.ceil(Number(totalRow.c) / 25));
  const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), totalPages); // D4-C2 clamp
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


/* ================= CURRENCY-SYSTEM-01 =================
   The player's selected currency (req.cur) is primary on money pages:
   methods in his currency list first, foreign methods are grouped
   under "Other currencies" and always carry their currency name, and
   amounts shown in a foreign currency get a marked equivalent in his
   currency. Equivalents are DISPLAY-ONLY (convertMinor via the
   admin-set rates, always with the approx sign, never booked); a
   missing/zero rate yields NO equivalent rather than a wrong one. */
function sortMethodsForPlayer(methods, cur) {
  return [...methods].sort((a, b) => ((b.currency === cur) ? 1 : 0) - ((a.currency === cur) ? 1 : 0));
}
function equivStr(req, minor, code) {
  if (!minor || !code || code === req.cur) return '';
  try { return req.fmt(convertMinor(minor, code, req.cur, req.currencies), req.cur); } catch { return ''; }
}
function rateNote(req, code) {
  const base = getS(req.settings, 'base_currency', 'USD');
  const entry = (c) => (req.currencies || []).find(x => x.code === c);
  const perBase = (c) => { const e = entry(c), b = entry(base); return (e && b && Number(b.rate)) ? (Number(e.rate) / Number(b.rate)) : null; };
  const parts = [];
  const pc = perBase(code);
  if (code && code !== req.cur && pc) parts.push(`Amounts on this method are in ${code}. Set rate: 1 ${base} = ${pc.toFixed(4)} ${code}.`);
  const pu = perBase(req.cur);
  if (req.cur !== base && pu) parts.push(`Your currency is ${req.cur}: 1 ${base} = ${pu.toFixed(4)} ${req.cur} (set rate).`);
  return parts.join(' ');
}

async function walletPage(req, res) {
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
  /* D4-C1 (v20): a REJECTED deposit used to vanish from the player's
     world entirely (it never reaches the ledger, so /transactions
     cannot show it, and the pending card drops decided items). The
     wallet now also carries a recent REQUEST history — deposits and
     withdrawals in every status, with the admin's stored reason
     (decision_reason) when one exists — so a decided request is always
     visible in-app even when the notification email fails. */
  const histDeps = await req.db.query("SELECT public_id, amount, currency, status, created_at, decision_reason FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 10", [req.user.id]);
  const histWds = await req.db.query("SELECT public_id, amount, currency, status, created_at, decision_reason FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 10", [req.user.id]);
  const requests = [
    ...histDeps.map(d => ({ ...d, kind: 'deposit', reason: d.decision_reason || '' })),
    ...histWds.map(d => ({ ...d, kind: 'withdrawal', reason: d.decision_reason || '' })),
  ].sort((a, b) => b.created_at - a.created_at).slice(0, 15);
  const kycW = kycLib.kycBlock(req.settings, req.user, 'withdraw');
  const kycD = kycLib.kycBlock(req.settings, req.user, 'deposit');
  const kycSt = kycLib.kycStatusOf(req.user);
  const kycNotice = (kycW.required || kycD.required || kycSt !== 'none')
    ? { status: kycSt, statusLabel: kycLib.STATUS_LABELS[kycSt], withdrawBlocked: kycW.blocked, depositBlocked: kycD.blocked, note: req.user.kyc_note || '' } : null;
  /* CURRENCY-SYSTEM-01: converted TOTAL in the player's currency,
     labelled approx. Shown only when EVERY wallet converts — a
     partial total would be a wrong number (everything-real rule). */
  let totalApprox = null;
  if (wallets.length) {
    try {
      let sum = 0;
      for (const w of wallets) sum += convertMinor(w.balance, w.currency, req.cur, req.currencies);
      totalApprox = req.fmt(sum, req.cur);
    } catch { totalApprox = null; }
  }
  const exchangeFeePercent = parseFloat(getS(req.settings, 'exchange_fee_percent', '0')) || 0;
  /* H1-10 (v23): bonus wagering progress is VISIBLE to the player whose
     withdrawals it gates. Before, unmetWagering existed only inside the
     withdrawal refusal — the player learned about the requirement from
     a rejection. Now the wallet states it plainly per currency. */
  const wagering = [];
  try {
    const bonusLib = require('../lib/bonus');
    for (const w of wallets) {
      const unmet = await bonusLib.unmetWagering(req.db, req.user.id, w.currency);
      if (unmet > 0) wagering.push({ currency: w.currency, unmet });
    }
  } catch {}
  res.render('wallet', { metaTitle: 'Wallet', metaDesc: 'Your balances, deposits and withdrawals.', wallets, depositMethods, withdrawMethods, pending, requests, kycNotice, totalApprox, myCur: req.cur, baseCur: baseCurrency(req), exchangeFeePercent, exchangePreview: req.__exchangePreview || null, wagering });
}
router.get('/wallet', requireLogin, walletPage);

/* CURRENCY-SYSTEM-01: wallet Exchange — preview (shows the exact
   give/receive at the ADMIN-SET rate, fee included) then execute. */
router.post('/wallet/exchange/preview', requireLogin, async (req, res) => {
  const from = String(req.body.from_currency || '').toUpperCase();
  const to = String(req.body.to_currency || '').toUpperCase();
  const dec = decimalsFor(from, req.currencies);
  const amount = toMinor(req.body.amount, dec);
  const back = async (msg) => { await req.setFlash('error', msg); return res.redirect('/wallet'); };
  if (!from || !to || from === to) return back('Pick two different currencies to exchange.');
  if (amount === null || amount <= 0) return back('Enter a valid amount.');
  const wallets = await getBalances(req.db, req.user.id);
  const src = wallets.find(w => w.currency === from);
  if (!src || src.balance < amount) return back('You do not have enough balance in that currency.');
  let q;
  try { q = exchangeQuote(req.currencies, from, to, amount, parseFloat(getS(req.settings, 'exchange_fee_percent', '0')) || 0); }
  catch (e) { return back(e.message); }
  if (q.credit <= 0) return back('That amount is too small to exchange at the current rate.');
  // Re-render the wallet with the confirmation card (same locals as GET).
  req.__exchangePreview = { from, to, amount, amountMajor: String(req.body.amount), credit: q.credit, fee: q.fee, feePercent: parseFloat(getS(req.settings, 'exchange_fee_percent', '0')) || 0, rateFrom: q.rateFrom, rateTo: q.rateTo };
  return walletPage(req, res);
});
router.post('/wallet/exchange', requireLogin, async (req, res) => {
  const from = String(req.body.from_currency || '').toUpperCase();
  const to = String(req.body.to_currency || '').toUpperCase();
  const dec = decimalsFor(from, req.currencies);
  const amount = toMinor(req.body.amount, dec);
  const back = async (msg) => { await req.setFlash('error', msg); return res.redirect('/wallet'); };
  if (!from || !to || from === to) return back('Pick two different currencies to exchange.');
  if (amount === null || amount <= 0) return back('Enter a valid amount.');
  try {
    const r = await exchangeCurrency(req.db, { userId: req.user.id, from, to, amountMinor: amount, settings: req.settings });
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'player', action: 'wallet.exchange', entity: 'wallet', entityId: r.pairRef, detail: { from, to, amount, credited: r.credit, fee: r.fee, fee_percent: r.feePercent !== undefined ? r.feePercent : (parseFloat(getS(req.settings, 'exchange_fee_percent', '0')) || 0) }, ip: req.ip });
    await req.setFlash('success', `Exchanged ${req.fmt(amount, from)} → ${req.fmt(r.credit, to)} at the set rate.`);
    return res.redirect('/wallet');
  } catch (e) { return back(e.message); }
});

/* U-21 §5.3: the rail field set depends on the flow — deposits ask for
   payment PROOF (rail.userFields: tx hash, UTR, transfer reference),
   withdrawals ask for the player's OWN payout destination
   (rail.withdrawUserFields: their wallet address, their bank account).
   Operator-defined method custom_fields apply to both, as before. */
function methodCustomFields(method, kind) {
  let custom = [];
  try { custom = JSON.parse(method.custom_fields || '[]'); } catch {}
  const rail = getRail(method.rail);
  const railFields = rail ? ((kind === 'withdrawal' ? rail.withdrawUserFields : rail.userFields) || []) : [];
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
  const methodsRaw = await req.db.query("SELECT * FROM payment_methods WHERE enabled = 1 AND kind IN ('deposit','both') ORDER BY sort");
  if (!methodsRaw.length) return res.render('deposit_new', { metaTitle: 'Deposit', metaDesc: '', methods: [], method: null, noMethods: true });
  /* CURRENCY-SYSTEM-01: the player's currency group comes first and is
     the default selection; foreign methods follow under their own
     heading in the view. */
  const methods = sortMethodsForPlayer(methodsRaw, req.cur);
  const method = methods.find(m => m.id === parseInt(req.query.m, 10)) || methods[0];
  // DS-005: show the player WHERE to pay (receiving details from the
  // method's stored credentials - public payment addresses, never secrets).
  const receiving = await getReceivingDetails(req.db, method);
  /* HOTFIX 2026-10-29: gateway public config is NO LONGER fetched or
     rendered on the player deposit page (see deposit_new.ejs note) —
     players see pay-to details only, never credential values. */
  /* INSTR-APPLE-01 + METHOD-MODE-01: the how-to the player reads is
     the AUTO text on an Auto Pay method and the manual steps on a
     Manual Pay method — never mixed. */
  const railDef = railByKey(method.rail);
  /* H5-01 (v23): a manual method with no receiving details must not
     print pay-to instructions pointing at an empty destination. */
  const { RECEIVING_FIELDS: RF2 } = require('../lib/rails');
  const manualNoDestination = (method.processing_mode || 'manual') !== 'auto'
    && (RF2[method.rail] || []).length > 0 && !Object.keys(receiving || {}).length;
  const shownInstruction = manualNoDestination
    ? 'This method is not ready yet — no payment destination has been set for it. Please pick another method.'
    : method.processing_mode === 'auto'
    ? (railDef && railDef.autoInstruction) || 'Once the payment provider confirms your payment, your balance is credited automatically.'
    : method.instruction;
  res.render('deposit_new', {
    metaTitle: 'Deposit', metaDesc: '', methods, receiving,
    method: { ...method, instruction: shownInstruction, custom_fields: methodCustomFields(method) },
    methodDec: decimalsFor(method.currency, req.currencies),
    myCur: req.cur, minEquiv: equivStr(req, method.min_amount, method.currency), maxEquiv: equivStr(req, method.max_amount, method.currency),
    rateNote: rateNote(req, method.currency),
  });
});

/* AUTO-INTEGRATION: verify-on-submit for Auto Pay methods whose
   provider offers a real lookup. Returns 'credited' only when the
   PROVIDER confirms the exact payment; every other outcome leaves the
   deposit pending and truthful (never a fake success, never a
   rejection based on an unverified claim either). */
async function tryPaypalAutoVerify(req, method, depositId, txid) {
  try {
    const { loadCredentials } = require('../lib/credentials');
    const paypal = require('../lib/paypal');
    const { creditVerifiedDeposit, refAlreadyUsed } = require('../lib/auto-credit');
    const creds = await loadCredentials(req.db, method.id).catch(() => ({}));
    if (!creds.client_id || !creds.client_secret) return 'not_configured';
    const dep = await req.db.get('SELECT * FROM deposits WHERE id = ?', [depositId]);
    if (!dep || dep.status !== 'pending') return 'unconfirmed';
    if (await refAlreadyUsed(req.db, txid, dep.id)) {
      await audit.log(req.db, { actorId: req.user.id, actorRole: 'player', action: 'deposit.auto_verify_refused', entity: 'deposit', entityId: dep.public_id, detail: { provider: 'paypal', reason: 'transaction already used by another deposit' }, ip: req.ip });
      return 'unconfirmed';
    }
    const got = await paypal.getCapture(creds, txid, { decimals: decimalsFor(dep.currency, getCurrencies(req.settings)) });
    if (!got.ok) {
      await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'deposit.auto_verify_unconfirmed', entity: 'deposit', entityId: dep.public_id, detail: { provider: 'paypal', reason: got.reason }, ip: req.ip });
      return 'unconfirmed';
    }
    const chk = paypal.checkCaptureAgainstDeposit(got.capture, { amountMinor: dep.amount, currency: dep.currency, accountEmail: creds.account_email });
    if (!chk.ok) {
      await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'deposit.auto_verify_unconfirmed', entity: 'deposit', entityId: dep.public_id, detail: { provider: 'paypal', reason: chk.reason }, ip: req.ip });
      return 'unconfirmed';
    }
    const r = await creditVerifiedDeposit(req.db, req.settings, dep, { provider: 'paypal', ref: txid });
    return r.applied ? 'credited' : 'unconfirmed';
  } catch { return 'unconfirmed'; }
}
/* Skrill's status report may arrive BEFORE the player submits the
   deposit (the report fires when Skrill processes the payment). When
   the player then submits that Skrill transaction ID on an Auto
   method, apply the already-verified recorded event — same amount /
   currency gate as the live path. */
async function trySkrillRecordedEvent(req, method, depositId, txid) {
  try {
    const { loadCredentials } = require('../lib/credentials');
    const creds = await loadCredentials(req.db, method.id).catch(() => ({}));
    if (String(creds.provider || '') !== 'Skrill' || !creds.merchant_id || !creds.secret_word) return 'none';
    const events = await req.db.query("SELECT * FROM webhook_events WHERE provider = 'skrill' AND deposit_id IS NULL AND action = 'payment_success' ORDER BY id ASC LIMIT 50", []);
    for (const ev of events) {
      let f = {};
      try { f = JSON.parse(ev.payload || '{}'); } catch { continue; }
      if (String(f.mb_transaction_id || '') !== String(txid)) continue;
      if (String(f.merchant_id || '') !== String(creds.merchant_id)) continue;
      const dep = await req.db.get('SELECT * FROM deposits WHERE id = ?', [depositId]);
      if (!dep || dep.status !== 'pending') return 'none';
      const amtOk = Math.round(Number(f.mb_amount) * (10 ** decimalsFor(dep.currency, getCurrencies(req.settings)))) === Number(dep.amount);
      const curOk = String(f.mb_currency || '').toUpperCase() === String(dep.currency).toUpperCase();
      if (!amtOk || !curOk) {
        await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'deposit.auto_verify_unconfirmed', entity: 'deposit', entityId: dep.public_id, detail: { provider: 'skrill', reason: amtOk ? 'currency mismatch' : 'amount mismatch' }, ip: req.ip });
        return 'none';
      }
      const { creditVerifiedDeposit } = require('../lib/auto-credit');
      const r = await creditVerifiedDeposit(req.db, req.settings, dep, { provider: 'skrill', ref: txid });
      if (r.applied) {
        try { await req.db.run('UPDATE webhook_events SET deposit_id = ? WHERE id = ?', [dep.id, ev.id]); } catch {}
        return 'credited';
      }
      return 'none';
    }
  } catch {}
  return 'none';
}

router.post('/deposit/new', requireLogin, rateLimit({ windowMs: 60000, max: 10, keyFn: req => `deposit:${req.user.id}` }), async (req, res) => { // DS-050: pending-deposit spam cap
  // U-02: submission failures return the player to the form (or the
  // wallet, when the form itself is gated) with the TRUE reason in the
  // flash — the reason texts below are unchanged, only the bare error
  // page is gone.
  const backToForm = async (msg, methodId) => { await req.setFlash('error', msg); return res.redirect('/deposit/new' + (methodId ? '?m=' + methodId : '')); };
  const backToWallet = async (msg) => { await req.setFlash('error', msg); return res.redirect('/wallet'); };
  const policy = depositPolicy(req.settings, req.user);
  if (!policy.allowed) return backToWallet(policy.reason);
  // DS-008: self-exclusion/cooling-off blocks funding too, not just play.
  try { const { enforceAccountPlayable } = require('../lib/scratch'); await enforceAccountPlayable(req.db, req.user.id); }
  catch (e) { return backToWallet('Deposits are unavailable during your self-exclusion or cooling-off period.'); }
  // BP-21: KYC gate (only bites when the operator's gate scope covers deposits).
  if (kycLib.kycBlock(req.settings, req.user, 'deposit').blocked) return backToWallet(kycLib.KYC_MESSAGES.deposit);
  const methodId = parseInt(req.body.method_id, 10);
  if (!methodId) return backToForm('Invalid deposit method.');
  const method = await req.db.get("SELECT * FROM payment_methods WHERE id = ? AND enabled = 1 AND kind IN ('deposit','both')", [methodId]);
  if (!method) return backToForm('That deposit method is not available. Pick another method.', methodId);
  /* H5-01 (v23): a MANUAL method with no receiving details has nowhere
     for the player to pay — refuse the deposit honestly instead of
     recording a request against an empty destination. (The admin
     enable-toggle now prevents this state; this is the second door.) */
  if ((method.processing_mode || 'manual') !== 'auto') {
    const { RECEIVING_FIELDS } = require('../lib/rails');
    if ((RECEIVING_FIELDS[method.rail] || []).length) {
      const receiving = await getReceivingDetails(req.db, method);
      if (!Object.keys(receiving || {}).length) return backToForm('This deposit method is not ready yet — there is no payment destination set for it. Please pick another method.', methodId);
    }
  }
  const amount = toMinor(req.body.amount, decimalsFor(method.currency, getCurrencies(req.settings)));
  if (amount === null || amount <= 0) return backToForm('Enter a valid amount.', methodId);
  if (method.min_amount && amount < method.min_amount) return backToForm(`Amount is below the minimum for this method (${req.fmt(method.min_amount, method.currency)}).`, methodId);
  if (method.max_amount && amount > method.max_amount) return backToForm(`Amount exceeds the maximum for this method (${req.fmt(method.max_amount, method.currency)}).`, methodId);
  // DS-018: player-set daily deposit limit (per currency, UTC day; pending
  // and approved requests both count, so it cannot be split around).
  const rpRow = await req.db.get('SELECT daily_deposit_limit FROM responsible_play WHERE user_id = ?', [req.user.id]);
  const depLimit = rpRow ? Number(rpRow.daily_deposit_limit || 0) : 0;
  if (depLimit > 0) {
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const depRow = await req.db.get(`SELECT COALESCE(SUM(amount),0) AS s FROM deposits WHERE user_id = ? AND currency = ? AND status IN ('pending','approved') AND created_at >= ?`, [req.user.id, method.currency, dayStart.getTime()]);
    if (Number(depRow.s) + amount > depLimit) return backToForm('That deposit would exceed your daily deposit limit.', methodId);
  }
  const userData = {};
  for (const f of methodCustomFields(method)) {
    // R-116: per-field length cap (was unbounded up to the 2MB body limit).
    const v = String(req.body['custom_' + f.key] || '').trim().slice(0, 2000);
    if (f.required && !v) return backToForm(`Field "${f.label}" is required.`, methodId);
    userData[f.key] = v;
  }
  try {
    const createdDep = await createDeposit(req.db, { userId: req.user.id, method, amountMinor: amount, userData, settings: req.settings });
    const publicId = createdDep.publicId;
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'player', action: 'deposit.create', entity: 'deposit', entityId: publicId, detail: { amount, method: method.name }, ip: req.ip });
    // NO unverified auto-approve: a deposit is credited ONLY by a
    // verified provider confirmation or an admin approving against a
    // statement entry. The old code approved small "auto" deposits with
    // zero payment verification — free money for anyone who submitted.
    // AUTO-INTEGRATION: on an Auto Pay method we now ASK THE PROVIDER
    // about the reference the player just submitted (PayPal capture
    // lookup / an already-received signed Skrill status report) and
    // credit only on its exact confirmation.
    let flashMsg = 'Deposit request submitted. It will be credited after review.';
    if (method.processing_mode === 'auto' && method.rail === 'paypal' && userData.paypal_txid) {
      const r = await tryPaypalAutoVerify(req, method, createdDep.id, userData.paypal_txid);
      if (r === 'credited') flashMsg = 'Deposit credited — PayPal confirmed your payment automatically.';
      else flashMsg = 'Deposit request submitted. PayPal has not confirmed this payment yet — if PayPal confirms it, your balance is credited automatically; otherwise our team will review it.';
    } else if (method.processing_mode === 'auto' && method.rail === 'ewallet' && userData.ewallet_txid) {
      const r = await trySkrillRecordedEvent(req, method, createdDep.id, userData.ewallet_txid);
      if (r === 'credited') flashMsg = 'Deposit credited — Skrill confirmed your payment automatically.';
    }
    await req.setFlash('success', flashMsg);
    res.redirect('/wallet');
  } catch (e) {
    console.error('[deposit] failed:', e.message);
    const msg = e.message === 'Invalid deposit amount' ? 'Enter a valid amount.'
      : /deposit limit of/i.test(e.message) ? e.message // ADMIN-CLARITY-01: cap refusals are already plain player language — pass them through
      : 'Your deposit request could not be submitted and no money was taken. Please contact support if this keeps happening.';
    return backToForm(msg, methodId);
  }
});

router.get('/withdraw/new', requireLogin, async (req, res) => {
  const policy = withdrawalPolicy(req.settings, req.user);
  if (!policy.allowed) return res.status(403).render('error', { status: 403, message: policy.reason });
  // BP-21: KYC gate — honest, specific message, never a generic error.
  if (kycLib.kycBlock(req.settings, req.user, 'withdraw').blocked) return res.status(403).render('error', { status: 403, message: kycLib.KYC_MESSAGES.withdraw, cta: { href: '/kyc', label: 'Go to the KYC page' } });
  let methods = await req.db.query("SELECT * FROM payment_methods WHERE enabled = 1 AND kind IN ('withdrawal','both') ORDER BY sort");
  /* MANUAL-PAYMENTS round note: rails with no payout-destination
     fields of their own (cards, Apple/Google/Samsung Pay, vouchers)
     stay withdrawable BY DESIGN (v20-tested behaviour): the operator
     arranges the payout destination with the player off-platform, and
     the rail's withdrawal how-to says exactly that. An earlier draft
     of this round refused such withdrawals outright; that broke the
     established manual loop and was reverted — see FIX-LOG. */
  if (!methods.length) return res.render('withdraw_new', { metaTitle: 'Withdraw', metaDesc: '', methods: [], method: null, balance: 0, noMethods: true, noMethodsReason: 'No payout method is available right now. Please contact support.' });
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
  /* CURRENCY-SYSTEM-01: player's currency group first (stable sort —
     the deposit-used preference above survives inside each group). */
  methods = sortMethodsForPlayer(methods, req.cur);
  const method = methods.find(m => m.id === parseInt(req.query.m, 10)) || methods[0];
  const wallets = await getBalances(req.db, req.user.id);
  const balance = (wallets.find(w => w.currency === method.currency) || { balance: 0 }).balance;
  res.render('withdraw_new', {
    metaTitle: 'Withdraw', metaDesc: '', methods,
    method: { ...method, instruction: (method.withdraw_instruction && String(method.withdraw_instruction).trim()) ? method.withdraw_instruction : method.instruction, custom_fields: methodCustomFields(method, 'withdrawal') }, balance,
    methodDec: decimalsFor(method.currency, req.currencies),
    myCur: req.cur, minEquiv: equivStr(req, method.min_amount, method.currency), maxEquiv: equivStr(req, method.max_amount, method.currency),
    rateNote: rateNote(req, method.currency),
  });
});

router.post('/withdraw/new', requireLogin, rateLimit({ windowMs: 60000, max: 10, keyFn: req => `withdraw:${req.user.id}` }), async (req, res) => { // D2 rate gap: mirrors the deposit limiter (10/min per user)
  // U-02: same true-reason rule as deposits — failures return to the
  // form (or wallet, when gated) with the reason in the flash.
  const backToForm = async (msg, mId) => { await req.setFlash('error', msg); return res.redirect('/withdraw/new' + (mId ? '?m=' + mId : '')); };
  const backToWallet = async (msg) => { await req.setFlash('error', msg); return res.redirect('/wallet'); };
  const policy = withdrawalPolicy(req.settings, req.user);
  if (!policy.allowed) return backToWallet(policy.reason);
  // BP-21: KYC gate — honest, specific message, never a generic error.
  if (kycLib.kycBlock(req.settings, req.user, 'withdraw').blocked) return backToWallet(kycLib.KYC_MESSAGES.withdraw);
  const methodId = parseInt(req.body.method_id, 10);
  if (!methodId) return backToForm('Invalid withdrawal method.');
  const method = await req.db.get("SELECT * FROM payment_methods WHERE id = ? AND enabled = 1 AND kind IN ('withdrawal','both')", [methodId]);
  if (!method) return backToForm('That withdrawal method is not available. Pick another method.', methodId);
  const amount = toMinor(req.body.amount, decimalsFor(method.currency, getCurrencies(req.settings)));
  if (amount === null || amount <= 0) return backToForm('Enter a valid amount.', methodId);
  if (method.min_amount && amount < method.min_amount) return backToForm(`Amount is below the minimum for this method (${req.fmt(method.min_amount, method.currency)}).`, methodId);
  if (method.max_amount && amount > method.max_amount) return backToForm(`Amount exceeds the maximum for this method (${req.fmt(method.max_amount, method.currency)}).`, methodId);
  const userData = {};
  for (const f of methodCustomFields(method, 'withdrawal')) {
    // R-116: per-field length cap (was unbounded up to the 2MB body limit).
    const v = String(req.body['custom_' + f.key] || '').trim().slice(0, 2000);
    if (f.required && !v) return backToForm(`Field "${f.label}" is required.`, methodId);
    userData[f.key] = v;
  }
  /* U-21 §5.3: format-check the submitted payout details with the
     rail's true-reason validator before any rule/OTP step runs. */
  const proofErr = validateUserProof(method.rail, userData);
  if (proofErr) return backToForm(proofErr, methodId);
  // v14 withdrawal rules (turnover, caps, payout lock, same-method) — checked
  // BEFORE the OTP step so a blocked withdrawal never sends a code.
  // R-114: balance check also happens BEFORE the OTP step, so a player
  // with insufficient balance is not sent a code for a doomed withdrawal.
  {
    const wallets0 = await getBalances(req.db, req.user.id);
    const bal0 = (wallets0.find(w => w.currency === method.currency) || { balance: 0 }).balance;
    if (Number(bal0) < amount) return backToForm(`Not enough balance: you asked to withdraw ${req.fmt(amount, method.currency)}, but your ${method.currency} wallet has ${req.fmt(bal0, method.currency)} — you are ${req.fmt(amount - Number(bal0), method.currency)} short.`, methodId);
  }
  const ruleCheck = await checkWithdrawalRules(req.db, req.settings, req.user, method, amount, userData);
  if (!ruleCheck.ok) {
    // RT-20: a blocked attempt records the change as PENDING - it must
    // never replace the active payout fingerprint or lock the original
    // details (the old code did both via notePayoutDetails(..., true)).
    if (ruleCheck.changeDetected) await notePendingPayoutChange(req.db, req.user.id, ruleCheck.fingerprint);
    return backToForm(ruleCheck.reason, methodId);
  }
  // Withdrawal OTP (admin toggle `withdrawal_otp_enabled`, ON by default):
  // OTP is used ONLY here — never on login/register. When ON, the withdrawal is
  // held as pending until the player verifies a one-time code sent to their email/phone.
  if (getBool(req.settings, 'withdrawal_otp_enabled', true)) {
    const otpLib = require('../lib/otp');
    const realEmail = req.user.email && !String(req.user.email).endsWith('@phone.local') ? req.user.email : null;
    const channel = realEmail ? 'email' : 'phone';
    const identifier = channel === 'email' ? realEmail : req.user.phone;
    if (!identifier) return backToForm('Add an email or phone to your profile before withdrawing.', methodId);
    let code;
    try {
      code = await otpLib.createOtp(req.db, identifier, channel);
    } catch (e) {
      return backToForm(e.message, methodId);
    }
    const sent = await otpLib.sendOtp(req.db, req.settings, identifier, channel, code, 'withdrawal');
    // Fail closed: if the code could not be delivered, do NOT park the user
    // on a verify screen for a code that will never arrive.
    if (!sent.sent) { await otpLib.expireLiveOtps(req.db, identifier, channel); return backToForm('Could not send the verification code, so this withdrawal was not started. Please contact support if this keeps happening.', methodId); } // AUTH-CHANNELS-01
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
    console.error('[withdraw] failed:', e.message);
    return backToForm(await withdrawFailureMessage(req, e, method, amount), methodId);
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
  const sent = await otpLib.sendOtp(req.db, req.settings, identifier, channel, code, 'withdrawal');
  if (!sent.sent) { await otpLib.expireLiveOtps(req.db, identifier, channel); return res.status(503).render('error', { status: 503, message: 'Could not send the verification code. Please try again later or contact support.' }); } // AUTH-CHANNELS-01
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
    // U-02: mapped true reason (see withdrawFailureMessage); the
    // no-pending and bad-code branches above keep their 400 true-reason
    // renders (a standing tamper-suite contract).
    console.error('[withdraw] failed:', e.message);
    await req.setFlash('error', await withdrawFailureMessage(req, e, method, pending.amount));
    return res.redirect('/wallet');
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
  let page = Math.max(1, parseInt(req.query.page, 10) || 1);
  let where = ' WHERE user_id = ?';
  const params = [req.user.id];
  if (type === 'credit') where += ' AND amount > 0';
  else if (type === 'debit') where += ' AND amount < 0';
  const total = (await req.db.get('SELECT COUNT(*) AS c FROM transactions' + where, params)).c;
  const totalPages = Math.max(1, Math.ceil(total / PER));
  page = Math.min(page, totalPages); // D4-C2: an out-of-range page renders the LAST page, never a false "No transactions yet"
  const txs = await req.db.query('SELECT * FROM transactions' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?', params.concat([PER, (page - 1) * PER]));
  /* H1-10 (v23): a campaign bonus used to render as type "Bonus" with a
     bare numeric campaign id in the Reference column — a raw internal
     id on a player page. Resolve the campaign NAME for display and
     label deposit bonuses distinctly; the raw id never renders. */
  const campIds = [...new Set(txs.filter(t => t.ref_type === 'bonus_campaign').map(t => Number(t.ref_id)).filter(Number.isFinite))];
  const campNames = {};
  if (campIds.length) {
    const rows = await req.db.query('SELECT id, name FROM bonus_campaigns WHERE id IN (' + campIds.map(() => '?').join(',') + ')', campIds);
    for (const r of rows) campNames[r.id] = r.name;
  }
  for (const t of txs) {
    let meta = {};
    try { meta = JSON.parse(t.meta || '{}'); } catch {}
    if (t.type === 'bonus') t.displayLabel = meta.kind === 'deposit_bonus' ? 'Deposit bonus' : 'Bonus';
    if (t.ref_type === 'bonus_campaign') t.displayRef = campNames[Number(t.ref_id)] || 'Bonus campaign';
  }
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
  /* U-15: profileVerified — the verified-badge boolean. The rule is the
     deposit gate's own rule (lib/money.js verifiedContactOk): email OR
     phone verified. It states a fact about the contacts, so it does NOT
     consult the verified_contact_required toggle (the toggle decides
     whether the fact gates money movement, not whether it is true).
     U-16: baseUrl / referralUrl — absolute links built with the app's
     existing pattern (same expression as the verify-email link below
     and the password-reset link in routes/auth.js):
     BASE_URL env, else the request's own protocol + host. baseUrl also
     repairs the profile view's existing referral expression, which
     silently degraded to a relative path while no route passed it. */
  const baseUrl = (process.env.BASE_URL || (req.protocol + '://' + req.get('host'))).replace(/\/+$/, '');
  const profileVerified = !!(req.user.email_verified || req.user.mobile_verified);
  const referralUrl = req.user.referral_code ? baseUrl + '/register?ref=' + encodeURIComponent(req.user.referral_code) : '';
  /* Player email change (hotfix 2026-10-29): a pending, unexpired
     change row whose target differs from the current address. */
  const pendingRow = await req.db.get('SELECT new_email FROM email_verifications WHERE user_id = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1', [req.user.id, now()]);
  const pendingEmailChange = (pendingRow && pendingRow.new_email && pendingRow.new_email !== req.user.email) ? pendingRow.new_email : '';
  res.render('profile', { metaTitle: 'Profile', metaDesc: '', verifyPhone: req.query.verify_phone === '1', refSummary: refRows, kycCard, baseUrl, referralUrl, profileVerified, pendingEmailChange, referralOn: getBool(req.settings, 'referral_enabled', false) });
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
    /* D2-C5 (v20): the blocked-country rule was enforced only at
       registration — the same number was accepted here afterwards.
       Same check, same true reason; the stored phone is left
       untouched because this returns before the UPDATE. */
    const { isBlockedPhone } = require('../lib/phone-countries');
    if (isBlockedPhone(req.settings, newPhone)) { await req.setFlash('error', 'Phone numbers from this country are not accepted on this platform.'); return res.redirect('/profile'); }
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

/* ---------------- player email change (hotfix 2026-10-29) ----------------
   Owner-reported dead end: the profile page said "Email cannot be
   changed here — contact support." The swap machinery already existed
   (email_verifications + /verify-email/:token, used by the admin
   self-service flow); what was missing was the PLAYER request path.
   Safety contract (deliberately stricter than the admin self flow):
   current-password proof, one-account duplicate refusal, the swap
   happens ONLY when the NEW address clicks its emailed link, and if
   the email cannot actually be sent the token is burned and NOTHING
   changes (no silent immediate apply for player accounts). */
router.post('/profile/change-email', requireLogin, rateLimit({ windowMs: 3600000, max: 5, keyFn: req => 'change-email:' + req.user.id }), async (req, res) => {
  if (!req.user.password_hash || !verifyPassword(String(req.body.current_password || ''), req.user.password_hash)) {
    await req.setFlash('error', 'Email NOT changed: your current password is incorrect.');
    return res.redirect('/profile');
  }
  const email = normalizeEmail(req.body.new_email);
  if (!validEmail(email) || email.endsWith('@phone.local')) { await req.setFlash('error', 'Email NOT changed: enter a valid new email address.'); return res.redirect('/profile'); }
  if (email === normalizeEmail(req.user.email)) { await req.setFlash('error', 'That is already your email address.'); return res.redirect('/profile'); }
  const dup = await req.db.get('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user.id]);
  if (dup) { await req.setFlash('error', 'Email NOT changed: that email is already used by another account.'); return res.redirect('/profile'); }
  // One live link at a time (same burn-then-issue pattern as verify-email).
  await req.db.run('UPDATE email_verifications SET used = 1 WHERE user_id = ? AND used = 0', [req.user.id]);
  const token = randHex(24);
  await req.db.run('INSERT INTO email_verifications (user_id, new_email, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    [req.user.id, email, sha256('verify:' + token), now() + 24 * 3600 * 1000, now()]);
  const linkBaseP = emailedLinkBase(req); // H3-02: BASE_URL in production, never a forged Host
  const link = linkBaseP ? linkBaseP + '/verify-email/' + token : null;
  const sent = link ? await notify.send(req.db, req.settings, 'email', 'email_verification', email, { name: req.user.name, link }).catch(() => ({ status: 'failed' })) : { status: 'failed' };
  if (sent.status === 'sent') {
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'player', action: 'user.email_change_requested', entity: 'user', entityId: req.user.id, detail: { pending_verification: true, to: email }, ip: req.ip });
    await req.setFlash('success', 'Confirmation link sent to ' + email + '. Your email changes only when that link is clicked — your current email keeps working until then.');
  } else { // AUTH-CHANNELS-01 delivery truth: undelivered link is burned, nothing changes
    await req.db.run('UPDATE email_verifications SET used = 1 WHERE token_hash = ?', [sha256('verify:' + token)]);
    await req.setFlash('error', 'Could not send the confirmation email right now, so your email was NOT changed. Please try again later.');
  }
  res.redirect('/profile');
});

/* ---------------- contact verification (v14) ---------------- */
// Email link + phone OTP verification mark email_verified / mobile_verified,
// which the deposit/withdrawal gate reads. Admins can also mark a contact
// verified from the user page (audited) when no provider is configured.
router.post('/profile/verify-email', requireLogin, rateLimit({ windowMs: 3600000, max: 5, keyFn: req => 'verify-email:' + req.user.id }), async (req, res) => {
  const email = req.user.email;
  if (!email || email.endsWith('@phone.local')) { await req.setFlash('error', 'Add a real email to your profile first.'); return res.redirect('/profile'); }
  /* D2-C6 (v20): one live link at a time — invalidate prior unconsumed
     tokens BEFORE issuing the new one (the R-014/R-030 pattern the
     admin path and password reset already follow). */
  await req.db.run('UPDATE email_verifications SET used = 1 WHERE user_id = ? AND used = 0', [req.user.id]);
  const token = randHex(24);
  await req.db.run('INSERT INTO email_verifications (user_id, new_email, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    [req.user.id, email, sha256('verify:' + token), now() + 24 * 3600 * 1000, now()]);
  const linkBaseV = emailedLinkBase(req); // H3-02: BASE_URL in production, never a forged Host
  const link = linkBaseV ? linkBaseV + '/verify-email/' + token : null;
  const sent = link ? await notify.send(req.db, req.settings, 'email', 'email_verification', email, { name: req.user.name, link }) : { status: 'failed' };
  if (sent.status === 'sent') await req.setFlash('success', 'Verification link sent to ' + email + '.');
  else { // AUTH-CHANNELS-01: burn the undelivered link token
    await req.db.run('UPDATE email_verifications SET used = 1 WHERE token_hash = ?', [sha256('verify:' + token)]);
    await req.setFlash('error', 'Could not send the verification email right now. Please try again later.');
  }
  res.redirect('/profile');
});
router.post('/profile/verify-phone', requireLogin, async (req, res) => {
  const phone = req.user.phone;
  if (!phone) { await req.setFlash('error', 'Add a phone number to your profile first.'); return res.redirect('/profile'); }
  const otpLib = require('../lib/otp');
  let code;
  try { code = await otpLib.createOtp(req.db, phone, 'phone'); } catch (e) { await req.setFlash('error', e.message); return res.redirect('/profile'); }
  const sent = await otpLib.sendOtp(req.db, req.settings, phone, 'phone', code, 'verify');
  if (!sent.sent) { await otpLib.expireLiveOtps(req.db, phone, 'phone'); await req.setFlash('error', 'Could not send the verification code. Try again later.'); return res.redirect('/profile'); } // AUTH-CHANNELS-01: undelivered code invalidated
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
const playerSecurityLimiter = rateLimit({ windowMs: 15 * 60000, max: 10, keyFn: req => `player-security:${req.user.id}` }); // D2 rate gap: mirrors the admin TOTP twins (10/15min)
router.post('/force-reset', requireLogin, playerSecurityLimiter, async (req, res) => {
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
  const rawSessions = await req.db.query(
    'SELECT id, ip, user_agent, created_at, expires_at, scope FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC',
    [req.user.id, now()]);
  /* U-04(a): the view receives HUMAN session fields only — the raw
     user-agent never leaves the server. Each item: { id, ip,
     created_at, expires_at, device, browser, os, deviceLabel } with
     deviceLabel = "Device · Browser" and the fallbacks
     "Unknown device · Unknown browser" for an unrecognised UA.
     SESSION-TAB-01: scopeLabel states truthfully WHERE each session
     signs in (Website vs Admin panel) — with dual scopes one account
     can hold one of each, and revoking one never touches the other. */
  const sessions = rawSessions.map(s => {
    const p = parseUA(s.user_agent);
    const browser = p.browser === 'Unknown' ? 'Unknown browser' : p.browser;
    return {
      id: s.id, ip: s.ip, created_at: s.created_at, expires_at: s.expires_at,
      device: p.device, browser, os: p.os,
      deviceLabel: p.device + ' · ' + browser,
      scope: s.scope || 'site',
      scopeLabel: (s.scope === 'admin') ? 'Admin panel' : 'Website',
    };
  });
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
router.post('/security/password', requireLogin, playerSecurityLimiter, async (req, res) => {
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
router.post('/security/totp/start', requireLogin, playerSecurityLimiter, async (req, res) => {
  /* D2-C3 (v20): enrolling a second factor must prove the first —
     the disable/backup handlers in this file already require the
     current password; start/confirm did not, so a bare session could
     enrol an attacker's authenticator. Passwordless accounts (OAuth /
     OTP signups, password_hash NULL) must set a password first — the
     Set-a-password path exists on this very page (securityViewModel
     hasPassword) — so they get that true reason instead. */
  const u0 = await req.db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!u0 || !u0.password_hash) { await req.setFlash('error', 'Set a password on your account before enabling two-factor authentication.'); return res.redirect('/security'); }
  if (!verifyPassword(req.body.password || '', u0.password_hash)) { await req.setFlash('error', 'Wrong password.'); return res.redirect('/security'); }
  const secret = newTotpSecret();
  const { touchSession } = require('../lib/auth');
  await touchSession(req.db, req.sess.id, { totp_pending: secret });
  const uri = totpUri(secret, req.user.email, getS(req.settings, 'site_name', 'Cash Pop'));
  const qrDataUrl = await QRCode.toDataURL(uri);
  res.render('security', await securityViewModel(req, { totpEnabled: false, showSetup: true, setup: { qrDataUrl, secret } }));
});
router.post('/security/totp/confirm', requireLogin, playerSecurityLimiter, async (req, res) => {
  // D2-C3: the password is required AGAIN at confirm, so a session
  // stolen mid-enrolment cannot finish it.
  const u0 = await req.db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (!u0 || !u0.password_hash) { await req.setFlash('error', 'Set a password on your account before enabling two-factor authentication.'); return res.redirect('/security'); }
  if (!verifyPassword(req.body.password || '', u0.password_hash)) { await req.setFlash('error', 'Wrong password.'); return res.redirect('/security'); }
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
  await req.db.run('UPDATE users SET totp_secret = ?, backup_codes = ? WHERE id = ?', [wrapTotpSecret(secret), hashBackupCodes(codes), req.user.id]);
  const { touchSession } = require('../lib/auth');
  await touchSession(req.db, req.sess.id, { totp_pending: null });
  await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'user.totp_enable', entity: 'user', entityId: req.user.id, detail: {}, ip: req.ip });
  res.render('security', await securityViewModel(req, { totpEnabled: true, showBackup: true, backupCodes: codes }));
});
router.post('/security/totp/disable', requireLogin, playerSecurityLimiter, async (req, res) => {
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
router.post('/security/totp/backup', requireLogin, playerSecurityLimiter, async (req, res) => {
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
router.post('/security/sessions/revoke', requireLogin, playerSecurityLimiter, async (req, res) => {
  const others = await req.db.get('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND id != ?', [req.user.id, req.sess.id]);
  await destroyUserSessions(req.db, req.user.id, req.sess.id);
  // BP-14: the revoke used to leave no audit trace; log it like the other
  // session-revoking actions (password change, 2FA disable).
  await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'user.sessions_revoke', entity: 'user', entityId: req.user.id, detail: { revoked: others ? Number(others.c) : 0 }, ip: req.ip });
  await req.setFlash('success', 'All other sessions signed out.');
  res.redirect('/security');
});

/* ---------------- support tickets ---------------- */
/* U-19 (v20): settings-driven creation limits. Keys (the admin Settings
   form wires to these exact names): support_max_open_tickets (default
   2) and support_max_new_tickets_24h (default 3); 0 = unlimited. The
   settings store is a generic key/value table read through getS, so no
   schema change is needed. A stored value that does not parse, or is
   negative, falls back to the default — never to a silent lockout.
   U-25 interplay, implemented exactly: the 24h count includes tickets
   later soft-deleted (deleting never refunds quota — no deleted_at
   filter), while the open count covers only LIVE tickets (status not
   closed AND deleted_at IS NULL), so deleting an open ticket frees
   its slot. 'answered' counts as open: the ticket is still live and
   unresolved, it is merely waiting on the player. */
function supportLimit(settings, key, fallback) {
  const n = parseInt(getS(settings, key, ''), 10);
  return Number.isNaN(n) || n < 0 ? fallback : n;
}
/* U-18 (v20): turn-taking state for one ticket. The alternation keys
   off the messages table's author_role: staff/agent replies are
   written by routes/admin.js and routes/agent.js with a role that is
   never 'player' ('agent', or the admin's normalised staff role), so
   "the latest message is not the player's" is exactly "support spoke
   last" — and staff replies through their existing routes unlock the
   player with no change on their side. Latest = highest id (true
   insertion order; created_at alone can tie within one millisecond).
   Returns { canReply, lockReason } — lockReason is '' when canReply. */
async function supportReplyState(db, ticket) {
  if (ticket.status === 'closed') return { canReply: false, lockReason: 'This ticket is closed. Reopen it if you need more help.' };
  const last = await db.get('SELECT author_role FROM support_messages WHERE ticket_id = ? ORDER BY id DESC LIMIT 1', [ticket.id]);
  if (last && last.author_role !== 'player') return { canReply: true, lockReason: '' };
  return { canReply: false, lockReason: 'You can reply again as soon as our support team has responded to your last message.' };
}

router.get('/support', requireLogin, async (req, res) => {
  // U-25: soft-deleted tickets are gone from the player's list.
  const stickets = await req.db.query('SELECT * FROM support_tickets WHERE user_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC', [req.user.id]);
  res.render('support', { metaTitle: 'Support', metaDesc: 'Contact support.', stickets });
});
router.post('/support/new', requireLogin, async (req, res) => {
  const subject = typeof req.body.subject === 'string' ? req.body.subject : ''; // B-08: type-confusion guard
  const message = typeof req.body.message === 'string' ? req.body.message : '';
  if (!subject || !message) { await req.setFlash('error', 'Subject and message are required.'); return res.redirect('/support'); }
  // U-19: creation limits (see supportLimit note above for the exact
  // counting rules, incl. the U-25 soft-delete interplay).
  const maxOpen = supportLimit(req.settings, 'support_max_open_tickets', 2);
  if (maxOpen > 0) {
    const openRow = await req.db.get("SELECT COUNT(*) AS c FROM support_tickets WHERE user_id = ? AND status != 'closed' AND deleted_at IS NULL", [req.user.id]);
    const openCount = Number(openRow.c);
    if (openCount >= maxOpen) {
      await req.setFlash('error', `You already have ${openCount} open support ticket${openCount === 1 ? '' : 's'} — the limit is ${maxOpen} at a time. Please wait for a reply on an open ticket, or close or delete one, before opening another.`);
      return res.redirect('/support');
    }
  }
  const maxNew24h = supportLimit(req.settings, 'support_max_new_tickets_24h', 3);
  if (maxNew24h > 0) {
    const dayRow = await req.db.get('SELECT COUNT(*) AS c FROM support_tickets WHERE user_id = ? AND created_at >= ?', [req.user.id, now() - 24 * 3600 * 1000]);
    const dayCount = Number(dayRow.c);
    if (dayCount >= maxNew24h) {
      await req.setFlash('error', `You have opened ${dayCount} support tickets in the last 24 hours — the limit is ${maxNew24h} per 24 hours. Deleted tickets still count toward this limit.`);
      return res.redirect('/support');
    }
  }
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
  // U-25: a soft-deleted ticket's URL is a plain not-found, like a
  // missing or foreign ticket — no content leaks.
  const ticket = await req.db.get('SELECT * FROM support_tickets WHERE public_id = ? AND user_id = ? AND deleted_at IS NULL', [req.params.publicId, req.user.id]);
  if (!ticket) return res.status(404).render('error', { status: 404, message: 'Ticket not found.' });
  const messages = await req.db.query('SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY created_at', [ticket.id]);
  // U-18 locals for the view: canReply (boolean) + lockReason (string,
  // '' when the player may reply) — the view shows the reason in place
  // of the reply form when locked.
  const replyState = await supportReplyState(req.db, ticket);
  res.render('support_view', {
    metaTitle: 'Support', metaDesc: '', ticket,
    messages: messages.map(m => ({ ...m, mine: m.author_id === req.user.id })),
    canReply: replyState.canReply, lockReason: replyState.lockReason,
  });
});
router.post('/support/:publicId/reply', requireLogin, async (req, res) => {
  // U-25: the lookup is scoped to the OWNER but not filtered on
  // deleted_at, so an own deleted ticket earns its own true reason
  // while a foreign ticket keeps the indistinguishable plain redirect.
  const ticket = await req.db.get('SELECT * FROM support_tickets WHERE public_id = ? AND user_id = ?', [req.params.publicId, req.user.id]);
  if (!ticket) return res.redirect('/support');
  if (ticket.deleted_at) { await req.setFlash('error', 'This ticket has been deleted and can no longer be replied to.'); return res.redirect('/support'); }
  // U-18: server-enforced turn-taking (the view hiding the form is not
  // the enforcement). Every refusal redirects back with the true
  // reason in the flash — never a bare 400/500.
  const replyState = await supportReplyState(req.db, ticket);
  if (!replyState.canReply) { await req.setFlash('error', replyState.lockReason); return res.redirect('/support/' + ticket.public_id); }
  const body = String(req.body.message || '').trim().slice(0, 5000);
  if (!body) { await req.setFlash('error', 'Write a message before sending your reply.'); return res.redirect('/support/' + ticket.public_id); }
  await req.db.run('INSERT INTO support_messages (ticket_id, author_id, author_role, body, created_at) VALUES (?, ?, ?, ?, ?)',
    [ticket.id, req.user.id, req.user.role, body, now()]);
  await req.db.run("UPDATE support_tickets SET status = 'open', updated_at = ? WHERE id = ?", [now(), ticket.id]);
  // DS-026: staff must learn a reply arrived (audit trail + optional email).
  try { await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'support.reply', entity: 'support_ticket', entityId: ticket.id, detail: { public_id: ticket.public_id }, ip: req.ip }); } catch {}
  const notifyTo2 = String(getS(req.settings, 'support_notify_email', '') || '').trim();
  if (notifyTo2) { try { await notify.sendRaw(req.db, req.settings, 'email', notifyTo2, 'New reply on ticket ' + ticket.public_id, 'A player replied to support ticket "' + ticket.subject + '". Sign in to the admin panel to read it.'); } catch {} }
  res.redirect('/support/' + ticket.public_id);
});
/* U-25 (v20): player soft-deletes their OWN ticket (migration v19
   columns deleted_at / deleted_by). Deleting an open ticket withdraws
   it. Same POST + flash/redirect pattern as close/reopen below — no
   new confirm pattern. Foreign, missing and already-deleted tickets
   all get the identical 'Ticket not found.' flash, so the endpoint
   leaks nothing about existence. Deleting sends NO notification
   email — this handler never calls notify. */
router.post('/support/:publicId/delete', requireLogin, async (req, res) => {
  const ticket = await req.db.get('SELECT * FROM support_tickets WHERE public_id = ? AND user_id = ? AND deleted_at IS NULL', [req.params.publicId, req.user.id]);
  if (!ticket) { await req.setFlash('error', 'Ticket not found.'); return res.redirect('/support'); }
  await req.db.run('UPDATE support_tickets SET deleted_at = ?, deleted_by = ? WHERE id = ?', [now(), req.user.id, ticket.id]);
  try { await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'support.delete', entity: 'support_ticket', entityId: ticket.id, detail: { public_id: ticket.public_id }, ip: req.ip }); } catch {}
  await req.setFlash('success', 'Ticket deleted.');
  res.redirect('/support');
});
// DS-061: players can close and reopen their own tickets.
router.post('/support/:publicId/close', requireLogin, async (req, res) => {
  const ticket = await req.db.get('SELECT * FROM support_tickets WHERE public_id = ? AND user_id = ? AND deleted_at IS NULL', [req.params.publicId, req.user.id]);
  if (!ticket) return res.redirect('/support');
  if (ticket.status !== 'closed') {
    await req.db.run("UPDATE support_tickets SET status = 'closed', updated_at = ? WHERE id = ? AND status != 'closed'", [now(), ticket.id]);
    try { await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'support.close', entity: 'support_ticket', entityId: ticket.id, detail: { public_id: ticket.public_id, by: 'player' }, ip: req.ip }); } catch {}
  }
  res.redirect('/support/' + ticket.public_id);
});
router.post('/support/:publicId/reopen', requireLogin, async (req, res) => {
  const ticket = await req.db.get('SELECT * FROM support_tickets WHERE public_id = ? AND user_id = ? AND deleted_at IS NULL', [req.params.publicId, req.user.id]);
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
