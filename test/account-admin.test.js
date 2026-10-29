'use strict';
/* USER-PASS-SET-01 + ADMIN-SELF-01 E2E (spawned server, port 4135).
   USER-PASS-SET-01: the admin can DIRECTLY set a non-admin user's
   password from the user page (forced-change default ON): old
   password dies, new password lands on the forced-reset screen, the
   player then sets their own; with forced OFF the new password signs
   in directly. Admin targets stay excluded (404). Audit carries the
   forced flag only — never a password.
   ADMIN-SELF-01: the panel's My Account page works ONLY on the
   signed-in admin (name, login email, password): current-password
   proof, duplicate-email refusal, wrong-password refusal (audited),
   other sessions killed on password change while the current one
   survives, and a finance-role staffer's page shows only their own
   data (and RBAC still refuses them the user set-password action). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-acct-'));
const PORT = 4135;
const BASE = 'http://localhost:' + PORT;
const ADMIN_PATH = '/ops-7f3a9c-console';

class Jar {
  constructor(ua) { this.cookies = new Map(); this.ua = ua || 'acct-test'; }
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
async function loginAs(jar, email, password) {
  const g = await jar.text('/login');
  return jar.text('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email, password } });
}

let server = null, dbA = null, adminJar, playerJar, adminId, playerId;

test.before(async () => {
  const env = { ...process.env,
    PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite',
    SQLITE_PATH: path.join(TMP, 'a.sqlite'),
    TICKET_HMAC_SECRET: 'acct-test-ticket-hmac-secret-throwaway-0123456789',
    CREDENTIAL_ENCRYPTION_KEY: ENC_KEY,
    ADMIN_SEED_EMAIL: 'admin@acct.test', ADMIN_SEED_PASSWORD: 'AcctAdmin#pass', ADMIN_SEED_NAME: 'Acct Admin',
  };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[acct server] ' + d));
  assert.ok(await waitHealthy(), 'server must boot');
  process.env.SQLITE_PATH = path.join(TMP, 'a.sqlite');
  process.env.DB_DRIVER = 'sqlite';
  dbA = require('../lib/db').openDB().db;
  adminId = (await dbA.get("SELECT id FROM users WHERE email = 'admin@acct.test'")).id;

  adminJar = new Jar('acct-admin');
  const lp = await loginAs(adminJar, 'admin@acct.test', 'AcctAdmin#pass');
  assert.equal(lp.status, 302); assert.ok(lp.loc.includes(ADMIN_PATH));

  playerJar = new Jar('acct-player');
  const g = await playerJar.text('/register');
  const post = await playerJar.text('/register', { method: 'POST', body: { _csrf: csrfOf(g.body), name: 'Acct Player', email: 'player@acct.test', password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(post.status, 302, 'register player');
  playerId = (await dbA.get("SELECT id FROM users WHERE email = 'player@acct.test'")).id;
  await dbA.run('UPDATE users SET email_verified = 1 WHERE id = ?', [playerId]);
});

test.after(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch {} }
  try { if (dbA) await dbA.close(); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('USER-PASS-SET-01: forced set — old password dies, new one lands on forced-reset, player then sets their own', { timeout: 60000 }, async () => {
  const detail = await adminJar.text(`${ADMIN_PATH}/users/${playerId}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.includes('/set-password') && detail.body.includes('Set password'), 'set-password form sits on the user page'); // USER-DETAIL-01 rewrote the card copy; assert the form itself, not a heading string
  assert.ok(detail.body.includes('Reset password'), 'reset-link button still there');

  const post = await adminJar.text(`${ADMIN_PATH}/users/${playerId}/set-password`, { method: 'POST', body: { _csrf: csrfOf(detail.body), new_password: 'SetByAdmin#1', new_password_confirm: 'SetByAdmin#1', force_change: 'on' } });
  assert.equal(post.status, 302);
  const u = await dbA.get('SELECT force_password_reset FROM users WHERE id = ?', [playerId]);
  assert.equal(Number(u.force_password_reset), 1, 'forced-change flag set');
  const aud = await dbA.get("SELECT detail FROM audit_log WHERE action = 'user.password_set_admin' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(playerId)]);
  assert.ok(aud, 'audit row exists');
  assert.ok(!String(aud.detail).includes('SetByAdmin'), 'audit NEVER carries the password');
  assert.equal((await playerJar.text('/wallet')).status, 302, 'player sessions destroyed by the set');

  const fresh = new Jar('acct-player-fresh');
  const oldTry = await loginAs(fresh, 'player@acct.test', 'Player#pass1');
  assert.ok(!(oldTry.status === 302 && oldTry.loc === '/'), 'old password no longer signs in');
  assert.equal((await fresh.text('/wallet')).status, 302, 'old password: no session');

  const newTry = await loginAs(fresh, 'player@acct.test', 'SetByAdmin#1');
  assert.equal(newTry.status, 302, 'new password signs in');
  const home = await fresh.text('/');
  assert.equal(home.status, 302); assert.ok(home.loc.includes('/force-reset'), 'forced flag gates to the reset screen');
  const fr = await fresh.text('/force-reset');
  assert.equal(fr.status, 200, 'forced-reset screen renders');
  const done = await fresh.text('/force-reset', { method: 'POST', body: { _csrf: csrfOf(fr.body), password: 'PlayerOwn#99', password2: 'PlayerOwn#99' } });
  assert.equal(done.status, 302);
  assert.equal(Number((await dbA.get('SELECT force_password_reset FROM users WHERE id = ?', [playerId])).force_password_reset), 0, 'flag cleared after own set');
  assert.equal((await fresh.text('/wallet')).status, 200, 'player fully in with their own password');
});

test('USER-PASS-SET-01: unforced set signs in directly; mismatch changes nothing; admin target excluded', { timeout: 60000 }, async () => {
  const detail = await adminJar.text(`${ADMIN_PATH}/users/${playerId}`);
  const post = await adminJar.text(`${ADMIN_PATH}/users/${playerId}/set-password`, { method: 'POST', body: { _csrf: csrfOf(detail.body), new_password: 'DirectSet#22', new_password_confirm: 'DirectSet#22' } });
  assert.equal(post.status, 302);
  assert.equal(Number((await dbA.get('SELECT force_password_reset FROM users WHERE id = ?', [playerId])).force_password_reset), 0);
  const fresh = new Jar('acct-player-direct');
  const t = await loginAs(fresh, 'player@acct.test', 'DirectSet#22');
  assert.equal(t.status, 302);
  assert.equal((await fresh.text('/wallet')).status, 200, 'unforced set: straight into the account');

  const bad = await adminJar.text(`${ADMIN_PATH}/users/${playerId}/set-password`, { method: 'POST', body: { _csrf: csrfOf(detail.body), new_password: 'Mismatch#333', new_password_confirm: 'Mismatch#444', force_change: 'on' } });
  assert.equal(bad.status, 302);
  const still = new Jar('acct-player-still');
  const t2 = await loginAs(still, 'player@acct.test', 'DirectSet#22');
  assert.equal(t2.status, 302, 'mismatched set changed nothing — previous password still works');
  assert.equal(Number((await dbA.get('SELECT force_password_reset FROM users WHERE id = ?', [playerId])).force_password_reset), 0, 'flag untouched by failed set');

  const adm = await adminJar.text(`${ADMIN_PATH}/users/${adminId}/set-password`, { method: 'POST', body: { _csrf: csrfOf(detail.body), new_password: 'Takeover#123', new_password_confirm: 'Takeover#123' } });
  assert.equal(adm.status, 404, 'admin targets stay excluded from the generic handler (no A-1 style takeover)');
});

test('ADMIN-SELF-01: name, email (proof + duplicate + immediate path), password (other sessions die, current lives)', { timeout: 60000 }, async () => {
  const page = await adminJar.text(ADMIN_PATH + '/my-account');
  assert.equal(page.status, 200, 'My Account renders inside the panel');
  assert.ok(page.body.includes('Display name') && page.body.includes('Login email') && page.body.includes('free hosting plan'), 'all three sections + the honest hosting note');

  // name
  let post = await adminJar.text(ADMIN_PATH + '/my-account/name', { method: 'POST', body: { _csrf: csrfOf(page.body), name: 'Boss Admin' } });
  assert.equal(post.status, 302);
  assert.equal((await dbA.get('SELECT name FROM users WHERE id = ?', [adminId])).name, 'Boss Admin');
  const home = await adminJar.text(ADMIN_PATH + '/');
  assert.ok(home.body.includes('Boss Admin'), 'panel header shows the new name');
  assert.ok(await dbA.get("SELECT id FROM audit_log WHERE action = 'admin.self_name' AND entity_id = ?", [String(adminId)]), 'name change audited');

  // second admin session (to prove the password change kills it)
  const jar2 = new Jar('acct-admin-second');
  const l2 = await loginAs(jar2, 'admin@acct.test', 'AcctAdmin#pass');
  assert.equal(l2.status, 302);
  assert.equal((await jar2.text(ADMIN_PATH + '/my-account')).status, 200, 'second session alive before the change');

  // email: wrong current password -> refusal, audited, nothing changes
  post = await adminJar.text(ADMIN_PATH + '/my-account/email', { method: 'POST', body: { _csrf: csrfOf(page.body), new_email: 'boss@acct.test', current_password: 'WrongPass#123' } });
  assert.equal(post.status, 302);
  assert.equal((await dbA.get('SELECT email FROM users WHERE id = ?', [adminId])).email, 'admin@acct.test', 'wrong password: email unchanged');
  const failAud = await dbA.get("SELECT detail FROM audit_log WHERE action = 'admin.self_email' ORDER BY id DESC LIMIT 1");
  assert.ok(failAud && JSON.parse(failAud.detail).ok === false, 'failed attempt audit-logged');

  // email: duplicate (the player's) -> refusal
  post = await adminJar.text(ADMIN_PATH + '/my-account/email', { method: 'POST', body: { _csrf: csrfOf(page.body), new_email: 'player@acct.test', current_password: 'AcctAdmin#pass' } });
  assert.equal(post.status, 302);
  assert.equal((await dbA.get('SELECT email FROM users WHERE id = ?', [adminId])).email, 'admin@acct.test', 'duplicate: email unchanged');

  // password: wrong current -> refusal
  post = await adminJar.text(ADMIN_PATH + '/my-account/password', { method: 'POST', body: { _csrf: csrfOf(page.body), current_password: 'WrongPass#123', new_password: 'NewBoss#pass12', new_password_confirm: 'NewBoss#pass12' } });
  assert.equal(post.status, 302);
  const probe = new Jar('acct-probe');
  const lp = await loginAs(probe, 'admin@acct.test', 'AcctAdmin#pass');
  assert.equal(lp.status, 302, 'wrong-current attempt changed nothing — old password still works');

  // password: correct -> other session dies, current survives
  const page2 = await adminJar.text(ADMIN_PATH + '/my-account');
  post = await adminJar.text(ADMIN_PATH + '/my-account/password', { method: 'POST', body: { _csrf: csrfOf(page2.body), current_password: 'AcctAdmin#pass', new_password: 'NewBoss#pass12', new_password_confirm: 'NewBoss#pass12' } });
  assert.equal(post.status, 302);
  assert.equal((await jar2.text(ADMIN_PATH + '/my-account')).status, 404, 'other admin session destroyed (stealth 404 = signed out)');
  assert.equal((await adminJar.text(ADMIN_PATH + '/my-account')).status, 200, 'current session survives');
  const oldJar = new Jar('acct-oldpw');
  const lo = await loginAs(oldJar, 'admin@acct.test', 'AcctAdmin#pass');
  assert.ok(!(lo.status === 302 && lo.loc.includes(ADMIN_PATH)), 'old password no longer reaches the panel');
  const newJar = new Jar('acct-newpw');
  const ln = await loginAs(newJar, 'admin@acct.test', 'NewBoss#pass12');
  assert.equal(ln.status, 302); assert.ok(ln.loc.includes(ADMIN_PATH), 'new password reaches the panel');
  assert.ok(await dbA.get("SELECT id FROM audit_log WHERE action = 'admin.self_password' AND entity_id = ?", [String(adminId)]), 'password change audited');

  // email change with the NEW password (immediate path — no SMTP in the test env)
  const page3 = await adminJar.text(ADMIN_PATH + '/my-account');
  post = await adminJar.text(ADMIN_PATH + '/my-account/email', { method: 'POST', body: { _csrf: csrfOf(page3.body), new_email: 'boss@acct.test', current_password: 'NewBoss#pass12' } });
  assert.equal(post.status, 302);
  assert.equal((await dbA.get('SELECT email FROM users WHERE id = ?', [adminId])).email, 'boss@acct.test', 'email changed (immediate, email not configured)');
  const after = await adminJar.text(ADMIN_PATH + '/my-account');
  assert.ok(after.body.includes('applied straight away') || after.body.includes('boss@acct.test'), 'page/flash states the change plainly');
  const oldMail = new Jar('acct-oldmail');
  const lom = await loginAs(oldMail, 'admin@acct.test', 'NewBoss#pass12');
  assert.ok(!(lom.status === 302 && lom.loc.includes(ADMIN_PATH)), 'old login email no longer works');
  const newMail = new Jar('acct-newmail');
  const lnm = await loginAs(newMail, 'boss@acct.test', 'NewBoss#pass12');
  assert.equal(lnm.status, 302); assert.ok(lnm.loc.includes(ADMIN_PATH), 'new login email works');
});

test('ADMIN-SELF-01 RBAC: a finance staffer sees only their OWN account page and cannot set user passwords', { timeout: 60000 }, async () => {
  const { hashPassword } = require('../lib/util');
  const { now } = require('../lib/util');
  const ins = await dbA.run("INSERT INTO users (name, email, password_hash, role, admin_role, status, email_verified, created_at) VALUES ('Fin Person', 'fin@acct.test', ?, 'admin', 'finance', 'active', 1, ?)", [hashPassword('Finance#pass1'), now()]);
  const finJar = new Jar('acct-finance');
  const lf = await loginAs(finJar, 'fin@acct.test', 'Finance#pass1');
  assert.equal(lf.status, 302); assert.ok(lf.loc.includes(ADMIN_PATH), 'finance staffer reaches the panel');
  const page = await finJar.text(ADMIN_PATH + '/my-account');
  assert.equal(page.status, 200, 'finance staffer can open My Account');
  assert.ok(page.body.includes('fin@acct.test'), 'page shows THEIR email');
  assert.ok(!page.body.includes('boss@acct.test'), 'page never shows the super admin\'s data');
  const detail = await finJar.text(`${ADMIN_PATH}/users/${playerId}`);
  const post = await finJar.text(`${ADMIN_PATH}/users/${playerId}/set-password`, { method: 'POST', body: { _csrf: csrfOf(detail.body), new_password: 'FinSet#12345', new_password_confirm: 'FinSet#12345' } });
  assert.equal(post.status, 403, 'RBAC: set-password is a SAFETY action — finance is refused');
  void ins;
});
