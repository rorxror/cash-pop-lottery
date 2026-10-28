'use strict';
/* V20 OWNER-FIX — D-FIX-B HTTP regression tests (port 4138, SMTP sink
   4426, NO BASE_URL so the host-fallback paths are exercised).
   Run: node --test test/v20-discovery-fixes.test.js
   Covers: D1-C1a (percent >= 100 refused at save), D1-C2a (no zero
   commission row), D1-C6/C7 (agent transfer decimals + one-time token),
   D2-C5 (blocked phone on profile), D2-C9 admin half (host-fallback
   links), D2 rate gaps (withdraw + player security limiters), D2-C3
   (TOTP enrolment re-auth, player + admin), D2-C6 (verify-email
   discipline), D3-C5 (broadcast masking), D3-C6 ("rejected" spelled
   right in delivered mail), D3-C7 (mark-paid notifies), D4-C1
   (rejected deposit visible with reason), D4-C2 (pagination clamps),
   D4-C3 (fairness TEST badge markup), D4-C5 (scratch status on the
   buy-error re-render), view observations (forgot formError, login
   captcha slot). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 4138;
const BASE = 'http://localhost:' + PORT;
const ADMIN = '/ops-7f3a9c-console';
const SMTP_PORT = 4426;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-dfixb-'));
const DBFILE = path.join(TMP, 'fixes.sqlite');
const ADMIN_EMAIL = 'admin@dfixb.test';
const ADMIN_PW = 'Admin#12345';
const PW_A = 'Xk9!vQ2#zLp8wR7';
const PW_B = 'Qw7!zX2#vLp9mN4';

let server = null;
let db = null;
const mail = [];
let sink = null;

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
  async follow(r) { let cur = r; for (let i = 0; i < 5 && cur.status >= 300 && cur.status < 400 && cur.location; i++) cur = await this.get(cur.location.replace(BASE, '')); return cur; }
}
const csrfOf = (html) => { const m = /name="_csrf" value="([^"]+)"/.exec(html || ''); return m ? m[1] : ''; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const adminJar = new Jar();
const jarA = new Jar();
let userA = 0; let userB = 0; let agentId = 0;

async function login(jar, email, password) {
  const g = await jar.get('/login');
  return jar.post('/login', { _csrf: csrfOf(g.text), email, password });
}
async function register(jar, name, email, phone, password) {
  const g = await jar.get('/register');
  return jar.post('/register', { _csrf: csrfOf(g.text), name, email, phone, password, password_confirm: password, agree: 'on' });
}

test.before(async () => {
  await startSink();
  server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, SQLITE_PATH: DBFILE, PORT: String(PORT), TICKET_HMAC_SECRET: 'dfixb-fixes-hmac-secret-0123456789', ADMIN_SEED_EMAIL: ADMIN_EMAIL, ADMIN_SEED_PASSWORD: ADMIN_PW, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(SMTP_PORT), SMTP_FROM: 'noreply@dfixb.test', BASE_URL: '' },
    stdio: 'pipe',
  });
  server.stderr.on('data', (d) => process.stderr.write('[dfixb-server] ' + d));
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.ok) break; } catch {}
    await sleep(500);
  }
  process.env.SQLITE_PATH = DBFILE; process.env.DB_DRIVER = 'sqlite'; delete process.env.DATABASE_URL;
  const { openDB } = require('../lib/db');
  db = openDB().db;
  const al = await login(adminJar, ADMIN_EMAIL, ADMIN_PW);
  assert.equal(al.status, 302, 'admin login');
  await sleep(6500); // breached-password cache warm-up (see D-FIX-A notes)
  const ra = await register(jarA, 'Player A', 'pa@dfixb.test', '+15550101', PW_A);
  assert.equal(ra.status, 302, 'player A register: ' + ra.text.slice(0, 200));
  await db.run("UPDATE users SET email_verified = 1 WHERE email = 'pa@dfixb.test'");
  userA = (await db.get("SELECT id FROM users WHERE email = 'pa@dfixb.test'")).id;
  const jarB = new Jar();
  const rb = await register(jarB, 'Player B', 'pb@dfixb.test', '+15550102', PW_B);
  assert.equal(rb.status, 302, 'player B register');
  await db.run("UPDATE users SET email_verified = 1 WHERE email = 'pb@dfixb.test'");
  userB = (await db.get("SELECT id FROM users WHERE email = 'pb@dfixb.test'")).id;
  // Agent account + assignment for A.
  const ag = await db.run("INSERT INTO users (email, name, password_hash, role, status, email_verified, created_at) VALUES ('agent@dfixb.test', 'Agent A', 'x', 'agent', 'active', 1, ?)", [Date.now()]);
  agentId = ag.id;
  await db.run('UPDATE users SET agent_id = ? WHERE id = ?', [agentId, userA]);
  // Cards method live for deposit/withdraw flows.
  await db.run("UPDATE payment_methods SET enabled = 1, min_amount = 100 WHERE slug = 'rail-cards'");
  // Withdrawal OTP is ON by default (it renders a verify step instead of
  // creating the withdrawal); these flows test the money paths, so the
  // operator toggle is set OFF for this server.
  await upsertSetting('withdrawal_otp_enabled', '0');
  await sleep(6000); // let the server's settings cache (5s TTL) pick the toggle up before any flow runs
});

test.after(async () => {
  if (server) server.kill('SIGKILL');
  if (sink) await new Promise((r) => sink.close(r));
  if (db) await db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

const upsertSetting = async (key, value) => {
  const ex = await db.get('SELECT key FROM settings WHERE key = ?', [key]);
  if (ex) await db.run('UPDATE settings SET value = ? WHERE key = ?', [value, key]);
  else await db.run('INSERT INTO settings (key, value) VALUES (?, ?)', [key, value]);
};
const fundWallet = async (uid, minor) => {
  await db.run("INSERT INTO wallets (user_id, currency, balance) VALUES (?, 'USD', ?) ON CONFLICT(user_id, currency) DO UPDATE SET balance = balance + excluded.balance", [uid, minor]);
  await db.run("INSERT INTO transactions (user_id, currency, type, amount, balance_after, ref_type, ref_id, meta, created_at) VALUES (?, 'USD', 'deposit', ?, ?, 'test', 'seed', '{}', ?)", [uid, minor, minor, Date.now()]);
};

test('D1-C1a: a percent charge of 100 is refused at method save with the true reason; the stored value is unchanged', async () => {
  const m = await db.get("SELECT id, percent_charge FROM payment_methods WHERE slug = 'rail-cards'");
  const g = await adminJar.get(ADMIN + '/methods/' + m.id);
  const csrf = csrfOf(g.text);
  assert.ok(csrf, 'admin method page carries csrf');
  const body = { _csrf: csrf, name: 'Credit / Debit Cards', kind: 'both', rail: 'cards', currency: 'USD', rate: '1', min_amount: '100', max_amount: '100000', fixed_charge: '0', percent_charge: '100', instruction: '', custom_fields: '[]', enabled: '1' };
  const r = await adminJar.post(ADMIN + '/methods/' + m.id, body);
  const page = await adminJar.follow(r);
  assert.match(page.text, /Percent charge must be less than 100%/);
  const after = await db.get('SELECT percent_charge FROM payment_methods WHERE id = ?', [m.id]);
  assert.equal(Number(after.percent_charge), Number(m.percent_charge), 'the 100% charge was NOT saved');
});

test('D1-C2a: a $0.05 ticket at 5% commission creates NO commission row; a $1 ticket creates exactly one real row', async () => {
  await db.run("UPDATE settings SET value = '0.05,1,2,5,10' WHERE key = 'wager_options'");
  await fundWallet(userA, 100000);
  await sleep(6000); // settings cache TTL
  const play = await jarA.get('/play');
  const buy = (wager) => jarA.post('/play/buy', { _csrf: csrfOf(play.text), draw_type: 'DAY', num_draws: '1', pops: '5', wager: String(wager), currency: 'USD' });
  const r1 = await buy(5);
  assert.equal(r1.status, 302, 'nickel ticket buys: ' + r1.location);
  let rows = await db.query('SELECT * FROM commissions WHERE user_id = ?', [userA]);
  assert.equal(rows.length, 0, 'round(5 x 5%) = 0 -> no zero row (the old code inserted one)');
  const r2 = await buy(100);
  assert.equal(r2.status, 302);
  rows = await db.query('SELECT * FROM commissions WHERE user_id = ?', [userA]);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].amount), 5, 'the real 5% of $1 accrues normally');
});

test('D1-C6 + D1-C7: agent transfer honours currency decimals and a double-submit moves money exactly once', async () => {
  // JPY as a configured 0-decimal currency.
  await db.run("UPDATE settings SET value = ? WHERE key = 'currencies'", [JSON.stringify([{ code: 'USD', symbol: '$', rate: 1 }, { code: 'JPY', symbol: '¥', rate: 150, decimals: 0 }])]);
  await db.run("INSERT INTO agent_floats (agent_id, currency, balance) VALUES (?, 'JPY', 100000), (?, 'USD', 100000) ON CONFLICT(agent_id, currency) DO UPDATE SET balance = 100000", [agentId, agentId]);
  await sleep(6000); // settings cache TTL: the JPY decimals must be live
  const jar = new Jar();
  // Agent logs in through the normal login (role agent).
  const aj = new Jar();
  await db.run("UPDATE users SET password_hash = ? WHERE id = ?", [require('../lib/util').hashPassword(PW_B), agentId]);
  const lg = await login(aj, 'agent@dfixb.test', PW_B);
  assert.equal(lg.status, 302, 'agent login');
  const form = await aj.get('/agent/transfer');
  const tokenM = /name="transfer_token" value="([^"]+)"/.exec(form.text);
  assert.ok(tokenM, 'the transfer form carries the one-time token');
  const token = tokenM[1];
  const csrf = csrfOf(form.text);
  const payload = { _csrf: csrf, transfer_token: token, to_user_id: String(userA), currency: 'JPY', amount: '500', note: 'dfixb' };
  const [r1, r2] = await Promise.all([aj.post('/agent/transfer', payload), aj.post('/agent/transfer', payload)]);
  const rows = await db.query("SELECT * FROM agent_transfers WHERE from_agent = ? AND currency = 'JPY'", [agentId]);
  assert.equal(rows.length, 1, 'exactly ONE transfer row from two parallel identical POSTs');
  assert.equal(Number(rows[0].amount), 500, 'JPY "500" is 500 minor (0-decimal), not 50000');
  const float = await db.get("SELECT balance FROM agent_floats WHERE agent_id = ? AND currency = 'JPY'", [agentId]);
  assert.equal(Number(float.balance), 100000 - 500, 'float debited exactly once, by 500');
  const credited = await db.get("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE user_id = ? AND type = 'agent_funding'", [userA]);
  assert.equal(Number(credited.s), 500, 'player credited exactly 500 JPY minor, once');
  // The replayed (consumed) token is refused with the true reason.
  const replay = await aj.post('/agent/transfer', payload);
  const landed = await aj.follow(replay);
  assert.match(landed.text, /already submitted|form has expired/);
  // A FRESH form/token still transfers fine. (Fetched AFTER the replay:
  // every transfer-page render rotates the session's token.)
  const form2 = await aj.get('/agent/transfer');
  const freshToken = /name="transfer_token" value="([^"]+)"/.exec(form2.text)[1];
  const ok = await aj.post('/agent/transfer', { _csrf: csrfOf(form2.text), transfer_token: freshToken, to_user_id: String(userA), currency: 'USD', amount: '10', note: 'second' });
  const rows2 = await db.query("SELECT * FROM agent_transfers WHERE from_agent = ? AND currency = 'USD'", [agentId]);
  assert.equal(rows2.length, 1, 'fresh-token transfer status was ' + ok.status + ' -> ' + ok.location);
  assert.equal(Number(rows2[0].amount), 1000, 'USD "10" is 1000 minor (2-decimal behaviour unchanged)');
  assert.ok(jar && r1 && r2 && ok);
});

test('D4-C1 + D3-C6: rejected deposit shows on the wallet with its reason; withdrawal rejection mail says "rejected"', async () => {
  const depPage = await jarA.get('/deposit/new');
  const dep = await jarA.post('/deposit/new', { _csrf: csrfOf(depPage.text), method_id: '2', amount: '10' });
  assert.equal(dep.status, 302, 'deposit created: ' + dep.location);
  const d = await db.get("SELECT id FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 1", [userA]);
  const dg = await adminJar.get(ADMIN + '/deposits/' + d.id);
  /* U-28.1: the reason the player sees is the PLAYER-FACING decision
     reason captured on the reject form — NOT the internal admin note
     (the note form now states it is never shown to the player). */
  await adminJar.post(ADMIN + '/deposits/' + d.id + '/note', { _csrf: csrfOf(dg.text), admin_note: 'DFIXB internal note — must stay internal' });
  const dg2 = await adminJar.get(ADMIN + '/deposits/' + d.id);
  await adminJar.post(ADMIN + '/deposits/' + d.id + '/reject', { _csrf: csrfOf(dg2.text), decision_reason: 'Receipt unreadable — please re-upload.' });
  const wallet = await jarA.get('/wallet');
  assert.match(wallet.text, /Request history/);
  assert.match(wallet.text, /Rejected/);
  assert.match(wallet.text, /Receipt unreadable — please re-upload\./, 'the player-facing decision reason reaches the player');
  assert.ok(!wallet.text.includes('DFIXB internal note'), 'the internal admin note never reaches the player (U-28.1)');
  // Withdrawal rejection wording in delivered mail.
  await fundWallet(userA, 5000);
  const wdPage = await jarA.get('/withdraw/new');
  const wd = await jarA.post('/withdraw/new', { _csrf: csrfOf(wdPage.text), method_id: '2', amount: '5' });
  assert.equal(wd.status, 302, 'withdrawal created: ' + wd.location);
  const w = await db.get("SELECT id FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 1", [userA]);
  const wg = await adminJar.get(ADMIN + '/withdrawals/' + w.id);
  const before = mail.length;
  await adminJar.post(ADMIN + '/withdrawals/' + w.id + '/reject', { _csrf: csrfOf(wg.text) });
  await sleep(700);
  const fresh = mail.slice(before).join('\n');
  assert.match(fresh, /rejected/i, 'delivered mail says rejected');
  assert.ok(!/rejectd/i.test(fresh), 'and never "rejectd"');
  const row = await db.get("SELECT body FROM notifications_log WHERE to_addr = 'pa@dfixb.test' ORDER BY id DESC LIMIT 1");
  assert.ok(!row || !/rejectd/i.test(row.body || ''), 'stored outbox copy is clean too');
});

