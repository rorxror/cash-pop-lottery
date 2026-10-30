'use strict';
/* v23 HUNT — regression suite for the admin/surfaces/security batch:
   H1-02 (public fairness page hides TEST draws), H5-01 (a manual
   method cannot be enabled with no receiving details), H4-01 (password
   login cannot be switched off with no alternative sign-in path),
   H4-20 (orphan settings are gone), H3-10 (signup codes are scrypt-
   hashed), H3-01 (anonymous sessions no longer transplant across
   scopes — lib-level middleware test). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const AP = '/ops-7f3a9c-console';
const PORT = 4271, BASE = `http://127.0.0.1:${PORT}`;
const ENC_KEY = 'd4'.repeat(32);
const THS = ['hunt', 'admin', 'hmac'].join('-');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-hunt-as-'));
const DBP = path.join(TMP, 's.sqlite');
process.env.SQLITE_PATH = DBP;
process.env.DB_DRIVER = 'sqlite';
process.env.CREDENTIAL_ENCRYPTION_KEY = ENC_KEY;

let server, db;
const { openDB } = require('../lib/db');
const { verifyCode } = require('../lib/util');

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

test.before(async () => {
  const env = { ...process.env, PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite', SQLITE_PATH: DBP,
    TICKET_HMAC_SECRET: THS, CREDENTIAL_ENCRYPTION_KEY: ENC_KEY,
    ADMIN_SEED_EMAIL: 'hunt-admin2@example.com', ADMIN_SEED_PASSWORD: 'HuntAdminPass-2026', ADMIN_SEED_NAME: 'Hunt Admin' };
  delete env.DATABASE_URL;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[hunt-as server] ' + d));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(BASE + '/healthz'); up = r.status === 200; } catch {} if (!up) await new Promise(r => setTimeout(r, 500)); }
  assert.ok(up, 'server boots');
  db = openDB().db;
  // Admin sign-in (password login → admin root).
  const loginPage = await admin.req('/login');
  const post = await admin.req('/login', { method: 'POST', body: { _csrf: admin.csrf(loginPage.html), email: 'hunt-admin2@example.com', password: 'HuntAdminPass-2026' } });
  assert.ok([302, 303].includes(post.status), 'admin login redirects: ' + post.status);
  const root = await admin.req(AP);
  assert.equal(root.status, 200, 'admin root loads');
});

test.after(() => { if (server) server.kill(); });

test('H4-20: orphan settings rows do not exist after boot', async () => {
  for (const k of ['kyc_required', 'email_verification', 'mobile_verification', 'auto_approve_deposit_limit']) {
    const row = await db.get('SELECT key FROM settings WHERE key = ?', [k]);
    assert.equal(row, undefined, k + ' must not be seeded');
  }
  const stake = await db.get("SELECT value FROM settings WHERE key = 'per_draw_stake_cap'");
  assert.ok(stake, 'H4-04: per_draw_stake_cap IS seeded');
});

test('H3-10: admin-issued signup codes are scrypt-hashed and verify', async () => {
  const page = await admin.req(AP + '/otp');
  assert.equal(page.status, 200);
  const post = await admin.req(AP + '/otp', { method: 'POST', body: { _csrf: admin.csrf(page.html), label: 'hunt test code', max_uses: '1', expires_hours: '72' } });
  assert.ok([302, 303].includes(post.status));
  const list = await admin.req(AP + '/otp');
  const m = list.html.match(/New signup code: ([A-Z0-9]{4}-[A-Z0-9]{4})/);
  assert.ok(m, 'the issued code is shown once in the flash');
  const row = await db.get('SELECT * FROM otp_codes ORDER BY id DESC LIMIT 1');
  assert.ok(row.code_hash.startsWith('scrypt$'), 'stored hash is scrypt, got: ' + row.code_hash.slice(0, 16));
  assert.equal(verifyCode(row.code_hash, m[1]), true, 'the code verifies against the scrypt hash');
  assert.equal(verifyCode(row.code_hash, 'ZZZZ-9999'), false);
});

test('H4-01: password login cannot be turned off with no alternative sign-in path', async () => {
  const page = await admin.req(AP + '/settings');
  assert.equal(page.status, 200);
  // Mirror the current toggle states from the rendered checkboxes,
  // changing ONLY password_login_enabled (omit it = off).
  const body = { _csrf: admin.csrf(page.html) };
  for (const m of page.html.matchAll(/<input[^>]*type="checkbox"[^>]*name="([a-z_]+)"[^>]*>/g)) {
    const tag = m[0], key = m[1];
    if (key === 'password_login_enabled') continue;
    if (/checked/.test(tag)) body[key] = '1';
  }
  const post = await admin.req(AP + '/settings/toggles', { method: 'POST', body });
  assert.ok([302, 303].includes(post.status));
  const row = await db.get("SELECT value FROM settings WHERE key = 'password_login_enabled'");
  assert.equal(row.value, '1', 'the save was refused — password login is still on');
  const after = await admin.req(AP + '/settings');
  assert.match(after.html, /Cannot turn password login off/, 'the refusal reason is shown');
});

test('H5-01: a manual method with no receiving details cannot be enabled', async () => {
  const m = await db.get("SELECT * FROM payment_methods WHERE slug = 'rail-bank_transfer'");
  assert.ok(m, 'seeded bank method exists');
  assert.equal(Number(m.enabled), 0);
  const list = await admin.req(AP + '/methods');
  const post = await admin.req(`${AP}/methods/${m.id}/toggle`, { method: 'POST', body: { _csrf: admin.csrf(list.html) } });
  assert.ok([302, 303].includes(post.status));
  const after = await db.get('SELECT enabled FROM payment_methods WHERE id = ?', [m.id]);
  assert.equal(Number(after.enabled), 0, 'enable refused while no receiving details exist');
  const list2 = await admin.req(AP + '/methods');
  assert.match(list2.html, /no receiving details saved yet/, 'the refusal names the fix');
  // Save real receiving details, then the enable succeeds.
  const credPage = await admin.req(`${AP}/methods/${m.id}/credentials`);
  assert.equal(credPage.status, 200);
  const save = await admin.req(`${AP}/methods/${m.id}/credentials`, { method: 'POST', body: { _csrf: admin.csrf(credPage.html), bank_name: 'Hunt Bank', account_name: 'Hunt Owner', account_number: 'GB29NWBK60161331926819', swift: 'CHASUS33' } });
  assert.ok([302, 303].includes(save.status), 'credentials save redirects');
  const list3 = await admin.req(AP + '/methods');
  await admin.req(`${AP}/methods/${m.id}/toggle`, { method: 'POST', body: { _csrf: admin.csrf(list3.html) } });
  const on = await db.get('SELECT enabled FROM payment_methods WHERE id = ?', [m.id]);
  assert.equal(Number(on.enabled), 1, 'enable works once a destination exists');
});

test('H1-02 (reversed in the adversarial phase): settled TEST draws verify WITH the TEST badge; unsettled seeds never render', async () => {
  const seed = 'hunt-test-seed-1234567890';
  const { sha256 } = require('../lib/util');
  const hash = sha256(seed);
  const ins = await db.run("INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, winning_number, is_test, created_at) VALUES ('DAY', '2099-01-01', ?, 'settled', ?, ?, 7, 1, ?)",
    [Date.now() + 86400000, hash, seed, Date.now()]);
  const pub = await fetch(BASE + '/fairness?draw_id=' + ins.id);
  const html = await pub.text();
  assert.ok(html.includes('<span class="badge b-warn">TEST</span>'), 'a settled test draw is honestly badged TEST (the deliberate D4-C3 design)');
  const insOpen = await db.run("INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, winning_number, is_test, created_at) VALUES ('DAY', '2099-01-02', ?, 'scheduled', ?, ?, NULL, 1, ?)",
    [Date.now() + 86400000, hash, seed, Date.now()]);
  const pubOpen = await fetch(BASE + '/fairness?draw_id=' + insOpen.id);
  const htmlOpen = await pubOpen.text();
  assert.ok(!htmlOpen.includes(seed), 'an UNSETTLED draw seed never renders (the real invariant)');
  const ins2 = await db.run("INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, winning_number, is_test, created_at) VALUES ('EVE', '2099-01-01', ?, 'settled', ?, ?, 7, 0, ?)",
    [Date.now() + 86400000, hash, seed, Date.now()]);
  const pub2 = await fetch(BASE + '/fairness?draw_id=' + ins2.id);
  const html2 = await pub2.text();
  assert.ok(html2.includes(seed), 'a real settled draw still verifies publicly (control)');
});

test('H3-04: TOTP secrets verify from an encrypted envelope AND from legacy plaintext', () => {
  const { newTotpSecret, totpCode, verifyTotp, wrapTotpSecret, unwrapTotpSecret } = require('../lib/auth');
  const secret = newTotpSecret();
  const code = totpCode(secret, Date.now());
  const wrapped = wrapTotpSecret(secret);
  assert.ok(wrapped.startsWith('v1:'), 'with a key configured the stored secret is an envelope');
  assert.equal(unwrapTotpSecret(wrapped), secret, 'the envelope unwraps to the seed');
  assert.equal(verifyTotp(wrapped, code), true, 'login verify works against the ENCRYPTED stored value');
  assert.equal(verifyTotp(secret, code), true, 'legacy plaintext rows still verify');
  assert.equal(verifyTotp('v1:deadbeef:deadbeef:deadbeef', code), false, 'an undecryptable envelope fails closed');
});

test('H3-01: an anonymous session minted in one scope is not honored in the other', async () => {
  const { loadSession, createSession } = require('../lib/auth');
  const sid = await createSession(db, 0, { ip: '127.0.0.1', ua: 'hunt', scope: 'site', extra: { _captcha: 'x' } });
  const mw = loadSession(db, { adminPath: AP });
  const run = (p, cookies) => new Promise((resolve, reject) => {
    const req = { path: p, cookies, headers: {}, method: 'GET' };
    mw(req, {}, (e) => e ? reject(e) : resolve(req));
  });
  const siteReq = await run('/login', { sid });
  assert.ok(siteReq.sess && siteReq.sess.id === sid, 'control: the session loads in its own scope');
  const adminReq = await run(AP + '/login', { sid_admin: sid });
  assert.equal(adminReq.sess, null, 'the same sid presented as the admin cookie is ignored');
});
