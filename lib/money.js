'use strict';
/* Money engine: multi-currency wallets, atomic ledger entries, idempotent
   deposit/withdrawal lifecycle with balance holds, and the deposit/withdrawal
   control matrix (global kill switches + per-user switches + auto/manual). */
const { now, randHex, sha256, fmtMoney } = require('./util');
const { encryptField, decryptField, keyConfigured } = require('./credentials');
function encodeUserData(userData) {
  const raw = JSON.stringify(userData || {});
  // R-115: payout details (bank/wallet data) encrypted at rest when the
  // credentials key is configured; plaintext otherwise (documented, and
  // decodeUserData handles both forms so old rows keep working).
  if (keyConfigured()) { try { return encryptField(raw); } catch {} }
  return raw;
}
function decodeUserData(stored) {
  if (!stored) return {};
  try {
    if (String(stored).startsWith('v1:')) return JSON.parse(decryptField(stored, 1));
    return JSON.parse(stored);
  } catch { return {}; }
}
const { getS, getBool, getCurrencies } = require('./settings');

async function getWallet(tx, userId, currency) {
  let w = await tx.get('SELECT * FROM wallets WHERE user_id = ? AND currency = ?', [userId, currency]);
  if (!w) {
    // R-076: INSERT OR IGNORE-style upsert — concurrent first posts for a
    // new wallet used to race on the PK and fail the second post.
    // (Postgres/MySQL upsert syntax differs; the guarded re-read below
    // covers the race on all drivers: if our insert lost, re-read.)
    try { await tx.run('INSERT INTO wallets (user_id, currency, balance) VALUES (?, ?, 0)', [userId, currency]); } catch (e) { if (!/UNIQUE|duplicate/i.test(e.message)) throw e; }
    w = await tx.get('SELECT * FROM wallets WHERE user_id = ? AND currency = ?', [userId, currency]);
    if (!w) w = { user_id: userId, currency, balance: 0 };
  }
  return w;
}

/* Atomic ledger post. tx = db or transaction handle. Throws on insufficient funds for debits.
   The balance update is a single guarded statement (SET balance = balance + ?
   WHERE balance + ? >= 0) and the affected-row count is checked, so two
   concurrent debits cannot both pass the balance check (double-spend race
   on MySQL, and on SQLite whenever postLedger runs outside a transaction). */
async function postLedger(tx, { userId, currency, type, amount, refType = '', refId = '', meta = {} }) {
  // R-077/R-076: reject non-integer amounts (old code silently rounded)
  // and keep balance_after honest: it is read inside the same txn, after
  // the guarded UPDATE, so a concurrent post on PG/MySQL cannot shift it
  // between update and read (SQLite serialises via BEGIN IMMEDIATE).
  if (!Number.isSafeInteger(amount) || amount === 0) throw new Error('Invalid ledger amount');
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
  // Charges can never be negative: a negative percent/rate (see method
  // create/edit validation) must not turn a fee into a payout.
  return Math.max(0, Math.round(fixed + (amountMinor * pct) / 100));
}

/* Row-lock suffix for SELECT ... FOR UPDATE. SQLite has NO FOR UPDATE
   support at all (node:sqlite throws a syntax error), so on SQLite the
   suffix must be empty — BEGIN IMMEDIATE already serializes the whole
   transaction. Postgres/MySQL need the real suffix for concurrency safety.
   (v16 wrongly claimed SQLite treats FOR UPDATE as a no-op; it throws.) */
function lockSuffix(db) {
  return db && db.driver === 'sqlite' ? '' : ' FOR UPDATE';
}

