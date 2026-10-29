'use strict';
/* V20 / U-21 PAYMENTS — per-method config audit regression tests.
   Run: node --test test/v20-payments.test.js
   Part A (lib level, own temp DB): rail definitions are complete and
   honest (PayPal exists, no blob credentials, every webhook rail can
   supply a webhook_secret, every password field is secret-flagged),
   per-key validation gives true reasons, credentials saved through
   lib/credentials land ENCRYPTED at rest while receiving details stay
   readable through the app, and money.createDeposit rejects malformed
   proof with the true reason.
   Part B (spawned server, port 4125): the real admin credentials form
   drives crypto (player deposit page shows asset/network/address
   exactly as saved), Stripe-cards webhook verification (good Stripe
   signature approves + credits; bad signature is rejected and nothing
   moves), and PayPal manual flow (admin form -> player page pay-to ->
   deposit request reaches the queue with the transaction ID intact). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'; // throwaway test key (64 hex)
const TMP_A = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-v20a-'));
const TMP_B = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-v20b-'));
process.env.SQLITE_PATH = path.join(TMP_A, 'a.sqlite');
process.env.DB_DRIVER = 'sqlite';
process.env.CREDENTIAL_ENCRYPTION_KEY = ENC_KEY;
delete process.env.DATABASE_URL;

const { openDB } = require('../lib/db');
const { migrate } = require('../lib/migrations');
const rails = require('../lib/rails');
const creds = require('../lib/credentials');
const money = require('../lib/money');
const { now } = require('../lib/util');

const { db } = openDB();

/* ---------------- Part A: lib level ---------------- */

test.before(async () => { await migrate(db, 'sqlite'); });

test('U-21 definitions: PayPal is a real rail; ewallet no longer lumps it in; no blob credentials anywhere', () => {
  const paypal = rails.getRail('paypal');
  assert.ok(paypal, 'paypal rail must exist');
  /* AUTO-INTEGRATION round supersedes the v20/v21 state: PayPal
     verification is still NOT HMAC — but lib/paypal.js now verifies it
     for real (OAuth2 + capture lookup + PayPal's verify-webhook-
     signature API on the dedicated /webhooks/paypal route), so the
     rail may claim a confirmation path. What must NEVER happen is the
     generic HMAC verifier being PayPal's gate: rails.autoCapability
     requires the webhook_id the real verifier reads. */
  assert.equal(paypal.webhook, true, 'paypal has a real (non-HMAC) verification client since the AUTO-INTEGRATION round');
  assert.ok(paypal.credentialFields.some(f => f.key === 'webhook_id'), 'paypal must carry the Webhook ID its verifier reads');
  const ppKeys = paypal.credentialFields.map(f => f.key);
  assert.ok(ppKeys.includes('account_email') && ppKeys.includes('client_id') && ppKeys.includes('client_secret'));
  const ew = rails.getRail('ewallet');
  assert.ok(!(ew.credentialFields.find(f => f.key === 'provider').options || []).includes('PayPal'), 'ewallet provider options must not claim PayPal');
  assert.ok(!ew.credentialFields.some(f => /PayPal/.test(f.label)), 'ewallet field labels must not claim PayPal');
  assert.ok(!JSON.stringify(rails.RAILS).includes('api_credentials'), 'the single-blob "API credentials" field is gone');
  for (const r of rails.RAILS) {
    for (const f of r.credentialFields) {
      if (f.type === 'password') assert.equal(f.secret, true, `${r.key}.${f.key} is a password field and must be secret-flagged`);
    }
  }
});

test('U-21 definitions: every webhook:true rail can supply the credential its verifier reads', () => {
  for (const r of rails.RAILS) {
    if (!r.webhook) continue;
    /* AUTO-INTEGRATION: PayPal is the one provider-API exception — its
       verifier (lib/paypal.js) reads client_id/secret + webhook_id,
       never an HMAC secret. Every other webhook rail's generic
       verifier reads webhook_secret, so the field must exist. */
    if (r.key === 'paypal') {
      assert.ok(r.credentialFields.some(f => f.key === 'webhook_id'), 'paypal verifier reads webhook_id');
      continue;
    }
    assert.ok(r.credentialFields.some(f => f.key === 'webhook_secret'), `${r.key} claims webhooks but has no webhook_secret field`);
  }
  // manual-mode honesty: no provider-API field is required on any rail
  for (const r of rails.RAILS) {
    for (const f of r.credentialFields) {
      if (f.type === 'password') assert.ok(!f.required, `${r.key}.${f.key} must not be required — manual mode must work without API credentials`);
    }
  }
});