test('D3-C7: direct mark-paid sends the same paid notification as the maker-checker path', async () => {
  const wdPage = await jarA.get('/withdraw/new');
  const wd = await jarA.post('/withdraw/new', { _csrf: csrfOf(wdPage.text), method_id: '2', amount: '5' });
  assert.equal(wd.status, 302);
  const w = await db.get("SELECT id, public_id FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 1", [userA]);
  const wg = await adminJar.get(ADMIN + '/withdrawals/' + w.id);
  await adminJar.post(ADMIN + '/withdrawals/' + w.id + '/approve', { _csrf: csrfOf(wg.text) });
  const before = await db.query("SELECT id FROM notifications_log WHERE to_addr = 'pa@dfixb.test'");
  const wg2 = await adminJar.get(ADMIN + '/withdrawals/' + w.id);
  const mp = await adminJar.post(ADMIN + '/withdrawals/' + w.id + '/mark-paid', { _csrf: csrfOf(wg2.text), provider_payout_id: 'po_dfixb_1' });
  const mpLand = await adminJar.follow(mp);
  const mpFlash = /data-flash[^>]*>([^<]+)/.exec(mpLand.text);
  const wst = await db.get('SELECT status FROM withdrawals WHERE id = ?', [w.id]);
  assert.equal(wst.status, 'paid', 'mark-paid itself succeeded (flash: ' + (mpFlash ? mpFlash[1] : '(none)') + ')');
  await sleep(900); // notify.send is fire-and-forget; the outbox row lands after the SMTP attempt
  const after = await db.query("SELECT id, subject, body FROM notifications_log WHERE to_addr = 'pa@dfixb.test' ORDER BY id");
  assert.ok(after.length > before.length, 'mark-paid produced a new outbox row for the player');
  assert.match(after[after.length - 1].body + ' ' + after[after.length - 1].subject, /paid/i, 'the mark-paid notification says paid: ' + after[after.length - 1].subject);
});

