'use strict';
/* v17 regression tests: fixes from the fix-coordinator round (priority
   regressions + old 235-report Critical/High items).
   Run: node --test test/v17-fixes.test.js
   These tests fail on the pre-fix code and pass after:
   - SQLite rejects FOR UPDATE entirely, so v16 settleAgentCommissions and
     capped referral release ALWAYS threw on SQLite (and the aggregate SUM
     FOR UPDATE threw on Postgres too).
   - Email otp_login / support_reply templates were never seeded, so email
     login OTPs and support replies were silently skipped.
   - OAuth callbacks did not refuse banned/pending_review/TOTP accounts.
   - settleDraw had no guarded claims (double-pay on concurrent settle) and
     settleDueDraws aborted the whole batch on one bad draw.
   - Fairness page recomputed a winning number for unsettled draws.
   - Lottery buys ignored the daily loss limit (scratch only).
   - audit.verifyChain accepted a chain whose first row did not descend
     from GENESIS (earliest rows deletable without detection).
   - Dial-based phone blocking attributed +1 to Antigua (first in list
     order), so blocking US blocked nothing. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-v17-'));
process.env.SQLITE_PATH = path.join(TMP, 'v17.sqlite');
process.env.DB_DRIVER = 'sqlite';
delete process.env.DATABASE_URL;
delete process.env.SMTP_HOST;
process.env.TICKET_HMAC_SECRET = 'v17-test-hmac-secret-long-enough-for-tests';

const { openDB } = require('../lib/db');
const { migrate } = require('../lib/migrations');
const { ensureScratchSchema, responsibleStatus, enforceLotteryLossLimit } = require('../lib/scratch');
const { settleAgentCommissions, releaseReferralCredits } = require('../lib/money');
const { settleDraw, settleDueDraws, fairnessForDraw, deriveWinningNumberLegacy } = require('../lib/draws');
const { sha256, signTicket, now } = require('../lib/util');
const { oauthAccountCheck } = require('../lib/auth');
const { isBlockedPhone } = require('../lib/phone-countries');
const notify = require('../lib/notify');
const audit = require('../lib/audit');

const { db } = openDB();

test.before(async () => {
  await migrate(db, 'sqlite');
  await ensureScratchSchema(db);
});

test.after(async () => {
  await db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function mkUser(email) {
  const r = await db.run(
    "INSERT INTO users (email, phone, name, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, 'player', 'active', ?)",
    [email, '', 'Test User', 'x', now()]);
  return r.id;
}

async function walletBalance(userId, currency = 'USD') {
  const row = await db.get('SELECT balance FROM wallets WHERE user_id = ? AND currency = ?', [userId, currency]);
  return row ? Number(row.balance) : 0;
}

test('SQLite FOR UPDATE regression: settleAgentCommissions succeeds on SQLite and is idempotent', async () => {
  const agent = await mkUser('v17-agent@example.com');
  const player = await mkUser('v17-player@example.com');
  await db.run('INSERT INTO commissions (agent_id, user_id, currency, amount, rate, settled, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    [agent, player, 'USD', 500, 0.1, now()]);
  await db.run('INSERT INTO commissions (agent_id, user_id, currency, amount, rate, settled, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)',
    [agent, player, 'USD', 700, 0.1, now()]);
  // Pre-fix this threw "near \"UPDATE\": syntax error" on SQLite.
  const res = await settleAgentCommissions(db, agent, 1);
  assert.strictEqual(res.settled, 2);
  assert.strictEqual(res.total, 1200);
  assert.strictEqual(await walletBalance(agent), 1200);
  const again = await settleAgentCommissions(db, agent, 1);
  assert.deepStrictEqual(again, { settled: 0, total: 0 });
  assert.strictEqual(await walletBalance(agent), 1200, 'second settle must not double-credit');
});

test('referral cap release works on SQLite: in-cap released, over-cap capped (never paid)', async () => {
  const referrer = await mkUser('v17-referrer@example.com');
  const referee = await mkUser('v17-referee@example.com');
  await db.run("INSERT INTO deposits (public_id, user_id, currency, amount, net, status, idempotency_key, created_at) VALUES (?, ?, 'USD', 10000, 10000, 'approved', ?, ?)",
    ['DEP-V17', referee, 'IDEM-V17', now()]);
  await db.run("INSERT INTO transactions (user_id, currency, type, amount, balance_after, created_at) VALUES (?, 'USD', 'ticket_purchase', -1000, 9000, ?)",
    [referee, now()]);
  await db.run("INSERT INTO referral_credits (referrer_id, referee_id, currency, amount, status, created_at) VALUES (?, ?, 'USD', 100, 'pending', ?)",
    [referrer, referee, now()]);
  await db.run("INSERT INTO referral_credits (referrer_id, referee_id, currency, amount, status, created_at) VALUES (?, ?, 'USD', 100, 'pending', ?)",
    [referrer, referee, now() + 1]);
  // Pre-fix the aggregate SUM ... FOR UPDATE threw on SQLite AND Postgres.
  const res = await releaseReferralCredits(db, referee, { referral_cap_per_referee: '150' });
  assert.strictEqual(res.released, 1);
  assert.strictEqual(res.capped, 1);
  assert.strictEqual(await walletBalance(referrer), 100, 'only the in-cap row may credit');
  const rows = await db.query('SELECT status FROM referral_credits WHERE referee_id = ? ORDER BY created_at', [referee]);
  assert.deepStrictEqual(rows.map(r => r.status), ['released', 'capped']);
});

test('settle guards: second settleDraw returns skipped, no double credit', async () => {
  const player = await mkUser('v17-settle@example.com');
  const draw = await db.run(
    "INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, winning_number, is_test, created_at) VALUES ('daily', '2099-01-01', ?, 'scheduled', ?, ?, 5, 1, ?)",
    [now() - 1000, sha256('v17-seed'), 'v17-seed', now()]);
  const drawId = draw.id;
  const ticket = {
    public_id: 'V17T1', user_id: player, pops: '[5]', wager: 100,
    draw_ids: JSON.stringify([drawId]), total: 100, currency: 'USD',
  };
  ticket.hmac = signTicket(process.env.TICKET_HMAC_SECRET, ticket);
  const t = await db.run(
    "INSERT INTO tickets (public_id, user_id, currency, pops, wager, num_draws, draw_type, draw_ids, total, status, hmac, created_at) VALUES (?, ?, 'USD', '[5]', 100, 1, 'daily', ?, 100, 'active', ?, ?)",
    [ticket.public_id, player, ticket.draw_ids, ticket.hmac, now()]);
  await db.run('INSERT INTO ticket_entries (ticket_id, draw_id, status, win_amount) VALUES (?, ?, ?, 0)', [t.id, drawId, 'pending']);
  const first = await settleDraw(db, drawId, {}, {});
  assert.strictEqual(first.winning, 5);
  assert.strictEqual(first.paid, 1300, '1 pop x multiplier 13 x wager 100');
  const second = await settleDraw(db, drawId, {}, {});
  assert.strictEqual(second.skipped, true);
  assert.strictEqual(await walletBalance(player), 1300, 'second settle must not pay again');
});

test('settleDueDraws isolates a bad draw: the rest of the batch still settles', async () => {
  const player = await mkUser('v17-batch@example.com');
  // Broken draw: non-test, no seed, beacon disabled -> settleDraw throws.
  const bad = await db.run(
    "INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, is_test, created_at) VALUES ('daily', '2099-01-02', ?, 'scheduled', ?, '', 0, ?)",
    [now() - 1000, sha256('missing'), now()]);
  const good = await db.run(
    "INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, winning_number, is_test, created_at) VALUES ('daily', '2099-01-03', ?, 'scheduled', ?, ?, 3, 1, ?)",
    [now() - 1000, sha256('v17-good'), 'v17-good', now()]);
  const t = await db.run(
    "INSERT INTO tickets (public_id, user_id, currency, pops, wager, num_draws, draw_type, draw_ids, total, status, hmac, created_at) VALUES (?, ?, 'USD', '[3]', 100, 1, 'daily', ?, 100, 'active', ?, ?)",
    ['V17T2', player, JSON.stringify([good.id]), signTicket(process.env.TICKET_HMAC_SECRET, { public_id: 'V17T2', user_id: player, pops: '[3]', wager: 100, draw_ids: JSON.stringify([good.id]), total: 100, currency: 'USD' }), now()]);
  await db.run('INSERT INTO ticket_entries (ticket_id, draw_id, status, win_amount) VALUES (?, ?, ?, 0)', [t.id, good.id, 'pending']);
  const results = await settleDueDraws(db, { beacon_enabled: '0' });
  const badRes = results.find(r => r.drawId === bad.id);
  const goodRes = results.find(r => r.drawId === good.id);
  assert.ok(badRes && badRes.error, 'bad draw must be recorded, not thrown');
  assert.ok(goodRes && goodRes.winning === 3, 'good draw must still settle');
});

test('email OTP template seed: otp_login + support_reply resolve (failed, never skipped-as-slug)', async () => {
  const otpTpl = await db.get("SELECT * FROM notif_templates WHERE channel = 'email' AND slug = 'otp_login'");
  assert.ok(otpTpl, 'otp_login template must be seeded by migrate()');
  assert.match(otpTpl.subject, /login code/i);
  const supTpl = await db.get("SELECT * FROM notif_templates WHERE channel = 'email' AND slug = 'support_reply'");
  assert.ok(supTpl, 'support_reply template must be seeded by migrate()');
  // No SMTP configured: delivery fails honestly — it must NOT be 'skipped'
  // (the pre-fix symptom of a missing template) and the outbox row must
  // carry the rendered template subject/body, never the slug literal.
  const res = await notify.send(db, {}, 'email', 'otp_login', 'v17@example.com', { code: '123456' });
  assert.strictEqual(res.status, 'failed');
  const row = await db.get("SELECT * FROM notifications_log WHERE to_addr = 'v17@example.com' ORDER BY id DESC LIMIT 1");
  assert.match(row.subject, /login code/i);
  assert.notStrictEqual(row.subject, 'otp_login');
  assert.match(row.body, /123456/);
});

test('OAuth refusals: banned/pending refused, TOTP users routed to the TOTP step', () => {
  assert.deepStrictEqual(oauthAccountCheck({ status: 'banned' }).ok, false);
  assert.match(oauthAccountCheck({ status: 'banned' }).error, /blocked/i);
  assert.deepStrictEqual(oauthAccountCheck({ status: 'pending_review' }).ok, false);
  assert.match(oauthAccountCheck({ status: 'pending_review' }).error, /pending review/i);
  assert.deepStrictEqual(oauthAccountCheck({ status: 'active', totp_secret: 'ABC' }), { ok: true, totpRequired: true });
  assert.deepStrictEqual(oauthAccountCheck({ status: 'active', totp_secret: null }), { ok: true, totpRequired: false });
  assert.deepStrictEqual(oauthAccountCheck({ status: 'active' }), { ok: true, totpRequired: false });
});

test('fairness settled-only: unsettled draws get nulls, settled draws verify', () => {
  const unsettled = fairnessForDraw({ id: 1, status: 'scheduled', seed: 'secret-seed', seed_hash: sha256('secret-seed'), winning_number: 7, draw_type: 'daily', draw_date: '2099-01-01', close_at: 0, is_test: 0 });
  assert.strictEqual(unsettled.recomputed_number, null);
  assert.strictEqual(unsettled.recomputed_hash, null);
  assert.strictEqual(unsettled.number_match, null);
  assert.strictEqual(unsettled.hash_match, null);
  assert.strictEqual(unsettled.draw.winning_number, null, 'unsettled winning number must never leak via publicDrawInfo');
  const seed = 'fair-seed';
  const settled = fairnessForDraw({ id: 9, status: 'settled', seed, seed_hash: sha256(seed), winning_number: deriveWinningNumberLegacy(seed, 9), beacon_status: '', draw_type: 'daily', draw_date: '2099-01-01', close_at: 0, is_test: 0 });
  assert.strictEqual(settled.hash_match, true);
  assert.strictEqual(settled.number_match, true);
  assert.ok(settled.recomputed_number >= 1 && settled.recomputed_number <= 15);
});

test('lottery loss limit: over-limit buy rejected, in-limit buy allowed', async () => {
  const player = await mkUser('v17-limit@example.com');
  await db.run('INSERT INTO responsible_play (user_id, daily_loss_limit, session_limit_minutes, cooling_off_until, self_excluded_until, updated_at) VALUES (?, 500, 0, 0, 0, ?)',
    [player, now()]);
  // R-019 canonical window is UTC midnight (not server-local): the fixture
  // spend must fall inside today's UTC day, or the evening-CDT run puts a
  // local-midnight spend in "yesterday" UTC and the limit looks unenforced.
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  await db.run("INSERT INTO transactions (user_id, currency, type, amount, balance_after, created_at) VALUES (?, 'USD', 'ticket_purchase', -400, 0, ?)",
    [player, start.getTime() + 1000]);
  // Spent 400 + new 200 = 600 > 500 limit -> reject (pre-fix: no check at all).
  await assert.rejects(enforceLotteryLossLimit(db, player, 200), /daily loss limit/i);
  // Spent 400 + new 100 = 500 == limit -> allowed.
  await enforceLotteryLossLimit(db, player, 100);
  // No limit set -> always allowed.
  const free = await mkUser('v17-nolimit@example.com');
  await enforceLotteryLossLimit(db, free, 100000);
});

test('responsible-play decreases wait 24h: main row untouched until due', async () => {
  const player = await mkUser('v17-rp@example.com');
  await db.run('INSERT INTO responsible_play (user_id, daily_loss_limit, session_limit_minutes, cooling_off_until, self_excluded_until, updated_at) VALUES (?, 10000, 0, 0, 0, ?)',
    [player, now()]);
  // Simulate the POST handler's pending write for a decrease to 1000.
  await db.run('INSERT INTO responsible_play_pending (user_id, pending_daily_loss_limit, pending_session_limit_minutes, effective_at) VALUES (?, 1000, NULL, ?)',
    [player, now() + 24 * 3600000]);
  const before = await responsibleStatus(db, player);
  assert.strictEqual(Number(before.daily_loss_limit), 10000, 'decrease must not apply before 24h');
  assert.strictEqual(Number(before.pending_daily_loss_limit), 1000);
  // Fast-forward: move effective_at into the past, then it applies.
  await db.run('UPDATE responsible_play_pending SET effective_at = ? WHERE user_id = ?', [now() - 1, player]);
  const after = await responsibleStatus(db, player);
  assert.strictEqual(Number(after.daily_loss_limit), 1000);
  assert.strictEqual(after.pending_effective_at, undefined);
});

test('audit GENESIS: chain whose first row does not descend from GENESIS fails', async () => {
  // Isolated DB: the tampered row must be the FIRST chained row, because the
  // GENESIS check only anchors the start of the chain.
  const tmp2 = path.join(TMP, 'v17-audit.sqlite');
  process.env.SQLITE_PATH = tmp2;
  const { openDB: openDB2 } = require('../lib/db');
  const { db: db2 } = openDB2();
  try {
    await db2.execScript(`CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, actor_role TEXT, action TEXT,
      entity TEXT, entity_id TEXT, detail TEXT, ip TEXT, created_at INTEGER,
      prev_hash TEXT, hash TEXT)`);
    const created = now();
    const prev = 'tampered-anchor';
    const hash = sha256([prev, 'test.action', 'user', '1', '{}', String(created), '1'].join('|'));
    await db2.run('INSERT INTO audit_log (actor_id, actor_role, action, entity, entity_id, detail, ip, created_at, prev_hash, hash) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['admin', 'test.action', 'user', '1', '{}', '', created, prev, hash]);
    const res = await audit.verifyChain(db2);
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /GENESIS/);
    // And a genuine GENESIS-anchored chain still verifies.
    await db2.run('DELETE FROM audit_log');
    const h1 = sha256(['GENESIS', 'a.one', 'user', '1', '{}', String(created), '1'].join('|'));
    await db2.run('INSERT INTO audit_log (actor_id, actor_role, action, entity, entity_id, detail, ip, created_at, prev_hash, hash) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['admin', 'a.one', 'user', '1', '{}', '', created, 'GENESIS', h1]);
    const ok = await audit.verifyChain(db2);
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.checked, 1);
  } finally {
    await db2.close();
  }
});

test('phone dial blocking: shared dials block the whole range, others unaffected', () => {
  // Blocking US must block +1 numbers (pre-fix: +1 resolved to Antigua).
  assert.strictEqual(isBlockedPhone({ blocked_phone_countries: 'US' }, '+15551234567'), true);
  // Blocking a non-shared country must not block other countries.
  assert.strictEqual(isBlockedPhone({ blocked_phone_countries: 'AG' }, '+442071234567'), false);
  // Shared dial 7: blocking RU blocks a KZ number too (digits cannot tell them apart).
  assert.strictEqual(isBlockedPhone({ blocked_phone_countries: 'RU' }, '+77001234567'), true);
  // Unknown dial fails closed.
  assert.strictEqual(isBlockedPhone({ blocked_phone_countries: '' }, '+999123456'), true);
  // Explicit country can only add a block, never bypass the dial check.
  assert.strictEqual(isBlockedPhone({ blocked_phone_countries: 'US' }, '+15551234567', 'GB'), true);
});

test('notify unknown channel: logged as failed, never as sent', async () => {
  // The throw path only runs when a template is active: seed one for the
  // bogus channel (the pre-fix code then recorded the row as 'sent').
  await db.run("INSERT INTO notif_templates (channel, slug, subject, body, enabled) VALUES ('smoke-signal', 'win', 'You won', 'You won {{amount}}', 1)");
  const res = await notify.send(db, {}, 'smoke-signal', 'win', 'v17@example.com', {});
  assert.strictEqual(res.status, 'failed');
  assert.match(res.error, /Unknown notification channel/);
  const row = await db.get("SELECT * FROM notifications_log WHERE channel = 'smoke-signal' ORDER BY id DESC LIMIT 1");
  assert.strictEqual(row.status, 'failed');
});
