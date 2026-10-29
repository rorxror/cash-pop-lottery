'use strict';
/* V20 OWNER-FIX — U-24 final wave: display integrity + pending
   applications (port 4149, SMTP sink 4428).
   Run: node --test test/v20-u24.test.js

   Covers: the no-raw-output crawl across anon/player/agent/admin;
   the ref-coded error handler (500 page code == server log == audit
   row); the friendly 413 for oversized bodies; 400/403/404 pages;
   delivered-mail cleanliness; U-27.6–U-27.12 applications; the
   U-28.1 field separation (internal admin_note vs player-facing
   decision_reason, page + mail); the U-28.7 admin CSS split; the
   U-28.9 mode removal + gatewayPublic chain-leg rendering; the
   U-28.10 adminPath local restriction; migrations v22/v23 upgrade
   behaviour. Adjudication: audits/owner-fix-round/adj-u24.md. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 4149;
const SMTP_PORT = 4428;
const BASE = 'http://localhost:' + PORT;
const ADMIN = '/ops-7f3a9c-console';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-u24-'));
const DBFILE = path.join(TMP, 'u24.sqlite');
const ADMIN_EMAIL = 'admin@u24.test';
const ADMIN_PW = 'Admin#12345';
const PW_A = 'Xk9!vQ2#zLp8wR7';
const PW_B = 'Qw7!zX2#vLp9mN4';
const PW_G = 'Ag3!vQ2#zLp8wR';
const INTERNAL_NOTE = 'U24INTERNALNOTE fraud-watch do-not-tell';
const PLAYER_REASON = 'U24 player reason — receipt unreadable, please re-upload';
const WD_REASON = 'U24 player reason — payout name does not match';
const PUBKEY = 'pk_test_U24PUBLISHABLEKEY123';

let server = null, serverOut = '', db = null, sink = null;
const mail = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startSink() {
  return new Promise((resolve) => {
    sink = net.createServer((sock) => {
      let inData = false; let buf = '';
      sock.write('220 sink ESMTP\r\n');
      sock.on('data', (chunk) => {
        const text = chunk.toString('utf8');
        if (inData) { buf += text; if (buf.includes('\r\n.\r\n')) { mail.push(buf); inData = false; sock.write('250 OK queued\r\n'); } return; }
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

class Jar {
  constructor() { this.cookies = new Map(); }
  absorb(res) { const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []; for (const c of sc) { const [pair] = c.split(';'); const i = pair.indexOf('='); if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim()); } }
  header() { return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, p, body, headers2) {
    const headers = { Cookie: this.header(), ...(headers2 || {}) };
    let payload;
    if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
    this.absorb(res);
    return { status: res.status, location: res.headers.get('location') || '', text: await res.text() };
  }
  get(p) { return this.req('GET', p); }
  post(p, b) { return this.req('POST', p, b || {}); }
}
const csrfOf = (html) => { const m = /name="_csrf" value="([^"]+)"/.exec(html || ''); return m ? m[1] : ''; };
const visibleText = (html) => String(html)
  .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ');

const anon = new Jar(), jarA = new Jar(), jarB = new Jar(), jarG = new Jar(), jarAdmin = new Jar();
let userA = 0, settledId = 0, liveSlug = '', scratchPublicId = '', depId = 0, wdId = 0, supPublicId = '';

test.before(async () => {
  await startSink();
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, SQLITE_PATH: DBFILE, PORT: String(PORT), BASE_URL: BASE,
      TICKET_HMAC_SECRET: 'u24-final-wave-hmac-secret-0123456789abcdef',
      ADMIN_SEED_EMAIL: ADMIN_EMAIL, ADMIN_SEED_PASSWORD: ADMIN_PW,
      CREDENTIAL_ENCRYPTION_KEY: 'a1'.repeat(32),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT), SMTP_FROM: 'noreply@u24.test',
    },
    stdio: 'pipe',
  });
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/healthz'); if (r.ok) break; } catch {} await sleep(500); }
  process.env.SQLITE_PATH = DBFILE; process.env.DB_DRIVER = 'sqlite'; delete process.env.DATABASE_URL;
  db = require('../lib/db').openDB().db;
  const { hashPassword, sha256 } = require('../lib/util');
  const t = Date.now();

  // Player A through the real register flow (welcome mail lands in the sink).
  const gA = await jarA.get('/register');
  const regA = await jarA.post('/register', { _csrf: csrfOf(gA.text), name: 'U24 Alice', email: 'alice@u24.test', phone: '+15550111', password: PW_A, password_confirm: PW_A, agree: 'on' });
  assert.equal(regA.status, 302, 'register A');
  userA = (await db.get("SELECT id FROM users WHERE email = 'alice@u24.test'")).id;
  // Player B + agent inserted directly (login flow is the real part).
  await db.run("INSERT INTO users (email, phone, name, password_hash, role, status, email_verified, created_at) VALUES ('bob@u24.test', '+15550222', 'U24 Bob', ?, 'player', 'active', 1, ?)", [hashPassword(PW_B), t]);
  await db.run("INSERT INTO users (email, phone, name, password_hash, role, status, email_verified, created_at) VALUES ('agent@u24.test', '+15550333', 'U24 Agent', ?, 'agent', 'active', 1, ?)", [hashPassword(PW_G), t]);
  const agentId = (await db.get("SELECT id FROM users WHERE email = 'agent@u24.test'")).id;
  const userB = (await db.get("SELECT id FROM users WHERE email = 'bob@u24.test'")).id;
  await db.run('UPDATE users SET agent_id = ?, email_verified = 1 WHERE id IN (?, ?)', [agentId, userA, userB]);
  assert.equal((await jarB.post('/login', { _csrf: csrfOf((await jarB.get('/login')).text), email: 'bob@u24.test', password: PW_B })).status, 302, 'login B');
  assert.equal((await jarG.post('/login', { _csrf: csrfOf((await jarG.get('/login')).text), email: 'agent@u24.test', password: PW_G })).status, 302, 'login agent');
  assert.equal((await jarAdmin.post('/login', { _csrf: csrfOf((await jarAdmin.get('/login')).text), email: ADMIN_EMAIL, password: ADMIN_PW })).status, 302, 'login admin');

  // Withdrawal OTP is ON by default (it inserts a verify step); the
  // U-28.1 flow below exercises the direct create path, like the
  // discovery suite does.
  await db.run("INSERT INTO settings (key, value, updated_at) VALUES ('withdrawal_otp_enabled', '0', ?) ON CONFLICT(key) DO UPDATE SET value = '0'", [t]);
  await db.run("INSERT INTO wallets (user_id, currency, balance) VALUES (?, 'USD', 100000) ON CONFLICT(user_id, currency) DO UPDATE SET balance = 100000", [userA]);
  await db.run('UPDATE payment_methods SET enabled = 1 WHERE id IN (1, 2)');
  await db.run("INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, winning_number, is_test, created_at) VALUES ('DAY', '2020-01-01', 1, 'settled', ?, 'u24settledseed', 7, 0, ?)", [sha256('u24settledseed'), t]);
  settledId = (await db.get("SELECT id FROM draws WHERE draw_date = '2020-01-01'")).id;

  const play = await jarA.get('/play');
  const buy = await jarA.post('/play/buy', { _csrf: csrfOf(play.text), pops: '3', wager: '100', draw_type: 'DAY', num_draws: '1', currency: 'USD' });
  assert.equal(buy.status, 302, 'lottery buy: ' + buy.location);
  const live = await db.get("SELECT id, slug FROM scratch_series WHERE status = 'live' AND enabled = 1 LIMIT 1");
  liveSlug = live.slug;
  const lobby = await jarA.get('/scratch');
  const sbuy = await jarA.post('/scratch/' + live.id + '/buy', { _csrf: csrfOf(lobby.text) });
  assert.equal(sbuy.status, 302, 'scratch buy');
  scratchPublicId = (await db.get('SELECT public_id FROM scratch_tickets WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userA])).public_id;
  const sup = await jarA.get('/support');
  const tick = await jarA.post('/support/new', { _csrf: csrfOf(sup.text), subject: 'U24 crawl ticket', message: 'Hello, I need help with my ticket please.', priority: 'normal' });
  assert.equal(tick.status, 302, 'support create: ' + tick.location);
  supPublicId = (await db.get('SELECT public_id FROM support_tickets WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userA])).public_id;
  await sleep(800); // welcome mail
});

test.after(() => { if (server) server.kill('SIGTERM'); if (sink) sink.close(); });

/* ---------- Part A.1: the crawl ---------- */
const BAD_PATTERNS = [
  ['html tag as text', /<(span|div|p|a|strong|em|br|table|td|tr)\b[^>]*>/],
  ['nbsp entity as text', /&nbsp;/],
  ['double-escaped entity', /&(amp);(amp|nbsp|lt|gt);/],
  ['undefined', /\bundefined\b/],
  ['NaN', /\bNaN\b/],
  ['[object Object]', /\[object Object\]/],
  ['stack trace', /\s+at\s+[A-Za-z_$][\w$.]*\s+\(/],
  ['error class name', /\b(TypeError|ReferenceError|RangeError|PayloadTooLargeError)\b/],
  ['SQL internal', /(SQLITE_|sqlite3|INSERT INTO|SELECT .* FROM .* WHERE)/i],
];
test('U-24 crawl: no raw output on the main pages in any role', async () => {
  const pages = {
    anon: ['/', '/results', '/fairness', '/fairness?draw_id=' + settledId, '/scratch', '/scratch/' + liveSlug, '/login', '/register', '/contact', '/page/terms', '/page/privacy', '/page/how-it-works'],
    player: ['/', '/play', '/wallet', '/profile', '/security', '/tickets', '/transactions', '/scratch', '/scratch/my-tickets', '/scratch/ticket/' + scratchPublicId, '/scratch/ticket/' + scratchPublicId + '/verify', '/support', '/support/' + supPublicId, '/kyc', '/deposit/new', '/withdraw/new', '/fairness?draw_id=' + settledId, '/results', '/announcements'],
    agent: ['/agent', '/agent/players', '/agent/players/new', '/agent/transfer', '/agent/commissions', '/agent/support'],
    admin: [ADMIN, ADMIN + '/deposits', ADMIN + '/withdrawals', ADMIN + '/users', ADMIN + '/users/' + userA, ADMIN + '/agents', ADMIN + '/draws', ADMIN + '/tickets', ADMIN + '/scratch', ADMIN + '/support', ADMIN + '/kyc', ADMIN + '/settings', ADMIN + '/automation', ADMIN + '/bonuses', ADMIN + '/notifications', ADMIN + '/methods', ADMIN + '/reports', ADMIN + '/audit', ADMIN + '/data', ADMIN + '/security', ADMIN + '/extensions', ADMIN + '/cron', ADMIN + '/pages', ADMIN + '/referrals', ADMIN + '/flags', ADMIN + '/otp', ADMIN + '/login-history', ADMIN + '/staff', ADMIN + '/approvals', ADMIN + '/reconciliation', ADMIN + '/contact-messages', ADMIN + '/support/canned-replies'],
  };
  const jars = { anon, player: jarA, agent: jarG, admin: jarAdmin };
  for (const [role, paths] of Object.entries(pages)) {
    for (const p of paths) {
      const r = await jars[role].get(p);
      assert.equal(r.status, 200, `${role} ${p} renders 200, got ${r.status}`);
      const vis = visibleText(r.text);
      for (const [name, re] of BAD_PATTERNS) {
        assert.ok(!re.test(vis), `${role} ${p}: visible text must not contain ${name} (matched ${JSON.stringify((re.exec(vis) || [])[0] || '')})`);
      }
      assert.ok(!r.text.includes('[object Object]'), `${role} ${p}: raw HTML has no [object Object]`);
    }
  }
});

test('U-24 crawl: no raw snake_case enum labels on non-admin visible text (fairness formulas excepted)', async () => {
  // Adjudicated stays: verify.ejs's verifier formulas name the artifacts
  // (seed_hash / winning_number / beacon_randomness / draw_id) in code
  // spans — U-27 NOT-HITS + U-28.6 protect that surface's math.
  const FAIRNESS_OK = new Set(['seed_hash', 'winning_number', 'beacon_randomness', 'draw_id', 'reject_sample']);
  const paths = ['/', '/results', '/fairness', '/fairness?draw_id=' + settledId, '/scratch', '/scratch/' + liveSlug, '/login', '/register', '/contact', '/page/terms'];
  for (const p of paths) {
    const vis = visibleText((await anon.get(p)).text);
    const toks = vis.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [];
    for (const tok of toks) assert.ok(p.startsWith('/fairness') && FAIRNESS_OK.has(tok), `anon ${p}: raw snake_case token ${tok} in visible text`);
  }
  const playerPaths = ['/play', '/wallet', '/profile', '/security', '/tickets', '/transactions', '/scratch/my-tickets', '/support', '/kyc', '/deposit/new', '/withdraw/new'];
  for (const p of playerPaths) {
    const vis = visibleText((await jarA.get(p)).text);
    const toks = vis.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [];
    assert.deepEqual(toks, [], `player ${p}: raw snake_case tokens in visible text: ${toks.join(', ')}`);
  }
  const agentPaths = ['/agent', '/agent/players', '/agent/transfer', '/agent/commissions', '/agent/support'];
  for (const p of agentPaths) {
    const vis = visibleText((await jarG.get(p)).text);
    const toks = vis.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) || [];
    assert.deepEqual(toks, [], `agent ${p}: raw snake_case tokens in visible text: ${toks.join(', ')}`);
  }
});