/* ---------- deposits ---------- */
async function createDeposit(db, { userId, method, amountMinor, userData = {}, idempotencyKey = null }) {
  const key = idempotencyKey || ('dep_' + randHex(16));
  // R-022/R-077: engine-level validation + net can never go negative.
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('Invalid deposit amount');
  const charge = Math.min(chargeFor(method, amountMinor), amountMinor);
  const publicId = 'D' + now().toString(36).toUpperCase() + randHex(3).toUpperCase();
  try {
    const r = await db.run(
      `INSERT INTO deposits (public_id, user_id, method_id, currency, amount, charge, net, status, user_data, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [publicId, userId, method.id, method.currency, amountMinor, charge, amountMinor - charge, encodeUserData(userData), key, now()]
    );
    return { id: r.id, publicId };
  } catch (e) {
    if (/UNIQUE|duplicate/i.test(e.message)) {
      const ex = await db.get('SELECT id, public_id FROM deposits WHERE idempotency_key = ?', [key]);
      // v16: the UNIQUE violation may have been on public_id, not the key —
      // then ex is null and ex.id used to throw a confusing TypeError.
      if (!ex) throw e;
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
      // v16: guarded transition. Under Postgres/MySQL READ COMMITTED two
      // concurrent approves could both read 'pending' and both credit the
      // user. The WHERE status clause makes the second UPDATE a no-op and
      // the changes check turns it into a clean failure, not a double credit.
      const updA = await tx.run("UPDATE deposits SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'", ['approved', t, adminId, depositId]);
      if (updA.changes === 0) throw new Error('Deposit was already decided by another process — please refresh.');
      await postLedger(tx, { userId: d.user_id, currency: d.currency, type: 'deposit', amount: d.net, refType: 'deposit', refId: d.public_id, meta: { method_id: d.method_id } });
    } else if (decision === 'reject') {
      if (d.status !== 'pending') throw new Error('Only pending deposits can be rejected');
      const updR = await tx.run("UPDATE deposits SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'", ['rejected', t, adminId, depositId]);
      if (updR.changes === 0) throw new Error('Deposit was already decided by another process — please refresh.');
    } else if (decision === 'revoke') {
      if (d.status !== 'approved') throw new Error('Only approved deposits can be revoked');
      const updV = await tx.run("UPDATE deposits SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'approved'", ['revoked', t, adminId, depositId]);
      if (updV.changes === 0) throw new Error('Deposit was already decided by another process — please refresh.');
      await postLedger(tx, { userId: d.user_id, currency: d.currency, type: 'deposit_revoke', amount: -d.net, refType: 'deposit', refId: d.public_id, meta: { revoked_by: adminId } });
    } else throw new Error('Unknown decision');
    return d;
  });
}

/* ---------- withdrawals (hold on create, release on decide) ---------- */
async function createWithdrawal(db, { userId, method, amountMinor, userData = {}, idempotencyKey = null, settings = null, user = null }) {
  const key = idempotencyKey || ('wd_' + randHex(16));
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('Invalid withdrawal amount');
  const charge = Math.min(chargeFor(method, amountMinor), amountMinor);
  const publicId = 'W' + now().toString(36).toUpperCase() + randHex(3).toUpperCase();
  try {
    const created = await db.transaction(async (tx) => {
      // R-021: re-check caps/turnover/lock INSIDE the creation txn when
      // the caller supplies settings+user, so concurrent creates cannot
      // both pass an outside-txn check and exceed a cap.
      if (settings && user) {
        const rc = await checkWithdrawalRules(tx, settings, user, method, amountMinor, userData);
        if (!rc.ok) throw new Error(rc.reason);
      }
      const r = await tx.run(
        `INSERT INTO withdrawals (public_id, user_id, method_id, currency, amount, charge, net, status, user_data, idempotency_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [publicId, userId, method.id, method.currency, amountMinor, charge, amountMinor - charge, encodeUserData(userData), key, now()]
      );
      // hold the full amount immediately
      await postLedger(tx, { userId, currency: method.currency, type: 'withdrawal_hold', amount: -amountMinor, refType: 'withdrawal', refId: publicId, meta: { method_id: method.id } });
      return r.id;
    });
    return { id: created, publicId };
  } catch (e) {
    if (/UNIQUE|duplicate/i.test(e.message)) {
      const ex = await db.get('SELECT id, public_id FROM withdrawals WHERE idempotency_key = ?', [key]);
      // v16: same null-guard as deposits (violation may be on public_id).
      if (!ex) throw e;
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
      // v16: guarded transition (same double-decide race as deposits).
      const updA = await tx.run("UPDATE withdrawals SET status = ?, decided_at = ?, decided_by = ?, admin_note = ? WHERE id = ? AND status = 'pending'", ['approved', t, adminId, adminNote, withdrawalId]);
      if (updA.changes === 0) throw new Error('Withdrawal was already decided by another process — please refresh.');
      // Hold becomes permanent: createWithdrawal already debited the FULL amount,
      // and the user is paid only the net outside the app. NOTHING is posted
      // back here — the old code credited +charge to the user on approve,
      // which refunded the fee instead of retaining it (house leaked the fee
      // on every charged withdrawal). The fee is retained implicitly: the
      // wallet stays down by the full amount while only the net is paid out.
    } else if (decision === 'reject') {
      if (w.status !== 'pending') throw new Error('Only pending withdrawals can be rejected');
      const updR = await tx.run("UPDATE withdrawals SET status = ?, decided_at = ?, decided_by = ?, admin_note = ? WHERE id = ? AND status = 'pending'", ['rejected', t, adminId, adminNote, withdrawalId]);
      if (updR.changes === 0) throw new Error('Withdrawal was already decided by another process — please refresh.');
      await postLedger(tx, { userId: w.user_id, currency: w.currency, type: 'withdrawal_release', amount: w.amount, refType: 'withdrawal', refId: w.public_id, meta: { note: 'hold released' } });
    } else if (decision === 'revoke') {
      if (w.status !== 'approved') throw new Error('Only approved withdrawals can be revoked');
      const updV = await tx.run("UPDATE withdrawals SET status = ?, decided_at = ?, decided_by = ?, admin_note = ? WHERE id = ? AND status = 'approved'", ['revoked', t, adminId, adminNote, withdrawalId]);
      if (updV.changes === 0) throw new Error('Withdrawal was already decided by another process — please refresh.');
      // v17.1: revoke-before-payout refunds the FULL hold (createWithdrawal
      // holds the full amount; the fee was never earned). Reject already
      // refunds full; revoke now matches it.
      await postLedger(tx, { userId: w.user_id, currency: w.currency, type: 'withdrawal_revoke', amount: w.amount, refType: 'withdrawal', refId: w.public_id, meta: { revoked_by: adminId } });
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
    // v16: guarded transition — two concurrent mark-paid clicks must not both
    // succeed (the second now fails cleanly instead of double-recording).
    const upd = await tx.run("UPDATE withdrawals SET status = ?, provider_payout_id = ?, payout_at = ?, decided_by = ? WHERE id = ? AND status = 'approved'",
      ['paid', pid, now(), adminId, withdrawalId]);
    if (upd.changes === 0) throw new Error('Withdrawal was already decided by another process — please refresh.');
    return w;
  });
}

