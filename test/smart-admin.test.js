'use strict';
/* SMART-ADMIN regression tests (automation + bonus engine round).
   Run: node --test test/smart-admin.test.js
   Covers the pieces that must never silently regress:
   - bonus grants respect the budget cap exactly and auto-stop the campaign;
   - per-user caps clamp grants;
   - a % first-deposit campaign pays on the FIRST approved deposit only;
   - wagering progress accrues and unmet wagering is reported;
   - the automation master switch freezes settleDueDraws. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-smart-'));
process.env.SQLITE_PATH = path.join(TMP, 'smart.sqlite');
process.env.DB_DRIVER = 'sqlite';
delete process.env.DATABASE_URL;
delete process.env.SMTP_HOST;
process.env.TICKET_HMAC_SECRET = 'smart-test-hmac-secret-0123456789';

const { openDB } = require('../lib/db');
const { migrate } = require('../lib/migrations');
const { ensureScratchSchema } = require('../lib/scratch');
const bonus = require('../lib/bonus');
const { decideDeposit } = require('../lib/money');
const { settleDueDraws } = require('../lib/draws');
const { getSettings } = require('../lib/settings');
const { now } = require('../lib/util');

const { db } = openDB();
let seq = 0;

test.before(async () => {
  await migrate(db, 'sqlite');
  await ensureScratchSchema(db, 'sqlite');
});

test.after(async () => {
  await db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function mkUser() {
  seq += 1;
  const r = await db.run(
    "INSERT INTO users (email, name, password_hash, role, status, email_verified, created_at) VALUES (?, ?, 'x', 'player', 'active', 1, ?)",
    ['smart' + seq + '@test.dev', 'Smart ' + seq, now()]);
  return r.id;
}

async function mkCampaign(over = {}) {
  const c = {
    name: 'T' + seq + '-' + Math.random().toString(36).slice(2, 7), audience: 'all', audience_n: 0,
    amount_type: 'fixed', amount: 500, currency: 'USD', trigger_type: 'manual',
    starts_at: 0, ends_at: 0, wagering_x: 0, per_user_cap: 0, budget_cap: 0, ...over,
  };
  const r = await db.run(
    `INSERT INTO bonus_campaigns (name, audience, audience_n, amount_type, amount, currency, trigger_type, starts_at, ends_at, wagering_x, per_user_cap, budget_cap, granted_total, active, last_drop_at, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, NULL, ?)`,
    [c.name, c.audience, c.audience_n, c.amount_type, c.amount, c.currency, c.trigger_type, c.starts_at, c.ends_at, c.wagering_x, c.per_user_cap, c.budget_cap, now()]);
  return r.id;
}

const settings = { bonus_enabled: '1', automation_master_enabled: '1' };

test('budget cap: grants clamp to the exact cap and the campaign auto-stops', async () => {
  const u1 = await mkUser(); const u2 = await mkUser(); const u3 = await mkUser();
  const cid = await mkCampaign({ amount: 500, budget_cap: 1200 });
  const out = await bonus.runCampaign(db, cid, 'manual', settings, { manual: true });
  assert.equal(out.total, 1200);
  assert.equal(out.stopped, true);
  const camp = await db.get('SELECT active, granted_total FROM bonus_campaigns WHERE id = ?', [cid]);
  assert.equal(camp.active, 0);
  assert.equal(Number(camp.granted_total), 1200);
  const grants = await db.query('SELECT amount FROM bonus_grants WHERE campaign_id = ? ORDER BY id', [cid]);
  assert.deepEqual(grants.map((g) => Number(g.amount)), [500, 500, 200]);
  const bal = await db.get("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE user_id = ? AND type = 'bonus'", [u3]);
  assert.equal(Number(bal.s), 200);
  assert.ok(u1 && u2);
});

test('per-user cap clamps repeat grants', async () => {
  const u = await mkUser();
  const cid = await mkCampaign({ amount: 500, per_user_cap: 700, audience: 'first_n', audience_n: 1000 });
  await bonus.runCampaign(db, cid, 'manual', settings, { manual: true, userId: undefined });
  const mine = await db.get('SELECT COALESCE(SUM(amount),0) AS s FROM bonus_grants WHERE campaign_id = ? AND user_id = ?', [cid, u]);
  assert.ok(Number(mine.s) <= 700);
});

test('first-deposit percent campaign pays once, on the first approval only', async () => {
  const u = await mkUser();
  await mkCampaign({ amount_type: 'percent', amount: 10, trigger_type: 'first_deposit' });
  const mkDep = async () => {
    const r = await db.run(
      "INSERT INTO deposits (public_id, user_id, method_id, currency, amount, charge, net, status, idempotency_key, created_at) VALUES (?, ?, 1, 'USD', 5000, 0, 5000, 'pending', ?, ?)",
      ['dep' + Math.random().toString(36).slice(2, 10), u, 'idem' + Math.random().toString(36).slice(2, 12), now()]);
    return r.id;
  };
  await decideDeposit(db, await mkDep(), 'approve', null, settings);
  await decideDeposit(db, await mkDep(), 'approve', null, settings);
  const grants = await db.query("SELECT amount FROM bonus_grants WHERE user_id = ? AND trigger_type = 'first_deposit'", [u]);
  assert.equal(grants.length, 1);
  assert.equal(Number(grants[0].amount), 500);
});

test('wagering accrues against the oldest unmet grant', async () => {
  const u = await mkUser();
  const cid = await mkCampaign({ amount: 200, wagering_x: 2, audience: 'all' });
  await bonus.runCampaign(db, cid, 'manual', settings, { manual: true });
  assert.equal(await bonus.unmetWagering(db, u, 'USD'), 400);
  await bonus.accrueWagering(db, u, 'USD', 150);
  assert.equal(await bonus.unmetWagering(db, u, 'USD'), 250);
  await bonus.accrueWagering(db, u, 'USD', 1000);
  assert.equal(await bonus.unmetWagering(db, u, 'USD'), 0);
});

test('master switch off freezes settleDueDraws; on resumes it', async () => {
  const r = await db.run(
    "INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, is_test, created_at) VALUES ('DAY', '2020-01-01', 1, 'scheduled', 'h', 's', 0, ?)",
    [now()]);
  const off = await settleDueDraws(db, { ...settings, automation_master_enabled: '0', beacon_enabled: '0' });
  assert.deepEqual(off, []);
  let d = await db.get('SELECT status FROM draws WHERE id = ?', [r.id]);
  assert.equal(d.status, 'scheduled');
  const on = await settleDueDraws(db, { ...settings, beacon_enabled: '0' });
  assert.equal(on.length, 1);
  d = await db.get('SELECT status FROM draws WHERE id = ?', [r.id]);
  assert.equal(d.status, 'settled');
});

test('signup hook grants only signup campaigns and respects the master switch', async () => {
  const cid = await mkCampaign({ amount: 300, trigger_type: 'signup' });
  const u = await mkUser();
  await bonus.onSignup(db, { ...settings, automation_master_enabled: '0' }, u);
  let g = await db.query('SELECT * FROM bonus_grants WHERE campaign_id = ? AND user_id = ?', [cid, u]);
  assert.equal(g.length, 0);
  await bonus.onSignup(db, settings, u);
  g = await db.query('SELECT * FROM bonus_grants WHERE campaign_id = ? AND user_id = ?', [cid, u]);
  assert.equal(g.length, 1);
  assert.equal(Number(g[0].amount), 300);
});