test('U-21 validation: true reasons for the classic garbage saves', () => {
  // crypto: network now required; address shape enforced
  let v = rails.validateRailCredentials('crypto', { asset: 'USDT', wallet_address: 'TXYZ1234567890abcdefghijklmnopqrstuv' });
  assert.equal(v.ok, false); assert.match(v.error, /Network/);
  v = rails.validateRailCredentials('crypto', { asset: 'USDT', network: 'TRC20', wallet_address: 'short' });
  assert.match(v.error, /wallet address/i);
  v = rails.validateRailCredentials('crypto', { asset: 'USDT', network: 'TRC20', wallet_address: 'TXYZ1234567890abcdefghijklmnopqrstuv', confirmations: '3' });
  assert.equal(v.ok, true, JSON.stringify(v));
  // upi VPA shape
  assert.match(rails.validateRailCredentials('upi', { upi_id: 'not-an-upi' }).error, /UPI ID/);
  assert.equal(rails.validateRailCredentials('upi', { upi_id: 'shop@okhdfcbank' }).ok, true);
  // cards: Stripe test key under live mode is a mismatch, sandbox is fine
  v = rails.validateRailCredentials('cards', { provider: 'Stripe', mode: 'live', publishable_key: 'pk_test_abc123456789', secret_key: 'sk_test_abc123456789', webhook_secret: 'whsec_testsecret123' });
  assert.match(v.error, /sandbox|test key|Mode is set to live/i);
  v = rails.validateRailCredentials('cards', { provider: 'Stripe', mode: 'sandbox', publishable_key: 'pk_test_abc123456789', secret_key: 'sk_test_abc123456789', webhook_secret: 'whsec_testsecret123' });
  assert.equal(v.ok, true, JSON.stringify(v));
  assert.match(rails.validateRailCredentials('cards', { provider: 'Stripe', webhook_secret: 'notwhsec' }).error, /whsec_/);
  // bank: SWIFT vs routing are different fields with different shapes
  const bankBase = { bank_name: 'Bank', account_name: 'Owner', account_number: 'GB29NWBK60161331926819' };
  assert.match(rails.validateRailCredentials('bank_transfer', { ...bankBase, swift: '12345678' }).error, /SWIFT\/BIC/);
  assert.equal(rails.validateRailCredentials('bank_transfer', { ...bankBase, swift: 'CHASUS33' }).ok, true);
  assert.match(rails.validateRailCredentials('bank_transfer', { ...bankBase, routing_number: '12345' }).error, /9 digits/);
  assert.equal(rails.validateRailCredentials('bank_transfer', { ...bankBase, routing_number: '021000021' }).ok, true);
  // qr: https only; apple merchant id shape; pix key shapes
  assert.match(rails.validateRailCredentials('qr_pay', { provider: 'PromptPay', payee_id: '0812345678', qr_image_url: 'http://x.test/q.png' }).error, /https/);
  assert.match(rails.validateRailCredentials('apple_pay', { merchant_id: 'com.example', processor: 'Stripe' }).error, /merchant\./);
  assert.equal(rails.validateRailCredentials('pix', { pix_key: '12345678901' }).ok, true, 'CPF pix key');
  assert.match(rails.validateRailCredentials('pix', { pix_key: '!!' }).error, /Pix key/);
  // paypal: email required and shaped
  assert.match(rails.validateRailCredentials('paypal', { account_email: 'nope' }).error, /email/);
  assert.equal(rails.validateRailCredentials('paypal', { account_email: 'pay@v20.test' }).ok, true);
});

