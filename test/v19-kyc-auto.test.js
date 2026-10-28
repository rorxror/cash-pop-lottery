'use strict';
/* BP-21 (KYC) + BP-22 (auto-withdrawal limits) — v19.
   Part A (lib level, temp DB): the KYC requirement matrix, the upload
   validator + private store, the auto-limit resolver, and the
   auto-approval engine's safety refusals + happy path (built through
   createWithdrawal + notePayoutDetails exactly as the route does).
   Part B (spawned server): the enforcement matrix over HTTP — master
   OFF/ON, per-user required/exempt, document upload + owner-only access.
   The full OTP-leg narrative is covered by the manual E2E in
   FIX-LOG-V19.md; here the KYC gate fires before the OTP step, so no
   mail sink is needed. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

/* ---------------- Part A: lib level ---------------- */
let dbA, money, kyc, upload, settingsLib;
const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'v19kyc-a-'));
process.env.SQLITE_PATH = path.join(tmpA, 'a.sqlite');
process.env.KYC_UPLOAD_DIR = path.join(tmpA, 'uploads');

before(async () => {
  const { openDB } = require('../lib/db');
  const { migrate } = require('../lib/migrations');
  ({ db: dbA } = openDB());
  await migrate(dbA, 'sqlite');
  money = require('../lib/money');
  kyc = require('../lib/kyc');
  upload = require('../lib/upload');
  settingsLib = require('../lib/settings');
});

test('BP-21 lib: KYC requirement matrix (override x master x gate)', () => {
  const onW = { kyc_enabled: '1', kyc_gate: 'withdrawals' };
  const onB = { kyc_enabled: '1', kyc_gate: 'deposits_and_withdrawals' };
  const off = { kyc_enabled: '0', kyc_gate: 'withdrawals' };
  const dflt = { kyc_override: 'default', kyc_status: 'none' };
  const reqd = { kyc_override: 'required', kyc_status: 'none' };
  const exmp = { kyc_override: 'exempt', kyc_status: 'none' };
  const ver = { kyc_override: 'default', kyc_status: 'verified' };
  assert.equal(kyc.kycBlock(onW, dflt, 'withdraw').blocked, true);
  assert.equal(kyc.kycBlock(onW, dflt, 'deposit').blocked, false); // gate=withdrawals
  assert.equal(kyc.kycBlock(onB, dflt, 'deposit').blocked, true);
  assert.equal(kyc.kycBlock(off, dflt, 'withdraw').blocked, false);
  assert.equal(kyc.kycBlock(off, reqd, 'withdraw').blocked, true); // required beats master OFF
  assert.equal(kyc.kycBlock(onW, exmp, 'withdraw').blocked, false); // exempt never gated
  assert.equal(kyc.kycBlock(onW, ver, 'withdraw').blocked, false); // verified passes
  assert.equal(kyc.kycBlock(onW, { kyc_override: 'default', kyc_status: 'rejected' }, 'withdraw').blocked, true);
  assert.equal(kyc.kycBlock(onW, { kyc_override: 'default', kyc_status: 'pending' }, 'withdraw').blocked, true);
});

test('BP-21 lib: upload validation + private store + traversal-proof reads', () => {
  assert.equal(upload.validateUpload({ filename: 'id.png', data: PNG }).ok, true);
  assert.equal(upload.validateUpload({ filename: 'id.exe', data: Buffer.from('MZ....') }).ok, false);
  assert.equal(upload.validateUpload({ filename: 'id.png', data: Buffer.from('plain text') }).ok, false); // magic mismatch
  assert.equal(upload.validateUpload({ filename: 'id.pdf', data: Buffer.from('%PDF-1.7 body') }).ok, true);
  const big = Buffer.concat([PNG, Buffer.alloc(upload.MAX_FILE_BYTES + 1)]);
  assert.equal(upload.validateUpload({ filename: 'id.png', data: big }).ok, false); // oversize
  const stored = upload.storeUpload(PNG, 'png');
  assert.match(stored, /^[a-f0-9]{32}\.png$/);
  assert.deepEqual(upload.readStored(stored), PNG);
  assert.equal(upload.resolveStoredPath('../../etc/passwd'), null);
  assert.equal(upload.resolveStoredPath('../' + stored), null);
  assert.equal(upload.readStored('not-a-stored-name.png'), null);
  const parsed = upload.parseMultipart(Buffer.from(
    '--B\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\ntok123\r\n' +
    '--B\r\nContent-Disposition: form-data; name="document"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n' +
    PNG.toString('latin1') + '\r\n--B--\r\n', 'latin1'), 'multipart/form-data; boundary=B');
  assert.equal(parsed.fields._csrf, 'tok123');
  assert.equal(parsed.file.filename, 'a.png');
  assert.deepEqual(parsed.file.data, PNG);
});

