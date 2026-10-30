'use strict';
/* v23 DELIVERY-OTP (extra) — the legs test/delivery-otp.test.js does
   not cover, per the build spec:
   - Twilio SMS OTP E2E through a local double (TWILIO_API_BASE
     test-only hook; the hook defaults to https://api.twilio.com).
   - OTP-D3 effective-provider fallback: Twilio selected but NOT
     configured, TextBelt panel-configured -> sends via TextBelt and
     the health card notes the FALLBACK.
   - OTP-D6: changing the panel SMTP port rebuilds the mail transport
     in the SAME process (dead port fails, restored port delivers).
   - SMS withdrawal OTP purpose wording for a phone-only account.
   - lib/credentials global save fails closed without the key.
   Run: node --test test/delivery-otp-extra.test.js */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');
const AP = '/ops-7f3a9c-console';
const ENC_KEY = 'd8'.repeat(32);
const PORT = 4255, BASE = `http://127.0.0.1:${PORT}`;
const DBP = `/tmp/cp-delx-${process.pid}.sqlite`;
const ADMIN_EMAIL = 'delx-admin@example.com', ADMIN_PASS = 'DelxAdminPass-2026';

let server = null, db = null, admin = null;
let smtpServer = null, smtpPort = 0;
let smsServer = null, smsBase = '';
const mails = [];
const smsHits = [];

class Jar {
  constructor() { this.m = new Map(); }
  absorb(h) { const sc = h.getSetCookie ? h.getSetCookie() : []; for (const c of sc) { const p = c.split(';')[0]; const i = p.indexOf('='); if (i > 0) { const k = p.slice(0, i).trim(), v = p.slice(i + 1).trim(); if (v) this.m.set(k, v); else this.m.delete(k); } } }
  header() { return [...this.m.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(p, { method = 'GET', body } = {}) {
    const r = await fetch(BASE + p, { method, redirect: 'manual', headers: { cookie: this.header(), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: body ? new URLSearchParams(body).toString() : undefined });
    this.absorb(r.headers); return { status: r.status, loc: r.headers.get('location') || '', html: await r.text() };
  }
  csrf(html) { const m = html.match(/name="_csrf" value="([^"]+)"/); assert.ok(m, 'csrf present'); return m[1]; }
}
function codeFrom(text) { const m = String(text).match(/code is[:\s]*([0-9]{6})/i) || String(text).match(/\b([0-9]{6})\b/); assert.ok(m, 'a 6-digit code is present in: ' + String(text).slice(0, 200)); return m[1]; }
async function makePlayer(email, password, extra = {}) {
  const { hashPassword } = require('../lib/util');
  const ins = await db.run("INSERT INTO users (name, email, phone, password_hash, role, status, email_verified, created_at) VALUES (?, ?, ?, ?, 'player', 'active', 1, ?)",
    [extra.name || 'Extra Player', email, extra.phone || '', hashPassword(password), Date.now()]);
  return ins.id;
}
async function playerLogin(email, password) {
  const jar = new Jar();
  const lp = await jar.req('/login');
  const post = await jar.req('/login', { method: 'POST', body: { _csrf: jar.csrf(lp.html), email, password } });
  assert.equal(post.status, 302, 'player login ' + email);
  return jar;
}
async function setProvider(provider) {
  const sPage = await admin.req(AP + '/settings');
  const r = await admin.req(AP + '/settings/appearance', { method: 'POST', body: {
    _csrf: admin.csrf(sPage.html), site_name: 'Cash Pop Lottery', cookie_text: '', custom_css: '', site_timezone: 'UTC', support_notify_email: '', sms_provider: provider,
  } });
  assert.equal(r.status, 302, 'provider saved');
}
async function phoneVerifySend(jar) {
  const prof = await jar.req('/profile');
  return jar.req('/profile/verify-phone', { method: 'POST', body: { _csrf: jar.csrf(prof.html) } });
}

before(async () => {
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
  smsServer = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url === '/text') {
        let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
        smsHits.push({ kind: 'textbelt', key: j.key, to: j.phone, message: j.message });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, textId: 'tb-x-1' }));
        return;
      }
      if (req.url.startsWith('/2010-04-01/Accounts/')) {
        const params = new URLSearchParams(body);
        const sid = decodeURIComponent(req.url.split('/Accounts/')[1].split('/')[0]);
        smsHits.push({ kind: 'twilio', sid, from: params.get('From'), to: params.get('To'), message: params.get('Body') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ sid: 'SM-x-1' }));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise(r => smsServer.listen(0, '127.0.0.1', r));
  smsBase = `http://127.0.0.1:${smsServer.address().port}`;