test('U-21 proof validation: tx_hash and UTR formats, true reasons', () => {
  assert.match(rails.validateUserProof('crypto', { tx_hash: 'abc' }), /Transaction hash/);
  assert.equal(rails.validateUserProof('crypto', { tx_hash: 'a'.repeat(64) }), '');
  assert.equal(rails.validateUserProof('crypto', { tx_hash: '0x' + 'b'.repeat(64) }), '');
  assert.match(rails.validateUserProof('upi', { utr: '12345' }), /UTR/);
  assert.equal(rails.validateUserProof('upi', { utr: '123456789012' }), '');
  assert.equal(rails.validateUserProof('bank_transfer', { reference: 'anything' }), '', 'unfixed formats stay unenforced');
});

test('U-21 credentials store: secrets unreadable at rest, receiving details readable through the app', async () => {
  const method = await db.get("SELECT * FROM payment_methods WHERE slug = 'rail-crypto'");
  assert.ok(method, 'seeded crypto method exists');
  const ADDR = 'TXYZ1234567890abcdefghijklmnopqrstuv';
  const SECRET = 'whsec_throwaway_v20_secret';
  await creds.saveCredentialField(db, method.id, 'asset', 'USDT');
  await creds.saveCredentialField(db, method.id, 'network', 'TRC20');
  await creds.saveCredentialField(db, method.id, 'wallet_address', ADDR);
  await creds.saveCredentialField(db, method.id, 'confirmations', '3');
  await creds.saveCredentialField(db, method.id, 'webhook_secret', SECRET);
  const rows = await db.query('SELECT * FROM gateway_credentials WHERE method_id = ?', [method.id]);
  assert.ok(rows.length >= 5);
  for (const r of rows) {
    assert.equal(Number(r.field_enc), 1, r.field_key + ' must be flagged encrypted');
    assert.ok(String(r.field_value).startsWith('v1:'), r.field_key + ' must be an envelope at rest');
    assert.ok(!String(r.field_value).includes(SECRET) && !String(r.field_value).includes(ADDR), r.field_key + ' plaintext must not appear at rest');
  }
  // runtime read path returns the pay-to details exactly, and never the secret
  const receiving = await rails.getReceivingDetails(db, method);
  const byKey = Object.fromEntries(receiving.map(r => [r.key, r.value]));
  assert.equal(byKey.wallet_address, ADDR);
  assert.equal(byKey.network, 'TRC20');
  assert.equal(byKey.asset, 'USDT');
  assert.equal(byKey.confirmations, '3');
  assert.ok(!receiving.some(r => r.key === 'webhook_secret'), 'webhook secret must never be a receiving detail');
  assert.equal(rails.isSecretField('crypto', 'webhook_secret'), true);
  assert.equal(rails.isSecretField('crypto', 'wallet_address'), false);
});

test('U-21 public config: publishable/gateway values readable, secret keys never exposed', async () => {
  const method = await db.get("SELECT * FROM payment_methods WHERE slug = 'rail-cards'");
  await creds.saveCredentialField(db, method.id, 'provider', 'Stripe');
  await creds.saveCredentialField(db, method.id, 'mode', 'sandbox');
  await creds.saveCredentialField(db, method.id, 'publishable_key', 'pk_test_v20public123');
  await creds.saveCredentialField(db, method.id, 'secret_key', 'sk_test_v20secret123');
  await creds.saveCredentialField(db, method.id, 'webhook_secret', 'whsec_v20publictest');
  const pub = await rails.getPublicConfig(db, method);
  const keys = pub.map(r => r.key);
  assert.ok(keys.includes('publishable_key'), 'public config carries the checkout values: ' + keys.join(','));
  /* U-28.9 (v20, applied by the U-24 wave): the sandbox/live `mode` is
     owner-only posture and was REMOVED from PUBLIC_CONFIG_FIELDS — the
     pre-U-28.9 assertion that mode is public is superseded, exactly
     like BP-16's healthz `time` expectation. Mode must NOT surface. */
  assert.ok(!keys.includes('mode'), 'sandbox/live mode must never be public config (U-28.9)');
  assert.ok(!keys.includes('secret_key') && !keys.includes('webhook_secret'), 'secrets must never be public config');
});

