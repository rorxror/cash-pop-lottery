'use strict';
/* HOTFIX 2026-10-29 — player self-service email change.
   Owner-reported dead end: profile said "Email cannot be changed
   here — contact support." The swap machinery (email_verifications +
   GET /verify-email/:token) already existed for admin-initiated and
   admin self-service changes; this round adds the PLAYER request
   path (POST /profile/change-email) with: current-password proof,
   one-account duplicate refusal, same-email refusal, swap ONLY when
   the new address clicks its emailed link, and delivery truth — if
   the email cannot be sent, the token is burned and nothing changes.
   Run: node --test test/profile-email-change.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PORT = 4179;
const BASE = 'http://127.0.0.1:' + PORT;
let server = null, dbB = null, smtpServer = null, smtpDown = false;
const mails = [];

class Jar {
  constructor(ua) { this.cookies = new Map(); this.ua = ua || 'ec-test'; }
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
async function register(jar, name, email, password) {
  const g = await jar.text('/register');
  const post = await jar.text('/register', { method: 'POST', body: { _csrf: csrfOf(g.body), name, email, password, password_confirm: password, agree: '1' } });
  assert.equal(post.status, 302, 'register ' + email);
}
async function pendingRow(userId) {
  return dbB.get('SELECT * FROM email_verifications WHERE user_id = ? AND used = 0 ORDER BY id DESC LIMIT 1', [userId]);
}

const jarA = new Jar('ec-a'); const jarB = new Jar('ec-b');
let userA;

test.before(async () => {
  smtpServer = net.createServer(sock => {
    let dataMode = false, buf = '';
    sock.write('220 capture.local ESMTP ready\r\n');
    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      if (dataMode) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end > -1) { mails.push(buf.slice(0, end)); buf = buf.slice(end + 5); dataMode = false; sock.write('250 OK queued\r\n'); }
        return;
      }
      let idx;
      while ((idx = buf.indexOf('\r\n')) > -1) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-capture.local\r\n250 OK\r\n');
        else if (cmd === 'DATA') { if (smtpDown) { sock.write('554 Transaction failed\r\n'); } else { dataMode = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); } break; }
        else if (cmd === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise(r => smtpServer.listen(0, '127.0.0.1', r));
  const smtpPort = smtpServer.address().port;
  const TMPB = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-ec-b-'));
  const env = { ...process.env,
    PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite',
    SQLITE_PATH: path.join(TMPB, 'b.sqlite'),
    TICKET_HMAC_SECRET: 'ec-test-hmac',
    CREDENTIAL_ENCRYPTION_KEY: ENC_KEY,
    ADMIN_SEED_EMAIL: 'admin@ec.test', ADMIN_SEED_PASSWORD: 'EcAdmin#pass', ADMIN_SEED_NAME: 'EC Admin',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_FROM: 'Cash Pop <test@cashpop.example>',
  };
  delete env.DATABASE_URL;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[ec server] ' + d));
  assert.ok(await waitHealthy(), 'server must boot');
  process.env.SQLITE_PATH = path.join(TMPB, 'b.sqlite');
  dbB = require('../lib/db').openDB().db;
  await register(jarA, 'Change A', 'a@change.test', 'Player#pass1');
  await register(jarB, 'Change B', 'b@change.test', 'Player#pass1');
  userA = (await dbB.get('SELECT id FROM users WHERE email = ?', ['a@change.test'])).id;
});

test.after(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch {} }
  if (smtpServer) { try { smtpServer.close(); } catch {} }
  try { if (dbB) await dbB.close(); } catch {}
});

async function changeEmail(jar, body) {
  const g = await jar.text('/profile');
  assert.equal(g.status, 200, 'profile loads');
  return jar.text('/profile/change-email', { method: 'POST', body: { _csrf: csrfOf(g.body), ...body } });
}

test('profile page: dead-end line gone, working Change email form present', async () => {
  const g = await jarA.text('/profile');
  assert.ok(!g.body.includes('cannot be changed here'), 'the dead-end wording is removed');
  assert.ok(g.body.includes('/profile/change-email'), 'the change-email form is on the profile page');
});

test('wrong current password refuses and creates nothing', async () => {
  const r = await changeEmail(jarA, { new_email: 'new@change.test', current_password: 'WrongPass#9' });
  assert.equal(r.status, 302);
  assert.equal(await pendingRow(userA), undefined, 'no pending row');
});

test('same email and another account\'s email are both refused', async () => {
  await changeEmail(jarA, { new_email: 'a@change.test', current_password: 'Player#pass1' });
  assert.equal(await pendingRow(userA), undefined, 'same email: no row');
  await changeEmail(jarA, { new_email: 'b@change.test', current_password: 'Player#pass1' });
  assert.equal(await pendingRow(userA), undefined, 'taken email: no row (one-account rule)');
});

test('delivery failure burns the token and changes nothing', async () => {
  smtpDown = true;
  try { await changeEmail(jarA, { new_email: 'new@change.test', current_password: 'Player#pass1' }); }
  finally { smtpDown = false; }
  const u = await dbB.get('SELECT email FROM users WHERE id = ?', [userA]);
  assert.equal(u.email, 'a@change.test', 'email unchanged when the send fails');
  const anyRow = await dbB.get('SELECT COUNT(*) AS c FROM email_verifications WHERE user_id = ? AND used = 0', [userA]);
  assert.equal(anyRow.c, 0, 'undelivered token is burned');
});

test('happy path: link to the NEW address swaps the email only when clicked', { timeout: 60000 }, async () => {
  const mailBefore = mails.length;
  const r = await changeEmail(jarA, { new_email: 'new@change.test', current_password: 'Player#pass1' });
  assert.equal(r.status, 302);
  const row = await pendingRow(userA);
  assert.ok(row && row.new_email === 'new@change.test', 'pending row targets the new address');
  const u1 = await dbB.get('SELECT email, email_verified FROM users WHERE id = ?', [userA]);
  assert.equal(u1.email, 'a@change.test', 'email NOT swapped before the click');
  const prof = await jarA.text('/profile');
  assert.ok(prof.body.includes('Confirmation pending') && prof.body.includes('new@change.test'), 'profile shows the pending state');
  // find the delivered mail + token
  let token = null;
  for (let i = 0; i < 20 && !token; i++) {
    const m = mails.slice(mailBefore).join('\n').match(/\/verify-email\/([a-f0-9]{32,})/);
    if (m) token = m[1]; else await new Promise(r2 => setTimeout(r2, 250));
  }
  assert.ok(token, 'the new address received a real verification link');
  // the "new address owner" clicks it (public route, fresh jar)
  const anon = new Jar('ec-anon');
  const click = await anon.text('/verify-email/' + token);
  assert.equal(click.status, 302, 'click redirects to login');
  const u2 = await dbB.get('SELECT email, email_verified FROM users WHERE id = ?', [userA]);
  assert.equal(u2.email, 'new@change.test', 'email swapped after the click');
  assert.equal(Number(u2.email_verified), 1, 'new email is verified');
  // Audit assertion goes through the ADMIN audit page (the operator
  // surface where the entry must appear) — the row itself was also
  // verified in the DB file during development; a second sqlite
  // connection in this process does not reliably observe the server's
  // hash-chained audit inserts mid-run.
  const jarAdmin = new Jar('ec-admin');
  const ga = await jarAdmin.text('/login');
  const la = await jarAdmin.text('/login', { method: 'POST', body: { _csrf: csrfOf(ga.body), email: 'admin@ec.test', password: 'EcAdmin#pass' } });
  assert.equal(la.status, 302, 'admin login');
  const auditPage = await jarAdmin.text('/ops-7f3a9c-console/audit');
  assert.equal(auditPage.status, 200, 'audit page loads');
  assert.ok(auditPage.body.includes('user.email_changed'), 'audit trail shows user.email_changed');
  // replaying the same link fails
  const replay = await anon.text('/verify-email/' + token);
  assert.equal(replay.status, 400, 'token is single-use');
  // and the player can sign in with the NEW email
  const jarNew = new Jar('ec-new');
  const gl = await jarNew.text('/login');
  const li = await jarNew.text('/login', { method: 'POST', body: { _csrf: csrfOf(gl.body), email: 'new@change.test', password: 'Player#pass1' } });
  assert.equal(li.status, 302, 'login with the new email works');
});