test('D2-C9 (admin half): admin-triggered reset link is absolute via the request-host fallback (no BASE_URL set)', async () => {
  const ug = await adminJar.get(ADMIN + '/users/' + userA);
  const before = mail.length;
  await adminJar.post(ADMIN + '/users/' + userA + '/reset-password', { _csrf: csrfOf(ug.text) });
  await sleep(700);
  const fresh = mail.slice(before).join('\n');
  assert.match(fresh, new RegExp('http://localhost:' + PORT + '/reset/[0-9a-f]+'), 'reset mail carries an absolute, clickable link built from the request host');
  // By design, an admin-triggered reset destroys the player's existing
  // sessions (destroyUserSessions) — sign jarA back in for later tests.
  const relog = await login(jarA, 'pa@dfixb.test', PW_A);
  assert.equal(relog.status, 302, 'player A re-login after the reset');
});

test('D2-C5: with IN blocked, a profile phone change to +91 is refused and the stored phone is untouched', async () => {
  await upsertSetting('blocked_phone_countries', 'IN');
  await sleep(6000);
  const prof = await jarA.get('/profile');
  const r = await jarA.post('/profile', { _csrf: csrfOf(prof.text), name: 'Player A', phone: '+919876543210' });
  const landed = await jarA.follow(r);
  const fl = /data-flash[^>]*>([^<]+)/.exec(landed.text);
  assert.match(landed.text, /Phone numbers from this country are not accepted on this platform\./, 'actual flash: ' + (fl ? fl[1] : '(none)'));
  const row = await db.get('SELECT phone FROM users WHERE id = ?', [userA]);
  assert.equal(row.phone, '+15550101', 'stored phone unchanged');
  await upsertSetting('blocked_phone_countries', '');
});

