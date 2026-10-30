'use strict';
/* Money engine: multi-currency wallets, atomic ledger entries, idempotent
   deposit/withdrawal lifecycle with balance holds, and the deposit/withdrawal
   control matrix (global kill switches + per-user switches + auto/manual). */
const { now, randHex, sha256, fmtMoney, toMinor, decimalsFor } = require('./util');
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

/* H2-02 (v23): duplicate-proof guard. A payment proof (the rail's
   userFields values — tx_hash, UTR, transaction IDs) identifies ONE
   real payment. Before this fix, the same proof could be submitted
   on two deposits and BOTH approved (double credit): provider_txn_id
   is only set by the auto path, after crediting, and manual approvals
   never set it. Identity = same rail + any identical non-empty proof
   value (trimmed, case-insensitive), across ALL users (a provider
   reference is globally unique; another account reusing it is the
   fraud this stops), on deposits still live (pending/approved).
   user_data may be encrypted at rest, so candidates are decoded in
   JS — the same approach as the webhook proof matcher (R-115). */
function proofValuesFor(railKey, userData) {
  try {
    const rail = require('./rails').getRail(railKey);
    const fields = (rail && rail.userFields) || [];
    const out = {};
    for (const f of fields) {
      /* Identity uses REFERENCE fields only. Descriptive fields (the
         sender's name or email, an agent location, an account label)
         repeat legitimately across a player's own deposits — treating
         them as payment identity would block a player's second real
         deposit. Reference values (transaction hashes, UTRs, receipt
         codes, voucher PINs, transfer references) are unique per
         payment by construction. */
      if (PROOF_DESCRIPTIVE_KEYS.has(f.key)) continue;
      const v = String((userData || {})[f.key] || '').trim().toLowerCase();
      if (v) out[f.key] = v;
    }
    return out;
  } catch { return {}; }
}
const PROOF_DESCRIPTIVE_KEYS = new Set(['sender_name', 'sender_email', 'agent_location', 'account_name', 'account_label']);
async function findDuplicateProof(db, { railKey, userData, excludeId = 0 }) {
  const mine = proofValuesFor(railKey, userData);
  if (!Object.keys(mine).length) return null;
  const cands = await db.query(
    `SELECT d.id, d.public_id, d.user_data FROM deposits d JOIN payment_methods m ON m.id = d.method_id
     WHERE m.rail = ? AND d.status IN ('pending','approved') AND d.id != ? ORDER BY d.created_at ASC LIMIT 1000`,
    [railKey, excludeId]);
  for (const c of cands) {
    const theirs = proofValuesFor(railKey, decodeUserData(c.user_data));
    for (const k of Object.keys(mine)) if (theirs[k] && theirs[k] === mine[k]) return { depositId: c.id, publicId: c.public_id, field: k };
  }
  return null;
}

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
  // DS-013/DS-038: player-facing reasons are NEUTRAL. The true reason
  // (global toggle off, per-user block, unverified contact) is operator-
  // internal state and must never be announced to players; support can see
  // the real state in the admin panel. The actionable part (verify your own
  // contact) stays, minus the internal staff-attestation hint.
  if (!getBool(settings, 'deposits_enabled', true)) return { allowed: false, code: 'global_off', reason: 'Deposits are unavailable right now. Please try again later or contact support.' };
  if (user.deposit_blocked) return { allowed: false, code: 'user_blocked', reason: 'Deposits are unavailable right now. Please try again later or contact support.' };
  if (!verifiedContactOk(settings, user)) return { allowed: false, code: 'unverified', reason: 'Verify your email or phone before depositing. Go to Profile → Verify contact to finish verification.' };
  const mode = user.deposit_mode || getS(settings, 'deposit_mode', 'manual');
  return { allowed: true, mode };
}
function withdrawalPolicy(settings, user) {
  // DS-013/DS-038: neutral player wording (see depositPolicy).
  if (!getBool(settings, 'withdrawals_enabled', true)) return { allowed: false, code: 'global_off', reason: 'Withdrawals are unavailable right now. Please try again later or contact support.' };
  if (user.withdrawal_blocked) return { allowed: false, code: 'user_blocked', reason: 'Withdrawals are unavailable right now. Please try again later or contact support.' };
  if (!verifiedContactOk(settings, user)) return { allowed: false, code: 'unverified', reason: 'Verify your email or phone before withdrawing. Go to Profile → Verify contact to finish verification.' };
  const mode = user.withdrawal_mode || getS(settings, 'withdrawal_mode', 'manual');
  return { allowed: true, mode };
}

