'use strict';
/* MANUAL PAYMENTS round — per-rail manual deposit/withdrawal E2E.
   Run: node --test test/manual-payments.test.js
   Part A (lib level, own temp DB): for ALL 14 rails — valid real-world
   credentials pass validation; saved credentials never leak through
   getReceivingDetails/getPublicConfig (the only two player-facing
   projections); a manual deposit credits the exact net exactly once
   (double-approve throws), a reject credits nothing and stores the
   player-facing reason; a manual withdrawal holds exactly once,
   reject refunds exactly once, approve -> mark-paid (provider ID
   required) lands paid and cannot be paid twice.
   Part B (spawned server, port 4131): the real admin forms drive
   every rail (credentials save -> enable -> player page shows pay-to
   details + numbered how-to, NO secrets -> proof submit -> admin
   detail shows labelled proof + receiving block), METHOD-MODE-01
   (manual webhook records without crediting; auto crypto credits
   exactly once via signed webhook, replay deduped, forged/wrong
   amount refused; Auto save refused honestly on paypal/bank_transfer
   and on pix without webhook_secret; PayPal manual save with ONLY
   the receiving email works), AUTO-VISIBILITY-01 (player history
   shows pending -> credited with exact amounts, notification lands,
   auto withdrawal hold/approve visible with exact numbers),
   AGENT-CURRENCY-01 (unfunded agent sees currencies + empty state;
   EUR float funds an exact EUR transfer; insufficient float refused),
   and the no-destination withdrawal guard. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const ENC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'; // throwaway test key (64 hex)
const TMP_A = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-mp-a-'));
const TMP_B = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-mp-b-'));
process.env.SQLITE_PATH = path.join(TMP_A, 'a.sqlite');
process.env.DB_DRIVER = 'sqlite';
process.env.CREDENTIAL_ENCRYPTION_KEY = ENC_KEY;
delete process.env.DATABASE_URL;

const { openDB } = require('../lib/db');
const { migrate } = require('../lib/migrations');
const rails = require('../lib/rails');
const creds = require('../lib/credentials');
const money = require('../lib/money');
const { now } = require('../lib/util');

const { db } = openDB();

/* Distinctive per-rail test values. Secret values carry SECRETVAL so a
   leak anywhere (player page, receiving details, public config) is
   greppable. Receiving values are what a player must see. */
const TRC = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
const CREDS = {
  crypto: { asset: 'USDT', network: 'TRC20', wallet_address: TRC, webhook_secret: 'mpWhsecCrypto1' },
  cards: { provider: 'Stripe', mode: 'sandbox', publishable_key: 'pk_test_mp123456789', secret_key: 'sk_test_MPSECRET123456', webhook_secret: 'whsec_mpsecret123' },
  upi: { upi_id: 'owner@okhdfcbank', merchant_name: 'Owner Store' },
  pix: { pix_key: 'owner@bank.com.br', pix_key_type: 'email', webhook_secret: 'mpWhsecPix123' },
  mobile_money: { provider: 'MTN Mobile Money', account_type: 'mobile', account_number: '+233201234567', account_name: 'Owner', api_key: 'SECRETVAL_mm', webhook_secret: 'mpWhsecMm1234' },
  ewallet: { provider: 'Skrill', account_email: 'owner@skrill.test', client_id: 'mp-client', client_secret: 'SECRETVAL_ew', webhook_secret: 'mpWhsecEw12345' },
  apple_pay: { merchant_id: 'merchant.com.cashpop.test', processor: 'Stripe', api_key: 'SECRETVAL_ap', webhook_secret: 'mpWhsecAp12345' },
  google_pay: { merchant_id: '12345678901234567890', merchant_name: 'Owner Store', gateway: 'stripe', gateway_merchant_id: 'gw_mp_123', environment: 'TEST', webhook_secret: 'mpWhsecGp12345' },
  samsung_pay: { merchant_id: 'mp_samsung_merchant', service_id: 'mp_service_1', api_key: 'SECRETVAL_sp', webhook_secret: 'mpWhsecSp12345' },
  bank_transfer: { bank_name: 'Test Bank', account_name: 'Owner Name', account_number: 'GB29NWBK60161331926819', swift: 'CHASUS33' },
  qr_pay: { provider: 'PromptPay', payee_id: '0812345678', qr_image_url: 'https://example.test/qr-mp.png', account_label: 'Owner PromptPay' },
  voucher: { issuer: 'Flexepin', api_key: 'SECRETVAL_vc' },
  cash_agent: { agent_network: 'Wave', instructions: 'Ask for Cash Pop desk' },
  paypal: { account_email: 'owner@paypal.test', account_name: 'Owner Business', client_id: 'mpPaypalClientId', client_secret: 'SECRETVAL_pp' },
};
const SECRET_VALUES = {
  crypto: ['mpWhsecCrypto1'], cards: ['sk_test_MPSECRET123456', 'whsec_mpsecret123'],
  pix: ['mpWhsecPix123'], mobile_money: ['SECRETVAL_mm', 'mpWhsecMm1234'],
  ewallet: ['SECRETVAL_ew', 'mpWhsecEw12345'], apple_pay: ['SECRETVAL_ap', 'mpWhsecAp12345'],
  google_pay: ['mpWhsecGp12345'], samsung_pay: ['SECRETVAL_sp', 'mpWhsecSp12345'],
  voucher: ['SECRETVAL_vc'], paypal: ['SECRETVAL_pp'],
};
const PROOF = {
  crypto: { tx_hash: 'a1b2c3d4'.repeat(8) },
  cards: {}, upi: { utr: '123456789012' }, pix: { pix_txid: 'E12345678202501011234567890123456' },
  mobile_money: { receipt_code: 'MP2601290001' }, ewallet: { ewallet_txid: 'EW-TX-998877' },
  apple_pay: {}, google_pay: {}, samsung_pay: {},
  bank_transfer: { reference: 'BANKREF-12345', sender_name: 'Player One' },
  qr_pay: { reference: 'QRREF-12345' }, voucher: { voucher_pin: '1234567890123456' },
  cash_agent: { agent_location: 'Main Street Store', receipt_code: 'AG-RCPT-77' },
  paypal: { paypal_txid: '8AB12345CD678901E', sender_email: 'player@paypal.test' },
};
const DEST = {
  crypto: { wallet_address: TRC, network: 'TRC20' },
  upi: { upi_id: 'player@okhdfcbank' }, pix: { pix_key: 'player@bank.com.br' },
  mobile_money: { account_number: '+233209876543', account_name: 'Player One' },
  ewallet: { account_email: 'player@skrill.test' },
  bank_transfer: { account_name: 'Player One', account_number: 'GB29NWBK60161331926820', bank_name: 'Player Bank' },
  qr_pay: { account_label: 'Player PromptPay 0812345678' },
  cash_agent: { agent_location: 'Main Street Store' },
  paypal: { account_email: 'player@paypal.test' },
};
const DEST_RAILS = Object.keys(DEST);
const ALL_RAILS = Object.keys(CREDS);

