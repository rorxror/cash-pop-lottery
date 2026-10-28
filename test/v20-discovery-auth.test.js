'use strict';
/* V20 owner-fix round — DISCOVERY D2 auth/session domain (D-FIX-A).
   Run: node --test test/v20-discovery-auth.test.js
   Each test is the D2 finder's live repro, INVERTED: the behaviour the
   finder proved broken must now be impossible.
     C1 pre-auth (pending-TOTP) sessions carry the 15-min PREAUTH_TTL,
        not the 1-hour anon TTL — DB lifetime + aged-stash death.
     C2 destroyUserSessions also kills pre-auth sessions (user_id=0,
        data.pending_user_id): a password reset kills a pending-TOTP
        session started before the reset; the new password still works.
     C4 custom captcha is single-use ACROSS requests: one solve mints
        one reset token; the replayed answer is refused.
     C7 POST /reset/:token refuses a session-less, tokenless POST
        (403, password unchanged, token unconsumed) while the genuine
        emailed-link flow (GET sets session/CSRF, form carries the
        token, POST succeeds) still works.
     C8 (re-verify of U-04b) XFF chains: the internal proxy hop and a
        spoofed prefix are never recorded as the client IP, and a
        spoofed prefix cannot mint a fresh rate-limit bucket.
     C9 OAuth redirect_uri is absolute without BASE_URL (request-host
        fallback), and unchanged (BASE_URL) when BASE_URL is set.
   C3 (TOTP enrolment re-auth) and C6 (verify-email discipline) live in
   routes/player.js / routes/admin.js — outside D-FIX-A's files; they
   are SPEC'd in audits/owner-fix-round/adj-discovery-auth.md and appear
   here as skipped placeholders so the suite names them.
   Spawned servers: port 4136 (BASE_URL set) and 4137 (no BASE_URL). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP1 = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-dfixa1-'));
const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-dfixa2-'));
const PORT1 = 4136, PORT2 = 4137;
const BASE1 = 'http://localhost:' + PORT1;
const BASE2 = 'http://localhost:' + PORT2;
const HMAC = 'v20-dfixa-e2e-secret-0123456789abcdef0123456789abcdef';

process.env.DB_DRIVER = 'sqlite';
delete process.env.DATABASE_URL;
const { openDB } = require('../lib/db');
const { sha256, now } = require('../lib/util');
const authLib = require('../lib/auth');

class Jar {
  constructor(base) { this.cookies = new Map(); this.base = base; }
  async req(p, { method = 'GET', body, headers = {} } = {}) {
    const h = { 'User-Agent': 'v20-dfixa-test', ...headers };
    if (this.cookies.size) h.Cookie = [...this.cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
    let payload;
    if (body && headers['Content-Type'] === 'application/json') payload = JSON.stringify(body);
    else if (body) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    const res = await fetch(this.base + p, { method, headers: h, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const pair = c.split(';')[0]; const i = pair.indexOf('=');
      if (i > 0) { const k = pair.slice(0, i).trim(); const v = pair.slice(i + 1).trim(); if (v) this.cookies.set(k, v); else this.cookies.delete(k); }
    }
    return { status: res.status, loc: res.headers.get('location') || '', headers: res.headers, body: await res.text() };
  }
}
function csrfOf(html) { const m = String(html).match(/name="_csrf" value="([^"]+)"/); return m && m[1]; }
function captchaAnswer(html) { const m = String(html).match(/what is (\d+) \+ (\d+)\?/); return m ? String(Number(m[1]) + Number(m[2])) : null; }
async function waitHealthy(base, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(base + '/healthz'); if (r.status === 200) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
function spawnServer(port, sqlitePath, extraEnv) {
  const env = { ...process.env,
    PORT: String(port), DB_DRIVER: 'sqlite', SQLITE_PATH: sqlitePath,
    TICKET_HMAC_SECRET: HMAC,
    ADMIN_SEED_EMAIL: 'admin@dfixa.test', ADMIN_SEED_PASSWORD: 'Df1xa!Admin2948', ADMIN_SEED_NAME: 'DFIXA Admin',
    GOOGLE_CLIENT_ID: 'g-dfixa', GOOGLE_CLIENT_SECRET: 'g-dfixa-secret',
    FACEBOOK_APP_ID: 'fb-dfixa', FACEBOOK_APP_SECRET: 'fb-dfixa-secret',
    ...extraEnv };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  const child = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.stderr.write('[dfixa server] ' + d));
  return child;
}

let server1 = null, server2 = null, db1 = null;
const PW = {
  a: 'Df1x!Alice2948Qz', aNew: 'Df1x!AliceNew5731Qz',
  b: 'Df1x!Bob2948Qz', bNew: 'Df1x!BobNew5731Qz',
  d: 'Df1x!Dave2948Qz', dNew: 'Df1x!DaveNew5731Qz', attack: 'Df1x!Attack9999Qz',
};

async function registerUser(email, password) {
  const jar = new Jar(BASE1);
  const g = await jar.req('/register');
  const post = await jar.req('/register', { method: 'POST', body: {
    _csrf: csrfOf(g.body), name: 'DFIXA User', email, phone: '',
    password, password_confirm: password, agree: '1' } });
  assert.equal(post.status, 302, 'register ' + email + ' must succeed, got ' + post.status + ' ' + post.body.slice(0, 160));
  const u = await db1.get('SELECT * FROM users WHERE email = ?', [email]);
  assert.ok(u, email + ' row must exist');
  return { jar, user: u };
}
async function passwordStash(email, password) {
  const jar = new Jar(BASE1);
  const g = await jar.req('/login');
  const post = await jar.req('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email, password } });
  assert.equal(post.status, 200);
  assert.match(post.body, /totp_code/, 'password step must reach the TOTP challenge');
  return { jar, page: post };
}
async function totpComplete(jar, page, secret) {
  return jar.req('/login', { method: 'POST', body: { _csrf: csrfOf(page.body), totp_code: authLib.totpCode(secret) } });
}
/* RT-01 one-use: a TOTP step that already completed one login is a
   replay. A test that completes twice for the same user must wait for
   the next 30s step before the second completion — the refusal of the
   same-step code is the app being CORRECT, not a failure. */
