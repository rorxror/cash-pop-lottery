'use strict';
/* AUTO-INTEGRATION round — real provider verification for Auto Pay.
   Run: node --test test/auto-integration.test.js
   Part A (lib level): PayPal base-URL-by-mode (sandbox host asserted),
   OAuth + capture lookup against a local provider double, Skrill
   md5sig against a HARDCODED known vector, the autoCapability unlock
   matrix, and the generic verifier's Coinbase / NOWPayments schemes.
   Part B (spawned server + PayPal HTTP double on 127.0.0.1):
   - PayPal unlock: Auto refuses naming Webhook ID when it is missing,
     saves when Client ID + Secret + Webhook ID are present.
   - Verify-on-submit: COMPLETED capture with exact amount/currency/
     payee credits the exact net ONCE; wrong amount, wrong currency,
     wrong payee, non-completed capture, replayed capture ID and a
     DOWN provider all leave the deposit truthfully pending.
   - PayPal webhook: PayPal-verified PAYMENT.CAPTURE.COMPLETED credits
     once, replay is deduped, a delivery PayPal will not verify gets
     401 and credits nothing; on a Manual method a verified event is
     recorded but never credited.
   - Skrill: Auto unlocks with Merchant ID + Secret Word and NO webhook
     secret; a correctly md5sig-signed status report credits once;
     forged signature -> 401; wrong amount -> recorded, no credit; a
     report that arrives BEFORE the deposit is applied on submit. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENC_KEY = 'c1d2e3f4a5b60718293a4b5c6d7e8f90c1d2e3f4a5b60718293a4b5c6d7e8f90';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-ai-'));
process.env.SQLITE_PATH = path.join(TMP, 'a.sqlite');
process.env.DB_DRIVER = 'sqlite';
process.env.CREDENTIAL_ENCRYPTION_KEY = ENC_KEY;
delete process.env.DATABASE_URL;
delete process.env.PAYPAL_API_BASE_URL;

const paypal = require('../lib/paypal');
const skrill = require('../lib/skrill');
const rails = require('../lib/rails');

/* ---------------- Part A: lib level ---------------- */

test('A1 PayPal base URL follows the Mode field (sandbox is REAL)', async () => {
  assert.equal(paypal.baseUrlForMode('sandbox'), 'https://api-m.sandbox.paypal.com');
  assert.equal(paypal.baseUrlForMode('live'), 'https://api-m.paypal.com');
  assert.equal(paypal.baseUrlForMode(''), 'https://api-m.paypal.com');
  const seen = [];
  const stubFetch = async (url, init) => {
    seen.push(String(url));
    return { ok: true, status: 200, json: async () => ({ access_token: 'TOK', expires_in: 3600 }) };
  };
  const tok = await paypal.getAccessToken({ client_id: 'cid', client_secret: 'sec', mode: 'sandbox' }, { fetchImpl: stubFetch });
  assert.equal(tok.ok, true);
  assert.ok(seen[0].startsWith('https://api-m.sandbox.paypal.com/v1/oauth2/token'), 'sandbox creds must hit the sandbox host, got: ' + seen[0]);
  const seen2 = [];
  const stubFetch2 = async (url, init) => { seen2.push(String(url)); return { ok: true, status: 200, json: async () => ({ access_token: 'TOK2', expires_in: 3600 }) }; };
  await paypal.getAccessToken({ client_id: 'cid-live', client_secret: 'sec', mode: 'live' }, { fetchImpl: stubFetch2 });
  assert.ok(seen2[0].startsWith('https://api-m.paypal.com/v1/oauth2/token'), 'live creds must hit the live host, got: ' + seen2[0]);
});

