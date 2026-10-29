'use strict';
/* ADMIN-LOGIN-01: the EXACT admin root serves a dedicated admin-branded
   login page (owner order, ViserLab pattern); every other admin path
   keeps stealth 404 + probe logging. POST {root}/login authenticates
   staff only, into the ADMIN scope (sid_admin), never touching the
   player-scope cookie; TOTP step renders on the same page. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 4141, BASE = `http://127.0.0.1:${PORT}`, ROOT = path.join(__dirname, '..');
const AP = '/ops-7f3a9c-console';
const DBP = `/tmp/cp-alogin-${process.pid}.sqlite`;
const ADMIN_EMAIL = 'alogin-admin@example.com', ADMIN_PASSWORD = 'AloginAdminPass-2026';
let server, db;

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

before(async () => {
  const env = { ...process.env, PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite', SQLITE_PATH: DBP,
    TICKET_HMAC_SECRET: 'alogin-test-' + 'x'.repeat(48),
    CREDENTIAL_ENCRYPTION_KEY: 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2',
    ADMIN_SEED_EMAIL: ADMIN_EMAIL, ADMIN_SEED_PASSWORD: ADMIN_PASSWORD, ADMIN_SEED_NAME: 'ALogin Admin' };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[alogin server] ' + d));
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { try { const r = await fetch(BASE + '/healthz'); ok = r.status === 200; } catch {} if (!ok) await new Promise(r => setTimeout(r, 500)); }
  assert.ok(ok, 'server boots');
  process.env.SQLITE_PATH = DBP; process.env.DB_DRIVER = 'sqlite';
  db = require('../lib/db').openDB().db;
  // a player account (for the player-creds refusal) + a TOTP admin
  const { hashPassword } = require('../lib/util');
  const { newTotpSecret } = require('../lib/auth');
  await db.run("INSERT INTO users (name, email, password_hash, role, status, created_at) VALUES ('Player One', 'player1@example.com', ?, 'player', 'active', ?)", [await hashPassword('PlayerPass#123'), Date.now()]);
  global.__totpSecret = newTotpSecret();
  await db.run("INSERT INTO users (name, email, password_hash, role, status, totp_secret, created_at) VALUES ('Totp Admin', 'totp-admin@example.com', ?, 'admin', 'active', ?, ?)", [await hashPassword('TotpAdminPass-2026'), global.__totpSecret, Date.now()]);
});
after(() => { if (server) server.kill(); });

test('GET root logged out: 200 admin login, no player chrome, no register', async () => {
  const j = new Jar();
  const g = await j.req(AP);
  assert.equal(g.status, 200);
  assert.ok(g.html.includes('Control Room'), 'admin branding');
  assert.ok(g.html.includes(`action="${AP}/login"`), 'form posts to the admin login route');
  assert.ok(!g.html.includes('main-nav') && !g.html.includes('/register'), 'no player navigation, no register link');
  assert.ok(j.m.has('sid_admin'), 'anon admin-scope session cookie set');
  assert.ok(!j.m.has('sid'), 'player-scope cookie NOT touched');
});

test('stealth preserved: subpaths 404 + probed, /admin 404', async () => {
  const j = new Jar();
  assert.equal((await j.req(AP + '/users')).status, 404);
  assert.equal((await j.req(AP + '/settings')).status, 404);
  assert.equal((await j.req('/admin')).status, 404);
  const probes = await db.query("SELECT id FROM audit_log WHERE action = 'admin.probe'");
  assert.ok(probes.length >= 2, 'subpath probes logged: ' + probes.length);
});

test('valid admin creds: 302 to dashboard, admin-scope session only', async () => {
  const j = new Jar();
  const g = await j.req(AP);
  const post = await j.req(AP + '/login', { method: 'POST', body: { _csrf: j.csrf(g.html), email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assert.equal(post.status, 302);
  assert.ok(post.loc.startsWith(AP), 'redirects into the panel: ' + post.loc);
  assert.ok(j.m.has('sid_admin'));
  const dash = await j.req(AP);
  assert.equal(dash.status, 200);
  assert.ok(!dash.html.includes('Control Room</h1>'), 'dashboard, not the login page');
  const row = await db.get("SELECT id FROM audit_log WHERE action = 'admin.login' AND detail LIKE '%\"ok\":true%' ORDER BY id DESC LIMIT 1");
  assert.ok(row, 'successful admin.login audited');
});

test('player creds + wrong password: same generic failure, audited, no session', async () => {
  const j1 = new Jar(); const g1 = await j1.req(AP);
  const p1 = await j1.req(AP + '/login', { method: 'POST', body: { _csrf: j1.csrf(g1.html), email: 'player1@example.com', password: 'PlayerPass#123' } });
  assert.equal(p1.status, 200);
  assert.ok(p1.html.includes('Invalid credentials.'), 'generic failure for player creds');
  assert.equal((await j1.req(AP + '/users')).status, 404, 'no admin session granted');
  const j2 = new Jar(); const g2 = await j2.req(AP);
  const p2 = await j2.req(AP + '/login', { method: 'POST', body: { _csrf: j2.csrf(g2.html), email: ADMIN_EMAIL, password: 'WrongPass-999' } });
  assert.ok(p2.html.includes('Invalid credentials.'), 'identical generic failure for wrong password');
  assert.ok(!p2.html.toLowerCase().includes('player') && !p1.html.includes('WrongPass'), 'no account-kind or input leakage');
  const fails = await db.query("SELECT id FROM audit_log WHERE action = 'admin.login' AND detail LIKE '%\"ok\":false%'");
  assert.ok(fails.length >= 2, 'failures audited: ' + fails.length);
});

test('TOTP admin: code step on the same page, then dashboard', async () => {
  const { totpCode } = require('../lib/auth');
  const j = new Jar();
  const g = await j.req(AP);
  const step1 = await j.req(AP + '/login', { method: 'POST', body: { _csrf: j.csrf(g.html), email: 'totp-admin@example.com', password: 'TotpAdminPass-2026' } });
  assert.equal(step1.status, 200);
  assert.ok(step1.html.includes('Two-factor authentication'), 'TOTP step renders on the admin login page');
  assert.ok(step1.html.includes('name="totp_code"'), 'code field present');
  const bad = await j.req(AP + '/login', { method: 'POST', body: { _csrf: j.csrf(step1.html), totp_code: '000000' } });
  assert.ok(bad.html.includes('Invalid authenticator code.'));
  const step2 = await j.req(AP + '/login', { method: 'POST', body: { _csrf: j.csrf(bad.html), totp_code: totpCode(global.__totpSecret) } });
  assert.equal(step2.status, 302, 'correct code signs in');
  assert.equal((await j.req(AP)).status, 200, 'dashboard reachable');
});

test('public /login fallback still works for the admin', async () => {
  const j = new Jar();
  const g = await j.req('/login');
  const post = await j.req('/login', { method: 'POST', body: { _csrf: j.csrf(g.html), email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  assert.equal(post.status, 302);
  assert.ok(post.loc.startsWith(AP), 'admin auto-redirected to the panel');
});