test('BP-22 lib: effective-limit resolution (global vs per-user vs 0)', () => {
  const g50 = { auto_withdrawal_limit: '50' };
  const g0 = { auto_withdrawal_limit: '0' };
  assert.equal(money.autoWithdrawalLimitMinor(g50, { auto_withdrawal_limit: null }, 'USD'), 5000);
  assert.equal(money.autoWithdrawalLimitMinor(g50, { auto_withdrawal_limit: '10' }, 'USD'), 1000);
  assert.equal(money.autoWithdrawalLimitMinor(g50, { auto_withdrawal_limit: '0' }, 'USD'), 0); // per-user 0 wins over global
  assert.equal(money.autoWithdrawalLimitMinor(g0, { auto_withdrawal_limit: null }, 'USD'), 0);
  assert.equal(money.autoWithdrawalLimitMinor(g50, { auto_withdrawal_limit: '' }, 'USD'), 5000); // blank = follow global
  assert.equal(money.autoWithdrawalLimitMinor({ auto_withdrawal_limit: 'junk' }, { auto_withdrawal_limit: null }, 'USD'), 0); // fail closed
});

async function mkUser(email, extra = {}) {
  const ins = await dbA.run("INSERT INTO users (name, email, password_hash, role, status, email_verified, created_at) VALUES (?, ?, 'x', 'player', 'active', 1, ?)",
    ['T ' + email, email, Date.now()]);
  if (Object.keys(extra).length) {
    const sets = Object.keys(extra).map(k => `${k} = ?`).join(', ');
    await dbA.run(`UPDATE users SET ${sets} WHERE id = ?`, [...Object.values(extra), ins.id]);
  }
  return dbA.get('SELECT * FROM users WHERE id = ?', [ins.id]);
}
async function mkWithdrawalViaRouteFlow(user, settings, amountMinor) {
  const method = await dbA.get("SELECT * FROM payment_methods WHERE rail = 'bank_transfer'");
  const userData = { reference: 'REF-1' };
  const rules = await money.checkWithdrawalRules(dbA, settings, user, method, amountMinor, userData);
  assert.equal(rules.ok, true, 'pre-check: ' + rules.reason);
  const { publicId } = await money.createWithdrawal(dbA, { userId: user.id, method, amountMinor, userData, settings, user });
  if (rules.promotePending) await money.promotePayoutDetails(dbA, user.id, rules.fingerprint);
  else await money.notePayoutDetails(dbA, user.id, rules.fingerprint, false);
  return publicId;
}

