'use strict';
/* V20 OWNER-FIX — D-FIX-B cron/notify regression tests (D3 candidates).
   Run: node --test test/v20-discovery-cron.test.js
   Lib-level (own temp SQLite, migrated) + an in-process SMTP sink:
   C1 in-flight guard, C2 honest ensure_draws reporting + failure
   plumbing, C3 bonus drop stamping, C4 queued-batch retries with
   bounded attempts and off-period deferral, C9 expire_deposits
   provider-reference survival. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-dfixb-cron-'));
process.env.SQLITE_PATH = path.join(TMP, 'cron.sqlite');
process.env.DB_DRIVER = 'sqlite';
delete process.env.DATABASE_URL;
process.env.TICKET_HMAC_SECRET = 'dfixb-cron-hmac-secret-0123456789';
process.env.DRAND_API = 'http://127.0.0.1:9/dead'; // beacon endpoint dead on purpose (D3-C2)
const SMTP_PORT = 4499;
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(SMTP_PORT);
process.env.SMTP_FROM = 'noreply@dfixb.test';
delete process.env.SMTP_USER; delete process.env.SMTP_PASS; delete process.env.SMTP_SECURE;

const { openDB } = require('../lib/db');
const { migrate } = require('../lib/migrations');
const { ensureScratchSchema } = require('../lib/scratch');
const cron = require('../lib/cron');
const notify = require('../lib/notify');
const bonus = require('../lib/bonus');
const { getSettings } = require('../lib/settings');
const { now } = require('../lib/util');

const { db } = openDB();
let settings;

/* Minimal SMTP sink: enough of RFC 5321 for nodemailer. Captures DATA. */
const captured = [];
let sink = null;
function startSink() {
  return new Promise((resolve) => {
    sink = net.createServer((sock) => {
      let inData = false; let buf = '';
      sock.write('220 sink ESMTP\r\n');
      sock.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (inData) {
          buf += text;
          if (buf.includes('\r\n.\r\n')) { captured.push(buf); inData = false; sock.write('250 OK queued\r\n'); }
          return;
        }
        for (const line of text.split('\r\n').filter(Boolean)) {
          const cmd = line.split(' ')[0].toUpperCase();
          if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-sink\r\n250 8BITMIME\r\n');
          else if (cmd === 'DATA') { inData = true; buf = ''; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
          else if (cmd === 'QUIT') sock.write('221 Bye\r\n');
          else sock.write('250 OK\r\n');
        }
      });
      sock.on('error', () => {});
    });
    sink.listen(SMTP_PORT, '127.0.0.1', resolve);
  });
}
function stopSink() { return new Promise((resolve) => { if (!sink) return resolve(); sink.close(() => { sink = null; resolve(); }); }); }