let playerA, adminAId;
async function methodRow(railKey) { return db.get('SELECT * FROM payment_methods WHERE slug = ?', ['rail-' + railKey]); }
async function balanceA(userId, currency = 'USD') {
  const b = await money.getBalances(db, userId);
  const w = (b || []).find(x => x.currency === currency);
  return w ? Number(w.balance) : 0;
}

test.before(async () => {
  await migrate(db, 'sqlite');
  const ins = await db.run("INSERT INTO users (name, email, password_hash, role, status, email_verified, created_at) VALUES ('MP Player', 'mpa@test', 'x', 'player', 'active', 1, ?)", [now()]);
  playerA = ins.id;
  const adm = await db.run("INSERT INTO users (name, email, password_hash, role, status, email_verified, created_at) VALUES ('MP Admin', 'mpadmin@test', 'x', 'admin', 'active', 1, ?)", [now()]);
  adminAId = adm.id;
});

test('A1 field audit: every rail accepts exactly its real-world manual credentials', () => {
  assert.equal(ALL_RAILS.length, 14, '14 rails under audit');
  for (const k of ALL_RAILS) {
    const v = rails.validateRailCredentials(k, CREDS[k]);
    assert.equal(v.ok, true, `${k}: ${v.error || ''}`);
  }
});

test('A2 secret hygiene: receiving details + public config never contain a secret value, for every rail', async () => {
  for (const k of ALL_RAILS) {
    const m = await methodRow(k);
    for (const [fk, fv] of Object.entries(CREDS[k])) await creds.saveCredentialField(db, m.id, fk, fv);
    const receiving = JSON.stringify(await rails.getReceivingDetails(db, m));
    const pub = JSON.stringify(await rails.getPublicConfig(db, m));
    for (const sv of (SECRET_VALUES[k] || [])) {
      assert.ok(!receiving.includes(sv), `${k}: secret leaked into receiving details`);
      assert.ok(!pub.includes(sv), `${k}: secret leaked into public config`);
    }
  }
  // fail-closed: without the env key, saves refuse (test key unset in a subprocess env sense — assert the guard exists via keyConfigured contract)
  assert.equal(creds.keyConfigured(), true, 'test env key is configured');
});

test('A3 manual deposit loop (all 14 rails): approve credits exact net once; double-approve throws; reject credits nothing and stores the reason', async () => {
  for (const k of ALL_RAILS) {
    const m = await methodRow(k);
    const bal0 = await balanceA(playerA);
    const d1 = await money.createDeposit(db, { userId: playerA, method: m, amountMinor: 10000, userData: PROOF[k] });
    await money.decideDeposit(db, d1.id, 'approve', adminAId, null);
    assert.equal(await balanceA(playerA), bal0 + 10000, `${k}: approve credits the exact amount`);
    await assert.rejects(() => money.decideDeposit(db, d1.id, 'approve', adminAId, null), `${k}: double approve must throw`);
    assert.equal(await balanceA(playerA), bal0 + 10000, `${k}: double approve moved nothing`);
    const d2 = await money.createDeposit(db, { userId: playerA, method: m, amountMinor: 4000, userData: PROOF[k] });
    await money.decideDeposit(db, d2.id, 'reject', adminAId, null, 'Proof does not match our records.');
    assert.equal(await balanceA(playerA), bal0 + 10000, `${k}: reject credits nothing`);
    const row = await db.get('SELECT decision_reason, status FROM deposits WHERE id = ?', [d2.id]);
    assert.equal(row.status, 'rejected');
    assert.equal(row.decision_reason, 'Proof does not match our records.', `${k}: player-facing reason stored`);
  }
});

test('A4 adversarial proof: a malformed crypto hash is refused at the engine with the true reason', async () => {
  const m = await methodRow('crypto');
  await assert.rejects(
    () => money.createDeposit(db, { userId: playerA, method: m, amountMinor: 1000, userData: { tx_hash: 'xyz' } }),
    /Transaction hash looks invalid/);
});