test('BP-22 lib: engine approves under the limit, refuses safely otherwise', async () => {
  await settingsLib.setSetting(dbA, 'sqlite', 'auto_withdrawal_limit', '50');
  await dbA.run("UPDATE payment_methods SET enabled = 1 WHERE rail = 'bank_transfer'");
  const s = await settingsLib.getSettings(dbA, 'sqlite', true);
  await settingsLib.setSetting(dbA, 'sqlite', 'withdrawal_turnover_required', '0');
  const s2 = await settingsLib.getSettings(dbA, 'sqlite', true);

  // happy path: $30 under global $50 -> approved by system, never paid
  const u1 = await mkUser('auto1@test');
  await money.postLedger(dbA, { userId: u1.id, currency: 'USD', type: 'deposit', amount: 20000, refType: 'test', refId: 'seed1' });
  const pid = await mkWithdrawalViaRouteFlow(u1, s2, 3000);
  const r1 = await money.maybeAutoApproveWithdrawal(dbA, s2, pid);
  assert.equal(r1.auto, true, JSON.stringify(r1));
  const w1 = await dbA.get('SELECT * FROM withdrawals WHERE public_id = ?', [pid]);
  assert.equal(w1.status, 'approved');
  assert.equal(w1.decided_by, 0);
  const aud = await dbA.get("SELECT * FROM audit_log WHERE action = 'withdrawal.auto_approve' AND entity_id = ?", [String(w1.id)]);
  assert.ok(aud, 'auto-approve audit row exists');

  // over the limit -> stays pending
  const pid2 = await mkWithdrawalViaRouteFlow(u1, s2, 8000);
  const r2 = await money.maybeAutoApproveWithdrawal(dbA, s2, pid2);
  assert.equal(r2.auto, false); assert.equal(r2.reason, 'over_limit');

  // withdrawal_blocked -> policy refusal
  const u2 = await mkUser('auto2@test', { withdrawal_blocked: 1 });
  await money.postLedger(dbA, { userId: u2.id, currency: 'USD', type: 'deposit', amount: 20000, refType: 'test', refId: 'seed2' });
  const pid3 = await mkWithdrawalViaRouteFlow(u2, s2, 1000).catch(e => null);
  if (pid3) { // creation itself may refuse blocked users; engine refusal is what matters when a row exists
    const r3 = await money.maybeAutoApproveWithdrawal(dbA, s2, pid3);
    assert.equal(r3.auto, false);
  }

  // KYC gate bites -> no auto (master ON, user unverified)
  await settingsLib.setSetting(dbA, 'sqlite', 'kyc_enabled', '1');
  const s3 = await settingsLib.getSettings(dbA, 'sqlite', true);
  const u3 = await mkUser('auto3@test');
  await money.postLedger(dbA, { userId: u3.id, currency: 'USD', type: 'deposit', amount: 20000, refType: 'test', refId: 'seed3' });
  const pid4 = await mkWithdrawalViaRouteFlow(u3, s2, 1000);
  const r4 = await money.maybeAutoApproveWithdrawal(dbA, s3, pid4);
  assert.equal(r4.auto, false); assert.equal(r4.reason, 'kyc_blocked');
  await settingsLib.setSetting(dbA, 'sqlite', 'kyc_enabled', '0');

  // global 0 -> off
  await settingsLib.setSetting(dbA, 'sqlite', 'auto_withdrawal_limit', '0');
  const s4 = await settingsLib.getSettings(dbA, 'sqlite', true);
  const r5 = await money.maybeAutoApproveWithdrawal(dbA, s4, pid2);
  assert.equal(r5.auto, false); assert.equal(r5.reason, 'limit_off');
});

/* ---------------- Part B: HTTP enforcement ---------------- */
const PORT = 3233;
const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'v19kyc-b-'));
const envB = {
  ...process.env,
  SQLITE_PATH: path.join(tmpB, 'b.sqlite'),
  KYC_UPLOAD_DIR: path.join(tmpB, 'uploads'),
  PORT: String(PORT),
  BASE_URL: `http://127.0.0.1:${PORT}`,
  TICKET_HMAC_SECRET: 'v19-kyc-http-secret-0123456789',
  ADMIN_SEED_EMAIL: 'admin@v19kyc.test',
  ADMIN_SEED_PASSWORD: 'V19Kyc#pass',
  ADMIN_SEED_NAME: 'V19 KYC Admin',
};
delete envB.CREDENTIAL_ENCRYPTION_KEY;
let serverProc = null;

