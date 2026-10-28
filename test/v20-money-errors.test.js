'use strict';
/* V20 OWNER-FIX tests — U-02 (true-reason money errors, inline),
   U-04(a) (human session data / parseUA), U-15/U-16 (profile locals),
   U-04(b) (stable half: a single X-Forwarded-For hop is stored as the
   client IP under both the current and the proposed trust-proxy
   setting; the multi-hop chain case is adjudicated in
   audits/owner-fix-round/adj-backend.md — its fix is a one-line
   server.js change owned by the coordinator).
   Run: node --test test/v20-money-errors.test.js
   Part A: parseUA unit contract (lib level, no server).
   Part B: spawned server on port 4122 (recipe env), fresh SQLite. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

/* ---------------- Part A: parseUA (U-04a) ---------------- */
const { parseUA } = require('../lib/auth');

test('U-04a parseUA: legacy {browser, os} contract is unchanged', () => {
  const win = parseUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  assert.equal(win.browser, 'Chrome');
  assert.equal(win.os, 'Windows');
  const mac = parseUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15');
  assert.equal(mac.browser, 'Safari');
  assert.equal(mac.os, 'macOS');
});

test('U-04a parseUA: real-world mobile browsers + device field', () => {
  const crios = parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1');
  assert.deepEqual(crios, { browser: 'Chrome', os: 'iOS', device: 'iPhone' }, 'iOS Chrome is CriOS, not Safari');
  const fxios = parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/121.0 Mobile/15E148 Safari/605.1.15');
  assert.deepEqual(fxios, { browser: 'Firefox', os: 'iOS', device: 'iPhone' });
  const samsung = parseUA('Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36');
  assert.deepEqual(samsung, { browser: 'Samsung Internet', os: 'Android', device: 'Android' });
  const edgWin = parseUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0');
  assert.deepEqual(edgWin, { browser: 'Edge', os: 'Windows', device: 'Windows' });
  const edgIos = parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) EdgiOS/120.0 Mobile/15E148 Safari/605.1.15');
  assert.equal(edgIos.browser, 'Edge');
  assert.equal(edgIos.device, 'iPhone');
  const ipad = parseUA('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  assert.deepEqual(ipad, { browser: 'Safari', os: 'iOS', device: 'iPad' });
  const ipadDesktopUa = parseUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1');
  assert.equal(ipadDesktopUa.device, 'iPad', 'iPadOS desktop-style UA (Macintosh + Mobile/) is an iPad');
  const fxLinux = parseUA('Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0');
  assert.deepEqual(fxLinux, { browser: 'Firefox', os: 'Linux', device: 'Linux' });
  const unknown = parseUA('AdjTest/1.0');
  assert.equal(unknown.browser, 'Unknown');
  assert.equal(unknown.device, 'Unknown device');
  assert.equal(parseUA('').device, 'Unknown device');
});

/* ---------------- Part B: spawned server ---------------- */
const PORT = 4122;
const BASE = 'http://localhost:' + PORT;
const TMP_B = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-v20m-'));
let server = null;
let dbB = null;