async function waitNextTotpStep() {
  const step = () => Math.floor(Date.now() / 30000);
  const s0 = step();
  while (step() === s0) await new Promise(r => setTimeout(r, 400));
}
async function insertResetToken(userId, token) {
  await db1.run('INSERT INTO password_resets (user_id, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)',
    [userId, sha256('reset:' + token), now() + 3600000, now()]);
}
async function preAuthRowsFor(userId) {
  const rows = await db1.query('SELECT * FROM sessions WHERE user_id = 0');
  return rows.filter(r => { try { return Number(JSON.parse(r.data || '{}').pending_user_id) === Number(userId); } catch { return false; } });
}

test.before(async () => {
  server1 = spawnServer(PORT1, path.join(TMP1, 'one.sqlite'), { BASE_URL: BASE1 });
  assert.ok(await waitHealthy(BASE1), 'server1 (4136) must boot');
  process.env.SQLITE_PATH = path.join(TMP1, 'one.sqlite');
  db1 = openDB().db;
  // Deterministic password flows: the HIBP breached check is fail-open
  // on network error but live where reachable; the test passwords are
  // unique strings, and the check is disabled here so a sandbox network
  // quirk can never masquerade as an auth verdict. Settings are cached
  // for ~5s, so wait out the cache once.
  await db1.run("UPDATE settings SET value = '0' WHERE key = 'breached_password_check'");
  await new Promise(r => setTimeout(r, 6000));
});

