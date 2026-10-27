'use strict';
/* Money engine: multi-currency wallets, atomic ledger entries, idempotent
   deposit/withdrawal lifecycle with balance holds, and the deposit/withdrawal
   control matrix (global kill switches + per-user switches + auto/manual). */
const { now, randHex, sha256, fmtMoney } = require('./util');
const { getS, getBool, getCurrencies } = require('./settings');

async function getWallet(tx, userId, currency) {
  let w = await tx.get('SELECT * FROM wallets WHERE user_id = ? AND currency = ?', [userId, currency]);
  if (!w) {
    await tx.run('INSERT INTO wallets (user_id, currency, balance) VALUES (?, ?, 0)', [userId, currency]);
    w = { user_id: userId, currency, balance: 0 };
  }
  return w;
}

/* Atomic ledger post. tx = db or transaction handle. Throws on insufficient funds for debits.
   The balance update is a single guarded statement (SET balance = balance + ?
   WHERE balance + ? >= 0) and the affected-row count is checked, so two
   concurrent debits cannot both pass the balance check (double-spend race
   on MySQL, and on SQLite whenever postLedger runs outside a transaction). */
async function postLedger(tx, { userId, currency, type, amount, refType = '', refId = '', meta = {} }) {
  amount = Math.round(Number(amount));
  if (!Number.isFinite(amount) || amount === 0) throw new Error('Invalid ledger amount');
  await getWallet(tx, userId, currency); // ensure the wallet row exists
  const r = await tx.run(
    'UPDATE wallets SET balance = balance + ? WHERE user_id = ? AND currency = ? AND balance + ? >= 0',
    [amount, userId, currency, amount]
  );
  if (r.changes === 0) throw new Error('Insufficient balance');
  const w = await tx.get('SELECT balance FROM wallets WHERE user_id = ? AND currency = ?', [userId, currency]);
  const after = w.balance;
  const ins = await tx.run(
    'INSERT INTO transactions (user_id, currency, type, amount, balance_after, ref_type, ref_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, currency, type, amount, after, refType, String(refId), JSON.stringify(meta), now()]
  );
  return { id: ins.id, balanceAfter: after };
}

async function getBalances(db, userId) {
  return db.query('SELECT currency, balance FROM wallets WHERE user_id = ? ORDER BY currency', [userId]);
}

/* ---------- control matrix ---------- */
/* v14: a verified contact (email OR phone) is required before money moves.
   Admins can mark a contact verified on the user page (audited) when no
   provider is configured — so the gate never bricks a legitimate user. */
function verifiedContactOk(settings, user) {
  if (!getBool(settings, 'verified_contact_required', true)) return true;
  return !!(user.email_verified || user.mobile_verified);
}

function depositPolicy(settings, user) {
  if (!getBool(settings, 'deposits_enabled', true)) return { allowed: false, reason: 'Deposits are currently disabled.' };
  if (user.deposit_blocked) return { allowed: false, reason: 'Deposits are disabled for your account.' };
  if (!verifiedContactOk(settings, user)) return { allowed: false, reason: 'Verify your email or phone before depositing. Use Profile → Verify contact, or ask support to mark your contact verified.' };
  const mode = user.deposit_mode || getS(settings, 'deposit_mode', 'manual');
  return { allowed: true, mode };
}
function withdrawalPolicy(settings, user) {
  if (!getBool(settings, 'withdrawals_enabled', true)) return { allowed: false, reason: 'Withdrawals are currently disabled.' };
  if (user.withdrawal_blocked) return { allowed: false, reason: 'Withdrawals are disabled for your account.' };
  if (!verifiedContactOk(settings, user)) return { allowed: false, reason: 'Verify your email or phone before withdrawing. Use Profile → Verify contact, or ask support to mark your contact verified.' };
  const mode = user.withdrawal_mode || getS(settings, 'withdrawal_mode', 'manual');
  return { allowed: true, mode };
}

function chargeFor(method, amountMinor) {
  const fixed = Number(method.fixed_charge || 0);
  const pct = Number(method.percent_charge || 0);
  return Math.round(fixed + (amountMinor * pct) / 100);
}