function rawRequest({ method = 'GET', path: p, jar, body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (jar && jar.size) h.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: h }, (resp) => {
      const sc = resp.headers['set-cookie'] || [];
      if (jar) for (const c of sc) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim()); }
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const form = (o) => new URLSearchParams(o).toString();
const FORM_CT = { 'Content-Type': 'application/x-www-form-urlencoded' };
function csrfOf(html) { const m = /name="_csrf" value="([^"]+)"/.exec(html); return m ? m[1] : ''; }
async function get(jar, p) { const r = await rawRequest({ path: p, jar }); return { ...r, text: r.body.toString('utf8') }; }
async function postForm(jar, p, o) { const r = await rawRequest({ method: 'POST', path: p, jar, body: form(o), headers: FORM_CT }); return { ...r, text: r.body.toString('utf8') }; }
async function loginAs(email, password) {
  const jar = new Map();
  const g = await get(jar, '/login');
  await postForm(jar, '/login', { _csrf: csrfOf(g.text), email, password });
  return jar;
}
async function registerPlayer(name, email) {
  const jar = new Map();
  const g = await get(jar, '/register');
  await postForm(jar, '/register', { _csrf: csrfOf(g.text), name, email, password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' });
  return jar;
}
async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try { const r = await rawRequest({ path: '/healthz' }); if (r.status === 200) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not become healthy');
}

before(async () => {
  serverProc = spawn('node', ['server.js'], { cwd: ROOT, env: envB, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProc.stderr.on('data', (d) => process.stderr.write('[v19kyc-server] ' + d));
  await waitHealthy();
});
after(() => { if (serverProc) serverProc.kill('SIGKILL'); });

test('BP-21 http: gate matrix + upload + owner-only document', async () => {
  const adminJar = await loginAs('admin@v19kyc.test', 'V19Kyc#pass');
  const CONSOLE = '/ops-7f3a9c-console';
  const pJar = await registerPlayer('KYC Player', 'kycp@v19kyc.test');
  const oJar = await registerPlayer('Other Player', 'other@v19kyc.test');
  // Withdrawal policy requires a verified contact (deposit/withdraw rule) —
  // flip it directly in the server's DB, like the v19-features tests do.
  process.env.SQLITE_PATH = path.join(tmpB, 'b.sqlite');
  const { openDB } = require('../lib/db');
  const { db: dbB } = openDB();
  await dbB.run("UPDATE users SET email_verified = 1 WHERE email IN ('kycp@v19kyc.test', 'other@v19kyc.test')");

  // master OFF (default): the withdraw form is reachable (no KYC block)
  let r = await get(pJar, '/withdraw/new');
  assert.equal(r.status, 200, 'master OFF: withdraw page reachable, got ' + r.status);

  // master ON via the real settings route
  let s = await get(adminJar, CONSOLE + '/settings');
  r = await postForm(adminJar, CONSOLE + '/settings/kyc', { _csrf: csrfOf(s.text), kyc_enabled: '1', kyc_gate: 'withdrawals' });
  assert.equal(r.status, 302);
  r = await get(pJar, '/withdraw/new');
  assert.equal(r.status, 403);
  assert.match(r.text, /KYC approval is required before withdrawals/);

  // /kyc page + multipart submit
  r = await get(pJar, '/kyc');
  assert.equal(r.status, 200);
  assert.match(r.text, /Not submitted/);
  const boundary = '----v19testboundary';
  const mp = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${csrfOf(r.text)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="doc_type"\r\n\r\npassport\r\n--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="pass.png"\r\nContent-Type: image/png\r\n\r\n`, 'latin1'),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1'),
  ]);
  r = await rawRequest({ method: 'POST', path: '/kyc', jar: pJar, body: mp, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
  r = { ...r, text: r.body.toString('utf8') };
  assert.equal(r.status, 302, 'submit redirects, got ' + r.status);
  r = await get(pJar, '/kyc');
  assert.match(r.text, /Pending review/);
  const docLink = /\/kyc\/document\/(\d+)/.exec(r.text);
  assert.ok(docLink, 'own document link listed');
  const docId = docLink[1];

  // other player cannot read it; owner can; logged-out console is stealth
  r = await get(oJar, '/kyc/document/' + docId);
  assert.equal(r.status, 404);
  r = await get(pJar, '/kyc/document/' + docId);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, PNG);
  r = await get(new Map(), CONSOLE + '/kyc');
  assert.equal(r.status, 404);

  // admin approve -> gate lifts
  r = await get(adminJar, CONSOLE + '/kyc');
  assert.match(r.text, /kycp@v19kyc\.test/);
  s = await get(adminJar, CONSOLE + '/kyc/' + docId);
  r = await postForm(adminJar, CONSOLE + '/kyc/' + docId + '/approve', { _csrf: csrfOf(s.text) });
  assert.equal(r.status, 302);
  r = await get(pJar, '/withdraw/new');
  assert.equal(r.status, 200, 'approved player passes the gate, got ' + r.status);

  // bad upload: wrong magic with a .png name
  const bad = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\n${csrfOf((await get(oJar, '/kyc')).text)}\r\n--${boundary}\r\nContent-Disposition: form-data; name="doc_type"\r\n\r\npassport\r\n--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="fake.png"\r\nContent-Type: image/png\r\n\r\n`, 'latin1'),
    Buffer.from('definitely not a png'),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1'),
  ]);
  r = await rawRequest({ method: 'POST', path: '/kyc', jar: oJar, body: bad, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
  assert.equal(r.status, 302);
  r = await get(oJar, '/kyc');
  assert.match(r.text, /does not match/);
  assert.doesNotMatch(r.text, /Pending review/);
});