test('U-24.1/2: fraud flags render human labels + readable detail; ledger types all labelled', async () => {
  // A shared-device flag was created by the B/agent logins from one IP.
  const flagsPage = await jarAdmin.get(ADMIN + '/flags');
  assert.equal(flagsPage.status, 200);
  const vis = visibleText(flagsPage.text);
  assert.ok(!vis.includes('shared_device'), 'flag type is not the raw enum');
  if (vis.includes('Shared device')) assert.ok(!vis.includes('"other_user_id"'), 'flag detail is not a JSON blob');
  const userPage = await jarAdmin.get(ADMIN + '/users/' + userA);
  assert.ok(!visibleText(userPage.text).includes('shared_device'), 'user detail flag type is humanised too');
  // Transactions label map now covers every ledger type the engine writes.
  const src = fs.readFileSync(path.join(ROOT, 'views', 'transactions.ejs'), 'utf8');
  for (const ty of ['agent_commission', 'agent_funding', 'withdrawal_release', 'withdrawal_revoke']) {
    assert.ok(src.includes(ty + ':'), 'transactions label map covers ' + ty);
  }
});

/* ---------- Part A.2–A.4: error pages ---------- */
test('U-24: 404/403/400 pages are friendly, correct-status, internal-free (anon + player)', async () => {
  for (const jar of [anon, jarA]) {
    const nf = await jar.get('/no-such-u24-page');
    assert.equal(nf.status, 404);
    assert.ok(visibleText(nf.text).includes('Page not found'));
    assert.ok(!/error|stack|at\s+\w+\s+\(/i.test(visibleText(nf.text).replace('Page not found', '')), '404 carries no internals');
  }
  const f = await anon.post('/login', { email: 'x@y.z' }); // session-less POST
  assert.equal(f.status, 403);
  assert.ok(visibleText(f.text).includes('Security token mismatch'));
  // Malformed JSON body → parser error → friendly 400 (not a 500).
  const bad = await fetch(BASE + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.equal(bad.status, 400, 'malformed JSON is a 400');
  const badText = visibleText(await bad.text());
  assert.ok(badText.includes('could not be read'), '400 states the true reason plainly');
  assert.ok(!badText.includes('SyntaxError'), '400 leaks no parser internals');
  // A money-flow 400 (U-02 pattern): buy with no pops selected.
  const play = await jarA.get('/play');
  const buy400 = await jarA.post('/play/buy', { _csrf: csrfOf(play.text), wager: '100', draw_type: 'DAY', num_draws: '1', currency: 'USD' });
  assert.equal(buy400.status, 400, 'buy without pops is a 400 re-render');
  assert.ok(!visibleText(buy400.text).includes('undefined'), '400 buy page is clean');
});

test('U-24: oversized body gets a friendly 413 with the true reason (D4-C4)', async () => {
  const big = 'x=' + 'A'.repeat(2_600_000);
  const res = await fetch(BASE + '/contact', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: big });
  assert.equal(res.status, 413, 'oversized POST is a 413, not a 500');
  const vis = visibleText(await res.text());
  assert.ok(vis.includes('too large'), '413 states the true reason');
  assert.ok(!vis.includes('PayloadTooLarge'), '413 leaks no error class');
});

test('U-24: a forced 500 shows ONLY a short reference code — and the code is findable in log + audit', async () => {
  // A malformed cookie makes decodeURIComponent throw in the cookie
  // middleware — a genuine unexpected 500 through the global handler.
  const res = await fetch(BASE + '/', { headers: { Cookie: 'sid=%E0%A4%A' } });
  assert.equal(res.status, 500);
  const html = await res.text();
  const vis = visibleText(html);
  assert.ok(vis.includes('Something went wrong. The team has been notified.'));
  const m = /Reference:\s*([A-Z0-9]{6,})/.exec(vis);
  assert.ok(m, 'the page carries a reference code');
  const ref = m[1];
  assert.ok(!vis.includes('URIError') && !vis.includes('decodeURIComponent') && !/\s+at\s+\w+\s+\(/.test(vis), 'no internals on the 500 page');
  await sleep(400);
  assert.ok(serverOut.includes('[error] ref=' + ref), 'the same code is in the server log output');
  const row = await db.get("SELECT entity_id FROM audit_log WHERE action = 'error.unhandled' AND entity_id = ?", [ref]);
  assert.ok(row, 'the same code is in the audit trail');
});

/* ---------- Part A.5: delivered mail ---------- */
test('U-24: delivered mail copies are clean (welcome sample on this build)', async () => {
  const welcome = mail.join('\n');
  assert.ok(welcome.includes('U24 Alice'), 'welcome mail was delivered with the player name');
  assert.ok(!welcome.includes('{{'), 'no raw placeholders in delivered mail');
  assert.ok(!welcome.includes('&lt;'), 'no HTML-as-text in delivered mail');
  assert.ok(!/admin_note|decision_reason|BP-\d/.test(welcome), 'no internal wording in delivered mail');
});

/* ---------- Part B: U-27 applications ---------- */
test('U-27.6–U-27.11: internal language is out of rendered copy', async () => {
  const sec = await jarAdmin.get(ADMIN + '/security');
  const secVis = visibleText(sec.text);
  assert.ok(!secVis.includes('admin_totp_required'), 'raw setting key is not visible copy (U-27.8)');
  assert.ok(secVis.includes('TOTP is REQUIRED for admins on this site.') || secVis.includes('TOTP is not required for admins yet.'), 'plain TOTP wording renders');
  for (const p of [ADMIN + '/automation', ADMIN + '/settings', ADMIN + '/users/' + userA, ADMIN + '/scratch']) {
    const vis = visibleText((await jarAdmin.get(p)).text);
    assert.ok(!/BP-\d+|R-\d{3}/.test(vis), p + ' shows no internal project codes (U-27.9)');
  }
  const notif = await jarAdmin.get(ADMIN + '/notifications?tab=providers');
  assert.ok(!visibleText(notif.text).includes('lib/notify.js'), 'push card names no source file (U-27.10)');
  assert.ok(visibleText(notif.text).includes('push notifications are not set up yet'), 'push card plain wording (U-27.10)');
  const det = await anon.get('/scratch/' + liveSlug);
  const detVis = visibleText(det.text);
  assert.ok(detVis.includes("Your card's prize is decided when you buy it, before you scratch."), 'scratch fairness step 1 is plain (U-27.11)');
  assert.ok(detVis.includes('That result is locked to your ticket before you scratch.'), 'scratch fairness step 2 is plain (U-27.11)');
  assert.ok(detVis.includes('After you reveal it, you can check the result yourself on the Verify page.'), 'scratch fairness step 4 is plain (U-27.11)');
  assert.ok(!detVis.includes('pre-shuffled') && !detVis.includes('recompute the commitment'), 'no build register left (U-27.11)');
  const src = fs.readFileSync(path.join(ROOT, 'routes', 'player.js'), 'utf8');
  assert.ok(!src.includes('ticket signing is not configured'), 'buy error confesses no config state (U-27.6)');
  const authSrc = fs.readFileSync(path.join(ROOT, 'routes', 'auth.js'), 'utf8');
  assert.ok(!authSrc.includes('Registration is currently disabled.'), 'register POST uses the app voice: closed (U-27.12)');
});

/* ---------- Part B: U-28.1 field separation ---------- */
test('U-28.1: internal admin note never reaches the player; the player-facing reason does (deposit + withdrawal, page + mail)', async () => {
  // --- Deposit: internal note saved, then rejected WITH a player reason.
  const depPage = await jarA.get('/deposit/new');
  const dep = await jarA.post('/deposit/new', { _csrf: csrfOf(depPage.text), method_id: '2', amount: '10' });
  assert.equal(dep.status, 302, 'deposit created');
  depId = (await db.get('SELECT id FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userA])).id;
  const dg = await jarAdmin.get(ADMIN + '/deposits/' + depId);
  assert.ok(visibleText(dg.text).includes('Admin note (internal — never shown to the player)'), 'note form is labelled internal');
  assert.ok(visibleText(dg.text).includes('Reason shown to the player'), 'decision form carries the player-facing reason field');
  await jarAdmin.post(ADMIN + '/deposits/' + depId + '/note', { _csrf: csrfOf(dg.text), admin_note: INTERNAL_NOTE });
  const dg2 = await jarAdmin.get(ADMIN + '/deposits/' + depId);
  const mailBefore = mail.length;
  await jarAdmin.post(ADMIN + '/deposits/' + depId + '/reject', { _csrf: csrfOf(dg2.text), decision_reason: PLAYER_REASON });
  const dRow = await db.get('SELECT admin_note, decision_reason, status FROM deposits WHERE id = ?', [depId]);
  assert.equal(dRow.status, 'rejected');
  assert.equal(dRow.admin_note, INTERNAL_NOTE, 'the internal note stays stored internally');
  assert.equal(dRow.decision_reason, PLAYER_REASON, 'the player-facing reason is stored separately');
  const wal = await jarA.get('/wallet');
  assert.ok(wal.text.includes('Rejected'), 'wallet shows the rejection (class A)');
  assert.ok(wal.text.includes(PLAYER_REASON), 'wallet shows the player-facing reason');
  assert.ok(!wal.text.includes(INTERNAL_NOTE), 'wallet never shows the internal note');
  await sleep(700);
  const depMail = mail.slice(mailBefore).join('\n');
  assert.ok(depMail.includes('rejected'), 'deposit rejection mail delivered');
  assert.ok(!depMail.includes(INTERNAL_NOTE) && !depMail.includes('{{'), 'deposit mail carries no internal note, no placeholders');

  // --- Withdrawal WITH a player-facing reason → reason shows.
  await sleep(6500); // let the server's 5s settings cache reload the OTP-off upsert
  const wdPage = await jarA.get('/withdraw/new');
  const wd = await jarA.post('/withdraw/new', { _csrf: csrfOf(wdPage.text), method_id: '2', amount: '5' });
  assert.equal(wd.status, 302, 'withdrawal created: ' + wd.location);
  wdId = (await db.get('SELECT id FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userA])).id;
  const wg = await jarAdmin.get(ADMIN + '/withdrawals/' + wdId);
  assert.ok(visibleText(wg.text).includes('Admin note (internal — never shown to the player)'), 'withdrawal note form is labelled internal');
  await jarAdmin.post(ADMIN + '/withdrawals/' + wdId + '/note', { _csrf: csrfOf(wg.text), admin_note: INTERNAL_NOTE });
  const wg2 = await jarAdmin.get(ADMIN + '/withdrawals/' + wdId);
  await jarAdmin.post(ADMIN + '/withdrawals/' + wdId + '/reject', { _csrf: csrfOf(wg2.text), decision_reason: WD_REASON });
  const wRow = await db.get('SELECT admin_note, decision_reason, status FROM withdrawals WHERE id = ?', [wdId]);
  assert.equal(wRow.status, 'rejected');
  assert.equal(wRow.admin_note, INTERNAL_NOTE, 'deciding does not wipe the internal note');
  assert.equal(wRow.decision_reason, WD_REASON);
  const wal2 = await jarA.get('/wallet');
  assert.ok(wal2.text.includes(WD_REASON), 'wallet shows the withdrawal player-facing reason');
  assert.ok(!wal2.text.includes(INTERNAL_NOTE), 'wallet still hides the internal note');

  // --- Withdrawal with ONLY an internal note → status only, no note anywhere.
  const wdPage2 = await jarA.get('/withdraw/new');
  const wd2 = await jarA.post('/withdraw/new', { _csrf: csrfOf(wdPage2.text), method_id: '2', amount: '5' });
  assert.equal(wd2.status, 302, 'second withdrawal created');
  const wd2Id = (await db.get('SELECT id FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userA])).id;
  const wg3 = await jarAdmin.get(ADMIN + '/withdrawals/' + wd2Id);
  await jarAdmin.post(ADMIN + '/withdrawals/' + wd2Id + '/note', { _csrf: csrfOf(wg3.text), admin_note: INTERNAL_NOTE });
  const wg4 = await jarAdmin.get(ADMIN + '/withdrawals/' + wd2Id);
  const mailBefore2 = mail.length;
  await jarAdmin.post(ADMIN + '/withdrawals/' + wd2Id + '/reject', { _csrf: csrfOf(wg4.text) });
  const wal3 = await jarA.get('/wallet');
  assert.ok(wal3.text.includes('Rejected'), 'the rejection itself is visible');
  assert.ok(!wal3.text.includes(INTERNAL_NOTE), 'no internal note on the wallet');
  await sleep(700);
  const wdMail = mail.slice(mailBefore2).join('\n');
  assert.ok(wdMail.includes('rejected'), 'withdrawal decision mail delivered, correctly spelled');
  assert.ok(!wdMail.includes(INTERNAL_NOTE), 'no internal note in the withdrawal mail');
  assert.ok(!wdMail.includes('{{'), 'no raw placeholders in the withdrawal mail');
});

/* ---------- Part B: U-28.7 CSS split ---------- */
test('U-28.7: admin CSS is split out — admin pages link it, player/agent pages never reference it', async () => {
  const styleCss = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  const adminCss = fs.readFileSync(path.join(ROOT, 'public', 'admin.css'), 'utf8');
  assert.ok(!/\.adm\b|\.adm-|\.admin-/.test(styleCss), 'public stylesheet carries no admin rules');
  assert.ok(adminCss.includes('.adm {') && adminCss.includes('.adm-side'), 'admin stylesheet carries the panel rules');
  const admCount = (adminCss.match(/\{/g) || []).length;
  assert.ok(admCount >= 100, 'admin stylesheet holds the moved rule blocks (' + admCount + ')');
  const adminPage = await jarAdmin.get(ADMIN);
  assert.ok(adminPage.text.includes('/admin.css'), 'admin HTML links the admin stylesheet');
  assert.ok(adminPage.text.includes('/style.css'), 'admin HTML still links the shared stylesheet');
  const playerPage = await jarA.get('/wallet');
  assert.ok(!playerPage.text.includes('admin.css'), 'player page never references admin.css');
  const agentPage = await jarG.get('/agent');
  assert.equal(agentPage.status, 200, 'agent page renders unchanged');
  assert.ok(!agentPage.text.includes('admin.css'), 'agent page never references admin.css');
  assert.ok(agentPage.text.includes('agent-nav'), 'agent navigation markup intact');
  const scratchAdmin = await jarAdmin.get(ADMIN + '/scratch');
  assert.ok(scratchAdmin.text.includes('/admin.css'), 'scratch admin pages link the admin stylesheet too');
});

/* ---------- Part B: U-28.9 + chain leg ---------- */
/* SUPERSEDED 2026-10-29 by the owner-reported credential-display
   hotfix: the U-21/U-28.9 "gatewayPublic renders on the deposit page"
   behavior is REMOVED (owner rule: player pages show pay-to details
   only; the PayPal Client ID was displayed under "Payment gateway
   details" on live v21). This test now asserts the NEW contract with
   the same planted values: no gateway config of any kind renders on
   the player deposit page — not the publishable key, not the mode,
   and (as before) never the secrets. The lib-level projections are
   covered by test/player-credential-leak.test.js. */
test('U-28.9 + chain leg: NO gateway config renders on the player deposit page — mode and secrets never surface', async () => {
  const { PUBLIC_CONFIG_FIELDS } = require('../lib/rails');
  assert.ok(!PUBLIC_CONFIG_FIELDS.cards.includes('mode'), 'cards public fields exclude mode');
  assert.equal(PUBLIC_CONFIG_FIELDS.paypal, undefined, 'paypal has no public-config fields at all (2026-10-29 hotfix)');
  // Plant a cards method with a publishable key + sandbox mode via the real admin form.
  const cards = await db.get("SELECT id FROM payment_methods WHERE rail = 'cards' LIMIT 1");
  assert.ok(cards, 'a cards method exists');
  await db.run('UPDATE payment_methods SET enabled = 1 WHERE id = ?', [cards.id]);
  const credPage = await jarAdmin.get(ADMIN + '/methods/' + cards.id + '/credentials');
  assert.equal(credPage.status, 200);
  const save = await jarAdmin.post(ADMIN + '/methods/' + cards.id + '/credentials', {
    _csrf: csrfOf(credPage.text), provider: 'Stripe', mode: 'sandbox', publishable_key: PUBKEY,
    secret_key: 'sk_test_U24SECRETKEY999', webhook_secret: 'whsec_U24SECRET999',
  });
  assert.equal(save.status, 302, 'credentials saved: ' + save.location);
  const dep = await jarA.get('/deposit/new?m=' + cards.id);
  assert.equal(dep.status, 200);
  assert.ok(!dep.text.includes(PUBKEY), 'the publishable key no longer renders on the deposit page (hotfix)');
  assert.ok(!dep.text.includes('Payment gateway details'), 'the gateway details block is removed');
  assert.ok(!dep.text.includes('sandbox'), 'the sandbox/live mode never reaches the player');
  assert.ok(!dep.text.includes('sk_test_U24SECRETKEY999') && !dep.text.includes('whsec_U24SECRET999'), 'secrets never render');
});

/* ---------- Part B: U-28.10 adminPath restriction ---------- */
test('U-28.10: the console path is absent from player/agent output, present in admin output', async () => {
  for (const [jar, p] of [[jarA, '/wallet'], [jarA, '/profile'], [jarG, '/agent'], [anon, '/']]) {
    const r = await jar.get(p);
    assert.ok(!r.text.includes(ADMIN), p + ' output contains no console path');
  }
  const adminPage = await jarAdmin.get(ADMIN);
  assert.ok(adminPage.text.includes(ADMIN), 'admin pages still build their links from the path');
  // Adjudicated proof (adj-u24.md): no player/agent view reads the
  // adminPath local at all (grep-verified), so its absence from every
  // rendered non-admin page + unchanged admin rendering is the
  // observable contract; server.js now deletes the local for every
  // non-console request.
});

/* ---------- Part B: U-28.8 manual KYC verify clears kyc_note ---------- */
test('U-28.8: manual KYC verify clears users.kyc_note (attestation lives in the audit log)', async () => {
  const userB = (await db.get("SELECT id FROM users WHERE email = 'bob@u24.test'")).id;
  await db.run("UPDATE users SET kyc_status = 'rejected', kyc_note = 'U24 old player-facing reason' WHERE id = ?", [userB]);
  const up = await jarAdmin.get(ADMIN + '/users/' + userB);
  const r = await jarAdmin.post(ADMIN + '/users/' + userB + '/kyc-verify', { _csrf: csrfOf(up.text), note: 'U24 attestation: passport seen on video call' });
  assert.equal(r.status, 302, 'manual verify posts');
  const row = await db.get('SELECT kyc_status, kyc_note FROM users WHERE id = ?', [userB]);
  assert.equal(row.kyc_status, 'verified');
  assert.equal(row.kyc_note, '', 'kyc_note is cleared by manual verify');
  const auditRow = await db.get("SELECT detail FROM audit_log WHERE action = 'kyc.manual_verify' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(userB)]);
  assert.ok(auditRow && auditRow.detail.includes('passport seen'), 'the attestation lives in the audit log');
});

/* ---------- Migrations v22/v23: upgrade proof (in-process) ---------- */
test('Migrations v22/v23: a v21 database upgrades — terms heal, columns arrive, operator edits untouched', async () => {
  const { openDB } = require('../lib/db');
  const { migrate } = require('../lib/migrations');
  const upFile = path.join(TMP, 'upgrade.sqlite');
  process.env.SQLITE_PATH = upFile;
  const up = openDB().db;
  await migrate(up, 'sqlite');
  let vers = await up.query('SELECT version FROM migrations_applied ORDER BY version DESC LIMIT 1');
  assert.equal(Number(vers[0].version), 26, 'fresh migrate reaches v26');

  // Roll the DB back to a v21 state with the OLD terms paragraph planted.
  const OLD_PARA = '<p><strong>Template notice:</strong> the operator must replace this page with terms reviewed for their own licence and jurisdiction before offering real-money play.</p>';
  await up.run("DELETE FROM migrations_applied WHERE version IN (22, 23)");
  await up.run('ALTER TABLE deposits DROP COLUMN decision_reason');
  await up.run('ALTER TABLE withdrawals DROP COLUMN decision_reason');
  const terms = await up.get("SELECT body FROM pages WHERE slug = 'terms'");
  await up.run("UPDATE pages SET body = ? WHERE slug = 'terms'", [OLD_PARA + terms.body]);
  await migrate(up, 'sqlite');
  vers = await up.query('SELECT version FROM migrations_applied ORDER BY version DESC LIMIT 1');
  assert.equal(Number(vers[0].version), 26, 'upgrade migrate reaches the current latest version (v24 sessions.scope, v25 processing_mode, v26 withdraw_instruction added after v23)');
  const healed = await up.get("SELECT body FROM pages WHERE slug = 'terms'");
  assert.ok(!healed.body.includes('Template notice'), 'v22 removed the Template notice from the existing DB');
  assert.ok(healed.body.includes('Eligibility'), 'the rest of the terms page is intact');
  const cols = await up.query('PRAGMA table_info(deposits)');
  assert.ok(cols.some((c) => c.name === 'decision_reason'), 'v23 added deposits.decision_reason on upgrade');

  // Operator-edited terms (marker phrase present but NOT the exact
  // seeded paragraph) must be untouched by a re-run of v22.
  const custom = '<p>Template notice: my own operator wording, keep me.</p><h4>Mine</h4>';
  await up.run("UPDATE pages SET body = ? WHERE slug = 'terms'", [custom]);
  await up.run('DELETE FROM migrations_applied WHERE version = 22');
  await migrate(up, 'sqlite');
  const after = await up.get("SELECT body FROM pages WHERE slug = 'terms'");
  assert.equal(after.body, custom, 'operator-edited terms are never overwritten by the heal');
  process.env.SQLITE_PATH = DBFILE;
});

test('U-24: audit hash chain verifies after the whole round', async () => {
  const audit = require('../lib/audit');
  const v = await audit.verifyChain(db);
  assert.equal(v.ok, true, 'audit chain verifies: ' + JSON.stringify(v));
});