test('D2 rate gaps: /withdraw/new and player security POSTs are rate-limited (the 11th rapid request is refused)', async () => {
  const trail = [];
  for (let i = 0; i < 11; i++) {
    const wp = await jarA.get('/withdraw/new');
    const r = await jarA.post('/withdraw/new', { _csrf: csrfOf(wp.text), method_id: '2', amount: '5' });
    trail.push(r.status);
  }
  assert.equal(trail[trail.length - 1], 429, 'withdraw/new rapid-fire trail: ' + trail.join(','));
  const trailS = [];
  for (let i = 0; i < 11; i++) {
    const sp = await jarA.get('/security');
    const r = await jarA.post('/security/password', { _csrf: csrfOf(sp.text), current_password: 'wrong', new_password: 'Whatever#123', confirm_password: 'Whatever#123' });
    trailS.push(r.status);
  }
  assert.equal(trailS[trailS.length - 1], 429, 'player security rapid-fire trail: ' + trailS.join(','));
});

test('D2-C6: verify-email invalidates prior tokens and is rate-limited per user', async () => {
  const jar = new Jar();
  await login(jar, 'pb@dfixb.test', PW_B);
  const prof = await jar.get('/profile');
  const csrf = csrfOf(prof.text);
  await jar.post('/profile/verify-email', { _csrf: csrf });
  await jar.post('/profile/verify-email', { _csrf: csrf });
  const live = await db.query('SELECT token_hash FROM email_verifications WHERE user_id = ? AND used = 0', [userB]);
  assert.equal(live.length, 1, 'only the latest verify token is live after a second issuance');
  let last = 0;
  for (let i = 0; i < 4; i++) { const r = await jar.post('/profile/verify-email', { _csrf: csrf }); last = r.status; }
  assert.equal(last, 429, 'the limiter (5/hour per user) trips on hammering');
});

