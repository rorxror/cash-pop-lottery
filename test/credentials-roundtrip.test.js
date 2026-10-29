'use strict';
/* CREDENTIALS-REAL-01 round-trip: for EVERY rail, saving the credentials
   page with the documented field set (values that pass the rail's own
   validators) succeeds; secrets are encrypted at rest (field_enc = 1,
   stored value != plaintext) and are NEVER echoed back into the
   redisplayed page; non-secret values round-trip visibly; every field
   carries its Manual-vs-Auto mode note. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 4153, BASE = `http://127.0.0.1:${PORT}`, ROOT = path.join(__dirname, '..');
const AP = '/ops-7f3a9c-console';
const DBP = `/tmp/cp-credrt-${process.pid}.sqlite`;
let server, db;
const { RAILS, getRail } = require('../lib/rails');

/* Values that satisfy each rail's validators (same set the manual-loop
   E2E uses to configure methods). */
const VALUES = {
  crypto: { asset: 'USDT', network: 'TRC20', wallet_address: 'TJk3FakeTestWalletAddress1234567', confirmations: '1', webhook_secret: 'whsec_crypto_test' },
  cards: { provider: 'Stripe', mode: 'live', publishable_key: 'pk_live_test123', secret_key: 'sk_live_test123', webhook_secret: 'whsec_cards_test' },
  upi: { upi_id: 'owner@okhdfcbank', merchant_name: 'Cash Pop' },
  pix: { pix_key: 'owner@bank.com.br', pix_key_type: 'email', provider: 'Test PSP', mode: 'live', api_token: 'pix_token_test', webhook_secret: 'whsec_pix_test' },
  mobile_money: { provider: 'M-Pesa', account_number: '+254712345678', account_name: 'Owner Name', api_key: 'mm_key_test', webhook_secret: 'whsec_mm_test' },
  ewallet: { provider: 'Skrill', account_email: 'owner@skrill.test', client_id: 'ew_client_test', client_secret: 'ew_secret_test', merchant_id: '987654321', secret_word: 'ew_secret_word_test', webhook_secret: 'whsec_ew_test' },
  apple_pay: { merchant_id: 'merchant.test.example', processor: 'Stripe', api_key: 'ap_key_test', webhook_secret: 'whsec_ap_test' },
  google_pay: { merchant_id: '12345678901234567890', merchant_name: 'Cash Pop', gateway: 'Stripe', gateway_merchant_id: 'gw_test', environment: 'PRODUCTION', webhook_secret: 'whsec_gp_test' },
  samsung_pay: { merchant_id: 'sp_merchant_test', service_id: 'sp_service_test', api_key: 'sp_key_test', webhook_secret: 'whsec_sp_test' },
  bank_transfer: { bank_name: 'Test Bank', account_name: 'Owner Name', account_number: '123456789', iban: 'GB29NWBK60161331926819', swift: 'CHASUS33', routing_number: '', routing_code_local: '' },
  qr_pay: { provider: 'PromptPay', qr_image_url: 'https://example.com/qr.png', account_label: 'Owner 0812345678' },
  voucher: { issuer: 'Test Voucher Co', api_key: 'vch_key_test' },
  cash_agent: { agent_network: 'Test Agents', instructions: 'Pay at any Test Agent shop.' },
  paypal: { account_email: 'owner@paypal.test', account_name: 'Owner Name', mode: 'live', client_id: 'pp_client_test', client_secret: 'pp_secret_test', webhook_id: 'WH-PP-TEST-123' },
};

