'use strict';
/* V19 DEEP SCAN regression tests — one behavioural proof per fixed
   finding. Lib-level where the defect was lib-level, HTTP where the
   defect was in a render/route. Findings: B-01 (BP-22 cap double
   count), B-02 (KYC decide guard), B-03/A-08 (resubmit demotion +
   pending cap), B-04 (lifecycle launch failure traced, cap fail
   closed), B-08 (type-confused input must not 500), B-09 (handlerless
   cron job records error), B-11 (threshold-0 refused), A-01 (register
   error re-render), A-02 (login prefill), A-04/A-05 (homepage currency
   + meta description), A-10 (contact CSRF), C-04 (settle button). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'cp-' + tag + '-')); }
async function bootDb(dir) {
  const p = path.join(dir, 'test.sqlite');
  process.env.SQLITE_PATH = p;
  process.env.DB_DRIVER = 'sqlite';
  delete process.env.DATABASE_URL;
  const { openDB } = require('../lib/db');
  const { db } = openDB();
  const { migrate } = require('../lib/migrations');
  await migrate(db, 'sqlite');
  const { ensureScratchSchema } = require('../lib/scratch');
  await ensureScratchSchema(db, 'sqlite');
  const { getSettings } = require('../lib/settings');
  const settings = await getSettings(db, 'sqlite', true);
  return { db, settings, path: p };
}

/* ---------------- Part A: lib-level ---------------- */

test('SCAN B-01: auto-approve re-check does not double-count its own withdrawal against the daily cap', async () => {
  const { db, settings } = await bootDb(tmpDir('scanB01'));
  const { now, hashPassword } = require('../lib/util');
  const { getSettings, setSetting } = require('../lib/settings');
  await setSetting(db, 'sqlite', 'auto_withdrawal_limit', '400');
  await setSetting(db, 'sqlite', 'withdrawal_daily_cap', '50000'); // $500 in minor units
  const s = await getSettings(db, 'sqlite', true);
  const u = await db.run("INSERT INTO users (email, name, password_hash, role, status, email_verified, created_at) VALUES ('b01@t.test','B One',?,'player','active',1,?)", [hashPassword('B01pass#x'), now()]);
  const money = require('../lib/money');
  await money.postLedger(db, { userId: u.id, currency: 'USD', type: 'deposit', amount: 100000, refType: 'test', refId: 'b01' });
  const user = await db.get('SELECT * FROM users WHERE id = ?', [u.id]);
  const method = await db.get("SELECT * FROM payment_methods WHERE rail = 'bank_transfer'");
  /* Route flow, mirrored from routes/player.js + the BP-22 suite test:
     rules pre-check, create, note payout details, then the engine. */
  const userData = { reference: 'B01-REF' };
  const rules = await money.checkWithdrawalRules(db, s, user, method, 30000, userData);
  assert.equal(rules.ok, true, 'pre-check: ' + rules.reason);
  const { publicId } = await money.createWithdrawal(db, { userId: user.id, method, amountMinor: 30000, userData, settings: s, user });
  if (rules.promotePending) await money.promotePayoutDetails(db, user.id, rules.fingerprint);
  else await money.notePayoutDetails(db, user.id, rules.fingerprint, false);
  const fresh = await db.get('SELECT * FROM withdrawals WHERE public_id = ?', [publicId]);
  assert.equal(fresh.status, 'pending');
  // $300 under a $500 daily cap: the re-check must count it ONCE.
  const r = await money.maybeAutoApproveWithdrawal(db, s, publicId);
  assert.equal(r.auto, true, 'expected auto-approval, got: ' + JSON.stringify(r));
  const after = await db.get('SELECT status, decided_by FROM withdrawals WHERE public_id = ?', [publicId]);
  assert.equal(after.status, 'approved');
  assert.equal(after.decided_by, 0);
});

test('SCAN B-09: a cron job with no registered handler records an ERROR, not ok', async () => {
  const { db } = await bootDb(tmpDir('scanB09'));
  const { now } = require('../lib/util');
  const { setSetting } = require('../lib/settings');
  await setSetting(db, 'sqlite', 'automation_master_enabled', '1');
  await db.run("INSERT INTO cron_jobs (name, handler_key, interval_minutes, next_run_at, status, description) VALUES ('Ghost job', 'no_such_handler', 60, ?, 'active', 'scan test')", [now() - 1000]);
  const cron = require('../lib/cron');
  cron.start({ db, driver: 'sqlite' });
  await new Promise(r => setTimeout(r, 600));
  const job = await db.get("SELECT last_status, last_message FROM cron_jobs WHERE handler_key = 'no_such_handler'");
  assert.equal(job.last_status, 'error');
  assert.match(job.last_message, /no handler/);
});