test('U-21 credentials store fails closed without an encryption key', async () => {
  const method = await db.get("SELECT * FROM payment_methods WHERE slug = 'rail-upi'");
  const saved = process.env.CREDENTIAL_ENCRYPTION_KEY;
  delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  try { await assert.rejects(() => creds.saveCredentialField(db, method.id, 'upi_id', 'shop@okhdfcbank'), /CREDENTIAL_ENCRYPTION_KEY/); }
  finally { process.env.CREDENTIAL_ENCRYPTION_KEY = saved; }
});

test('U-21 money engine: malformed crypto proof rejected with true reason; valid proof stored intact', async () => {
  const u = await db.run("INSERT INTO users (email, name, password_hash, role, status, email_verified, created_at) VALUES ('proof@v20.test', 'Proof', 'x', 'player', 'active', 1, ?)", [now()]);
  const method = await db.get("SELECT * FROM payment_methods WHERE slug = 'rail-crypto'");
  await assert.rejects(
    () => money.createDeposit(db, { userId: u.id, method, amountMinor: 1000, userData: { tx_hash: 'abc' } }),
    /Transaction hash/);
  const good = 'c'.repeat(64);
  const dep = await money.createDeposit(db, { userId: u.id, method, amountMinor: 1000, userData: { tx_hash: good } });
  const row = await db.get('SELECT user_data FROM deposits WHERE id = ?', [dep.id]);
  assert.equal(money.decodeUserData(row.user_data).tx_hash, good, 'proof survives the deposit round-trip intact');
});

/* ---------------- Part B: spawned server (port 4125) ---------------- */

const PORT = 4125;
const BASE = 'http://localhost:' + PORT;
const ADMIN_PATH = '/ops-7f3a9c-console';
let server = null;
let dbB = null;

