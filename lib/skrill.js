'use strict';
/* Skrill status-report verification (AUTO-INTEGRATION round).
   Skrill does NOT use an HMAC webhook secret. For payments created
   through Skrill's checkout with a status_url, Skrill POSTs a status
   report to that URL and signs it with the merchant's Secret Word:

     md5sig = MD5( merchant_id + transaction_id
                   + UPPERCASE(MD5(secret_word))
                   + mb_amount + mb_currency + status )   (hex, lowercase)

   (Skrill Quick Checkout Integration Guide, "Status Report" section.)
   Status codes: 2 = processed (paid), 0 = pending, -1 = cancelled,
   -2 = failed, -3 = chargeback.

   Verification here is pure and fail-closed: the merchant_id in the
   report must be the configured one, the pay_to_email must be the
   configured receiving account, and the signature must match a
   timing-safe comparison. Amount/currency matching against the
   deposit happens in the caller, exactly like every other rail. */
const crypto = require('node:crypto');

function md5hex(s) { return crypto.createHash('md5').update(String(s), 'utf8').digest('hex'); }

function expectedMd5Sig(secretWord, f) {
  return md5hex(
    String(f.merchant_id || '') +
    String(f.transaction_id || '') +
    md5hex(String(secretWord || '')).toUpperCase() +
    String(f.mb_amount || '') +
    String(f.mb_currency || '') +
    String(f.status || '')
  );
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || '').toLowerCase(), 'utf8');
  const y = Buffer.from(String(b || '').toLowerCase(), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* creds: { merchant_id, secret_word, account_email }
   fields: the POSTed status-report form fields (strings). */
function verifyStatusReport(creds, fields) {
  const f = fields || {};
  if (!creds || !String(creds.merchant_id || '').trim() || !String(creds.secret_word || '').trim())
    return { ok: false, reason: 'skrill credentials not configured' };
  if (!f.md5sig) return { ok: false, reason: 'missing md5sig' };
  if (String(f.merchant_id || '') !== String(creds.merchant_id))
    return { ok: false, reason: 'merchant_id mismatch' };
  if (creds.account_email && String(f.pay_to_email || '').toLowerCase() !== String(creds.account_email).toLowerCase())
    return { ok: false, reason: 'pay_to_email mismatch' };
  if (!safeEqualHex(expectedMd5Sig(creds.secret_word, f), f.md5sig))
    return { ok: false, reason: 'md5sig mismatch' };
  return { ok: true };
}

const STATUS_ACTIONS = { '2': 'payment_success', '0': 'pending', '-1': 'cancelled', '-2': 'failed', '-3': 'chargeback' };
function parseStatusReport(fields) {
  const f = fields || {};
  const amt = Number(f.mb_amount);
  return {
    merchantId: String(f.merchant_id || ''),
    transactionId: String(f.transaction_id || ''),       // merchant reference (may be '')
    mbTransactionId: String(f.mb_transaction_id || ''),  // Skrill's own transaction ID — the one players paste as proof
    payToEmail: String(f.pay_to_email || ''),
    payFromEmail: String(f.pay_from_email || ''),
    amountMinor: Number.isFinite(amt) ? Math.round(amt * 100) : null,
    currency: String(f.mb_currency || '').toUpperCase() || null,
    status: String(f.status || ''),
    action: STATUS_ACTIONS[String(f.status || '')] || 'unknown',
    raw: f,
  };
}

module.exports = { md5hex, expectedMd5Sig, verifyStatusReport, parseStatusReport, STATUS_ACTIONS };