test('SCAN B-04: a failing scheduled scratch launch is traced (event + audit), series stays draft', async () => {
  const { db, settings } = await bootDb(tmpDir('scanB04'));
  const { now } = require('../lib/util');
  const { setSetting, getSettings } = require('../lib/settings');
  await setSetting(db, 'sqlite', 'automation_master_enabled', '1');
  const s = await getSettings(db, 'sqlite', true);
  const r = await db.run("INSERT INTO scratch_series (title, slug, game_type, currency, price, total_tickets, status, enabled, server_seed, seed_hash, launch_at, created_at) VALUES ('Broken Launch', 'broken-launch', 'instant', 'USD', 100, 10, 'draft', 0, 'seed', 'hash', ?, ?)", [now() - 1000, now()]);
  // Negative tier makes launchSeries throw AFTER the cap check passes.
  await db.run('INSERT INTO scratch_prize_tiers (series_id, amount, quantity, label) VALUES (?, -5, 1, \'bad\')', [r.id]);
  const scratch = require('../lib/scratch');
  const out = await scratch.scratchLifecycle(db, s);
  assert.equal(out.activated, 0);
  const row = await db.get('SELECT status FROM scratch_series WHERE id = ?', [r.id]);
  assert.equal(row.status, 'draft');
  const ev = await db.get("SELECT id FROM scratch_events WHERE event_type = 'series.launch_failed' AND entity_id = ?", [String(r.id)]);
  assert.ok(ev, 'launch_failed event recorded');
  const au = await db.get("SELECT id FROM audit_log WHERE action = 'scratch.launch_failed' AND entity_id = ?", [String(r.id)]);
  assert.ok(au, 'launch_failed audit recorded');
});

/* ---------------- Part B: HTTP ---------------- */

const PORT = 3247;
const BASE = `http://127.0.0.1:${PORT}`;
const CONSOLE = '/ops-7f3a9c-console';
let serverProc = null;
let serverDbPath = null;

function cookieJar() {
  const jar = new Map();
  return {
    absorb(res) {
      const set = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      for (const line of set) {
        const [pair] = line.split(';');
        const i = pair.indexOf('=');
        if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    },
    header() { return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '); },
  };
}
async function req(jar, method, url, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (jar) headers.Cookie = jar.header();
  let data;
  if (body !== undefined && body !== null) {
    if (body instanceof FormData) { data = body; }
    else { data = new URLSearchParams(body); headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
  }
  const res = await fetch(BASE + url, { method, headers, body: data, redirect: 'manual' });
  if (jar) jar.absorb(res);
  return { status: res.status, text: await res.text(), location: res.headers.get('location') || '' };
}
function csrfOf(html) {
  const m = html.match(/name="_csrf" value="([^"]+)"/);
  return m ? m[1] : null;
}
async function waitHealthy(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.status === 200) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not become healthy');
}
async function login(jar, email, password) {
  const g = await req(jar, 'GET', '/login');
  const post = await req(jar, 'POST', '/login', { _csrf: csrfOf(g.text), email, password });
  assert.ok([200, 302].includes(post.status), 'login status ' + post.status);
}
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]);
function kycForm(csrf, filename = 'id.png') {
  const fd = new FormData();
  fd.append('_csrf', csrf);
  fd.append('doc_type', 'passport');
  fd.append('document', new Blob([PNG], { type: 'image/png' }), filename);
  return fd;
}

