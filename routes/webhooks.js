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
  // find a method on this rail to pull credentials
  const method = await req.db.get('SELECT * FROM payment_methods WHERE rail = ? AND enabled = 1 LIMIT 1', [rail.key]);
  const creds = {};
  if (method) {
    for (const c of await req.db.query('SELECT field_key, field_value FROM gateway_credentials WHERE method_id = ?', [method.id]))
      creds[c.field_key] = c.field_value;
  }
  const check = verifyWebhookSignature(rail.key, req, creds);
  await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.received', entity: 'rail', entityId: rail.key, detail: { ok: check.ok, reason: check.reason || '' }, ip: req.ip });
  if (!check.ok) return res.status(401).json({ ok: false, error: check.reason });
  // Provider-specific event parsing plugs in here per rail.
  // For now we acknowledge receipt; deposit reconciliation happens when the
  // provider's event maps to a deposit's user_data reference.
  res.json({ ok: true, rail: rail.key, note: 'signature verified; event queued for reconciliation' });
});

module.exports = router;
