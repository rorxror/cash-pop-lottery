'use strict';
/* BP-23 Smart Prize & Profit Engine — proof tests.
   (i) planner liability sums EXACTLY to the target on clean samples and
   reports honestly when integer money cannot reach it;
   (iv) simulator RTP matches the hand-computed multiplier/15;
   (ii) guardrail alert fires on a prize-heavy tail + launch cap blocks;
   (c) smart auto-next regenerates the pool from sell-through + target. */
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v19pe-'));
process.env.SQLITE_PATH = path.join(tmp, 'pe.sqlite');
let db, engine, scratch, settingsLib, audit;

before(async () => {
  const { openDB } = require('../lib/db');
  const { migrate } = require('../lib/migrations');
  ({ db } = openDB());
  await migrate(db, 'sqlite');
  scratch = require('../lib/scratch');
  await scratch.ensureScratchSchema(db, 'sqlite');
  engine = require('../lib/prize-engine');
  settingsLib = require('../lib/settings');
  audit = require('../lib/audit');
});

test('BP-23 planner: liability sums exactly to target RTP on clean samples', () => {
  const p1 = engine.planPrizePool({ price: 100, totalTickets: 100, targetRtpPct: 75 });
  assert.equal(p1.ok, true);
  assert.equal(p1.targetLiability, 7500);
  assert.equal(p1.liability, 7500, 'achieved liability must equal target exactly');
  assert.equal(p1.tiers.reduce((s, t) => s + t.amount * t.quantity, 0), 7500);
  assert.equal(p1.achievedRtpPct, 75);
  assert.ok(p1.winners <= 100);
  assert.equal(p1.marginAt(100), 2500); // 10000 gross − 7500 liability
  assert.equal(p1.marginAt(50), 1250);
  assert.equal(p1.marginAt(25), 625);
  const p2 = engine.planPrizePool({ price: 200, totalTickets: 1000, targetRtpPct: 80 });
  assert.equal(p2.liability, 160000);
  assert.equal(p2.achievedRtpPct, 80);
  // honest reporting when integer money cannot reach the target
  const p3 = engine.planPrizePool({ price: 100, totalTickets: 10, targetRtpPct: 75 });
  assert.equal(p3.ok, true);
  assert.ok(p3.liability <= p3.targetLiability);
  assert.equal(p3.unallocated, p3.targetLiability - p3.liability);
  // invalid inputs refused
  assert.equal(engine.planPrizePool({ price: 100, totalTickets: 100, targetRtpPct: 101 }).ok, false);
  assert.equal(engine.planPrizePool({ price: 0, totalTickets: 100, targetRtpPct: 75 }).ok, false);
});

test('BP-23 simulator: RTP = multiplier/15, margin matches hand computation', async () => {
  assert.ok(Math.abs(engine.popRtpPct(13) - (13 / 15 * 100)) < 1e-9);
  assert.ok(Math.abs(engine.popRtpPct(5) - (5 / 15 * 100)) < 1e-9);
  assert.ok(Math.abs(engine.popRtpPct(15) - 100) < 1e-9);
  // Fabricate real entry rows: one draw, TEN tickets with pops [1,2], wager 100, 1 entry each.
  const t = Date.now();
  const dr = await db.run("INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, is_test, created_at) VALUES ('day', '2026-10-28', ?, 'settled', 'h', 's', 0, ?)", [t, t]);
  for (let i = 0; i < 10; i++) {
    const tk = await db.run("INSERT INTO tickets (public_id, user_id, currency, pops, wager, num_draws, draw_type, draw_ids, total, status, hmac, created_at) VALUES (?, 1, 'USD', '[1,2]', 100, 1, 'day', ?, 200, 'settled', 'x', ?)", ['TPE' + i, JSON.stringify([dr.id]), t]);
    await db.run("INSERT INTO ticket_entries (ticket_id, draw_id, status) VALUES (?, ?, 'settled')", [tk.id, dr.id]);
  }
  const mix = await engine.popSalesMix(db);
  const row = mix.find(m => m.pops === 2);
  assert.equal(row.entries, 10);
  assert.equal(row.stake, 2000);
  const proj = await engine.projectedMargin(db, { 2: 13 });
  assert.equal(proj.stake, 2000);
  assert.equal(proj.expectedPayout, 1733); // 100 × 10 × 13 × (2/15) = 1733.33 → 1733
  assert.ok(Math.abs(proj.marginPct - (1 - (100 * 10 * 13 * (2 / 15)) / 2000) * 100) < 0.1);
  const expo = await engine.drawExposure(db, dr.id, { 2: 13 });
  assert.equal(expo.length, 1);
  assert.equal(expo[0].maxLiability, 13000); // every entry wins: 100 × 13 × 10
  assert.equal(expo[0].expectedLiability, 1733);
});

async function mkSeries({ price = 100, total = 100, tiers, slug }) {
  const { randHex, sha256, now } = require('../lib/util');
  const seed = randHex(32);
  const r = await db.run("INSERT INTO scratch_series (title, slug, game_type, currency, price, total_tickets, status, enabled, rules, server_seed, seed_hash, created_at) VALUES (?, ?, 'single', 'USD', ?, ?, 'draft', 0, '', ?, ?, ?)",
    ['PE ' + slug, slug, price, total, seed, sha256(seed), now()]);
  for (const [amount, qty] of tiers) await db.run('INSERT INTO scratch_prize_tiers (series_id, amount, quantity, label) VALUES (?, ?, ?, ?)', [r.id, amount, qty, 't']);
  return r.id;
}