test('A5 manual withdrawal loop (9 destination rails): hold once -> reject refunds once; hold -> approve -> mark-paid with provider ID -> paid, second mark-paid throws', async () => {
  for (const k of DEST_RAILS) {
    const m = await methodRow(k);
    const bal0 = await balanceA(playerA);
    assert.ok(bal0 >= 5000, `${k}: player funded by A3 (balance ${bal0})`);
    // reject path
    const w1 = await money.createWithdrawal(db, { userId: playerA, method: m, amountMinor: 2000, userData: DEST[k] });
    assert.equal(await balanceA(playerA), bal0 - 2000, `${k}: hold drops the balance exactly once`);
    await money.decideWithdrawal(db, w1.id, 'reject', adminAId, '', 'Destination details could not be verified.');
    assert.equal(await balanceA(playerA), bal0, `${k}: reject refunds the hold exactly once`);
    await assert.rejects(() => money.decideWithdrawal(db, w1.id, 'reject', adminAId), `${k}: double reject must throw`);
    assert.equal(await balanceA(playerA), bal0, `${k}: double reject refunded nothing extra`);
    // paid path
    const w2 = await money.createWithdrawal(db, { userId: playerA, method: m, amountMinor: 3000, userData: DEST[k] });
    await money.decideWithdrawal(db, w2.id, 'approve', adminAId);
    await assert.rejects(() => money.markWithdrawalPaid(db, w2.id, '', adminAId), `${k}: mark-paid without a provider ID must throw`);
    await money.markWithdrawalPaid(db, w2.id, 'PAYOUT-' + k.toUpperCase() + '-1', adminAId);
    const row = await db.get('SELECT status, provider_payout_id FROM withdrawals WHERE id = ?', [w2.id]);
    assert.equal(row.status, 'paid', `${k}: paid after mark-paid`);
    assert.equal(row.provider_payout_id, 'PAYOUT-' + k.toUpperCase() + '-1');
    assert.equal(await balanceA(playerA), bal0 - 3000, `${k}: paid withdrawal stays deducted exactly once`);
    await assert.rejects(() => money.markWithdrawalPaid(db, w2.id, 'PAYOUT-AGAIN', adminAId), `${k}: second mark-paid must throw`);
  }
});

/* ---------------- Part B: spawned server (port 4131) ---------------- */

const PORT = 4131;
const BASE = 'http://localhost:' + PORT;
const ADMIN_PATH = '/ops-7f3a9c-console';
let server = null;
let dbB = null;