class Jar {
  constructor(ua) { this.cookies = new Map(); this.ua = ua || 'v20-test-agent'; }
  async req(p, { method = 'GET', body, rawBody, headers = {} } = {}) {
    const h = { 'User-Agent': this.ua, ...headers };
    if (this.cookies.size) h.Cookie = [...this.cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
    let payload;
    if (body) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    if (rawBody !== undefined) payload = rawBody;
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

let adminJar, playerJar;
const WALLET = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE'; // well-known-shaped throwaway TRC20 address (test data)
const CARDS_WHSEC = 'whsec_v20cardssecret';
let cryptoId, cardsId, paypalId, playerId;

test.before(async () => {
  const env = { ...process.env,
    PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite',
    SQLITE_PATH: path.join(TMP_B, 'b.sqlite'),
    TICKET_HMAC_SECRET: 'v20-ticket-hmac-secret-long-enough-0123456789',
    CREDENTIAL_ENCRYPTION_KEY: ENC_KEY,
    ADMIN_SEED_EMAIL: 'admin@v20.test', ADMIN_SEED_PASSWORD: 'V20Admin#pass', ADMIN_SEED_NAME: 'V20 Admin',
  };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[v20 server] ' + d));
  assert.ok(await waitHealthy(), 'server must boot');
  process.env.SQLITE_PATH = path.join(TMP_B, 'b.sqlite');
  dbB = openDB().db;
  cryptoId = (await dbB.get("SELECT id FROM payment_methods WHERE slug = 'rail-crypto'")).id;
  cardsId = (await dbB.get("SELECT id FROM payment_methods WHERE slug = 'rail-cards'")).id;
  paypalId = (await dbB.get("SELECT id FROM payment_methods WHERE slug = 'rail-paypal'")).id;
  assert.ok(paypalId, 'paypal method template must be seeded from the new rail');

  adminJar = new Jar('v20-admin');
  let g = await adminJar.text('/login');
  let post = await adminJar.text('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email: 'admin@v20.test', password: 'V20Admin#pass' } });
  assert.equal(post.status, 302); assert.ok(post.loc.includes(ADMIN_PATH));

  playerJar = new Jar('v20-player');
  g = await playerJar.text('/register');
  post = await playerJar.text('/register', { method: 'POST', body: { _csrf: csrfOf(g.body), name: 'V20 Player', email: 'player@v20.test', password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(post.status, 302, 'register: ' + post.status);
  const u = await dbB.get("SELECT id FROM users WHERE email = 'player@v20.test'");
  playerId = u.id;
  await dbB.run('UPDATE users SET email_verified = 1 WHERE id = ?', [playerId]);
});

test.after(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch {} }
  try { await db.close(); } catch {}
  try { if (dbB) await dbB.close(); } catch {}
  fs.rmSync(TMP_A, { recursive: true, force: true });
  fs.rmSync(TMP_B, { recursive: true, force: true });
});

async function saveCredentialsViaAdminForm(methodId, fields) {
  const g = await adminJar.text(`${ADMIN_PATH}/methods/${methodId}/credentials`);
  assert.equal(g.status, 200, 'credentials page loads');
  const post = await adminJar.text(`${ADMIN_PATH}/methods/${methodId}/credentials`, { method: 'POST', body: { _csrf: csrfOf(g.body), ...fields } });
  assert.equal(post.status, 302, 'credentials save redirects');
  return g.body;
}
async function toggleMethod(methodId) {
  const g = await adminJar.text(ADMIN_PATH + '/methods');
  const post = await adminJar.text(`${ADMIN_PATH}/methods/${methodId}/toggle`, { method: 'POST', body: { _csrf: csrfOf(g.body) } });
  assert.equal(post.status, 302);
}

test('E2E-1 crypto: admin form -> encrypted at rest -> player deposit page shows asset+network+address exactly', { timeout: 60000 }, async () => {
  const formHtml = await saveCredentialsViaAdminForm(cryptoId, {
    asset: 'USDT', network: 'TRC20', wallet_address: WALLET, confirmations: '3', webhook_secret: '',
  });
  assert.match(formHtml, /Asset/, 'crypto form carries the new asset field');
  const raw = await dbB.get("SELECT * FROM gateway_credentials WHERE method_id = ? AND field_key = 'wallet_address'", [cryptoId]);
  assert.equal(Number(raw.field_enc), 1);
  assert.ok(!String(raw.field_value).includes(WALLET), 'wallet address must not be plaintext at rest');
  await toggleMethod(cryptoId);
  const page = await playerJar.text('/deposit/new?m=' + cryptoId);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(WALLET), 'player page shows the exact saved wallet address');
  assert.ok(page.body.includes('TRC20'), 'player page shows the exact saved network');
  assert.ok(page.body.includes('USDT'), 'player page shows the saved asset');
});

test('E2E-2 cards/Stripe sandbox: config save -> encrypted at rest -> good Stripe signature approves+credits, bad signature rejected', { timeout: 60000 }, async () => {
  await saveCredentialsViaAdminForm(cardsId, {
    provider: 'Stripe', mode: 'sandbox', publishable_key: 'pk_test_v20e2e123456', secret_key: 'sk_test_v20e2e123456', webhook_secret: CARDS_WHSEC,
  });
  const raw = await dbB.get("SELECT * FROM gateway_credentials WHERE method_id = ? AND field_key = 'webhook_secret'", [cardsId]);
  assert.equal(Number(raw.field_enc), 1, 'webhook secret encrypted at rest');
  assert.ok(!String(raw.field_value).includes(CARDS_WHSEC), 'webhook secret plaintext must not appear at rest');
  await toggleMethod(cardsId);
  /* METHOD-MODE-01 (manual-payments round): a signed webhook only
     auto-credits a method the operator set to Auto Pay. This E2E is
     about the AUTO path, so flip cards to Auto first (webhook_secret
     is saved above, so the save must be accepted). */
  {
    const g = await adminJar.text(`${ADMIN_PATH}/methods/${cardsId}/credentials`);
    const post = await adminJar.text(`${ADMIN_PATH}/methods/${cardsId}/mode`, { method: 'POST', body: { _csrf: csrfOf(g.body), processing_mode: 'auto' } });
    assert.equal(post.status, 302, 'mode save redirects');
    const mrow = await dbB.get('SELECT processing_mode FROM payment_methods WHERE id = ?', [cardsId]);
    assert.equal(mrow.processing_mode, 'auto', 'cards method is Auto Pay for the webhook assertions below');
  }

  // player creates a $25 cards deposit (manual request; provider ref recorded as a PSP would)
  let g = await playerJar.text('/deposit/new?m=' + cardsId);
  let post = await playerJar.text('/deposit/new', { method: 'POST', body: { _csrf: csrfOf(g.body), method_id: String(cardsId), amount: '25.00' } });
  assert.equal(post.status, 302, 'deposit submit: ' + post.status);
  const dep = await dbB.get('SELECT * FROM deposits WHERE user_id = ? AND method_id = ? ORDER BY id DESC LIMIT 1', [playerId, cardsId]);
  assert.ok(dep && dep.status === 'pending');
  await dbB.run('UPDATE deposits SET provider_txn_id = ? WHERE id = ?', ['pi_v20_test_1', dep.id]);

  const payload = JSON.stringify({ id: 'evt_v20_1', type: 'payment_intent.succeeded', txn_id: 'pi_v20_test_1', amount: 2500, currency: 'USD' });
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', CARDS_WHSEC).update(ts + '.' + payload).digest('hex');
  // bad signature first: rejected, deposit untouched, balance untouched
  let res = await fetch(BASE + '/webhooks/cards', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${ts},v1=${'0'.repeat(64)}` }, body: payload.replace('evt_v20_1', 'evt_v20_bad') });
  assert.equal(res.status, 401, 'bad signature must be rejected');
  let after = await dbB.get('SELECT status FROM deposits WHERE id = ?', [dep.id]);
  assert.equal(after.status, 'pending', 'bad-signature webhook must not approve');
  // good signature: approved and credited exactly $25.00
  res = await fetch(BASE + '/webhooks/cards', { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': `t=${ts},v1=${sig}` }, body: payload });
  assert.equal(res.status, 200, 'good signature accepted: ' + res.status);
  const j = await res.json(); assert.match(j.note || '', /approved/);
  after = await dbB.get('SELECT status FROM deposits WHERE id = ?', [dep.id]);
  assert.equal(after.status, 'approved');
  const w = await dbB.get("SELECT balance FROM wallets WHERE user_id = ? AND currency = 'USD'", [playerId]);
  assert.equal(Number(w.balance), 2500, 'wallet credited exactly the deposit net');
});

test('E2E-3 PayPal manual: admin form -> player page pay-to -> deposit reaches the admin queue with txid intact', { timeout: 60000 }, async () => {
  const formHtml = await saveCredentialsViaAdminForm(paypalId, {
    account_email: 'payments@v20.test', account_name: 'V20 Business', mode: 'sandbox',
    client_id: 'AV20clientid_throwaway_value', client_secret: 'EV20clientsecret_throwaway',
  });
  assert.match(formHtml, /PayPal account email/, 'paypal form carries its own real fields, not a generic form');
  const raw = await dbB.get("SELECT * FROM gateway_credentials WHERE method_id = ? AND field_key = 'client_secret'", [paypalId]);
  assert.equal(Number(raw.field_enc), 1); assert.ok(!String(raw.field_value).includes('EV20clientsecret'), 'client secret must not be plaintext at rest');
  await toggleMethod(paypalId);

  const page = await playerJar.text('/deposit/new?m=' + paypalId);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('payments@v20.test'), 'player page shows the PayPal pay-to email exactly as saved');
  assert.ok(page.body.includes('V20 Business'), 'player page shows the account name');
  assert.ok(page.body.includes('PayPal transaction ID'), 'player is asked for the PayPal transaction ID');

  const post = await playerJar.text('/deposit/new', { method: 'POST', body: {
    _csrf: csrfOf(page.body), method_id: String(paypalId), amount: '10.00',
    custom_paypal_txid: 'PAYID-V20-TEST-123', custom_sender_email: 'player@v20.test',
  } });
  assert.equal(post.status, 302, 'paypal deposit submit: ' + post.status);
  const dep = await dbB.get('SELECT * FROM deposits WHERE user_id = ? AND method_id = ? ORDER BY id DESC LIMIT 1', [playerId, paypalId]);
  assert.ok(dep && dep.status === 'pending', 'deposit sits in the queue pending review');
  assert.equal(money.decodeUserData(dep.user_data).paypal_txid, 'PAYID-V20-TEST-123', 'transaction ID intact in the queued deposit');
  const queue = await adminJar.text(ADMIN_PATH + '/deposits');
  assert.equal(queue.status, 200);
  assert.ok(queue.body.includes(dep.public_id), 'admin deposit queue lists the PayPal deposit');
});