/* v14: agent commissions settle THROUGH the ledger (one postLedger per
   currency) instead of ad-hoc balance edits, and are marked settled so they
   can never be paid twice. */
async function settleAgentCommissions(db, agentId, adminId) {
  const lock = lockSuffix(db);
  return db.transaction(async (tx) => {
    // v16: lock the unsettled rows first. Without this, two concurrent settles
    // on Postgres/MySQL could both read settled=0 and both credit the agent.
    // On SQLite the lock suffix is empty (no FOR UPDATE support) and
    // BEGIN IMMEDIATE already serializes the transaction.
    const rows = await tx.query('SELECT * FROM commissions WHERE agent_id = ? AND settled = 0' + lock, [agentId]);
    if (!rows.length) return { settled: 0, total: 0 };
    const byCur = {};
    for (const r of rows) byCur[r.currency] = (byCur[r.currency] || 0) + Number(r.amount);
    for (const [cur, total] of Object.entries(byCur)) {
      await postLedger(tx, { userId: agentId, currency: cur, type: 'agent_commission', amount: total, refType: 'commission_settlement', refId: 'COM' + now() + '-' + cur + '-' + rows.filter(x => x.currency === cur).map(r => r.id).join('-'), meta: { admin_id: adminId, count: rows.filter(x => x.currency === cur).length } });
    }
    const upd = await tx.run('UPDATE commissions SET settled = 1, settled_at = ? WHERE agent_id = ? AND settled = 0', [now(), agentId]);
    // Guarded UPDATE must cover exactly the rows we credited; anything else
    // means a concurrent settle interfered — roll back instead of double-paying.
    if (upd.changes !== rows.length) throw new Error('Commission settle raced another process — please retry.');
    return { settled: rows.length, total: rows.reduce((a, r) => a + Number(r.amount), 0) };
  });
}

