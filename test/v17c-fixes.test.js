'use strict';
/* v17.1 regression tests (owner-directed round 2c).
   - cancelDraw cumulative rounding: cancelling every draw of a 1000-minor
     3-draw ticket returns exactly 1000 (was 3x333=999).
   - webhook decideDeposit with NULL admin id (not fake admin 0).
   - withdrawal revoke-before-payout refunds the FULL hold (was net).
   - normalizePhone canonical form used by the profile fix. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-v17c-'));
process.env.SQLITE_PATH = path.join(TMP, 'v17c.sqlite');
process.env.DB_DRIVER = 'sqlite';
delete process.env.DATABASE_URL;
delete process.env.SMTP_HOST;
process.env.TICKET_HMAC_SECRET = 'test-hmac-secret-for-tests-only-0123456789abcdef';

const { openDB } = require('../lib/db');
const { migrate } = require('../lib/migrations');
const { ensureScratchSchema } = require('../lib/scratch');
const { cancelDraw } = require('../lib/draws');
const { decideDeposit, decideWithdrawal } = require('../lib/money');
const { normalizePhone, now } = require('../lib/util');

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

test('cancelDraw: 3 sequential cancels of a 1000-minor ticket refund exactly 1000', async () => {
  const user = await mkUser('v17c-cancel@example.com');
  const drawIds = [];
  const dates = ['2026-10-28', '2026-10-29', '2026-10-30'];
  for (let i = 0; i < 3; i++) {
    const d = await db.run(
      "INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, is_test, created_at) VALUES ('DAILY', ?, ?, 'scheduled', 'hash', 'seed', 0, ?)",
      [dates[i], now() + 86400000, now()]);
    drawIds.push(d.id);
  }
  const t = await db.run(
    "INSERT INTO tickets (public_id, user_id, currency, pops, wager, num_draws, draw_type, draw_ids, total, status, hmac, created_at) VALUES ('TTEST1', ?, 'USD', '[1,2,3]', 100, 3, 'DAILY', ?, 1000, 'active', 'test', ?)",
    [user, JSON.stringify(drawIds), now()]);
  for (const d of drawIds) {
    await db.run('INSERT INTO ticket_entries (ticket_id, draw_id, status) VALUES (?, ?, ?)', [t.id, d, 'pending']);
  }
  const r1 = await cancelDraw(db, drawIds[0], {}, { actorId: 1 });
  const r2 = await cancelDraw(db, drawIds[1], {}, { actorId: 1 });
  const r3 = await cancelDraw(db, drawIds[2], {}, { actorId: 1 });
  assert.strictEqual(r1.refunded, 333);
  assert.strictEqual(r2.refunded, 334);
  assert.strictEqual(r3.refunded, 333);
  assert.strictEqual(r1.refunded + r2.refunded + r3.refunded, 1000);
  const ticket = await db.get("SELECT status FROM tickets WHERE id = ?", [t.id]);
  assert.strictEqual(ticket.status, 'cancelled');
});

test('webhook decideDeposit stores NULL decided_by, not admin id 0', async () => {
  const user = await mkUser('v17c-webhook@example.com');
  const d = await db.run(
    "INSERT INTO deposits (public_id, user_id, method_id, currency, amount, charge, net, status, user_data, idempotency_key, created_at) VALUES ('DTEST1', ?, NULL, 'USD', 1000, 0, 1000, 'pending', '{}', 'k1', ?)",
    [user, now()]);
  await decideDeposit(db, d.id, 'approve', null);
  const row = await db.get('SELECT status, decided_by FROM deposits WHERE id = ?', [d.id]);
  assert.strictEqual(row.status, 'approved');
  assert.strictEqual(row.decided_by, null);
});

test('withdrawal revoke-before-payout refunds the FULL hold, not net', async () => {
  const user = await mkUser('v17c-revoke@example.com');
  const w = await db.run(
    "INSERT INTO withdrawals (public_id, user_id, method_id, currency, amount, charge, net, status, user_data, idempotency_key, created_at) VALUES ('WTEST1', ?, NULL, 'USD', 1000, 50, 950, 'approved', '{}', 'k2', ?)",
    [user, now()]);
  await decideWithdrawal(db, w.id, 'revoke', 999);
  const wallet = await db.get('SELECT balance FROM wallets WHERE user_id = ? AND currency = ?', [user, 'USD']);
  assert.strictEqual(Number(wallet.balance), 1000);
  const led = await db.get("SELECT amount FROM transactions WHERE type = 'withdrawal_revoke' AND ref_id = ?", ['WTEST1']);
  assert.strictEqual(Number(led.amount), 1000);
});

test('normalizePhone canonical form (profile fix contract)', async () => {
  assert.strictEqual(normalizePhone('+1 (555) 123-4567'), '+15551234567');
  assert.strictEqual(normalizePhone('0044 7700 900123'), '+447700900123');
  assert.strictEqual(normalizePhone(''), '');
});