test('SCAN http: register error re-render, login prefill, homepage honesty, contact CSRF, type-confusion, threshold-0, settle button', async (t) => {
  const dir = tmpDir('scanhttp');
  serverDbPath = path.join(dir, 'db.sqlite');
  serverProc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, SQLITE_PATH: serverDbPath, PORT: String(PORT), BASE_URL: BASE, TICKET_HMAC_SECRET: 'scan-hmac-secret-value-0123456789abcdef', ADMIN_SEED_EMAIL: 'admin@scan.test', ADMIN_SEED_PASSWORD: 'ScanAdmin#pass1', ADMIN_SEED_NAME: 'Scan Admin' },
    stdio: 'ignore',
  });
  t.after(() => { if (serverProc) serverProc.kill('SIGKILL'); });
  await waitHealthy();

  /* A-01: register with mismatched passwords -> re-render keeps the
     country dropdown populated and the typed email. */
  const guest = cookieJar();
  const gReg = await req(guest, 'GET', '/register');
  const badReg = await req(guest, 'POST', '/register', {
    _csrf: csrfOf(gReg.text), name: 'Scan User', email: 'scanuser@test.dev',
    password: 'ScanPass#1', password_confirm: 'Different#1', agree: '1',
  });
  assert.equal(badReg.status, 200);
  assert.match(badReg.text, /Passwords do not match/);
  assert.ok((badReg.text.match(/<option value="\d+"/g) || []).length > 20, 'country-code options still present after error');
  assert.ok(badReg.text.includes('value="scanuser@test.dev"'), 'typed email preserved after error');

  /* A-02: failed login keeps the identifier. */
  const gLogin = await req(guest, 'GET', '/login');
  const badLogin = await req(guest, 'POST', '/login', { _csrf: csrfOf(gLogin.text), email: 'scanuser@test.dev', password: 'WrongPass#9' });
  assert.ok(badLogin.text.includes('value="scanuser@test.dev"'), 'login identifier prefilled after failure');

  /* A-05 + A-04: homepage meta description non-empty; paid-out figure
     stays in base currency even with a EUR display cookie. */
  const home = await req(null, 'GET', '/', null, { Cookie: 'display_currency=EUR' });
  const meta = home.text.match(/<meta name="description" content="([^"]*)"/);
  assert.ok(meta && meta[1].length > 10, 'meta description present: ' + (meta && meta[1]));
  const paid = home.text.match(/data-money="1"[^>]*>([^<]*)</);
  assert.ok(paid && paid[1].includes('$'), 'paid-out shown in base currency ($), got: ' + (paid && paid[1]));

  /* A-10: session-less contact POST is refused (403); the real flow
     (session + token) lands in the staff inbox. */
  const noSess = await req(null, 'POST', '/contact', { name: 'Anon', email: 'anon@test.dev', subject: 'x', message: 'hello there' });
  assert.equal(noSess.status, 403);
  const gContact = await req(guest, 'GET', '/contact');
  const okContact = await req(guest, 'POST', '/contact', { _csrf: csrfOf(gContact.text), name: 'Anon', email: 'anon@test.dev', subject: 'scan', message: 'hello from the scan test' });
  assert.equal(okContact.status, 302);
  process.env.SQLITE_PATH = serverDbPath;
  const { openDB } = require('../lib/db');
  const { db: db2 } = openDB();
  const cm = await db2.get("SELECT id FROM contact_messages WHERE subject = 'scan'");
  assert.ok(cm, 'contact message reached the inbox');

  /* Register a player for the remaining checks. */
  const player = cookieJar();
  const gReg2 = await req(player, 'GET', '/register');
  const reg = await req(player, 'POST', '/register', {
    _csrf: csrfOf(gReg2.text), name: 'Scan Player', email: 'scanplayer@test.dev',
    password: 'ScanPass#1', password_confirm: 'ScanPass#1', agree: '1',
  });
  assert.ok([200, 302].includes(reg.status));

  /* B-08: type-confused support subject must NOT 500. */
  const gSup = await req(player, 'GET', '/support/new');
  const confused = await req(player, 'POST', '/support/new', { _csrf: csrfOf(gSup.text), 'subject[x]': '1', message: 'type confusion probe' });
  assert.notEqual(confused.status, 500, 'support/new with subject[x]=1 must not 500, got ' + confused.status);

  /* Admin-side checks. */
  const admin = cookieJar();
  await login(admin, 'admin@scan.test', 'ScanAdmin#pass1');

  /* B-11: threshold mode + threshold 0 refused, setting unchanged. */
  const gAuto = await req(admin, 'GET', CONSOLE + '/automation');
  const before = await db2.get("SELECT value FROM settings WHERE key = 'draw_threshold_day'");
  const refused = await req(admin, 'POST', CONSOLE + '/automation/draws', {
    _csrf: csrfOf(gAuto.text), auto_draw_day: '1', auto_draw_eve: '1',
    draw_trigger_mode_day: 'threshold', draw_threshold_day: '0', draw_unmet_day: 'settle',
    draw_trigger_mode_eve: 'time', draw_threshold_eve: '100', draw_unmet_eve: 'settle',
    wager_options: '1,2,5,10',
  });
  assert.equal(refused.status, 302);
  const afterSet = await db2.get("SELECT value FROM settings WHERE key = 'draw_threshold_day'");
  assert.equal(afterSet.value, before.value, 'threshold setting unchanged after refused save');
  const modeRow = await db2.get("SELECT value FROM settings WHERE key = 'draw_trigger_mode_day'");
  assert.notEqual(modeRow.value, 'threshold', 'threshold mode was not saved either (whole-save refusal)');

  /* C-04: a future draw shows "Settles at close", not a settle form. */
  const gDraws = await req(admin, 'GET', CONSOLE + '/draws');
  assert.ok(gDraws.text.includes('Settles at close'), 'future draws are labelled honestly');

  /* B-02 + B-03 over HTTP: verify a user, submit a second document,
     reject it — the user must STAY verified; and a second pending
     submission is refused while one is under review. */
  const pid = (await db2.get("SELECT id FROM users WHERE email = 'scanplayer@test.dev'")).id;
  await db2.run("UPDATE settings SET value = '1' WHERE key = 'kyc_enabled'");
  const gKyc = await req(player, 'GET', '/kyc');
  const sub1 = await req(player, 'POST', '/kyc', kycForm(csrfOf(gKyc.text)));
  assert.equal(sub1.status, 302);
  let st = await db2.get('SELECT kyc_status FROM users WHERE id = ?', [pid]);
  assert.equal(st.kyc_status, 'pending');
  // Second submission while one is pending -> refused, still one doc.
  const gKyc2 = await req(player, 'GET', '/kyc');
  await req(player, 'POST', '/kyc', kycForm(csrfOf(gKyc2.text), 'second.png'));
  const docCount1 = await db2.get('SELECT COUNT(*) AS c FROM kyc_documents WHERE user_id = ?', [pid]);
  assert.equal(docCount1.c, 1, 'pending cap: still exactly one document');
  // Admin approves doc 1 -> verified.
  const doc1 = await db2.get('SELECT id FROM kyc_documents WHERE user_id = ? ORDER BY id LIMIT 1', [pid]);
  const gDoc = await req(admin, 'GET', CONSOLE + '/kyc/' + doc1.id);
  await req(admin, 'POST', CONSOLE + '/kyc/' + doc1.id + '/approve', { _csrf: csrfOf(gDoc.text) });
  st = await db2.get('SELECT kyc_status FROM users WHERE id = ?', [pid]);
  assert.equal(st.kyc_status, 'verified');
  // Verified user submits another document -> stays verified.
  const gKyc3 = await req(player, 'GET', '/kyc');
  const sub3 = await req(player, 'POST', '/kyc', kycForm(csrfOf(gKyc3.text), 'extra.png'));
  assert.equal(sub3.status, 302);
  st = await db2.get('SELECT kyc_status FROM users WHERE id = ?', [pid]);
  assert.equal(st.kyc_status, 'verified', 'verified user is not demoted by an extra submission');
  // Admin rejects the extra document -> user STILL verified.
  const doc2 = await db2.get("SELECT id FROM kyc_documents WHERE user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1", [pid]);
  assert.ok(doc2, 'second document is pending');
  const gDoc2 = await req(admin, 'GET', CONSOLE + '/kyc/' + doc2.id);
  await req(admin, 'POST', CONSOLE + '/kyc/' + doc2.id + '/reject', { _csrf: csrfOf(gDoc2.text), reason: 'Extra copy not needed' });
  st = await db2.get('SELECT kyc_status FROM users WHERE id = ?', [pid]);
  assert.equal(st.kyc_status, 'verified', 'rejecting a later document does not strip earned verification');
  const d2row = await db2.get('SELECT status FROM kyc_documents WHERE id = ?', [doc2.id]);
  assert.equal(d2row.status, 'rejected');
  // Deciding an already-decided document changes nothing (guard).
  const gDoc3 = await req(admin, 'GET', CONSOLE + '/kyc/' + doc2.id);
  await req(admin, 'POST', CONSOLE + '/kyc/' + doc2.id + '/approve', { _csrf: csrfOf(gDoc3.text) });
  const d2after = await db2.get('SELECT status FROM kyc_documents WHERE id = ?', [doc2.id]);
  assert.equal(d2after.status, 'rejected', 'already-decided document cannot be flipped');
});
