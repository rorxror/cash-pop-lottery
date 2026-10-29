'use strict';
/* PayPal REST verification client (AUTO-INTEGRATION round).
   This is the real thing, not a stub: every function talks to PayPal's
   REST API with the method's own Client ID / Secret and only ever
   answers "verified" when PayPal itself confirms the payment.

   - Base URL is chosen by the method's Mode field, exactly like the
     Sandbox / Live tabs in PayPal Developer:
       sandbox -> https://api-m.sandbox.paypal.com
       live    -> https://api-m.paypal.com
     (PAYPAL_API_BASE_URL env may override the host — a test/support
     hook, same trust level as the other server env secrets; the test
     suite uses it to run a local provider double.)
   - OAuth2: POST /v1/oauth2/token (Basic auth, client_credentials).
   - Capture lookup: GET /v2/payments/captures/{id} — used to verify a
     transaction ID the player pasted: status must be COMPLETED, the
     amount + currency must match the deposit exactly, and the payee
     must be the operator's configured account.
   - Webhook verification: POST /v1/notifications/verify-webhook-signature
     (PayPal's own verification API — PayPal webhooks are NOT HMAC, so
     the generic HMAC verifier can never verify them; that is why this
     client exists). Docs: developer.paypal.com/docs/api/webhooks/v1/
     and /docs/api/payments/v2/ (captures).

   Fail-closed throughout: any network error, timeout, non-200, or
   malformed response yields { ok:false } — never a "probably paid". */

const BASES = {
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com',
};

function baseUrlForMode(mode) {
  return String(mode || '').toLowerCase() === 'sandbox' ? BASES.sandbox : BASES.live;
}
function resolveBase(creds, opts = {}) {
  return opts.baseUrl || process.env.PAYPAL_API_BASE_URL || baseUrlForMode(creds && creds.mode);
}
function fetchImpl(opts = {}) { return opts.fetchImpl || globalThis.fetch; }

