'use strict';
/* AUTO-INTEGRATION round: the ONE place a provider-verified payment
   outcome is applied to a deposit (PayPal webhook + capture lookup,
   Skrill status report). It deliberately mirrors the generic webhook
   path (routes/webhooks.js) behaviour exactly — decideDeposit's
   guarded transition is the credit itself (a second application
   throws instead of double-crediting), provider_txn_id is recorded,
   the player gets the same 'deposit_approved' / 'deposit_revoked'
   notification an admin approval sends (AUTO-VISIBILITY-01), referral
   credits release, and every outcome is audit-logged under the
   provider's name. Callers MUST have verified the payment with the
   provider (signature + amount + currency) before calling this —
   nothing in here trusts a client claim. */
const { decideDeposit, releaseReferralCredits } = require('./money');
const { loadCredentials } = require('./credentials');
const { getSettings, getCurrencies } = require('./settings');
const { fmtMoney } = require('./util');
const notify = require('./notify');
const audit = require('./audit');

async function notifyPlayer(db, settings, dep, template) {
  try {
    const u = await db.get('SELECT email, name FROM users WHERE id = ?', [dep.user_id]);
    if (u && u.email) {
      notify.send(db, settings, 'email', template, u.email,
        { name: u.name, amount: fmtMoney(dep.net, dep.currency, getCurrencies(settings)) }).catch(() => {});
    }
  } catch {}
}

/* Approve a pending deposit because the provider verified the payment.
   Returns { applied:true } or { applied:false, reason }. */
async function creditVerifiedDeposit(db, settings, dep, { provider, ref }) {
  if (!dep || dep.status !== 'pending') return { applied: false, reason: 'deposit is ' + (dep ? dep.status : 'missing') };
  const s = settings || await getSettings(db, null, true);
  try {
    await decideDeposit(db, dep.id, 'approve', null, s); // webhook/system actor: NULL admin, like the generic path
  } catch (e) { return { applied: false, reason: 'approve failed: ' + e.message }; }
  if (ref) { try { await db.run('UPDATE deposits SET provider_txn_id = ? WHERE id = ?', [ref, dep.id]); } catch {} }
  await notifyPlayer(db, s, dep, 'deposit_approved');
  try { await releaseReferralCredits(db, dep.user_id, s); } catch {}
  await audit.log(db, { actorId: null, actorRole: 'webhook', action: 'webhook.deposit_approved', entity: 'deposit', entityId: dep.public_id, detail: { provider, ref: ref || '' } });
  return { applied: true };
}

/* Revoke an approved deposit because the provider verified a refund /
   reversal of the same payment. */
async function revokeVerifiedDeposit(db, settings, dep, { provider, ref }) {
  if (!dep || dep.status !== 'approved') return { applied: false, reason: 'deposit is ' + (dep ? dep.status : 'missing') };
  const s = settings || await getSettings(db, null, true);
  try {
    await decideDeposit(db, dep.id, 'revoke', null, s);
  } catch (e) { return { applied: false, reason: 'revoke failed: ' + e.message }; }
  await notifyPlayer(db, s, dep, 'deposit_revoked');
  await audit.log(db, { actorId: null, actorRole: 'webhook', action: 'webhook.deposit_revoked', entity: 'deposit', entityId: dep.public_id, detail: { provider, ref: ref || '' } });
  return { applied: true };
}

/* Find the pending deposit a provider reference belongs to: exact
   provider_txn_id first, then the rail's proof field inside the
   (possibly encrypted) user_data of pending deposits on ONE method. */
async function findDepositForRef(db, { methodId, ref, proofKey }) {
  if (!ref) return null;
  let dep = await db.get('SELECT * FROM deposits WHERE provider_txn_id = ?', [ref]);
  if (dep) {
    if (Number(dep.method_id) !== Number(methodId)) return null; // belongs to another method — not ours to act on
    return dep;
  }
  const { decodeUserData } = require('./money');
  const cands = await db.query(
    "SELECT * FROM deposits WHERE method_id = ? AND status IN ('pending','approved') ORDER BY created_at ASC LIMIT 500",
    [methodId]);
  for (const c of cands) {
    let decoded = {};
    try { decoded = decodeUserData(c.user_data); } catch { continue; }
    if (proofKey && String(decoded[proofKey] || '') === String(ref)) return c;
  }
  return null;
}

/* Has this provider reference already been consumed by a DIFFERENT
   deposit? (Replay guard for verify-on-submit flows.) */
async function refAlreadyUsed(db, ref, exceptDepositId) {
  if (!ref) return false;
  const row = await db.get('SELECT id FROM deposits WHERE provider_txn_id = ? AND id != ?', [ref, exceptDepositId || 0]);
  return !!row;
}

async function methodCreds(db, methodId) {
  return loadCredentials(db, methodId).catch(() => ({}));
}

module.exports = { creditVerifiedDeposit, revokeVerifiedDeposit, findDepositForRef, refAlreadyUsed, methodCreds, notifyPlayer };
