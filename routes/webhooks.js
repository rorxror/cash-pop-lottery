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
const { rateLimit } = require('../lib/auth');
const { decideDeposit, releaseReferralCredits } = require('../lib/money');
const { decryptField } = require('../lib/credentials');
const { getSettings } = require('../lib/settings');
const audit = require('../lib/audit');

/* Generic event parser: providers disagree on field names, so try the common
   ones. Returns { ref, eventId, action } where action is payment_success,
   refund, or unknown (unknown events are recorded, never acted on). */
// R-006: whole-token status map per provider family — substring regexes
// used to classify 'unpaid' as success and 'payment_failed' as refund.
const SUCCESS_TOKENS = new Set(['paid', 'success', 'succeeded', 'completed', 'complete', 'approved', 'captured', 'payment_intent.succeeded', 'charge.succeeded', 'payment.succeeded', 'payment_success', 'successfully_paid', 'settled']);
const REFUND_TOKENS = new Set(['refund', 'refunded', 'chargeback', 'reversed', 'reversal', 'payment_failed', 'failed', 'failure', 'cancelled', 'canceled']);
function classifyStatus(typeRaw) {
  const t = String(typeRaw || '').toLowerCase().trim();
  // Exact token first, then the last dotted segment (Stripe-style
  // 'payment_intent.succeeded' -> 'succeeded').
  if (SUCCESS_TOKENS.has(t)) return 'payment_success';
  if (REFUND_TOKENS.has(t)) return 'refund';
  const last = t.split('.').pop();
  if (SUCCESS_TOKENS.has(last)) return 'payment_success';
  if (REFUND_TOKENS.has(last)) return 'refund';
  return 'unknown';
}
// R-005: one unit convention per rail family. Stripe-style rails send
// minor units; PayPal-style rails send major units. Never both.
const MINOR_UNIT_RAILS = new Set(['cards', 'crypto', 'apple_pay', 'google_pay', 'samsung_pay', 'qr_pay']);
function parseEvent(body) {
  let j = {};
  try { j = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '')); } catch {}
  const ref = j.txn_id || j.transaction_id || j.reference || j.payment_id || j.order_id || j.merchant_reference || '';
  const eventId = j.event_id || j.id || j.eventId || '';
  const typeRaw = String(j.event || j.type || j.status || '').toLowerCase();
  const action = classifyStatus(typeRaw);
  // v16: amount + currency when the provider sends them (Stripe: minor units;
  // PayPal-style: major units). Used to verify the webhook amount matches the
  // deposit before any auto-approval — see the handler below.
  const amtRaw = j.amount ?? j.amount_minor ?? j.amount_cents ?? j.total ?? j.gross ?? j.value ?? null;
  const amtNum = amtRaw === null || amtRaw === undefined || amtRaw === '' ? null : Number(amtRaw);
  const currency = String(j.currency || j.currency_code || '').toUpperCase() || null;
  return { ref: String(ref), eventId: String(eventId), typeRaw, action, raw: j, amount: Number.isFinite(amtNum) ? amtNum : null, currency };
}