test('A2 Skrill md5sig: hardcoded known vector + fail-closed checks', () => {
  // Vector computed independently from the documented formula:
  // MD5('100001' + 'DEP-TEST-1' + UPPER(MD5('testsecretword')) + '25.00' + 'USD' + '2')
  const fields = { merchant_id: '100001', transaction_id: 'DEP-TEST-1', mb_amount: '25.00', mb_currency: 'USD', status: '2', mb_transaction_id: 'MB1', pay_to_email: 'owner@skrill.test' };
  assert.equal(skrill.expectedMd5Sig('testsecretword', fields), '8f25617ed1a696f87b258723fb458a92');
  const creds = { merchant_id: '100001', secret_word: 'testsecretword', account_email: 'owner@skrill.test' };
  assert.equal(skrill.verifyStatusReport(creds, { ...fields, md5sig: '8f25617ed1a696f87b258723fb458a92' }).ok, true);
  assert.equal(skrill.verifyStatusReport(creds, { ...fields, md5sig: '8f25617ed1a696f87b258723fb458a93' }).ok, false, 'one-char-off signature must fail');
  assert.equal(skrill.verifyStatusReport(creds, { ...fields, merchant_id: '100002', md5sig: '8f25617ed1a696f87b258723fb458a92' }).ok, false, 'wrong merchant must fail');
  assert.equal(skrill.verifyStatusReport(creds, { ...fields, pay_to_email: 'other@skrill.test', md5sig: '8f25617ed1a696f87b258723fb458a92' }).ok, false, 'report for a different account must fail');
  assert.equal(skrill.verifyStatusReport({ merchant_id: '100001' }, { ...fields, md5sig: '8f25617ed1a696f87b258723fb458a92' }).ok, false, 'missing secret word fails closed');
  const p = skrill.parseStatusReport({ ...fields, md5sig: 'x' });
  assert.equal(p.action, 'payment_success'); assert.equal(p.amountMinor, 2500); assert.equal(p.currency, 'USD');
});

test('A3 autoCapability unlock matrix (Auto exactly when the real fields exist)', () => {
  const pp = rails.getRail('paypal');
  let cap = rails.autoCapability(pp, {});
  assert.equal(cap.canAuto, false);
  assert.ok(cap.missing.includes('Webhook ID'), 'missing names Webhook ID: ' + cap.missing.join(','));
  cap = rails.autoCapability(pp, { account_email: 'o@p.test', client_id: 'cid', client_secret: 'sec', webhook_id: 'WH1' });
  assert.equal(cap.canAuto, true, 'full PayPal creds unlock Auto');
  const ew = rails.getRail('ewallet');
  cap = rails.autoCapability(ew, { provider: 'Skrill', account_email: 'o@s.test', merchant_id: '100001' });
  assert.equal(cap.canAuto, false); assert.ok(cap.missing.includes('Secret Word'));
  cap = rails.autoCapability(ew, { provider: 'Skrill', account_email: 'o@s.test', merchant_id: '100001', secret_word: 'word' });
  assert.equal(cap.canAuto, true, 'Skrill unlocks WITHOUT any webhook_secret — its Secret Word is the real credential');
  cap = rails.autoCapability(ew, { provider: 'Neteller', account_email: 'o@n.test' });
  assert.equal(cap.canAuto, false); assert.ok(cap.missing.some(m => /Webhook signing secret/.test(m)), 'NETELLER still needs the generic webhook secret');
  assert.equal(rails.autoCapability(rails.getRail('bank_transfer'), { bank_name: 'B', account_name: 'A', account_number: '1' }).blocked, true, 'bank transfer can never auto — no provider API exists');
  assert.equal(rails.autoCapability(rails.getRail('upi'), { upi_id: 'a@okbank' }).blocked, true, 'plain UPI ID can never auto');
  assert.equal(rails.autoCapability(rails.getRail('voucher'), { issuer: 'X' }).blocked, true);
  assert.equal(rails.autoCapability(rails.getRail('cash_agent'), { agent_network: 'X' }).blocked, true);
  assert.equal(rails.autoCapability(rails.getRail('qr_pay'), { provider: 'PromptPay', payee_id: '08', qr_image_url: 'https://x.test/q.png' }).blocked, true);
});

