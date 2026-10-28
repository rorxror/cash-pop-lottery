'use strict';
/* V20 / CHAIN — U-21 §5 polish + U-23 import/export regression tests.
   Run: node --test test/v20-chain.test.js   (port 4143, /tmp/chain.sqlite)
   §5: admin credentials save validates with true reasons BEFORE writing
   (invalid save refused + stored config unchanged; blank password keeps
   the saved secret), the credentials form renders rails.js help text and
   never echoes a stored secret, secrets sit encrypted at rest, and the
   player withdrawal form asks for the rail's OWN payout fields
   (withdrawUserFields) — not the deposit proof fields.
   U-23: CSV exports (human headers, known rows, audit-logged, players
   get the stealth 404), import dry-run writes nothing and reports
   per-row reasons, execute imports, the SAME file again adds 0 rows,
   and money datasets have no import path at all. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 4143;
const BASE = 'http://localhost:' + PORT;
const AP = '/ops-7f3a9c-console';
const DBFILE = '/tmp/chain.sqlite';
const ENC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

process.env.SQLITE_PATH = DBFILE;
process.env.DB_DRIVER = 'sqlite';
process.env.CREDENTIAL_ENCRYPTION_KEY = ENC_KEY;
delete process.env.DATABASE_URL;

const { openDB } = require('../lib/db');
const money = require('../lib/money');
const audit = require('../lib/audit');

class Jar {
  constructor(ua) { this.cookies = new Map(); this.ua = ua || 'chain-test'; }
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
  async text(p, opts) { const r = await this.req(p, opts); return { status: r.status, loc: r.headers.get('location') || '', headers: r.headers, body: await r.text() }; }
  async post(p, body) { return this.text(p, { method: 'POST', body }); }
}
function csrfOf(html) { const m = String(html).match(/name="_csrf" value="([^"]+)"/); return m && m[1]; }
async function csrfFor(jar, getPath) { const g = await jar.text(getPath); assert.equal(g.status, 200, 'csrf page ' + getPath + ' -> ' + g.status); return csrfOf(g.body); }
async function waitHealthy(tries = 80) {
  for (let i = 0; i < tries; i++) { try { const r = await fetch(BASE + '/healthz'); if (r.status === 200) return true; } catch {} await new Promise(r => setTimeout(r, 500)); }
  return false;
}

let server = null, db = null;
let admin, player;
let playerId, bankId, upiId, cardsId, cryptoId;
const BANK_ACCT = 'GB29NWBK60161331926819';
const CARDS_SECRET = 'sk_test_chainsecret123';
const CARDS_WHSEC = 'whsec_chainsecret123';

test.before(async () => {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DBFILE + suffix); } catch {} }
  const env = { ...process.env,
    PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite', SQLITE_PATH: DBFILE,
    TICKET_HMAC_SECRET: 'chain-test-hmac-secret-0123456789abcdef0123456789',
    CREDENTIAL_ENCRYPTION_KEY: ENC_KEY,
    ADMIN_SEED_EMAIL: 'admin@chain.test', ADMIN_SEED_PASSWORD: 'ChainAdmin#pass', ADMIN_SEED_NAME: 'Chain Admin' };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[chain server] ' + d));
  assert.ok(await waitHealthy(), 'server must boot');
  db = openDB().db;
  bankId = (await db.get("SELECT id FROM payment_methods WHERE slug = 'rail-bank_transfer'")).id;
  upiId = (await db.get("SELECT id FROM payment_methods WHERE slug = 'rail-upi'")).id;
  cardsId = (await db.get("SELECT id FROM payment_methods WHERE slug = 'rail-cards'")).id;
  cryptoId = (await db.get("SELECT id FROM payment_methods WHERE slug = 'rail-crypto'")).id;

  admin = new Jar('chain-admin');
  let g = await admin.text('/login');
  let post = await admin.post('/login', { _csrf: csrfOf(g.body), email: 'admin@chain.test', password: 'ChainAdmin#pass' });
  assert.equal(post.status, 302); assert.ok(post.loc.includes(AP), 'admin lands on console');

  player = new Jar('chain-player');
  g = await player.text('/register');
  post = await player.post('/register', { _csrf: csrfOf(g.body), name: 'Chain Player One', email: 'chain1@chain.test', password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' });
  assert.equal(post.status, 302, 'register -> ' + post.status);
  playerId = (await db.get("SELECT id FROM users WHERE email = 'chain1@chain.test'")).id;
  await db.run('UPDATE users SET email_verified = 1 WHERE id = ?', [playerId]);

  // Withdrawal OTP off through the real settings toggles form (proven pattern).
  const TOGGLES_ON = { registration_enabled: '1', policy_agreement: '1', secure_password: '1', notifications_enabled: '1', deposits_enabled: '1', withdrawals_enabled: '1', cookie_consent_enabled: '1', verified_contact_required: '1', beacon_enabled: '1', breached_password_check: '1', csp_enabled: '1', password_login_enabled: '1', withdrawal_otp_enabled: '1' };
  const noOtp = { ...TOGGLES_ON }; delete noOtp.withdrawal_otp_enabled;
  await admin.post(AP + '/settings/toggles', { _csrf: await csrfFor(admin, AP + '/settings'), ...noOtp });

  // Bank rail configured through the real credentials form + enabled.
  await saveCreds(bankId, { bank_name: 'Chain Bank', account_name: 'Chain Holdings', account_number: BANK_ACCT, swift: 'CHASUS33', routing_number: '' });
  await admin.post(AP + '/methods/' + bankId + '/toggle', { _csrf: await csrfFor(admin, AP + '/methods') });

  // Player deposit $10 via bank (deposit fields: reference + sender name), admin approves.
  g = await player.text('/deposit/new?m=' + bankId);
  post = await player.post('/deposit/new', { _csrf: csrfOf(g.body), method_id: String(bankId), amount: '10.00', custom_reference: 'REF-CHAIN-1', custom_sender_name: 'Chain Player One' });
  assert.equal(post.status, 302, 'deposit submit -> ' + post.status);
  const dep = await db.get('SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 1', [playerId]);
  assert.ok(dep && dep.status === 'pending', 'deposit pending');
  const appr = await admin.post(AP + '/deposits/' + dep.id + '/approve', { _csrf: await csrfFor(admin, AP + '/deposits/' + dep.id) });
  assert.equal(appr.status, 302);
  assert.equal((await db.get('SELECT status FROM deposits WHERE id = ?', [dep.id])).status, 'approved');

  // Buy a $10 ticket (meets the 1x turnover gate on the $10 deposit).
  g = await player.text('/play');
  post = await player.post('/play/buy', { _csrf: csrfOf(g.body), pops: '7', wager: '1000', draw_type: 'DAY', num_draws: '1', currency: 'USD' });
  assert.ok([200, 302].includes(post.status), 'ticket buy -> ' + post.status);
  const tk = await db.get('SELECT * FROM tickets WHERE user_id = ? ORDER BY id DESC LIMIT 1', [playerId]);
  assert.ok(tk, 'ticket exists after buy');

  // Admin tops the player up $50 by balance adjustment (not a deposit).
  const adj = await admin.post(AP + '/users/' + playerId + '/adjust', { _csrf: await csrfFor(admin, AP + '/users/' + playerId), direction: 'add', amount: '50.00', remark: 'chain test funding' });
  assert.equal(adj.status, 302);
  const wal = await db.get("SELECT balance FROM wallets WHERE user_id = ? AND currency = 'USD'", [playerId]);
  assert.equal(Number(wal.balance), 5000, 'balance is the $50 adjustment after the $10 ticket spend');

  // Support thread through the real flow.
  g = await player.text('/support');
  post = await player.post('/support/new', { _csrf: csrfOf(g.body), subject: 'Chain help needed', message: 'Please check my deposit REF-CHAIN-1.', priority: 'medium' });
  assert.equal(post.status, 302, 'support create -> ' + post.status);
});

test.after(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch {} }
  try { if (db) await db.close(); } catch {}
});

async function saveCreds(methodId, fields) {
  const g = await admin.text(AP + '/methods/' + methodId + '/credentials');
  assert.equal(g.status, 200, 'credentials page -> ' + g.status);
  const post = await admin.post(AP + '/methods/' + methodId + '/credentials', { _csrf: csrfOf(g.body), ...fields });
  assert.equal(post.status, 302, 'credentials save -> ' + post.status);
  return g.body;
}
async function flashAfter(jar, postRes, getPath) {
  assert.equal(postRes.status, 302, 'expected redirect, got ' + postRes.status);
  const g = await jar.text(getPath);
  return g.body;
}

/* ---------------- §5.1 / §5.2 ---------------- */

