'use strict';
/* Nightly ledger reconciliation (v14): proves wallets == ledger, per user and
   per currency, and lists deposits that claim a provider transaction but have
   no matching webhook event (PSP confirmation gap — closing that gap
   automatically needs merchant credentials; until then the gap is REPORTED,
   never hidden). Mismatches are stored in reconciliation_reports, audit-logged,
   and surfaced on the admin dashboard. */
const { now } = require('./util');
const audit = require('./audit');

async function runReconciliation(db) {
  const wallets = await db.query('SELECT user_id, currency, balance FROM wallets');
  const sums = await db.query('SELECT user_id, currency, COALESCE(SUM(amount),0) AS s FROM transactions GROUP BY user_id, currency');
  const sumMap = new Map(sums.map(r => [r.user_id + '|' + r.currency, Number(r.s)]));
  const walletKeys = new Set(wallets.map(w => w.user_id + '|' + w.currency));
  const mismatches = [];
  for (const w of wallets) {
    const expected = sumMap.get(w.user_id + '|' + w.currency) || 0;
    if (Number(w.balance) !== expected) {
      mismatches.push({ user_id: w.user_id, currency: w.currency, wallet: Number(w.balance), ledger: expected, diff: Number(w.balance) - expected });
    }
  }
  // Transactions with no wallet row at all (postLedger always creates the row,
  // so this should never happen — if it does, it is a real integrity break).
  for (const s of sums) {
    if (!walletKeys.has(s.user_id + '|' + s.currency) && Number(s.s) !== 0) {
      mismatches.push({ user_id: s.user_id, currency: s.currency, wallet: null, ledger: Number(s.s), diff: -Number(s.s) });
    }
  }
  const unconfirmed = await db.query(
    `SELECT d.id, d.public_id, d.provider_txn_id FROM deposits d
     WHERE d.provider_txn_id IS NOT NULL AND d.provider_txn_id != ''
     AND NOT EXISTS (SELECT 1 FROM webhook_events w WHERE w.deposit_id = d.id) LIMIT 100`);
  const staleProof = await db.query(
    `SELECT id, public_id FROM deposits WHERE status = 'pending' AND created_at < ? AND user_data != '{}' AND user_data != '' LIMIT 100`,
    [now() - 7 * 86400000]);
  const details = { mismatches, unconfirmed_provider_txns: unconfirmed, stale_proof_deposits: staleProof };
  const r = await db.run(
    'INSERT INTO reconciliation_reports (checked_at, wallets_checked, mismatch_count, details, created_at) VALUES (?, ?, ?, ?, ?)',
    [now(), wallets.length, mismatches.length, JSON.stringify(details), now()]);
  await audit.log(db, { actorId: null, actorRole: 'system', action: 'reconcile.run', entity: 'reconciliation', entityId: r.id,
    detail: { wallets_checked: wallets.length, mismatch_count: mismatches.length, unconfirmed: unconfirmed.length, stale_proof: staleProof.length }, ip: '' });
  return { reportId: r.id, wallets_checked: wallets.length, mismatch_count: mismatches.length, unconfirmed: unconfirmed.length, stale_proof: staleProof.length, mismatches };
}

module.exports = { runReconciliation };