/* ---------- deposits ---------- */
async function createDeposit(db, { userId, method, amountMinor, userData = {}, idempotencyKey = null }) {
  const key = idempotencyKey || ('dep_' + randHex(16));
  const charge = chargeFor(method, amountMinor);
  const publicId = 'D' + now().toString(36).toUpperCase() + randHex(3).toUpperCase();
  try {
    const r = await db.run(
      `INSERT INTO deposits (public_id, user_id, method_id, currency, amount, charge, net, status, user_data, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [publicId, userId, method.id, method.currency, amountMinor, charge, amountMinor - charge, JSON.stringify(userData), key, now()]
    );
    return { id: r.id, publicId };
  } catch (e) {
    if (/UNIQUE|duplicate/i.test(e.message)) {
      const ex = await db.get('SELECT id, public_id FROM deposits WHERE idempotency_key = ?', [key]);
      return { id: ex.id, publicId: ex.public_id, duplicate: true };
    }
    throw e;
  }
}

async function decideDeposit(db, depositId, decision, adminId) {
  // decision: approve | reject | revoke
  return db.transaction(async (tx) => {
    const d = await tx.get('SELECT * FROM deposits WHERE id = ?', [depositId]);
    if (!d) throw new Error('Deposit not found');
    const t = now();
    if (decision === 'approve') {
      if (d.status !== 'pending') throw new Error('Only pending deposits can be approved');
      await tx.run('UPDATE deposits SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?', ['approved', t, adminId, depositId]);
      await postLedger(tx, { userId: d.user_id, currency: d.currency, type: 'deposit', amount: d.net, refType: 'deposit', refId: d.public_id, meta: { method_id: d.method_id } });
    } else if (decision === 'reject') {
      if (d.status !== 'pending') throw new Error('Only pending deposits can be rejected');
      await tx.run('UPDATE deposits SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?', ['rejected', t, adminId, depositId]);
    } else if (decision === 'revoke') {
      if (d.status !== 'approved') throw new Error('Only approved deposits can be revoked');
      await tx.run('UPDATE deposits SET status = ?, decided_at = ?, decided_by = ? WHERE id = ?', ['revoked', t, adminId, depositId]);
      await postLedger(tx, { userId: d.user_id, currency: d.currency, type: 'deposit_revoke', amount: -d.net, refType: 'deposit', refId: d.public_id, meta: { revoked_by: adminId } });
    } else throw new Error('Unknown decision');
    return d;
  });
}

/* ---------- withdrawals (hold on create, release on decide) ---------- */
async function createWithdrawal(db, { userId, method, amountMinor, userData = {}, idempotencyKey = null }) {
  const key = idempotencyKey || ('wd_' + randHex(16));
  const charge = chargeFor(method, amountMinor);
  const publicId = 'W' + now().toString(36).toUpperCase() + randHex(3).toUpperCase();
  try {
    const created = await db.transaction(async (tx) => {
      const r = await tx.run(
        `INSERT INTO withdrawals (public_id, user_id, method_id, currency, amount, charge, net, status, user_data, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [publicId, userId, method.id, method.currency, amountMinor, charge, amountMinor - charge, JSON.stringify(userData), key, now()]
      );
      // hold the full amount immediately
      await postLedger(tx, { userId, currency: method.currency, type: 'withdrawal_hold', amount: -amountMinor, refType: 'withdrawal', refId: publicId, meta: { method_id: method.id } });
      return r.id;
    });
    return { id: created, publicId };
  } catch (e) {
    if (/UNIQUE|duplicate/i.test(e.message)) {
      const ex = await db.get('SELECT id, public_id FROM withdrawals WHERE idempotency_key = ?', [key]);
      return { id: ex.id, publicId: ex.public_id, duplicate: true };
    }
    throw e;
  }
}

