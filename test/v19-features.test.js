'use strict';
/* V19 BLUEPRINT-ROUND regression tests (BP-13/14/15/16).
   Run: node --test test/v19-features.test.js
   Part A (lib level, own temp DB): migration v16 shape + the
   emailPrefEnabled gate semantics BP-13 relies on.
   Part B (spawned server, own temp DB + port): /healthz contract, the
   canned-reply E2E (admin creates -> ticket page offers picker -> reply
   sent -> player sees it), notification-preference gating of the
   support-reply email (outbox row present only when the pref is on),
   and the /security sessions list + revoke-others flow. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP_A = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-v19a-'));
const TMP_B = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-v19b-'));
process.env.SQLITE_PATH = path.join(TMP_A, 'a.sqlite');
process.env.DB_DRIVER = 'sqlite';
delete process.env.DATABASE_URL;

const { openDB } = require('../lib/db');
const { migrate } = require('../lib/migrations');
const { ensureScratchSchema } = require('../lib/scratch');
const notify = require('../lib/notify');
const { now } = require('../lib/util');

const { db } = openDB();

/* ---------------- Part A: lib level ---------------- */

test.before(async () => {
  await migrate(db, 'sqlite');
  await ensureScratchSchema(db, 'sqlite');
});

test('BP-15/BP-13 schema: migration v16 adds canned_replies + pref columns (default on)', async () => {
  const t = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'canned_replies'");
  assert.ok(t, 'canned_replies table must exist');
  const cols = await db.query('PRAGMA table_info(users)');
  const win = cols.find(c => c.name === 'notify_win_email');
  const sup = cols.find(c => c.name === 'notify_support_email');
  assert.ok(win && sup, 'preference columns must exist');
  assert.equal(Number(win.dflt_value), 1);
  assert.equal(Number(sup.dflt_value), 1);
  const v = await db.get('SELECT MAX(version) AS v FROM migrations_applied');
  assert.ok(Number(v.v) >= 16, 'migration v16 must be recorded');
});

test('BP-13 gate: emailPrefEnabled defaults on, respects opt-out, fails open', async () => {
  const r = await db.run(
    "INSERT INTO users (email, name, password_hash, role, status, email_verified, created_at) VALUES ('pref@test.dev', 'Pref', 'x', 'player', 'active', 1, ?)", [now()]);
  const uid = r.id;
  assert.equal(await notify.emailPrefEnabled(db, uid, 'win'), true, 'default must be on');
  assert.equal(await notify.emailPrefEnabled(db, uid, 'support_reply'), true, 'default must be on');
  await db.run('UPDATE users SET notify_win_email = 0 WHERE id = ?', [uid]);
  assert.equal(await notify.emailPrefEnabled(db, uid, 'win'), false, 'opt-out must gate win mail');
  assert.equal(await notify.emailPrefEnabled(db, uid, 'support_reply'), true, 'other topic unaffected');
  await db.run('UPDATE users SET notify_support_email = 0 WHERE id = ?', [uid]);
  assert.equal(await notify.emailPrefEnabled(db, uid, 'support_reply'), false, 'opt-out must gate support mail');
  assert.equal(await notify.emailPrefEnabled(db, uid, 'deposit_approved'), true, 'ungated topic stays on');
  assert.equal(await notify.emailPrefEnabled(db, 99999999, 'win'), true, 'missing user fails open');
  assert.equal(await notify.emailPrefEnabled(db, null, 'win'), true, 'missing id fails open');
});

/* ---------------- Part B: spawned server ---------------- */

const PORT = 3219;
const BASE = 'http://localhost:' + PORT;
const ADMIN_PATH = '/ops-7f3a9c-console';
let server = null;
let dbB = null; // read-mostly second connection to the server's DB file

class Jar {
  constructor(ua) { this.cookies = new Map(); this.ua = ua || 'v19-test-agent'; }
  async req(p, { method = 'GET', body } = {}) {
    const headers = { 'User-Agent': this.ua };
    if (this.cookies.size) headers.Cookie = [...this.cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
    let payload;
    if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const pair = c.split(';')[0]; const i = pair.indexOf('=');
      if (i > 0) { const k = pair.slice(0, i).trim(); const v = pair.slice(i + 1).trim(); if (v) this.cookies.set(k, v); else this.cookies.delete(k); }
    }
    return res;
  }
  async text(p, opts) { const r = await this.req(p, opts); return { status: r.status, loc: r.headers.get('location') || '', body: await r.text() }; }
}
function csrfOf(html) { const m = String(html).match(/name="_csrf" value="([^"]+)"/); return m && m[1]; }

async function waitHealthy(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.status === 200) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

let adminJar, playerJar;