test('§5.1 invalid credential save is refused with the true reason and writes nothing', { timeout: 60000 }, async () => {
  const post = await admin.post(AP + '/methods/' + upiId + '/credentials', { _csrf: await csrfFor(admin, AP + '/methods/' + upiId + '/credentials'), upi_id: 'not-an-upi', merchant_name: 'Chain Shop' });
  const page = await flashAfter(admin, post, AP + '/methods/' + upiId + '/credentials');
  assert.match(page, /UPI ID/, 'flash names the failing field with its format reason');
  assert.match(page, /NOT saved/);
  const rows = await db.query('SELECT * FROM gateway_credentials WHERE method_id = ?', [upiId]);
  assert.equal(rows.length, 0, 'refused save must write no credential rows');
});

test('§5.1 required-field refusal: crypto save missing Network names it and stores nothing', { timeout: 60000 }, async () => {
  const post = await admin.post(AP + '/methods/' + cryptoId + '/credentials', { _csrf: await csrfFor(admin, AP + '/methods/' + cryptoId + '/credentials'), asset: 'USDT', wallet_address: 'TXYZ1234567890abcdefghijklmnopqrstuv', confirmations: '', webhook_secret: '' });
  const page = await flashAfter(admin, post, AP + '/methods/' + cryptoId + '/credentials');
  assert.match(page, /Network/, 'required reason names the Network field');
  const rows = await db.query('SELECT * FROM gateway_credentials WHERE method_id = ?', [cryptoId]);
  assert.equal(rows.length, 0, 'no partial config stored');
});