async function decideWithdrawal(db, withdrawalId, decision, adminId, adminNote = '') {
  return db.transaction(async (tx) => {
    const w = await tx.get('SELECT * FROM withdrawals WHERE id = ?', [withdrawalId]);
    if (!w) throw new Error('Withdrawal not found');
    const t = now();
    if (decision === 'approve') {
      if (w.status !== 'pending') throw new Error('Only pending withdrawals can be approved');
      await tx.run('UPDATE withdrawals SET status = ?, decided_at = ?, decided_by = ?, admin_note = ? WHERE id = ?', ['approved', t, adminId, adminNote, withdrawalId]);
      // Hold becomes permanent: createWithdrawal already debited the FULL amount,
      // and the user is paid only the net outside the app. NOTHING is posted
      // back here — the old code credited +charge to the user on approve,
      // which refunded the fee instead of retaining it (house leaked the fee
      // on every charged withdrawal). The fee is retained implicitly: the
      // wallet stays down by the full amount while only the net is paid out.
    } else if (decision === 'reject') {
      if (w.status !== 'pending') throw new Error('Only pending withdrawals can be rejected');
      await tx.run('UPDATE withdrawals SET status = ?, decided_at = ?, decided_by = ?, admin_note = ? WHERE id = ?', ['rejected', t, adminId, adminNote, withdrawalId]);
      await postLedger(tx, { userId: w.user_id, currency: w.currency, type: 'withdrawal_release', amount: w.amount, refType: 'withdrawal', refId: w.public_id, meta: { note: 'hold released' } });
    } else if (decision === 'revoke') {
      if (w.status !== 'approved') throw new Error('Only approved withdrawals can be revoked');
      await tx.run('UPDATE withdrawals SET status = ?, decided_at = ?, decided_by = ?, admin_note = ? WHERE id = ?', ['revoked', t, adminId, adminNote, withdrawalId]);
      await postLedger(tx, { userId: w.user_id, currency: w.currency, type: 'withdrawal_revoke', amount: w.net, refType: 'withdrawal', refId: w.public_id, meta: { revoked_by: adminId } });
    } else throw new Error('Unknown decision');
    return w;
  });
}

/* ---------- v14 withdrawal rules ---------- */
/* Checked BEFORE the OTP step on /withdraw/new and re-checked on
   /withdraw/verify (state may have changed in between).
   Returns { ok, reason, fingerprint, changeDetected }.
   Payout-lock semantics: any payout-detail CHANGE starts a lock window
   (payout_lock_hours, default 48) during which NO withdrawal is allowed —
   not the first changed attempt, not retries with the same details, not a
   further change (which also does NOT refresh the clock, so the lock cannot
   be extended by spam). After expiry, the recorded details proceed.
   First-ever details are free (no timestamp is set for them). */
function sortObject(o) {
  const out = {};
  for (const k of Object.keys(o || {}).sort()) out[k] = o[k];
  return out;
}

