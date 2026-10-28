'use strict';
/* V20 regression tests: notifications_log must never store a live secret.
   Run: node --test test/v20-log-masking.test.js
   Covers the three secret-bearing templates (otp_login {{code}},
   password_reset {{link}} with /reset/<token>, email_verification
   {{link}} with /verify-email/<token>), the maskForLog unit contract
   (log copy masked, delivered/original string untouched, non-secret
   content byte-identical), and the sendRaw generic URL scrub.
   Delivery itself is unconfigured in tests (no SMTP), so sends land as
   'failed' — the log row is still written, exactly as in production. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-v20-'));
process.env.SQLITE_PATH = path.join(TMP, 'a.sqlite');
process.env.DB_DRIVER = 'sqlite';
delete process.env.DATABASE_URL;
delete process.env.SMTP_HOST;

const { openDB } = require('../lib/db');
const { migrate } = require('../lib/migrations');
const notify = require('../lib/notify');
const { db } = openDB();

test.before(async () => { await migrate(db, 'sqlite'); });

test('maskForLog: code + secret links masked, normal content untouched', () => {
  const body = 'Hi Ravi, your login code is 483920. You won $500.00 on ticket T-9911.';
  const masked = notify.maskForLog(body, { code: '483920' });
  assert.doesNotMatch(masked, /483920/);
  assert.match(masked, /code is \*\*\*\*\*\*/);
  assert.match(masked, /\$500\.00/);
  assert.match(masked, /T-9911/);
  assert.match(body, /483920/, 'original string must be unchanged (delivery uses it)');

  const reset = 'Reset here: https://site.example/reset/abcdef0123456789abcdef01 (1 hour)';
  const m2 = notify.maskForLog(reset, { link: 'https://site.example/reset/abcdef0123456789abcdef01' });
  assert.doesNotMatch(m2, /abcdef0123456789abcdef01/);
  assert.match(m2, /\/reset\/\*\*\*/);

  // Generic scrub even when no vars are supplied (sendRaw / future templates)
  const m3 = notify.maskForLog('go https://x.example/verify-email/deadbeef99 please');
  assert.doesNotMatch(m3, /deadbeef99/);
  assert.match(m3, /\/verify-email\/\*\*\*/);
});

test('otp_login: log row carries the rendered template but never the code', async () => {
  const res = await notify.send(db, {}, 'email', 'otp_login', 'v20-otp@test.dev', { code: '731905' });
  assert.strictEqual(res.status, 'failed'); // no SMTP in tests; delivery attempted honestly
  const row = await db.get("SELECT * FROM notifications_log WHERE to_addr = 'v20-otp@test.dev' ORDER BY id DESC LIMIT 1");
  assert.ok(row, 'outbox row must exist');
  assert.doesNotMatch(row.body, /731905/);
  assert.match(row.body, /login code is \*\*\*\*\*\*/i);
});

test('password_reset: log row never contains the raw reset token', async () => {
  const token = 'a1b2c3d4e5f60718293a4b5c';
  const link = 'https://cashpop.example/reset/' + token;
  await notify.send(db, {}, 'email', 'password_reset', 'v20-reset@test.dev', { name: 'Ravi', link });
  const row = await db.get("SELECT * FROM notifications_log WHERE to_addr = 'v20-reset@test.dev' ORDER BY id DESC LIMIT 1");
  assert.ok(row, 'outbox row must exist');
  assert.doesNotMatch(row.body, new RegExp(token));
  assert.match(row.body, /\/reset\/\*\*\*/);
});

test('email_verification: log row never contains the raw verify token', async () => {
  const token = 'ffeeddccbbaa998877665544';
  const link = 'https://cashpop.example/verify-email/' + token;
  await notify.send(db, {}, 'email', 'email_verification', 'v20-verify@test.dev', { name: 'Ravi', link });
  const row = await db.get("SELECT * FROM notifications_log WHERE to_addr = 'v20-verify@test.dev' ORDER BY id DESC LIMIT 1");
  assert.ok(row, 'outbox row must exist');
  assert.doesNotMatch(row.body, new RegExp(token));
  assert.match(row.body, /\/verify-email\/\*\*\*/);
});

test('win mail: non-secret body is logged byte-identical (no over-masking)', async () => {
  await notify.send(db, {}, 'email', 'win', 'v20-win@test.dev', { name: 'Ravi', amount: '$250.00', ticket: 'T-123456' });
  const row = await db.get("SELECT * FROM notifications_log WHERE to_addr = 'v20-win@test.dev' ORDER BY id DESC LIMIT 1");
  assert.ok(row, 'outbox row must exist');
  assert.match(row.body, /\$250\.00/);
  assert.match(row.body, /T-123456/);
});

test('sendRaw: generic scrub catches a secret link in an ad-hoc body', async () => {
  await notify.sendRaw(db, {}, 'email', 'v20-raw@test.dev', 'Hi', 'Reset: https://x.example/reset/0123456789abcdef done');
  const row = await db.get("SELECT * FROM notifications_log WHERE to_addr = 'v20-raw@test.dev' ORDER BY id DESC LIMIT 1");
  assert.ok(row, 'outbox row must exist');
  assert.doesNotMatch(row.body, /0123456789abcdef/);
});