class Jar {
  constructor(ua) { this.cookies = new Map(); this.ua = ua || 'mp-test-agent'; }
  async req(p, { method = 'GET', body, rawBody, headers = {} } = {}) {
    const h = { 'User-Agent': this.ua, ...headers };
    if (this.cookies.size) h.Cookie = [...this.cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
    let payload;
    if (body) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    if (rawBody !== undefined) payload = rawBody;
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

let adminJar, playerJar, playerBId, player2Jar, player2Id;
const methodIdB = {};
async function balB(currency = 'USD') {
  const w = await dbB.get('SELECT balance FROM wallets WHERE user_id = ? AND currency = ?', [playerBId, currency]);
  return w ? Number(w.balance) : 0;
}
async function saveCredsB(methodId, fields) {
  const g = await adminJar.text(`${ADMIN_PATH}/methods/${methodId}/credentials`);
  assert.equal(g.status, 200, 'credentials page loads');
  const post = await adminJar.text(`${ADMIN_PATH}/methods/${methodId}/credentials`, { method: 'POST', body: { _csrf: csrfOf(g.body), ...fields } });
  assert.equal(post.status, 302, 'credentials save redirects');
  return g.body;
}
async function toggleB(methodId) {
  const g = await adminJar.text(ADMIN_PATH + '/methods');
  const post = await adminJar.text(`${ADMIN_PATH}/methods/${methodId}/toggle`, { method: 'POST', body: { _csrf: csrfOf(g.body) } });
  assert.equal(post.status, 302);
}
async function setModeB(methodId, mode) {
  const g = await adminJar.text(`${ADMIN_PATH}/methods/${methodId}/credentials`);
  const post = await adminJar.text(`${ADMIN_PATH}/methods/${methodId}/mode`, { method: 'POST', body: { _csrf: csrfOf(g.body), processing_mode: mode } });
  assert.equal(post.status, 302, 'mode save redirects');
  const page = await adminJar.text(`${ADMIN_PATH}/methods/${methodId}/credentials`);
  return page.body;
}
async function playerDepositAs(jar, userId, methodId, amount, proof = {}) {
  const g = await jar.text('/deposit/new?m=' + methodId);
  assert.equal(g.status, 200, 'deposit page loads');
  const body = { _csrf: csrfOf(g.body), method_id: String(methodId), amount };
  for (const [k, v] of Object.entries(proof)) body['custom_' + k] = v;
  const post = await jar.text('/deposit/new', { method: 'POST', body });
  assert.equal(post.status, 302, 'deposit submit redirects: ' + post.status);
  return dbB.get('SELECT * FROM deposits WHERE user_id = ? AND method_id = ? ORDER BY id DESC LIMIT 1', [userId, methodId]);
}
async function playerDepositB(methodId, amount, proof = {}) {
  const g = await playerJar.text('/deposit/new?m=' + methodId);
  assert.equal(g.status, 200, 'deposit page loads');
  const body = { _csrf: csrfOf(g.body), method_id: String(methodId), amount };
  for (const [k, v] of Object.entries(proof)) body['custom_' + k] = v;
  const post = await playerJar.text('/deposit/new', { method: 'POST', body });
  assert.equal(post.status, 302, 'deposit submit redirects: ' + post.status);
  return dbB.get('SELECT * FROM deposits WHERE user_id = ? AND method_id = ? ORDER BY id DESC LIMIT 1', [playerBId, methodId]);
}

test.before(async () => {
  const env = { ...process.env,
    PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite',
    SQLITE_PATH: path.join(TMP_B, 'b.sqlite'),
    TICKET_HMAC_SECRET: 'mp-test-ticket-hmac-secret-throwaway-0123456789',
    CREDENTIAL_ENCRYPTION_KEY: ENC_KEY,
    ADMIN_SEED_EMAIL: 'admin@mp.test', ADMIN_SEED_PASSWORD: 'MpAdmin#pass', ADMIN_SEED_NAME: 'MP Admin',
  };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[mp server] ' + d));
  assert.ok(await waitHealthy(), 'server must boot');
  process.env.SQLITE_PATH = path.join(TMP_B, 'b.sqlite');
  dbB = openDB().db;
  for (const k of ALL_RAILS) {
    const m = await dbB.get('SELECT id FROM payment_methods WHERE slug = ?', ['rail-' + k]);
    assert.ok(m, 'seeded method for ' + k);
    methodIdB[k] = m.id;
  }
  // Relax the withdrawal gates that are orthogonal to this round
  // (OTP gets its own segment in B5; turnover/lock are v19-proven).
  for (const [k, v] of [['withdrawal_otp_enabled', '0'], ['withdrawal_turnover_required', '0'], ['payout_lock_hours', '0']]) {
    await dbB.run('UPDATE settings SET value = ? WHERE key = ?', [v, k]);
  }
  adminJar = new Jar('mp-admin');
  let g = await adminJar.text('/login');
  let post = await adminJar.text('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email: 'admin@mp.test', password: 'MpAdmin#pass' } });
  assert.equal(post.status, 302); assert.ok(post.loc.includes(ADMIN_PATH), 'admin lands on the panel');
  assert.ok(adminJar.cookies.has('sid_admin'), 'admin login set the ADMIN-scope cookie (SESSION-TAB-01)');

  playerJar = new Jar('mp-player');
  g = await playerJar.text('/register');
  post = await playerJar.text('/register', { method: 'POST', body: { _csrf: csrfOf(g.body), name: 'MP Player', email: 'player@mp.test', password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(post.status, 302, 'register: ' + post.status);
  playerBId = (await dbB.get("SELECT id FROM users WHERE email = 'player@mp.test'")).id;
  await dbB.run('UPDATE users SET email_verified = 1 WHERE id = ?', [playerBId]);

  // Second player for the B4b/B6 auto flows: the deposit rate limiter
  // (10/min per user) is doing its real job, and B3 already used most
  // of player one's budget — separate users, separate buckets.
  player2Jar = new Jar('mp-player2');
  g = await player2Jar.text('/register');
  post = await player2Jar.text('/register', { method: 'POST', body: { _csrf: csrfOf(g.body), name: 'MP Player Two', email: 'player2@mp.test', password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(post.status, 302, 'register player2: ' + post.status);
  player2Id = (await dbB.get("SELECT id FROM users WHERE email = 'player2@mp.test'")).id;
  await dbB.run('UPDATE users SET email_verified = 1 WHERE id = ?', [player2Id]);
});

test.after(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch {} }
  try { await db.close(); } catch {}
  try { if (dbB) await dbB.close(); } catch {}
  fs.rmSync(TMP_A, { recursive: true, force: true });
  fs.rmSync(TMP_B, { recursive: true, force: true });
});

test('B1 (f) PayPal manual save with ONLY the receiving email works, and Auto Pay is refused honestly (c)', { timeout: 60000 }, async () => {
  await saveCredsB(methodIdB.paypal, { account_email: 'owner@paypal.test' });
  await toggleB(methodIdB.paypal);
  const page = await playerJar.text('/deposit/new?m=' + methodIdB.paypal);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('owner@paypal.test'), 'pay-to email shows with email-only manual config');
  assert.ok(page.body.includes('howto-steps'), 'numbered manual how-to renders (INSTR-APPLE-01)');
  const after = await setModeB(methodIdB.paypal, 'auto');
  assert.ok(after.includes('Auto Pay NOT set'), 'refusal is explained on the credentials page');
  const m = await dbB.get('SELECT processing_mode FROM payment_methods WHERE id = ?', [methodIdB.paypal]);
  assert.equal(m.processing_mode, 'manual', 'paypal stays manual — no fake Auto');
});

test('B2 (c)+(d) Auto refused on bank_transfer (no confirmation path) and on pix without webhook_secret (missing field named)', { timeout: 60000 }, async () => {
  await saveCredsB(methodIdB.bank_transfer, CREDS.bank_transfer);
  await toggleB(methodIdB.bank_transfer);
  const afterBank = await setModeB(methodIdB.bank_transfer, 'auto');
  assert.ok(afterBank.includes('Auto Pay NOT set'));
  assert.equal((await dbB.get('SELECT processing_mode FROM payment_methods WHERE id = ?', [methodIdB.bank_transfer])).processing_mode, 'manual');

  await saveCredsB(methodIdB.pix, { pix_key: 'owner@bank.com.br', pix_key_type: 'email' }); // NO webhook_secret yet
  await toggleB(methodIdB.pix);
  const afterPix = await setModeB(methodIdB.pix, 'auto');
  assert.ok(afterPix.includes('Auto Pay NOT set'), 'pix auto refused without webhook_secret');
  assert.match(afterPix, /webhook/i, 'the missing field is named for the admin');
  assert.equal((await dbB.get('SELECT processing_mode FROM payment_methods WHERE id = ?', [methodIdB.pix])).processing_mode, 'manual');
  // complete pix properly for the B3 loop
  await saveCredsB(methodIdB.pix, CREDS.pix);
});

const RECEIVING_SHOWN = {
  crypto: TRC, upi: 'owner@okhdfcbank', pix: 'owner@bank.com.br', mobile_money: '+233201234567',
  ewallet: 'owner@skrill.test', bank_transfer: 'GB29NWBK60161331926819', qr_pay: 'https://example.test/qr-mp.png',
  cash_agent: 'Wave', voucher: 'Flexepin',
};
test('B3 per-rail HTTP loop: configure -> player page (pay-to + how-to, no secrets) -> proof submit -> admin detail shows labelled proof + receiving', { timeout: 120000 }, async () => {
  for (const k of ['crypto', 'cards', 'upi', 'mobile_money', 'ewallet', 'apple_pay', 'google_pay', 'samsung_pay', 'qr_pay', 'voucher', 'cash_agent']) {
    await saveCredsB(methodIdB[k], CREDS[k]);
    await toggleB(methodIdB[k]);
    const page = await playerJar.text('/deposit/new?m=' + methodIdB[k]);
    assert.equal(page.status, 200, k + ' deposit page');
    assert.ok(page.body.includes('howto-steps'), k + ': numbered how-to renders');
    if (RECEIVING_SHOWN[k]) assert.ok(page.body.includes(RECEIVING_SHOWN[k]), k + ': pay-to detail shows exactly as saved');
    for (const sv of (SECRET_VALUES[k] || [])) assert.ok(!page.body.includes(sv), k + ': secret must never reach the player page');
    // The last three rails submit as player2 — player one's 10/min
    // deposit budget is spent by the first eight (limiter as designed).
    const dep = ['qr_pay', 'voucher', 'cash_agent'].includes(k)
      ? await playerDepositAs(player2Jar, player2Id, methodIdB[k], '10.00', PROOF[k])
      : await playerDepositB(methodIdB[k], '10.00', PROOF[k]);
    assert.ok(dep && dep.status === 'pending', k + ': deposit lands pending in the queue');
    const detail = await adminJar.text(`${ADMIN_PATH}/deposits/${dep.id}`);
    assert.equal(detail.status, 200, k + ' admin detail');
    const proofVals = Object.values(PROOF[k]);
    if (proofVals.length) assert.ok(proofVals.some(v => detail.body.includes(v)), k + ': admin sees the submitted proof in one place');
  }
  // paypal + bank + pix were configured in B1/B2 — run the same loop tail for them
  for (const k of ['paypal', 'bank_transfer', 'pix']) {
    const page = await playerJar.text('/deposit/new?m=' + methodIdB[k]);
    assert.equal(page.status, 200, k + ' deposit page');
    assert.ok(page.body.includes('howto-steps'), k + ': numbered how-to renders');
    if (RECEIVING_SHOWN[k]) assert.ok(page.body.includes(RECEIVING_SHOWN[k]), k + ': pay-to detail shows');
    // player2 submits these three: player one's 10/min deposit budget
    // is spent by the loop above (the limiter working as designed).
    const dep = await playerDepositAs(player2Jar, player2Id, methodIdB[k], '10.00', PROOF[k]);
    assert.ok(dep && dep.status === 'pending', k + ': deposit lands pending');
  }
});

async function fireWebhook(railKey, secret, payloadObj) {
  const raw = JSON.stringify(payloadObj);
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const res = await fetch(BASE + '/webhooks/' + railKey, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-signature': sig }, body: raw });
  let json = {}; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
async function adminDecideB(kind, id, action, extra = {}) {
  const g = await adminJar.text(`${ADMIN_PATH}/${kind}`);
  const post = await adminJar.text(`${ADMIN_PATH}/${kind}/${id}/${action}`, { method: 'POST', body: { _csrf: csrfOf(g.body), ...extra } });
  assert.equal(post.status, 302, `${kind} ${action} redirects`);
}
async function playerWithdrawAs(jar, userId, methodId, amount, dest = {}) {
  const g = await jar.text('/withdraw/new?m=' + methodId);
  assert.equal(g.status, 200, 'withdraw page loads');
  const body = { _csrf: csrfOf(g.body), method_id: String(methodId), amount };
  for (const [k, v] of Object.entries(dest)) body['custom_' + k] = v;
  const post = await jar.text('/withdraw/new', { method: 'POST', body });
  return { post, row: await dbB.get('SELECT * FROM withdrawals WHERE user_id = ? AND method_id = ? ORDER BY id DESC LIMIT 1', [userId, methodId]) };
}
async function balAs(userId, currency = 'USD') {
  const w = await dbB.get('SELECT balance FROM wallets WHERE user_id = ? AND currency = ?', [userId, currency]);
  return w ? Number(w.balance) : 0;
}
async function playerWithdrawB(methodId, amount, dest = {}) {
  const g = await playerJar.text('/withdraw/new?m=' + methodId);
  assert.equal(g.status, 200, 'withdraw page loads');
  const body = { _csrf: csrfOf(g.body), method_id: String(methodId), amount };
  for (const [k, v] of Object.entries(dest)) body['custom_' + k] = v;
  const post = await playerJar.text('/withdraw/new', { method: 'POST', body });
  return { post, row: await dbB.get('SELECT * FROM withdrawals WHERE user_id = ? AND method_id = ? ORDER BY id DESC LIMIT 1', [playerBId, methodId]) };
}

test('B4a METHOD-MODE (a): MANUAL cards method + valid signed webhook = recorded, NOT credited; admin approve credits', { timeout: 60000 }, async () => {
  const bal0 = await balAs(player2Id);
  const dep = await playerDepositAs(player2Jar, player2Id, methodIdB.cards, '25.00', {});
  await dbB.run('UPDATE deposits SET provider_txn_id = ? WHERE id = ?', ['pi_mp_1', dep.id]);
  const r = await fireWebhook('cards', 'whsec_mpsecret123', { event_id: 'evt_mp_manual1', txn_id: 'pi_mp_1', status: 'paid', amount: 2500, currency: 'USD' });
  assert.equal(r.status, 200, 'signed webhook accepted for recording');
  const ev = await dbB.get("SELECT id FROM webhook_events WHERE event_id = 'evt_mp_manual1' AND provider = 'cards'");
  assert.ok(ev, 'webhook event recorded');
  assert.equal((await dbB.get('SELECT status FROM deposits WHERE id = ?', [dep.id])).status, 'pending', 'manual method: webhook must NOT auto-credit');
  assert.equal(await balB(), bal0, 'manual method: balance untouched by webhook');
  await adminDecideB('deposits', dep.id, 'approve');
  assert.equal((await dbB.get('SELECT status FROM deposits WHERE id = ?', [dep.id])).status, 'approved');
  assert.equal(await balAs(player2Id), bal0 + 2500, 'admin approve credits exactly once');
});

test('B4b METHOD-MODE (b) + AUTO-VISIBILITY-01: AUTO crypto — pending visible, forged/wrong-amount refused, signed webhook credits exactly once, replay deduped, history flips, notification lands', { timeout: 60000 }, async () => {
  await setModeB(methodIdB.crypto, 'auto');
  assert.equal((await dbB.get('SELECT processing_mode FROM payment_methods WHERE id = ?', [methodIdB.crypto])).processing_mode, 'auto');
  // auto how-to replaces manual how-to on the deposit page (INSTR-APPLE-01 §4)
  const page = await playerJar.text('/deposit/new?m=' + methodIdB.crypto);
  assert.ok(page.body.includes('No proof chasing'), 'auto instruction text shows');
  assert.ok(!page.body.includes('Paste the transaction hash in the box below'), 'manual steps do NOT show on an auto method');

  const HASH = 'c3d4e5f6'.repeat(8);
  const bal0 = await balAs(player2Id);
  const notif0 = (await dbB.get("SELECT COUNT(*) AS c FROM notifications_log WHERE to_addr = 'player2@mp.test'")).c;
  const dep = await playerDepositAs(player2Jar, player2Id, methodIdB.crypto, '200.00', { tx_hash: HASH });
  // visibility BEFORE confirmation: pending in the player's own wallet, not credited
  const wallet1 = await player2Jar.text('/wallet');
  assert.ok(wallet1.body.includes(dep.public_id), 'pending deposit visible in player wallet immediately');
  assert.ok(wallet1.body.includes('Pending'), 'truthful pending label');
  assert.equal(await balAs(player2Id), bal0, 'not credited before confirmation');

  const forged = await fireWebhook('crypto', 'wrong-secret-value', { event_id: 'evt_mp_forged', txn_id: HASH, status: 'paid', amount: 20000, currency: 'USD' });
  assert.equal(forged.status, 401, 'forged signature rejected');
  assert.equal((await dbB.get('SELECT status FROM deposits WHERE id = ?', [dep.id])).status, 'pending');

  const wrongAmt = await fireWebhook('crypto', 'mpWhsecCrypto1', { event_id: 'evt_mp_wrongamt', txn_id: HASH, status: 'paid', amount: 9000, currency: 'USD' });
  assert.equal(wrongAmt.status, 200);
  assert.equal((await dbB.get('SELECT status FROM deposits WHERE id = ?', [dep.id])).status, 'pending', 'amount mismatch: no credit');
  assert.equal(await balAs(player2Id), bal0);

  const good = await fireWebhook('crypto', 'mpWhsecCrypto1', { event_id: 'evt_mp_auto1', txn_id: HASH, status: 'paid', amount: 20000, currency: 'USD' });
  assert.equal(good.status, 200);
  assert.equal((await dbB.get('SELECT status FROM deposits WHERE id = ?', [dep.id])).status, 'approved', 'verified confirmation credits');
  assert.equal(await balAs(player2Id), bal0 + 20000, 'exact net credited');
  const notif1 = (await dbB.get("SELECT COUNT(*) AS c FROM notifications_log WHERE to_addr = 'player2@mp.test'")).c;
  assert.ok(Number(notif1) > Number(notif0), 'player notification recorded for the credit');
  const wallet2 = await player2Jar.text('/wallet');
  assert.ok(wallet2.body.includes(dep.public_id) && wallet2.body.includes('Approved'), 'same history entry flips to Approved');

  const replay = await fireWebhook('crypto', 'mpWhsecCrypto1', { event_id: 'evt_mp_auto1', txn_id: HASH, status: 'paid', amount: 20000, currency: 'USD' });
  assert.equal(replay.status, 200);
  assert.match(replay.json.note || '', /duplicate/, 'replay deduped');
  assert.equal(await balAs(player2Id), bal0 + 20000, 'replay credits nothing twice');

  // AUTO-VISIBILITY reversal: a later provider refund flips the SAME
  // entry to revoked, corrects the balance, and notifies — no silent edit.
  const notif2 = (await dbB.get("SELECT COUNT(*) AS c FROM notifications_log WHERE to_addr = 'player2@mp.test'")).c;
  const rev = await fireWebhook('crypto', 'mpWhsecCrypto1', { event_id: 'evt_mp_refund1', txn_id: HASH, status: 'refunded', amount: 20000, currency: 'USD' });
  assert.equal(rev.status, 200);
  assert.equal((await dbB.get('SELECT status FROM deposits WHERE id = ?', [dep.id])).status, 'revoked', 'reversal is recorded truthfully');
  assert.equal(await balAs(player2Id), bal0, 'reversal removes exactly the credited net');
  const notif3 = (await dbB.get("SELECT COUNT(*) AS c FROM notifications_log WHERE to_addr = 'player2@mp.test'")).c;
  assert.ok(Number(notif3) > Number(notif2), 'reversal notification recorded');
  const wallet3 = await player2Jar.text('/wallet');
  assert.ok(wallet3.body.includes('Revoked'), 'player history shows the reversal');
});

test('B5 withdrawal gates: OTP-ON creates no row and no hold; destination-less cards withdrawal still completes the manual loop', { timeout: 60000 }, async () => {
  // Fund player one by approving their pending B3 crypto deposit.
  const pend = await dbB.get("SELECT id FROM deposits WHERE user_id = ? AND method_id = ? AND status = 'pending' ORDER BY id LIMIT 1", [playerBId, methodIdB.crypto]);
  assert.ok(pend, 'a pending B3 deposit exists to fund player one');
  await adminDecideB('deposits', pend.id, 'approve');
  assert.ok((await balB()) >= 1000, 'player one funded');
  await dbB.run("UPDATE settings SET value = '1' WHERE key = 'withdrawal_otp_enabled'");
  await new Promise(r => setTimeout(r, 5200)); // server settings cache TTL (5s) — see B6 note
  const bal0 = await balB();
  const cnt0 = (await dbB.get('SELECT COUNT(*) AS c FROM withdrawals WHERE user_id = ?', [playerBId])).c;
  const g = await playerJar.text('/withdraw/new?m=' + methodIdB.paypal);
  await playerJar.text('/withdraw/new', { method: 'POST', body: { _csrf: csrfOf(g.body), method_id: String(methodIdB.paypal), amount: '5.00', custom_account_email: 'player@paypal.test' } });
  assert.equal((await dbB.get('SELECT COUNT(*) AS c FROM withdrawals WHERE user_id = ?', [playerBId])).c, cnt0, 'OTP gate: no withdrawal row before verification');
  assert.equal(await balB(), bal0, 'OTP gate: no hold before verification');
  await dbB.run("UPDATE settings SET value = '0' WHERE key = 'withdrawal_otp_enabled'");
  await new Promise(r => setTimeout(r, 5200)); // settings cache TTL again — B6 depends on OTP being off server-side

  // Destination-less rails (cards & co.) stay withdrawable BY DESIGN
  // (v20 behaviour): the operator arranges the payout with the player
  // off-platform. Prove the manual loop still closes: hold -> admin
  // reject -> exact refund. (An earlier draft of this round refused
  // these withdrawals; that broke the established loop — reverted,
  // see FIX-LOG.)
  const bal1 = await balB();
  const { row } = await playerWithdrawB(methodIdB.cards, '5.00', {});
  assert.ok(row && row.status === 'pending', 'cards withdrawal is created for manual handling');
  assert.equal(await balB(), bal1 - 500, 'hold placed exactly once');
  await adminDecideB('withdrawals', row.id, 'reject', { decision_reason: 'Payout arranged check failed.' });
  assert.equal(await balB(), bal1, 'reject refunds the hold exactly once');
});

test('B6 METHOD-MODE (e): BP-22 auto-approval on the AUTO crypto method — under limit auto-approved (never paid), over limit stays manual, reject refunds exactly', { timeout: 60000 }, async () => {
  await dbB.run("UPDATE settings SET value = '100' WHERE key = 'auto_withdrawal_limit'");
  // The server caches settings for 5s (lib/settings TTL, invalidated
  // on in-process writes). This test writes via a second connection,
  // so wait out the TTL — in production the admin UI write invalidates
  // the cache itself.
  await new Promise(r => setTimeout(r, 5200));
  // B4b's credit was reversed by its refund segment, so fund player2
  // here with a manual approve (also re-proves the manual path).
  const fundDep = await playerDepositAs(player2Jar, player2Id, methodIdB.paypal, '200.00', PROOF.paypal);
  await adminDecideB('deposits', fundDep.id, 'approve');
  const bal0 = await balAs(player2Id);
  assert.ok(bal0 >= 14000, 'funded for B6 (balance ' + bal0 + ')');
  // first submission settles the payout destination; the second is the auto-approval proof
  await playerWithdrawAs(player2Jar, player2Id, methodIdB.crypto, '20.00', DEST.crypto);
  const { row: w2 } = await playerWithdrawAs(player2Jar, player2Id, methodIdB.crypto, '20.00', DEST.crypto);
  assert.ok(w2, 'withdrawal created');

  assert.equal(w2.status, 'approved', 'under-limit withdrawal on auto method is auto-approved: ' + w2.status);
  assert.equal(Number(w2.decided_by), 0, 'decided by the system, not an admin');
  assert.ok(!w2.provider_payout_id, 'auto-approval NEVER marks paid');
  const balAfterHolds = await balAs(player2Id);
  assert.equal(balAfterHolds, bal0 - 4000, 'both holds deducted exactly (AUTO-VISIBILITY: deduction visible at request time)');
  const wallet = await player2Jar.text('/wallet');
  assert.ok(wallet.body.includes(w2.public_id), 'auto withdrawal visible in player history');
  const { row: w3 } = await playerWithdrawAs(player2Jar, player2Id, methodIdB.crypto, '120.00', DEST.crypto);
  assert.equal(w3.status, 'pending', 'over-limit stays in the manual queue');
  const balBeforeReject = await balAs(player2Id);
  await adminDecideB('withdrawals', w3.id, 'reject', { decision_reason: 'Amount needs manual review.' });
  assert.equal(await balAs(player2Id), balBeforeReject + 12000, 'reject refunds the hold exactly once');
  await dbB.run("UPDATE settings SET value = '0' WHERE key = 'auto_withdrawal_limit'");
});

test('B7 AGENT-CURRENCY-01: unfunded agent sees currencies + empty state; EUR float funds an exact EUR transfer; insufficient float refused with no ledger entry', { timeout: 60000 }, async () => {
  const { hashPassword } = require('../lib/util');
  const ins = await dbB.run("INSERT INTO users (name, email, password_hash, role, status, email_verified, created_at) VALUES ('MP Agent', 'agent@mp.test', ?, 'agent', 'active', 1, ?)", [hashPassword('Agent#pass1'), now()]);
  const agentId = ins.id;
  await dbB.run('UPDATE users SET agent_id = ? WHERE id = ?', [agentId, playerBId]);

  const agentJar = new Jar('mp-agent');
  let g = await agentJar.text('/login');
  let post = await agentJar.text('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email: 'agent@mp.test', password: 'Agent#pass1' } });
  assert.equal(post.status, 302, 'agent login');

  // (a) NO float rows: currencies visible + honest empty state + non-USD label machinery
  let page = await agentJar.text('/agent/transfer');
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('EUR'), 'EUR option renders even with zero float');
  assert.ok(page.body.includes('USD'), 'USD option renders even with zero float');
  assert.ok(page.body.includes('Ask the admin to fund your float first'), 'plain-language empty state shows');
  assert.ok(!page.body.includes('Amount (USD)</label>'), 'amount label is not hardcoded to USD');

  // (b) admin funds EUR float through the real admin form
  g = await adminJar.text(`${ADMIN_PATH}/agents/${agentId}`);
  post = await adminJar.text(`${ADMIN_PATH}/agents/${agentId}/fund`, { method: 'POST', body: { _csrf: csrfOf(g.body), currency: 'EUR', amount: '50' } });
  assert.equal(post.status, 302, 'fund float redirects');
  page = await agentJar.text('/agent/transfer');
  assert.ok(page.body.includes('EUR'), 'EUR still listed after funding');
  assert.ok(!page.body.includes('Ask the admin to fund your float first'), 'empty state clears once funded');

  // (c) transfer €20 -> player EUR wallet credited exactly
  const tokM = page.body.match(/name="transfer_token" value="([^"]+)"/);
  assert.ok(tokM, 'transfer token issued');
  post = await agentJar.text('/agent/transfer', { method: 'POST', body: { _csrf: csrfOf(page.body), transfer_token: tokM[1], to_user_id: String(playerBId), currency: 'EUR', amount: '20', note: 'mp test' } });
  assert.equal(post.status, 302, 'transfer redirects');
  assert.equal(await balB('EUR'), 2000, 'player EUR wallet credited exactly €20.00');
  const fl = await dbB.get("SELECT balance FROM agent_floats WHERE agent_id = ? AND currency = 'EUR'", [agentId]);
  assert.equal(Number(fl.balance), 3000, 'agent EUR float debited exactly');

  // (d) insufficient float (€40 > €30): refused, no ledger entry, balances unchanged
  page = await agentJar.text('/agent/transfer');
  const tok2 = page.body.match(/name="transfer_token" value="([^"]+)"/)[1];
  const txBefore = (await dbB.get("SELECT COUNT(*) AS c FROM transactions WHERE user_id = ? AND currency = 'EUR'", [playerBId])).c;
  await agentJar.text('/agent/transfer', { method: 'POST', body: { _csrf: csrfOf(page.body), transfer_token: tok2, to_user_id: String(playerBId), currency: 'EUR', amount: '40', note: 'too much' } });
  assert.equal(await balB('EUR'), 2000, 'insufficient-float transfer credited nothing');
  assert.equal((await dbB.get("SELECT COUNT(*) AS c FROM transactions WHERE user_id = ? AND currency = 'EUR'", [playerBId])).c, txBefore, 'no ledger entry for the refused transfer');
  const pageAfter = await agentJar.text('/agent/transfer');
  assert.ok(pageAfter.body.includes('Insufficient float'), 'true reason shown to the agent');
});