test('D2-C3: TOTP enrolment requires the current password — player and admin', async () => {
  // Player half uses a FRESH jar/user: the rate-gap test deliberately
  // exhausted jarA's shared player-security limiter bucket (15-min
  // window), which would 429 these POSTs for the wrong reason.
  const jarP = new Jar();
  const lp = await login(jarP, 'pb@dfixb.test', PW_B);
  assert.equal(lp.status, 302, 'player B login for the TOTP half');
  const jarA = jarP;
  // Player: no password -> refused, no pending secret.
  const sec = await jarA.get('/security');
  const r1 = await jarA.post('/security/totp/start', { _csrf: csrfOf(sec.text) });
  const land1 = await jarA.follow(r1);
  assert.match(land1.text, /Wrong password\./);
  let sess = await db.get("SELECT data FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT 1", [userB]);
  assert.ok(!/"totp_pending"\s*:\s*"/.test(sess.data), 'no enrolment secret was stored');
  // Wrong password -> refused.
  const sec2 = await jarA.get('/security');
  const r2 = await jarA.post('/security/totp/start', { _csrf: csrfOf(sec2.text), password: 'nope-nope' });
  const land2 = await jarA.follow(r2);
  assert.match(land2.text, /Wrong password\./);
  // Correct password -> enrolment starts; confirm WITHOUT password -> refused.
  const sec3 = await jarA.get('/security');
  const r3 = await jarA.post('/security/totp/start', { _csrf: csrfOf(sec3.text), password: PW_B });
  const land3 = await jarA.follow(r3);
  assert.match(land3.text, /Save this secret|Authenticator/, 'enrolment started with the correct password');
  const allSess = await db.query("SELECT data FROM sessions WHERE user_id = ?", [userB]);
  sess = allSess.find((s) => /totp_pending/.test(s.data || '')) || allSess[0] || { data: '' };
  const secret = (/"totp_pending"\s*:\s*"([^"]+)"/.exec(sess.data) || [])[1];
  assert.ok(secret, 'pending secret stored after password-verified start; session data: ' + String(sess.data).slice(0, 200) + '; start flash: ' + ((/data-flash[^>]*>([^<]+)/.exec(land3.text) || [])[1] || '(none)'));
  const { totpCode } = require('../lib/auth');
  const code = totpCode(secret);
  const bad = await jarA.post('/security/totp/confirm', { _csrf: csrfOf(land3.text), totp_code: code });
  const landB = await jarA.follow(bad);
  assert.match(landB.text, /Wrong password\./, 'confirm without password refused even with a valid code');
  let u = await db.get('SELECT totp_secret FROM users WHERE id = ?', [userB]);
  assert.ok(!u.totp_secret, '2FA was NOT enabled');
  const ok = await jarA.post('/security/totp/confirm', { _csrf: csrfOf(landB.text), password: PW_B, totp_code: totpCode(secret) });
  await jarA.follow(ok);
  u = await db.get('SELECT totp_secret FROM users WHERE id = ?', [userB]);
  assert.ok(u.totp_secret, '2FA enabled with password + valid code');
  // Passwordless branch: an account with NO password (OAuth/OTP-created)
  // is refused with the set-a-password reason (a set-password path exists
  // on /security, so the refusal is the implemented behaviour).
  const jarN = new Jar();
  await register(jarN, 'No Pass', 'nopass@dfixb.test', '+15550177', PW_B);
  await db.run("UPDATE users SET password_hash = NULL WHERE email = 'nopass@dfixb.test'");
  const secN = await jarN.get('/security');
  const rn = await jarN.post('/security/totp/start', { _csrf: csrfOf(secN.text), password: 'anything' });
  const landN = await jarN.follow(rn);
  assert.match(landN.text, /Set a password on your account before enabling two-factor authentication\./);
  // Admin twin: start without password refused; with password starts.
  const ag = await adminJar.get(ADMIN + '/security');
  const ar = await adminJar.post(ADMIN + '/security/totp/start', { _csrf: csrfOf(ag.text) });
  const aland = await adminJar.follow(ar);
  assert.match(aland.text, /Wrong password\./);
  const ag2 = await adminJar.get(ADMIN + '/security');
  const ar2 = await adminJar.post(ADMIN + '/security/totp/start', { _csrf: csrfOf(ag2.text), password: ADMIN_PW });
  const aland2 = await adminJar.follow(ar2);
  assert.match(aland2.text, /Scan the QR|secret/i, 'admin enrolment starts with the correct password');
});

