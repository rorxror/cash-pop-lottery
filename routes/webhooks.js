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
const { loadCredentials } = require('../lib/credentials');
const { getSettings, getCurrencies } = require('../lib/settings');
const notify = require('../lib/notify');
const { fmtMoney, decimalsFor } = require('../lib/util');
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
// U-21 note: qr_pay is listed although its rail declares webhook:false —
// this route accepts webhooks for every rail key, and qr PSPs that do
// send callbacks use minor units; the convention is retained deliberately
// (documented in adj-payments.md, no behaviour change).
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

/* ================= AUTO-INTEGRATION: provider-specific routes =======
   PayPal and Skrill do NOT sign with an HMAC shared secret, so the
   generic HMAC route below can never verify them. These dedicated
   routes are registered BEFORE '/:rail' and verify the way each
   provider actually signs: PayPal via PayPal's own
   verify-webhook-signature API (lib/paypal.js), Skrill via the Secret
   Word md5sig on its status report (lib/skrill.js). Both fail closed:
   unverifiable => 401, recorded, never credited. Crediting goes
   through lib/auto-credit (decideDeposit's guarded transition), so a
   replayed or duplicated event can never credit twice. */
const paypal = require('../lib/paypal');
const skrill = require('../lib/skrill');
const { creditVerifiedDeposit, revokeVerifiedDeposit, findDepositForRef } = require('../lib/auto-credit');

