'use strict';
/* CURRENCY-SYSTEM-01:
   - An INR-preference player sees INR methods first on deposit, foreign
     methods grouped under "Other currencies" with their currency named,
     and the INR method as the default selection.
   - Foreign amounts carry a marked equivalent in his currency; the
     wallet shows a Total (approx) line.
   - Wallet Exchange at the ADMIN-SET rate: exact credit, fee case,
     unknown-rate refusal (fail closed, no balance change), insufficient
     refusal; ledger pair with one shared ref.
   - Admin Currencies TABLE round-trip preserves the stored JSON
     semantics; the coverage warning appears for an enabled currency
     with no method and disappears once one exists. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 4147, BASE = `http://127.0.0.1:${PORT}`, ROOT = path.join(__dirname, '..');
const AP = '/ops-7f3a9c-console';
const DBP = `/tmp/cp-currency-${process.pid}.sqlite`;
let server, db, upiId, bankId, playerId;

class Jar {
  constructor() { this.m = new Map(); }
  absorb(h) { const sc = h.getSetCookie ? h.getSetCookie() : []; for (const c of sc) { const p = c.split(';')[0]; const i = p.indexOf('='); if (i > 0) { const k = p.slice(0, i).trim(), v = p.slice(i + 1).trim(); if (v) this.m.set(k, v); else this.m.delete(k); } } }
  header() { return [...this.m.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(p, { method = 'GET', body } = {}) {
    const payload = body instanceof URLSearchParams ? body.toString() : (body ? new URLSearchParams(body).toString() : undefined);
    const r = await fetch(BASE + p, { method, redirect: 'manual', headers: { cookie: this.header(), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: payload });
    this.absorb(r.headers); return { status: r.status, loc: r.headers.get('location') || '', html: await r.text() };
  }
  csrf(html) { const m = html.match(/name="_csrf" value="([^"]+)"/); assert.ok(m, 'csrf present'); return m[1]; }
}
const admin = new Jar(), player = new Jar();

before(async () => {
  const env = { ...process.env, PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite', SQLITE_PATH: DBP,
    TICKET_HMAC_SECRET: 'currency-test-' + 'x'.repeat(48),
    CREDENTIAL_ENCRYPTION_KEY: 'f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6',
    ADMIN_SEED_EMAIL: 'currency-admin@example.com', ADMIN_SEED_PASSWORD: 'CurrencyAdminPass-2026', ADMIN_SEED_NAME: 'Cur Admin' };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[currency server] ' + d));
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { try { const r = await fetch(BASE + '/healthz'); ok = r.status === 200; } catch {} if (!ok) await new Promise(r => setTimeout(r, 500)); }
  assert.ok(ok, 'server boots');
  process.env.SQLITE_PATH = DBP; process.env.DB_DRIVER = 'sqlite';
  db = require('../lib/db').openDB().db;
  const g = await admin.req(AP);
  await admin.req(AP + '/login', { method: 'POST', body: { _csrf: admin.csrf(g.html), email: 'currency-admin@example.com', password: 'CurrencyAdminPass-2026' } });
  // Rates: USD base, INR at 90.5 (via the admin JSON path)
  const st = await admin.req(AP + '/settings');
  const set = await admin.req(AP + '/settings/currencies', { method: 'POST', body: { _csrf: admin.csrf(st.html), currencies: JSON.stringify([{ code: 'USD', symbol: '$', rate: 1 }, { code: 'INR', symbol: '₹', rate: 90.5 }, { code: 'EUR', symbol: '€', rate: 0.92 }]), base_currency: 'USD' } });
  assert.equal(set.status, 302, 'currencies JSON save');
  // Methods: UPI becomes the INR method; bank stays USD.
  const upi = await db.get("SELECT id FROM payment_methods WHERE slug = 'rail-upi'");
  const bank = await db.get("SELECT id FROM payment_methods WHERE slug = 'rail-bank_transfer'");
  upiId = upi.id; bankId = bank.id;
  await db.run("UPDATE payment_methods SET currency = 'INR', enabled = 1 WHERE id = ?", [upiId]);
  await db.run('UPDATE payment_methods SET enabled = 1, min_amount = 1000 WHERE id = ?', [bankId]);
  // Player with INR preference and a funded INR wallet.
  const { hashPassword } = require('../lib/util');
  const ins = await db.run("INSERT INTO users (name, email, password_hash, role, status, email_verified, display_currency, created_at) VALUES ('Rupee Player', 'rupee@example.com', ?, 'player', 'active', 1, 'INR', ?)", [await hashPassword('RupeePass#123'), Date.now()]);
  playerId = ins.id;
  await db.run("INSERT INTO wallets (user_id, currency, balance) VALUES (?, 'INR', 200000)", [playerId]).catch(async () => {
    await db.run("INSERT INTO wallets (user_id, currency, balance, created_at, updated_at) VALUES (?, 'INR', 200000, ?, ?)", [playerId, Date.now(), Date.now()]);
  });
  const lp = await player.req('/login');
  await player.req('/login', { method: 'POST', body: { _csrf: player.csrf(lp.html), email: 'rupee@example.com', password: 'RupeePass#123' } });
});
after(() => { if (server) server.kill(); });

test('deposit page: INR methods first, Other currencies group, INR default, foreign amounts carry equivalents', async () => {
  const g = await player.req('/deposit/new');
  assert.equal(g.status, 200);
  const iUpi = g.html.indexOf('UPI');
  const iOther = g.html.indexOf('Other currencies');
  assert.ok(iUpi > -1 && iOther > iUpi, 'INR method listed before the Other currencies heading');
  assert.ok(g.html.includes(`name="method_id" value="${upiId}"`), 'default selection is the INR method');
  const usd = await player.req('/deposit/new?m=' + bankId);
  assert.ok(usd.html.includes('(USD)'), 'foreign method tagged with its currency');
  assert.ok(usd.html.includes('₹905.00'), 'min $10.00 shows the equivalent ₹905.00 at the set rate');
  assert.ok(usd.html.includes('Set rate'), 'rate note names the set rate honestly');
  assert.ok(!/admin-set|settings\s*→|settings\s*->/i.test(usd.html), 'player pages never mention admin or settings (owner rule, hotfix 2026-10-29)');
});

test('wallet: Total (approx) in INR; exchange happy path credits exactly; ledger pair shares one ref', async () => {
  const w = await player.req('/wallet');
  assert.ok(w.html.includes('Total (approx): ₹2,000.00'), 'total approx line in his currency');
  const prev = await player.req('/wallet');
  const ex = await player.req('/wallet/exchange/preview', { method: 'POST', body: { _csrf: player.csrf(prev.html), from_currency: 'INR', to_currency: 'USD', amount: '905.00' } });
  assert.equal(ex.status, 200);
  assert.ok(ex.html.includes('you receive') && ex.html.includes('$10.00'), 'preview shows the exact receive amount');
  const done = await player.req('/wallet/exchange', { method: 'POST', body: { _csrf: player.csrf(ex.html), from_currency: 'INR', to_currency: 'USD', amount: '905.00' } });
  assert.equal(done.status, 302);
  const inr = await db.get("SELECT balance FROM wallets WHERE user_id = ? AND currency = 'INR'", [playerId]);
  const usd = await db.get("SELECT balance FROM wallets WHERE user_id = ? AND currency = 'USD'", [playerId]);
  assert.equal(inr.balance, 200000 - 90500, 'INR debited exactly');
  assert.equal(usd.balance, 1000, 'USD credited exactly 1000 minor at rate 90.5');
  const pair = await db.query("SELECT * FROM transactions WHERE user_id = ? AND type IN ('exchange_out','exchange_in') ORDER BY id", [playerId]);
  assert.equal(pair.length, 2, 'ledger pair written');
  assert.equal(pair[0].ref_id, pair[1].ref_id, 'one shared pair ref');
  assert.ok(String(pair[0].meta).includes('90.5'), 'rate snapshot in the ledger meta');
  const auditRow = await db.get("SELECT id FROM audit_log WHERE action = 'wallet.exchange'");
  assert.ok(auditRow, 'exchange audit-logged');
});

test('exchange fee 2%: credits 980 of 1000; unknown rate fails closed; insufficient refused', async () => {
  // fee via the TABLE form (also the round-trip test for the table path)
  const st = await admin.req(AP + '/settings');
  const body = new URLSearchParams();
  body.append('_csrf', admin.csrf(st.html));
  for (const [code, sym, rate] of [['USD', '$', '1'], ['INR', '₹', '90.5'], ['EUR', '€', '0.92']]) {
    body.append('cur_code', code); body.append('cur_symbol', sym); body.append('cur_rate', rate); body.append('cur_decimals', ''); body.append('cur_enabled', code);
  }
  body.append('cur_code', ''); body.append('cur_symbol', ''); body.append('cur_rate', ''); body.append('cur_decimals', ''); // empty new row
  body.append('base_currency', 'USD');
  body.append('exchange_fee_percent', '2');
  const save = await admin.req(AP + '/settings/currencies', { method: 'POST', body });
  assert.equal(save.status, 302, 'table save accepted');
  const stored = await db.get("SELECT value FROM settings WHERE key = 'currencies'");
  const list = JSON.parse(stored.value);
  assert.equal(list.find(c => c.code === 'INR').rate, 90.5, 'JSON semantics preserved (INR rate)');
  assert.equal(list.find(c => c.code === 'INR').symbol, '₹', 'symbol preserved');
  const feeRow = await db.get("SELECT value FROM settings WHERE key = 'exchange_fee_percent'");
  assert.equal(feeRow.value, '2', 'fee saved');

  const prev = await player.req('/wallet');
  await player.req('/wallet/exchange/preview', { method: 'POST', body: { _csrf: player.csrf(prev.html), from_currency: 'INR', to_currency: 'USD', amount: '905.00' } });
  const w2 = await player.req('/wallet');
  const done = await player.req('/wallet/exchange', { method: 'POST', body: { _csrf: player.csrf(w2.html), from_currency: 'INR', to_currency: 'USD', amount: '905.00' } });
  assert.equal(done.status, 302);
  const usd = await db.get("SELECT balance FROM wallets WHERE user_id = ? AND currency = 'USD'", [playerId]);
  assert.equal(usd.balance, 1000 + 980, 'fee case: 1000 gross - 2% = 980 credited');

  // unknown/zero rate: write a zero-rate currency straight into settings (bypasses UI validation on purpose)
  await db.run("UPDATE settings SET value = ? WHERE key = 'currencies'", [JSON.stringify([{ code: 'USD', symbol: '$', rate: 1 }, { code: 'INR', symbol: '₹', rate: 90.5 }, { code: 'EUR', symbol: '€', rate: 0.92 }, { code: 'ZZZ', symbol: 'Z', rate: 0 }])]);
  await new Promise(r => setTimeout(r, 5200)); // settings cache TTL
  const inrBefore = (await db.get("SELECT balance FROM wallets WHERE user_id = ? AND currency = 'INR'", [playerId])).balance;
  const p3 = await player.req('/wallet');
  const bad = await player.req('/wallet/exchange/preview', { method: 'POST', body: { _csrf: player.csrf(p3.html), from_currency: 'INR', to_currency: 'ZZZ', amount: '10.00' } });
  assert.equal(bad.status, 302, 'refused back to wallet');
  const follow = await player.req(bad.loc);
  assert.ok(follow.html.includes('not available for this currency pair'), 'honest fail-closed message');
  const inrAfter = (await db.get("SELECT balance FROM wallets WHERE user_id = ? AND currency = 'INR'", [playerId])).balance;
  assert.equal(inrAfter, inrBefore, 'no balance change on refused exchange');
  // insufficient
  const p4 = await player.req('/wallet');
  const ins = await player.req('/wallet/exchange/preview', { method: 'POST', body: { _csrf: player.csrf(p4.html), from_currency: 'INR', to_currency: 'USD', amount: '99999.00' } });
  assert.equal(ins.status, 302);
  const f2 = await player.req(ins.loc);
  assert.ok(f2.html.includes('do not have enough balance'), 'insufficient refused truthfully');
});

test('coverage warning: EUR (no methods) listed; INR covered so absent', async () => {
  const methods = await admin.req(AP + '/methods');
  assert.ok(methods.html.includes('Currency coverage warning'), 'warning renders on the methods page');
  assert.ok(methods.html.includes('<strong>EUR</strong>'), 'EUR gap listed (no EUR methods exist)');
  assert.ok(!methods.html.includes('<strong>INR</strong> is enabled but has'), 'INR not listed — it has deposit+withdrawal coverage');
  const st = await admin.req(AP + '/settings');
  assert.ok(st.html.includes('name="cur_rate"'), 'currencies card is a table, not only a JSON box');
  assert.ok(st.html.includes('Advanced (JSON)'), 'raw JSON kept under Advanced');
});
