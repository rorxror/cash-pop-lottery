'use strict';
/* SETTINGS-FIND-01 E2E (spawned server, port 4137).
   The owner could not FIND the "Require 1x wagering" checkbox inside
   the mega Settings page on his phone. Proof of the fix:
   (1) the wagering gate has a SECOND door on the admin Withdrawals
       page — unchecking it there flips the same setting in the DB and
       a wagering-blocked player can immediately withdraw;
   (2) re-checking it from the Settings door blocks the player again
       (one setting, two doors, no divergence);
   (3) the Settings page carries a "Jump to" index whose anchors all
       resolve to real card ids in the rendered HTML;
   (4) a non-super staffer sees the gates card read-only. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-find-'));
const PORT = 4137;
const BASE = 'http://localhost:' + PORT;
const ADMIN_PATH = '/ops-7f3a9c-console';

class Jar {
  constructor(ua) { this.cookies = new Map(); this.ua = ua || 'find-test'; }
  async req(p, { method = 'GET', body, headers = {} } = {}) {
    const h = { 'User-Agent': this.ua, ...headers };
    if (this.cookies.size) h.Cookie = [...this.cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
    let payload;
    if (body) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    const res = await fetch(BASE + p, { method, headers: h, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) { const pair = c.split(';')[0]; const i = pair.indexOf('='); if (i > 0) { const k = pair.slice(0, i).trim(); const v = pair.slice(i + 1).trim(); if (v) this.cookies.set(k, v); else this.cookies.delete(k); } }
    return res;
  }
  async text(p, opts) { const r = await this.req(p, opts); return { status: r.status, loc: r.headers.get('location') || '', body: await r.text() }; }
}
function csrfOf(html) { const m = String(html).match(/name="_csrf" value="([^"]+)"/); return m && m[1]; }
async function waitHealthy(tries = 60) {
  for (let i = 0; i < tries; i++) { try { const r = await fetch(BASE + '/healthz'); if (r.status === 200) return true; } catch {} await new Promise(r => setTimeout(r, 500)); }
  return false;
}

let server = null, dbF = null, adminJar, playerJar, playerId, bankId;
const RISK_BASE = { withdrawal_daily_cap: '0.00', withdrawal_monthly_cap: '0.00', payout_lock_hours: '48', maker_checker_threshold: '0.00', referral_cap_per_referee: '0.00', auto_withdrawal_limit: '0' };

test.before(async () => {
  const env = { ...process.env,
    PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite',
    SQLITE_PATH: path.join(TMP, 'f.sqlite'),
    TICKET_HMAC_SECRET: 'find-test-ticket-hmac-secret-throwaway-0123456789',
    CREDENTIAL_ENCRYPTION_KEY: ENC_KEY,
    ADMIN_SEED_EMAIL: 'admin@find.test', ADMIN_SEED_PASSWORD: 'FindAdmin#pass', ADMIN_SEED_NAME: 'Find Admin',
  };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[find server] ' + d));
  assert.ok(await waitHealthy(), 'server must boot');
  process.env.SQLITE_PATH = path.join(TMP, 'f.sqlite');
  process.env.DB_DRIVER = 'sqlite';
  process.env.CREDENTIAL_ENCRYPTION_KEY = ENC_KEY;
  dbF = require('../lib/db').openDB().db;
  const money = require('../lib/money');

  adminJar = new Jar('find-admin');
  let g = await adminJar.text('/login');
  const lp = await adminJar.text('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email: 'admin@find.test', password: 'FindAdmin#pass' } });
  assert.equal(lp.status, 302); assert.ok(lp.loc.includes(ADMIN_PATH));

  playerJar = new Jar('find-player');
  g = await playerJar.text('/register');
  const rp = await playerJar.text('/register', { method: 'POST', body: { _csrf: csrfOf(g.body), name: 'Find Player', email: 'player@find.test', password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(rp.status, 302);
  playerId = (await dbF.get("SELECT id FROM users WHERE email = 'player@find.test'")).id;
  await dbF.run('UPDATE users SET email_verified = 1 WHERE id = ?', [playerId]);

  // $10 approved deposit, $0 wagered — the owner's exact scenario.
  const method = await dbF.get("SELECT * FROM payment_methods WHERE slug = 'rail-bank_transfer'");
  bankId = method.id;
  await dbF.run('UPDATE payment_methods SET enabled = 1 WHERE id = ?', [bankId]);
  const dep = await money.createDeposit(dbF, { userId: playerId, method, amountMinor: 1000, userData: { reference: 'FIND-REF-1' } });
  await money.decideDeposit(dbF, dep.id, 'approve', null, null);
  // Neutralize the orthogonal gates (OTP + payout lock) via DB, then
  // wait out the server's 5s settings cache so turnover is the only bite.
  await dbF.run("UPDATE settings SET value = '0' WHERE key = 'withdrawal_otp_enabled'");
  await dbF.run("UPDATE settings SET value = '0' WHERE key = 'payout_lock_hours'");
  await new Promise(r => setTimeout(r, 5200));
});

test.after(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch {} }
  try { if (dbF) await dbF.close(); } catch {}
  fs.rmSync(TMP, { recursive: true, force: true });
});

async function tryWithdraw() {
  const g = await playerJar.text('/withdraw/new?m=' + bankId);
  const post = await playerJar.text('/withdraw/new', { method: 'POST', body: { _csrf: csrfOf(g.body), method_id: String(bankId), amount: '5.00', custom_account_name: 'Find Player', custom_account_number: 'GB29NWBK60161331926819', custom_bank_name: 'Player Bank' } });
  const row = await dbF.get('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 1', [playerId]);
  return { post, row };
}

test('wagering gate: blocked player -> uncheck on the WITHDRAWALS page door -> withdraws -> re-check on the SETTINGS door -> blocked again', { timeout: 90000 }, async () => {
  // Gate ON (seeded default): blocked, no row.
  assert.equal((await dbF.get("SELECT value FROM settings WHERE key = 'withdrawal_turnover_required'")).value, '1');
  const before = await tryWithdraw();
  assert.ok(!before.row, 'wagering gate blocks the withdrawal (no row created)');

  // The second door exists on the Withdrawals page with the switch visible.
  const wpage = await adminJar.text(ADMIN_PATH + '/withdrawals');
  assert.equal(wpage.status, 200);
  assert.ok(wpage.body.includes('Withdrawal gates'), 'gates card renders on the Withdrawals page');
  assert.ok(wpage.body.includes('name="withdrawal_turnover_required"'), 'wagering checkbox is on the Withdrawals page');
  assert.ok(wpage.body.includes('checked'), 'checkbox reflects the ON state');

  // Uncheck FROM THE WITHDRAWALS DOOR (post the risk form as the browser does).
  const post = await adminJar.text(ADMIN_PATH + '/settings/risk', { method: 'POST', body: { _csrf: csrfOf(wpage.body), ...RISK_BASE } });
  assert.equal(post.status, 302);
  assert.equal((await dbF.get("SELECT value FROM settings WHERE key = 'withdrawal_turnover_required'")).value, '0', 'setting flipped in DB via the withdrawals door');

  const mid = await tryWithdraw();
  assert.ok(mid.row && mid.row.status === 'pending', 'player can immediately submit a withdrawal with the gate off');

  // Re-check FROM THE SETTINGS DOOR (same handler, checkbox present = on).
  const spage = await adminJar.text(ADMIN_PATH + '/settings');
  const post2 = await adminJar.text(ADMIN_PATH + '/settings/risk', { method: 'POST', body: { _csrf: csrfOf(spage.body), ...RISK_BASE, withdrawal_turnover_required: '1' } });
  assert.equal(post2.status, 302);
  assert.equal((await dbF.get("SELECT value FROM settings WHERE key = 'withdrawal_turnover_required'")).value, '1', 'setting flipped back via the settings door');
  const cnt = (await dbF.get('SELECT COUNT(*) AS c FROM withdrawals WHERE user_id = ?', [playerId])).c;
  const after = await tryWithdraw();
  assert.ok(!after.row || Number(after.row.id) === Number(mid.row.id), 'blocked again — no new withdrawal row');
  assert.equal((await dbF.get('SELECT COUNT(*) AS c FROM withdrawals WHERE user_id = ?', [playerId])).c, cnt, 'row count unchanged while blocked');
});

test('Settings jump index: every anchor resolves to a card id in the rendered page', { timeout: 60000 }, async () => {
  const spage = await adminJar.text(ADMIN_PATH + '/settings');
  assert.equal(spage.status, 200);
  assert.ok(spage.body.includes('Jump to:'), 'jump index renders at the top of Settings');
  for (const id of ['set-economy', 'set-risk', 'set-kyc', 'set-currencies', 'set-appearance']) {
    assert.ok(spage.body.includes(`href="#${id}"`), 'jump link present: #' + id);
    assert.ok(spage.body.includes(`id="${id}"`), 'anchor target present: #' + id);
  }
});

test('non-super staffer sees the withdrawal gates card read-only', { timeout: 60000 }, async () => {
  const { hashPassword, now } = require('../lib/util');
  await dbF.run("INSERT INTO users (name, email, password_hash, role, admin_role, status, email_verified, created_at) VALUES ('Fin Two', 'fin@find.test', ?, 'admin', 'finance', 'active', 1, ?)", [hashPassword('Finance#pass1'), now()]);
  const finJar = new Jar('find-fin');
  const g = await finJar.text('/login');
  const lf = await finJar.text('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email: 'fin@find.test', password: 'Finance#pass1' } });
  assert.equal(lf.status, 302);
  const wpage = await finJar.text(ADMIN_PATH + '/withdrawals');
  assert.equal(wpage.status, 200);
  assert.ok(wpage.body.includes('Withdrawal gates'), 'gates card visible to finance');
  assert.ok(wpage.body.includes('Only the super admin can change it'), 'read-only explanation for non-super roles');
  assert.ok(!wpage.body.includes('Save withdrawal gates'), 'no save button for non-super roles');
});
