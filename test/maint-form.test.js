'use strict';
/* MAINT-FORM-01 (owner live report 2026-10-29): with maintenance mode
   ON, tapping a currency in the header made the browser DOWNLOAD a file
   named "currency.json" — the maintenance middleware answered every
   non-GET with JSON, and a plain HTML form POST is a top-level
   navigation, so the browser saved the JSON instead of showing the
   maintenance page. Fix: browsers (Accept: text/html) get the
   maintenance page for EVERY method; JSON stays only for API/fetch
   callers; the block itself is NOT weakened (no POST is processed). */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 4161, BASE = `http://127.0.0.1:${PORT}`, ROOT = path.join(__dirname, '..');
const AP = '/ops-7f3a9c-console';
const DBP = `/tmp/cp-maint-${process.pid}.sqlite`;
let server, db, playerId, playerCsrf;

class Jar {
  constructor() { this.m = new Map(); }
  absorb(h) { const sc = h.getSetCookie ? h.getSetCookie() : []; for (const c of sc) { const p = c.split(';')[0]; const i = p.indexOf('='); if (i > 0) { const k = p.slice(0, i).trim(), v = p.slice(i + 1).trim(); if (v) this.m.set(k, v); else this.m.delete(k); } } }
  header() { return [...this.m.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(p, { method = 'GET', body, accept } = {}) {
    const r = await fetch(BASE + p, { method, redirect: 'manual', headers: { cookie: this.header(), ...(accept ? { accept } : {}), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: body ? new URLSearchParams(body).toString() : undefined });
    this.absorb(r.headers); return { status: r.status, loc: r.headers.get('location') || '', ct: r.headers.get('content-type') || '', html: await r.text() };
  }
  csrf(html) { const m = html.match(/name="_csrf" value="([^"]+)"/); assert.ok(m, 'csrf present'); return m[1]; }
}
const admin = new Jar(), player = new Jar();
const BROWSER = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

async function setMaintenance(on) {
  await db.run("UPDATE settings SET value = ? WHERE key = 'maintenance_mode'", [on ? '1' : '0']);
  const st = await admin.req(AP + '/settings');
  await admin.req(AP + '/settings/clear-cache', { method: 'POST', body: { _csrf: admin.csrf(st.html) } });
}

before(async () => {
  const env = { ...process.env, PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite', SQLITE_PATH: DBP,
    TICKET_HMAC_SECRET: 'maint-test-' + 'x'.repeat(48),
    CREDENTIAL_ENCRYPTION_KEY: 'c6'.repeat(32),
    ADMIN_SEED_EMAIL: 'maint-admin@example.com', ADMIN_SEED_PASSWORD: 'MaintAdminPass-2026', ADMIN_SEED_NAME: 'M Admin' };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[maint server] ' + d));
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { try { const r = await fetch(BASE + '/healthz'); ok = r.status === 200; } catch {} if (!ok) await new Promise(r => setTimeout(r, 500)); }
  assert.ok(ok, 'server boots');
  process.env.SQLITE_PATH = DBP; process.env.DB_DRIVER = 'sqlite';
  db = require('../lib/db').openDB().db;
  const g = await admin.req(AP);
  await admin.req(AP + '/login', { method: 'POST', body: { _csrf: admin.csrf(g.html), email: 'maint-admin@example.com', password: 'MaintAdminPass-2026' } });
  const { hashPassword } = require('../lib/util');
  const ins = await db.run("INSERT INTO users (name, email, password_hash, role, status, email_verified, created_at) VALUES ('Maint Player', 'maint@example.com', ?, 'player', 'active', 1, ?)", [await hashPassword('MaintPass#123'), Date.now()]);
  playerId = ins.id;
  await db.run("INSERT INTO wallets (user_id, currency, balance) VALUES (?, 'USD', 100000)", [playerId]).catch(async () => {
    await db.run("INSERT INTO wallets (user_id, currency, balance, created_at, updated_at) VALUES (?, 'USD', 100000, ?, ?)", [playerId, Date.now(), Date.now()]);
  });
  const lp = await player.req('/login');
  await player.req('/login', { method: 'POST', body: { _csrf: player.csrf(lp.html), email: 'maint@example.com', password: 'MaintPass#123' } });
  const w = await player.req('/wallet');
  playerCsrf = player.csrf(w.html);
  await setMaintenance(true);
});
after(() => { if (server) server.kill(); });

test('browser form POST during maintenance: HTML 503 page (no JSON download), preference NOT saved', async () => {
  const home = await player.req('/', { accept: BROWSER });
  assert.equal(home.status, 503, 'GET blocked with maintenance page');
  const r = await player.req('/currency', { method: 'POST', accept: BROWSER, body: { _csrf: playerCsrf, code: 'INR' } });
  assert.equal(r.status, 503);
  assert.ok(r.ct.includes('text/html'), 'response is HTML, got content-type: ' + r.ct);
  assert.ok(!r.html.trim().startsWith('{'), 'response is not a JSON download');
  assert.ok(/maintenance/i.test(r.html), 'maintenance page shown');
  const u = await db.get('SELECT display_currency FROM users WHERE id = ?', [playerId]);
  assert.ok(!u.display_currency || u.display_currency === 'USD', 'currency preference was NOT saved during maintenance (still ' + (u.display_currency || 'unset') + ')');
});

test('money POST stays blocked: play/buy creates zero tickets during maintenance', async () => {
  const before = await db.get('SELECT COUNT(*) AS c FROM tickets WHERE user_id = ?', [playerId]);
  const r = await player.req('/play/buy', { method: 'POST', accept: BROWSER, body: { _csrf: playerCsrf, pops: '3', wager: '100', draw_type: 'DAY', num_draws: '1', currency: 'USD' } });
  assert.equal(r.status, 503);
  assert.ok(r.ct.includes('text/html'), 'blocked with the HTML page');
  const afterN = await db.get('SELECT COUNT(*) AS c FROM tickets WHERE user_id = ?', [playerId]);
  assert.equal(Number(afterN.c), Number(before.c), 'no ticket created — the block did not weaken');
  const bal = await db.get("SELECT balance FROM wallets WHERE user_id = ? AND currency = 'USD'", [playerId]);
  assert.equal(bal.balance, 100000, 'balance untouched');
});

test('API-style POST keeps the JSON 503; admin bypasses maintenance entirely', async () => {
  const r = await player.req('/currency', { method: 'POST', accept: 'application/json', body: { _csrf: playerCsrf, code: 'INR' } });
  assert.equal(r.status, 503);
  assert.ok(r.ct.includes('application/json'), 'API caller still gets JSON');
  assert.equal(JSON.parse(r.html).ok, false);
  const dash = await admin.req(AP);
  assert.equal(dash.status, 200, 'admin panel works during maintenance');
  await setMaintenance(false);
  const home = await player.req('/');
  assert.equal(home.status, 200, 'site back after maintenance off');
  // Regression: with maintenance OFF the very same currency POST works
  // normally again (redirect + the preference actually saves).
  const w = await player.req('/wallet');
  const ok = await player.req('/currency', { method: 'POST', accept: BROWSER, body: { _csrf: player.csrf(w.html), code: 'INR' } });
  assert.equal(ok.status, 302, 'currency POST redirects normally when maintenance is off');
  const u = await db.get('SELECT display_currency FROM users WHERE id = ?', [playerId]);
  assert.equal(u.display_currency, 'INR', 'preference saved once maintenance is off');
});