test('§5.1+§5.2 valid save: help text renders, secrets never render, blank password keeps the saved secret', { timeout: 60000 }, async () => {
  await saveCreds(cardsId, { provider: 'Stripe', mode: 'sandbox', publishable_key: 'pk_test_chain123456', secret_key: CARDS_SECRET, webhook_secret: CARDS_WHSEC });
  let rows = await db.query('SELECT * FROM gateway_credentials WHERE method_id = ?', [cardsId]);
  const whsec = rows.find(r => r.field_key === 'webhook_secret');
  assert.equal(Number(whsec.field_enc), 1, 'webhook secret flagged encrypted');
  assert.ok(String(whsec.field_value).startsWith('v1:'), 'webhook secret is an envelope at rest');
  assert.ok(!String(whsec.field_value).includes(CARDS_WHSEC), 'secret plaintext not at rest');

  const page = (await admin.text(AP + '/methods/' + cardsId + '/credentials')).body;
  assert.ok(page.includes('Leave blank to keep the saved value.'), 'password fields carry the keep-saved help');
  assert.ok(page.includes('Only needed for the provider/API'), 'rails.js help text reaches the form (§5.2)');
  assert.ok(page.includes('pk_test_chain123456'), 'non-secret publishable key shows its saved value');
  assert.ok(!page.includes(CARDS_WHSEC) && !page.includes(CARDS_SECRET), 'stored secrets never render into the page');

  // Blank password + a bad non-secret value: validation refuses, and the
  // blank must NOT wipe (or pass over) the saved secret.
  const post = await admin.post(AP + '/methods/' + cardsId + '/credentials', { _csrf: await csrfFor(admin, AP + '/methods/' + cardsId + '/credentials'), provider: 'Stripe', mode: 'sandbox', publishable_key: 'not-a-stripe-key', secret_key: '', webhook_secret: '' });
  const after = await flashAfter(admin, post, AP + '/methods/' + cardsId + '/credentials');
  assert.match(after, /Publishable key/, 'refusal names the bad field');
  rows = await db.query('SELECT * FROM gateway_credentials WHERE method_id = ?', [cardsId]);
  const pk = rows.find(r => r.field_key === 'publishable_key');
  const { decryptField } = require('../lib/credentials');
  assert.equal(decryptField(pk.field_value, pk.field_enc), 'pk_test_chain123456', 'stored config unchanged after refused save');
  assert.equal(decryptField(rows.find(r => r.field_key === 'webhook_secret').field_value, 1), CARDS_WHSEC, 'blank password kept the saved secret');
});

/* ---------------- §5.3 ---------------- */

test('§5.3 deposit page shows the rail receiving details exactly as saved', { timeout: 60000 }, async () => {
  const page = await player.text('/deposit/new?m=' + bankId);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(BANK_ACCT), 'player sees the saved bank account number');
  assert.ok(page.body.includes('Chain Bank'), 'player sees the saved bank name');
  assert.ok(page.body.includes('Transfer reference'), 'deposit form asks for the deposit proof field');
});