test.after(async () => {
  for (const s of [server1, server2]) if (s) { try { s.kill('SIGKILL'); } catch {} }
  try { if (db1) await db1.close(); } catch {}
  for (const d of [TMP1, TMP2]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

/* ---------------- C1 ---------------- */
test('C1 pre-auth stash carries PREAUTH_TTL (~900s, not 3600s); an aged stash cannot complete login', { timeout: 60000 }, async () => {
  const { user } = await registerUser('c1@dfixa.test', PW.a);
  const secret = authLib.newTotpSecret();
  await db1.run('UPDATE users SET totp_secret = ? WHERE id = ?', [secret, user.id]);
  const { jar, page } = await passwordStash('c1@dfixa.test', PW.a);
  const rows = await preAuthRowsFor(user.id);
  assert.equal(rows.length, 1, 'exactly one pre-auth row for the user');
  const lifetime = Number(rows[0].expires_at) - Number(rows[0].created_at);
  assert.ok(lifetime > 800000 && lifetime < 1000000, 'pre-auth lifetime must be ~900,000 ms (PREAUTH_TTL), got ' + lifetime);
  // Age it past expiry: the session must be dead, not completable.
  await db1.run('UPDATE sessions SET expires_at = 1000 WHERE id = ?', [rows[0].id]);
  const attempt = await totpComplete(jar, page, secret);
  assert.notEqual(attempt.status, 302, 'an aged pre-auth session must not complete the login');
  const wallet = await jar.req('/wallet');
  assert.equal(wallet.status, 302, 'aged stash jar must not reach /wallet');
  assert.equal((await preAuthRowsFor(user.id)).length, 0, 'expired pre-auth row must be gone');
});

/* ---------------- C2 + C7 genuine flow ---------------- */
test('C2+C7 reset via the genuine flow kills the pre-auth session AND all full sessions; new password completes a fresh login', { timeout: 60000 }, async () => {
  const { user } = await registerUser('c2@dfixa.test', PW.b);
  const secret = authLib.newTotpSecret();
  await db1.run('UPDATE users SET totp_secret = ? WHERE id = ?', [secret, user.id]);
  // One FULL session (password + TOTP) ...
  const full = await passwordStash('c2@dfixa.test', PW.b);
  const fullLogin = await totpComplete(full.jar, full.page, secret);
  assert.equal(fullLogin.status, 302, 'initial full login must succeed');
  // ... and one PRE-AUTH session started before the reset.
  const pre = await passwordStash('c2@dfixa.test', PW.b);
  assert.equal((await preAuthRowsFor(user.id)).length, 1);
  // Genuine emailed-link flow: GET sets the session cookie and the form
  // carries a real CSRF token (C7's keep-it-working half).
  const token = 'dfixa-c2-reset-token-0001';
  await insertResetToken(user.id, token);
  const jarR = new Jar(BASE1);
  const get = await jarR.req('/reset/' + token);
  assert.equal(get.status, 200);
  assert.ok(jarR.cookies.get('sid'), 'GET /reset/:token must set a session cookie');
  const csrf = csrfOf(get.body);
  assert.ok(csrf, 'the reset form must carry a non-empty CSRF token');
  const post = await jarR.req('/reset/' + token, { method: 'POST', body: { _csrf: csrf, password: PW.bNew, password2: PW.bNew } });
  assert.equal(post.status, 302, 'genuine reset POST must succeed, got ' + post.status);
  assert.equal(post.loc, '/login');
  // The finder's repro, inverted: the pre-auth session is GONE, and so
  // are the user's full sessions.
  assert.equal((await preAuthRowsFor(user.id)).length, 0, 'reset must destroy the pre-auth session (D2-C2)');
  const fullRows = await db1.get('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?', [user.id]);
  assert.equal(Number(fullRows.c), 0, 'reset must destroy all full sessions too');
  const attempt = await totpComplete(pre.jar, pre.page, secret);
  assert.notEqual(attempt.status, 302, 'the killed pre-auth session must not complete the login');
  const wallet = await pre.jar.req('/wallet');
  assert.equal(wallet.status, 302, 'killed pre-auth jar must not reach /wallet');
  // A fresh full login with the NEW password works end to end. (Wait
  // for a fresh TOTP step first: the initial login consumed this one.)
  await waitNextTotpStep();
  const fresh = await passwordStash('c2@dfixa.test', PW.bNew);
  const done = await totpComplete(fresh.jar, fresh.page, secret);
  assert.equal(done.status, 302, 'fresh login with the new password + TOTP must succeed, got ' + done.status + ' ' + done.body.slice(0, 160));
  const w2 = await fresh.jar.req('/wallet');
  assert.equal(w2.status, 200);
});

/* ---------------- C7 attack half ---------------- */
test('C7 empty-jar tokenless POST /reset/:token -> 403, token unconsumed, password unchanged', { timeout: 60000 }, async () => {
  const { user } = await registerUser('c7@dfixa.test', PW.d);
  const token = 'dfixa-c7-reset-token-0001';
  await insertResetToken(user.id, token);
  // Completely empty jar, no _csrf field at all — the finder's repro.
  const res = await fetch(BASE1 + '/reset/' + token, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: PW.attack, password2: PW.attack }).toString(), redirect: 'manual' });
  assert.equal(res.status, 403, 'session-less tokenless reset POST must be refused, got ' + res.status);
  const row = await db1.get('SELECT used FROM password_resets WHERE user_id = ? AND token_hash = ?', [user.id, sha256('reset:' + token)]);
  assert.equal(Number(row.used), 0, 'the refused POST must not consume the token');
  // Password unchanged: attack password refused generically, real one logs in.
  const jarA = new Jar(BASE1);
  const gA = await jarA.req('/login');
  const bad = await jarA.req('/login', { method: 'POST', body: { _csrf: csrfOf(gA.body), email: 'c7@dfixa.test', password: PW.attack } });
  assert.match(bad.body, /Invalid credentials/, 'the attack password must not work');
  const jarB = new Jar(BASE1);
  const gB = await jarB.req('/login');
  const good = await jarB.req('/login', { method: 'POST', body: { _csrf: csrfOf(gB.body), email: 'c7@dfixa.test', password: PW.d } });
  assert.equal(good.status, 302, 'the real password must still log in, got ' + good.status);
});

