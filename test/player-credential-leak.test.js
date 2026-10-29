'use strict';
/* HOTFIX 2026-10-29 — player pages must NEVER display credential values.
   Owner-reported on live v21: the PayPal deposit page showed
   "Payment gateway details: Client ID: <value>" because the v20-era
   U-21 design whitelisted paypal client_id in PUBLIC_CONFIG_FIELDS
   ("public by design") and deposit_new.ejs rendered getPublicConfig.
   Nothing client-side consumed that value (no JS SDK checkout), and
   the owner's rule is that credentials stay admin-side. The old
   manual-payments A2 test missed it because it only asserted
   SECRET-flagged values; client_id is type text, not secret.
   This test plants a DISTINCTIVE value in EVERY credential field of
   EVERY rail and asserts none of them reaches the player-facing
   projections (getReceivingDetails / getPublicConfig) unless the
   field is a designated pay-to (RECEIVING_FIELDS) field — and, over
   HTTP, that the rendered deposit page shows the pay-to email, never
   any planted credential value, and no "Payment gateway details"
   block at all. Run: node --test test/player-credential-leak.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TMP_A = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-leak-a-'));
process.env.SQLITE_PATH = path.join(TMP_A, 'a.sqlite');
process.env.DB_DRIVER = 'sqlite';
process.env.CREDENTIAL_ENCRYPTION_KEY = ENC_KEY;
delete process.env.DATABASE_URL;

const { openDB } = require('../lib/db');
const { migrate } = require('../lib/migrations');
const rails = require('../lib/rails');
const creds = require('../lib/credentials');
const { db } = openDB();

test.before(async () => { await migrate(db, 'sqlite'); });
test.after(async () => { try { await db.close(); } catch {} fs.rmSync(TMP_A, { recursive: true, force: true }); });

async function methodRow(railKey) {
  return db.get('SELECT * FROM payment_methods WHERE slug = ?', ['rail-' + railKey]);
}

test('A1 lib level: receiving projection = pay-to keys only; public config never carries credential-pair values', async () => {
  assert.equal(rails.PUBLIC_CONFIG_FIELDS.paypal, undefined, 'paypal must have NO public-config fields (hotfix)');
  for (const rail of rails.RAILS) {
    const m = await methodRow(rail.key);
    assert.ok(m, 'seeded method for ' + rail.key);
    const planted = {};
    for (const f of rail.credentialFields) {
      // email-shaped where the field is an email, so format validation accepts the save
      const v = /email/i.test(f.key) ? `leakval_${rail.key}_${f.key}@leak.test` : 'LEAKVAL_' + rail.key + '_' + f.key;
      planted[f.key] = v;
      await creds.saveCredentialField(db, m.id, f.key, v);
    }
    const receivingKeys = new Set((rails.RECEIVING_FIELDS[rail.key] || []));
    const publicKeys = new Set((rails.PUBLIC_CONFIG_FIELDS[rail.key] || []));
    const recv = await rails.getReceivingDetails(db, m);
    const pub = await rails.getPublicConfig(db, m);
    const recvJson = JSON.stringify(recv);
    const pubJson = JSON.stringify(pub);
    for (const f of rail.credentialFields) {
      if (!receivingKeys.has(f.key)) {
        assert.ok(!recvJson.includes(planted[f.key]), `${rail.key}.${f.key} leaked into receiving details`);
      }
      if (!publicKeys.has(f.key)) {
        assert.ok(!pubJson.includes(planted[f.key]), `${rail.key}.${f.key} leaked into public config`);
      }
      if (f.secret || f.type === 'password') {
        assert.ok(!pubJson.includes(planted[f.key]), `${rail.key}.${f.key} (secret) leaked into public config`);
        assert.ok(!recvJson.includes(planted[f.key]), `${rail.key}.${f.key} (secret) leaked into receiving details`);
      }
    }
    // receiving projection may only ever contain designated pay-to keys
    for (const r of recv) assert.ok(receivingKeys.has(r.key), `${rail.key}: unexpected receiving key ${r.key}`);
  }
});

test('A2 paypal specifically: Client ID is not public config anymore, pay-to email still shows', async () => {
  const m = await methodRow('paypal');
  const pub = await rails.getPublicConfig(db, m);
  assert.ok(!JSON.stringify(pub).includes('LEAKVAL_paypal_client_id'), 'client_id must not be player-visible');
  const recv = await rails.getReceivingDetails(db, m);
  assert.ok(JSON.stringify(recv).includes('leakval_paypal_account_email@leak.test'), 'pay-to email still shows (intended)');
});

/* ---------------- Part B: rendered deposit page over HTTP ---------------- */
const PORT = 4171;
const BASE = 'http://127.0.0.1:' + PORT;
const ADMIN_PATH = '/ops-7f3a9c-console';
let server = null, dbB = null;

