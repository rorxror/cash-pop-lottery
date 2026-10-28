'use strict';
/* V20 CHROME (owner-fix round) regression tests — U-05/U-06/U-07/U-08.
   Run: node --test test/v20-chrome.test.js
   Spawned server on its own port + temp DB (pattern of v19-features).
   Asserts RENDERED behaviour: exactly one header balance control when
   logged in (the currency pill), none logged out; the currency menu
   still offers multiple currencies; the zoom-lock viewport ships;
   flashes carry the auto-dismiss / close hooks; Cover All no longer
   ships a static check glyph claiming a state that does not exist. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-v20chrome-'));
const PORT = 4392;
const BASE = 'http://localhost:' + PORT;
let server = null;

class Jar {
  constructor(ua) { this.cookies = new Map(); this.ua = ua || 'v20-chrome-test'; }
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
function headerOf(html) { const m = String(html).match(/<header[\s\S]*?<\/header>/); return m ? m[0] : ''; }
function count(hay, needle) { return String(hay).split(needle).length - 1; }

async function waitHealthy(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.status === 200) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

let anonHome = '';
let authHome = ''; // FIRST logged-in GET / — carries the register success flash

test.before(async () => {
  const env = { ...process.env,
    PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite',
    SQLITE_PATH: path.join(TMP, 't.sqlite'),
    TICKET_HMAC_SECRET: '<redacted>',
    ADMIN_SEED_EMAIL: 'admin@v20.test', ADMIN_SEED_PASSWORD: 'V20Admin#pass', ADMIN_SEED_NAME: 'V20 Admin',
  };
  delete env.DATABASE_URL; delete env.SMTP_HOST; delete env.DATABASE_URL_PG;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[v20 server] ' + d));
  assert.ok(await waitHealthy(), 'server must boot and answer /healthz');

  const anon = new Jar();
  anonHome = (await anon.text('/')).body;

  const jar = new Jar('V20ChromePlayer/1.0');
  const g = await jar.text('/register');
  const post = await jar.text('/register', { method: 'POST', body: {
    _csrf: csrfOf(g.body), name: 'V20 Player', email: 'player@v20.test',
    phone_cc: '+1', phone_local: '5551112222', phone: '+15551112222',
    password: 'PlayerPass#1', password_confirm: 'PlayerPass#1', agree: 'on',
  } });
  assert.equal(post.status, 302, 'register redirects');
  authHome = (await jar.text('/')).body;
  test.jar = jar;
});

test.after(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch {} }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('U-07: viewport meta locks zoom on public pages (anon + logged in)', () => {
  for (const html of [anonHome, authHome]) {
    const m = html.match(/<meta name="viewport" content="([^"]+)">/);
    assert.ok(m, 'viewport meta present');
    assert.match(m[1], /maximum-scale=1/, 'maximum-scale=1 present');
    assert.match(m[1], /user-scalable=no/, 'user-scalable=no present');
  }
});

test('U-05: logged-out header shows NO balance anywhere', () => {
  const h = headerOf(anonHome);
  assert.ok(h, 'header rendered');
  assert.equal(count(h, 'class="cur-bal"'), 0, 'no currency-pill balance logged out');
  assert.equal(count(h, 'class="ubal"'), 0, 'no user-pill balance logged out');
  assert.equal(count(h, 'cur-item-bal'), 0, 'no per-currency balances in the menu logged out');
  assert.ok(!/\$\s?0\.00/.test(h), 'no formatted balance leaks into the logged-out header');
});

test('U-05: logged-in header has exactly ONE balance control; currency switch preserved', () => {
  const h = headerOf(authHome);
  assert.ok(h, 'header rendered');
  assert.equal(count(h, 'class="cur-bal"'), 1, 'exactly one visible balance (currency pill)');
  assert.equal(count(h, 'class="ubal"'), 0, 'user-menu trigger no longer duplicates the balance');
  assert.equal(count(h, 'balance-pill'), 0, 'old balance-pill trigger is gone');
  assert.equal(count(h, 'class="user-pill"'), 1, 'account menu trigger still present (name only)');
  assert.ok(count(h, 'cur-item-code') >= 2, 'currency menu still lists multiple currencies (multi-currency wallet model preserved)');
  assert.match(h, /action="\/currency"/, 'currency switch form still posts to /currency');
});

test('U-08: success flash carries auto-dismiss + close hooks, role preserved', () => {
  assert.match(authHome, /data-flash="success"/, 'success flash is marked for the dismiss logic');
  assert.match(authHome, /data-auto-dismiss="4000"/, 'success flash auto-dismisses after ~4s');
  assert.match(authHome, /data-flash-close/, 'flash carries a visible close button hook');
  assert.match(authHome, /class="flash f-ok" role="alert" data-flash="success"/, 'role="alert" semantics preserved');
});

test('U-06: Cover All ships no static check glyph and starts un-pressed', async () => {
  const jar = test.jar;
  const play = await jar.text('/play');
  assert.equal(play.status, 200);
  assert.ok(!/id="coverAll"[^>]*>&#10003;/.test(play.body), 'static ✓ glyph removed from Cover All');
  assert.match(play.body, /id="coverAll"[^>]*aria-pressed="false"/, 'Cover All starts aria-pressed=false at 0 selected');
  assert.match(play.body, /id="popCount">0<\/span> pops selected/, 'initial count is 0');
});

test('Wave-B primitives + dismiss logic are served in the static assets', async () => {
  const css = await (await fetch(BASE + '/style.css')).text();
  for (const sel of ['.v20-draw-card', '.v20-draw-ball', '.v20-draw-countdown', '.v20-draw-enter',
    '.v20-feature-grid', '.v20-feature-card', '.v20-stat-card', '.v20-stat-deco',
    '.v20-step-card', '.v20-step-num', '.v20-scratch-card', '.v20-accordion-summary',
    '.v20-session-card', '.v20-switch-input', '.v20-checkbox-input', '.flash-close', '#coverAll.is-active']) {
    assert.ok(css.includes(sel), 'style.css must define ' + sel);
  }
  const js = await (await fetch(BASE + '/app.js')).text();
  assert.match(js, /data-auto-dismiss/, 'app.js implements flash auto-dismiss');
  assert.match(js, /data-counted/, 'app.js marks primary count-up (U-09 fallback contract)');
  assert.match(js, /live-count:not\(\[data-counted\]\)/, 'app.js carries the independent count-up fallback');
});