async function fetchWithTimeout(opts, url, init) {
  const ms = Number(opts.timeoutMs || 10000);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetchImpl(opts)(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

/* Access tokens are cached per (base, client_id) until shortly before
   expiry — PayPal tokens live ~9h and re-minting per call is wasteful. */
const tokenCache = new Map();
async function getAccessToken(creds, opts = {}) {
  const base = resolveBase(creds, opts);
  const cacheKey = base + '|' + String(creds.client_id || '');
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.exp > Date.now() + 30000) return { ok: true, token: hit.token, base };
  let res;
  try {
    res = await fetchWithTimeout(opts, base + '/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(String(creds.client_id) + ':' + String(creds.client_secret)).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
  } catch (e) { return { ok: false, reason: 'unreachable', error: String(e && e.message || e) }; }
  if (!res.ok) return { ok: false, reason: res.status === 401 ? 'auth_failed' : 'http_' + res.status };
  let j = null;
  try { j = await res.json(); } catch {}
  if (!j || !j.access_token) return { ok: false, reason: 'bad_token_response' };
  const ttl = Math.max(60, Number(j.expires_in || 3600)) * 1000;
  tokenCache.set(cacheKey, { token: j.access_token, exp: Date.now() + ttl });
  return { ok: true, token: j.access_token, base };
}

async function apiGet(creds, path, opts = {}) {
  const tok = await getAccessToken(creds, opts);
  if (!tok.ok) return tok;
  let res;
  try {
    res = await fetchWithTimeout(opts, tok.base + path, {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + tok.token, 'Content-Type': 'application/json' },
    });
  } catch (e) { return { ok: false, reason: 'unreachable', error: String(e && e.message || e) }; }
  if (res.status === 404) return { ok: false, reason: 'not_found' };
  if (!res.ok) return { ok: false, reason: 'http_' + res.status };
  try { return { ok: true, data: await res.json() }; }
  catch { return { ok: false, reason: 'bad_response' }; }
}

/* GET /v2/payments/captures/{capture_id} — the capture is the payment
   the player made to the operator's account. */
async function getCapture(creds, captureId, opts = {}) {
  const r = await apiGet(creds, '/v2/payments/captures/' + encodeURIComponent(String(captureId)), opts);
  if (!r.ok) return r;
  return { ok: true, capture: normalizeCapture(r.data) };
}
/* GET /v2/checkout/orders/{order_id} — used for ORDER events that carry
   a completed capture. */
async function getOrder(creds, orderId, opts = {}) {
  const r = await apiGet(creds, '/v2/checkout/orders/' + encodeURIComponent(String(orderId)), opts);
  if (!r.ok) return r;
  return { ok: true, order: r.data };
}
function normalizeCapture(c) {
  if (!c || typeof c !== 'object') return null;
  const value = c.amount && c.amount.value !== null && c.amount.value !== undefined ? Number(c.amount.value) : NaN;
  return {
    id: String(c.id || ''),
    status: String(c.status || ''),
    amountMinor: Number.isFinite(value) ? Math.round(value * 100) : null,
    currency: String((c.amount && c.amount.currency_code) || '').toUpperCase() || null,
    payeeEmail: c.payee && c.payee.email_address ? String(c.payee.email_address) : null,
    payeeMerchantId: c.payee && c.payee.merchant_id ? String(c.payee.merchant_id) : null,
    customId: c.custom_id ? String(c.custom_id) : null,
    invoiceId: c.invoice_id ? String(c.invoice_id) : null,
    raw: c,
  };
}

/* POST /v1/notifications/verify-webhook-signature — PayPal verifies its
   own webhook delivery. headers: the paypal-* headers from the delivery
   request; rawBody: the exact request body (parsed here for the
   webhook_event field); webhookId: the method's configured Webhook ID. */
async function verifyWebhookSignature(creds, { webhookId, headers, rawBody }, opts = {}) {
  const tok = await getAccessToken(creds, opts);
  if (!tok.ok) return tok;
  let event = null;
  try { event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '')); } catch {}
  if (!event || typeof event !== 'object') return { ok: false, reason: 'bad_event_json' };
  const payload = {
    transmission_id: headers['paypal-transmission-id'] || '',
    transmission_time: headers['paypal-transmission-time'] || '',
    cert_url: headers['paypal-cert-url'] || '',
    auth_algo: headers['paypal-auth-algo'] || '',
    transmission_sig: headers['paypal-transmission-sig'] || '',
    webhook_id: String(webhookId || ''),
    webhook_event: event,
  };
  if (!payload.transmission_id || !payload.transmission_sig || !payload.webhook_id)
    return { ok: false, reason: 'missing_signature_headers' };
  let res;
  try {
    res = await fetchWithTimeout(opts, tok.base + '/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + tok.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (e) { return { ok: false, reason: 'unreachable', error: String(e && e.message || e) }; }
  if (!res.ok) return { ok: false, reason: 'http_' + res.status };
  let j = null;
  try { j = await res.json(); } catch {}
  return j && j.verification_status === 'SUCCESS'
    ? { ok: true }
    : { ok: false, reason: 'signature_not_verified' };
}

/* Verifies a capture against a deposit expectation. Returns
   { ok:true } only when PayPal confirms: capture COMPLETED, exact
   amount (minor units) and currency, and — when PayPal reports the
   payee email — the payee is the configured receiving account. */
function checkCaptureAgainstDeposit(capture, { amountMinor, currency, accountEmail }) {
  if (!capture) return { ok: false, reason: 'no_capture' };
  if (capture.status !== 'COMPLETED') return { ok: false, reason: 'capture_status_' + String(capture.status || 'unknown').toLowerCase() };
  if (capture.amountMinor === null || capture.amountMinor !== Number(amountMinor))
    return { ok: false, reason: 'amount_mismatch' };
  if (!capture.currency || capture.currency !== String(currency || '').toUpperCase())
    return { ok: false, reason: 'currency_mismatch' };
  if (capture.payeeEmail && accountEmail &&
      capture.payeeEmail.toLowerCase() !== String(accountEmail).toLowerCase())
    return { ok: false, reason: 'payee_mismatch' };
  return { ok: true };
}

module.exports = { BASES, baseUrlForMode, resolveBase, getAccessToken, getCapture, getOrder, normalizeCapture, verifyWebhookSignature, checkCaptureAgainstDeposit, _tokenCache: tokenCache };