test('A4 PayPal capture lookup against a local double + deposit gate', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/v1/oauth2/token') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ access_token: 'DT', expires_in: 3600 })); }
    if (req.url === '/v2/payments/captures/CAP1') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ id: 'CAP1', status: 'COMPLETED', amount: { value: '42.50', currency_code: 'USD' }, payee: { email_address: 'owner@paypal.test', merchant_id: 'M123' } })); }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"name":"RESOURCE_NOT_FOUND"}');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  try {
    const creds = { client_id: 'cid-d', client_secret: 'sec-d', mode: 'sandbox' };
    const got = await paypal.getCapture(creds, 'CAP1', { baseUrl: base });
    assert.equal(got.ok, true);
    assert.equal(got.capture.amountMinor, 4250); assert.equal(got.capture.currency, 'USD'); assert.equal(got.capture.payeeEmail, 'owner@paypal.test');
    assert.equal(paypal.checkCaptureAgainstDeposit(got.capture, { amountMinor: 4250, currency: 'USD', accountEmail: 'owner@paypal.test' }).ok, true);
    assert.equal(paypal.checkCaptureAgainstDeposit(got.capture, { amountMinor: 4251, currency: 'USD', accountEmail: 'owner@paypal.test' }).ok, false);
    assert.equal(paypal.checkCaptureAgainstDeposit(got.capture, { amountMinor: 4250, currency: 'EUR', accountEmail: 'owner@paypal.test' }).ok, false);
    assert.equal(paypal.checkCaptureAgainstDeposit(got.capture, { amountMinor: 4250, currency: 'USD', accountEmail: 'other@paypal.test' }).ok, false);
    const missing = await paypal.getCapture(creds, 'NOPE', { baseUrl: base });
    assert.equal(missing.ok, false); assert.equal(missing.reason, 'not_found');
    const down = await paypal.getCapture(creds, 'CAP1', { baseUrl: 'http://127.0.0.1:1', timeoutMs: 1500 });
    assert.equal(down.ok, false, 'provider down must fail closed, never verify');
  } finally { srv.close(); }
});

test('A5 generic verifier also speaks Coinbase Commerce + NOWPayments (real schemes)', () => {
  const secret = 'whsec-generic-1';
  const methods = [{ id: 7, webhook_secret: secret }];
  const body = Buffer.from(JSON.stringify({ b: 1, a: { d: 4, c: 3 } }));
  const cc = crypto.createHmac('sha256', secret).update(body).digest('hex');
  let r = rails.verifyWebhookSignature('crypto', { body, headers: { 'x-cc-webhook-signature': cc } }, methods);
  assert.equal(r.ok, true, 'Coinbase Commerce header must verify');
  const canonical = JSON.stringify({ a: { c: 3, d: 4 }, b: 1 });
  const np = crypto.createHmac('sha512', secret).update(canonical).digest('hex');
  r = rails.verifyWebhookSignature('crypto', { body, headers: { 'x-nowpayments-sig': np } }, methods);
  assert.equal(r.ok, true, 'NOWPayments sorted-JSON HMAC-SHA512 must verify');
  r = rails.verifyWebhookSignature('crypto', { body, headers: { 'x-nowpayments-sig': np.replace(/.$/, '0') } }, methods);
  assert.equal(r.ok, false, 'tampered NOWPayments signature must fail');
});

/* ---------------- Part B: spawned server + PayPal double ---------------- */

const PORT = 4163;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN_PATH = '/ops-7f3a9c-console';
let server = null, dbB = null, double = null, doublePort = 0, doubleDown = false;
const doubleCalls = { token: 0, verify: 0 };

const CAPTURES = {
  'CAP-OK-100': { id: 'CAP-OK-100', status: 'COMPLETED', amount: { value: '100.00', currency_code: 'USD' }, payee: { email_address: 'owner@paypal.test' } },
  'CAP-OK-200': { id: 'CAP-OK-200', status: 'COMPLETED', amount: { value: '200.00', currency_code: 'USD' }, payee: { email_address: 'owner@paypal.test' } },
  'CAP-WRONG-AMT': { id: 'CAP-WRONG-AMT', status: 'COMPLETED', amount: { value: '50.00', currency_code: 'USD' }, payee: { email_address: 'owner@paypal.test' } },
  'CAP-WRONG-CUR': { id: 'CAP-WRONG-CUR', status: 'COMPLETED', amount: { value: '100.00', currency_code: 'EUR' }, payee: { email_address: 'owner@paypal.test' } },
  'CAP-WRONG-PAYEE': { id: 'CAP-WRONG-PAYEE', status: 'COMPLETED', amount: { value: '100.00', currency_code: 'USD' }, payee: { email_address: 'someoneelse@paypal.test' } },
  'CAP-PENDING': { id: 'CAP-PENDING', status: 'PENDING', amount: { value: '100.00', currency_code: 'USD' }, payee: { email_address: 'owner@paypal.test' } },
};
function startDouble() {
  return new Promise(resolve => {
    double = http.createServer((req, res) => {
      let raw = '';
      req.on('data', d => raw += d);
      req.on('end', () => {
        if (doubleDown) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end('{"name":"INTERNAL_ERROR"}'); }
        if (req.url === '/v1/oauth2/token') { doubleCalls.token++; res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ access_token: 'DOUBLE-TOKEN', expires_in: 3600 })); }
        if (req.url === '/v1/notifications/verify-webhook-signature') {
          doubleCalls.verify++;
          let j = {}; try { j = JSON.parse(raw || '{}'); } catch {}
          const forged = j.webhook_event && j.webhook_event.id === 'EVT-FORGED';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ verification_status: forged ? 'FAILURE' : 'SUCCESS' }));
        }
        const cm = /^\/v2\/payments\/captures\/(.+)$/.exec(req.url || '');
        if (cm && CAPTURES[cm[1]]) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(CAPTURES[cm[1]])); }
        res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"name":"RESOURCE_NOT_FOUND"}');
      });
    });
    double.listen(0, '127.0.0.1', () => { doublePort = double.address().port; resolve(); });
  });
}

