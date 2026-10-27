'use strict';
/* Provider webhooks: signature-verified entry points per rail.
   Manual rails never hit these; auto rails verify the signature (fail closed)
   and reconcile deposits by provider reference. v14: events are deduplicated
   (webhook_events.event_id UNIQUE) and mapped to deposits: payment-success
   approves the matching pending deposit (and records provider_txn_id),
   refund/chargeback revokes an approved deposit. Server-to-server PSP
   confirmation is provider-specific and plugs in per rail when merchant
   credentials exist; until then, signature + reference match is the gate. */
const express = require('express');
const router = express.Router();
const { now, sha256 } = require('../lib/util');
const { getRail, verifyWebhookSignature } = require('../lib/rails');
const { decideDeposit, releaseReferralCredits } = require('../lib/money');
const { decryptField } = require('../lib/credentials');
const { getSettings } = require('../lib/settings');
const audit = require('../lib/audit');

/* Generic event parser: providers disagree on field names, so try the common
   ones. Returns { ref, eventId, action } where action is payment_success,
   refund, or unknown (unknown events are recorded, never acted on). */
function parseEvent(body) {
  let j = {};
  try { j = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '')); } catch {}
  const ref = j.txn_id || j.transaction_id || j.reference || j.payment_id || j.order_id || j.merchant_reference || '';
  const eventId = j.event_id || j.id || j.eventId || '';
  const typeRaw = String(j.event || j.type || j.status || '').toLowerCase();
  let action = 'unknown';
  if (/(paid|success|completed|approved|captured)/.test(typeRaw)) action = 'payment_success';
  else if (/(refund|chargeback|reversed|failed)/.test(typeRaw)) action = 'refund';
  // v16: amount + currency when the provider sends them (Stripe: minor units;
  // PayPal-style: major units). Used to verify the webhook amount matches the
  // deposit before any auto-approval — see the handler below.
  const amtRaw = j.amount ?? j.amount_minor ?? j.amount_cents ?? j.total ?? j.gross ?? j.value ?? null;
  const amtNum = amtRaw === null || amtRaw === undefined || amtRaw === '' ? null : Number(amtRaw);
  const currency = String(j.currency || j.currency_code || '').toUpperCase() || null;
  return { ref: String(ref), eventId: String(eventId), typeRaw, action, raw: j, amount: Number.isFinite(amtNum) ? amtNum : null, currency };
}

router.post('/:rail', express.raw({ type: '*/*' }), async (req, res) => {
  const rail = getRail(req.params.rail);
  if (!rail) return res.status(404).json({ ok: false });
  // Try every enabled method on this rail: the signature is accepted only
  // if it verifies against one of their secrets (never the first method's
  // credentials by default, and never on header presence alone).
  const methods = await req.db.query('SELECT * FROM payment_methods WHERE rail = ? AND enabled = 1', [rail.key]);
  for (const m of methods) {
    const creds = {};
    for (const c of await req.db.query('SELECT field_key, field_value, field_enc FROM gateway_credentials WHERE method_id = ?', [m.id])) {
      try { creds[c.field_key] = decryptField(c.field_value, c.field_enc); }
      catch { creds[c.field_key] = ''; }
    }
    m.webhook_secret = creds.webhook_secret || creds.api_token || creds.secret_key || '';
  }
  const check = verifyWebhookSignature(rail.key, req, methods);
  await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.received', entity: 'rail', entityId: rail.key, detail: { ok: check.ok, reason: check.reason || '', methodId: check.methodId || null }, ip: req.ip });
  if (!check.ok) return res.status(401).json({ ok: false, error: check.reason });

  const ev = parseEvent(req.body);
  const eventId = ev.eventId || sha256(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || ''));
  const dup = await req.db.get('SELECT id FROM webhook_events WHERE event_id = ?', [eventId]);
  if (dup) return res.json({ ok: true, rail: rail.key, note: 'duplicate event ignored' });

  let depositId = null, note = 'event recorded, no matching deposit';
  if (ev.ref) {
    // Exact provider_txn_id match first; then a QUOTED user_data value match
    // (user_data is JSON, so quoting avoids short-ref false positives).
    // v16: LIKE wildcards in the ref are ESCAPED (the old code stripped % _
    // and backslash, so a ref containing them could match the WRONG deposit).
    // v16: pending deposits first, oldest first — the old ORDER BY
    // created_at DESC let a newer large deposit steal an older small
    // payment's webhook.
    const escRef = ev.ref.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const dep = await req.db.get(
      `SELECT * FROM deposits WHERE provider_txn_id = ? OR LOWER(user_data) LIKE LOWER(?) ESCAPE '\\' ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`,
      [ev.ref, '%"' + escRef + '"%']);
    if (dep) {
      depositId = dep.id;
      // v16: AMOUNT VERIFICATION. The old code approved any pending deposit
      // whose reference matched, regardless of amount — a small real payment
      // whose reference was pasted into a large deposit's proof (or echoed
      // back by a reference-echo rail like bank/UPI) could approve the large
      // amount. Now: approve/revoke only when the payload amount matches
      // the deposit (minor units, or major units x100). A payload with no
      // amount cannot prove what was paid — it is recorded for manual
      // review and NEVER auto-approved (fail closed).
      let amountOk = false, amountNote = '';
      if (ev.amount !== null) {
        const depAmt = Number(dep.amount);
        amountOk = (Math.round(ev.amount) === depAmt) || (Math.round(ev.amount * 100) === depAmt);
        if (!amountOk) amountNote = `amount mismatch (webhook ${ev.amount}${ev.currency ? ' ' + ev.currency : ''} vs deposit ${depAmt} minor)`;
      } else {
        amountNote = 'no amount in webhook payload';
      }
      if (ev.action === 'payment_success' && dep.status === 'pending' && amountOk) {
        try {
          await decideDeposit(req.db, dep.id, 'approve', 0);
          await req.db.run('UPDATE deposits SET provider_txn_id = ? WHERE id = ?', [ev.ref, dep.id]);
          const settings = await getSettings(req.db, req.driver, true);
          try { await releaseReferralCredits(req.db, dep.user_id, settings); } catch {}
          await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.deposit_approved', entity: 'deposit', entityId: dep.public_id, detail: { provider: rail.key, ref: ev.ref }, ip: req.ip });
          note = 'deposit approved via webhook';
        } catch (e) { note = 'approve failed: ' + e.message; }
      } else if (ev.action === 'refund' && dep.status === 'approved' && amountOk) {
        try {
          await decideDeposit(req.db, dep.id, 'revoke', 0);
          await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.deposit_revoked', entity: 'deposit', entityId: dep.public_id, detail: { provider: rail.key, ref: ev.ref }, ip: req.ip });
          note = 'deposit revoked via webhook (refund/chargeback)';
        } catch (e) { note = 'revoke failed: ' + e.message; }
      } else if ((ev.action === 'payment_success' && dep.status === 'pending') || (ev.action === 'refund' && dep.status === 'approved')) {
        await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.amount_mismatch', entity: 'deposit', entityId: dep.public_id, detail: { provider: rail.key, ref: ev.ref, reason: amountNote }, ip: req.ip });
        note = 'webhook NOT auto-applied (' + amountNote + ') — manual review required';
      } else {
        note = 'deposit already ' + dep.status + ', no action taken';
      }
    }
  }
  await req.db.run('INSERT INTO webhook_events (provider, event_id, deposit_id, action, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [rail.key, eventId, depositId, ev.action, JSON.stringify(ev.raw).slice(0, 2000), now()]);
  res.json({ ok: true, rail: rail.key, note });
});

module.exports = router;
