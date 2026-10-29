'use strict';
/* SESSION-TAB-01 — dual session scope E2E (spawned server, port 4133).
   The owner's bug: ONE `sid` cookie served player AND admin, so a
   login in one tab overwrote the other tab's account. Proof here uses
   ONE shared cookie jar (= one browser): player login and admin login
   must coexist, neither disturbing the other; the TOTP challenge for
   the admin must ride the admin scope (sid_admin) without mutating
   the player's live session; panel logout clears ONLY the admin
   scope; stealth 404s are unchanged for anonymous and player-only
   browsers; session rows carry truthful scopes and the security page
   labels them. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-scope-'));
const PORT = 4133;
const BASE = 'http://localhost:' + PORT;
const ADMIN_PATH = '/ops-7f3a9c-console';

class Jar {
  constructor(ua) { this.cookies = new Map(); this.ua = ua || 'scope-test'; }
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

let server = null, dbS = null, adminId, playerId;
const jar = new Jar('one-browser'); // THE shared jar: "tab 1" and "tab 2" are the same browser

test.before(async () => {
  const env = { ...process.env,
    PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite',
    SQLITE_PATH: path.join(TMP, 's.sqlite'),
    TICKET_HMAC_SECRET: 'scope-test-ticket-hmac-secret-throwaway-0123456789',
    CREDENTIAL_ENCRYPTION_KEY: ENC_KEY,
    ADMIN_SEED_EMAIL: 'admin@scope.test', ADMIN_SEED_PASSWORD: 'ScopeAdmin#pass', ADMIN_SEED_NAME: 'Scope Admin',
  };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[scope server] ' + d));
  assert.ok(await waitHealthy(), 'server must boot');
  process.env.SQLITE_PATH = path.join(TMP, 's.sqlite');
  process.env.DB_DRIVER = 'sqlite';
  dbS = require('../lib/db').openDB().db;
  adminId = (await dbS.get("SELECT id FROM users WHERE email = 'admin@scope.test'")).id;
});

test.after(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch {} }
  try { if (dbS) await dbS.close(); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('shared jar: player login (tab 1) then admin login (tab 2) — both stay alive, neither overwrites the other', { timeout: 60000 }, async () => {
  // Tab 1: register + player session in `sid`
  let g = await jar.text('/register');
  let post = await jar.text('/register', { method: 'POST', body: { _csrf: csrfOf(g.body), name: 'Scope Player', email: 'player@scope.test', password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(post.status, 302, 'register');
  playerId = (await dbS.get("SELECT id FROM users WHERE email = 'player@scope.test'")).id;
  await dbS.run('UPDATE users SET email_verified = 1 WHERE id = ?', [playerId]);
  const sidBefore = jar.cookies.get('sid');
  assert.ok(sidBefore, 'player session cookie sid set');
  assert.ok(!jar.cookies.has('sid_admin'), 'no admin cookie yet');
  let w = await jar.text('/wallet');
  assert.equal(w.status, 200, 'tab 1: player wallet loads');

  // Tab 2 (SAME jar): the login page must NOT bounce the signed-in
  // player away, and must say the current session stays active.
  g = await jar.text('/login');
  assert.equal(g.status, 200, 'login page renders for a signed-in player');
  assert.ok(g.body.includes('separate session'), 'page explains the second login adds a separate session');
  post = await jar.text('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email: 'admin@scope.test', password: 'ScopeAdmin#pass' } });
  assert.equal(post.status, 302); assert.ok(post.loc.includes(ADMIN_PATH), 'admin lands on the panel');
  assert.ok(jar.cookies.has('sid_admin'), 'admin session lives in sid_admin');
  assert.equal(jar.cookies.get('sid'), sidBefore, 'the player cookie was NOT overwritten — the tab-swap bug is gone');

  // Refresh both tabs: each keeps its own account.
  w = await jar.text('/wallet');
  assert.equal(w.status, 200, 'tab 1 refresh: still the player');
  const panel = await jar.text(ADMIN_PATH);
  assert.equal(panel.status, 200, 'tab 2 refresh: still the admin panel');

  // Session rows carry truthful scopes.
  const rows = await dbS.query('SELECT user_id, scope FROM sessions WHERE user_id IN (?, ?) AND user_id != 0', [playerId, adminId]);
  assert.ok(rows.some(r => Number(r.user_id) === playerId && r.scope === 'site'), 'player session row is site scope');
  assert.ok(rows.some(r => Number(r.user_id) === adminId && r.scope === 'admin'), 'admin session row is admin scope');

  // An admin action in tab 2 is audited as the admin.
  const methodsPage = await jar.text(ADMIN_PATH + '/methods');
  const mid = (await dbS.get("SELECT id FROM payment_methods WHERE slug = 'rail-upi'")).id;
  const t = await jar.text(`${ADMIN_PATH}/methods/${mid}/toggle`, { method: 'POST', body: { _csrf: csrfOf(methodsPage.body) } });
  assert.equal(t.status, 302);
  const aud = await dbS.get("SELECT actor_id FROM audit_log WHERE action = 'method.toggle' ORDER BY id DESC LIMIT 1");
  assert.equal(Number(aud.actor_id), adminId, 'audit actor is the admin, not the player');

  // Player security page labels the session scope truthfully.
  const sec = await jar.text('/security');
  assert.equal(sec.status, 200);
  assert.ok(sec.body.includes('Website'), 'player session labelled Website');
});

test('panel logout clears ONLY the admin scope — the player tab stays logged in', { timeout: 60000 }, async () => {
  const g = await jar.text(ADMIN_PATH);
  assert.equal(g.status, 200);
  const post = await jar.text(ADMIN_PATH + '/logout', { method: 'POST', body: { _csrf: csrfOf(g.body) } });
  assert.equal(post.status, 302);
  assert.ok(!jar.cookies.has('sid_admin'), 'admin cookie cleared');
  const panel = await jar.text(ADMIN_PATH);
  // ADMIN-LOGIN-01 supersedes the root-404: the exact root now serves
  // the dedicated admin login page; the admin SESSION is still dead —
  // proven by the protected subpath staying 404.
  assert.equal(panel.status, 200, 'after admin logout the root serves the admin login page');
  assert.ok(panel.body.includes('Control Room'), 'admin login branding after logout');
  assert.equal((await jar.text(ADMIN_PATH + '/users')).status, 404, 'protected subpath still stealth-404 after admin logout');
  const w = await jar.text('/wallet');
  assert.equal(w.status, 200, 'player session survived the admin logout');
});

test('stealth regressions: player-only and anonymous browsers get plain 404 on admin paths', { timeout: 60000 }, async () => {
  const pOnly = new Jar('player-only');
  let g = await pOnly.text('/login');
  let post = await pOnly.text('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email: 'player@scope.test', password: 'Player#pass1' } });
  assert.equal(post.status, 302);
  assert.ok(!pOnly.cookies.has('sid_admin'));
  // ADMIN-LOGIN-01: the exact root serves the login page to anyone
  // (the path is the secret); every OTHER admin path keeps stealth 404.
  assert.equal((await pOnly.text(ADMIN_PATH)).status, 200, 'player-only jar: root serves the admin login page');
  assert.equal((await pOnly.text(ADMIN_PATH + '/users')).status, 404, 'player-only jar: panel subpath 404');
  const anon = new Jar('anon');
  assert.equal((await anon.text(ADMIN_PATH)).status, 200, 'anonymous: root serves the admin login page');
  assert.equal((await anon.text(ADMIN_PATH + '/settings')).status, 404, 'anonymous: panel subpath 404');
  assert.equal((await anon.text('/wallet')).status, 302, 'anonymous: wallet bounces to login');
});

test('revoke-all-other-sessions kills only that user\'s other sessions', { timeout: 60000 }, async () => {
  const jar5 = new Jar('second-device');
  let g = await jar5.text('/login');
  await jar5.text('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email: 'player@scope.test', password: 'Player#pass1' } });
  assert.equal((await jar5.text('/wallet')).status, 200, 'second session alive before revoke');
  const sec = await jar.text('/security');
  const post = await jar.text('/security/sessions/revoke', { method: 'POST', body: { _csrf: csrfOf(sec.body) } });
  assert.equal(post.status, 302);
  assert.equal((await jar5.text('/wallet')).status, 302, 'revoked session is signed out');
  assert.equal((await jar.text('/wallet')).status, 200, 'current session survives');
});

test('TOTP: the admin challenge rides sid_admin and never mutates the live player session', { timeout: 60000 }, async () => {
  const { newTotpSecret, totpCode } = require('../lib/auth');
  const secret = newTotpSecret();
  await dbS.run('UPDATE users SET totp_secret = ? WHERE id = ?', [secret, adminId]);

  const jarT = new Jar('totp-browser');
  let g = await jarT.text('/register');
  await jarT.text('/register', { method: 'POST', body: { _csrf: csrfOf(g.body), name: 'TOTP Bystander', email: 'bystander@scope.test', password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  const sidPlayer = jarT.cookies.get('sid');
  assert.ok(sidPlayer, 'bystander player logged in');
  assert.equal((await jarT.text('/wallet')).status, 200);

  // Admin password step in the same browser: TOTP page renders, the
  // challenge session is the ADMIN cookie, player cookie untouched.
  g = await jarT.text('/login');
  const step1 = await jarT.text('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email: 'admin@scope.test', password: 'ScopeAdmin#pass' } });
  assert.equal(step1.status, 200, 'TOTP challenge renders');
  assert.ok(jarT.cookies.has('sid_admin'), 'pre-auth challenge lives in sid_admin');
  assert.equal(jarT.cookies.get('sid'), sidPlayer, 'player cookie untouched by the admin password step');
  assert.equal((await jarT.text('/wallet')).status, 200, 'player STILL logged in during the admin TOTP challenge — no mutation');

  const code = totpCode(secret);
  const step2 = await jarT.text('/login', { method: 'POST', body: { _csrf: csrfOf(step1.body), totp_code: code } });
  assert.equal(step2.status, 302, 'TOTP step completes: ' + step2.status);
  assert.ok(step2.loc.includes(ADMIN_PATH), 'admin lands on the panel');
  assert.equal(jarT.cookies.get('sid'), sidPlayer, 'player cookie STILL untouched after admin TOTP login');
  assert.equal((await jarT.text('/wallet')).status, 200, 'player tab alive');
  assert.equal((await jarT.text(ADMIN_PATH)).status, 200, 'admin tab alive');
  await dbS.run("UPDATE users SET totp_secret = '' WHERE id = ?", [adminId]);
});