async function checkWithdrawalRules(db, settings, user, method, amountMinor, userData = {}) {
  const cur = method.currency;
  const currencies = getCurrencies(settings);
  const m = (x) => fmtMoney(x, cur, currencies);
  if (getBool(settings, 'withdrawal_turnover_required', true)) {
    const dep = await db.get("SELECT COALESCE(SUM(net),0) AS s FROM deposits WHERE user_id = ? AND status = 'approved' AND currency = ?", [user.id, cur]);
    const wag = await db.get("SELECT COALESCE(SUM(ABS(amount)),0) AS s FROM transactions WHERE user_id = ? AND type IN ('ticket_purchase','scratch_purchase') AND currency = ?", [user.id, cur]);
    const deposited = Number(dep.s), wagered = Number(wag.s);
    if (wagered < deposited) {
      return { ok: false, reason: `Wagering requirement not met: you have wagered ${m(wagered)} of ${m(deposited)} deposited. Wager ${m(deposited - wagered)} more before withdrawing.`, fingerprint: null, changeDetected: false };
    }
  }
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const dailyCap = parseInt(getS(settings, 'withdrawal_daily_cap', '0'), 10) || 0;
  if (dailyCap > 0) {
    const row = await db.get(`SELECT COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE user_id = ? AND status IN ('pending','approved','paid') AND currency = ? AND created_at >= ?`, [user.id, cur, dayStart.getTime()]);
    if (Number(row.s) + amountMinor > dailyCap) return { ok: false, reason: `Daily withdrawal limit of ${m(dailyCap)} reached.`, fingerprint: null, changeDetected: false };
  }
  const monthlyCap = parseInt(getS(settings, 'withdrawal_monthly_cap', '0'), 10) || 0;
  if (monthlyCap > 0) {
    const row = await db.get(`SELECT COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE user_id = ? AND status IN ('pending','approved','paid') AND currency = ? AND created_at >= ?`, [user.id, cur, monthStart.getTime()]);
    if (Number(row.s) + amountMinor > monthlyCap) return { ok: false, reason: `Monthly withdrawal limit of ${m(monthlyCap)} reached.`, fingerprint: null, changeDetected: false };
  }
  const lockHours = parseInt(getS(settings, 'payout_lock_hours', '48'), 10) || 0;
  const fp = sha256(JSON.stringify(sortObject(userData)));
  const u = await db.get('SELECT payout_updated_at, payout_fingerprint FROM users WHERE id = ?', [user.id]);
  const stored = (u && u.payout_fingerprint) || '';
  const updatedAt = (u && Number(u.payout_updated_at)) || 0;
  const inWindow = lockHours > 0 && updatedAt > now() - lockHours * 3600000;
  if (stored && stored !== fp) {
    if (inWindow) {
      // Changed again DURING an active lock: blocked, clock NOT refreshed.
      return { ok: false, reason: `Payout details were changed recently. Withdrawals are locked for ${lockHours} hours after a payout-detail change.`, fingerprint: fp, changeDetected: false };
    }
    if (lockHours > 0) {
      return { ok: false, reason: `Payout details changed. For your security, withdrawals are locked for ${lockHours} hours after a payout-detail change. Please try again after the lock expires.`, fingerprint: fp, changeDetected: true };
    }
    // Lock disabled: allow; caller refreshes the fingerprint.
  } else if (stored && stored === fp && inWindow) {
    // Same details as the recorded change, but the lock window from that
    // change is still running: still blocked (the lock is on the CHANGE,
    // not on the details differing — otherwise a retry would sail through).
    return { ok: false, reason: `Payout details were changed recently. Withdrawals are locked for ${lockHours} hours after a payout-detail change.`, fingerprint: fp, changeDetected: false };
  }
  if (getBool(settings, 'withdrawal_same_method', false)) {
    const used = await db.get('SELECT COUNT(*) AS c FROM deposits WHERE user_id = ? AND method_id = ? AND status = ?', [user.id, method.id, 'approved']);
    if (!used || Number(used.c) === 0) return { ok: false, reason: 'Withdrawals must use a payment method you have deposited with before.', fingerprint: fp, changeDetected: false };
  }
  return { ok: true, reason: '', fingerprint: fp, changeDetected: false };
}

async function notePayoutDetails(db, userId, fingerprint, recordChange) {
  if (recordChange) {
    await db.run('UPDATE users SET payout_fingerprint = ?, payout_updated_at = ? WHERE id = ?', [fingerprint, now(), userId]);
  } else {
    await db.run("UPDATE users SET payout_fingerprint = ? WHERE id = ? AND (payout_fingerprint IS NULL OR payout_fingerprint = '')", [fingerprint, userId]);
  }
}

/* v14: the real payout step. Only approved withdrawals can be marked paid,
   and a provider payout ID is REQUIRED — the payout is never "assumed".
   'paid' is terminal (no revoke after payment; errors go through adjustment). */
async function markWithdrawalPaid(db, withdrawalId, payoutId, adminId) {
  return db.transaction(async (tx) => {
    const w = await tx.get('SELECT * FROM withdrawals WHERE id = ?', [withdrawalId]);
    if (!w) throw new Error('Withdrawal not found');
    if (w.status !== 'approved') throw new Error('Only approved withdrawals can be marked paid');
    const pid = String(payoutId || '').trim().slice(0, 255);
    if (!pid) throw new Error('Provider payout ID is required');
    await tx.run('UPDATE withdrawals SET status = ?, provider_payout_id = ?, payout_at = ?, decided_by = ? WHERE id = ?',
      ['paid', pid, now(), adminId, withdrawalId]);
    return w;
  });
}

