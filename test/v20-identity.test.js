'use strict';
/* V20 U-22 — ONE identity = ONE account.
   Run: node --test test/v20-identity.test.js
   Part A (lib level, own temp DBs): normalizePhone collision proof,
   migration v20 on a fresh DB (indexes exist, '' phones stay legal,
   duplicate phone / case-variant email blocked AT THE DB, migrate
   twice = no-op), and the dirty-DB behaviour (duplicate phones
   present -> v20 is recorded in identity_migration_reports and
   SKIPPED without throwing; the boot survives).
   Part B (in-process express harness mounting the REAL routes/auth.js
   with the REAL loadSession/settings middleware contract): the OAuth
   callbacks use the global fetch() to hardcoded provider URLs — that
   global fetch is the exact seam the codebase exposes, so the test
   stubs it AT THOSE URLs (token + userinfo/graph) and delegates
   everything else. Cross-path proofs assert USERS-ROW COUNTS in the
   DB, not just status codes: form -> Google(verified) same account +
   google_id recorded; Google-first -> form refused; unverified
   Google matching an existing account -> no merge, no twin, no
   session, true-reason message; Facebook email-only match -> same
   fail-safe (Graph returns no email-verification field); in-account
   linking via a signed-in OAuth start; OTP-phone creation storing
   the canonical '+' phone so a later form registration with the
   same number is refused.
   Part C (spawned server, port 4126, recipe env): full-stack form
   register + duplicate email/phone refusals with DB assertions. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP_A = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-id-a-'));
const TMP_A2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-id-a2-'));
const TMP_B = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-id-b-'));
const TMP_C = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-id-c-'));

process.env.DB_DRIVER = 'sqlite';
delete process.env.DATABASE_URL;

const { openDB } = require('../lib/db');
const { migrate } = require('../lib/migrations');
const { normalizePhone, normalizeEmail, now, hashPassword } = require('../lib/util');
const otpLib = require('../lib/otp');

/* ---------------- Part A: lib level ---------------- */

process.env.SQLITE_PATH = path.join(TMP_A, 'a.sqlite');
const dbA = openDB().db;

test.before(async () => { await migrate(dbA, 'sqlite'); });

test('A1 normalize: +/00/011 spellings collide; bare digits do NOT gain a +', () => {
  assert.equal(normalizePhone('+1 555-111-2222'), '+15551112222');
  assert.equal(normalizePhone('0015551112222'), '+15551112222');
  assert.equal(normalizePhone('01115551112222'), '+15551112222');
  assert.equal(normalizePhone('+44 07700 900123'), '+447700900123');
  // This asymmetry is exactly why creation paths must canonicalize /
  // variant-match — adjudicated in adj-identity.md.
  assert.equal(normalizePhone('15551112222'), '15551112222');
  assert.equal(normalizeEmail('  Foo@Bar.COM '), 'foo@bar.com');
});

test('A2 migration v20 fresh: indexes exist, empty phones legal, DB blocks dup phone + case-variant email, migrate twice ok', async () => {
  const v = await dbA.get('SELECT MAX(version) AS v FROM migrations_applied');
  assert.ok(Number(v.v) >= 20, 'migration v20 must be recorded, got ' + v.v);
  const idx = await dbA.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_users_email_lower_uq','idx_users_phone_uq','idx_users_google_uq','idx_users_facebook_uq')");
  assert.equal(idx.length, 4, 'all four v20 identity indexes must exist: ' + JSON.stringify(idx));
  // '' phones are legitimate (OAuth/staff accounts) and must stay legal.
  await dbA.run("INSERT INTO users (email, phone, name, created_at) VALUES ('a2-one@id.test', '', 'One', ?)", [now()]);
  await dbA.run("INSERT INTO users (email, phone, name, created_at) VALUES ('a2-two@id.test', '', 'Two', ?)", [now()]);
  // Duplicate non-empty phone is refused by the DB itself.
  await dbA.run("INSERT INTO users (email, phone, name, created_at) VALUES ('a2-three@id.test', '+15550001111', 'Three', ?)", [now()]);
  await assert.rejects(
    dbA.run("INSERT INTO users (email, phone, name, created_at) VALUES ('a2-four@id.test', '+15550001111', 'Four', ?)", [now()]),
    /UNIQUE/i, 'second account with the same phone must fail at the DB');
  // Case-variant email twin is refused by the LOWER(email) index even
  // though the raw v1 UNIQUE is case-sensitive on sqlite.
  await assert.rejects(
    dbA.run("INSERT INTO users (email, phone, name, created_at) VALUES ('A2-One@id.test', '', 'CaseTwin', ?)", [now()]),
    /UNIQUE/i, 'case-variant email must fail at the DB');
  const c = await dbA.get('SELECT COUNT(*) AS c FROM users');
  assert.equal(Number(c.c), 3, 'only the three legal rows may exist');
  await migrate(dbA, 'sqlite'); // re-run: no-op, must not throw
});