test('D3-C5: broadcast queued batches store MASKED content; no raw secret link anywhere in notifications_log', async () => {
  for (let i = 0; i < 3; i++) {
    const j = new Jar();
    await register(j, 'Bulk ' + i, 'bulk' + i + '@dfixb.test', '+1555011' + i, PW_B);
  }
  const page = await adminJar.get(ADMIN + '/notifications?tab=send');
  const secret = 'SECRETTOKENDFIXB123';
  const r = await adminJar.post(ADMIN + '/notifications/send', {
    _csrf: csrfOf(page.text), to: 'all', subject: 'Reset inside', message: 'Use this link: http://localhost:' + PORT + '/reset/' + secret + ' now', start_from: '1', per_batch: '1', cooling: '60',
  });
  assert.ok(r.status === 302 || r.status === 200);
  const queued = await db.query("SELECT subject, body FROM notifications_log WHERE status = 'queued'");
  assert.ok(queued.length >= 1, 'later batches were queued');
  for (const q of queued) assert.ok(!q.body.includes(secret) && !q.subject.includes(secret), 'queued copy is masked');
  const raw = await db.query('SELECT subject, body FROM notifications_log');
  for (const q of raw) assert.ok(!(q.body || '').includes(secret) && !(q.subject || '').includes(secret), 'no raw token in ANY stored notification row');
});