test.before(async () => {
  const env = { ...process.env,
    PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite',
    SQLITE_PATH: path.join(TMP_B, 'b.sqlite'),
    TICKET_HMAC_SECRET: '<redacted>',
    ADMIN_SEED_EMAIL: 'admin@v19.test', ADMIN_SEED_PASSWORD: 'V19Admin#pass', ADMIN_SEED_NAME: 'V19 Admin',
  };
  delete env.DATABASE_URL; delete env.SMTP_HOST; delete env.DATABASE_URL_PG;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[v19 server] ' + d));
  assert.ok(await waitHealthy(), 'server must boot and answer /healthz');
  process.env.SQLITE_PATH = path.join(TMP_B, 'b.sqlite');
  dbB = openDB().db;

  // admin login
  adminJar = new Jar('v19-admin-ua');
  let g = await adminJar.text('/login');
  let post = await adminJar.text('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email: 'admin@v19.test', password: 'V19Admin#pass' } });
  assert.equal(post.status, 302, 'admin login redirects');
  assert.ok(post.loc.includes(ADMIN_PATH), 'admin lands on the console path, got: ' + post.loc);

  // player registration (auto-logs-in)
  playerJar = new Jar('V19PlayerBrowser/1.0');
  g = await playerJar.text('/register');
  post = await playerJar.text('/register', { method: 'POST', body: {
    _csrf: csrfOf(g.body), name: 'V19 Player', email: 'player@v19.test',
    phone_cc: '+1', phone_local: '5551112222', phone: '+15551112222',
    password: 'PlayerPass#1', password_confirm: 'PlayerPass#1', agree: 'on',
  } });
  assert.equal(post.status, 302, 'register redirects, got ' + post.status);
});

test.after(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch {} }
  try { await db.close(); } catch {}
  try { if (dbB) await dbB.close(); } catch {}
  fs.rmSync(TMP_A, { recursive: true, force: true });
  fs.rmSync(TMP_B, { recursive: true, force: true });
});

test('BP-16: /healthz returns ok:true with no config leakage', async () => {
  const r = await fetch(BASE + '/healthz');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.deepEqual(Object.keys(j).sort(), ['ok', 'time'], 'healthz must expose nothing but ok+time');
});