test('A3 migration v20 dirty DB: duplicates -> recorded + skipped, migrate resolves (no boot crash)', async () => {
  process.env.SQLITE_PATH = path.join(TMP_A2, 'a2.sqlite');
  const db = openDB().db;
  await migrate(db, 'sqlite');
  // Simulate a production DB that already holds duplicate phones:
  // drop the backstop, insert the twin, un-record v20, re-run migrate.
  await db.execScript('DROP INDEX idx_users_phone_uq');
  await db.run("INSERT INTO users (email, phone, name, created_at) VALUES ('dirty1@id.test', '+15559998888', 'D1', ?)", [now()]);
  await db.run("INSERT INTO users (email, phone, name, created_at) VALUES ('dirty2@id.test', '+15559998888', 'D2', ?)", [now()]);
  await db.run('DELETE FROM migrations_applied WHERE version = 20');
  await migrate(db, 'sqlite'); // MUST resolve — a throw here fails the test
  const rep = await db.query('SELECT * FROM identity_migration_reports WHERE version = 20');
  assert.equal(rep.length, 1, 'exactly one report row for the duplicate phone group');
  assert.equal(rep[0].field, 'phone');
  assert.equal(rep[0].dup_value, '+15559998888');
  assert.equal(Number(rep[0].dup_count), 2);
  const rec = await db.get('SELECT version FROM migrations_applied WHERE version = 20');
  assert.equal(rec, undefined, 'v20 must stay UNRECORDED while duplicates exist (retried next boot)');
  const users = await db.get('SELECT COUNT(*) AS c FROM users');
  assert.equal(Number(users.c), 2, 'the pre-existing rows are untouched (no destructive dedupe)');
  await db.close();
});

/* ---------------- Part B: OAuth + OTP harness (real router) ---------------- */

process.env.SQLITE_PATH = path.join(TMP_B, 'b.sqlite');
const dbB = openDB().db;
process.env.GOOGLE_CLIENT_ID = 'g-test-client';
process.env.GOOGLE_CLIENT_SECRET = 'g-test-secret';
process.env.FACEBOOK_APP_ID = 'fb-test-app';
process.env.FACEBOOK_APP_SECRET = 'fb-test-secret';
process.env.BASE_URL = 'http://localhost';

const googleProfiles = {
  'code-form': { id: 'g-123', email: 'FormFirst@ID.test', verified_email: true, name: 'Form First' },
  'code-unver': { id: 'g-666', email: 'second@id.test', verified_email: false, name: 'Second' },
  'code-noflag': { id: 'g-667', email: 'second@id.test', name: 'Second' }, // verified_email ABSENT = unverified
  'code-new': { id: 'g-999', email: 'googlefirst@id.test', verified_email: true, name: 'Google First' },
  'code-link': { id: 'g-link-1', email: 'linker-google@id.test', verified_email: true, name: 'Linker G' },
};
const fbProfiles = {
  'code-fbmatch': { id: 'fb-777', email: 'formfirst@id.test', name: 'Form First' },
  'code-fbnew': { id: 'fb-888', email: 'fbfirst@id.test', name: 'Fb First' },
};

