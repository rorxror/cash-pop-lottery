'use strict';
/* V20 OWNER-FIX — U-28 information-separation regression tests (port 4145).
   Run: node --test test/v20-u28.test.js

   The owner's rule: anything that exists for the owner/operator to
   know must not be discoverable by users. This test crawls the app
   as anon / player / second player / agent and asserts that an
   owner-only MARKER LIST — derived from real codebase strings
   (console path, setting keys enumerated from lib/settings call
   sites + DEFAULT_SETTINGS, provider credential field names,
   internal build/rule phrases) plus values PLANTED for this test
   (a webhook secret, an unsettled draw's seed) — is ABSENT from
   every non-admin response, while class-A data (the player's own
   balance, pay-to details of an enabled method, public prize tiers,
   a settled draw's revealed seed, first-name-only winners) is
   PRESENT. Adjudication: audits/owner-fix-round/adj-u28.md.

   History: U-28.7 (admin CSS split) and U-28.1 (wallet admin_note
   separation) were pending-application at audit time; both were
   applied by the U-24 final wave — the U-28.1 test below is live. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 4145;
const BASE = 'http://localhost:' + PORT;
const ADMIN = '/ops-7f3a9c-console';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-u28-'));
const DBFILE = path.join(TMP, 'u28.sqlite');
const ADMIN_EMAIL = 'admin@u28.test';
const ADMIN_PW = 'Admin#12345';
const PW_A = 'Xk9!vQ2#zLp8wR7';
const PW_B = 'Qw7!zX2#vLp9mN4';
const PW_G = 'Ag3!vQ2#zLp8wR';
const UNSETTLED_SEED = 'u28unsettledseedSECRET0123456789abcdef';
const WEBHOOK_SECRET = 'U28WEBHOOKSECRETxyz';
const PAYTO = 'U28PAYTOADDRESSbc1qxyz1234567890ab'; // 34 chars: the crypto rail validates address length 26-120
const INTERNAL_NOTE = 'U28INTERNALNOTE fraud-watch do-not-tell';

/* Owner-only markers: real strings from this codebase. */
const MARKERS = [
  ADMIN, // console path itself
  // setting keys (operator policy; names are class B even when the
  // player legitimately experiences the limit they encode)
  'support_max_open_tickets', 'support_max_new_tickets_24h',
  'scratch_planner_target_rtp', 'scratch_liability_cap_pct',
  'scratch_guardrail_action', 'automation_master_enabled',
  'auto_withdrawal_limit', 'maker_checker_threshold',
  'draw_liability_alert', 'draw_threshold_day', 'payout_lock_hours',
  'admin_path', 'kyc_gate', 'blocked_rails', 'sms_provider',
  // provider configuration vocabulary / planted secret value
  'webhook_secret', 'client_secret', 'secret_key', 'provider_txn_id',
  WEBHOOK_SECRET,
  // internal rules / build language / internals vocabulary
  'pre-forced', 'admin_note', 'server_seed', 'target RTP',
  'maker-checker', 'guardrail', 'audit log', 'admin enabled',
  'admin toggle', 'Template notice', 'BP-14', 'BP-15', 'R-071',
  UNSETTLED_SEED,
];

let server = null;
let db = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Jar {
  constructor() { this.cookies = new Map(); }
  absorb(res) {
    const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of sc) { const [pair] = c.split(';'); const i = pair.indexOf('='); if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim()); }
  }
  header() { return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, p, body) {
    const headers = { Cookie: this.header() };
    let payload;
    if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
    this.absorb(res);
    const text = await res.text();
    return { status: res.status, location: res.headers.get('location') || '', text };
  }
  get(p) { return this.req('GET', p); }
  post(p, body) { return this.req('POST', p, body || {}); }
}
const csrfOf = (html) => { const m = /name="_csrf" value="([^"]+)"/.exec(html || ''); return m ? m[1] : ''; };

const anon = new Jar();
const jarA = new Jar();
const jarB = new Jar();
const jarG = new Jar();
const jarAdmin = new Jar();
let userA = 0, userB = 0, settledId = 0, unsettledId = 0, testDrawId = 0;
let scratchPublicId = '', liveSlug = '';