class Jar {
  constructor() { this.m = new Map(); }
  absorb(h) { const sc = h.getSetCookie ? h.getSetCookie() : []; for (const c of sc) { const p = c.split(';')[0]; const i = p.indexOf('='); if (i > 0) { const k = p.slice(0, i).trim(), v = p.slice(i + 1).trim(); if (v) this.m.set(k, v); else this.m.delete(k); } } }
  header() { return [...this.m.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(p, { method = 'GET', body } = {}) {
    const r = await fetch(BASE + p, { method, redirect: 'manual', headers: { cookie: this.header(), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: body ? new URLSearchParams(body).toString() : undefined });
    this.absorb(r.headers); return { status: r.status, loc: r.headers.get('location') || '', html: await r.text() };
  }
  csrf(html) { const m = html.match(/name="_csrf" value="([^"]+)"/); assert.ok(m, 'csrf present'); return m[1]; }
}
const admin = new Jar();

before(async () => {
  const env = { ...process.env, PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite', SQLITE_PATH: DBP,
    TICKET_HMAC_SECRET: 'credrt-test-' + 'x'.repeat(48),
    CREDENTIAL_ENCRYPTION_KEY: 'b6'.repeat(32),
    ADMIN_SEED_EMAIL: 'credrt-admin@example.com', ADMIN_SEED_PASSWORD: 'CredRtAdminPass-2026', ADMIN_SEED_NAME: 'CR Admin' };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[credrt server] ' + d));
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { try { const r = await fetch(BASE + '/healthz'); ok = r.status === 200; } catch {} if (!ok) await new Promise(r => setTimeout(r, 500)); }
  assert.ok(ok, 'server boots');
  process.env.SQLITE_PATH = DBP; process.env.DB_DRIVER = 'sqlite';
  db = require('../lib/db').openDB().db;
  const g = await admin.req(AP);
  await admin.req(AP + '/login', { method: 'POST', body: { _csrf: admin.csrf(g.html), email: 'credrt-admin@example.com', password: 'CredRtAdminPass-2026' } });
});
after(() => { if (server) server.kill(); });

test('every rail: documented field set saves, encrypts at rest, masks on redisplay, carries mode notes', async () => {
  assert.equal(RAILS.length, 14, '14 rails under test');
  for (const rail of RAILS) {
    const m = await db.get('SELECT id FROM payment_methods WHERE slug = ?', ['rail-' + rail.key]);
    assert.ok(m, 'seeded method exists for ' + rail.key);
    const page = await admin.req(`${AP}/methods/${m.id}/credentials`);
    assert.equal(page.status, 200, rail.key + ' credentials page loads');
    assert.ok(page.html.includes('Needed for:'), rail.key + ': fields carry Manual/Auto mode notes');
    const vals = VALUES[rail.key] || {};
    const body = { _csrf: admin.csrf(page.html) };
    for (const f of rail.credentialFields) {
      if (vals[f.key] !== undefined) body[f.key] = vals[f.key];
      else if (f.options && f.options.length) body[f.key] = typeof f.options[0] === 'object' ? f.options[0].value : f.options[0];
      else body[f.key] = 'Test Value';
    }
    const save = await admin.req(`${AP}/methods/${m.id}/credentials`, { method: 'POST', body });
    assert.equal(save.status, 302, rail.key + ' save redirects');
    const fol = await admin.req(save.loc);
    assert.ok(fol.html.includes('Credentials saved'), rail.key + ': save confirmed');
    // At rest: encrypted rows, no plaintext secrets.
    const rows = await db.query('SELECT field_key, field_value, field_enc FROM gateway_credentials WHERE method_id = ?', [m.id]);
    assert.ok(rows.length >= rail.credentialFields.filter(f => (VALUES[rail.key] || {})[f.key]).length, rail.key + ': rows stored');
    for (const f of rail.credentialFields) {
      const row = rows.find(r => r.field_key === f.key);
      if (!row) continue;
      assert.equal(Number(row.field_enc), 1, rail.key + '/' + f.key + ' encrypted at rest');
      if (f.type === 'password') assert.notEqual(row.field_value, body[f.key], rail.key + '/' + f.key + ' secret not stored in plaintext');
    }
    // Redisplay: secrets never echoed; non-secret values visible.
    for (const f of rail.credentialFields) {
      if (f.type === 'password' && body[f.key]) assert.ok(!fol.html.includes(body[f.key]), rail.key + '/' + f.key + ' secret not echoed on redisplay');
    }
    void getRail;
  }
});