router.post('/paypal', rateLimit({ windowMs: 60000, max: 60, keyFn: r => 'webhook:' + r.ip }), express.raw({ type: '*/*' }), async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''));
  let event = null;
  try { event = JSON.parse(rawBody.toString('utf8')); } catch {}
  if (!event || typeof event !== 'object' || !event.event_type)
    return res.status(400).json({ ok: false, error: 'bad event' });
  const eventId = String(event.id || sha256(rawBody.toString('utf8')));
  const methods = await req.db.query("SELECT * FROM payment_methods WHERE rail = 'paypal' AND enabled = 1", []);
  /* The delivery is authentic only if PayPal's verification API says
     SUCCESS against one configured method's Webhook ID + app creds. */
  let method = null, creds = null;
  for (const m of methods) {
    const c = await loadCredentials(req.db, m.id).catch(() => ({}));
    if (!c.client_id || !c.client_secret || !c.webhook_id) continue;
    const v = await paypal.verifyWebhookSignature(c, { webhookId: c.webhook_id, headers: req.headers, rawBody });
    if (v.ok) { method = m; creds = c; break; }
  }
  await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.received', entity: 'rail', entityId: 'paypal', detail: { ok: !!method, eventType: event.event_type, methodId: method ? method.id : null }, ip: req.ip });
  if (!method) return res.status(401).json({ ok: false, error: 'signature verification failed' });

  const dup = await req.db.get('SELECT id FROM webhook_events WHERE event_id = ? AND provider = ?', [eventId, 'paypal']);
  if (dup) return res.json({ ok: true, rail: 'paypal', note: 'duplicate event ignored' });

  const settings = await getSettings(req.db, req.driver, true);
  const methodAuto = method.processing_mode === 'auto';
  let depositId = null, note = 'event recorded, no action', action = 'unknown';

  const applyCapture = async (capture) => {
    action = 'payment_success';
    const dep = await findDepositForRef(req.db, { methodId: method.id, ref: capture.id, proofKey: 'paypal_txid' });
    if (!dep) { note = 'event recorded, no matching deposit'; return; }
    depositId = dep.id;
    const chk = paypal.checkCaptureAgainstDeposit(capture, { amountMinor: dep.amount, currency: dep.currency, accountEmail: creds.account_email });
    if (!chk.ok) {
      await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.verification_mismatch', entity: 'deposit', entityId: dep.public_id, detail: { provider: 'paypal', ref: capture.id, reason: chk.reason }, ip: req.ip });
      note = 'webhook NOT auto-applied (' + chk.reason + ') — manual review required';
      return;
    }
    if (!methodAuto) {
      await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.manual_mode_recorded', entity: 'deposit', entityId: dep.public_id, detail: { provider: 'paypal', ref: capture.id, note: 'method is Manual Pay — event recorded, no auto action' }, ip: req.ip });
      note = 'event recorded — method is Manual Pay, deposit stays for admin review';
      return;
    }
    if (dep.status !== 'pending') { note = 'deposit already ' + dep.status + ', no action taken'; return; }
    const r = await creditVerifiedDeposit(req.db, settings, dep, { provider: 'paypal', ref: capture.id });
    note = r.applied ? 'deposit approved via PayPal webhook' : ('approve failed: ' + r.reason);
  };

  if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
    const capture = paypal.normalizeCapture(event.resource, decimalsFor(method.currency, getCurrencies(settings)));
    if (capture) await applyCapture(capture); else note = 'event recorded, unparseable capture resource';
  } else if (event.event_type === 'CHECKOUT.ORDER.APPROVED' || event.event_type === 'CHECKOUT.ORDER.COMPLETED') {
    /* We never create PayPal orders (players pay the account directly),
       so an order event can only credit when it already carries a
       COMPLETED capture; an APPROVED-but-uncaptured order is recorded
       and never credited. */
    const order = event.resource || {};
    const units = Array.isArray(order.purchase_units) ? order.purchase_units : [];
    const captures = units.flatMap(u => (u.payments && Array.isArray(u.payments.captures)) ? u.payments.captures : []);
    if (String(order.status || '') === 'COMPLETED' && captures.length) {
      const capture = paypal.normalizeCapture(captures[0], decimalsFor(method.currency, getCurrencies(settings)));
      if (capture) await applyCapture(capture);
    } else note = 'order event recorded — no completed capture, no credit';
  } else if (event.event_type === 'PAYMENT.CAPTURE.REFUNDED' || event.event_type === 'PAYMENT.CAPTURE.REVERSED') {
    action = 'refund';
    const r = event.resource || {};
    const up = (Array.isArray(r.links) ? r.links : []).find(l => l && l.rel === 'up' && /\/captures\/([A-Za-z0-9_-]+)/.test(String(l.href || '')));
    const captureId = up ? /\/captures\/([A-Za-z0-9_-]+)/.exec(String(up.href))[1] : '';
    const refundValue = r.amount && r.amount.value !== null && r.amount.value !== undefined ? Number(r.amount.value) : NaN;
    /* H2-04 (v23): refund value is in MAJOR units of its currency. */
    const refundMinor = Number.isFinite(refundValue) ? Math.round(refundValue * (10 ** decimalsFor(String((r.amount && r.amount.currency_code) || method.currency || '').toUpperCase(), getCurrencies(settings)))) : null;
    const refundCur = String((r.amount && r.amount.currency_code) || '').toUpperCase() || null;
    const dep = captureId ? await findDepositForRef(req.db, { methodId: method.id, ref: captureId, proofKey: 'paypal_txid' }) : null;
    if (!dep) note = 'refund recorded, no matching deposit';
    else {
      depositId = dep.id;
      if (!methodAuto) note = 'refund recorded — method is Manual Pay, no auto action';
      else if (dep.status !== 'approved') note = 'refund recorded — deposit is ' + dep.status;
      else if (refundMinor === null || refundMinor !== Number(dep.amount) || (refundCur && refundCur !== String(dep.currency).toUpperCase())) {
        await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.verification_mismatch', entity: 'deposit', entityId: dep.public_id, detail: { provider: 'paypal', ref: captureId, reason: 'refund amount/currency does not match the full deposit — partial refunds stay manual' }, ip: req.ip });
        note = 'refund NOT auto-applied (not a full-amount match) — manual review required';
      } else {
        const rr = await revokeVerifiedDeposit(req.db, settings, dep, { provider: 'paypal', ref: captureId });
        note = rr.applied ? 'deposit revoked via PayPal refund webhook' : ('revoke failed: ' + rr.reason);
      }
    }
  }

  try {
    await req.db.run('INSERT INTO webhook_events (provider, event_id, deposit_id, action, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ['paypal', eventId, depositId, action, JSON.stringify(event).slice(0, 2000), now()]);
  } catch (e) { if (/UNIQUE|duplicate/i.test(e.message)) return res.json({ ok: true, rail: 'paypal', note: 'duplicate event ignored' }); throw e; }
  res.json({ ok: true, rail: 'paypal', note });
});

