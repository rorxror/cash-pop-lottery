'use strict';
/* v23 HUNT — money regression suite for the cross-examined findings:
   H2-01 decimal-scale exchange (JPY/KWD mint/loss), H2-02 duplicate
   proof double-credit, H2-05 cap scaling per currency, H2-06 deposit
   bonus wagering invisibility, H2-04 minor-unit conversions in the
   PayPal/Skrill normalizers, H2-03 generic-webhook refund of a
   MANUALLY approved deposit (spawned server, signed webhook). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENC_KEY = 'c1c2c3c4'.repeat(8); // 64 hex chars, throwaway test key
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-hunt-'));
process.env.SQLITE_PATH = path.join(TMP, 'a.sqlite');
process.env.DB_DRIVER = 'sqlite';
process.env.CREDENTIAL_ENCRYPTION_KEY = ENC_KEY;

const { openDB } = require('../lib/db');
const { migrate } = require('../lib/migrations');
const { getSettings, setSetting } = require('../lib/settings');
const money = require('../lib/money');
const { convertMinor } = require('../lib/util');
const bonus = require('../lib/bonus');
const paypal = require('../lib/paypal');
const skrill = require('../lib/skrill');

let db, settings;
const CURR = [
  { code: 'USD', symbol: '$', rate: 1, decimals: 2 },
  { code: 'EUR', symbol: '€', rate: 0.92, decimals: 2 },
  { code: 'JPY', symbol: '¥', rate: 150, decimals: 0 },
  { code: 'KWD', symbol: 'KD', rate: 0.3, decimals: 3 },
];

test.before(async () => {
  db = openDB().db;
  await migrate(db, 'sqlite');
  await setSetting(db, 'sqlite', 'currencies', JSON.stringify(CURR));
  await setSetting(db, 'sqlite', 'base_currency', 'USD');
  settings = await getSettings(db, 'sqlite', true);
});

async function mkUser(email) {
  const r = await db.run("INSERT INTO users (name, email, phone, password_hash, role, status, email_verified, created_at) VALUES ('Hunt Player', ?, '', 'x', 'player', 'active', 1, ?)", [email, Date.now()]);
  return r.id;
}
async function mkMethod(rail, currency) {
  const r = await db.run("INSERT INTO payment_methods (kind, name, slug, rail, currency, min_amount, max_amount, fixed_charge, percent_charge, enabled, sort) VALUES ('both', ?, ?, ?, ?, 0, 0, 0, 0, 1, 1)",
    ['Hunt ' + rail + ' ' + currency, 'hunt-' + rail + '-' + currency.toLowerCase() + '-' + Math.random().toString(36).slice(2, 7), rail, currency]);
  return db.get('SELECT * FROM payment_methods WHERE id = ?', [r.id]);
}
async function bal(userId, currency) {
  const w = await db.get('SELECT balance FROM wallets WHERE user_id = ? AND currency = ?', [userId, currency]);
  return w ? Number(w.balance) : 0;
}

test('H2-01: exchangeQuote + convertMinor respect decimal scale (JPY 0, KWD 3)', async () => {
  // $10.00 (1000 minor) at rate 150 -> ¥1,500 (1500 minor), NOT ¥150,000.
  assert.equal(money.exchangeQuote(CURR, 'USD', 'JPY', 1000, 0).gross, 1500);
  // ¥10,000 (10000 minor) -> $66.66 (6666 minor, floored), NOT $0.66.
  assert.equal(money.exchangeQuote(CURR, 'JPY', 'USD', 10000, 0).gross, 6666);
  // $10.00 at rate 0.3 -> KD 3.000 (3000 minor), NOT KD 0.300.
  assert.equal(money.exchangeQuote(CURR, 'USD', 'KWD', 1000, 0).gross, 3000);
  // Same-decimal pairs are unchanged.
  assert.equal(money.exchangeQuote(CURR, 'USD', 'EUR', 1000, 0).gross, 920);
  assert.equal(convertMinor(1000, 'USD', 'JPY', CURR), 1500);
  assert.equal(convertMinor(10000, 'JPY', 'USD', CURR), 6667);
  assert.equal(convertMinor(1000, 'USD', 'KWD', CURR), 3000);
  // E2E: the credited wallet amount is the scaled one.
  const u = await mkUser('h-exchange@example.com');
  await db.transaction(async (tx) => { await money.postLedger(tx, { userId: u, currency: 'USD', type: 'adjustment', amount: 10000, refType: 'test', refId: 'seed1' }); });
  const r = await money.exchangeCurrency(db, { userId: u, from: 'USD', to: 'JPY', amountMinor: 1000, settings });
  assert.equal(r.credit, 1500);
  assert.equal(await bal(u, 'JPY'), 1500);
  assert.equal(await bal(u, 'USD'), 9000);
});

test('H2-02: the same payment proof can never fund two deposits', async () => {
  const m = await mkMethod('crypto', 'USD');
  const a = await mkUser('h-proof-a@example.com');
  const b = await mkUser('h-proof-b@example.com');
  const HASH = 'abcd1234'.repeat(8);
  const d1 = await money.createDeposit(db, { userId: a, method: m, amountMinor: 10000, userData: { tx_hash: HASH }, settings });
  assert.ok(d1.id);
  // Same user again, and a DIFFERENT user — both refused at creation.
  await assert.rejects(() => money.createDeposit(db, { userId: a, method: m, amountMinor: 5000, userData: { tx_hash: HASH }, settings }), /already been submitted/);
  await assert.rejects(() => money.createDeposit(db, { userId: b, method: m, amountMinor: 5000, userData: { tx_hash: HASH.toUpperCase() }, settings }), /already been submitted/);
  await money.decideDeposit(db, d1.id, 'approve', 1, settings);
  assert.equal(await bal(a, 'USD'), 10000);
  // A duplicate row slipped in directly (bypassing create) is blocked at
  // APPROVAL time, inside the decision transaction — no credit posts.
  const ins = await db.run("INSERT INTO deposits (public_id, user_id, method_id, currency, amount, charge, net, status, user_data, idempotency_key, created_at) VALUES ('DHUNTDUP', ?, ?, 'USD', 7000, 0, 7000, 'pending', ?, ?, ?)",
    [b, m.id, money.encodeUserData({ tx_hash: HASH }), 'dup_' + Math.random().toString(36).slice(2), Date.now()]);
  await assert.rejects(() => money.decideDeposit(db, ins.id, 'approve', 1, settings), /Duplicate payment proof/);
  assert.equal(await bal(b, 'USD'), 0, 'blocked approval credited nothing');
  assert.equal((await db.get('SELECT status FROM deposits WHERE id = ?', [ins.id])).status, 'pending', 'blocked approval leaves the deposit pending');
});

test('H2-06: deposit bonus is wagering-tracked (grant exists, dies on revoke)', async () => {
  const m = await mkMethod('bank_transfer', 'USD');
  const u = await mkUser('h-bonus@example.com');
  const s2 = await getSettings(db, 'sqlite', true);
  s2.deposit_bonus_percent = '10';
  const d = await money.createDeposit(db, { userId: u, method: m, amountMinor: 10000, userData: { reference: 'BANKREF-HUNT-1' }, settings: s2 });
  await money.decideDeposit(db, d.id, 'approve', 1, s2);
  assert.equal(await bal(u, 'USD'), 11000, 'net + 10% bonus credited');
  const g = await db.get("SELECT * FROM bonus_grants WHERE user_id = ? AND trigger_type = 'deposit_bonus'", [u]);
  assert.ok(g, 'a wagering grant exists for the deposit bonus');
  assert.equal(Number(g.amount), 1000);
  assert.equal(Number(g.wagering_required), 1000, 'bonus must be wagered 1x before withdrawal');
  assert.equal(await bonus.unmetWagering(db, u, 'USD'), 1000, 'the withdrawal gate can SEE the bonus now');
  await money.decideDeposit(db, d.id, 'revoke', 1, s2);
  assert.equal(await bal(u, 'USD'), 0, 'revoke claws back net + bonus');
  assert.equal(await bonus.unmetWagering(db, u, 'USD'), 0, 'grant died with the clawback');
});

test('H2-05: global caps mean the same typed amount in every currency', async () => {
  const s3 = await getSettings(db, 'sqlite', true);
  s3.deposit_daily_cap = '50000'; // typed "500.00" at the admin door (stored hundredths)
  const mJ = await mkMethod('bank_transfer', 'JPY');
  const mU = await mkMethod('bank_transfer', 'USD');
  const u = await mkUser('h-caps@example.com');
  // JPY: the cap is ¥500 — a ¥600 deposit is refused, ¥400 passes.
  await assert.rejects(() => money.createDeposit(db, { userId: u, method: mJ, amountMinor: 600, userData: { reference: 'CAP-JPY-1' }, settings: s3 }), /Daily deposit limit/);
  const ok = await money.createDeposit(db, { userId: u, method: mJ, amountMinor: 400, userData: { reference: 'CAP-JPY-2' }, settings: s3 });
  assert.ok(ok.id);
  // USD: the cap is $500.00 (50000 minor) — a $600 deposit is refused.
  await assert.rejects(() => money.createDeposit(db, { userId: u, method: mU, amountMinor: 60000, userData: { reference: 'CAP-USD-1' }, settings: s3 }), /Daily deposit limit/);
});

test('H2-04: PayPal/Skrill normalizers convert with the currency decimals', () => {
  const cap = paypal.normalizeCapture({ id: 'CAP1', status: 'COMPLETED', amount: { value: '1500', currency_code: 'JPY' }, payee: {} }, 0);
  assert.equal(cap.amountMinor, 1500, '¥1500 capture is 1500 minor, not 150000');
  const cap2 = paypal.normalizeCapture({ id: 'CAP2', status: 'COMPLETED', amount: { value: '15.00', currency_code: 'USD' }, payee: {} }, 2);
  assert.equal(cap2.amountMinor, 1500);
  const sr = skrill.parseStatusReport({ mb_amount: '1500', mb_currency: 'JPY', status: '2' }, 0);
  assert.equal(sr.amountMinor, 1500);
  assert.equal(sr.amountMajor, 1500);
  const sr2 = skrill.parseStatusReport({ mb_amount: '3.000', mb_currency: 'KWD', status: '2' }, 3);
  assert.equal(sr2.amountMinor, 3000);
});

/* ------------- Part B (spawned): H2-03 generic refund ------------- */
const PORT_B = 4261, BASE_B = `http://127.0.0.1:${PORT_B}`;
const DBP_B = path.join(TMP, 'b.sqlite');
let serverB, dbB;