/* ---------------- C4 ---------------- */
test('C4 one captcha solve = one use across requests: replayed answer mints no second reset token', { timeout: 60000 }, async () => {
  // The account is created FIRST (captcha off), then the extension is
  // enabled — registration itself is captcha-gated while it is on.
  const { user } = await registerUser('c4@dfixa.test', PW.a);
  const uid = user.id;
  await db1.run("UPDATE extensions SET enabled = 1 WHERE key = 'custom_captcha'");
  try {
    const before = await db1.get('SELECT COUNT(*) AS c FROM password_resets WHERE user_id = ?', [uid]);
    const jar = new Jar(BASE1);
    const g = await jar.req('/forgot');
    const ans = captchaAnswer(g.body);
    assert.ok(ans !== null, 'forgot page must render the captcha question while the extension is on');
    const body = { _csrf: csrfOf(g.body), email: 'c4@dfixa.test', captcha_answer: ans };
    const p1 = await jar.req('/forgot', { method: 'POST', body });
    assert.equal(p1.status, 200);
    const mid = await db1.get('SELECT COUNT(*) AS c FROM password_resets WHERE user_id = ?', [uid]);
    assert.equal(Number(mid.c), Number(before.c) + 1, 'the first (solved) POST must mint exactly one token');
    const p2 = await jar.req('/forgot', { method: 'POST', body });
    assert.equal(p2.status, 200);
    /* The handler refuses with formError 'Captcha verification failed.';
       views/forgot.ejs does not render formError (pre-existing view gap,
       flagged in the addendum), so the observable refusal here is: NOT
       the "sent" page, and — the security property itself — no token. */
    assert.ok(!/reset link is on its way/.test(p2.body), 'the replayed answer must be refused (no "sent" confirmation)');
    const after = await db1.get('SELECT COUNT(*) AS c FROM password_resets WHERE user_id = ?', [uid]);
    assert.equal(Number(after.c), Number(mid.c), 'the replay must mint NO second token (D2-C4)');
  } finally {
    await db1.run("UPDATE extensions SET enabled = 0 WHERE key = 'custom_captcha'");
  }
});

