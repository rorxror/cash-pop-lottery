'use strict';
/* V20 OWNER-FIX — D-FIX-B money regression tests (D1 candidates).
   Run: node --test test/v20-discovery-money.test.js
   Lib-level (own temp SQLite, migrated): C1b net-zero deposit, C2b
   zero-commission settlement, C3 scratch ends_at, C4 turnover netting,
   C5 cancelDraw commission void + bonus wagering reversal, migration
   v21 shape. HTTP-level proofs (C1a save validation, C6 decimals,
   C7 double-submit) live in v20-discovery-fixes.test.js. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-dfixb-money-'));
process.env.SQLITE_PATH = path.join(TMP, 'money.sqlite');
process.env.DB_DRIVER = 'sqlite';
delete process.env.DATABASE_URL;
delete process.env.SMTP_HOST;
process.env.TICKET_HMAC_SECRET = 'dfixb-money-hmac-secret-0123456789';

const { openDB } = require('../lib/db');
const { migrate } = require('../lib/migrations');
const { ensureScratchSchema } = require('../lib/scratch');
const money = require('../lib/money');
const bonus = require('../lib/bonus');
const draws = require('../lib/draws');
const scratch = require('../lib/scratch');
const { now } = require('../lib/util');

const { db } = openDB();
let seq = 0;

test.before(async () => {
  await migrate(db, 'sqlite');
  await ensureScratchSchema(db, 'sqlite');
});
test.after(async () => { await db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

async function mkUser(role = 'player') {
  seq += 1;
  const r = await db.run(
    "INSERT INTO users (email, name, password_hash, role, status, email_verified, created_at) VALUES (?, ?, 'x', ?, 'active', 1, ?)",
    ['dfixbm' + seq + '@test.dev', 'DFIXB ' + seq, role, now()]);
  return r.id;
}
const wallet = async (uid) => {
  const r = await db.get('SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE user_id = ?', [uid]);
  return Number(r.s);
};

test('migration v21: commissions.voided, notifications_log.attempts, agent_transfers.idempotency_key + UNIQUE index', async () => {
  const cols = async (t) => (await db.query(`PRAGMA table_info(${t})`)).map((c) => c.name);
  assert.ok((await cols('commissions')).includes('voided'));
  assert.ok((await cols('commissions')).includes('voided_at'));
  assert.ok((await cols('notifications_log')).includes('attempts'));
  assert.ok((await cols('agent_transfers')).includes('idempotency_key'));
  const idx = await db.query("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_agent_transfers_idem'");
  assert.equal(idx.length, 1);
});

test('D1-C1b: a pre-existing net-0 deposit (100% charge) approves cleanly — terminal state, no wallet change, audited', async () => {
  const u = await mkUser();
  const m = await db.run(
    "INSERT INTO payment_methods (name, slug, kind, rail, currency, min_amount, max_amount, fixed_charge, percent_charge, custom_fields, enabled, sort) VALUES ('DFIXB Full Charge', 'dfixb-full', 'deposit', 'cards', 'USD', 100, 0, 0, 100, '[]', 1, 99)");
  const methodRow = await db.get('SELECT * FROM payment_methods WHERE id = ?', [m.id]);
  const dep = await money.createDeposit(db, { userId: u, method: methodRow, amountMinor: 1000, userData: {} });
  const depRow = await db.get('SELECT net FROM deposits WHERE id = ?', [dep.id]);
  assert.equal(Number(depRow.net), 0, 'fixture sanity: net is 0');
  await money.decideDeposit(db, dep.id, 'approve', 1, { bonus_enabled: '0' }); // returns the pre-decision row; the DB row below is the proof
  const row = await db.get('SELECT status, charge FROM deposits WHERE id = ?', [dep.id]);
  assert.equal(row.status, 'approved', 'not stuck pending');
  assert.equal(Number(row.charge), 1000, 'the charge is still recorded on the deposit');
  assert.equal(await wallet(u), 0, 'no wallet movement for a zero credit');
  const zeroTx = await db.query("SELECT id FROM transactions WHERE type = 'deposit' AND user_id = ?", [u]);
  assert.equal(zeroTx.length, 0, 'no zero-amount ledger row was posted');
  const aud = await db.query("SELECT id FROM audit_log WHERE action = 'deposit.approve_zero_net'");
  assert.ok(aud.length >= 1, 'the zero-net approval is audited');
});

test('D1-C2b: settlement survives a planted zero commission row and pays the real rows', async () => {
  const agent = await mkUser('agent');
  const player = await mkUser();
  await db.run('INSERT INTO commissions (agent_id, user_id, currency, amount, rate, settled, created_at) VALUES (?, ?, ?, 0, 5, 0, ?)', [agent, player, 'USD', now()]);
  await db.run('INSERT INTO commissions (agent_id, user_id, currency, amount, rate, settled, created_at) VALUES (?, ?, ?, 250, 5, 0, ?)', [agent, player, 'USD', now()]);
  const res = await money.settleAgentCommissions(db, agent, 1);
  assert.equal(res.total, 250);
  assert.equal(res.settled, 2, 'both rows consumed — the zero row no longer poisons settlement');
  assert.equal(await wallet(agent), 250, 'the real commission reached the agent wallet');
  const unsettled = await db.get('SELECT COUNT(*) AS c FROM commissions WHERE agent_id = ? AND settled = 0', [agent]);
  assert.equal(Number(unsettled.c), 0, 'zero row was consumed, not left poisoning the next settle');
});

test('D1-C4: the withdrawal turnover gate nets draw_refund (deposit -> buy -> cancel -> refund reads wagered 0)', async () => {
  const u = await mkUser();
  await db.run(
    "INSERT INTO deposits (public_id, user_id, method_id, currency, amount, charge, net, status, idempotency_key, created_at) VALUES (?, ?, 1, 'USD', 1000, 0, 1000, 'approved', ?, ?)",
    ['depD1C4' + seq, u, 'idemD1C4' + seq, now()]);
  await money.postLedger(db, { userId: u, currency: 'USD', type: 'deposit', amount: 1000, refType: 'deposit', refId: 'depD1C4' + seq });
  await money.postLedger(db, { userId: u, currency: 'USD', type: 'ticket_purchase', amount: -1000, refType: 'ticket', refId: 'TD1C4' });
  const method = { currency: 'USD', min_amount: 0, max_amount: 0, fixed_charge: 0, percent_charge: 0, rail: 'cards' };
  const userRow = await db.get('SELECT * FROM users WHERE id = ?', [u]);
  const settings = { withdrawal_turnover_required: '1', bonus_enabled: '0' };
  const before = await money.checkWithdrawalRules(db, settings, userRow, method, 100);
  assert.ok(before.ok || !/turnover|Wagering requirement/.test(before.reason || ''), 'with the stake live, the turnover gate is satisfied: ' + (before.reason || 'ok'));
  await money.postLedger(db, { userId: u, currency: 'USD', type: 'draw_refund', amount: 1000, refType: 'ticket', refId: 'TD1C4' });
  const after = await money.checkWithdrawalRules(db, settings, userRow, method, 100);
  assert.equal(after.ok, false);
  assert.match(after.reason, /Wagering requirement not met: you have wagered \$0\.00 of \$10\.00/, 'refunded stake no longer counts as wagered');
});

test('D1-C3: scratch buy refuses a series past ends_at with the true reason and no charge; future ends_at sells', async () => {
  const u = await mkUser();
  await money.postLedger(db, { userId: u, currency: 'USD', type: 'deposit', amount: 10000, refType: 'test', refId: 'seed' });
  const mkSeries = async (slug, endsAt) => {
    const r = await db.run(
      "INSERT INTO scratch_series (title, slug, game_type, currency, price, total_tickets, status, enabled, server_seed, seed_hash, created_by, created_at, ends_at) VALUES ('T', ?, 'single', 'USD', 100, 10, 'live', 1, 'seed', 'hash', 1, ?, ?)",
      [slug, now(), endsAt]);
    await db.run('INSERT INTO scratch_outcomes (series_id, ordinal, nonce, prize, commitment) VALUES (?, 1, 1, 0, ?)', [r.id, 'c' + slug]);
    return r.id;
  };
  const ended = await mkSeries('dfixb-ended', now() - 60000);
  await assert.rejects(() => scratch.buyTicket(db, u, ended, '127.0.0.1'), /This series has ended\./);
  assert.equal(await wallet(u), 10000, 'no charge for the ended series');
  const live = await mkSeries('dfixb-live', now() + 3600000);
  const t = await scratch.buyTicket(db, u, live, '127.0.0.1');
  assert.ok(t && t.publicId, 'future ends_at series sells normally');
  assert.equal(await wallet(u), 9900);
});

test('D1-C5: draw cancel voids unsettled commissions for the draw and reverses bonus wagering; settled commissions are untouched', async () => {
  const agent = await mkUser('agent');
  const u = await mkUser();
  await db.run('UPDATE users SET agent_id = ? WHERE id = ?', [agent, u]);
  await money.postLedger(db, { userId: u, currency: 'USD', type: 'deposit', amount: 5000, refType: 'test', refId: 'seed5' });
  // Bonus grant with wagering progress from the buy (stored-counter mechanism).
  const camp = await db.run(
    "INSERT INTO bonus_campaigns (name, audience, audience_n, amount_type, amount, currency, trigger_type, starts_at, ends_at, wagering_x, per_user_cap, budget_cap, granted_total, active, last_drop_at, created_by, created_at) VALUES ('D1C5', 'all', 0, 'fixed', 100, 'USD', 'manual', 0, 0, 1, 0, 0, 0, 1, 0, NULL, ?)", [now()]);
  await db.run("INSERT INTO bonus_grants (campaign_id, user_id, currency, amount, wagering_required, wagered, created_at) VALUES (?, ?, 'USD', 100, 100, 0, ?)", [camp.id, u, now()]);
  await bonus.accrueWagering(db, u, 'USD', 1000);
  assert.equal(await bonus.unmetWagering(db, u, 'USD'), 0, 'fixture sanity: buy progress met the requirement');
  // Draw + ticket + entry + one unsettled and one already-settled commission.
  const d = await db.run(
    "INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, is_test, created_at) VALUES ('DAY', '2099-01-01', ?, 'scheduled', 'h', 's', 0, ?)",
    [now() + 3600000, now()]);
  const t = await db.run(
    "INSERT INTO tickets (public_id, user_id, currency, pops, wager, num_draws, draw_type, draw_ids, total, status, hmac, created_at) VALUES (?, ?, 'USD', '[5]', 1000, 1, 'DAY', ?, 1000, 'active', 'x', ?)",
    ['TD1C5' + seq, u, JSON.stringify([d.id]), now()]);
  await db.run("INSERT INTO ticket_entries (ticket_id, draw_id, status) VALUES (?, ?, 'pending')", [t.id, d.id]);
  await money.postLedger(db, { userId: u, currency: 'USD', type: 'ticket_purchase', amount: -1000, refType: 'ticket', refId: 'TD1C5' + seq });
  const cUn = await db.run('INSERT INTO commissions (agent_id, user_id, ticket_id, currency, amount, rate, settled, created_at) VALUES (?, ?, ?, ?, 50, 5, 0, ?)', [agent, u, t.id, 'USD', now()]);
  const cSet = await db.run('INSERT INTO commissions (agent_id, user_id, ticket_id, currency, amount, rate, settled, created_at) VALUES (?, ?, ?, ?, 70, 5, 1, ?)', [agent, u, t.id, 'USD', now()]);

  const out = await draws.cancelDraw(db, d.id, { bonus_enabled: '1' }, { actorId: 1 });
  assert.equal(out.commissionsVoided, 1);
  const un = await db.get('SELECT settled, voided FROM commissions WHERE id = ?', [cUn.id]);
  assert.equal(Number(un.voided), 1, 'unsettled commission voided by the cancel');
  assert.equal(Number(un.settled), 1, 'and closed, so settlement can never pay it');
  const st = await db.get('SELECT settled, voided FROM commissions WHERE id = ?', [cSet.id]);
  assert.equal(Number(st.voided || 0), 0, 'already-settled commission NOT clawed back (honest boundary)');
  assert.equal(await bonus.unmetWagering(db, u, 'USD'), 100, 'refunded stake no longer counts: wagering progress reversed in full');
  const settle = await money.settleAgentCommissions(db, agent, 1);
  assert.equal(settle.total, 0, 'the voided commission is no longer settleable');
  assert.equal(settle.settled, 0);
});