test('§5.3 withdrawal form asks for the player OWN payout fields, not deposit proof', { timeout: 60000 }, async () => {
  const page = await player.text('/withdraw/new?m=' + bankId);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('Your account holder name'), 'withdrawal asks for own account name');
  assert.ok(page.body.includes('Your account number / IBAN'), 'withdrawal asks for own account number');
  assert.ok(page.body.includes('Your bank name'), 'withdrawal asks for own bank name');
  assert.ok(!page.body.includes('Transfer reference'), 'deposit proof field is gone from withdrawals');
  assert.ok(!page.body.includes('Name on the sending account'), 'deposit sender field is gone from withdrawals');
});

test('§5.3 withdrawal missing a required rail field is refused with its true reason and writes nothing', { timeout: 60000 }, async () => {
  const before = (await db.get('SELECT COUNT(*) AS c FROM withdrawals WHERE user_id = ?', [playerId])).c;
  const g = await player.text('/withdraw/new?m=' + bankId);
  const post = await player.post('/withdraw/new', { _csrf: csrfOf(g.body), method_id: String(bankId), amount: '20.00', custom_account_name: 'Chain Player One', custom_bank_name: 'Chain Bank', custom_swift: '' });
  const page = await flashAfter(player, post, '/withdraw/new?m=' + bankId);
  assert.match(page, /Your account number \/ IBAN.*required/, 'true reason names the missing payout field');
  const afterCount = (await db.get('SELECT COUNT(*) AS c FROM withdrawals WHERE user_id = ?', [playerId])).c;
  assert.equal(Number(afterCount), Number(before), 'no withdrawal row written');
});

test('§5.3 valid withdrawal stores the payout details on the request', { timeout: 60000 }, async () => {
  const g = await player.text('/withdraw/new?m=' + bankId);
  const post = await player.post('/withdraw/new', { _csrf: csrfOf(g.body), method_id: String(bankId), amount: '20.00', custom_account_name: 'Chain Player One', custom_account_number: 'DE89370400440532013000', custom_bank_name: 'Chain Bank', custom_swift: '' });
  assert.equal(post.status, 302, 'withdraw submit -> ' + post.status);
  const w = await db.get('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 1', [playerId]);
  assert.ok(w, 'withdrawal row exists');
  const data = money.decodeUserData(w.user_data);
  assert.equal(data.account_number, 'DE89370400440532013000', 'payout account stored on the request');
  assert.equal(data.account_name, 'Chain Player One');
  assert.ok(!('reference' in data), 'no deposit proof keys on a withdrawal');
});

/* ---------------- U-23 export ---------------- */

test('U-23 export: player hitting the data area gets the stealth 404 (and a probe is logged)', { timeout: 60000 }, async () => {
  const r1 = await player.text(AP + '/data');
  assert.equal(r1.status, 404, 'player /data -> ' + r1.status);
  const r2 = await player.text(AP + '/data/export/users');
  assert.equal(r2.status, 404, 'player export -> ' + r2.status);
  const probe = await db.get("SELECT * FROM audit_log WHERE action = 'admin.probe' ORDER BY id DESC LIMIT 1");
  assert.ok(probe, 'probe audit row written');
});

test('U-23 export: users CSV has human headers and the known player row', { timeout: 60000 }, async () => {
  const r = await admin.text(AP + '/data/export/users');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/csv/);
  assert.match(r.headers.get('content-disposition') || '', /users-\d{4}-\d{2}-\d{2}\.csv/);
  const lines = r.body.trim().split('\r\n');
  assert.equal(lines[0], 'User ID,Full name,Email,Phone,Account type,Status,Email verified,Phone verified,KYC status,Country,Agent,Referral code,Referred by,Joined,Last login');
  const row = lines.find(l => l.includes('chain1@chain.test'));
  assert.ok(row, 'known player row present');
  assert.ok(row.includes('Chain Player One') && row.includes('Player') && row.includes(',Yes,'), 'row values humanised: ' + row);
  assert.ok(!lines[0].includes('created_at') && !lines[0].includes('user_id'), 'no snake_case headers');
});

