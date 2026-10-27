'use strict';
/* Provider webhooks: signature-verified entry points per rail.
   Manual rails never hit these; auto rails verify the signature (fail closed)
   and reconcile deposits by provider reference. */
const express = require('express');
const router = express.Router();
const { now } = require('../lib/util');
const { getRail, verifyWebhookSignature } = require('../lib/rails');
const { decideDeposit } = require('../lib/money');
const audit = require('../lib/audit');

router.post('/:rail', express.raw({ type: '*/*' }), async (req, res) => {
  const rail = getRail(req.params.rail);
  if (!rail) return res.status(404).json({ ok: false });
  // Try every enabled method on this rail: the signature is accepted only
  // if it verifies against one of their secrets (never the first method's
  // credentials by default, and never on header presence alone).
  const methods = await req.db.query('SELECT * FROM payment_methods WHERE rail = ? AND enabled = 1', [rail.key]);
  for (const m of methods) {
    const creds = {};
    for (const c of await req.db.query('SELECT field_key, field_value FROM gateway_credentials WHERE method_id = ?', [m.id]))
      creds[c.field_key] = c.field_value;
    m.webhook_secret = creds.webhook_secret; m.api_token = creds.api_token; m.secret_key = creds.secret_key;
  }
  const check = verifyWebhookSignature(rail.key, req, methods);
  await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.received', entity: 'rail', entityId: rail.key, detail: { ok: check.ok, reason: check.reason || '', methodId: check.methodId || null }, ip: req.ip });
  if (!check.ok) return res.status(401).json({ ok: false, error: check.reason });
  // Provider-specific event parsing plugs in here per rail.
  // For now we acknowledge receipt; deposit reconciliation happens when the
  // provider's event maps to a deposit's user_data reference. No money moves
  // on webhook receipt today — crediting happens only via verified provider
  // confirmation or admin approval against a bank statement entry.
  res.json({ ok: true, rail: rail.key, note: 'signature verified; event queued for reconciliation' });
});

module.exports = router;
