'use strict';
/* Security-fix regression tests (2026-10-27 audit round).
   Run: node --test test/security-fixes.test.js
   These tests fail on the pre-fix code and pass after:
   - OTP codes were Math.random() and returned in API responses (demo mode).
   - Webhook "verification" accepted any present signature header.
   - Ledger posts did read-balance-then-write (double-spend race). */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Keep provider env out of these tests so "no provider configured" is real.
delete process.env.SMS_PROVIDER;
delete process.env.TWILIO_SID;
delete process.env.TWILIO_TOKEN;
delete process.env.TWILIO_FROM;

const otp = require('../lib/otp');
const { verifyWebhookSignature } = require('../lib/rails');
const { postLedger } = require('../lib/money');

test('OTP codes are 6 digits (crypto range, never short/leading-zero broken)', () => {
  for (let i = 0; i < 500; i++) {
    const c = otp.generateCode();
    assert.match(c, /^\d{6}$/);
    assert.ok(Number(c) >= 100000 && Number(c) <= 999999);
  }
});

test('sendOtp with no provider sends nothing and NEVER returns a code', async () => {
  const fakeDb = {
    get: async () => { throw new Error('no db'); },
    run: async () => { throw new Error('no db'); },
    query: async () => [],
  };
  const phone = await otp.sendOtp(fakeDb, {}, '+15550001111', 'phone', '123456');
  assert.equal(phone.sent, false);
  assert.equal('code' in phone, false);
  const email = await otp.sendOtp(fakeDb, {}, 'victim@example.com', 'email', '123456');
  assert.equal(email.sent, false);
  assert.equal('code' in email, false);
});

test('webhook signature: real HMAC passes, forged/missing/no-secret fails', () => {
  const secret = 'test-webhook-secret';
  const body = Buffer.from('{"event":"paid","amount":1000}');
  const good = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const mkReq = (sig) => ({ body, headers: sig ? { 'x-signature': sig } : {} });
  const methods = [{ id: 7, webhook_secret: secret }];
  assert.equal(verifyWebhookSignature('test', mkReq(good), methods).ok, true);
  assert.equal(verifyWebhookSignature('test', mkReq(good), methods).methodId, 7);
  assert.equal(verifyWebhookSignature('test', mkReq('sha256=' + good), methods).ok, true);
  assert.equal(verifyWebhookSignature('test', mkReq('deadbeef'), methods).ok, false);
  assert.equal(verifyWebhookSignature('test', mkReq(null), methods).ok, false);
  assert.equal(verifyWebhookSignature('test', mkReq(good), [{ id: 7 }]).ok, false);
  assert.equal(verifyWebhookSignature('test', mkReq(good), []).ok, false);
});

test('postLedger: guarded update refuses overdraft and keeps balance exact', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-test-')), 't.sqlite');
  const raw = new DatabaseSync(tmp);
  raw.exec(`CREATE TABLE wallets (user_id INTEGER, currency TEXT, balance INTEGER);
            CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, currency TEXT, type TEXT, amount INTEGER, balance_after INTEGER, ref_type TEXT, ref_id TEXT, meta TEXT, created_at INTEGER);`);
  const tx = {
    get: (s, p = []) => Promise.resolve(raw.prepare(s).get(...p)),
    run: (s, p = []) => { const r = raw.prepare(s).run(...p); return Promise.resolve({ id: Number(r.lastInsertRowid), changes: r.changes }); },
  };
  await postLedger(tx, { userId: 1, currency: 'USD', type: 'credit', amount: 100, refType: 't', refId: 'a' });
  let w = raw.prepare('SELECT balance FROM wallets WHERE user_id = 1').get();
  assert.equal(w.balance, 100);
  await assert.rejects(
    postLedger(tx, { userId: 1, currency: 'USD', type: 'debit', amount: -150, refType: 't', refId: 'b' }),
    /Insufficient balance/
  );
  w = raw.prepare('SELECT balance FROM wallets WHERE user_id = 1').get();
  assert.equal(w.balance, 100); // failed debit changed nothing
  await postLedger(tx, { userId: 1, currency: 'USD', type: 'debit', amount: -100, refType: 't', refId: 'c' });
  w = raw.prepare('SELECT balance FROM wallets WHERE user_id = 1').get();
  assert.equal(w.balance, 0);
  // The guard itself, at SQL level: two -100 debits against a 100 balance —
  // exactly one UPDATE may affect a row.
  raw.prepare('UPDATE wallets SET balance = 100 WHERE user_id = 1').run();
  const guard = 'UPDATE wallets SET balance = balance + ? WHERE user_id = ? AND currency = ? AND balance + ? >= 0';
  const first = raw.prepare(guard).run(-100, 1, 'USD', -100);
  const second = raw.prepare(guard).run(-100, 1, 'USD', -100);
  assert.equal(first.changes, 1);
  assert.equal(second.changes, 0);
  raw.close();
});

/* ---------------- v14 additions ---------------- */