/* D1-C4 (v20): net wagered = game purchases MINUS draw refunds, floored
   at 0. A draw_refund returns the stake of a ticket_purchase, so a fully
   refunded purchase was never really wagered; counting it gross let a
   player pass the withdrawal turnover gate (and the referral wagering
   gate) on money that was never at risk. Every consumer of the wagered
   sum uses this ONE SQL fragment so the gates can never drift apart.
   scratch_purchase has no refund type (scratch stakes are never
   refunded), so only draw_refund nets. */
const NET_WAGERED_SQL = "SELECT COALESCE(SUM(CASE WHEN type IN ('ticket_purchase','scratch_purchase') THEN ABS(amount) ELSE 0 END),0) - COALESCE(SUM(CASE WHEN type = 'draw_refund' THEN ABS(amount) ELSE 0 END),0) AS raw FROM transactions WHERE user_id = ?";
function netWagered(rawRow) { return Math.max(0, Number(rawRow && rawRow.raw) || 0); }

function chargeFor(method, amountMinor) {
  const fixed = Number(method.fixed_charge || 0);
  const pct = Number(method.percent_charge || 0);
  // Charges can never be negative: a negative percent/rate (see method
  // create/edit validation) must not turn a fee into a payout.
  return Math.max(0, Math.round(fixed + (amountMinor * pct) / 100));
}

/* H2-05 (v23): global caps are TYPED by the owner as a plain amount
   ("500") that applies per currency (the Limits hub labels say exactly
   that) and STORED as hundredths of that amount (toMinor at the admin
   doors). Enforcement must therefore express the typed amount in the
   TRANSACTION currency's minor units: typed x 10^decimals(currency).
   The old raw compare made a "500" cap mean 500.00 on 2-decimal
   currencies but ¥50,000 on JPY and 50.000 on KWD. For 2-decimal
   currencies this returns the stored value unchanged. */
function capMinorForCurrency(settings, storedCap, currency) {
  const stored = parseInt(storedCap, 10) || 0;
  if (stored <= 0) return 0;
  const dec = decimalsFor(currency, getCurrencies(settings));
  return Math.round(stored * (10 ** (dec - 2)));
}

/* Row-lock suffix for SELECT ... FOR UPDATE. SQLite has NO FOR UPDATE
   support at all (node:sqlite throws a syntax error), so on SQLite the
   suffix must be empty — BEGIN IMMEDIATE already serializes the whole
   transaction. Postgres/MySQL need the real suffix for concurrency safety.
   (v16 wrongly claimed SQLite treats FOR UPDATE as a no-op; it throws.) */
function lockSuffix(db) {
  return db && db.driver === 'sqlite' ? '' : ' FOR UPDATE';
}

/* ---------- CURRENCY-SYSTEM-01: wallet exchange ----------
   A player converts between THEIR OWN wallets at the ADMIN-SET rate
   (currencies settings; rate = units per 1 base unit). There is no FX
   feed and the UI must never call this a "live market rate".
   Honesty rules enforced here:
   - conversion happens ONLY through this action (stored money never
     silently converts anywhere else; equivalents elsewhere are
     display-only and marked with the approx sign);
   - the credited amount is rounded DOWN to the destination minor
     unit, so rounding can never mint value;
   - an unknown or zero rate FAILS CLOSED (no 1:1 fallback, ever);
   - the optional exchange_fee_percent comes off the converted amount
     and is snapshotted in both ledger rows' meta with the rates. */
function exchangeQuote(currencies, from, to, amountMinor, feePercent) {
  const f = (currencies || []).find(c => c.code === from);
  const t = (currencies || []).find(c => c.code === to);
  if (!f || !t || !Number.isFinite(Number(f.rate)) || !Number.isFinite(Number(t.rate)) || Number(f.rate) <= 0 || Number(t.rate) <= 0)
    throw new Error('Exchange is not available for this currency pair right now.');
  /* H2-01 (v23): decimal-scale adjustment, same fix as convertMinor —
     gross must be expressed in DESTINATION minor units: multiply by
     10^(decTo - decFrom) (JPY 0, USD/EUR 2, KWD 3). Flooring stays:
     rounding can never mint value. */
  const scale = 10 ** (decimalsFor(to, currencies) - decimalsFor(from, currencies));
  const gross = Math.floor(Number(amountMinor) * (Number(t.rate) / Number(f.rate)) * scale);
  const fee = Math.floor(gross * (Number(feePercent) || 0) / 100);
  return { gross, fee, credit: gross - fee, rateFrom: Number(f.rate), rateTo: Number(t.rate) };
}
async function exchangeCurrency(db, { userId, from, to, amountMinor, settings }) {
  if (from === to) throw new Error('Pick two different currencies to exchange.');
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('Enter a valid amount.');
  const currencies = getCurrencies(settings);
  const feePercent = parseFloat(getS(settings, 'exchange_fee_percent', '0')) || 0;
  const q = exchangeQuote(currencies, from, to, amountMinor, feePercent);
  if (q.credit <= 0) throw new Error('That amount is too small to exchange at the current rate.');
  const pairRef = 'X' + now().toString(36).toUpperCase() + randHex(3).toUpperCase();
  await db.transaction(async (tx) => {
    const meta = { pair: pairRef, rate_from: q.rateFrom, rate_to: q.rateTo, fee_percent: feePercent, fee_amount: q.fee, gross: q.gross };
    await postLedger(tx, { userId, currency: from, type: 'exchange_out', amount: -amountMinor, refType: 'exchange', refId: pairRef, meta });
    await postLedger(tx, { userId, currency: to, type: 'exchange_in', amount: q.credit, refType: 'exchange', refId: pairRef, meta });
  });
  return { pairRef, ...q };
}