  const env = { ...process.env, PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite', SQLITE_PATH: DBP,
    TICKET_HMAC_SECRET: 'delx-test-' + 'z'.repeat(48), CREDENTIAL_ENCRYPTION_KEY: ENC_KEY,
    ADMIN_SEED_EMAIL: ADMIN_EMAIL, ADMIN_SEED_PASSWORD: ADMIN_PASS, ADMIN_SEED_NAME: 'Delx Admin',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_FROM: 'Cash Pop <env@cashpop.example>',
    TEXTBELT_API_URL: smsBase + '/text', TWILIO_API_BASE: smsBase };
  for (const k of ['DATABASE_URL', 'SMS_PROVIDER', 'TWILIO_SID', 'TWILIO_TOKEN', 'TWILIO_FROM', 'TEXTBELT_KEY', 'SMTP_USER', 'SMTP_PASS']) delete env[k];
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[delx server] ' + d));
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { try { const r = await fetch(BASE + '/healthz'); ok = r.status === 200; } catch {} if (!ok) await new Promise(r => setTimeout(r, 500)); }
  assert.ok(ok, 'server boots');
  process.env.SQLITE_PATH = DBP; process.env.DB_DRIVER = 'sqlite';
  db = require('../lib/db').openDB().db;
  for (const [k, v] of [['email_otp_enabled', '1'], ['phone_otp_enabled', '1'], ['withdrawal_turnover_required', '0']])
    await db.run('UPDATE settings SET value = ? WHERE key = ?', [v, k]);
  await new Promise(r => setTimeout(r, 5200));
  admin = new Jar();
  const g = await admin.req(AP);
  const post = await admin.req(AP + '/login', { method: 'POST', body: { _csrf: admin.csrf(g.html), email: ADMIN_EMAIL, password: ADMIN_PASS } });
  assert.equal(post.status, 302, 'admin login');
});
after(() => { if (server) server.kill(); if (smtpServer) smtpServer.close(); if (smsServer) smsServer.close(); });

test('OTP-D6: panel SMTP port change rebuilds the transport in-process (dead port fails, restored port delivers)', async () => {
  await makePlayer('x.d6@example.com', 'Dsix#12345');
  const page = await admin.req(AP + '/security');
  await admin.req(AP + '/security/delivery', { method: 'POST', body: { _csrf: admin.csrf(page.html), smtp_port: '59998' } });
  const jar = new Jar();
  const csrf = jar.csrf((await jar.req('/login')).html);
  const bad = await jar.req('/login/otp/request', { method: 'POST', body: { _csrf: csrf, identifier: 'x.d6@example.com', type: 'email' } });
  assert.equal(bad.status, 503, 'panel dead port breaks delivery (panel beats env)');
  const page2 = await admin.req(AP + '/security');
  await admin.req(AP + '/security/delivery', { method: 'POST', body: { _csrf: admin.csrf(page2.html), smtp_port: String(smtpPort) } });
  const before = mails.length;
  const good = await jar.req('/login/otp/request', { method: 'POST', body: { _csrf: csrf, identifier: 'x.d6@example.com', type: 'email' } });
  assert.equal(good.status, 200, 'delivery recovers without a restart: ' + good.html.slice(0, 120));
  assert.ok(mails.length > before, 'mail arrived after the transport rebuild');
});

test('OTP-D3 fallback: Twilio selected but unconfigured, panel TextBelt configured — sends via TextBelt, health notes FALLBACK', async () => {
  const page = await admin.req(AP + '/security');
  await admin.req(AP + '/security/delivery', { method: 'POST', body: { _csrf: admin.csrf(page.html), textbelt_key: 'x-panel-tb-key' } });
  await setProvider('twilio');
  await makePlayer('x.fb@example.com', 'Fall#12345', { phone: '+15550009201' });
  const jar = await playerLogin('x.fb@example.com', 'Fall#12345');
  const hitsBefore = smsHits.length;
  const send = await phoneVerifySend(jar);
  assert.equal(send.status, 302);
  const hits = smsHits.slice(hitsBefore);
  assert.ok(hits.some(h => h.kind === 'textbelt' && h.key === 'x-panel-tb-key'), 'fell back to the configured TextBelt with the panel key');
  assert.ok(!hits.some(h => h.kind === 'twilio'), 'unconfigured Twilio was never attempted');
  const sec = await admin.req(AP + '/security');
  assert.ok(sec.html.includes('FALLBACK'), 'health card notes the fallback');
  assert.ok(sec.html.includes('TextBelt'), 'health names the effective provider');
});