test.before(async () => {
  await migrate(db, 'sqlite');
  await ensureScratchSchema(db, 'sqlite');
  settings = await getSettings(db);
  // cron_jobs are seeded by the server boot in production; this lib-level
  // DB needs the rows for the jobs under test.
  for (const key of Object.keys(cron.handlers)) {
    await db.run("INSERT OR IGNORE INTO cron_jobs (name, handler_key, interval_minutes, next_run_at, status, description) VALUES (?, ?, 60, ?, 'active', '')", [key, key, now() + 3600000]);
  }
});
test.after(async () => { await stopSink(); await db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

const ctx = { db, driver: 'sqlite' };
async function setJobDue(key) {
  await db.run("UPDATE cron_jobs SET status = 'active', next_run_at = ? WHERE handler_key = ?", [now() - 1000, key]);
}
async function jobRow(key) { return db.get('SELECT * FROM cron_jobs WHERE handler_key = ?', [key]); }
async function setSetting(key, value) {
  const ex = await db.get('SELECT key FROM settings WHERE key = ?', [key]);
  if (ex) await db.run('UPDATE settings SET value = ? WHERE key = ?', [value, key]);
  else await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
}

test('D3-C1: overlapping ticks run a slow job ONCE (in-flight guard); it schedules normally afterwards; runNow refuses while running', async () => {
  let runs = 0;
  const orig = cron.handlers.clean_sessions;
  cron.handlers.clean_sessions = async () => { runs += 1; await new Promise((r) => setTimeout(r, 400)); return 'slow ok'; };
  try {
    await setJobDue('clean_sessions');
    const t1 = cron.tick(ctx);
    // runNow during the in-flight tick must be refused with the true reason.
    await new Promise((r) => setTimeout(r, 50));
    await assert.rejects(async () => cron.runNow(ctx, (await jobRow('clean_sessions')).id), /already running/);
    const t2 = cron.tick(ctx);
    await Promise.all([t1, t2]);
    assert.equal(runs, 1, 'two overlapping ticks + one refused runNow = exactly one execution');
    // Schedules normally afterwards.
    await setJobDue('clean_sessions');
    await cron.tick(ctx);
    assert.equal(runs, 2);
  } finally { cron.handlers.clean_sessions = orig; }
});

test('D3-C2 plumbing: a failing job is recorded as an error run with a cron.failed audit (tick and runNow)', async () => {
  const orig = cron.handlers.clean_sessions;
  cron.handlers.clean_sessions = async () => { throw new Error('boom-dfixb'); };
  try {
    await setJobDue('clean_sessions');
    await cron.tick(ctx);
    const run = await jobRow('clean_sessions');
    assert.equal(run.last_status, 'error');
    assert.match(run.last_message, /boom-dfixb/);
    await assert.rejects(async () => cron.runNow(ctx, run.id), /boom-dfixb/);
    const audits = await db.query("SELECT id FROM audit_log WHERE action = 'cron.failed'");
    assert.ok(audits.length >= 2, 'both the tick failure and the runNow failure wrote cron.failed');
  } finally { cron.handlers.clean_sessions = orig; }
});

test('D3-C2: ensure_draws with a dead beacon + beacon_required FAILS the run (cron.failed audit), never reports a phantom settle', async () => {
  const d = await db.run(
    "INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, is_test, created_at) VALUES ('EVE', '2020-06-06', 1, 'scheduled', 'h', 's', 0, ?)", [now()]);
  // The handler re-reads settings from the DB (ctx-based API), so the
  // dead-beacon configuration is planted as real settings rows.
  // DRAND_API points at a dead endpoint for this whole test process.
  await setSetting('automation_master_enabled', '1');
  await setSetting('beacon_enabled', '1');
  await setSetting('beacon_required', '1');
  await assert.rejects(() => cron.handlers.ensure_draws(ctx), /Beacon unavailable/, 'a failed draw surfaces as a failed run, not a green "settled 1"');
  const row = await db.get('SELECT status FROM draws WHERE id = ?', [d.id]);
  assert.equal(row.status, 'scheduled', 'the draw itself is untouched (still waiting for the beacon)');
  // Through the scheduler: the run record + audit tell the truth.
  await setJobDue('ensure_draws');
  await cron.tick(ctx);
  const job = await jobRow('ensure_draws');
  assert.equal(job.last_status, 'error');
  assert.match(job.last_message, /Beacon unavailable/);
  const audits = await db.query("SELECT id FROM audit_log WHERE action = 'cron.failed'");
  assert.ok(audits.length >= 1, 'cron.failed audit row exists for the Automation Console');
  // And with the beacon NOT required, the same draw is honestly DEFERRED-class:
  // settleDueDraws falls back and settles — so reset the fixture instead:
  await db.run("UPDATE draws SET status = 'cancelled' WHERE id = ?", [d.id]);
});

test('D3-C3: a skipped (engine-off) scheduled drop does NOT stamp last_drop_at; engine on fires and stamps', async () => {
  const u = await db.run("INSERT INTO users (email, name, password_hash, role, status, email_verified, created_at) VALUES ('dfixbc3@test.dev', 'C3', 'x', 'player', 'active', 1, ?)", [now()]);
  const c = await db.run(
    "INSERT INTO bonus_campaigns (name, audience, audience_n, amount_type, amount, currency, trigger_type, starts_at, ends_at, wagering_x, per_user_cap, budget_cap, granted_total, active, last_drop_at, created_by, created_at) VALUES ('D3C3 drop', 'all', 0, 'fixed', 100, 'USD', 'scheduled', ?, 0, 0, 0, 0, 0, 1, 0, NULL, ?)", [now() - 1000, now()]);
  const off = await bonus.runScheduledDrops(db, { ...settings, bonus_enabled: '0' });
  const skipped = off.find((r) => r.campaignId === c.id);
  assert.ok(skipped && skipped.skipped, 'engine off -> the drop reports skipped');
  let row = await db.get('SELECT last_drop_at FROM bonus_campaigns WHERE id = ?', [c.id]);
  assert.equal(Number(row.last_drop_at), 0, 'still due: last_drop_at NOT stamped');
  const on = await bonus.runScheduledDrops(db, { ...settings, bonus_enabled: '1' });
  const fired = on.find((r) => r.campaignId === c.id);
  assert.ok(fired && !fired.skipped, 'engine on -> the drop fires');
  row = await db.get('SELECT last_drop_at FROM bonus_campaigns WHERE id = ?', [c.id]);
  assert.ok(Number(row.last_drop_at) > 0, 'stamped after a real run');
  assert.ok(u.id);
});

test('D3-C9: expire_deposits never expires a deposit carrying a provider reference; an unreferenced one expires', async () => {
  const old = now() - 49 * 3600 * 1000;
  const mk = async (pub, txn) => {
    const r = await db.run(
      "INSERT INTO deposits (public_id, user_id, method_id, currency, amount, charge, net, status, idempotency_key, created_at, provider_txn_id) VALUES (?, 1, 1, 'USD', 1000, 0, 1000, 'pending', ?, ?, ?)",
      [pub, 'idem' + pub, old, txn]);
    return r.id;
  };
  const withRef = await mk('DEPREF1', 'pi_3PqExampleRef');
  const noRef = await mk('DEPREF2', null);
  await cron.handlers.expire_deposits(ctx);
  const a = await db.get('SELECT status FROM deposits WHERE id = ?', [withRef]);
  const b = await db.get('SELECT status FROM deposits WHERE id = ?', [noRef]);
  assert.equal(a.status, 'pending', 'provider-referenced deposit survives (its webhook may still land)');
  assert.equal(b.status, 'expired', 'unreferenced stale deposit expires as before');
});

test('D3-C4: queued batches retry with bounded attempts (3), defer while notifications are OFF, and deliver when SMTP returns', async () => {
  const onSettings = { ...settings, notifications_enabled: '1' };
  const mkRow = async (subject) => {
    const r = await db.run(
      "INSERT INTO notifications_log (channel, to_addr, subject, body, status, error, created_at, batch_no, scheduled_at) VALUES ('email', 'player@dfixb.test', ?, 'Body for retry proof', 'queued', '', ?, 9, ?)",
      [subject, now(), now() - 1000]);
    return db.get('SELECT * FROM notifications_log WHERE id = ?', [r.id]);
  };
  // OFF: due rows are NOT consumed.
  const offRow = await mkRow('off-period');
  const deferred = await notify.sendQueued(db, { ...settings, notifications_enabled: '0' }, offRow);
  assert.equal(deferred.status, 'deferred');
  let row = await db.get('SELECT status, attempts FROM notifications_log WHERE id = ?', [offRow.id]);
  assert.equal(row.status, 'queued');
  assert.equal(Number(row.attempts), 0, 'no attempt was spent while off');
  // SMTP down: attempts 1 and 2 re-queue; attempt 3 is terminal.
  await stopSink();
  let r1 = await notify.sendQueued(db, onSettings, await mkRow('retry-me'));
  assert.equal(r1.status, 'queued');
  row = await db.get('SELECT status, attempts, scheduled_at FROM notifications_log WHERE id = ?', [r1.id || 0]).catch(() => null);
  const rowId = (await db.get("SELECT id FROM notifications_log WHERE subject = 'retry-me'")).id;
  row = await db.get('SELECT status, attempts, scheduled_at FROM notifications_log WHERE id = ?', [rowId]);
  assert.equal(Number(row.attempts), 1);
  assert.ok(Number(row.scheduled_at) > now(), 'retry is scheduled in the future (backoff), not hot-looped');
  await db.run('UPDATE notifications_log SET scheduled_at = ? WHERE id = ?', [now() - 1000, rowId]);
  const r2 = await notify.sendQueued(db, onSettings, await db.get('SELECT * FROM notifications_log WHERE id = ?', [rowId]));
  assert.equal(r2.status, 'queued');
  await db.run('UPDATE notifications_log SET scheduled_at = ? WHERE id = ?', [now() - 1000, rowId]);
  const r3 = await notify.sendQueued(db, onSettings, await db.get('SELECT * FROM notifications_log WHERE id = ?', [rowId]));
  assert.equal(r3.status, 'failed', 'third failure is terminal');
  row = await db.get('SELECT status, attempts, error FROM notifications_log WHERE id = ?', [rowId]);
  assert.equal(Number(row.attempts), 3);
  assert.match(row.error, /attempts exhausted: 3\/3/);
  // SMTP restored: a fresh queued row delivers.
  await startSink();
  const okRow = await mkRow('deliver-me');
  const sent = await notify.sendQueued(db, onSettings, okRow);
  assert.equal(sent.status, 'sent');
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(captured.join('').includes('deliver-me'), 'the sink received the delivered message');
  assert.equal(notify.MAX_QUEUED_ATTEMPTS, 3, 'the bound is 3 attempts total');
});