test('D4-C2: pagination clamps — page=999 renders the LAST page with a truthful counter', async () => {
  for (let i = 0; i < 30; i++) {
    await db.run("INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, winning_number, is_test, created_at) VALUES ('DAY', ?, 1, 'settled', 'h', 's', 7, 0, ?)", ['2020-03-' + String(i + 1).padStart(2, '0'), Date.now()]);
  }
  const res = await (new Jar()).get('/results?page=999');
  assert.match(res.text, /Page 2 of 2/);
  assert.ok(!/No results yet/.test(res.text), 'not the empty state');
  for (let i = 0; i < 60; i++) { // PER is 50 on /transactions: 60 seeded + real rows => 2 pages
    await db.run("INSERT INTO transactions (user_id, currency, type, amount, balance_after, ref_type, ref_id, meta, created_at) VALUES (?, 'USD', 'deposit', 100, 100, 'test', ?, '{}', ?)", [userA, 'seedtx' + i, Date.now() + i]);
  }
  const tx = await jarA.get('/transactions?page=999');
  const txm = /Page [^<]+/.exec(tx.text);
  assert.match(tx.text, /Page 2 of 2/, 'transactions counter: ' + (txm ? txm[0] : '(none)'));
  assert.ok(!/Page 999 of/.test(tx.text), 'the transactions counter is clamped too');
});