test('U-23 export: ledger, deposits, withdrawals and support CSVs carry the known rows', { timeout: 60000 }, async () => {
  const ledger = await admin.text(AP + '/data/export/ledger');
  assert.equal(ledger.status, 200);
  assert.ok(ledger.body.split('\r\n')[0].startsWith('Transaction ID,Date and time,Player email,Type,Amount'), 'ledger headers human');
  assert.ok(ledger.body.includes('chain1@chain.test'), 'ledger rows include the player');
  assert.ok(ledger.body.includes('10.00'), 'ledger shows major-unit amounts');

  const deps = await admin.text(AP + '/data/export/deposits');
  assert.equal(deps.status, 200);
  assert.ok(deps.body.includes('REF-CHAIN-1'), 'deposit export decodes the submitted proof');
  assert.ok(deps.body.includes('Bank Transfer'), 'deposit export names the method');

  const wds = await admin.text(AP + '/data/export/withdrawals');
  assert.equal(wds.status, 200);
  assert.ok(wds.body.includes('DE89370400440532013000'), 'withdrawal export carries the payout details');

  const sup = await admin.text(AP + '/data/export/support_tickets');
  assert.equal(sup.status, 200);
  assert.ok(sup.body.includes('Chain help needed'), 'support export carries the known ticket');

  const draws = await admin.text(AP + '/data/export/draws');
  assert.equal(draws.status, 200);
  assert.ok(draws.body.split('\r\n').length > 2, 'draws export has rows');

  const tickets = await admin.text(AP + '/data/export/tickets');
  assert.equal(tickets.status, 200);
  assert.ok(tickets.body.includes('chain1@chain.test'), 'tickets export carries the bought ticket');

  const auditRow = await db.get("SELECT * FROM audit_log WHERE action = 'data.export' AND entity_id = 'users'");
  assert.ok(auditRow, 'export audit row exists');
  const detail = JSON.parse(auditRow.detail);
  assert.ok(detail.rows >= 2 && detail.dataset === 'users', 'audit detail carries dataset + row count');
});

test('U-23 export: a future date range exports headers only', { timeout: 60000 }, async () => {
  const r = await admin.text(AP + '/data/export/users?from=2999-01-01&to=2999-01-02');
  assert.equal(r.status, 200);
  assert.equal(r.body.trim().split('\r\n').length, 1, 'only the header row');
});

/* ---------------- U-23 import ---------------- */

const PAGES_CSV = ['slug,name,title,meta_title,meta_desc,body,status,sort',
  'chain-help,Chain Help,Chain Help Page,,, <p>Hello chain</p>,published,0',
  'BAD SLUG,Bad,Bad Page,,,<p>x</p>,published,0',
  'chain-help,Dup,Dup Page,,,<p>y</p>,published,0'].join('\n');

test('U-23 import: the data page states plainly that money can never be imported, and offers no money dataset', { timeout: 60000 }, async () => {
  const page = await admin.text(AP + '/data');
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('Money can never be imported.'), 'money warning in plain words');
  assert.ok(page.body.includes('Balances, the ledger (transaction history), deposits and withdrawals are not accepted here in any form'), 'warning names the money datasets');
  assert.ok(!page.body.includes('value="ledger"') && !page.body.includes('value="users"'), 'import select offers no money/identity dataset');
});

test('U-23 import: dry-run reports per-row reasons and writes NOTHING', { timeout: 60000 }, async () => {
  const post = await admin.post(AP + '/data/import', { _csrf: await csrfFor(admin, AP + '/data'), dataset: 'pages', filename: 'pages.csv', csv_text: PAGES_CSV });
  assert.equal(post.status, 200, 'dry-run renders the report -> ' + post.status);
  assert.ok(post.body.includes('Nothing has been saved yet.'), 'report states nothing saved');
  assert.match(post.body, /lowercase letters, numbers and dashes/, 'rejected row carries its true reason');
  assert.ok(post.body.includes('already appears in this file'), 'in-file duplicate detected');
  const row = await db.get("SELECT * FROM pages WHERE slug = 'chain-help'");
  assert.ok(!row, 'dry-run wrote no page');
  const auditRow = await db.get("SELECT * FROM audit_log WHERE action = 'data.import_dry_run' ORDER BY id DESC LIMIT 1");
  assert.ok(auditRow, 'dry-run audit row exists');
});