/* ---------- deposits ---------- */
async function createDeposit(db, { userId, method, amountMinor, userData = {}, idempotencyKey = null, settings = null }) {
  const key = idempotencyKey || ('dep_' + randHex(16));
  // R-022/R-077: engine-level validation + net can never go negative.
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('Invalid deposit amount');
  // U-21: malformed payment proof (e.g. a truncated crypto tx hash or a
  // non-UTR reference) is rejected with its true reason at the engine,
  // not stored for an admin to discover. Only formats fixed by the
  // payment system are checked, and only when a value was submitted.
  { const proofErr = require('./rails').validateUserProof(method && method.rail, userData); if (proofErr) throw new Error(proofErr); }
  /* H2-02: the same proof must never fund two deposits. At CREATION
     time this refusal applies to non-AUTO methods, where the player's
     proof is the only evidence of payment. On AUTO methods the deposit
     is created pending and the provider-side guards decide credit (a
     capture already consumed by another deposit never credits — the
     pre-existing B4 contract in test/auto-integration.test.js); the
     approve-time duplicate check inside decideDeposit covers every
     mode as the last line, including a manual approval of an AUTO
     deposit. */
  if (!method || (method.processing_mode || 'manual') !== 'auto') {
    const dup = await findDuplicateProof(db, { railKey: method && method.rail, userData });
    if (dup) throw new Error('This payment proof has already been submitted for another deposit. If you believe this is a mistake, please contact support.');
  }
  /* ADMIN-CLARITY-01 + H2-05 (v23): GLOBAL deposit caps
     (deposit_daily_cap / deposit_monthly_cap). The stored value is the
     Limits hub's typed amount x100; capMinorForCurrency scales it into
     each currency's own minor units, so the typed amount means the
     same in every currency (0 = unlimited).
     One setting applies to every player ("ek sath sab ki"); the sums
     are per player per currency, exactly mirroring the withdrawal-cap
     semantics below (same UTC day/month windows, same committed-status
     treatment: pending + approved deposits count, rejected/revoked do
     not). Enforced here at the engine so no route can bypass it; the
     message is plain player language with no operator internals. */
  if (settings) {
    const fm = (x) => fmtMoney(x, method.currency);
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const dCap = capMinorForCurrency(settings, getS(settings, 'deposit_daily_cap', '0'), method.currency);
    if (dCap > 0) {
      const row = await db.get(`SELECT COALESCE(SUM(amount),0) AS s FROM deposits WHERE user_id = ? AND currency = ? AND status IN ('pending','approved') AND created_at >= ?`, [userId, method.currency, dayStart.getTime()]);
      if (Number(row.s) + amountMinor > dCap) throw new Error(`Daily deposit limit of ${fm(dCap, method.currency)} reached. Please try again tomorrow, or contact support if you need a higher limit.`);
    }
    const mCap = capMinorForCurrency(settings, getS(settings, 'deposit_monthly_cap', '0'), method.currency);
    if (mCap > 0) {
      const row = await db.get(`SELECT COALESCE(SUM(amount),0) AS s FROM deposits WHERE user_id = ? AND currency = ? AND status IN ('pending','approved') AND created_at >= ?`, [userId, method.currency, monthStart.getTime()]);
      if (Number(row.s) + amountMinor > mCap) throw new Error(`Monthly deposit limit of ${fm(mCap, method.currency)} reached. Please try again next month, or contact support if you need a higher limit.`);
    }
  }
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

async function decideDeposit(db, depositId, decision, adminId, settings = null, decisionReason = '') {
  /* U-28.1: decisionReason is the PLAYER-FACING reason captured on the
     decision form (stored in deposits.decision_reason, the only reason
     the wallet ever reads). It is deliberately separate from the
     internal admin_note, which decideDeposit never touches. */
  const playerReason = String(decisionReason || '').slice(0, 500);
  // DS-019: optional deposit bonus. When settings carry a positive
  // deposit_bonus_percent, approving credits floor(net x pct / 100) as a
  // separate 'bonus' ledger row; revoking claws the bonus back in the same
  // transaction. With no settings (or 0%), behaviour is unchanged.
  // decision: approve | reject | revoke
  const decided = await db.transaction(async (tx) => {
    const d = await tx.get('SELECT * FROM deposits WHERE id = ?', [depositId]);
    if (!d) throw new Error('Deposit not found');
    const t = now();
    if (decision === 'approve') {
      if (d.status !== 'pending') throw new Error('Only pending deposits can be approved');
      /* H2-02: re-check the proof at decision time (a duplicate may
         have been submitted after this deposit was created). Blocks
         the approval inside the same transaction — no credit posts. */
      { const mRow = await tx.get('SELECT rail FROM payment_methods WHERE id = ?', [d.method_id]);
        if (mRow) { const dup = await findDuplicateProof(tx, { railKey: mRow.rail, userData: decodeUserData(d.user_data), excludeId: d.id });
          if (dup) throw new Error('Duplicate payment proof: this proof is already used on deposit ' + dup.publicId + ' — approval blocked to prevent a double credit.'); } }
      // v16: guarded transition. Under Postgres/MySQL READ COMMITTED two
      // concurrent approves could both read 'pending' and both credit the
      // user. The WHERE status clause makes the second UPDATE a no-op and
      // the changes check turns it into a clean failure, not a double credit.
      const updA = await tx.run("UPDATE deposits SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ? WHERE id = ? AND status = 'pending'", ['approved', t, adminId, playerReason, depositId]);
      if (updA.changes === 0) throw new Error('Deposit was already decided by another process — please refresh.');
      /* D1-C1 (v20): a net-ZERO deposit (charge == amount, e.g. a legacy
         100%-fee method saved before the >=100% save validation) must
         still be decidable: postLedger rightly refuses a 0 amount, so a
         zero net credits NOTHING — the status transition stands, the
         charge stays recorded on the deposit row itself, no ledger post
         is made, and the zero-credit approval is audited. */
      if (Number(d.net) > 0) {
        await postLedger(tx, { userId: d.user_id, currency: d.currency, type: 'deposit', amount: d.net, refType: 'deposit', refId: d.public_id, meta: { method_id: d.method_id } });
      } else {
        await require('./audit').log(tx, { actorId: adminId, actorRole: 'admin', action: 'deposit.approve_zero_net', entity: 'deposit', entityId: d.public_id, detail: { amount: d.amount, charge: d.charge, net: 0, note: 'approved with zero credit: charge consumed the full amount' } }, { throwOnError: true });
      }
      if (settings) {
        const pct = parseFloat(getS(settings, 'deposit_bonus_percent', '0')) || 0;
        const bonus = pct > 0 ? Math.floor(Number(d.net) * pct / 100) : 0;
        if (bonus > 0) {
          await postLedger(tx, { userId: d.user_id, currency: d.currency, type: 'bonus', amount: bonus, refType: 'deposit', refId: d.public_id, meta: { percent: pct, kind: 'deposit_bonus' } });
          /* H2-06 (v23): the deposit bonus is a BONUS, not cash — it
             must live in the wagering system like every campaign
             grant. Before this, no bonus_grants row existed, so
             unmetWagering never saw it and the bonus was withdrawable
             as plain cash. Rule (stated in the settings help): the
             bonus must be wagered 1x its own amount before it can be
             withdrawn. campaign_id 0 = not a campaign grant. */
          await tx.run('INSERT INTO bonus_grants (campaign_id, user_id, amount, currency, trigger_type, wagering_required, wagered, created_at) VALUES (0, ?, ?, ?, ?, ?, 0, ?)',
            [d.user_id, bonus, d.currency, 'deposit_bonus', bonus, t]);
        }
      }
    } else if (decision === 'reject') {
      if (d.status !== 'pending') throw new Error('Only pending deposits can be rejected');
      const updR = await tx.run("UPDATE deposits SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ? WHERE id = ? AND status = 'pending'", ['rejected', t, adminId, playerReason, depositId]);
      if (updR.changes === 0) throw new Error('Deposit was already decided by another process — please refresh.');
    } else if (decision === 'revoke') {
      if (d.status !== 'approved') throw new Error('Only approved deposits can be revoked');
      const updV = await tx.run("UPDATE deposits SET status = ?, decided_at = ?, decided_by = ?, decision_reason = ? WHERE id = ? AND status = 'approved'", ['revoked', t, adminId, playerReason, depositId]);
      if (updV.changes === 0) throw new Error('Deposit was already decided by another process — please refresh.');
      if (Number(d.net) > 0) await postLedger(tx, { userId: d.user_id, currency: d.currency, type: 'deposit_revoke', amount: -d.net, refType: 'deposit', refId: d.public_id, meta: { revoked_by: adminId } });
      // DS-019: claw back any bonus this deposit earned (same transaction).
      const brow = await tx.get("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE type = 'bonus' AND ref_type = 'deposit' AND ref_id = ?", [d.public_id]);
      const bsum = brow ? Number(brow.s) : 0;
      if (bsum > 0) {
        await postLedger(tx, { userId: d.user_id, currency: d.currency, type: 'bonus_revoke', amount: -bsum, refType: 'deposit', refId: d.public_id, meta: { revoked_by: adminId } });
        /* H2-06: the wagering grant dies with the clawback (the oldest
           matching deposit-bonus grant for this user/currency/amount). */
        const g = await tx.get("SELECT id FROM bonus_grants WHERE campaign_id = 0 AND trigger_type = 'deposit_bonus' AND user_id = ? AND currency = ? AND amount = ? ORDER BY id ASC LIMIT 1", [d.user_id, d.currency, bsum]);
        if (g) await tx.run('DELETE FROM bonus_grants WHERE id = ?', [g.id]);
      }
    } else throw new Error('Unknown decision');
    return d;
  });
  // SMART-ADMIN bonus engine: a first-deposit campaign fires on the FIRST
  // approved deposit (post-commit, own transaction; failure never breaks
  // the deposit decision itself).
  if (decision === 'approve' && settings) {
    try { await require('./bonus').onFirstDeposit(db, settings, decided.user_id, decided.net, decided.currency); } catch {}
  }
  return decided;
}

/* ---------- withdrawals (hold on create, release on decide) ---------- */
async function createWithdrawal(db, { userId, method, amountMinor, userData = {}, idempotencyKey = null, settings = null, user = null }) {
  const key = idempotencyKey || ('wd_' + randHex(16));
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('Invalid withdrawal amount');
  { const proofErr = require('./rails').validateUserProof(method && method.rail, userData); if (proofErr) throw new Error(proofErr); }
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

async function decideWithdrawal(db, withdrawalId, decision, adminId, adminNote = '', decisionReason = '') {
  /* U-28.1: adminNote stays INTERNAL (admin_note); decisionReason is the
     PLAYER-FACING reason (decision_reason) — the only one the wallet
     reads. A blank adminNote no longer wipes a previously saved internal
     note at decision time; an explicit note (e.g. the auto-approval
     stamp) still replaces it. */
  const playerReason = String(decisionReason || '').slice(0, 500);
  return db.transaction(async (tx) => {
    const w = await tx.get('SELECT * FROM withdrawals WHERE id = ?', [withdrawalId]);
    if (!w) throw new Error('Withdrawal not found');
    const t = now();
    const noteToStore = adminNote !== '' ? adminNote : (w.admin_note || '');
    if (decision === 'approve') {
      if (w.status !== 'pending') throw new Error('Only pending withdrawals can be approved');
      // v16: guarded transition (same double-decide race as deposits).
      const updA = await tx.run("UPDATE withdrawals SET status = ?, decided_at = ?, decided_by = ?, admin_note = ?, decision_reason = ? WHERE id = ? AND status = 'pending'", ['approved', t, adminId, noteToStore, playerReason, withdrawalId]);
      if (updA.changes === 0) throw new Error('Withdrawal was already decided by another process — please refresh.');
      // Hold becomes permanent: createWithdrawal already debited the FULL amount,
      // and the user is paid only the net outside the app. NOTHING is posted
      // back here — the old code credited +charge to the user on approve,
      // which refunded the fee instead of retaining it (house leaked the fee
      // on every charged withdrawal). The fee is retained implicitly: the
      // wallet stays down by the full amount while only the net is paid out.
    } else if (decision === 'reject') {
      if (w.status !== 'pending') throw new Error('Only pending withdrawals can be rejected');
      const updR = await tx.run("UPDATE withdrawals SET status = ?, decided_at = ?, decided_by = ?, admin_note = ?, decision_reason = ? WHERE id = ? AND status = 'pending'", ['rejected', t, adminId, noteToStore, playerReason, withdrawalId]);
      if (updR.changes === 0) throw new Error('Withdrawal was already decided by another process — please refresh.');
      await postLedger(tx, { userId: w.user_id, currency: w.currency, type: 'withdrawal_release', amount: w.amount, refType: 'withdrawal', refId: w.public_id, meta: { note: 'hold released' } });
    } else if (decision === 'revoke') {
      if (w.status !== 'approved') throw new Error('Only approved withdrawals can be revoked');
      const updV = await tx.run("UPDATE withdrawals SET status = ?, decided_at = ?, decided_by = ?, admin_note = ?, decision_reason = ? WHERE id = ? AND status = 'approved'", ['revoked', t, adminId, noteToStore, playerReason, withdrawalId]);
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
   Returns { ok, reason, fingerprint, changeDetected, promotePending }.
   Payout-lock semantics (RT-20 rework): a payout-detail CHANGE is first
   recorded as PENDING (payout_pending_fingerprint + payout_change_at) and
   withdrawals to the NEW details are locked for payout_lock_hours
   (default 48). The ACTIVE fingerprint is never replaced by a blocked
   attempt, so the original details keep working during the window; the
   pending change is promoted to active only by a successful, verified
   withdrawal to the new details after the window expires. Retries with
   the same new details do not refresh the clock. First-ever details are
   free (recorded on first success, no lock). */
function sortObject(o) {
  const out = {};
  for (const k of Object.keys(o || {}).sort()) out[k] = o[k];
  return out;
}

async function checkWithdrawalRules(db, settings, user, method, amountMinor, userData = {}, excludeWithdrawalId = 0) {
  const cur = method.currency;
  const currencies = getCurrencies(settings);
  const m = (x) => fmtMoney(x, cur, currencies);
  if (getBool(settings, 'withdrawal_turnover_required', true)) {
    const dep = await db.get("SELECT COALESCE(SUM(net),0) AS s FROM deposits WHERE user_id = ? AND status = 'approved' AND currency = ?", [user.id, cur]);
    const wag = await db.get(NET_WAGERED_SQL + " AND currency = ?", [user.id, cur]);
    const deposited = Number(dep.s), wagered = netWagered(wag);
    if (wagered < deposited) {
      return { ok: false, reason: `Wagering requirement not met: you have wagered ${m(wagered)} of ${m(deposited)} deposited. Wager ${m(deposited - wagered)} more before withdrawing.`, fingerprint: null, changeDetected: false };
    }
  }
  // SMART-ADMIN: unmet BONUS wagering (promotional credit granted with a
  // play-through rule) blocks withdrawal until played through. Zero unmet
  // = zero effect (the common case; table-guarded for legacy fixtures).
  const unmetBonus = await require('./bonus').unmetWagering(db, user.id, cur);
  if (unmetBonus > 0) return { ok: false, reason: 'A bonus wagering requirement is not met yet. Wager ' + m(unmetBonus) + ' more before withdrawing.', fingerprint: null, changeDetected: false };
  const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const dailyCap = capMinorForCurrency(settings, getS(settings, 'withdrawal_daily_cap', '0'), cur);
  if (dailyCap > 0) {
    /* SCAN fix (B-01): excludeWithdrawalId lets the BP-22 decision-time
       re-check exclude the withdrawal being decided — it is already
       'pending', so without the exclusion its amount was counted twice
       (once in the SUM, once as amountMinor) and auto-approval silently
       died for any amount over half the cap. */
    const row = await db.get(`SELECT COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE user_id = ? AND status IN ('pending','approved','paid') AND currency = ? AND created_at >= ? AND id != ?`, [user.id, cur, dayStart.getTime(), excludeWithdrawalId]);
    if (Number(row.s) + amountMinor > dailyCap) return { ok: false, reason: `Daily withdrawal limit of ${m(dailyCap)} reached.`, fingerprint: null, changeDetected: false };
  }
  const monthlyCap = capMinorForCurrency(settings, getS(settings, 'withdrawal_monthly_cap', '0'), cur);
  if (monthlyCap > 0) {
    const row = await db.get(`SELECT COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE user_id = ? AND status IN ('pending','approved','paid') AND currency = ? AND created_at >= ? AND id != ?`, [user.id, cur, monthStart.getTime(), excludeWithdrawalId]);
    if (Number(row.s) + amountMinor > monthlyCap) return { ok: false, reason: `Monthly withdrawal limit of ${m(monthlyCap)} reached.`, fingerprint: null, changeDetected: false };
  }
  const lockHours = parseInt(getS(settings, 'payout_lock_hours', '48'), 10) || 0;
  const fp = sha256(JSON.stringify(sortObject(userData)));
  const u = await db.get('SELECT payout_fingerprint, payout_pending_fingerprint, payout_change_at FROM users WHERE id = ?', [user.id]);
  const stored = (u && u.payout_fingerprint) || '';
  const pendingFp = (u && u.payout_pending_fingerprint) || '';
  const changeAt = (u && Number(u.payout_change_at)) || 0;
  const inWindow = lockHours > 0 && changeAt > now() - lockHours * 3600000;
  let promotePending = false;
  if (stored && stored !== fp) {
    if (pendingFp && pendingFp === fp) {
      if (inWindow) {
        // Retry with the pending details while the lock runs: blocked,
        // clock NOT refreshed.
        return { ok: false, reason: `Payout details were changed recently. Withdrawals to new details are locked for ${lockHours} hours after a payout-detail change.`, fingerprint: fp, changeDetected: false };
      }
      promotePending = true; // window expired: success promotes the change
    } else if (lockHours > 0) {
      // First sight of this change: blocked; the caller records it as
      // PENDING only - the active fingerprint is NOT replaced (RT-20).
      return { ok: false, reason: `Payout details changed. For your security, withdrawals to new payout details are locked for ${lockHours} hours. Your previous payout details are unaffected.`, fingerprint: fp, changeDetected: true };
    } else {
      promotePending = true; // lock disabled: success promotes immediately
    }
  }
  if (getBool(settings, 'withdrawal_same_method', false)) {
    const used = await db.get('SELECT COUNT(*) AS c FROM deposits WHERE user_id = ? AND method_id = ? AND status = ?', [user.id, method.id, 'approved']);
    if (!used || Number(used.c) === 0) return { ok: false, reason: 'Withdrawals must use a payment method you have deposited with before.', fingerprint: fp, changeDetected: false };
  }
  return { ok: true, reason: '', fingerprint: fp, changeDetected: false, promotePending };
}

/* RT-20: a blocked first attempt records the change as PENDING only. */
async function notePendingPayoutChange(db, userId, fingerprint) {
  await db.run('UPDATE users SET payout_pending_fingerprint = ?, payout_change_at = ? WHERE id = ?', [fingerprint, now(), userId]);
}
/* A successful verified withdrawal to ripe pending details promotes them
   to the active fingerprint and clears the pending record. */
async function promotePayoutDetails(db, userId, fingerprint) {
  await db.run("UPDATE users SET payout_fingerprint = ?, payout_updated_at = ?, payout_pending_fingerprint = '', payout_change_at = 0 WHERE id = ?", [fingerprint, now(), userId]);
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
    let rows;
    try { rows = await tx.query('SELECT * FROM commissions WHERE agent_id = ? AND settled = 0 AND COALESCE(voided, 0) = 0' + lock, [agentId]); }
    catch (e) { if (!/voided/i.test(e.message)) throw e; rows = await tx.query('SELECT * FROM commissions WHERE agent_id = ? AND settled = 0' + lock, [agentId]); }
    if (!rows.length) return { settled: 0, total: 0 };
    const byCur = {};
    for (const r of rows) byCur[r.currency] = (byCur[r.currency] || 0) + Number(r.amount);
    for (const [cur, total] of Object.entries(byCur)) {
      /* D1-C2 (v20): a per-currency total of exactly 0 (an agent whose
         only rows are legacy zero commissions) is a NO-OP success, not
         a postLedger throw that wedged the agent's settlement forever:
         post nothing, and the rows are still marked settled below. A
         non-positive total can never be a ledger post. */
      if (!(total > 0)) continue;
      await postLedger(tx, { userId: agentId, currency: cur, type: 'agent_commission', amount: total, refType: 'commission_settlement', refId: 'COM' + now() + '-' + cur + '-' + rows.filter(x => x.currency === cur).map(r => r.id).join('-'), meta: { admin_id: adminId, count: rows.filter(x => x.currency === cur).length } });
    }
    let upd;
    try { upd = await tx.run('UPDATE commissions SET settled = 1, settled_at = ? WHERE agent_id = ? AND settled = 0 AND COALESCE(voided, 0) = 0', [now(), agentId]); }
    catch (e) { if (!/voided/i.test(e.message)) throw e; upd = await tx.run('UPDATE commissions SET settled = 1, settled_at = ? WHERE agent_id = ? AND settled = 0', [now(), agentId]); }
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
  const wag = await db.get(NET_WAGERED_SQL, [refereeId]);
  if (netWagered(wag) <= 0) return { released: 0, capped: 0 };
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
      const wagCur = await tx.get(NET_WAGERED_SQL + " AND currency = ?", [refereeId, row.currency]);
      if (!depCur || Number(depCur.c) === 0 || netWagered(wagCur) <= 0) continue;
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

/* ---------- BP-22 (v19): auto-withdrawal approval limits ----------
   A deliberate operator pre-authorization: at withdrawal creation, when
   the amount is at/under the effective limit AND every existing gate
   still passes, the system approves the withdrawal itself (status
   'approved', decided_by = 0 = system, audit 'withdrawal.auto_approve').
   It NEVER marks anything 'paid': payout still happens only through the
   existing mark-paid path (admin, with a provider payout ID). There is
   no gateway payout executor in this codebase, so auto = approve-only.
   Effective limit: users.auto_withdrawal_limit (major units as typed;
   NULL/blank = follow global) else setting auto_withdrawal_limit;
   0 = OFF (manual review for everything — the shipped default).
   Unparseable values fail closed (0). */
const kycLib = require('./kyc');
const auditLib = require('./audit');
function autoWithdrawalLimitMinor(s, user, currency) {
  const perUser = user ? user.auto_withdrawal_limit : null;
  const raw = perUser !== null && perUser !== undefined && String(perUser).trim() !== ''
    ? String(perUser) : getS(s, 'auto_withdrawal_limit', '0');
  const minor = toMinor(raw, decimalsFor(currency, getCurrencies(s)));
  return minor === null || minor === undefined || Number.isNaN(minor) ? 0 : minor;
}
async function maybeAutoApproveWithdrawal(db, s, publicId) {
  try {
    const w = await db.get('SELECT * FROM withdrawals WHERE public_id = ?', [publicId]);
    if (!w || w.status !== 'pending') return { auto: false, reason: 'not_pending' };
    const user = await db.get('SELECT * FROM users WHERE id = ?', [w.user_id]);
    if (!user) return { auto: false, reason: 'no_user' };
    const limitMinor = autoWithdrawalLimitMinor(s, user, w.currency);
    if (limitMinor <= 0) return { auto: false, reason: 'limit_off' };
    if (w.amount > limitMinor) return { auto: false, reason: 'over_limit', limitMinor };
    /* Safety re-checks at decision time — any bite and the withdrawal
       simply stays on the existing manual path, never auto. */
    if (!getBool(s, 'withdrawals_enabled')) return { auto: false, reason: 'withdrawals_frozen' };
    const policy = withdrawalPolicy(s, user);
    if (!policy.allowed) return { auto: false, reason: 'policy_blocked' };
    if (kycLib.kycBlock(s, user, 'withdraw').blocked) return { auto: false, reason: 'kyc_blocked' };
    const method = await db.get('SELECT * FROM payment_methods WHERE id = ?', [w.method_id]);
    if (!method) return { auto: false, reason: 'no_method' };
    const rules = await checkWithdrawalRules(db, s, user, method, w.amount, decodeUserData(w.user_data), w.id);
    if (!rules.ok) return { auto: false, reason: 'rules_blocked' };
    if (rules.changeDetected || rules.promotePending) return { auto: false, reason: 'payout_details_unsettled' };
    const note = `Auto-approved by system (amount ${w.amount} at/under limit ${limitMinor}, minor units, ${w.currency}; operator pre-authorization). Payout still requires the normal mark-paid step.`;
    await decideWithdrawal(db, w.id, 'approve', 0, note);
    await auditLib.log(db, { actorId: null, actorRole: 'system', action: 'withdrawal.auto_approve', entity: 'withdrawal', entityId: String(w.id), detail: { public_id: w.public_id, user_id: w.user_id, amount: w.amount, currency: w.currency, limit_minor: limitMinor, decided_by: 0 } });
    return { auto: true, limitMinor };
  } catch (e) {
    /* An auto-approval failure must never break the withdrawal itself:
       it stays pending for manual review, and no money moves here. */
    return { auto: false, reason: 'error', error: e.message };
  }
}

module.exports = {
  getWallet, postLedger, getBalances,
  depositPolicy, withdrawalPolicy, verifiedContactOk, chargeFor,
  createDeposit, decideDeposit, createWithdrawal, decideWithdrawal, encodeUserData, decodeUserData,
  findDuplicateProof, proofValuesFor,
  exchangeQuote, exchangeCurrency,
  checkWithdrawalRules, notePayoutDetails, notePendingPayoutChange, promotePayoutDetails, markWithdrawalPaid,
  settleAgentCommissions, releaseReferralCredits,
  autoWithdrawalLimitMinor, maybeAutoApproveWithdrawal,
};
