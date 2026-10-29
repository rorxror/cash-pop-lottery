'use strict';
/* USER-DETAIL-01: the admin user-detail page opens with a summary band
   (identity, status, wallet chips) BEFORE any form; sections follow in
   operator order (facts -> money snapshot -> controls -> KYC/fraud ->
   history -> edit form LAST); every pre-existing action still posts to
   its original route. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 4145, BASE = `http://127.0.0.1:${PORT}`, ROOT = path.join(__dirname, '..');
const AP = '/ops-7f3a9c-console';
const DBP = `/tmp/cp-udetail-${process.pid}.sqlite`;
let server, db, uid;

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
    TICKET_HMAC_SECRET: 'udetail-test-' + 'x'.repeat(48),
    CREDENTIAL_ENCRYPTION_KEY: 'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5',
    ADMIN_SEED_EMAIL: 'udetail-admin@example.com', ADMIN_SEED_PASSWORD: 'UdetailAdminPass-2026', ADMIN_SEED_NAME: 'UD Admin' };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[udetail server] ' + d));
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { try { const r = await fetch(BASE + '/healthz'); ok = r.status === 200; } catch {} if (!ok) await new Promise(r => setTimeout(r, 500)); }
  assert.ok(ok, 'server boots');
  process.env.SQLITE_PATH = DBP; process.env.DB_DRIVER = 'sqlite';
  db = require('../lib/db').openDB().db;
  const { hashPassword } = require('../lib/util');
  const ag = await db.run("INSERT INTO users (name, email, password_hash, role, status, email_verified, created_at) VALUES ('Detail Agent', 'dagent@example.com', ?, 'agent', 'active', 1, ?)", [await hashPassword('DetailAgent#123'), Date.now() - 86400000]);
  const ins = await db.run("INSERT INTO users (name, email, password_hash, role, status, email_verified, agent_id, created_at) VALUES ('Detail Player', 'detail@example.com', ?, 'player', 'active', 1, ?, ?)", [await hashPassword('DetailPass#123'), ag.id, Date.now() - 86400000]);
  uid = ins.id;
  await db.run("INSERT INTO wallets (user_id, currency, balance, created_at, updated_at) VALUES (?, 'USD', 12345, ?, ?)", [uid, Date.now(), Date.now()]).catch(async () => {
    await db.run("INSERT INTO wallets (user_id, currency, balance) VALUES (?, 'USD', 12345)", [uid]);
  });
  await db.run("INSERT INTO deposits (public_id, user_id, method_id, currency, amount, charge, net, status, user_data, idempotency_key, created_at) VALUES ('DPDETAIL000001', ?, 1, 'USD', 2500, 0, 2500, 'approved', '{}', ?, ?)", [uid, 'ud-d-' + Date.now(), Date.now()]);
  await db.run("INSERT INTO withdrawals (public_id, user_id, method_id, currency, amount, charge, net, status, user_data, idempotency_key, created_at) VALUES ('WDDETAIL000001', ?, 1, 'USD', 1000, 0, 1000, 'pending', '{}', ?, ?)", [uid, 'ud-w-' + Date.now(), Date.now()]);
  const g = await admin.req(AP);
  await admin.req(AP + '/login', { method: 'POST', body: { _csrf: admin.csrf(g.html), email: 'udetail-admin@example.com', password: 'UdetailAdminPass-2026' } });
});
after(() => { if (server) server.kill(); });

test('summary band first, biodata form last, sections in operator order', async () => {
  const page = await admin.req(AP + '/users/' + uid);
  assert.equal(page.status, 200);
  const h = page.html;
  const iSummary = h.indexOf('user-summary');
  const iFacts = h.indexOf('Account facts');
  const iMoney = h.indexOf('Money snapshot');
  const iControls = h.indexOf('>Controls<');
  const iKyc = h.indexOf('KYC documents');
  const iEdit = h.indexOf('Edit details');
  assert.ok(iSummary > -1 && iFacts > iSummary && iMoney > iFacts && iControls > iMoney && iKyc > iControls && iEdit > iKyc,
    `order: summary ${iSummary} < facts ${iFacts} < money ${iMoney} < controls ${iControls} < kyc ${iKyc} < edit ${iEdit}`);
  assert.ok(h.includes('Detail Player') && h.includes('detail@example.com'), 'identity in the band');
  assert.ok(h.includes('$123.45'), 'wallet total chip in the band');
  assert.ok(iSummary < h.indexOf('name="address"'), 'band appears before the biodata form fields');
});

test('every pre-existing action still present, posting to its original route', async () => {
  const page = await admin.req(AP + '/users/' + uid);
  const h = page.html;
  for (const action of ['/block', '/reset-password', '/set-password', '/revoke-sessions', '/login-as', '/verify-contact', '/adjust', '/matrix', '/kyc-verify'])
    assert.ok(h.includes(`action="${AP}/users/${uid}${action}"`), 'form present: ' + action);
  for (const field of ['name="name"', 'name="email"', 'name="phone"', 'name="address"', 'name="city"', 'name="state"', 'name="zip"', 'name="country"', 'name="kyc_override"', 'name="auto_withdrawal_limit"', 'name="agent_id"', 'name="notes"'])
    assert.ok(h.includes(field), 'biodata field kept: ' + field);
  assert.ok(h.includes('Access') && h.includes('Password') && h.includes('Money controls'), 'controls grouped under sub-headings');
});

test('money snapshot renders the real seeded rows with formatted amounts', async () => {
  const page = await admin.req(AP + '/users/' + uid);
  const h = page.html;
  assert.ok(h.includes('DPDETAIL000001') && h.includes('$25.00'), 'recent deposit with formatted amount');
  assert.ok(h.includes('WDDETAIL000001') && h.includes('$10.00'), 'recent withdrawal with formatted amount');
});
