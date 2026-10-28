'use strict';
/* V20 OWNER-FIX tests — ACCOUNT worker: U-01 (no HTML/entities as visible
   text on profile/wallet), U-14 (profile accordion), U-15 (verified
   badge off the profileVerified local), U-16 (referral URL + Copy),
   U-17 (notification switches, same POST contract), U-04c (session cards,
   human fields only — no raw UA), U-18 (reply lock note in the view),
   U-25 (Delete action on the player's own support tickets).
   Run: node --test test/v20-account.test.js
   Spawned server on port 4127, fresh SQLite in a temp dir. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 4127;
const BASE = 'http://localhost:' + PORT;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-v20a-'));
const DB_PATH = path.join(TMP, 'account.sqlite');
let server = null;
let db = null;

class Jar {
  constructor(ua) { this.cookies = new Map(); this.ua = ua || 'v20-account-test'; }
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
async function register(jar, name, email) {
  const g = await jar.text('/register');
  const post = await jar.text('/register', { method: 'POST', body: { _csrf: csrfOf(g.body), name, email, password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(post.status, 302, 'register redirects, got ' + post.status);
}

const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
let jar, jar2;

test.before(async () => {
  const env = { ...process.env,
    PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite',
    SQLITE_PATH: DB_PATH,
    TICKET_HMAC_SECRET: 'v20-account-test-secret-0123456789abcdef',
    ADMIN_SEED_EMAIL: 'admin@v20a.test', ADMIN_SEED_PASSWORD: 'V20Admin#pass', ADMIN_SEED_NAME: 'V20 Admin',
  };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[v20a server] ' + d));
  assert.ok(await waitHealthy(), 'server must boot and answer /healthz');
  process.env.SQLITE_PATH = DB_PATH;
  process.env.DB_DRIVER = 'sqlite';
  db = require('../lib/db').openDB().db;
  jar = new Jar('v20-account-main');
  await register(jar, 'Account Player', 'player@v20a.test');
  // Second sign-in (second cookie jar, iPhone UA) so two sessions exist.
  jar2 = new Jar(IPHONE_UA);
  const g = await jar2.text('/login');
  const post = await jar2.text('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email: 'player@v20a.test', password: 'Player#pass1' } });
  assert.equal(post.status, 302, 'second login redirects, got ' + post.status);
});
test.after(async () => {
  if (server) server.kill('SIGKILL');
  try { if (db) await db.close(); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('U-01/U-15: profile renders REAL badge markup, unverified state, no escaped HTML or &nbsp; text', { timeout: 60000 }, async () => {
  const p = await jar.text('/profile');
  assert.equal(p.status, 200);
  // the contact badges are real elements, not printed markup
  assert.ok(p.body.includes('<span class="badge b-warn">not verified</span>'), 'email/phone not-verified badge renders as a real badge');
  assert.doesNotMatch(p.body, /&lt;span/, 'no escaped span markup is printed as text');
  assert.doesNotMatch(p.body, /&nbsp;/, 'no literal &nbsp; text on profile');
  // U-15 header badge, unverified state
  assert.ok(p.body.includes('<span class="badge b-warn">Profile not verified</span>'), 'header shows Profile not verified (b-warn)');
  assert.doesNotMatch(p.body, />Profile verified</, 'verified badge absent before verification');
  const w = await jar.text('/wallet');
  assert.equal(w.status, 200);
  assert.doesNotMatch(w.body, /&nbsp;/, 'wallet Balances card prints no literal &nbsp;');
  assert.doesNotMatch(w.body, /&lt;span/, 'no escaped span markup on wallet');
});

test('U-14/U-16/U-17: accordion sections collapsed, referral input + Copy, notification switches with the same names', { timeout: 60000 }, async () => {
  const p = await jar.text('/profile');
  assert.match(p.body, /class="v20-accordion /, 'accordion container present');
  const items = p.body.match(/<details class="v20-accordion-item">/g) || [];
  assert.ok(items.length >= 3, 'at least 3 collapsed accordion items (contact, notifications, referral), got ' + items.length);
  assert.doesNotMatch(p.body, /<details class="v20-accordion-item" open/, 'accordion items start collapsed');
  assert.match(p.body, /2 of 2 on/, 'notification summary counts the real toggle states (both default on)');
  // U-17: switches, identical POST contract names/values
  assert.match(p.body, /class="v20-switch-input" name="notify_win_email" value="1" checked/, 'win-email switch, same name/value, checked');
  assert.match(p.body, /class="v20-switch-input" name="notify_support_email" value="1" checked/, 'support-email switch, same name/value, checked');
  // U-16: referral input carries the absolute URL from the configured BASE_URL + a Copy button
  const m = p.body.match(/<input type="text" id="refLink" readonly value="([^"]+)"/);
  assert.ok(m, 'referral URL is in a read-only input');
  assert.ok(m[1].startsWith(BASE + '/register?ref='), 'referral URL starts with the configured BASE_URL: ' + m[1]);
  assert.match(p.body, /<button type="button" class="btn btn-sm" data-copy-target="refLink">Copy<\/button>/, 'Copy button wired to the referral input');
});

test('U-15: verified badge flips when a contact becomes verified in the DB', { timeout: 60000 }, async () => {
  await db.run("UPDATE users SET email_verified = 1 WHERE email = 'player@v20a.test'");
  const p = await jar.text('/profile');
  assert.ok(p.body.includes('<span class="badge b-ok">Profile verified</span>'), 'header shows Profile verified (b-ok)');
  assert.doesNotMatch(p.body, /Profile not verified/, 'not-verified badge gone');
  assert.ok(p.body.includes('<span class="badge b-ok">✓ verified</span>') || p.body.includes('badge b-ok">&#10003; verified'), 'email contact badge now renders verified');
});

test('U-04c: security page shows session CARDS with human device labels and NO raw user-agent anywhere', { timeout: 60000 }, async () => {
  const s = await jar2.text('/security');
  assert.equal(s.status, 200);
  const cards = s.body.match(/v20-session-card/g) || [];
  assert.ok(cards.length >= 2, 'two session cards render (two sign-ins), got ' + cards.length);
  assert.match(s.body, /iPhone/, 'deviceLabel names the device (iPhone)');
  assert.match(s.body, /Safari|Chrome/, 'deviceLabel names the browser');
  assert.doesNotMatch(s.body, /Mozilla\//, 'raw user-agent appears NOWHERE on the page');
  assert.doesNotMatch(s.body, /AppleWebKit/, 'no UA fragments leak');
  assert.match(s.body, /v20-session-card--current/, 'current session card is marked --current');
  assert.match(s.body, /v20-session-badge">This session</, 'current session badge renders');
  assert.match(s.body, /action="\/security\/sessions\/revoke"/, 'sign-out-other-sessions control preserved');
  assert.match(s.body, /Sign out all other sessions/, 'revoke button label preserved');
});

test('U-18/U-25: fresh ticket shows the lock note (no reply form); Delete present on list and detail', { timeout: 60000 }, async () => {
  const g = await jar.text('/support');
  const post = await jar.text('/support/new', { method: 'POST', body: { _csrf: csrfOf(g.body), subject: 'Account worker ticket', message: 'First player message', priority: 'medium' } });
  assert.equal(post.status, 302);
  const pub = decodeURIComponent(post.loc.split('/support/')[1]);
  assert.ok(pub && pub !== '', 'ticket created: ' + post.loc);
  const view = await jar.text('/support/' + pub);
  assert.equal(view.status, 200);
  assert.match(view.body, /You can reply again as soon as our support team has responded to your last message\./, 'lock note shows the server lockReason');
  assert.doesNotMatch(view.body, /<textarea[^>]*name="message"/, 'no reply textarea while locked');
  assert.doesNotMatch(view.body, /Send Reply/, 'no Send Reply button while locked');
  assert.ok(view.body.includes('action="/support/' + pub + '/delete"'), 'Delete form posts to the player delete endpoint (detail)');
  const list = await jar.text('/support');
  assert.ok(list.body.includes('action="/support/' + pub + '/delete"'), 'Delete form present on the own-ticket list');
  assert.match(list.body, />Delete<\/button>/, 'Delete button renders on the list');
});
