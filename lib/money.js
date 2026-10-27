'use strict';
/* Money engine: multi-currency wallets, atomic ledger entries, idempotent
   deposit/withdrawal lifecycle with balance holds, and the deposit/withdrawal
   control matrix (global kill switches + per-user switches + auto/manual). */
const { now, randHex } = require('./util');
const { getS, getBool, getCurrencies } = require('./settings');

async function getWallet(tx, userId, currency) {
  let w = await tx.get('SELECT * FROM wallets WHERE user_id = ? AND currency = ?', [userId, currency]);
  if (!w) {
    await tx.run('INSERT INTO wallets (user_id, currency, balance) VALUES (?, ?, 0)', [userId, currency]);
    w = { user_id: userId, currency, balance: 0 };
  }
  return w;
}

/* Atomic ledger post. tx = db or transaction handle. Throws on insufficient funds for debits. */
async function postLedger(tx, { userId, currency, type, amount, refType = '', refId = '', meta = {} }) {
  amount = Math.round(Number(amount));
  if (!Number.isFinite(amount) || amount === 0) throw new Error('Invalid ledger amount');
  const w = await getWallet(tx, userId, currency);
  const after = w.balance + amount;
  if (after < 0) throw new Error('Insufficient balance');
  await tx.run('UPDATE wallets SET balance = ? WHERE user_id = ? AND currency = ?', [after, userId, currency]);
  const r = await tx.run(
    'INSERT INTO transactions (user_id, currency, type, amount, balance_after, ref_type, ref_id, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, currency, type, amount, after, refType, String(refId), JSON.stringify(meta), now()]
  );
  return { id: r.id, balanceAfter: after };
}

async function getBalances(db, userId) {
  return db.query('SELECT currency, balance FROM wallets WHERE user_id = ? ORDER BY currency', [userId]);
}

/* ---------- control matrix ---------- */
function depositPolicy(settings, user) {
  if (!getBool(settings, 'deposits_enabled', true)) return { allowed: false, reason: 'Deposits are currently disabled.' };
  if (user.deposit_blocked) return { allowed: false, reason: 'Deposits are disabled for your account.' };
  const mode = user.deposit_mode || getS(settings, 'deposit_mode', 'manual');
  return { allowed: true, mode };
}
function withdrawalPolicy(settings, user) {
  if (!getBool(settings, 'withdrawals_enabled', true)) return { allowed: false, reason: 'Withdrawals are currently disabled.' };
  if (user.withdrawal_blocked) return { allowed: false, reason: 'Withdrawals are disabled for your account.' };
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
      // hold becomes permanent: convert hold into settled withdrawal (charge kept by house).
      // Zero-charge methods have nothing to settle — postLedger rejects a 0 amount,
      // and posting it would roll the whole approval back (withdrawal stuck pending).
      if (w.charge > 0) await postLedger(tx, { userId: w.user_id, currency: w.currency, type: 'withdrawal_settle', amount: w.charge, refType: 'withdrawal', refId: w.public_id, meta: { note: 'hold released, charge retained' } });
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

module.exports = {
  getWallet, postLedger, getBalances,
  depositPolicy, withdrawalPolicy, chargeFor,
  createDeposit, decideDeposit, createWithdrawal, decideWithdrawal,
};