class Jar {
  constructor(ua) { this.cookies = new Map(); this.ua = ua || 'leak-test'; }
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

test('B1 HTTP: deposit page shows pay-to email, never any credential value, no gateway block', { timeout: 90000 }, async () => {
  const TMPB = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-leak-b-'));
  const env = { ...process.env,
    PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite',
    SQLITE_PATH: path.join(TMPB, 'b.sqlite'),
    TICKET_HMAC_SECRET: 'leak-test-hmac',
    CREDENTIAL_ENCRYPTION_KEY: ENC_KEY,
    ADMIN_SEED_EMAIL: 'admin@leak.test', ADMIN_SEED_PASSWORD: 'LeakAdmin#pass', ADMIN_SEED_NAME: 'Leak Admin',
  };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[leak server] ' + d));
  try {
    assert.ok(await waitHealthy(), 'server must boot');
    process.env.SQLITE_PATH = path.join(TMPB, 'b.sqlite');
    dbB = require('../lib/db').openDB().db;
    const pp = await dbB.get("SELECT id FROM payment_methods WHERE slug = 'rail-paypal'");
    const cards = await dbB.get("SELECT id FROM payment_methods WHERE slug = 'rail-cards'");

    const admin = new Jar('leak-admin');
    const g0 = await admin.text('/login');
    const login = await admin.text('/login', { method: 'POST', body: { _csrf: csrfOf(g0.body), email: 'admin@leak.test', password: 'LeakAdmin#pass' } });
    assert.equal(login.status, 302); assert.ok(login.loc.includes(ADMIN_PATH));

    async function configure(methodId, fields) {
      const g = await admin.text(`${ADMIN_PATH}/methods/${methodId}/credentials`);
      assert.equal(g.status, 200, 'credentials page loads');
      const post = await admin.text(`${ADMIN_PATH}/methods/${methodId}/credentials`, { method: 'POST', body: { _csrf: csrfOf(g.body), ...fields } });
      assert.equal(post.status, 302, 'credentials save redirects');
      const gm = await admin.text(ADMIN_PATH + '/methods');
      const tog = await admin.text(`${ADMIN_PATH}/methods/${methodId}/toggle`, { method: 'POST', body: { _csrf: csrfOf(gm.body) } });
      assert.equal(tog.status, 302, 'method enable redirects');
    }
    await configure(pp.id, { account_email: 'payto@leak.test', account_name: 'Leak Biz', mode: 'live', client_id: 'LEAKVAL_http_client_id', client_secret: 'LEAKVAL_http_secret', webhook_id: 'LEAKVAL_http_webhook' });
    await configure(cards.id, { provider: 'Stripe', mode: 'live', publishable_key: 'LEAKVAL_http_publishable', secret_key: 'LEAKVAL_http_sk', webhook_secret: 'LEAKVAL_http_whsec' });

    const player = new Jar('leak-player');
    const gr = await player.text('/register');
    const reg = await player.text('/register', { method: 'POST', body: { _csrf: csrfOf(gr.body), name: 'Leak Player', email: 'p@leak.test', password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
    assert.equal(reg.status, 302, 'player registers');
    const u = await dbB.get('SELECT id FROM users WHERE email = ?', ['p@leak.test']);
    await dbB.run('UPDATE users SET email_verified = 1 WHERE id = ?', [u.id]);

    const page = await player.text('/deposit/new?m=' + pp.id);
    assert.equal(page.status, 200, 'paypal deposit page loads');
    assert.ok(page.body.includes('payto@leak.test'), 'pay-to email IS shown (intended)');
    assert.ok(!page.body.includes('LEAKVAL'), 'NO credential value appears on the paypal deposit page');
    assert.ok(!page.body.includes('Payment gateway details'), 'gateway details block is gone');

    const page2 = await player.text('/deposit/new?m=' + cards.id);
    assert.equal(page2.status, 200, 'cards deposit page loads');
    assert.ok(!page2.body.includes('LEAKVAL'), 'NO credential value appears on the cards deposit page');
    assert.ok(!page2.body.includes('Payment gateway details'), 'gateway details block is gone (cards)');
  } finally {
    if (server) { try { server.kill('SIGKILL'); } catch {} }
    try { if (dbB) await dbB.close(); } catch {}
    fs.rmSync(TMPB, { recursive: true, force: true });
  }
});