/* ---------------- C8 (U-04b re-verify) ---------------- */
test('C8 XFF chains: internal hop + spoofed prefix never become req.ip; spoofed prefix cannot mint a fresh bucket', { timeout: 90000 }, async () => {
  const ipFor = async (xff) => {
    const jar = new Jar(BASE1);
    await jar.req('/login', { headers: xff ? { 'X-Forwarded-For': xff } : {} });
    const row = await db1.get('SELECT ip FROM sessions WHERE id = ?', [jar.cookies.get('sid')]);
    return row && row.ip;
  };
  assert.equal(await ipFor('203.0.113.7, 10.26.103.5'), '203.0.113.7', 'the internal proxy hop must not be recorded as the client IP');
  assert.equal(await ipFor('1.2.3.4, 203.0.113.7, 10.26.103.5'), '203.0.113.7', 'a spoofed XFF prefix must be ignored');
  // Bucket: exhaust the login bucket for the chain-resolved IP, then a
  // NEW spoofed prefix on the same real client chain must still be 429.
  const jar = new Jar(BASE1);
  const g = await jar.req('/login', { headers: { 'X-Forwarded-For': '203.0.113.7, 10.26.103.5' } });
  const csrf = csrfOf(g.body);
  let last = 0;
  for (let i = 0; i < 31; i++) {
    const r = await jar.req('/login/otp/request', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.7, 10.26.103.5' },
      body: { _csrf: csrf, type: 'email', identifier: 'nobody@dfixa.test' } });
    last = r.status;
  }
  assert.equal(last, 429, 'the 31st request on the resolved-IP bucket must be rate-limited');
  const forged = await jar.req('/login/otp/request', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '6.6.6.6, 203.0.113.7, 10.26.103.5' },
    body: { _csrf: csrf, type: 'email', identifier: 'nobody@dfixa.test' } });
  assert.equal(forged.status, 429, 'a forged XFF prefix must NOT mint a fresh bucket (D2-C8)');
});

/* ---------------- C9 ---------------- */
test('C9 OAuth redirect_uri: BASE_URL when set (4136); absolute request-host fallback when unset (4137)', { timeout: 90000 }, async () => {
  await db1.run("UPDATE settings SET value = '1' WHERE key IN ('google_oauth_enabled', 'facebook_oauth_enabled')");
  await new Promise(r => setTimeout(r, 6000)); // settings cache
  for (const [provider, host] of [['google', 'accounts.google.com'], ['facebook', 'www.facebook.com']]) {
    const jar = new Jar(BASE1);
    const r = await jar.req('/auth/' + provider);
    assert.equal(r.status, 302);
    assert.ok(r.loc.startsWith('https://' + host), provider + ' start must redirect to the provider');
    const ru = new URL(r.loc).searchParams.get('redirect_uri');
    assert.equal(ru, BASE1 + '/auth/' + provider + '/callback', 'with BASE_URL set the redirect_uri uses it (unchanged)');
  }
  // Second boot WITHOUT BASE_URL (the test process env carries no
  // BASE_URL, and extraEnv adds none — only server1 got one).
  server2 = spawnServer(PORT2, path.join(TMP2, 'two.sqlite'), {});
  assert.ok(await waitHealthy(BASE2), 'server2 (4137, no BASE_URL) must boot');
  process.env.SQLITE_PATH = path.join(TMP2, 'two.sqlite');
  const db2 = openDB().db;
  await db2.run("UPDATE settings SET value = '1' WHERE key IN ('google_oauth_enabled', 'facebook_oauth_enabled')");
  await new Promise(r => setTimeout(r, 6000));
  for (const provider of ['google', 'facebook']) {
    const jar = new Jar(BASE2);
    const r = await jar.req('/auth/' + provider);
    assert.equal(r.status, 302, provider + ' start must redirect, got ' + r.status);
    const ru = new URL(r.loc).searchParams.get('redirect_uri');
    assert.equal(ru, BASE2 + '/auth/' + provider + '/callback', 'without BASE_URL the redirect_uri must be ABSOLUTE from the request host (D2-C9), got ' + ru);
  }
  await db2.close();
});

/* -------- C3 / C6: SPEC'd for the player/admin-file owners -------- */
test('C3 TOTP enrolment re-auth (player + admin)', { skip: 'SPEC only — routes/player.js + routes/admin.js are outside D-FIX-A files; see adj-discovery-auth.md "D-FIX-A results" SPEC D2-C3' }, () => {});
test('C6 verify-email invalidation + rate limit', { skip: 'SPEC only — routes/player.js is outside D-FIX-A files; see adj-discovery-auth.md "D-FIX-A results" SPEC D2-C6' }, () => {});