class Jar {
  constructor(ua, xff) { this.cookies = new Map(); this.ua = ua || 'v20-money-test'; this.xff = xff; }
  async req(p, { method = 'GET', body } = {}) {
    const headers = { 'User-Agent': this.ua };
    if (this.xff) headers['X-Forwarded-For'] = this.xff;
    if (this.cookies.size) headers.Cookie = [...this.cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
    let payload;
    if (body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (Array.isArray(v)) for (const item of v) params.append(k, String(item));
        else params.append(k, String(v));
      }
      payload = params.toString();
    }
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

const CRIOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.6099.119 Mobile/15E148 Safari/604.1';
let broke, brokeId;

test.before(async () => {
  const env = { ...process.env,
    PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite',
    SQLITE_PATH: path.join(TMP_B, 'b.sqlite'),
    TICKET_HMAC_SECRET: 'v20-money-test-secret-0123456789abcdef',
    ADMIN_SEED_EMAIL: 'admin@v20m.test', ADMIN_SEED_PASSWORD: 'V20Admin#pass', ADMIN_SEED_NAME: 'V20 Admin',
  };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[v20m server] ' + d));
  assert.ok(await waitHealthy(), 'server must boot and answer /healthz');
  process.env.SQLITE_PATH = path.join(TMP_B, 'b.sqlite');
  process.env.DB_DRIVER = 'sqlite';
  dbB = require('../lib/db').openDB().db;
  // a guaranteed upcoming DAY draw (fresh boots seed some already; if
  // not, insert one exactly as the other suites do)
  const { now } = require('../lib/util');
  const c = await dbB.get("SELECT COUNT(*) AS c FROM draws WHERE draw_type = 'DAY' AND status = 'scheduled' AND close_at > ?", [now()]);
  if (!Number(c.c)) await dbB.run("INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, is_test, created_at) VALUES ('DAY', '2099-01-01', ?, 'scheduled', 'h', 's', 0, ?)", [now() + 3600000, now()]);
  broke = new Jar(CRIOS_UA);
  await register(broke, 'Broke Player', 'broke@v20m.test');
  brokeId = (await dbB.get("SELECT id FROM users WHERE email = 'broke@v20m.test'")).id;
});
test.after(async () => {
  if (server) server.kill('SIGKILL');
  try { if (dbB) await dbB.close(); } catch {}
  fs.rmSync(TMP_B, { recursive: true, force: true });
});

test('U-02: empty-wallet lottery buy returns the playslip with the true balance reason + amounts', { timeout: 60000 }, async () => {
  const g = await broke.text('/play');
  assert.equal(g.status, 200);
  const post = await broke.text('/play/buy', { method: 'POST', body: {
    _csrf: csrfOf(g.body), pops: ['3', '7'], wager: '100', draw_type: 'DAY', num_draws: '1', currency: 'USD' } });
  assert.equal(post.status, 400, 'rejection keeps the standing 400 contract');
  assert.match(post.body, /Build Your Slip/, 'the response IS the playslip, not a bare error page');
  assert.match(post.body, /Not enough balance: this ticket costs \$2\.00, but your USD wallet has \$0\.00/, 'reason names cost and balance');
  assert.match(post.body, /you are \$2\.00 short/, 'reason names the shortfall');
  assert.doesNotMatch(post.body, /Purchase failed/, 'generic message is gone');
  // the slip local carries the selections server-side for the view to
  // restore: the posted pops/wager are echoed in the re-render contract
  // via the view model (balance shown is the attempted wallet's $0.00)
  assert.match(post.body, /Wallet balance: \$0\.00/, 'slip shows the attempted wallet');
  const t = await dbB.get('SELECT COUNT(*) AS c FROM tickets WHERE user_id = ?', [brokeId]);
  assert.equal(Number(t.c), 0, 'no ticket was created');
  const w = await dbB.get('SELECT COALESCE(SUM(balance),0) AS s FROM wallets WHERE user_id = ?', [brokeId]);
  assert.equal(Number(w.s), 0, 'no money moved');
});

test('U-02: invalid wager returns the playslip with its true reason (400)', { timeout: 60000 }, async () => {
  const g = await broke.text('/play');
  const post = await broke.text('/play/buy', { method: 'POST', body: {
    _csrf: csrfOf(g.body), pops: '5', wager: '7', draw_type: 'DAY', num_draws: '1' } });
  assert.equal(post.status, 400);
  assert.match(post.body, /Build Your Slip/);
  assert.match(post.body, /That wager is not available/);
});

test('U-02: a funded buy still succeeds exactly as before', { timeout: 60000 }, async () => {
  await dbB.run("INSERT INTO wallets (user_id, currency, balance) VALUES (?, 'USD', 1000)", [brokeId]);
  const g = await broke.text('/play');
  const post = await broke.text('/play/buy', { method: 'POST', body: {
    _csrf: csrfOf(g.body), pops: '5', wager: '100', draw_type: 'DAY', num_draws: '1', currency: 'USD' } });
  assert.equal(post.status, 302, 'success still redirects to the ticket');
  assert.match(post.loc, /^\/ticket\//);
  const w = await dbB.get('SELECT balance FROM wallets WHERE user_id = ?', [brokeId]);
  assert.equal(Number(w.balance), 900, 'debited exactly the $1.00 ticket');
});

test('U-02: empty-wallet scratch buy returns the series page with the true balance reason + amounts', { timeout: 60000 }, async () => {
  const jar = new Jar('v20-money-test');
  await register(jar, 'Scratch Broke', 'sbroke@v20m.test');
  const series = await dbB.get("SELECT id, slug FROM scratch_series WHERE slug = 'gold-rush'");
  assert.ok(series, 'Gold Rush live on fresh boot');
  const g = await jar.text('/scratch/' + series.slug);
  const post = await jar.text('/scratch/' + series.id + '/buy', { method: 'POST', body: { _csrf: csrfOf(g.body) } });
  assert.equal(post.status, 400);
  assert.match(post.body, /Gold Rush/, 'the response is the series page, not a bare error page');
  assert.match(post.body, /Not enough balance: this card costs \$1\.00, but your USD wallet has \$0\.00/);
  assert.match(post.body, /you are \$1\.00 short/);
  assert.doesNotMatch(post.body, /Scratch purchase failed/);
  const u = await dbB.get("SELECT id FROM users WHERE email = 'sbroke@v20m.test'");
  const t = await dbB.get('SELECT COUNT(*) AS c FROM scratch_tickets WHERE user_id = ?', [u.id]);
  assert.equal(Number(t.c), 0, 'no scratch ticket was created');
});

test('U-02: deposit/withdraw submissions return to the form with the true reason', { timeout: 60000 }, async () => {
  await dbB.run("UPDATE users SET email_verified = 1 WHERE email = 'broke@v20m.test'");
  // CSRF token is session-wide; take it from /profile (the no-methods
  // deposit/withdraw pages render no form, hence no token field).
  let g = await broke.text('/profile');
  let post = await broke.text('/deposit/new', { method: 'POST', body: { _csrf: csrfOf(g.body), method_id: '999', amount: '10.00' } });
  assert.equal(post.status, 302, 'failed deposit redirects back, got ' + post.status);
  assert.ok(post.loc.startsWith('/deposit/new'), 'back to the deposit form: ' + post.loc);
  g = await broke.text(post.loc);
  assert.match(g.body, /That deposit method is not available/, 'true reason shown on the form');
  g = await broke.text('/profile');
  post = await broke.text('/withdraw/new', { method: 'POST', body: { _csrf: csrfOf(g.body), method_id: '999', amount: '10.00' } });
  assert.equal(post.status, 302);
  assert.ok(post.loc.startsWith('/withdraw/new'), 'back to the withdraw form: ' + post.loc);
  g = await broke.text(post.loc);
  assert.match(g.body, /That withdrawal method is not available/);
});

test('U-04a: /security never receives the raw user-agent', { timeout: 60000 }, async () => {
  const g = await broke.text('/security');
  assert.equal(g.status, 200);
  assert.match(g.body, /Active sessions/);
  assert.doesNotMatch(g.body, /CriOS\/120/, 'raw UA token must not reach the page');
  assert.doesNotMatch(g.body, /Mozilla\/5\.0 \(iPhone/, 'raw UA string must not reach the page');
});

test('U-04b: a single X-Forwarded-For hop is stored as the session IP', { timeout: 60000 }, async () => {
  const jar = new Jar('v20-money-test', '203.0.113.7');
  const g = await jar.text('/login');
  const post = await jar.text('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email: 'broke@v20m.test', password: 'Player#pass1' } });
  assert.equal(post.status, 302);
  const s = await dbB.get('SELECT ip FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [brokeId]);
  assert.equal(s.ip, '203.0.113.7');
});

test('U-15/U-16: profile carries the absolute referral URL (BASE_URL pattern)', { timeout: 60000 }, async () => {
  const me = await dbB.get("SELECT referral_code FROM users WHERE email = 'broke@v20m.test'");
  assert.ok(me.referral_code, 'registered player has a referral code');
  const g = await broke.text('/profile');
  assert.equal(g.status, 200);
  assert.ok(g.body.includes(BASE + '/register?ref=' + me.referral_code),
    'referral link renders absolute: ' + BASE + '/register?ref=' + me.referral_code);
  assert.doesNotMatch(g.body, /<span class="code" id="refLink">\/register\?ref=/, 'no relative referral link remains');
});
