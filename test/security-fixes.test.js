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