const realFetch = global.fetch;
function stubProviderFetch() {
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const jsonRes = (obj) => ({ json: async () => obj, ok: true, status: 200 });
    if (u.includes('oauth2.googleapis.com/token')) {
      const code = new URLSearchParams(String(opts.body || '')).get('code');
      return jsonRes({ access_token: 'tok:' + code });
    }
    if (u.includes('googleapis.com/oauth2/v2/userinfo')) {
      const code = String((opts.headers && opts.headers.Authorization) || '').replace('Bearer tok:', '');
      return jsonRes(googleProfiles[code] || {});
    }
    if (u.includes('graph.facebook.com/v18.0/oauth/access_token')) {
      const code = new URL(u).searchParams.get('code');
      return jsonRes({ access_token: 'fbtok:' + code });
    }
    if (u.includes('graph.facebook.com/me')) {
      const code = new URL(u).searchParams.get('access_token').replace('fbtok:', '');
      return jsonRes(fbProfiles[code] || {});
    }
    return realFetch(url, opts);
  };
}

let harnessServer = null, BASE_B = '';
class Jar {
  constructor(base) { this.cookies = new Map(); this.base = base; }
  async req(p, { method = 'GET', body } = {}) {
    const headers = { 'User-Agent': 'v20-identity-test' };
    if (this.cookies.size) headers.Cookie = [...this.cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
    let payload;
    if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    const res = await fetch(this.base + p, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const pair = c.split(';')[0]; const i = pair.indexOf('=');
      if (i > 0) { const k = pair.slice(0, i).trim(); const v = pair.slice(i + 1).trim(); if (v) this.cookies.set(k, v); else this.cookies.delete(k); }
    }
    return { status: res.status, loc: res.headers.get('location') || '', body: await res.text() };
  }
}
async function usersCount(db) { const r = await db.get('SELECT COUNT(*) AS c FROM users'); return Number(r.c); }
async function oauthDance(jar, provider, code) {
  const start = await jar.req('/auth/' + provider);
  assert.equal(start.status, 302, provider + ' start must redirect, got ' + start.status);
  const state = new URL(start.loc).searchParams.get('state');
  assert.ok(state, 'start redirect must carry a state');
  return jar.req(`/auth/${provider}/callback?code=${encodeURIComponent(code)}&state=${state}`);
}

test.before(async () => {
  await migrate(dbB, 'sqlite');
  await dbB.run("UPDATE settings SET value = '1' WHERE key IN ('google_oauth_enabled', 'facebook_oauth_enabled')");
  await dbB.run("UPDATE settings SET value = '0' WHERE key = 'breached_password_check'");
  require('../lib/settings').invalidate();
  stubProviderFetch();

  const express = require('express');
  const { loadSession, touchSession } = require('../lib/auth');
  const { getSettings, getCurrencies } = require('../lib/settings');
  const { fmtMoney } = require('../lib/util');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(ROOT, 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, res, next) => {
    req.cookies = {};
    const h = req.headers.cookie;
    if (h) for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0) req.cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
    next();
  });
  app.use(loadSession(dbB));
  app.use(async (req, res, next) => {
    try {
      req.db = dbB; req.driver = 'sqlite';
      req.settings = await getSettings(dbB, 'sqlite', true);
      req.adminPath = '/ops-7f3a9c-console';
      req.currencies = getCurrencies(req.settings);
      req.cur = 'USD';
      req.fmt = (m, c) => fmtMoney(m, c || 'USD', req.currencies);
      req.csrfToken = (req.sessionData && req.sessionData._csrf) || '';
      req.setFlash = async (type, msg) => { if (req.sess) await touchSession(dbB, req.sess.id, { _flash: { type, msg } }); };
      res.locals = {
        S: (k, fb = '') => (req.settings[k] !== undefined ? req.settings[k] : fb),
        fmt: req.fmt, sym: () => '$', cur: 'USD', user: req.user, isAgent: false,
        impersonating: false, impersonatorName: '', flash: { error: '', success: '' },
        currencies: req.currencies, wallets: [], walletBal: () => 0, content: () => '',
        extOn: () => false, extCfg: () => ({}), footerPages: [], siteName: 'Cash Pop Lottery',
        metaTitle: '', metaDesc: '', currentPath: req.path, adminPath: req.adminPath,
        cspNonce: '', captchaHtml: '', recaptchaHtml: '', googleOn: true, csrf: req.csrfToken || '',
      };
      next();
    } catch (e) { next(e); }
  });
  app.use('/', require('../routes/auth'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => { res.status(500).send('HARNESS-500: ' + err.message); });
  await new Promise((resolve) => { harnessServer = app.listen(0, '127.0.0.1', resolve); });
  BASE_B = 'http://127.0.0.1:' + harnessServer.address().port;
});