router.post('/skrill', rateLimit({ windowMs: 60000, max: 60, keyFn: r => 'webhook:' + r.ip }), express.urlencoded({ extended: false }), async (req, res) => {
  const fields = {};
  for (const [k, v] of Object.entries(req.body || {})) fields[k] = String(v);
  const parsed = skrill.parseStatusReport(fields);
  const methods = await req.db.query("SELECT * FROM payment_methods WHERE rail = 'ewallet' AND enabled = 1", []);
  let method = null;
  for (const m of methods) {
    const c = await loadCredentials(req.db, m.id).catch(() => ({}));
    if (String(c.provider || '') !== 'Skrill') continue;
    if (skrill.verifyStatusReport(c, fields).ok) { method = m; break; }
  }
  await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.received', entity: 'rail', entityId: 'skrill', detail: { ok: !!method, status: parsed.status, methodId: method ? method.id : null }, ip: req.ip });
  if (!method) return res.status(401).send('verification failed');

  const settings = await getSettings(req.db, req.driver, true);
  const methodAuto = method.processing_mode === 'auto';
  const eventId = 'skrill:' + (parsed.mbTransactionId || sha256(JSON.stringify(fields))) + ':' + parsed.status;
  const existing = await req.db.get('SELECT id, deposit_id FROM webhook_events WHERE event_id = ? AND provider = ?', [eventId, 'skrill']);

  let depositId = existing && existing.deposit_id ? Number(existing.deposit_id) : null;
  if (!depositId && (parsed.action === 'payment_success' || parsed.action === 'chargeback')) {
    const dep = await findDepositForRef(req.db, { methodId: method.id, ref: parsed.mbTransactionId, proofKey: 'ewallet_txid' });
    if (dep) {
      /* H2-04 (v23): convert with the DEPOSIT currency's decimals. */
      const amountOk = parsed.amountMajor !== null && Math.round(parsed.amountMajor * (10 ** decimalsFor(dep.currency, getCurrencies(settings)))) === Number(dep.amount);
      const currencyOk = !!parsed.currency && parsed.currency === String(dep.currency).toUpperCase();
      if (!amountOk || !currencyOk) {
        await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.verification_mismatch', entity: 'deposit', entityId: dep.public_id, detail: { provider: 'skrill', ref: parsed.mbTransactionId, reason: amountOk ? 'currency mismatch' : 'amount mismatch' }, ip: req.ip });
      } else if (!methodAuto) {
        await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.manual_mode_recorded', entity: 'deposit', entityId: dep.public_id, detail: { provider: 'skrill', ref: parsed.mbTransactionId, note: 'method is Manual Pay — event recorded, no auto action' }, ip: req.ip });
        depositId = dep.id; // recorded against the deposit, not applied
      } else if (parsed.action === 'payment_success' && dep.status === 'pending') {
        const r = await creditVerifiedDeposit(req.db, settings, dep, { provider: 'skrill', ref: parsed.mbTransactionId });
        if (r.applied) depositId = dep.id;
      } else if (parsed.action === 'chargeback' && dep.status === 'approved') {
        const r = await revokeVerifiedDeposit(req.db, settings, dep, { provider: 'skrill', ref: parsed.mbTransactionId });
        if (r.applied) depositId = dep.id;
      } else depositId = dep.id;
    }
  }
  if (existing) {
    if (depositId && !existing.deposit_id) { try { await req.db.run('UPDATE webhook_events SET deposit_id = ? WHERE id = ?', [depositId, existing.id]); } catch {} }
  } else {
    try {
      await req.db.run('INSERT INTO webhook_events (provider, event_id, deposit_id, action, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        ['skrill', eventId, depositId, parsed.action, JSON.stringify(fields).slice(0, 2000), now()]);
    } catch (e) { if (!/UNIQUE|duplicate/i.test(e.message)) throw e; }
  }
  /* Skrill requires a plain 200 answer to stop retrying the report. */
  res.status(200).send('OK');
});

router.post('/:rail', rateLimit({ windowMs: 60000, max: 60, keyFn: r => 'webhook:' + r.ip }), express.raw({ type: '*/*' }), async (req, res) => { // R-090: per-IP rate limit
  const rail = getRail(req.params.rail);
  if (!rail) return res.status(404).json({ ok: false });
  // Try every enabled method on this rail: the signature is accepted only
  // if it verifies against one of their secrets (never the first method's
  // credentials by default, and never on header presence alone).
  const methods = await req.db.query('SELECT * FROM payment_methods WHERE rail = ? AND enabled = 1', [rail.key]);
  for (const m of methods) {
    // U-21: shared loader (lib/credentials.loadCredentials).
    const creds = await loadCredentials(req.db, m.id, async (field, e) => {
      // R-084: a decrypt failure is AUDITED, never silently substituted.
      await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.credential_decrypt_failed', entity: 'method', entityId: m.id, detail: { field, error: String(e.message).slice(0, 200) }, ip: req.ip });
    });
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
      /* H2-03 (v23): 'approved' deposits are candidates too — a refund /
         chargeback for a MANUALLY approved deposit (provider_txn_id is
         NULL, so the exact match above missed it) previously matched
         NOTHING: the reversal was recorded and the house silently kept
         money the provider had taken back. Pending rows sort first so
         a success event can never be shadowed by an older approved row
         carrying the same proof; the action branches below re-check
         status before acting. */
      const cands = await req.db.query(
        `SELECT d.* FROM deposits d JOIN payment_methods m ON m.id = d.method_id
         WHERE m.rail = ? AND d.status IN ('pending','approved') ORDER BY CASE d.status WHEN 'pending' THEN 0 ELSE 1 END, d.created_at ASC LIMIT 500`,
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
      /* METHOD-MODE-01: a signed webhook only AUTO-applies when the
         matched deposit's method is in Auto Pay mode. On a Manual Pay
         method the event is still verified + recorded (below), but the
         deposit stays in the admin queue — a webhook must never
         silently credit a method the operator set to manual review. */
      const depMethod = await req.db.get('SELECT processing_mode FROM payment_methods WHERE id = ?', [dep.method_id]);
      const methodAuto = !!(depMethod && depMethod.processing_mode === 'auto');
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
        /* H2-04 (v23): major-unit rails convert with the DEPOSIT
           currency's decimals (x100 was wrong for JPY/KWD). */
        amountOk = MINOR_UNIT_RAILS.has(rail.key)
          ? (Math.round(ev.amount) === depAmt)
          : (Math.round(ev.amount * (10 ** decimalsFor(dep.currency, getCurrencies(req.settings || {})))) === depAmt);
        amountOk = amountOk && currencyOk;
        if (!amountOk) amountNote = currencyOk
          ? `amount mismatch (webhook ${ev.amount}${ev.currency ? ' ' + ev.currency : ''} vs deposit ${depAmt} minor)`
          : `currency mismatch (webhook ${ev.currency} vs deposit ${dep.currency})`;
      } else {
        amountNote = 'no amount in webhook payload';
      }
      if (!methodAuto && amountOk && ((ev.action === 'payment_success' && dep.status === 'pending') || (ev.action === 'refund' && dep.status === 'approved'))) {
        await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.manual_mode_recorded', entity: 'deposit', entityId: dep.public_id, detail: { provider: rail.key, ref: ev.ref, action: ev.action, note: 'method is Manual Pay — event recorded, no auto action' }, ip: req.ip });
        note = 'event recorded — method is Manual Pay, deposit stays for admin review';
      } else if (ev.action === 'payment_success' && dep.status === 'pending' && amountOk) {
        try {
          const settings = await getSettings(req.db, req.driver, true);
          await decideDeposit(req.db, dep.id, 'approve', null, settings); // v17.1: webhook is not an admin; NULL, not a fake admin id 0
          /* AUTO-VISIBILITY-01 (manual-payments round): the admin
             decide path emails the player 'deposit_approved'; the
             webhook auto path credited silently, so an auto deposit
             flipped in the wallet with no notification. Send the SAME
             template here — visibility must not depend on the path. */
          try {
            const u = await req.db.get('SELECT email, name FROM users WHERE id = ?', [dep.user_id]);
            if (u && u.email) notify.send(req.db, settings, 'email', 'deposit_approved', u.email, { name: u.name, amount: fmtMoney(dep.net, dep.currency, getCurrencies(settings)) }).catch(() => {});
          } catch {}
          await req.db.run('UPDATE deposits SET provider_txn_id = ? WHERE id = ?', [ev.ref, dep.id]);
          try { await releaseReferralCredits(req.db, dep.user_id, settings); } catch {}
          await audit.log(req.db, { actorId: null, actorRole: 'webhook', action: 'webhook.deposit_approved', entity: 'deposit', entityId: dep.public_id, detail: { provider: rail.key, ref: ev.ref }, ip: req.ip });
          note = 'deposit approved via webhook';
        } catch (e) { note = 'approve failed: ' + e.message; }
      } else if (ev.action === 'refund' && dep.status === 'approved' && amountOk) {
        try {
          const rSettings = await getSettings(req.db, req.driver, true);
          await decideDeposit(req.db, dep.id, 'revoke', null, rSettings); // v17.1: see approve above
          /* AUTO-VISIBILITY-01: a reversal must be just as visible as
             the credit — notify with the dedicated revoked template
             (never 'deposit_rejected': its text claims the amount was
             never credited, which is false for a reversal). */
          try {
            const u = await req.db.get('SELECT email, name FROM users WHERE id = ?', [dep.user_id]);
            if (u && u.email) notify.send(req.db, rSettings, 'email', 'deposit_revoked', u.email, { name: u.name, amount: fmtMoney(dep.net, dep.currency, getCurrencies(rSettings)) }).catch(() => {});
          } catch {}
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