/* v14: agent commissions settle THROUGH the ledger (one postLedger per
   currency) instead of ad-hoc balance edits, and are marked settled so they
   can never be paid twice. */
async function settleAgentCommissions(db, agentId, adminId) {
  return db.transaction(async (tx) => {
    const rows = await tx.query('SELECT * FROM commissions WHERE agent_id = ? AND settled = 0', [agentId]);
    if (!rows.length) return { settled: 0, total: 0 };
    const byCur = {};
    for (const r of rows) byCur[r.currency] = (byCur[r.currency] || 0) + Number(r.amount);
    for (const [cur, total] of Object.entries(byCur)) {
      await postLedger(tx, { userId: agentId, currency: cur, type: 'agent_commission', amount: total, refType: 'commission_settlement', refId: 'COM' + now(), meta: { admin_id: adminId, count: rows.filter(x => x.currency === cur).length } });
    }
    await tx.run('UPDATE commissions SET settled = 1, settled_at = ? WHERE agent_id = ? AND settled = 0', [now(), agentId]);
    return { settled: rows.length, total: rows.reduce((a, r) => a + Number(r.amount), 0) };
  });
}

/* v14 referral release: pending referral_credits release only once the
   referee has an approved deposit AND any wagering, and only up to the
   per-referee lifetime cap (0 = unlimited). Over-cap rows are marked
   'capped' (terminal), never left pending forever. Call AFTER the triggering
   transaction commits (deposit approval, ticket buy) — never inside one. */
async function releaseReferralCredits(db, refereeId, settings) {
  const dep = await db.get("SELECT COUNT(*) AS c FROM deposits WHERE user_id = ? AND status = 'approved'", [refereeId]);
  if (!dep || Number(dep.c) === 0) return { released: 0, capped: 0 };
  const wag = await db.get("SELECT COALESCE(SUM(ABS(amount)),0) AS s FROM transactions WHERE user_id = ? AND type IN ('ticket_purchase','scratch_purchase')", [refereeId]);
  if (Number(wag.s) <= 0) return { released: 0, capped: 0 };
  const cap = parseInt(getS(settings, 'referral_cap_per_referee', '0'), 10) || 0;
  return db.transaction(async (tx) => {
    const pend = await tx.query("SELECT * FROM referral_credits WHERE referee_id = ? AND status = 'pending' ORDER BY created_at", [refereeId]);
    let released = 0, capped = 0;
    for (const row of pend) {
      if (cap > 0) {
        const rel = await tx.get("SELECT COALESCE(SUM(amount),0) AS s FROM referral_credits WHERE referee_id = ? AND status = 'released'", [refereeId]);
        if (Number(rel.s) + Number(row.amount) > cap) {
          await tx.run("UPDATE referral_credits SET status = 'capped' WHERE id = ?", [row.id]);
          capped++;
          continue;
        }
      }
      await postLedger(tx, { userId: row.referrer_id, currency: row.currency, type: 'referral_commission', amount: Number(row.amount), refType: 'referral_credit', refId: 'RC' + row.id, meta: { referee_id: refereeId, ticket_id: row.ticket_id } });
      await tx.run("UPDATE referral_credits SET status = 'released', released_at = ? WHERE id = ?", [now(), row.id]);
      released++;
    }
    return { released, capped };
  });
}

module.exports = {
  getWallet, postLedger, getBalances,
  depositPolicy, withdrawalPolicy, verifiedContactOk, chargeFor,
  createDeposit, decideDeposit, createWithdrawal, decideWithdrawal,
  checkWithdrawalRules, notePayoutDetails, markWithdrawalPaid,
  settleAgentCommissions, releaseReferralCredits,
};