test('Twilio E2E: panel Twilio credentials deliver the phone-verify code via the Twilio double', async () => {
  const page = await admin.req(AP + '/security');
  await admin.req(AP + '/security/delivery', { method: 'POST', body: {
    _csrf: admin.csrf(page.html), twilio_sid: 'ACx000000000000000000000000000001', twilio_token: 'x-twilio-token', twilio_from: '+15550009998',
  } });
  const stored = await db.get("SELECT field_value FROM global_credentials WHERE scope = 'delivery' AND field_key = 'twilio_token'");
  assert.ok(stored && String(stored.field_value).startsWith('v1:') && !String(stored.field_value).includes('x-twilio-token'), 'token stored as envelope only');
  const pid = await makePlayer('x.tw@example.com', 'Twil#12345', { phone: '+15550009202' });
  const jar = await playerLogin('x.tw@example.com', 'Twil#12345');
  const hitsBefore = smsHits.length;
  await phoneVerifySend(jar);
  const hit = smsHits.slice(hitsBefore).find(h => h.kind === 'twilio');
  assert.ok(hit, 'Twilio double received the SMS');
  assert.equal(hit.sid, 'ACx000000000000000000000000000001', 'panel SID used');
  assert.equal(hit.from, '+15550009998', 'panel From used');
  assert.ok(/verification code/i.test(hit.message), 'verify-purpose wording via Twilio');
  const code = codeFrom(hit.message);
  const prof2 = await jar.req('/profile?verify_phone=1');
  const conf = await jar.req('/profile/verify-phone/confirm', { method: 'POST', body: { _csrf: jar.csrf(prof2.html), code } });
  assert.equal(conf.status, 302);
  const u = await db.get('SELECT mobile_verified FROM users WHERE id = ?', [pid]);
  assert.equal(Number(u.mobile_verified), 1, 'phone verified via Twilio-delivered code');
  const sec = await admin.req(AP + '/security');
  assert.ok(!sec.html.includes('x-twilio-token'), 'token never rendered on the Security page');
});

test('SMS withdrawal OTP (phone-only account): "withdrawal code" wording, verify creates the withdrawal', async () => {
  const pid = await makePlayer('phone5550009203@phone.local', 'WdSmsX#123', { phone: '+15550009203' });
  await db.run("INSERT INTO wallets (user_id, currency, balance) VALUES (?, 'USD', 50000)", [pid]);
  const bank = await db.get("SELECT id FROM payment_methods WHERE slug = 'rail-bank_transfer'");
  await db.run('UPDATE payment_methods SET enabled = 1 WHERE id = ?', [bank.id]);
  const jar = await playerLogin('phone5550009203@phone.local', 'WdSmsX#123');
  const form = await jar.req('/withdraw/new');
  const hitsBefore = smsHits.length;
  const sub = await jar.req('/withdraw/new', { method: 'POST', body: { _csrf: jar.csrf(form.html), method_id: String(bank.id), amount: '20.00', custom_account_name: 'Extra Player', custom_account_number: 'GB29NWBK60161331926820', custom_bank_name: 'Player Bank' } });
  assert.equal(sub.status, 200, 'verify screen rendered');
  const hit = smsHits.slice(hitsBefore).find(h => h.kind === 'twilio' && h.to === '+15550009203');
  assert.ok(hit, 'withdrawal SMS delivered');
  assert.ok(/withdrawal code/i.test(hit.message), 'withdrawal SMS calls itself a withdrawal code');
  assert.ok(!/login code/i.test(hit.message), 'withdrawal SMS never says login code');
  const code = codeFrom(hit.message);
  const ver = await jar.req('/withdraw/verify', { method: 'POST', body: { _csrf: jar.csrf(sub.html), code } });
  assert.equal(ver.status, 302);
  const row = await db.get('SELECT * FROM withdrawals WHERE user_id = ?', [pid]);
  assert.ok(row && Number(row.amount) === 2000, 'withdrawal created after SMS verify');
});

test('lib: global credential save fails closed without CREDENTIAL_ENCRYPTION_KEY', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-delx-lib-'));
  const savedPath = process.env.SQLITE_PATH, savedKey = process.env.CREDENTIAL_ENCRYPTION_KEY;
  process.env.SQLITE_PATH = path.join(tmp, 'lib.sqlite'); process.env.DB_DRIVER = 'sqlite';
  delete require.cache[require.resolve('../lib/db')];
  const { openDB } = require('../lib/db');
  const { migrate } = require('../lib/migrations');
  const creds = require('../lib/credentials');
  const { db: libDb } = openDB();
  try {
    await migrate(libDb, 'sqlite');
    const tbl = await libDb.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'global_credentials'");
    assert.ok(tbl, 'global_credentials exists after migrate');
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    await assert.rejects(() => creds.saveGlobalCredentialField(libDb, 'delivery', 'smtp_pass', 'x'), /not configured/i, 'refuses without a key');
    process.env.CREDENTIAL_ENCRYPTION_KEY = ENC_KEY;
    await creds.saveGlobalCredentialField(libDb, 'delivery', 'smtp_pass', 'lib-secret-x');
    const loaded = await creds.loadGlobalCredentials(libDb, 'delivery');
    assert.equal(loaded.smtp_pass, 'lib-secret-x', 'round-trip works with a key');
  } finally {
    try { await libDb.close(); } catch {}
    if (savedPath === undefined) delete process.env.SQLITE_PATH; else process.env.SQLITE_PATH = savedPath;
    if (savedKey === undefined) delete process.env.CREDENTIAL_ENCRYPTION_KEY; else process.env.CREDENTIAL_ENCRYPTION_KEY = savedKey;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