/* v14 referral release: pending referral_credits release only once the
   referee has an approved deposit AND any wagering, and only up to the
   per-referee lifetime cap (0 = unlimited). Over-cap rows are marked
   'capped' (terminal), never left pending forever. Call AFTER the triggering
   transaction commits (deposit approval, ticket buy) — never inside one. */
async function releaseReferralCredits(db, refereeId, settings) {
  // R-087: activity is checked per credit currency inside the loop below
  // (a USD-only referee must not unlock EUR credits). The pre-check here
  // stays currency-blind only as a fast exit; each row is re-gated.
  const dep = await db.get("SELECT COUNT(*) AS c FROM deposits WHERE user_id = ? AND status = 'approved'", [refereeId]);
  if (!dep || Number(dep.c) === 0) return { released: 0, capped: 0 };
  const wag = await db.get("SELECT COALESCE(SUM(ABS(amount)),0) AS s FROM transactions WHERE user_id = ? AND type IN ('ticket_purchase','scratch_purchase')", [refereeId]);
  if (Number(wag.s) <= 0) return { released: 0, capped: 0 };
  const cap = parseInt(getS(settings, 'referral_cap_per_referee', '0'), 10) || 0;
  const lock = lockSuffix(db);
  return db.transaction(async (tx) => {
    // Lock the PENDING rows (row-level FOR UPDATE is legal on Postgres/MySQL;
    // empty on SQLite, where BEGIN IMMEDIATE serializes). A concurrent release
    // blocks on these rows on Postgres/MySQL, so the released-SUM read below
    // always sees committed state. The aggregate SUM itself must NEVER carry
    // FOR UPDATE: Postgres rejects FOR UPDATE on aggregates, and SQLite
    // rejects FOR UPDATE entirely — the v16 code threw on both.
    const pend = await tx.query("SELECT * FROM referral_credits WHERE referee_id = ? AND status = 'pending' ORDER BY created_at, id" + lock, [refereeId]);
    let released = 0, capped = 0;
    for (const row of pend) {
      // R-087: per-currency activity gate for this row's currency.
      const depCur = await tx.get("SELECT COUNT(*) AS c FROM deposits WHERE user_id = ? AND status = 'approved' AND currency = ?", [refereeId, row.currency]);
      const wagCur = await tx.get("SELECT COALESCE(SUM(ABS(amount)),0) AS s FROM transactions WHERE user_id = ? AND type IN ('ticket_purchase','scratch_purchase') AND currency = ?", [refereeId, row.currency]);
      if (!depCur || Number(depCur.c) === 0 || Number(wagCur.s) <= 0) continue;
      if (cap > 0) {
        const rel = await tx.get("SELECT COALESCE(SUM(amount),0) AS s FROM referral_credits WHERE referee_id = ? AND status = 'released'", [refereeId]);
        if (Number(rel.s) + Number(row.amount) > cap) {
          const capUpd = await tx.run("UPDATE referral_credits SET status = 'capped' WHERE id = ? AND status = 'pending'", [row.id]);
          if (capUpd.changes === 1) capped++;
          continue;
        }
      }
      // Claim the row FIRST (guarded): only post the ledger credit if this
      // transaction actually moved the row pending -> released. Posting
      // before claiming could double-credit on a concurrent release.
      const relUpd = await tx.run("UPDATE referral_credits SET status = 'released', released_at = ? WHERE id = ? AND status = 'pending'", [now(), row.id]);
      if (relUpd.changes !== 1) continue;
      await postLedger(tx, { userId: row.referrer_id, currency: row.currency, type: 'referral_commission', amount: Number(row.amount), refType: 'referral_credit', refId: 'RC' + row.id, meta: { referee_id: refereeId, ticket_id: row.ticket_id } });
      released++;
    }
    return { released, capped };
  });
}

module.exports = {
  getWallet, postLedger, getBalances,
  depositPolicy, withdrawalPolicy, verifiedContactOk, chargeFor,
  createDeposit, decideDeposit, createWithdrawal, decideWithdrawal, encodeUserData, decodeUserData,
  checkWithdrawalRules, notePayoutDetails, markWithdrawalPaid,
  settleAgentCommissions, releaseReferralCredits,
};