test('BP-23 guardrails: launch cap blocks an over-cap draft (lifecycle + helper)', async () => {
  await settingsLib.setSetting(db, 'sqlite', 'scratch_guardrail_enabled', '1');
  await settingsLib.setSetting(db, 'sqlite', 'scratch_liability_cap_pct', '100');
  const s = await settingsLib.getSettings(db, 'sqlite', true);
  // liability 20000 on gross 10000 → over the 100% cap
  const id = await mkSeries({ tiers: [[20000, 1]], slug: 'pe-cap' });
  const srow = await db.get('SELECT * FROM scratch_series WHERE id = ?', [id]);
  const expo = await engine.seriesExposure(db, srow);
  const cap = engine.launchCapCheck(s, srow, expo.totalLiability);
  assert.equal(cap.enforced, true);
  assert.equal(cap.ok, false);
  // scheduled launch is skipped by the lifecycle and audited
  await db.run('UPDATE scratch_series SET launch_at = ? WHERE id = ?', [Date.now() - 1000, id]);
  const out = await scratch.scratchLifecycle(db, s);
  assert.equal(out.launchBlocked, 1);
  const after = await db.get('SELECT status FROM scratch_series WHERE id = ?', [id]);
  assert.equal(after.status, 'draft');
  const aud = await db.get("SELECT * FROM audit_log WHERE action = 'scratch.guardrail_launch_blocked' AND entity_id = ?", [String(id)]);
  assert.ok(aud);
});

test('BP-23 guardrails: prize-heavy tail fires the alert (and close_sales acts)', async () => {
  await settingsLib.setSetting(db, 'sqlite', 'scratch_alert_threshold_pct', '90');
  await settingsLib.setSetting(db, 'sqlite', 'scratch_guardrail_action', 'close_sales');
  const s = await settingsLib.getSettings(db, 'sqlite', true);
  // 1 big prize (900) + 99 blanks, price 100 → after the blanks sell, tail RTP = 900%
  const id = await mkSeries({ tiers: [[900, 1]], slug: 'pe-tail' });
  await scratch.launchSeries(db, id, null);
  // sell every zero-prize outcome (mark claimed) leaving only the 900 unsold
  await db.run('UPDATE scratch_outcomes SET ticket_id = 999001 WHERE series_id = ? AND prize = 0', [id]);
  const out = await scratch.scratchLifecycle(db, s);
  assert.ok(out.guardrailAlerts >= 1, 'alert counted: ' + JSON.stringify(out));
  const aud = await db.get("SELECT * FROM audit_log WHERE action = 'scratch.guardrail_alert' AND entity_id = ?", [String(id)]);
  assert.ok(aud, 'guardrail alert audited');
  const srow = await db.get('SELECT enabled FROM scratch_series WHERE id = ?', [id]);
  assert.equal(Number(srow.enabled), 0, 'close_sales disabled further sales');
});

test('BP-23 smart auto-next: pool regenerated from sell-through + target RTP', async () => {
  await settingsLib.setSetting(db, 'sqlite', 'scratch_guardrail_enabled', '0');
  await settingsLib.setSetting(db, 'sqlite', 'scratch_auto_next_enabled', '1');
  await settingsLib.setSetting(db, 'sqlite', 'scratch_smart_pool_enabled', '1');
  await settingsLib.setSetting(db, 'sqlite', 'scratch_planner_target_rtp', '80');
  // Template series: 4 tickets, ends in the past; 2 of 4 outcomes sold → 50% sell-through
  const tplId = await mkSeries({ price: 100, total: 4, tiers: [[100, 1]], slug: 'pe-tpl' });
  await settingsLib.setSetting(db, 'sqlite', 'scratch_template_series_id', String(tplId));
  await scratch.launchSeries(db, tplId, null);
  const some = await db.query('SELECT id FROM scratch_outcomes WHERE series_id = ? ORDER BY id LIMIT 2', [tplId]);
  for (const o of some) await db.run('UPDATE scratch_outcomes SET ticket_id = 999002 WHERE id = ?', [o.id]);
  await db.run('UPDATE scratch_series SET ends_at = ? WHERE id = ?', [Date.now() - 1000, tplId]);
  const s = await settingsLib.getSettings(db, 'sqlite', true);
  const out = await scratch.scratchLifecycle(db, s);
  assert.equal(out.cloned, 1, JSON.stringify(out));
  const clone = await db.get("SELECT * FROM scratch_series WHERE slug LIKE 'pe-tpl-%' ORDER BY id DESC LIMIT 1");
  assert.ok(clone, 'clone exists');
  // nextTotal = max(50, round(4 × 0.5)) = 50; liability planned at 80% of 50×100 = 4000 exactly
  assert.equal(Number(clone.total_tickets), 50);
  const liab = await db.get('SELECT COALESCE(SUM(amount*quantity),0) AS s FROM scratch_prize_tiers WHERE series_id = ?', [clone.id]);
  assert.equal(Number(liab.s), 4000);
  const ev = await db.get("SELECT * FROM scratch_events WHERE event_type = 'series.auto_next_created' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(clone.id)]);
  assert.ok(ev && JSON.parse(ev.detail).smartPool === true, 'event records the smart pool path');
  // the clone actually launched with committed outcomes (provably fair unchanged)
  const outcomes = await db.get('SELECT COUNT(*) AS c FROM scratch_outcomes WHERE series_id = ?', [clone.id]);
  assert.equal(Number(outcomes.c), 50);
  const one = await db.get('SELECT * FROM scratch_outcomes WHERE series_id = ? ORDER BY ordinal LIMIT 1', [clone.id]);
  const { sha256 } = require('../lib/util');
  assert.equal(one.commitment, sha256(`${clone.id}|${one.ordinal}|${one.nonce}|${one.prize}`), 'commitment formula unchanged');
});