test('U-23 import: execute imports the ready rows; the SAME file again adds 0', { timeout: 60000 }, async () => {
  const exec = await admin.post(AP + '/data/import/execute', { _csrf: await csrfFor(admin, AP + '/data'), dataset: 'pages', filename: 'pages.csv', csv_text: PAGES_CSV });
  assert.equal(exec.status, 302, 'execute redirects -> ' + exec.status);
  const page = await db.get("SELECT * FROM pages WHERE slug = 'chain-help'");
  assert.ok(page && page.title === 'Chain Help Page', 'page imported with its content');
  const auditRow = await db.get("SELECT * FROM audit_log WHERE action = 'data.import' ORDER BY id DESC LIMIT 1");
  assert.ok(auditRow, 'import audit row exists');
  assert.equal(JSON.parse(auditRow.detail).inserted, 1, 'audit records exactly 1 inserted');

  const exec2 = await admin.post(AP + '/data/import/execute', { _csrf: await csrfFor(admin, AP + '/data'), dataset: 'pages', filename: 'pages.csv', csv_text: PAGES_CSV });
  const landing = await flashAfter(admin, exec2, AP + '/data');
  assert.ok(landing.includes('0 new row(s) added'), 'second import adds nothing: ' + landing.slice(0, 0));
  const count = (await db.get("SELECT COUNT(*) AS c FROM pages WHERE slug = 'chain-help'")).c;
  assert.equal(Number(count), 1, 'still exactly one chain-help page');
});

test('U-23 import: malformed file (missing column) fails cleanly; a money dataset is refused', { timeout: 60000 }, async () => {
  const bad = await admin.post(AP + '/data/import', { _csrf: await csrfFor(admin, AP + '/data'), dataset: 'pages', filename: 'bad.csv', csv_text: 'slug,name\nonly-two,Cols' });
  const landing = await flashAfter(admin, bad, AP + '/data');
  assert.ok(landing.includes('missing the') && landing.includes('title') && landing.includes('column'), 'clean true reason for the malformed file');

  const moneyTry = await admin.post(AP + '/data/import', { _csrf: await csrfFor(admin, AP + '/data'), dataset: 'ledger', filename: 'money.csv', csv_text: 'a,b\n1,2' });
  const landing2 = await flashAfter(admin, moneyTry, AP + '/data');
  assert.ok(landing2.includes('Choose what you are importing'), 'money dataset has no import route');
});

test('U-23 import: canned replies import through the same flow', { timeout: 60000 }, async () => {
  const csv = 'title,body\nChain greeting,"Hello, we are checking this for you now."';
  const exec = await admin.post(AP + '/data/import/execute', { _csrf: await csrfFor(admin, AP + '/data'), dataset: 'canned_replies', filename: 'replies.csv', csv_text: csv });
  assert.equal(exec.status, 302);
  const row = await db.get("SELECT * FROM canned_replies WHERE title = 'Chain greeting'");
  assert.ok(row && row.body.includes('checking this for you'), 'canned reply imported, quoted comma intact');
});

test('U-23 export RBAC: finance exports money data but not users; import is super-only', { timeout: 60000 }, async () => {
  const rf = await admin.post(AP + '/staff', { _csrf: await csrfFor(admin, AP + '/staff'), name: 'Chain Finance', email: 'finance@chain.test', password: 'Finance#pass123', admin_role: 'finance' });
  assert.equal(rf.status, 302, 'create finance staff');
  const fin = new Jar('chain-finance');
  let g = await fin.text('/login');
  const post = await fin.post('/login', { _csrf: csrfOf(g.body), email: 'finance@chain.test', password: 'Finance#pass123' });
  assert.equal(post.status, 302, 'finance login');
  const led = await fin.text(AP + '/data/export/ledger');
  assert.equal(led.status, 200, 'finance may export the ledger (MONEY set)');
  const usr = await fin.text(AP + '/data/export/users');
  assert.equal(usr.status, 403, 'finance may NOT export users (SAFETY set)');
  const imp = await fin.post(AP + '/data/import', { _csrf: await csrfFor(fin, AP + '/data'), dataset: 'pages', filename: 'x.csv', csv_text: 'slug,name,title\nx,X,X' });
  assert.ok([403, 302].includes(imp.status), 'finance import never executes (RBAC fail-closed or handler gate) -> ' + imp.status);
  const row = await db.get("SELECT * FROM pages WHERE slug = 'x'");
  assert.ok(!row, 'no import happened for finance staff');
});

test('audit hash chain still verifies after all chain work', { timeout: 60000 }, async () => {
  const v = await audit.verifyChain(db);
  assert.equal(v.ok, true, 'chain verify: ' + JSON.stringify(v));
  assert.ok(v.checked > 10, 'chain has real rows: ' + v.checked);
});