test('beacon draw: combined seed is deterministic, rejection sampling stays in 1..15', () => {
  const { combineSeed, deriveWinningNumberFair, deriveWinningNumberLegacy } = require('../lib/beacon');
  assert.equal(combineSeed('seed-abc', 'beacon-xyz'), combineSeed('seed-abc', 'beacon-xyz'));
  assert.notEqual(combineSeed('seed-abc', 'beacon-xyz'), combineSeed('seed-abc', 'beacon-other'));
  for (let id = 1; id <= 1000; id++) {
    const n = deriveWinningNumberFair(combineSeed('seed-' + id, 'beacon-round-9'), id);
    assert.ok(Number.isInteger(n) && n >= 1 && n <= 15, 'fair draw out of range: ' + n);
    const l = deriveWinningNumberLegacy('seed-' + id, id);
    assert.ok(l >= 1 && l <= 15);
  }
  // Fair derivation must actually differ from the legacy formula sometimes
  // (otherwise the beacon would be decorative, not decisive).
  let differs = false;
  for (let id = 1; id <= 100; id++) {
    if (deriveWinningNumberFair(combineSeed('seed-' + id, 'beacon-round-9'), id) !== deriveWinningNumberLegacy('seed-' + id, id)) { differs = true; break; }
  }
  assert.equal(differs, true);
});

test('credential encryption: round-trip, legacy plaintext passthrough, missing key refuses', () => {
  const prev = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  const creds = require('../lib/credentials');
  assert.equal(creds.keyConfigured(), true);
  const enc = creds.encryptField('my-provider-secret');
  assert.match(enc, /^v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
  assert.notEqual(enc, 'my-provider-secret');
  assert.equal(creds.decryptField(enc, 1), 'my-provider-secret');
  assert.equal(creds.decryptField('legacy-plaintext', 0), 'legacy-plaintext');
  assert.equal(creds.decryptField('legacy-plaintext', null), 'legacy-plaintext');
  delete process.env.CREDENTIAL_ENCRYPTION_KEY;
  assert.equal(creds.keyConfigured(), false);
  assert.throws(() => creds.encryptField('x'), /not configured/i);
  if (prev !== undefined) process.env.CREDENTIAL_ENCRYPTION_KEY = prev;
});

test('audit hash-chain: verifies forward, breaks on tampering at the right row', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-audit-')), 'a.sqlite');
  const raw = new DatabaseSync(tmp);
  raw.exec(`CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, actor_role TEXT, action TEXT, entity TEXT, entity_id TEXT, detail TEXT, ip TEXT, created_at INTEGER, prev_hash TEXT, hash TEXT);`);
  const db = {
    get: (s, p = []) => Promise.resolve(raw.prepare(s).get(...p)),
    run: (s, p = []) => { const r = raw.prepare(s).run(...p); return Promise.resolve({ id: Number(r.lastInsertRowid), changes: r.changes }); },
    query: (s, p = []) => Promise.resolve(raw.prepare(s).all(...p)),
  };
  const audit = require('../lib/audit');
  await audit.log(db, { actorId: 1, actorRole: 'admin', action: 'a.one', entity: 'x', entityId: '1', detail: { v: 1 }, ip: '127.0.0.1' });
  await audit.log(db, { actorId: 1, actorRole: 'admin', action: 'a.two', entity: 'x', entityId: '2', detail: { v: 2 }, ip: '127.0.0.1' });
  await audit.log(db, { actorId: 2, actorRole: 'admin', action: 'a.three', entity: 'y', entityId: '3', detail: { v: 3 }, ip: '127.0.0.1' });
  let v = await audit.verifyChain(db);
  assert.equal(v.ok, true);
  assert.equal(v.checked, 3);
  raw.prepare("UPDATE audit_log SET detail = 'tampered' WHERE id = 2").run();
  v = await audit.verifyChain(db);
  assert.equal(v.ok, false);
  assert.equal(v.firstBadId, 2);
  raw.close();
});

