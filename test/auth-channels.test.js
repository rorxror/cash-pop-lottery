'use strict';
/* AUTH-CHANNELS-01 — every sign-in / verification channel proven with
   PROVIDER DOUBLES (no real external services):
   - Email: an in-process SMTP capture server receives real nodemailer
     deliveries from the spawned app (SMTP env points at it).
   - SMS: TextBelt is intercepted by a fetch stub injected into the app
     process (NODE_OPTIONS --require); the stub records the SMS body
     (so the test can read the delivered code) and can be flipped to
     failure via a control file.
   - Google / Facebook OAuth: token + profile endpoints answered by the
     same fetch stub.
   - Delivery truth: when delivery FAILS, the player gets the honest
     error and the undelivered OTP row is invalidated (verified = 2).
   - Admin health card shows CONFIGURED booleans + test sends work. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

const PORT = 4149, BASE = `http://127.0.0.1:${PORT}`, ROOT = path.join(__dirname, '..');
const AP = '/ops-7f3a9c-console';
const DBP = `/tmp/cp-auth-${process.pid}.sqlite`;
const CTL = `/tmp/cp-auth-ctl-${process.pid}.json`;
const SMSOUT = `/tmp/cp-auth-sms-${process.pid}.log`;
const STUB = `/tmp/cp-auth-stub-${process.pid}.js`;
let server, db, smtpServer, smtpPort;
const mails = [];

function setCtl(patch) {
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(CTL, 'utf8')); } catch {}
  fs.writeFileSync(CTL, JSON.stringify({ ...cur, ...patch }));
}
function lastMail() { return mails[mails.length - 1] || ''; }
function codeFrom(text) { const m = String(text).match(/code is[:\s]*([0-9]{6})/i) || String(text).match(/\b([0-9]{6})\b/); assert.ok(m, 'a 6-digit code is present in: ' + String(text).slice(0, 200)); return m[1]; }

class Jar {
  constructor() { this.m = new Map(); }
  absorb(h) { const sc = h.getSetCookie ? h.getSetCookie() : []; for (const c of sc) { const p = c.split(';')[0]; const i = p.indexOf('='); if (i > 0) { const k = p.slice(0, i).trim(), v = p.slice(i + 1).trim(); if (v) this.m.set(k, v); else this.m.delete(k); } } }
  header() { return [...this.m.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(p, { method = 'GET', body } = {}) {
    const r = await fetch(BASE + p, { method, redirect: 'manual', headers: { cookie: this.header(), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: body ? new URLSearchParams(body).toString() : undefined });
    this.absorb(r.headers); return { status: r.status, loc: r.headers.get('location') || '', html: await r.text() };
  }
  csrf(html) { const m = html.match(/name="_csrf" value="([^"]+)"/); assert.ok(m, 'csrf present'); return m[1]; }
  async loginPage() { const g = await this.req('/login'); return this.csrf(g.html); }
}
const admin = new Jar();

before(async () => {
  fs.writeFileSync(CTL, JSON.stringify({ sms: 'ok',
    google: { id: 'g-1001', email: 'gina.google@example.com', name: 'Gina Google', verified_email: true },
    facebook: { id: 'fb-2002', name: 'Fred Book', email: 'fred.book@example.com' } }));
  fs.writeFileSync(STUB, `
const fs = require('fs');
const realFetch = globalThis.fetch;
function ctl() { try { return JSON.parse(fs.readFileSync(process.env.STUB_CTL, 'utf8')); } catch { return {}; } }
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } }); }
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url); const c = ctl();
  if (u.startsWith('https://textbelt.com/')) {
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch {}
    fs.appendFileSync(process.env.STUB_SMS_OUT, JSON.stringify(body) + '\\n');
    if (c.sms === 'fail') return json({ success: false, error: 'quota exceeded' });
    return json({ success: true, textId: 'tb-stub-1' });
  }
  if (u.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'stub-google-token' });
  if (u.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) return json(c.google || {});
  if (u.startsWith('https://graph.facebook.com/v18.0/oauth/access_token')) return json({ access_token: 'stub-fb-token' });
  if (u.startsWith('https://graph.facebook.com/me')) return json(c.facebook || {});
  return realFetch(url, opts);
};`);
  // Minimal SMTP capture: enough of RFC 5321 for nodemailer.
  smtpServer = net.createServer(sock => {
    let dataMode = false, buf = '';
    sock.write('220 capture.local ESMTP ready\r\n');
    sock.on('data', chunk => {
      buf += chunk.toString('utf8');
      if (dataMode) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end > -1) { mails.push(buf.slice(0, end)); buf = buf.slice(end + 5); dataMode = false; sock.write('250 OK queued\r\n'); }
        return;
      }
      let idx;
      while ((idx = buf.indexOf('\r\n')) > -1) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-capture.local\r\n250 OK\r\n');
        else if (cmd === 'DATA') { dataMode = true; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); break; }
        else if (cmd === 'QUIT') { sock.write('221 Bye\r\n'); sock.end(); }
        else sock.write('250 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise(r => smtpServer.listen(0, '127.0.0.1', r));
  smtpPort = smtpServer.address().port;

  const env = { ...process.env, PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite', SQLITE_PATH: DBP,
    TICKET_HMAC_SECRET: 'auth-test-' + 'x'.repeat(48),
    CREDENTIAL_ENCRYPTION_KEY: 'a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6a6',
    ADMIN_SEED_EMAIL: 'auth-admin@example.com', ADMIN_SEED_PASSWORD: 'AuthAdminPass-2026', ADMIN_SEED_NAME: 'Auth Admin',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_FROM: 'Cash Pop <test@cashpop.example>',
    SMS_PROVIDER: 'textbelt', TEXTBELT_KEY: 'test-key',
    GOOGLE_CLIENT_ID: 'gid-test', GOOGLE_CLIENT_SECRET: 'gsecret-test',
    FACEBOOK_APP_ID: 'fid-test', FACEBOOK_APP_SECRET: 'fsecret-test',
    NODE_OPTIONS: '--require ' + STUB, STUB_CTL: CTL, STUB_SMS_OUT: SMSOUT };
  delete env.DATABASE_URL;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[auth server] ' + d));
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { try { const r = await fetch(BASE + '/healthz'); ok = r.status === 200; } catch {} if (!ok) await new Promise(r => setTimeout(r, 500)); }
  assert.ok(ok, 'server boots');
  process.env.SQLITE_PATH = DBP; process.env.DB_DRIVER = 'sqlite';
  db = require('../lib/db').openDB().db;
  for (const [k, v] of [['email_otp_enabled', '1'], ['phone_otp_enabled', '1'], ['google_oauth_enabled', '1'], ['facebook_oauth_enabled', '1'], ['withdrawal_turnover_required', '0']])
    await db.run('UPDATE settings SET value = ? WHERE key = ?', [v, k]);
  await new Promise(r => setTimeout(r, 5200)); // settings cache TTL (second-connection writes)
  const g = await admin.req(AP);
  await admin.req(AP + '/login', { method: 'POST', body: { _csrf: admin.csrf(g.html), email: 'auth-admin@example.com', password: 'AuthAdminPass-2026' } });
});
after(() => { if (server) server.kill(); if (smtpServer) smtpServer.close(); });

async function makePlayer(email, password, extra = {}) {
  const { hashPassword } = require('../lib/util');
  const ins = await db.run("INSERT INTO users (name, email, phone, password_hash, role, status, email_verified, created_at) VALUES (?, ?, ?, ?, 'player', 'active', 1, ?)",
    [extra.name || 'Test Player', email, extra.phone || '', await hashPassword(password), Date.now()]);
  return ins.id;
}

test('health card: channels CONFIGURED from env presence; test sends deliver + report truthfully', async () => {
  const page = await admin.req(AP + '/security');
  assert.equal(page.status, 200);
  assert.ok(page.html.includes('verification health'), 'health card present');
  assert.ok(page.html.includes('Email (SMTP)') && page.html.includes('TextBelt'), 'email + named SMS provider rows');
  assert.ok(page.html.includes('Google sign-in') && page.html.includes('Facebook sign-in'), 'OAuth rows');
  assert.ok(page.html.includes('CONFIGURED'), 'configured badges shown');
  assert.ok(!page.html.includes('gsecret-test') && !page.html.includes('test-key'), 'no secret VALUES anywhere on the page');
  const t = await admin.req(AP + '/security/test-email', { method: 'POST', body: { _csrf: admin.csrf(page.html), to: 'owner-test@example.com' } });
  assert.equal(t.status, 302);
  const fol = await admin.req(t.loc);
  assert.ok(fol.html.includes('Test email sent'), 'test email reported sent (SMTP capture is live)');
  assert.ok(lastMail().includes('test email from your Cash Pop admin panel'), 'test email actually arrived at the capture server');
  const s = await admin.req(AP + '/security/test-sms', { method: 'POST', body: { _csrf: admin.csrf(page.html), to: '+15550001122' } });
  const fol2 = await admin.req(s.loc);
  assert.ok(fol2.html.includes('Test SMS sent'), 'test SMS reported sent (stub accepted)');
  const auditRow = await db.get("SELECT id FROM audit_log WHERE action = 'security.test_send'");
  assert.ok(auditRow, 'test sends audit-logged');
});

test('email OTP login: code arrives by real SMTP delivery and logs the user in', async () => {
  const pid = await makePlayer('otp.ema@example.com', 'OtpPass#12345');
  const jar = new Jar();
  const csrf = await jar.loginPage();
  const before = mails.length;
  const r = await jar.req('/login/otp/request', { method: 'POST', body: { _csrf: csrf, identifier: 'otp.ema@example.com', type: 'email' } });
  assert.equal(r.status, 200, JSON.stringify(r.html).slice(0, 200));
  assert.ok(JSON.parse(r.html).ok, 'request accepted');
  assert.ok(mails.length > before, 'an email was delivered to the capture server');
  const code = codeFrom(lastMail());
  const v = await jar.req('/login/otp/verify', { method: 'POST', body: { _csrf: csrf, identifier: 'otp.ema@example.com', type: 'email', code } });
  assert.ok(v.status === 200 || v.status === 302, 'verify succeeds (status ' + v.status + ')');
  if (v.status === 200) assert.ok(JSON.parse(v.html).ok, 'verify logs in');
  const w = await jar.req('/wallet');
  assert.equal(w.status, 200, 'session is live after OTP login');
  void pid;
});

test('withdrawal OTP by email: code delivered, verify completes the withdrawal', async () => {
  const pid = await makePlayer('wd.ema@example.com', 'WdPass#12345');
  await db.run("INSERT INTO wallets (user_id, currency, balance) VALUES (?, 'USD', 50000)", [pid]).catch(async () => {
    await db.run("INSERT INTO wallets (user_id, currency, balance, created_at, updated_at) VALUES (?, 'USD', 50000, ?, ?)", [pid, Date.now(), Date.now()]);
  });
  const bank = await db.get("SELECT id FROM payment_methods WHERE slug = 'rail-bank_transfer'");
  await db.run('UPDATE payment_methods SET enabled = 1 WHERE id = ?', [bank.id]);
  const jar = new Jar();
  const lp = await jar.req('/login');
  await jar.req('/login', { method: 'POST', body: { _csrf: jar.csrf(lp.html), email: 'wd.ema@example.com', password: 'WdPass#12345' } });
  const form = await jar.req('/withdraw/new');
  const before = mails.length;
  const sub = await jar.req('/withdraw/new', { method: 'POST', body: { _csrf: jar.csrf(form.html), method_id: String(bank.id), amount: '20.00', custom_account_name: 'Player One', custom_account_number: 'GB29NWBK60161331926820', custom_bank_name: 'Player Bank' } });
  assert.equal(sub.status, 200, 'verify screen rendered: ' + sub.html.slice(0, 120));
  assert.ok(mails.length > before, 'withdrawal code delivered by email');
  const code = codeFrom(lastMail());
  const ver = await jar.req('/withdraw/verify', { method: 'POST', body: { _csrf: jar.csrf(sub.html), code } });
  assert.equal(ver.status, 302);
  const row = await db.get('SELECT * FROM withdrawals WHERE user_id = ?', [pid]);
  assert.ok(row, 'withdrawal row created after OTP verify');
  assert.equal(row.amount, 2000, 'exact amount held');
});

test('password reset: the emailed link token is live (delivery happened)', async () => {
  await makePlayer('reset.ema@example.com', 'ResetPass#123');
  const jar = new Jar();
  const f = await jar.req('/forgot');
  const before = mails.length;
  const r = await jar.req('/forgot', { method: 'POST', body: { _csrf: jar.csrf(f.html), email: 'reset.ema@example.com' } });
  assert.equal(r.status, 200);
  assert.ok(mails.length > before, 'reset email delivered');
  const m = lastMail().match(/\/reset\/([a-f0-9]{32,})/);
  assert.ok(m, 'reset link in the delivered email');
  const { sha256 } = require('../lib/util');
  const row = await db.get('SELECT * FROM password_resets WHERE token_hash = ?', [sha256('reset:' + m[1])]);
  assert.ok(row && Number(row.used) === 0, 'delivered reset token stays live');
});

test('phone verify by SMS (TextBelt double): code delivered, confirm verifies; failed send invalidates the code', async () => {
  const pid = await makePlayer('phone.ema@example.com', 'PhonePass#123', { phone: '+15557650123' });
  const jar = new Jar();
  const lp = await jar.req('/login');
  await jar.req('/login', { method: 'POST', body: { _csrf: jar.csrf(lp.html), email: 'phone.ema@example.com', password: 'PhonePass#123' } });
  const prof = await jar.req('/profile');
  const send = await jar.req('/profile/verify-phone', { method: 'POST', body: { _csrf: jar.csrf(prof.html) } });
  assert.equal(send.status, 302);
  const smsLines = fs.readFileSync(SMSOUT, 'utf8').trim().split('\n');
  const lastSms = JSON.parse(smsLines[smsLines.length - 1]);
  const code = codeFrom(lastSms.message || lastSms.body || JSON.stringify(lastSms));
  const prof2 = await jar.req('/profile?verify_phone=1');
  const conf = await jar.req('/profile/verify-phone/confirm', { method: 'POST', body: { _csrf: jar.csrf(prof2.html), code } });
  assert.equal(conf.status, 302);
  const u = await db.get('SELECT mobile_verified FROM users WHERE id = ?', [pid]);
  assert.equal(Number(u.mobile_verified), 1, 'phone marked verified');
  // Failure leg: provider now fails -> honest error + the new code is dead.
  setCtl({ sms: 'fail' });
  const prof3 = await jar.req('/profile');
  const send2 = await jar.req('/profile/verify-phone', { method: 'POST', body: { _csrf: jar.csrf(prof3.html) } });
  const fol = await jar.req(send2.loc);
  assert.ok(fol.html.includes('Could not send the verification code'), 'honest failure message');
  const live = await db.get("SELECT COUNT(*) AS c FROM login_otps WHERE identifier = '+15557650123' AND id_type = 'phone' AND verified = 0", []);
  assert.equal(Number(live.c), 0, 'undelivered code invalidated (no live row)');
  setCtl({ sms: 'ok' });
});

test('Google OAuth (stubbed endpoints): create once, reuse the same account, link by verified email', async () => {
  const jar = new Jar();
  const start = await jar.req('/auth/google');
  assert.equal(start.status, 302);
  const state = new URL(start.loc).searchParams.get('state');
  assert.ok(state, 'state issued');
  const cb = await jar.req('/auth/google/callback?code=stubcode&state=' + state);
  assert.notEqual(cb.status, 500);
  const rows = await db.query("SELECT * FROM users WHERE email = 'gina.google@example.com'");
  assert.equal(rows.length, 1, 'exactly one account created');
  assert.equal(rows[0].google_id, 'g-1001', 'google_id recorded from birth');
  const jar2 = new Jar();
  const s2 = await jar2.req('/auth/google');
  const st2 = new URL(s2.loc).searchParams.get('state');
  await jar2.req('/auth/google/callback?code=stubcode&state=' + st2);
  const rows2 = await db.query("SELECT * FROM users WHERE email = 'gina.google@example.com'");
  assert.equal(rows2.length, 1, 'second sign-in reuses the same account (one-account rule)');
  // Link: pre-existing password account with the SAME verified email.
  const lid = await makePlayer('link.me@example.com', 'LinkPass#1234');
  setCtl({ google: { id: 'g-7777', email: 'link.me@example.com', name: 'Link Me', verified_email: true } });
  const jar3 = new Jar();
  const s3 = await jar3.req('/auth/google');
  const st3 = new URL(s3.loc).searchParams.get('state');
  await jar3.req('/auth/google/callback?code=stubcode&state=' + st3);
  const linked = await db.get('SELECT google_id FROM users WHERE id = ?', [lid]);
  assert.equal(linked.google_id, 'g-7777', 'verified-email match links to the existing account, no duplicate');
  const total = await db.get("SELECT COUNT(*) AS c FROM users WHERE email = 'link.me@example.com'");
  assert.equal(Number(total.c), 1);
});

test('Facebook OAuth (stubbed graph endpoints): create + reuse smoke', async () => {
  const jar = new Jar();
  const s = await jar.req('/auth/facebook');
  assert.equal(s.status, 302);
  const state = new URL(s.loc).searchParams.get('state');
  await jar.req('/auth/facebook/callback?code=stubcode&state=' + state);
  const rows = await db.query("SELECT * FROM users WHERE email = 'fred.book@example.com'");
  assert.equal(rows.length, 1, 'facebook account created once');
  assert.equal(rows[0].facebook_id, 'fb-2002');
  const jar2 = new Jar();
  const s2 = await jar2.req('/auth/facebook');
  const st2 = new URL(s2.loc).searchParams.get('state');
  await jar2.req('/auth/facebook/callback?code=stubcode&state=' + st2);
  const rows2 = await db.query("SELECT * FROM users WHERE email = 'fred.book@example.com'");
  assert.equal(rows2.length, 1, 'facebook reuse — still one account');
});

test('failed email delivery: honest 503 and the undelivered code is invalidated', async () => {
  await makePlayer('down.ema@example.com', 'DownPass#1234');
  smtpServer.close(); // SMTP now refuses connections
  await new Promise(r => setTimeout(r, 300));
  const jar = new Jar();
  const csrf = await jar.loginPage();
  const r = await jar.req('/login/otp/request', { method: 'POST', body: { _csrf: csrf, identifier: 'down.ema@example.com', type: 'email' } });
  assert.equal(r.status, 503, 'request refused honestly: ' + r.html.slice(0, 120));
  assert.ok(JSON.parse(r.html).error.includes('Could not send the code'), 'plain honest message');
  const live = await db.get("SELECT COUNT(*) AS c FROM login_otps WHERE identifier = 'down.ema@example.com' AND verified = 0", []);
  assert.equal(Number(live.c), 0, 'undelivered login code invalidated');
});
