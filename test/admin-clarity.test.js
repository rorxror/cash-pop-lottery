'use strict';
/* ADMIN-CLARITY-01: Limits & Controls hub + global deposit caps +
   page purpose subtitles + Dashboard Common tasks.
   - Hub POST writes the SAME settings keys as Settings (two doors).
   - deposit_daily_cap is enforced in the engine (money.js createDeposit):
     over-cap deposit refused with a plain player message, NO row created.
   - Cap 0 = unlimited restores the flow. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 4143, BASE = `http://127.0.0.1:${PORT}`, ROOT = path.join(__dirname, '..');
const AP = '/ops-7f3a9c-console';
const DBP = `/tmp/cp-clarity-${process.pid}.sqlite`;
const ADMIN_EMAIL = 'clarity-admin@example.com', ADMIN_PASSWORD = 'ClarityAdminPass-2026';
let server, db, bankId;

class Jar {
  constructor() { this.m = new Map(); }
  absorb(h) { const sc = h.getSetCookie ? h.getSetCookie() : []; for (const c of sc) { const p = c.split(';')[0]; const i = p.indexOf('='); if (i > 0) { const k = p.slice(0, i).trim(), v = p.slice(i + 1).trim(); if (v) this.m.set(k, v); else this.m.delete(k); } } }
  header() { return [...this.m.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(p, { method = 'GET', body } = {}) {
    const r = await fetch(BASE + p, { method, redirect: 'manual', headers: { cookie: this.header(), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: body ? new URLSearchParams(body).toString() : undefined });
    this.absorb(r.headers); return { status: r.status, loc: r.headers.get('location') || '', html: await r.text() };
  }
  csrf(html) { const m = html.match(/name="_csrf" value="([^"]+)"/); assert.ok(m, 'csrf present'); return m[1]; }
}
const admin = new Jar(), player = new Jar();

before(async () => {
  const env = { ...process.env, PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite', SQLITE_PATH: DBP,
    TICKET_HMAC_SECRET: 'clarity-test-' + 'x'.repeat(48),
    CREDENTIAL_ENCRYPTION_KEY: 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3',
    ADMIN_SEED_EMAIL: ADMIN_EMAIL, ADMIN_SEED_PASSWORD: ADMIN_PASSWORD, ADMIN_SEED_NAME: 'Clarity Admin' };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[clarity server] ' + d));
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { try { const r = await fetch(BASE + '/healthz'); ok = r.status === 200; } catch {} if (!ok) await new Promise(r => setTimeout(r, 500)); }
  assert.ok(ok, 'server boots');
  process.env.SQLITE_PATH = DBP; process.env.DB_DRIVER = 'sqlite';
  db = require('../lib/db').openDB().db;
  const g = await admin.req(AP);
  await admin.req(AP + '/login', { method: 'POST', body: { _csrf: admin.csrf(g.html), email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  const { hashPassword } = require('../lib/util');
  await db.run("INSERT INTO users (name, email, password_hash, role, status, email_verified, created_at) VALUES ('Cap Player', 'capplayer@example.com', ?, 'player', 'active', 1, ?)", [await hashPassword('CapPlayer#123'), Date.now()]);
  const lp = await player.req('/login');
  await player.req('/login', { method: 'POST', body: { _csrf: player.csrf(lp.html), email: 'capplayer@example.com', password: 'CapPlayer#123' } });
  const m = await db.get("SELECT id FROM payment_methods WHERE slug = 'rail-bank_transfer'");
  assert.ok(m, 'seeded bank method'); bankId = m.id;
  await db.run('UPDATE payment_methods SET enabled = 1 WHERE id = ?', [bankId]);
});
after(() => { if (server) server.kill(); });

async function hubPost(fields) {
  const g = await admin.req(AP + '/limits');
  return admin.req(AP + '/limits', { method: 'POST', body: { _csrf: admin.csrf(g.html), deposit_daily_cap: '0', deposit_monthly_cap: '0', withdrawal_daily_cap: '0', withdrawal_monthly_cap: '0', payout_lock_hours: '48', auto_withdrawal_limit: '0', ...fields } });
}
async function tryDeposit(amount) {
  const g = await player.req('/deposit/new?m=' + bankId);
  const post = await player.req('/deposit/new', { method: 'POST', body: { _csrf: player.csrf(g.html), method_id: String(bankId), amount, custom_reference: 'REF-' + amount + '-' + Date.now(), custom_sender_name: 'Cap Player' } });
  let html = post.html;
  if (post.status === 302 && post.loc) { const f = await player.req(post.loc); html = f.html; }
  return { status: post.status, html };
}

test('hub renders every limit row + the elsewhere summary', async () => {
  const g = await admin.req(AP + '/limits');
  assert.equal(g.status, 200);
  for (const label of ['Daily deposit limit', 'Monthly deposit limit', 'Daily withdrawal limit', 'Monthly withdrawal limit', 'Auto-withdrawal limit', 'Payout-detail change lock', 'Wagering required before withdrawal', 'Limits that live elsewhere'])
    assert.ok(g.html.includes(label), 'row present: ' + label);
  assert.ok(g.html.includes('adm-sub'), 'page purpose subtitle renders');
});

test('deposit_daily_cap enforced: over-cap refused plainly, NO row; cap 0 restores', async () => {
  await hubPost({ deposit_daily_cap: '40.00' });
  const d1 = await tryDeposit('25.00');
  assert.ok(!d1.html.includes('Daily deposit limit'), 'first deposit under cap passes');
  const rows1 = await db.get('SELECT COUNT(*) AS c FROM deposits');
  assert.equal(rows1.c, 1, 'one deposit row created');
  const d2 = await tryDeposit('20.00');
  assert.ok(d2.html.includes('Daily deposit limit'), 'plain refusal message shown to the player');
  const rows2 = await db.get('SELECT COUNT(*) AS c FROM deposits');
  assert.equal(rows2.c, 1, 'NO row created for the refused deposit');
  await hubPost({ deposit_daily_cap: '0' });
  const d3 = await tryDeposit('20.00');
  assert.ok(!d3.html.includes('Daily deposit limit'), 'cap 0 = unlimited restores the flow');
  const rows3 = await db.get('SELECT COUNT(*) AS c FROM deposits');
  assert.equal(rows3.c, 2, 'deposit lands after cap lifted');
});

test('two doors, one truth: hub value appears in Settings and vice versa', async () => {
  await hubPost({ withdrawal_daily_cap: '777.00' });
  const st = await admin.req(AP + '/settings');
  assert.ok(st.html.includes('777'), 'Settings risk card shows the hub value');
  const risk = await admin.req(AP + '/settings/risk', { method: 'POST', body: { _csrf: admin.csrf(st.html), withdrawal_turnover_required: '1', withdrawal_daily_cap: '777.00', withdrawal_monthly_cap: '888.00', payout_lock_hours: '48', maker_checker_threshold: '0', referral_cap_per_referee: '0', auto_withdrawal_limit: '0' } });
  assert.equal(risk.status, 302);
  const hub = await admin.req(AP + '/limits');
  assert.ok(hub.html.includes('888'), 'hub shows the Settings-side value');
});

test('subtitles on the main pages + Dashboard Common tasks with real counts', async () => {
  const dep = await admin.req(AP + '/deposits');
  assert.ok(dep.html.includes('Review deposit requests and credit players.'), 'deposits subtitle');
  const wd = await admin.req(AP + '/withdrawals');
  assert.ok(wd.html.includes('Review payout requests and mark them paid.'), 'withdrawals subtitle');
  const dash = await admin.req(AP);
  assert.ok(dash.html.includes('Common tasks'), 'common tasks card');
  assert.ok(dash.html.includes('Review pending deposits (2)'), 'real pending count (2 deposits are pending)');
  assert.ok(dash.html.includes('Set limits'), 'limits shortcut');
});