test('withdrawal rules: turnover, caps, payout lock, same-method', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-wd-')), 'w.sqlite');
  const raw = new DatabaseSync(tmp);
  raw.exec(`CREATE TABLE deposits (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, status TEXT, currency TEXT, net INTEGER, method_id INTEGER, created_at INTEGER);
            CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, type TEXT, currency TEXT, amount INTEGER);
            CREATE TABLE withdrawals (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, status TEXT, currency TEXT, amount INTEGER, created_at INTEGER, method_id INTEGER);
            CREATE TABLE users (id INTEGER PRIMARY KEY, payout_updated_at INTEGER, payout_fingerprint TEXT);`);
  const db = {
    get: (s, p = []) => Promise.resolve(raw.prepare(s).get(...p)),
    run: (s, p = []) => { const r = raw.prepare(s).run(...p); return Promise.resolve({ id: Number(r.lastInsertRowid), changes: r.changes }); },
    query: (s, p = []) => Promise.resolve(raw.prepare(s).all(...p)),
  };
  const { checkWithdrawalRules } = require('../lib/money');
  const { now } = require('../lib/util');
  const method = { id: 5, currency: 'USD' };
  const user = { id: 1 };
  const base = { withdrawal_turnover_required: '1', withdrawal_daily_cap: '0', withdrawal_monthly_cap: '0', payout_lock_hours: '48', withdrawal_same_method: '0' };
  raw.prepare("INSERT INTO users (id, payout_updated_at, payout_fingerprint) VALUES (1, 0, '')").run();
  raw.prepare("INSERT INTO deposits (user_id, status, currency, net, method_id, created_at) VALUES (1, 'approved', 'USD', 10000, 5, ?)").run(now());
  // Turnover: deposited 10000, wagered 0 -> blocked.
  let r = await checkWithdrawalRules(db, base, user, method, 1000, { account: 'A1' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Wagering requirement/);
  // Wager it all -> allowed (first-ever payout details are free).
  raw.prepare("INSERT INTO transactions (user_id, type, currency, amount) VALUES (1, 'ticket_purchase', 'USD', -10000)").run();
  r = await checkWithdrawalRules(db, base, user, method, 1000, { account: 'A1' });
  assert.equal(r.ok, true);
  // Daily cap: cap 5000, existing pending 4000 today, new 2000 -> blocked.
  raw.prepare("INSERT INTO withdrawals (user_id, status, currency, amount, created_at, method_id) VALUES (1, 'pending', 'USD', 4000, ?, 5)").run(now());
  r = await checkWithdrawalRules(db, { ...base, withdrawal_daily_cap: '5000' }, user, method, 2000, { account: 'A1' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Daily withdrawal limit/);
  // Payout lock: stored fingerprint A changed just now, new details B -> blocked, clock NOT refreshed.
  raw.prepare("UPDATE users SET payout_fingerprint = ?, payout_updated_at = ? WHERE id = 1").run('fp-A', now());
  r = await checkWithdrawalRules(db, base, user, method, 1000, { account: 'B2' });
  assert.equal(r.ok, false);
  assert.equal(r.changeDetected, false);
  // Lock expired long ago -> blocked once WITH changeDetected (records the change).
  raw.prepare("UPDATE users SET payout_updated_at = ? WHERE id = 1").run(now() - 100 * 3600 * 1000);
  r = await checkWithdrawalRules(db, base, user, method, 1000, { account: 'B2' });
  assert.equal(r.ok, false);
  assert.equal(r.changeDetected, true);
  // Same details as stored BUT lock window still running -> blocked (the lock
  // is on the change, not on the details differing).
  const { sha256 } = require('../lib/util');
  const fpA1 = sha256(JSON.stringify({ account: 'A1' }));
  raw.prepare("UPDATE users SET payout_fingerprint = ?, payout_updated_at = ? WHERE id = 1").run(fpA1, now());
  r = await checkWithdrawalRules(db, base, user, method, 1000, { account: 'A1' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /locked for 48 hours/);
  assert.equal(r.changeDetected, false);
  // Same details as stored -> lock passes, so the same-method rule decides.
  // The fingerprint is sha256 of the sorted userData JSON (single key here).
  raw.prepare("UPDATE users SET payout_fingerprint = ?, payout_updated_at = 0 WHERE id = 1").run(fpA1);
  // Method 5 has an approved deposit -> allowed.
  r = await checkWithdrawalRules(db, { ...base, withdrawal_same_method: '1' }, user, method, 1000, { account: 'A1' });
  assert.equal(r.ok, true);
  // Method 9 never deposited with -> blocked by the same-method rule.
  r = await checkWithdrawalRules(db, { ...base, withdrawal_same_method: '1' }, user, { id: 9, currency: 'USD' }, 1000, { account: 'A1' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /deposited with before/);
  raw.close();
});

test('RBAC: role matrix, self-service TOTP, fail-closed on unknown POST', () => {
  const { canAccess } = require('../lib/rbac');
  const u = (role) => ({ admin_role: role });
  assert.equal(canAccess(u('finance'), 'POST', '/deposits/1/approve'), true);
  assert.equal(canAccess(u('finance'), 'POST', '/users/1/block'), false);
  assert.equal(canAccess(u('support'), 'POST', '/support/ABC/reply'), true);
  assert.equal(canAccess(u('support'), 'POST', '/deposits/1/approve'), false);
  assert.equal(canAccess(u('risk'), 'POST', '/draws/5/settle'), true);
  assert.equal(canAccess(u('risk'), 'POST', '/settings/toggles'), false);
  assert.equal(canAccess(u('finance'), 'POST', '/approvals/3/approve'), true);
  assert.equal(canAccess(u('support'), 'POST', '/security/totp/start'), true);
  assert.equal(canAccess(u('finance'), 'POST', '/mystery/action'), false);
  assert.equal(canAccess(u('support'), 'GET', '/deposits'), true);
  assert.equal(canAccess(u('support'), 'GET', '/settings'), true);
  assert.equal(canAccess({ admin_role: '' }, 'POST', '/settings/toggles'), true); // legacy admin = super
  assert.equal(canAccess(u('super'), 'POST', '/staff/2/role'), true);
  assert.equal(canAccess(u('finance'), 'POST', '/staff/2/role'), false);
});