test('BP-15 E2E: admin canned reply -> picker on ticket -> send -> player sees it', { timeout: 60000 }, async () => {
  // create the canned reply as admin
  let g = await adminJar.text(ADMIN_PATH + '/support/canned-replies');
  assert.equal(g.status, 200);
  assert.match(g.body, /New canned reply/);
  let post = await adminJar.text(ADMIN_PATH + '/support/canned-replies', { method: 'POST', body: {
    _csrf: csrfOf(g.body), title: 'V19 deposit review', body: 'Your deposit is being reviewed by our team.' } });
  assert.equal(post.status, 302, 'create redirects');
  g = await adminJar.text(ADMIN_PATH + '/support/canned-replies');
  assert.match(g.body, /V19 deposit review/, 'created canned reply is listed');

  // player opens a ticket
  g = await playerJar.text('/support');
  post = await playerJar.text('/support/new', { method: 'POST', body: {
    _csrf: csrfOf(g.body), subject: 'Deposit question', message: 'Where is my deposit?', priority: 'normal' } });
  assert.equal(post.status, 302);
  const pub = decodeURIComponent(post.loc.split('/support/')[1]);
  assert.ok(pub, 'ticket public id from redirect: ' + post.loc);

  // admin opens the ticket: picker + canned title must be offered
  g = await adminJar.text(ADMIN_PATH + '/support/' + pub);
  assert.equal(g.status, 200);
  assert.match(g.body, /data-canned-picker/, 'ticket page must carry the canned picker');
  assert.match(g.body, /V19 deposit review/, 'picker lists the canned title');
  assert.match(g.body, /cannedData/, 'picker data island present');

  // admin sends a reply using the canned text (what the picker inserts)
  post = await adminJar.text(ADMIN_PATH + '/support/' + pub + '/reply', { method: 'POST', body: {
    _csrf: csrfOf(g.body), message: 'Your deposit is being reviewed by our team.' } });
  assert.equal(post.status, 302, 'reply send must not 404');

  // player sees the reply on their ticket page
  g = await playerJar.text('/support/' + pub);
  assert.equal(g.status, 200);
  assert.match(g.body, /Your deposit is being reviewed by our team\./, 'player sees the canned reply text');

  // agent picker renders too (assign the player to a fresh agent account)
  const agentJar = new Jar('v19-agent-ua');
  g = await agentJar.text('/register');
  post = await agentJar.text('/register', { method: 'POST', body: {
    _csrf: csrfOf(g.body), name: 'V19 Agent', email: 'agent@v19.test',
    phone_cc: '+1', phone_local: '5553334444', phone: '+15553334444',
    password: 'AgentPass#1', password_confirm: 'AgentPass#1', agree: 'on' } });
  assert.equal(post.status, 302);
  const agent = await dbB.get("SELECT id FROM users WHERE email = 'agent@v19.test'");
  const player = await dbB.get("SELECT id FROM users WHERE email = 'player@v19.test'");
  await dbB.run("UPDATE users SET role = 'agent' WHERE id = ?", [agent.id]);
  await dbB.run('UPDATE users SET agent_id = ? WHERE id = ?', [agent.id, player.id]);
  // fresh login so the session carries the agent role
  const agentJar2 = new Jar('v19-agent-ua');
  g = await agentJar2.text('/login');
  post = await agentJar2.text('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email: 'agent@v19.test', password: 'AgentPass#1' } });
  assert.equal(post.status, 302);
  g = await agentJar2.text('/agent/support/' + pub);
  assert.equal(g.status, 200, 'agent can open own player ticket');
  assert.match(g.body, /data-canned-picker/, 'agent ticket page must carry the canned picker');
});

async function supportReplyLogCount(email) {
  for (let i = 0; i < 10; i++) {
    try {
      const r = await dbB.get(
        "SELECT COUNT(*) AS c FROM notifications_log WHERE channel = 'email' AND to_addr = ? AND subject LIKE '%support%'", [email]);
      return Number(r.c);
    } catch { await new Promise(r => setTimeout(r, 200)); }
  }
  throw new Error('could not read notifications_log');
}

test('BP-13 E2E: support-reply email honours the player preference (off -> no send, on -> send)', { timeout: 60000 }, async () => {
  // player opens a second ticket
  let g = await playerJar.text('/support');
  let post = await playerJar.text('/support/new', { method: 'POST', body: {
    _csrf: csrfOf(g.body), subject: 'Pref check', message: 'Testing mail prefs', priority: 'normal' } });
  const pub = decodeURIComponent(post.loc.split('/support/')[1]);

  // turn support email OFF, win stays ON
  g = await playerJar.text('/profile');
  post = await playerJar.text('/profile/notifications', { method: 'POST', body: {
    _csrf: csrfOf(g.body), notify_win_email: '1' } });
  assert.equal(post.status, 302);
  const u = await dbB.get("SELECT notify_win_email, notify_support_email FROM users WHERE email = 'player@v19.test'");
  assert.equal(Number(u.notify_win_email), 1);
  assert.equal(Number(u.notify_support_email), 0, 'preference must persist');

  const before = await supportReplyLogCount('player@v19.test');
  g = await adminJar.text(ADMIN_PATH + '/support/' + pub);
  post = await adminJar.text(ADMIN_PATH + '/support/' + pub + '/reply', { method: 'POST', body: {
    _csrf: csrfOf(g.body), message: 'Reply while pref is off' } });
  assert.equal(post.status, 302);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(await supportReplyLogCount('player@v19.test'), before, 'no support-reply email may be attempted while the pref is off');

  // turn it back ON -> the next reply produces an outbox row
  g = await playerJar.text('/profile');
  post = await playerJar.text('/profile/notifications', { method: 'POST', body: {
    _csrf: csrfOf(g.body), notify_win_email: '1', notify_support_email: '1' } });
  assert.equal(post.status, 302);
  g = await adminJar.text(ADMIN_PATH + '/support/' + pub);
  post = await adminJar.text(ADMIN_PATH + '/support/' + pub + '/reply', { method: 'POST', body: {
    _csrf: csrfOf(g.body), message: 'Reply while pref is on' } });
  assert.equal(post.status, 302);
  await new Promise(r => setTimeout(r, 300));
  assert.ok((await supportReplyLogCount('player@v19.test')) > before, 'support-reply email must be attempted once the pref is back on');
});

test('BP-14 E2E: /security lists own sessions; revoke signs out the other session only', { timeout: 60000 }, async () => {
  let g = await playerJar.text('/security');
  assert.equal(g.status, 200);
  assert.match(g.body, /Active sessions/, 'sessions section renders');
  assert.match(g.body, /This session/, 'current session is marked');
  assert.match(g.body, /V19PlayerBrowser/, 'the recorded user-agent is shown verbatim');

  // second login for the same player
  const jar2 = new Jar('V19SecondBrowser/2.0');
  g = await jar2.text('/login');
  let post = await jar2.text('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email: 'player@v19.test', password: 'PlayerPass#1' } });
  assert.equal(post.status, 302, 'second login succeeds');
  g = await jar2.text('/wallet');
  assert.equal(g.status, 200, 'second session works before revoke');

  // revoke from the first session
  g = await playerJar.text('/security');
  assert.match(g.body, /V19SecondBrowser/, 'both sessions are listed');
  post = await playerJar.text('/security/sessions/revoke', { method: 'POST', body: { _csrf: csrfOf(g.body) } });
  assert.equal(post.status, 302);
  g = await jar2.text('/wallet');
  assert.equal(g.status, 302, 'revoked session is signed out');
  assert.ok(g.loc.includes('/login'), 'revoked session lands on login, got: ' + g.loc);
  g = await playerJar.text('/wallet');
  assert.equal(g.status, 200, 'current session survives the revoke');
});