test.after(async () => {
  global.fetch = realFetch;
  if (harnessServer) await new Promise(r => harnessServer.close(r));
  try { await dbA.close(); } catch {}
  try { await dbB.close(); } catch {}
});

test('B1 form register creates the original account', async () => {
  const jar = new Jar(BASE_B);
  await jar.req('/register');
  const post = await jar.req('/register', { method: 'POST', body: {
    name: 'Form First', email: 'formfirst@id.test', phone: '+15551112222', phone_cc: '+1', phone_local: '5551112222',
    password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(post.status, 302, 'register must redirect (logged in), got ' + post.status + ' ' + post.body.slice(0, 200));
  assert.equal(await usersCount(dbB), 1);
  const u = await dbB.get("SELECT * FROM users WHERE email = 'formfirst@id.test'");
  assert.ok(u); assert.equal(u.phone, '+15551112222'); assert.equal(u.google_id || '', '');
});

test('B2 Google VERIFIED email matching the form account lands on THAT account + records google_id (users stays 1)', async () => {
  const before = await dbB.get("SELECT * FROM users WHERE email = 'formfirst@id.test'");
  const jar = new Jar(BASE_B);
  const cb = await oauthDance(jar, 'google', 'code-form');
  assert.equal(cb.status, 302, 'verified Google callback must log in, got ' + cb.status + ' ' + cb.body.slice(0, 200));
  assert.equal(await usersCount(dbB), 1, 'no twin may be created');
  const after = await dbB.get("SELECT * FROM users WHERE email = 'formfirst@id.test'");
  assert.equal(after.id, before.id, 'same account row');
  assert.equal(after.google_id, 'g-123', 'provider link must be recorded on the existing account');
  assert.equal(Number(after.email_verified), 1, 'Google-verified email marks the contact verified');
  const sess = await dbB.get('SELECT * FROM sessions WHERE id = ?', [jar.cookies.get('sid')]);
  assert.ok(sess, 'a login session must exist');
  assert.equal(Number(sess.user_id), Number(before.id), 'session must belong to the ORIGINAL account');
});

test('B3 Google UNVERIFIED email matching an existing account: no merge, no twin, no session, true-reason message (explicit false AND absent flag)', async () => {
  const jar0 = new Jar(BASE_B);
  await jar0.req('/register');
  const post = await jar0.req('/register', { method: 'POST', body: {
    name: 'Second User', email: 'second@id.test', phone: '', password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(post.status, 302);
  assert.equal(await usersCount(dbB), 2);
  for (const code of ['code-unver', 'code-noflag']) {
    const jar = new Jar(BASE_B);
    const cb = await oauthDance(jar, 'google', code);
    assert.equal(cb.status, 400, code + ': unverified callback must be refused, got ' + cb.status);
    assert.match(cb.body, /did not verify this email/i, code + ': body must state the true reason');
    assert.match(cb.body, /link Google from inside your account/i, code + ': body must point to sign-in + in-account linking');
    assert.equal(await usersCount(dbB), 2, code + ': no twin');
    const u = await dbB.get("SELECT * FROM users WHERE email = 'second@id.test'");
    assert.equal(u.google_id || '', '', code + ': no provider link may be recorded');
    const sess = await dbB.get('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?', [u.id]);
    // jar0's register session exists (1); the OAuth attempt must add none.
    assert.equal(Number(sess.c), 1, code + ': no new session on the existing account');
  }
});

test('B4 Google-first creates ONE account (google_id from birth); a later FORM register with the same email is refused (users stays)', async () => {
  const jar = new Jar(BASE_B);
  const cb = await oauthDance(jar, 'google', 'code-new');
  assert.equal(cb.status, 302, 'verified Google signup must log in, got ' + cb.status + ' ' + cb.body.slice(0, 200));
  assert.equal(await usersCount(dbB), 3);
  const g = await dbB.get("SELECT * FROM users WHERE email = 'googlefirst@id.test'");
  assert.ok(g); assert.equal(g.google_id, 'g-999'); assert.equal(Number(g.email_verified), 1);
  // Reverse direction: form register with the OAuth account's email.
  const jar2 = new Jar(BASE_B);
  await jar2.req('/register');
  const post = await jar2.req('/register', { method: 'POST', body: {
    name: 'Twin Attempt', email: 'GoogleFirst@ID.test', phone: '', password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(post.status, 200, 'duplicate form register re-renders the form');
  assert.match(post.body, /already exists\. Please sign in instead/i);
  assert.equal(await usersCount(dbB), 3, 'the form must not create a twin of the OAuth account');
});

test('B5 Facebook email-only match is UNVERIFIED (Graph returns no verification field): no merge, no twin, no link, true-reason message', async () => {
  const jar = new Jar(BASE_B);
  const cb = await oauthDance(jar, 'facebook', 'code-fbmatch');
  assert.equal(cb.status, 400, 'Facebook email-match must fail safe, got ' + cb.status + ' ' + cb.body.slice(0, 200));
  assert.match(cb.body, /did not verify this email/i);
  assert.match(cb.body, /link Facebook from inside your account/i);
  assert.equal(await usersCount(dbB), 3, 'no twin');
  const u = await dbB.get("SELECT * FROM users WHERE email = 'formfirst@id.test'");
  assert.equal(u.facebook_id || '', '', 'no facebook link may be recorded by an unverified email match');
});

test('B6 Facebook-first creates one account with facebook_id; the same Facebook sign-in again lands on it (id match, users stays)', async () => {
  const jar = new Jar(BASE_B);
  const cb = await oauthDance(jar, 'facebook', 'code-fbnew');
  assert.equal(cb.status, 302, 'new Facebook signup must log in, got ' + cb.status + ' ' + cb.body.slice(0, 200));
  assert.equal(await usersCount(dbB), 4);
  const f = await dbB.get("SELECT * FROM users WHERE email = 'fbfirst@id.test'");
  assert.ok(f); assert.equal(f.facebook_id, 'fb-888');
  const jar2 = new Jar(BASE_B);
  const cb2 = await oauthDance(jar2, 'facebook', 'code-fbnew');
  assert.equal(cb2.status, 302, 'returning facebook_id sign-in must log in');
  assert.equal(await usersCount(dbB), 4, 'id-matched sign-in must not twin');
  const sess = await dbB.get('SELECT * FROM sessions WHERE id = ?', [jar2.cookies.get('sid')]);
  assert.equal(Number(sess.user_id), Number(f.id));
});

test('B7 in-account linking: a signed-in user linking Google records google_id on THEIR account; linking a provider already owned by another account is refused', async () => {
  const jar = new Jar(BASE_B);
  await jar.req('/register');
  const post = await jar.req('/register', { method: 'POST', body: {
    name: 'Linker User', email: 'linker@id.test', phone: '', password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(post.status, 302);
  assert.equal(await usersCount(dbB), 5);
  // Same jar (still signed in) starts Google OAuth = linking intent.
  // The Google profile email DIFFERS from the account email — linking is
  // by provider possession + signed-in intent, not by email match.
  const cb = await oauthDance(jar, 'google', 'code-link');
  assert.equal(cb.status, 302, 'linking callback must complete, got ' + cb.status + ' ' + cb.body.slice(0, 200));
  assert.equal(await usersCount(dbB), 5, 'linking must not create or switch accounts');
  const linker = await dbB.get("SELECT * FROM users WHERE email = 'linker@id.test'");
  assert.equal(linker.google_id, 'g-link-1', 'provider link recorded on the signed-in account');
  const sess = await dbB.get('SELECT * FROM sessions WHERE id = ?', [jar.cookies.get('sid')]);
  assert.equal(Number(sess.user_id), Number(linker.id), 'session stays on the linking user');

  // Conflict: another signed-in user tries to link the google_id that
  // already belongs to googlefirst@id.test (g-999).
  const jar2 = new Jar(BASE_B);
  await jar2.req('/register');
  const post2 = await jar2.req('/register', { method: 'POST', body: {
    name: 'Linker Two', email: 'linker2@id.test', phone: '', password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(post2.status, 302);
  assert.equal(await usersCount(dbB), 6);
  const cb2 = await oauthDance(jar2, 'google', 'code-new');
  assert.equal(cb2.status, 400, 'linking an already-owned provider must be refused, got ' + cb2.status);
  assert.match(cb2.body, /already linked to a different account/i);
  const l2 = await dbB.get("SELECT * FROM users WHERE email = 'linker2@id.test'");
  assert.equal(l2.google_id || '', '', 'no link may be recorded on refusal');
  assert.equal(await usersCount(dbB), 6);
});

test('B8 OTP phone path: creation stores the canonical + phone; form register with the same number (and a +/bare OTP re-login) cannot twin', async () => {
  // Seed a real login OTP at the lib seam (code known to the test only),
  // then verify through the REAL route with the BARE digit spelling.
  const code = await otpLib.createOtp(dbB, '15553334444', 'phone');
  const jar = new Jar(BASE_B);
  const res = await fetch(BASE_B + '/login/otp/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'phone', identifier: '15553334444', code }),
  });
  const j = await res.json();
  assert.equal(res.status, 200, 'OTP verify must succeed: ' + JSON.stringify(j));
  assert.equal(j.needsProfile, true, 'first OTP login is a new account');
  assert.equal(await usersCount(dbB), 7);
  const otpUser = await dbB.get("SELECT * FROM users WHERE email = 'phone15553334444@phone.local'");
  assert.ok(otpUser, 'OTP account must exist');
  assert.equal(otpUser.phone, '+15553334444', 'phone must be stored in the canonical + form (the pre-fix bug stored the bare form)');

  // Form register with the same number, different email -> refused.
  const jar2 = new Jar(BASE_B);
  await jar2.req('/register');
  const post = await jar2.req('/register', { method: 'POST', body: {
    name: 'Phone Twin', email: 'phonetwin@id.test', phone: '+15553334444', phone_cc: '+1', phone_local: '5553334444',
    password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(post.status, 200);
  assert.match(post.body, /phone number already exists\. Please sign in instead/i);
  assert.equal(await usersCount(dbB), 7, 'form must not twin the OTP account');

  // Reverse spelling: OTP verify with the '+' form finds the same user.
  const code2 = await otpLib.createOtp(dbB, '+15553334444', 'phone');
  const res2 = await fetch(BASE_B + '/login/otp/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'manual',
    body: JSON.stringify({ type: 'phone', identifier: '+15553334444', code: code2 }),
  });
  assert.equal(res2.status, 302, 'returning OTP user must finishLogin (redirect), got ' + res2.status);
  assert.equal(await usersCount(dbB), 7, 'OTP re-login must not twin either');
});

/* ---------------- Part C: spawned server (port 4126, recipe env) ---------------- */

const PORT_C = 4126;
const BASE_C = 'http://localhost:' + PORT_C;
let serverC = null, dbC = null;
function csrfOf(html) { const m = String(html).match(/name="_csrf" value="([^"]+)"/); return m && m[1]; }
async function waitHealthyC(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE_C + '/healthz'); if (r.status === 200) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

test.before(async () => {
  const env = { ...process.env,
    PORT: String(PORT_C), BASE_URL: BASE_C, DB_DRIVER: 'sqlite',
    SQLITE_PATH: path.join(TMP_C, 'c.sqlite'),
    TICKET_HMAC_SECRET: 'v20-identity-e2e-secret-0123456789abcdef0123456789abcdef',
    ADMIN_SEED_EMAIL: 'admin@id.test', ADMIN_SEED_PASSWORD: 'V20Admin#pass', ADMIN_SEED_NAME: 'ID Admin',
  };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  serverC = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverC.stderr.on('data', d => process.stderr.write('[v20-id server] ' + d));
  assert.ok(await waitHealthyC(), 'spawned server must boot (migration v20 included)');
  process.env.SQLITE_PATH = path.join(TMP_C, 'c.sqlite');
  dbC = openDB().db;
});

test.after(async () => {
  if (serverC) { try { serverC.kill('SIGKILL'); } catch {} }
  try { if (dbC) await dbC.close(); } catch {}
  for (const d of [TMP_A, TMP_A2, TMP_B, TMP_C]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
});

test('C1 spawned boot: migration v20 recorded + indexes present in the live DB', async () => {
  const v = await dbC.get('SELECT version FROM migrations_applied WHERE version = 20');
  assert.ok(v, 'v20 must be applied on a fresh boot');
  const idx = await dbC.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_users_phone_uq'");
  assert.equal(idx.length, 1);
});

test('C2 full-stack form register, then duplicate email AND duplicate phone refusals (DB counts stay 1)', { timeout: 60000 }, async () => {
  const jar = new Jar(BASE_C);
  let g = await jar.req('/register');
  let post = await jar.req('/register', { method: 'POST', body: {
    _csrf: csrfOf(g.body), name: 'Stack User', email: 'stack@id.test', phone: '+15557770000', phone_cc: '+1', phone_local: '5557770000',
    password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(post.status, 302, 'register must succeed, got ' + post.status + ' ' + post.body.slice(0, 200));
  const byEmail = await dbC.get("SELECT COUNT(*) AS c FROM users WHERE email = 'stack@id.test'");
  assert.equal(Number(byEmail.c), 1);

  const jar2 = new Jar(BASE_C);
  g = await jar2.req('/register');
  post = await jar2.req('/register', { method: 'POST', body: {
    _csrf: csrfOf(g.body), name: 'Stack Twin', email: 'stack@id.test', phone: '+15557770001', phone_cc: '+1', phone_local: '5557770001',
    password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(post.status, 200);
  assert.match(post.body, /already exists\. Please sign in instead/i, 'duplicate email must give the true reason + sign-in pointer');
  assert.equal(Number((await dbC.get("SELECT COUNT(*) AS c FROM users WHERE email = 'stack@id.test'")).c), 1, 'email twin must not exist');

  const jar3 = new Jar(BASE_C);
  g = await jar3.req('/register');
  post = await jar3.req('/register', { method: 'POST', body: {
    _csrf: csrfOf(g.body), name: 'Phone Twin', email: 'other@id.test', phone: '+15557770000', phone_cc: '+1', phone_local: '5557770000',
    password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(post.status, 200);
  assert.match(post.body, /phone number already exists\. Please sign in instead/i, 'duplicate phone must give the true reason + sign-in pointer');
  assert.equal(Number((await dbC.get("SELECT COUNT(*) AS c FROM users WHERE phone = '+15557770000'")).c), 1, 'phone twin must not exist');
  assert.equal(Number((await dbC.get("SELECT COUNT(*) AS c FROM users WHERE email = 'other@id.test'")).c), 0, 'the refused registration must create no row at all');
});