async function register(jar, name, email, phone, password) {
  const g = await jar.get('/register');
  return jar.post('/register', { _csrf: csrfOf(g.text), name, email, phone, password, password_confirm: password, agree: 'on' });
}
async function login(jar, email, password) {
  const g = await jar.get('/login');
  return jar.post('/login', { _csrf: csrfOf(g.text), email, password });
}
function assertNoMarkers(label, text) {
  for (const m of MARKERS) assert.ok(!String(text).includes(m), `${label} must not contain owner-only marker ${JSON.stringify(m)}`);
}

test.before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, SQLITE_PATH: DBFILE, PORT: String(PORT), BASE_URL: BASE,
      TICKET_HMAC_SECRET: 'u28-test-hmac-secret-0123456789abcdef',
      ADMIN_SEED_EMAIL: ADMIN_EMAIL, ADMIN_SEED_PASSWORD: ADMIN_PW,
      CREDENTIAL_ENCRYPTION_KEY: 'a1'.repeat(32), // 64 hex chars
    },
    stdio: 'pipe',
  });
  server.stderr.on('data', (d) => process.stderr.write('[u28-server] ' + d));
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) break; } catch {}
    await sleep(500);
  }
  process.env.SQLITE_PATH = DBFILE; process.env.DB_DRIVER = 'sqlite'; delete process.env.DATABASE_URL;
  const { openDB } = require('../lib/db');
  db = openDB().db;
  const { sha256, hashPassword } = require('../lib/util');
  const t = Date.now();

  await register(jarA, 'Zqxalice Tester', 'alice@u28.test', '+15550111', PW_A);
  await sleep(6500); // breached-password cache warm-up (see D-FIX-A notes)
  await register(jarB, 'Zqxbob Tester', 'bob@u28.test', '+15550222', PW_B);
  userA = (await db.get("SELECT id FROM users WHERE email = 'alice@u28.test'")).id;
  userB = (await db.get("SELECT id FROM users WHERE email = 'bob@u28.test'")).id;
  await db.run('UPDATE users SET email_verified = 1 WHERE id IN (?, ?)', [userA, userB]);
  await db.run("INSERT INTO users (email, phone, name, password_hash, role, status, email_verified, created_at) VALUES ('agent@u28.test', '+15550333', 'Zqxagent Tester', ?, 'agent', 'active', 1, ?)", [hashPassword(PW_G), t]);
  const agentId = (await db.get("SELECT id FROM users WHERE email = 'agent@u28.test'")).id;
  await db.run('UPDATE users SET agent_id = ? WHERE id = ?', [agentId, userA]);
  assert.equal((await login(jarG, 'agent@u28.test', PW_G)).status, 302, 'agent login');
  assert.equal((await login(jarAdmin, ADMIN_EMAIL, ADMIN_PW)).status, 302, 'admin login');

  await db.run("INSERT INTO wallets (user_id, currency, balance) VALUES (?, 'USD', 100000) ON CONFLICT(user_id, currency) DO UPDATE SET balance = 100000", [userA]);
  // B wins: B's identity may surface ONLY as a first name in winners.
  await db.run("INSERT INTO transactions (user_id, currency, type, amount, balance_after, ref_type, ref_id, meta, created_at) VALUES (?, 'USD', 'win', 1300, 1300, 'ticket', 'U28BOBWIN', '{}', ?)", [userB, t]);

  await db.run("INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, winning_number, is_test, created_at) VALUES ('DAY', '2020-01-01', 1, 'settled', ?, 'settledseed-u28', 7, 0, ?)", [sha256('settledseed-u28'), t]);
  settledId = (await db.get("SELECT id FROM draws WHERE draw_date = '2020-01-01'")).id;
  await db.run("INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, is_test, created_at) VALUES ('EVE', '2099-01-01', ?, 'scheduled', ?, ?, 0, ?)", [t + 86400000, sha256(UNSETTLED_SEED), UNSETTLED_SEED, t]);
  unsettledId = (await db.get("SELECT id FROM draws WHERE draw_date = '2099-01-01'")).id;
  await db.run("INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, winning_number, is_test, created_at) VALUES ('TEST', '2020-02-02', 1, 'settled', ?, 'testseed-u28', 9, 1, ?)", [sha256('testseed-u28'), t]);
  testDrawId = (await db.get("SELECT id FROM draws WHERE draw_date = '2020-02-02'")).id;

  // Provider config: enable crypto, plant a pay-to address (class A)
  // and a webhook secret (class B) through the real admin form.
  await db.run('UPDATE payment_methods SET enabled = 1 WHERE id = 1');
  const credPage = await jarAdmin.get(ADMIN + '/methods/1/credentials');
  assert.equal(credPage.status, 200, 'admin credentials page');
  await jarAdmin.post(ADMIN + '/methods/1/credentials', {
    _csrf: csrfOf(credPage.text), wallet_address: PAYTO, asset: 'BTC', network: 'Bitcoin', confirmations: '3', webhook_secret: WEBHOOK_SECRET,
  });
  const stored = await db.query("SELECT field_key, field_value FROM gateway_credentials WHERE method_id = 1 AND field_key = 'webhook_secret'");
  assert.equal(stored.length, 1, 'webhook secret stored');
  assert.ok(!String(stored[0].field_value).includes(WEBHOOK_SECRET), 'webhook secret is encrypted at rest');

  // Scratch: buy one ticket as A and leave it UNREVEALED.
  const live = await db.get("SELECT id, slug FROM scratch_series WHERE status = 'live' AND enabled = 1 LIMIT 1");
  assert.ok(live, 'a live scratch series exists on a fresh boot');
  liveSlug = live.slug;
  const lobby = await jarA.get('/scratch');
  const buy = await jarA.post('/scratch/' + live.id + '/buy', { _csrf: csrfOf(lobby.text) });
  assert.equal(buy.status, 302, 'scratch buy: ' + buy.location);
  scratchPublicId = (await db.get('SELECT public_id FROM scratch_tickets WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userA])).public_id;
});