function sign(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

test('H2-03: a signed refund webhook revokes a MANUALLY approved deposit (provider_txn_id NULL)', { timeout: 90000 }, async () => {
  const env = { ...process.env, PORT: String(PORT_B), BASE_URL: BASE_B, DB_DRIVER: 'sqlite', SQLITE_PATH: DBP_B,
    TICKET_HMAC_SECRET: ['hunt', 'test', 'hmac'].join('-'),
    CREDENTIAL_ENCRYPTION_KEY: ENC_KEY,
    ADMIN_SEED_EMAIL: 'hunt-admin@example.com', ADMIN_SEED_PASSWORD: 'HuntAdminPass-2026', ADMIN_SEED_NAME: 'Hunt Admin' };
  delete env.DATABASE_URL;
  serverB = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  serverB.stderr.on('data', d => process.stderr.write('[hunt server] ' + d));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { try { const r = await fetch(BASE_B + '/healthz'); up = r.status === 200; } catch {} if (!up) await new Promise(r => setTimeout(r, 500)); }
  assert.ok(up, 'server boots');
  process.env.SQLITE_PATH = DBP_B;
  dbB = require('../lib/db').openDB().db;
  const sB = await getSettings(dbB, 'sqlite', true);
  // AUTO crypto method with a webhook secret, driven at lib level.
  const { saveCredentialField } = require('../lib/credentials');
  const mRow = await dbB.get("SELECT * FROM payment_methods WHERE slug = 'rail-crypto'");
  await dbB.run("UPDATE payment_methods SET enabled = 1, processing_mode = 'auto' WHERE id = ?", [mRow.id]);
  await saveCredentialField(dbB, mRow.id, 'webhook_secret', 'huntWhsec123');
  const uid = (await dbB.run("INSERT INTO users (name, email, phone, password_hash, role, status, email_verified, created_at) VALUES ('Hunt B', 'huntb@example.com', '', 'x', 'player', 'active', 1, ?)", [Date.now()])).id;
  const HASH = 'f1e2d3c4'.repeat(8);
  const dep = await money.createDeposit(dbB, { userId: uid, method: mRow, amountMinor: 20000, userData: { tx_hash: HASH }, settings: sB });
  await money.decideDeposit(dbB, dep.id, 'approve', 1, sB); // MANUAL approval — provider_txn_id stays NULL
  const depRow = await dbB.get('SELECT * FROM deposits WHERE id = ?', [dep.id]);
  assert.equal(depRow.status, 'approved');
  assert.ok(!depRow.provider_txn_id, 'manually approved: no provider txn id (the H2-03 precondition)');
  const w0 = await dbB.get('SELECT balance FROM wallets WHERE user_id = ? AND currency = ?', [uid, 'USD']);
  assert.equal(Number(w0.balance), 20000);
  // Signed refund webhook referencing the PROOF (not a provider txn id).
  const payload = JSON.stringify({ event_id: 'evt_hunt_refund1', txn_id: HASH, status: 'refunded', amount: 20000, currency: 'USD' });
  const r = await fetch(BASE_B + '/webhooks/crypto', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': sign('huntWhsec123', payload) }, body: payload });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.note || '', /revoked/, 'refund is applied, not merely recorded: ' + (j.note || ''));
  assert.equal((await dbB.get('SELECT status FROM deposits WHERE id = ?', [dep.id])).status, 'revoked');
  const w1 = await dbB.get('SELECT balance FROM wallets WHERE user_id = ? AND currency = ?', [uid, 'USD']);
  assert.equal(Number(w1.balance), 0, 'reversal removes exactly the credited amount');
  const aud = await dbB.get("SELECT id FROM audit_log WHERE action = 'webhook.deposit_revoked' AND entity_id = ?", [depRow.public_id]);
  assert.ok(aud, 'the reversal is audit-visible');
  serverB.kill();
});