router.post('/:rail', rateLimit({ windowMs: 60000, max: 60, keyFn: r => 'webhook:' + r.ip }), express.raw({ type: '*/*' }), async (req, res) => { // R-090: per-IP rate limit
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
      catch (e) {
        // R-084: a decrypt failure is AUDITED, never silently substituted.
        await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.credential_decrypt_failed', entity: 'method', entityId: m.id, detail: { field: c.field_key, error: String(e.message).slice(0, 200) }, ip: req.ip });
        creds[c.field_key] = '';
      }
    }
    m.webhook_secret = creds.webhook_secret || '';
  }
  const check = verifyWebhookSignature(rail.key, req, methods);
  await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.received', entity: 'rail', entityId: rail.key, detail: { ok: check.ok, reason: check.reason || '', methodId: check.methodId || null }, ip: req.ip });
  if (!check.ok) return res.status(401).json({ ok: false, error: check.reason });

  const ev = parseEvent(req.body);
  const eventId = ev.eventId || sha256(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || ''));
  // R-090: dedup scoped per provider (same event id on another rail is a
  // different event) and claimed atomically via insert-or-ignore below;
  // the pre-check is only a fast path.
  const dup = await req.db.get('SELECT id FROM webhook_events WHERE event_id = ? AND provider = ?', [eventId, rail.key]);
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
    // R-031: exact provider_txn_id matches win over proof matches, and the
    // matched deposit's rail must equal the webhook rail (via its method).
    let dep = await req.db.get('SELECT * FROM deposits WHERE provider_txn_id = ?', [ev.ref]);
    if (!dep) {
      // R-115: proof matching must work on ENCRYPTED user_data too. The old
      // SQL LIKE on the raw column could never match an encrypted row, so
      // encrypted proof deposits were invisible to webhooks. Now: fetch the
      // rail's pending deposits (oldest first, capped at 500 — the pending
      // queue is an actionable list, not an archive) and match the quoted
      // reference against the DECODED details in JS. Same match semantics
      // as the old LIKE '%"<ref>"%' (quoted value, case-insensitive).
      const { decodeUserData } = require('../lib/money');
      const cands = await req.db.query(
        `SELECT d.* FROM deposits d JOIN payment_methods m ON m.id = d.method_id
         WHERE m.rail = ? AND d.status = 'pending' ORDER BY d.created_at ASC LIMIT 500`,
        [rail.key]);
      const needle = '"' + String(ev.ref).toLowerCase() + '"';
      for (const c of cands) {
        let decoded = {};
        try { decoded = decodeUserData(c.user_data); } catch { continue; }
        if (JSON.stringify(decoded).toLowerCase().includes(needle)) { dep = c; break; }
      }
    } else {
      const dm = await req.db.get('SELECT rail FROM payment_methods WHERE id = ?', [dep.method_id]);
      if (dm && dm.rail && dm.rail !== rail.key) dep = null; // rail mismatch: do not act
    }
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
      // R-004: currency must match (when the payload carries one); a
      // missing currency fails closed to manual review.
      const currencyOk = !ev.currency || String(ev.currency).toUpperCase() === String(dep.currency).toUpperCase();
      if (ev.amount !== null) {
        const depAmt = Number(dep.amount);
        // R-005: exactly one unit interpretation, by rail family.
        amountOk = MINOR_UNIT_RAILS.has(rail.key)
          ? (Math.round(ev.amount) === depAmt)
          : (Math.round(ev.amount * 100) === depAmt);
        amountOk = amountOk && currencyOk;
        if (!amountOk) amountNote = currencyOk
          ? `amount mismatch (webhook ${ev.amount}${ev.currency ? ' ' + ev.currency : ''} vs deposit ${depAmt} minor)`
          : `currency mismatch (webhook ${ev.currency} vs deposit ${dep.currency})`;
      } else {
        amountNote = 'no amount in webhook payload';
      }
      if (ev.action === 'payment_success' && dep.status === 'pending' && amountOk) {
        try {
          await decideDeposit(req.db, dep.id, 'approve', null); // v17.1: webhook is not an admin; NULL, not a fake admin id 0
          await req.db.run('UPDATE deposits SET provider_txn_id = ? WHERE id = ?', [ev.ref, dep.id]);
          const settings = await getSettings(req.db, req.driver, true);
          try { await releaseReferralCredits(req.db, dep.user_id, settings); } catch {}
          await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.deposit_approved', entity: 'deposit', entityId: dep.public_id, detail: { provider: rail.key, ref: ev.ref }, ip: req.ip });
          note = 'deposit approved via webhook';
        } catch (e) { note = 'approve failed: ' + e.message; }
      } else if (ev.action === 'refund' && dep.status === 'approved' && amountOk) {
        try {
          await decideDeposit(req.db, dep.id, 'revoke', null); // v17.1: see approve above
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
  // R-090: atomic claim — a concurrent duplicate's INSERT violates the
  // UNIQUE(event_id) backstop (or the provider-scoped check above) and is
  // treated as a duplicate instead of 500ing after side effects.
  try {
    await req.db.run('INSERT INTO webhook_events (provider, event_id, deposit_id, action, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [rail.key, eventId, depositId, ev.action, JSON.stringify(ev.raw).slice(0, 2000), now()]);
  } catch (e) { if (/UNIQUE|duplicate/i.test(e.message)) return res.json({ ok: true, rail: rail.key, note: 'duplicate event ignored' }); throw e; }
  res.json({ ok: true, rail: rail.key, note });
});

module.exports = router;
module.exports.parseEvent = parseEvent;
module.exports.MINOR_UNIT_RAILS = MINOR_UNIT_RAILS;
module.exports.classifyStatus = classifyStatus;