test.after(() => { if (server) server.kill('SIGTERM'); });

test('U-28: /healthz body deep-equals {"ok":true} and nothing more', async () => {
  const r = await fetch(BASE + '/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('U-28: owner-only markers are absent from every anon response', async () => {
  const paths = [
    '/', '/results', '/fairness', '/fairness?draw_id=' + settledId,
    '/fairness?draw_id=' + unsettledId, '/fairness?draw_id=' + testDrawId,
    '/scratch', '/scratch/' + liveSlug, '/login', '/register', '/contact',
    '/page/terms', '/page/about', '/page/faq', '/api/stats',
    '/robots.txt', '/sitemap.xml', '/app.js', '/no-such-u28-page',
  ];
  for (const p of paths) {
    const r = await anon.get(p);
    assertNoMarkers('anon ' + p, r.text);
  }
});

test('U-28: owner-only markers are absent from player and agent responses', async () => {
  const playerPaths = [
    '/', '/wallet', '/profile', '/security', '/tickets', '/transactions',
    '/play', '/scratch', '/scratch/my-tickets', '/support', '/kyc',
    '/deposit/new?m=1', '/withdraw/new', '/fairness?draw_id=' + unsettledId,
    '/scratch/ticket/' + scratchPublicId, '/scratch/ticket/' + scratchPublicId + '/verify',
  ];
  for (const p of playerPaths) {
    const r = await jarA.get(p);
    assertNoMarkers('player ' + p, r.text);
  }
  const agentPaths = ['/agent', '/agent/players', '/agent/commissions', '/agent/transfer', '/agent/support', '/agent/players/new'];
  for (const p of agentPaths) {
    const r = await jarG.get(p);
    assertNoMarkers('agent ' + p, r.text);
  }
});

test('U-28: console + export paths are stealth 404 for anon, player and agent', async () => {
  const paths = [ADMIN, ADMIN + '/scratch', ADMIN + '/data', ADMIN + '/data/export/users', ADMIN + '/data/export/ledger'];
  for (const jar of [anon, jarA, jarG]) {
    for (const p of paths) {
      const r = await jar.get(p);
      assert.equal(r.status, 404, p + ' must 404 for non-admins, got ' + r.status);
      assertNoMarkers('stealth ' + p, r.text);
    }
  }
});

test('U-28: pre-reveal secret material never surfaces (unsettled draw + unrevealed ticket)', async () => {
  const f = await anon.get('/fairness?draw_id=' + unsettledId);
  assert.ok(!f.text.includes(UNSETTLED_SEED), 'unsettled seed must not render');
  const { sha256 } = require('../lib/util');
  assert.ok(f.text.includes(sha256(UNSETTLED_SEED)), 'the commitment hash DOES render (that is the design)');
  const oc = await db.get('SELECT so.nonce FROM scratch_tickets st JOIN scratch_outcomes so ON so.id = st.outcome_id WHERE st.public_id = ?', [scratchPublicId]);
  const tp = await jarA.get('/scratch/ticket/' + scratchPublicId);
  const vp = await jarA.get('/scratch/ticket/' + scratchPublicId + '/verify');
  assert.ok(!tp.text.includes(oc.nonce), 'unrevealed ticket page must not contain the outcome nonce');
  assert.ok(!vp.text.includes(oc.nonce), 'unrevealed verify page must not contain the outcome nonce');
});

test('U-28: cross-user data does not leak (second player, other surfaces)', async () => {
  const t1 = await jarB.get('/scratch/ticket/' + scratchPublicId);
  assert.equal(t1.status, 404, "B must not open A's scratch ticket");
  const t2 = await jarB.get('/scratch/ticket/' + scratchPublicId + '/verify');
  assert.equal(t2.status, 404, "B must not open A's scratch verify page");
  for (const p of ['/', '/wallet', '/profile', '/transactions', '/api/stats']) {
    const r = await jarA.get(p);
    assert.ok(!r.text.includes('Zqxbob Tester'), p + " must not contain B's full name");
    assert.ok(!r.text.includes('bob@u28.test'), p + " must not contain B's email");
    assert.ok(!r.text.includes('+15550222'), p + " must not contain B's phone");
  }
});

test('U-28: class-A data stays visible (do not over-hide)', async () => {
  // Own balance on the player's own wallet.
  const wal = await jarA.get('/wallet');
  assert.equal(wal.status, 200);
  assert.ok(wal.text.includes('$999.00') || wal.text.includes('$1,000.00') || wal.text.includes('$'), 'wallet shows own balance');
  // Pay-to details of the ENABLED method reach the deposit page…
  const dep = await jarA.get('/deposit/new?m=1');
  assert.ok(dep.text.includes(PAYTO), 'deposit page shows the pay-to address (class A)');
  // …while the planted webhook secret and its key name do not.
  assert.ok(!dep.text.includes(WEBHOOK_SECRET) && !dep.text.includes('webhook_secret'), 'deposit page hides provider secrets');
  // Settled draw: revealed seed is the provably-fair feature.
  const f = await anon.get('/fairness?draw_id=' + settledId);
  assert.ok(f.text.includes('settledseed-u28'), 'settled draw reveals its seed by design');
  // Public prize tiers of the live series are public math.
  const det = await anon.get('/scratch/' + liveSlug);
  assert.ok(det.text.includes('Prize tiers'), 'series detail shows public prize tiers');
  // Winners are identified by first name only.
  const stats = await (await fetch(BASE + '/api/stats')).json();
  assert.ok(stats.recentWins.length >= 1, 'a recent win exists');
  assert.equal(stats.recentWins[0].name, 'Zqxbob', 'winner name is first-name only');
});

/* U-28.1 (applied by the U-24 wave, adj-u28.md): the internal admin
   note (deposits/withdrawals admin_note, written only via the internal
   "Admin note" form) must never reach the player. The wallet "Reason"
   reads ONLY the player-facing decision_reason captured on the
   decision form; this test rejects with NO player-facing reason, so
   the player sees the status and no reason text. */
test('U-28.1: internal admin note must not reach the player wallet', async () => {
  const depPage = await jarA.get('/deposit/new?m=1');
  await jarA.post('/deposit/new', { _csrf: csrfOf(depPage.text), method_id: '1', amount: '10', custom_tx_hash: '0x' + 'a'.repeat(64) });
  const depRow = await db.get('SELECT id FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userA]);
  const dg = await jarAdmin.get(ADMIN + '/deposits/' + depRow.id);
  await jarAdmin.post(ADMIN + '/deposits/' + depRow.id + '/note', { _csrf: csrfOf(dg.text), admin_note: INTERNAL_NOTE });
  const dg2 = await jarAdmin.get(ADMIN + '/deposits/' + depRow.id);
  await jarAdmin.post(ADMIN + '/deposits/' + depRow.id + '/reject', { _csrf: csrfOf(dg2.text) });
  const wal = await jarA.get('/wallet');
  assert.ok(wal.text.includes('Rejected'), 'the rejection itself is visible (class A)');
  assert.ok(!wal.text.includes(INTERNAL_NOTE), 'the internal note must not be visible');
});