class Jar {
  constructor(ua) { this.cookies = new Map(); this.ua = ua || 'ai-test'; }
  async req(p, { method = 'GET', body, headers = {} } = {}) {
    const h = { 'User-Agent': this.ua, ...headers };
    if (this.cookies.size) h.Cookie = [...this.cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
    let payload;
    if (body) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    const res = await fetch(BASE + p, { method, headers: h, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) { const pair = c.split(';')[0]; const i = pair.indexOf('='); if (i > 0) { const k = pair.slice(0, i).trim(); const v = pair.slice(i + 1).trim(); if (v) this.cookies.set(k, v); else this.cookies.delete(k); } }
    return res;
  }
  async text(p, opts) { const r = await this.req(p, opts); return { status: r.status, loc: r.headers.get('location') || '', body: await r.text() }; }
}
function csrfOf(html) { const m = String(html).match(/name="_csrf" value="([^"]+)"/); return m && m[1]; }
async function waitHealthy(tries = 60) {
  for (let i = 0; i < tries; i++) { try { const r = await fetch(BASE + '/healthz'); if (r.status === 200) return true; } catch {} await new Promise(r => setTimeout(r, 500)); }
  return false;
}

let adminJar; const players = {};
let ppMethodId, ewMethodId;
async function saveCreds(methodId, fields) {
  const g = await adminJar.text(`${ADMIN_PATH}/methods/${methodId}/credentials`);
  assert.equal(g.status, 200, 'credentials page loads');
  const post = await adminJar.text(`${ADMIN_PATH}/methods/${methodId}/credentials`, { method: 'POST', body: { _csrf: csrfOf(g.body), ...fields } });
  assert.equal(post.status, 302, 'credentials save redirects');
}
async function setMode(methodId, mode) {
  const g = await adminJar.text(`${ADMIN_PATH}/methods/${methodId}/credentials`);
  const post = await adminJar.text(`${ADMIN_PATH}/methods/${methodId}/mode`, { method: 'POST', body: { _csrf: csrfOf(g.body), processing_mode: mode } });
  assert.equal(post.status, 302);
  return (await dbB.get('SELECT processing_mode FROM payment_methods WHERE id = ?', [methodId])).processing_mode;
}
async function toggle(methodId) {
  const g = await adminJar.text(ADMIN_PATH + '/methods');
  const post = await adminJar.text(`${ADMIN_PATH}/methods/${methodId}/toggle`, { method: 'POST', body: { _csrf: csrfOf(g.body) } });
  assert.equal(post.status, 302);
}
async function makePlayer(tag) {
  const jar = new Jar('ai-' + tag);
  const g = await jar.text('/register');
  const post = await jar.text('/register', { method: 'POST', body: { _csrf: csrfOf(g.body), name: 'AI ' + tag, email: tag + '@ai.test', password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(post.status, 302, 'register ' + tag);
  const u = await dbB.get('SELECT id FROM users WHERE email = ?', [tag + '@ai.test']);
  await dbB.run('UPDATE users SET email_verified = 1 WHERE id = ?', [u.id]);
  players[tag] = { jar, id: u.id };
  return players[tag];
}
async function depositAs(tag, methodId, amount, proof) {
  const p = players[tag];
  const g = await p.jar.text('/deposit/new?m=' + methodId);
  assert.equal(g.status, 200, 'deposit page loads');
  const body = { _csrf: csrfOf(g.body), method_id: String(methodId), amount };
  for (const [k, v] of Object.entries(proof || {})) body['custom_' + k] = v;
  const post = await p.jar.text('/deposit/new', { method: 'POST', body });
  assert.equal(post.status, 302, 'deposit submit redirects');
  return dbB.get('SELECT * FROM deposits WHERE user_id = ? AND method_id = ? ORDER BY id DESC LIMIT 1', [p.id, methodId]);
}
async function balance(tag, currency = 'USD') {
  const w = await dbB.get('SELECT balance FROM wallets WHERE user_id = ? AND currency = ?', [players[tag].id, currency]);
  return w ? Number(w.balance) : 0;
}
async function postPaypalWebhook(event) {
  const res = await fetch(BASE + '/webhooks/paypal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'paypal-transmission-id': 'T-' + event.id, 'paypal-transmission-time': '2026-10-29T00:00:00Z', 'paypal-cert-url': 'https://api.paypal.com/v1/notifications/certs/CERT', 'paypal-auth-algo': 'SHA256withRSA', 'paypal-transmission-sig': 'SIG' },
    body: JSON.stringify(event),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
function skrillReport(fields) {
  const signed = { ...fields, md5sig: skrill.expectedMd5Sig('testsecretword', fields) };
  return fetch(BASE + '/webhooks/skrill', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(signed).toString() });
}

test.before(async () => {
  await startDouble();
  const TMPB = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-ai-b-'));
  const env = { ...process.env,
    PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite',
    SQLITE_PATH: path.join(TMPB, 'b.sqlite'),
    TICKET_HMAC_SECRET: ('ai-test-ticket-' + 'hmac-secret-throwaway-0123456789'),
    CREDENTIAL_ENCRYPTION_KEY: ENC_KEY,
    ADMIN_SEED_EMAIL: 'admin@ai.test', ADMIN_SEED_PASSWORD: 'AiAdmin#pass', ADMIN_SEED_NAME: 'AI Admin',
    PAYPAL_API_BASE_URL: 'http://127.0.0.1:' + doublePort,
  };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[ai server] ' + d));
  assert.ok(await waitHealthy(), 'server must boot');
  process.env.SQLITE_PATH = path.join(TMPB, 'b.sqlite');
  dbB = require('../lib/db').openDB().db;
  ppMethodId = (await dbB.get("SELECT id FROM payment_methods WHERE slug = 'rail-paypal'")).id;
  ewMethodId = (await dbB.get("SELECT id FROM payment_methods WHERE slug = 'rail-ewallet'")).id;
  adminJar = new Jar('ai-admin');
  const g = await adminJar.text('/login');
  const post = await adminJar.text('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email: 'admin@ai.test', password: 'AiAdmin#pass' } });
  assert.equal(post.status, 302); assert.ok(post.loc.includes(ADMIN_PATH));
  await makePlayer('pa'); await makePlayer('pb'); await makePlayer('pc');
});

test.after(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch {} }
  if (double) { try { double.close(); } catch {} }
  try { if (dbB) await dbB.close(); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('B1 PayPal Auto unlock: refused naming Webhook ID, saves with full real creds', { timeout: 60000 }, async () => {
  await saveCreds(ppMethodId, { account_email: 'owner@paypal.test', account_name: 'Owner Biz', mode: 'sandbox', client_id: 'cid-ai', client_secret: 'secret-ai-123' });
  let mode = await setMode(ppMethodId, 'auto');
  assert.equal(mode, 'manual', 'Auto must refuse while Webhook ID is missing');
  const page = await adminJar.text(`${ADMIN_PATH}/methods/${ppMethodId}/credentials`);
  assert.ok(page.body.includes('Webhook ID'), 'refusal names the missing Webhook ID field');
  await saveCreds(ppMethodId, { account_email: 'owner@paypal.test', account_name: 'Owner Biz', mode: 'sandbox', client_id: 'cid-ai', client_secret: 'secret-ai-123', webhook_id: 'WH-AI-1' });
  mode = await setMode(ppMethodId, 'auto');
  assert.equal(mode, 'auto', 'Auto saves once Client ID + Secret + Webhook ID exist');
  await toggle(ppMethodId);
});

test('B2 PayPal verify-on-submit: exact COMPLETED capture credits the exact net once', { timeout: 60000 }, async () => {
  const d = await depositAs('pa', ppMethodId, '100.00', { paypal_txid: 'CAP-OK-100', sender_email: 'pa@paypal.test' });
  assert.equal(d.status, 'approved', 'verified capture auto-approves at submit');
  assert.equal(d.provider_txn_id, 'CAP-OK-100');
  assert.equal(await balance('pa'), 10000, 'wallet credited the exact net (100.00, zero charge method)');
  assert.ok(doubleCalls.token >= 1, 'the server really called the provider double for a token');
});

test('B3 PayPal verify-on-submit negatives stay truthfully pending', { timeout: 60000 }, async () => {
  for (const txid of ['CAP-WRONG-AMT', 'CAP-WRONG-CUR', 'CAP-WRONG-PAYEE', 'CAP-PENDING', 'CAP-UNKNOWN-404']) {
    const d = await depositAs('pa', ppMethodId, '100.00', { paypal_txid: txid });
    assert.equal(d.status, 'pending', txid + ' must NOT credit');
  }
  assert.equal(await balance('pa'), 10000, 'no negative case moved the balance');
});

test('B4 PayPal replay: the same capture ID can never credit twice', { timeout: 60000 }, async () => {
  const d = await depositAs('pb', ppMethodId, '100.00', { paypal_txid: 'CAP-OK-100' });
  assert.equal(d.status, 'pending', 'a capture already consumed by another deposit stays pending');
  assert.equal(await balance('pb'), 0);
});

test('B5 PayPal provider DOWN: deposit stays pending, no fake success', { timeout: 60000 }, async () => {
  doubleDown = true;
  try {
    const d = await depositAs('pb', ppMethodId, '200.00', { paypal_txid: 'CAP-OK-200' });
    assert.equal(d.status, 'pending', 'provider outage leaves the deposit pending');
  } finally { doubleDown = false; }
  assert.equal(await balance('pb'), 0);
});

test('B6 PayPal webhook: verified CAPTURE.COMPLETED credits once; replay deduped; unverifiable gets 401', { timeout: 60000 }, async () => {
  const d0 = await depositAs('pb', ppMethodId, '75.00', { paypal_txid: 'CAP-WEBHOOK-ONLY' });
  assert.equal(d0.status, 'pending', 'unknown capture at submit stays pending');
  const ev = { id: 'EVT-1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-WEBHOOK-ONLY', status: 'COMPLETED', amount: { value: '75.00', currency_code: 'USD' }, payee: { email_address: 'owner@paypal.test' } } };
  const r1 = await postPaypalWebhook(ev);
  assert.equal(r1.status, 200); assert.match(r1.body.note, /approved/);
  const d1 = await dbB.get('SELECT * FROM deposits WHERE id = ?', [d0.id]);
  assert.equal(d1.status, 'approved'); assert.equal(d1.provider_txn_id, 'CAP-WEBHOOK-ONLY');
  assert.equal(await balance('pb'), 7500);
  const r2 = await postPaypalWebhook(ev);
  assert.equal(r2.status, 200); assert.match(r2.body.note, /duplicate/);
  assert.equal(await balance('pb'), 7500, 'replayed event credits nothing more');
  const dF = await depositAs('pb', ppMethodId, '75.00', { paypal_txid: 'CAP-FORGED' });
  const rF = await postPaypalWebhook({ id: 'EVT-FORGED', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-FORGED', status: 'COMPLETED', amount: { value: '75.00', currency_code: 'USD' }, payee: { email_address: 'owner@paypal.test' } } });
  assert.equal(rF.status, 401, 'a delivery PayPal will not verify is rejected');
  assert.equal((await dbB.get('SELECT status FROM deposits WHERE id = ?', [dF.id])).status, 'pending');
  assert.equal(await balance('pb'), 7500);
});

test('B7 PayPal webhook on a MANUAL method: verified event recorded, never credited', { timeout: 60000 }, async () => {
  assert.equal(await setMode(ppMethodId, 'manual'), 'manual');
  const d0 = await depositAs('pb', ppMethodId, '75.00', { paypal_txid: 'CAP-MANUAL-1' });
  assert.equal(d0.status, 'pending');
  const r = await postPaypalWebhook({ id: 'EVT-2', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: 'CAP-MANUAL-1', status: 'COMPLETED', amount: { value: '75.00', currency_code: 'USD' }, payee: { email_address: 'owner@paypal.test' } } });
  assert.equal(r.status, 200); assert.match(r.body.note, /Manual Pay/);
  assert.equal((await dbB.get('SELECT status FROM deposits WHERE id = ?', [d0.id])).status, 'pending', 'manual method never auto-credits');
  assert.equal(await balance('pb'), 7500);
  assert.equal(await setMode(ppMethodId, 'auto'), 'auto', 'restore Auto for later tests');
});

test('B8 Skrill Auto unlock: Merchant ID + Secret Word, NO webhook secret', { timeout: 60000 }, async () => {
  await saveCreds(ewMethodId, { provider: 'Skrill', account_email: 'owner@skrill.test', merchant_id: '100001' });
  let mode = await setMode(ewMethodId, 'auto');
  assert.equal(mode, 'manual', 'Auto refuses while the Secret Word is missing');
  await saveCreds(ewMethodId, { provider: 'Skrill', account_email: 'owner@skrill.test', merchant_id: '100001', secret_word: 'testsecretword' });
  mode = await setMode(ewMethodId, 'auto');
  assert.equal(mode, 'auto', 'Skrill Auto saves on its REAL credentials (Merchant ID + Secret Word)');
  await toggle(ewMethodId);
});

test('B9 Skrill status report: signed report credits once; forged 401; wrong amount no credit', { timeout: 60000 }, async () => {
  const d1 = await depositAs('pc', ewMethodId, '25.00', { ewallet_txid: 'MB-TRN-1' });
  assert.equal(d1.status, 'pending');
  const okRes = await skrillReport({ merchant_id: '100001', transaction_id: '', mb_transaction_id: 'MB-TRN-1', pay_to_email: 'owner@skrill.test', pay_from_email: 'pc@skrill.test', mb_amount: '25.00', mb_currency: 'USD', status: '2' });
  assert.equal(okRes.status, 200);
  assert.equal((await dbB.get('SELECT status FROM deposits WHERE id = ?', [d1.id])).status, 'approved');
  assert.equal(await balance('pc'), 2500);
  const again = await skrillReport({ merchant_id: '100001', transaction_id: '', mb_transaction_id: 'MB-TRN-1', pay_to_email: 'owner@skrill.test', pay_from_email: 'pc@skrill.test', mb_amount: '25.00', mb_currency: 'USD', status: '2' });
  assert.equal(again.status, 200);
  assert.equal(await balance('pc'), 2500, 'replayed report credits nothing more');

  const d2 = await depositAs('pc', ewMethodId, '25.00', { ewallet_txid: 'MB-TRN-2' });
  const forged = await fetch(BASE + '/webhooks/skrill', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ merchant_id: '100001', transaction_id: '', mb_transaction_id: 'MB-TRN-2', pay_to_email: 'owner@skrill.test', mb_amount: '25.00', mb_currency: 'USD', status: '2', md5sig: 'deadbeefdeadbeefdeadbeefdeadbeef' }).toString() });
  assert.equal(forged.status, 401, 'forged md5sig is rejected');
  assert.equal((await dbB.get('SELECT status FROM deposits WHERE id = ?', [d2.id])).status, 'pending');

  const d3 = await depositAs('pc', ewMethodId, '25.00', { ewallet_txid: 'MB-TRN-3' });
  const wrongAmt = await skrillReport({ merchant_id: '100001', transaction_id: '', mb_transaction_id: 'MB-TRN-3', pay_to_email: 'owner@skrill.test', pay_from_email: 'pc@skrill.test', mb_amount: '24.00', mb_currency: 'USD', status: '2' });
  assert.equal(wrongAmt.status, 200, 'authentic report is acknowledged');
  assert.equal((await dbB.get('SELECT status FROM deposits WHERE id = ?', [d3.id])).status, 'pending', 'amount mismatch never credits');
  assert.equal(await balance('pc'), 2500);
});

test('B10 Skrill report BEFORE the deposit: applied on submit', { timeout: 60000 }, async () => {
  const early = await skrillReport({ merchant_id: '100001', transaction_id: '', mb_transaction_id: 'MB-TRN-4', pay_to_email: 'owner@skrill.test', pay_from_email: 'pc@skrill.test', mb_amount: '40.00', mb_currency: 'USD', status: '2' });
  assert.equal(early.status, 200);
  const d = await depositAs('pc', ewMethodId, '40.00', { ewallet_txid: 'MB-TRN-4' });
  assert.equal(d.status, 'approved', 'the already-verified report credits at submit time');
  assert.equal(await balance('pc'), 6500);
});