test('D4-C2 (scratch): /scratch/my-tickets?page=999 renders the last page, not an empty one', async () => {
  const live = await db.get("SELECT id FROM scratch_series WHERE status = 'live' LIMIT 1");
  for (let i = 0; i < 30; i++) {
    const o = await db.run('INSERT INTO scratch_outcomes (series_id, ordinal, nonce, prize, commitment) VALUES (?, ?, ?, 0, ?)', [live.id, 9000 + i, 9000 + i, 'seedc' + i]);
    await db.run("INSERT INTO scratch_tickets (public_id, user_id, series_id, outcome_id, currency, price, status, prize, outcome_commitment, purchased_at) VALUES (?, ?, ?, ?, 'USD', 100, 'purchased', NULL, 'c', ?)", ['STDFIXB' + i, userA, live.id, o.id, Date.now() + i]);
  }
  const page = await jarA.get('/scratch/my-tickets?page=999');
  assert.match(page.text, /Page 2 of 2/, 'clamped to the last page (25 per page, 30+ tickets)');
});

test('D4-C3: a settled TEST draw fairness page renders the TEST badge as markup, never escaped text', async () => {
  const d = await db.run("INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, winning_number, is_test, created_at) VALUES ('EVE', '2020-04-01', 1, 'settled', 'h', 's', 9, 1, ?)", [Date.now()]);
  const page = await (new Jar()).get('/fairness?draw_id=' + d.id);
  assert.ok(page.text.includes('<span class="badge b-warn">TEST</span>'), 'real badge markup present');
  assert.ok(!page.text.includes('&lt;span'), 'no escaped HTML string leaks as text');
});

test('D4-C5: scratch buy-error re-render shows the series REAL status (draft is not "Live")', async () => {
  const draft = await db.get("SELECT id FROM scratch_series WHERE status = 'draft' LIMIT 1").catch(() => null);
  let draftId;
  if (draft) draftId = draft.id;
  else {
    const r = await db.run("INSERT INTO scratch_series (title, slug, game_type, currency, price, total_tickets, status, enabled, server_seed, seed_hash, created_by, created_at) VALUES ('DFIXB Draft', 'dfixb-draft', 'single', 'USD', 100, 10, 'draft', 1, 'seed', 'hash', 1, ?)", [Date.now()]);
    draftId = r.id;
  }
  const page = await jarA.post('/scratch/' + draftId + '/buy', { _csrf: csrfOf((await jarA.get('/scratch')).text) });
  assert.equal(page.status, 400, 'buy error re-renders the detail page (400 with the true reason)');
  assert.ok(!/status-dot/.test(page.text), 'no Live dot for a draft series');
  assert.match(page.text, /Draft/);
  const live = await db.get("SELECT id FROM scratch_series WHERE status = 'live' LIMIT 1");
  const broke = new Jar();
  await register(broke, 'Broke P', 'broke@dfixb.test', '+15550199', PW_B);
  await db.run("UPDATE users SET email_verified = 1 WHERE email = 'broke@dfixb.test'");
  await login(broke, 'broke@dfixb.test', PW_B);
  const lp = await broke.post('/scratch/' + live.id + '/buy', { _csrf: csrfOf((await broke.get('/scratch')).text) });
  assert.match(lp.text, /status-dot/, 'a live series error re-render still shows the Live dot');
});

test('View observations: forgot renders formError; login renders the captcha block when the extension is ON', async () => {
  await db.run("UPDATE extensions SET enabled = 1 WHERE key = 'custom_captcha'");
  await sleep(6000);
  const jar = new Jar();
  const lg = await jar.get('/login');
  assert.match(lg.text, /captcha_answer/, 'login page now asks the captcha question it demands');
  const fg = await jar.get('/forgot');
  assert.match(fg.text, /captcha_answer/, 'forgot page captcha present (sanity)');
  const bad = await jar.post('/forgot', { _csrf: csrfOf(fg.text), email: 'pa@dfixb.test', captcha_answer: '999' });
  assert.match(bad.text, /Captcha verification failed\./, 'the refused forgot POST shows its true reason (formError slot)');
  await db.run("UPDATE extensions SET enabled = 0 WHERE key = 'custom_captcha'");
});
