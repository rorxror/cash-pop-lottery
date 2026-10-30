'use strict';
/* v23 DELIVERY — admin-panel-configurable SMTP/SMS credentials proven
   end-to-end with provider doubles (no real external services):
   - Server A boots with NO working delivery env (SMTP env points at a
     DEAD port). The owner path is then exercised exactly as the owner
     will do it: log into the panel, save delivery details in
     Admin → Security → Delivery, and watch real OTP flows deliver.
   - Panel values must beat env values (precedence), secrets must be
     stored as AES-GCM envelopes, never rendered back, and appear in
     the audit trail as field NAMES only.
   - Phone OTP attempts must land in notifications_log (OTP-D1) with
     the code masked; OTP wording must match its purpose (H1-07).
   - Server B boots with NOTHING configured: the withdrawal-OTP
     warning banner shows where the operator works (H4-02), OTP sends
     fail honestly with no live code left behind, and the admin-self
     email change does NOT apply on delivery failure (OTP-D4). */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const AP = '/ops-7f3a9c-console';
const ENC_KEY = 'b6'.repeat(32); // exactly 64 hex chars = 32 bytes
process.env.CREDENTIAL_ENCRYPTION_KEY = ENC_KEY; // the unit-level test saves panel secrets in-process
const PANEL_SMTP_PASS = 'PanelSecret#SMTP-9911';
const PANEL_TB_KEY = 'panel-textbelt-key-7712';

class Jar {
  constructor(base) { this.base = base; this.m = new Map(); }
  absorb(h) { const sc = h.getSetCookie ? h.getSetCookie() : []; for (const c of sc) { const p = c.split(';')[0]; const i = p.indexOf('='); if (i > 0) { const k = p.slice(0, i).trim(), v = p.slice(i + 1).trim(); if (v) this.m.set(k, v); else this.m.delete(k); } } }
  header() { return [...this.m.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(p, { method = 'GET', body } = {}) {
    const r = await fetch(this.base + p, { method, redirect: 'manual', headers: { cookie: this.header(), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: body ? new URLSearchParams(body).toString() : undefined });
    this.absorb(r.headers); return { status: r.status, loc: r.headers.get('location') || '', html: await r.text() };
  }
  csrf(html) { const m = html.match(/name="_csrf" value="([^"]+)"/); assert.ok(m, 'csrf present'); return m[1]; }
}

function codeFrom(text) { const m = String(text).match(/code is[:\s]*([0-9]{6})/i) || String(text).match(/\b([0-9]{6})\b/); assert.ok(m, 'a 6-digit code is present in: ' + String(text).slice(0, 200)); return m[1]; }

function smtpCapture(mails) {
  const srv = net.createServer(sock => {
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
  return srv;
}

async function boot({ port, dbp, env, stubFile }) {
  const childEnv = { ...process.env, PORT: String(port), BASE_URL: `http://127.0.0.1:${port}`, DB_DRIVER: 'sqlite', SQLITE_PATH: dbp,
    TICKET_HMAC_SECRET: ['delivery', 'test', 'hmac'].join('-'),
    CREDENTIAL_ENCRYPTION_KEY: ENC_KEY,
    ADMIN_SEED_EMAIL: 'del-admin@example.com', ADMIN_SEED_PASSWORD: 'DelAdminPass-2026', ADMIN_SEED_NAME: 'Del Admin',
    ...env };
  delete childEnv.DATABASE_URL;
  const server = spawn('node', ['server.js'], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[delivery server] ' + d));
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); ok = r.status === 200; } catch {} if (!ok) await new Promise(r => setTimeout(r, 500)); }
  assert.ok(ok, 'server boots on ' + port);
  return server;
}

async function adminLogin(base) {
  const jar = new Jar(base);
  const g = await jar.req(AP);
  await jar.req(AP + '/login', { method: 'POST', body: { _csrf: jar.csrf(g.html), email: 'del-admin@example.com', password: 'DelAdminPass-2026' } });
  return jar;
}

function openDb(dbp) {
  process.env.SQLITE_PATH = dbp; process.env.DB_DRIVER = 'sqlite';
  delete require.cache[require.resolve('../lib/db')];
  return require('../lib/db').openDB().db;
}

/* ---------------- Server A: panel-configured delivery ---------------- */
const PORT_A = 4251, BASE_A = `http://127.0.0.1:${PORT_A}`;
const DBP_A = `/tmp/cp-del-a-${process.pid}.sqlite`;
const SMSOUT_A = `/tmp/cp-del-sms-a-${process.pid}.log`;
const STUB_A = `/tmp/cp-del-stub-a-${process.pid}.js`;
let serverA, dbA, smtpA, adminA;
const mailsA = [];

before(async () => {
  fs.writeFileSync(STUB_A, `
const fs = require('fs');
const realFetch = globalThis.fetch;
function json(obj, status = 200) { return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } }); }
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://textbelt.com/')) {
    let body = {}; try { body = JSON.parse(opts.body || '{}'); } catch {}
    fs.appendFileSync(process.env.STUB_SMS_OUT, JSON.stringify(body) + '\\n');
    return json({ success: true, textId: 'tb-del-1' });
  }
  return realFetch(url, opts);
};`);
  smtpA = smtpCapture(mailsA);
  await new Promise(r => smtpA.listen(0, '127.0.0.1', r));
  const smtpPort = smtpA.address().port;
  serverA = await boot({ port: PORT_A, dbp: DBP_A, stubFile: STUB_A, env: {
    // Env SMTP is DEAD on purpose (port 9 = discard): if delivery works
    // at all, it works because the PANEL values won.
    SMTP_HOST: '127.0.0.1', SMTP_PORT: '9', SMTP_FROM: 'Env Sender <env@cashpop.example>',
    SMS_PROVIDER: 'textbelt',
    NODE_OPTIONS: '--require ' + STUB_A, STUB_SMS_OUT: SMSOUT_A,
    __SMTP_CAPTURE_PORT: String(smtpPort),
  } });
  serverA.__smtpPort = smtpPort;
  dbA = openDb(DBP_A);
  for (const [k, v] of [['email_otp_enabled', '1'], ['phone_otp_enabled', '1'], ['withdrawal_turnover_required', '0']])
    await dbA.run('UPDATE settings SET value = ? WHERE key = ?', [v, k]);
  await new Promise(r => setTimeout(r, 5200)); // settings cache TTL
  adminA = await adminLogin(BASE_A);
});
after(() => { if (serverA) serverA.kill(); if (smtpA) smtpA.close(); });

async function makePlayerA(email, password, extra = {}) {
  const { hashPassword } = require('../lib/util');
  const ins = await dbA.run("INSERT INTO users (name, email, phone, password_hash, role, status, email_verified, created_at) VALUES (?, ?, ?, ?, 'player', 'active', 1, ?)",
    [extra.name || 'Delivery Player', email, extra.phone || '', await hashPassword(password), Date.now()]);
  return ins.id;
}

test('A1: panel save stores secrets as envelopes, never renders them back, audits field names only', async () => {
  const sec = await adminA.req(AP + '/security');
  assert.equal(sec.status, 200);
  assert.ok(sec.html.includes('Delivery (SMTP &amp; SMS)') || sec.html.includes('Delivery (SMTP & SMS)'), 'delivery section present');
  const r = await adminA.req(AP + '/security/delivery', { method: 'POST', body: {
    _csrf: adminA.csrf(sec.html),
    smtp_host: '127.0.0.1', smtp_port: String(serverA.__smtpPort), smtp_user: 'owner@gmail.com',
    smtp_pass: PANEL_SMTP_PASS, smtp_from: 'Cash Pop <owner@gmail.com>',
    twilio_sid: '', twilio_from: '', twilio_token: '', textbelt_key: PANEL_TB_KEY,
  } });
  assert.equal(r.status, 302, 'save redirects');
  const row = await dbA.get("SELECT * FROM global_credentials WHERE scope = 'delivery' AND field_key = 'smtp_pass'");
  assert.ok(row, 'smtp_pass stored');
  assert.equal(Number(row.field_enc), 1, 'stored encrypted');
  assert.ok(String(row.field_value).startsWith('v1:'), 'stored as AES-GCM envelope');
  assert.ok(!String(row.field_value).includes(PANEL_SMTP_PASS), 'plaintext secret is NOT in the DB');
  const tb = await dbA.get("SELECT * FROM global_credentials WHERE scope = 'delivery' AND field_key = 'textbelt_key'");
  assert.ok(tb && String(tb.field_value).startsWith('v1:'), 'textbelt key stored as envelope');
  const sec2 = await adminA.req(AP + '/security');
  assert.ok(!sec2.html.includes(PANEL_SMTP_PASS) && !sec2.html.includes(PANEL_TB_KEY), 'secrets never rendered back into the panel');
  assert.ok(sec2.html.includes('Email (SMTP)') && sec2.html.includes('CONFIGURED'), 'health now reports the email channel configured');
  const auditRow = await dbA.get("SELECT detail FROM audit_log WHERE action = 'delivery.config_update' ORDER BY id DESC LIMIT 1");
  assert.ok(auditRow, 'delivery save audit-logged');
  assert.ok(String(auditRow.detail).includes('smtp_pass'), 'audit names the changed field');
  assert.ok(!String(auditRow.detail).includes(PANEL_SMTP_PASS), 'audit detail contains NO secret value');
});

test('A2: panel-configured email beats the dead env — test send + login OTP deliver', async () => {
  const sec = await adminA.req(AP + '/security');
  const before = mailsA.length;
  const t = await adminA.req(AP + '/security/test-email', { method: 'POST', body: { _csrf: adminA.csrf(sec.html), to: 'owner-test@example.com' } });
  const fol = await adminA.req(t.loc);
  assert.ok(fol.html.includes('Test email sent'), 'test email sent via PANEL smtp (env pointed at a dead port)');
  assert.ok(mailsA.length > before, 'test email arrived at the capture server');

  const pid = await makePlayerA('del.otp@example.com', 'DelOtpPass#123');
  const jar = new Jar(BASE_A);
  const lp = await jar.req('/login');
  const csrf = jar.csrf(lp.html);
  const beforeOtp = mailsA.length;
  const r = await jar.req('/login/otp/request', { method: 'POST', body: { _csrf: csrf, identifier: 'del.otp@example.com', type: 'email' } });
  assert.equal(r.status, 200);
  assert.ok(JSON.parse(r.html).ok, 'OTP request accepted');
  assert.ok(mailsA.length > beforeOtp, 'login OTP email delivered via panel config');
  const code = codeFrom(mailsA[mailsA.length - 1]);
  const v = await jar.req('/login/otp/verify', { method: 'POST', body: { _csrf: csrf, identifier: 'del.otp@example.com', type: 'email', code } });
  assert.ok(v.status === 200 || v.status === 302, 'OTP verify completes the login');
  void pid;
});

test('A3: panel-configured SMS (TextBelt) delivers the phone-verify code; attempt is outbox-logged masked (OTP-D1)', async () => {
  const pid = await makePlayerA('del.phone@example.com', 'DelPhonePass#123', { phone: '+15557650999' });
  const jar = new Jar(BASE_A);
  const lp = await jar.req('/login');
  await jar.req('/login', { method: 'POST', body: { _csrf: jar.csrf(lp.html), email: 'del.phone@example.com', password: 'DelPhonePass#123' } });
  const prof = await jar.req('/profile');
  const send = await jar.req('/profile/verify-phone', { method: 'POST', body: { _csrf: jar.csrf(prof.html) } });
  assert.equal(send.status, 302);
  const lines = fs.readFileSync(SMSOUT_A, 'utf8').trim().split('\n');
  const lastSms = JSON.parse(lines[lines.length - 1]);
  assert.equal(lastSms.key, PANEL_TB_KEY, 'the PANEL TextBelt key was used (not env — env has none)');
  assert.ok(String(lastSms.message).includes('verification code'), 'SMS wording matches its purpose (verify, not login)');
  assert.ok(!String(lastSms.message).includes('login code'), 'SMS does not call itself a login code');
  const code = codeFrom(lastSms.message);
  const log = await dbA.get("SELECT * FROM notifications_log WHERE channel = 'sms' AND to_addr = '+15557650999' ORDER BY id DESC LIMIT 1");
  assert.ok(log, 'phone OTP attempt is in the outbox (OTP-D1 fixed)');
  assert.equal(log.status, 'sent');
  assert.ok(!String(log.body).includes(code), 'outbox copy masks the code');
  const prof2 = await jar.req('/profile?verify_phone=1');
  const conf = await jar.req('/profile/verify-phone/confirm', { method: 'POST', body: { _csrf: jar.csrf(prof2.html), code } });
  assert.equal(conf.status, 302);
  const u = await dbA.get('SELECT mobile_verified FROM users WHERE id = ?', [pid]);
  assert.equal(Number(u.mobile_verified), 1, 'phone marked verified');
});

test('A4: withdrawal OTP (panel email) — code says "withdrawal", verify creates the withdrawal', async () => {
  const pid = await makePlayerA('del.wd@example.com', 'DelWdPass#12345');
  await dbA.run("INSERT INTO wallets (user_id, currency, balance) VALUES (?, 'USD', 50000)", [pid]).catch(async () => {
    await dbA.run("INSERT INTO wallets (user_id, currency, balance, created_at, updated_at) VALUES (?, 'USD', 50000, ?, ?)", [pid, Date.now(), Date.now()]);
  });
  const bank = await dbA.get("SELECT id FROM payment_methods WHERE slug = 'rail-bank_transfer'");
  await dbA.run('UPDATE payment_methods SET enabled = 1 WHERE id = ?', [bank.id]);
  const jar = new Jar(BASE_A);
  const lp = await jar.req('/login');
  await jar.req('/login', { method: 'POST', body: { _csrf: jar.csrf(lp.html), email: 'del.wd@example.com', password: 'DelWdPass#12345' } });
  const form = await jar.req('/withdraw/new');
  const before = mailsA.length;
  const sub = await jar.req('/withdraw/new', { method: 'POST', body: { _csrf: jar.csrf(form.html), method_id: String(bank.id), amount: '20.00', custom_account_name: 'Delivery Player', custom_account_number: 'GB29NWBK60161331926820', custom_bank_name: 'Player Bank' } });
  assert.equal(sub.status, 200, 'verify screen rendered');
  assert.ok(mailsA.length > before, 'withdrawal code delivered');
  const mail = mailsA[mailsA.length - 1];
  assert.ok(/withdrawal code/i.test(mail), 'withdrawal email calls itself a withdrawal code (H1-07)');
  assert.ok(!/login code/i.test(mail), 'withdrawal email does not say login code');
  const code = codeFrom(mail);
  const ver = await jar.req('/withdraw/verify', { method: 'POST', body: { _csrf: jar.csrf(sub.html), code } });
  assert.equal(ver.status, 302);
  const row = await dbA.get('SELECT * FROM withdrawals WHERE user_id = ?', [pid]);
  assert.ok(row, 'withdrawal created after OTP verify');
  assert.equal(row.amount, 2000, 'exact amount held');
});

test('A5: resolver precedence at the unit level — panel beats env, env is the fallback', async () => {
  const delivery = require('../lib/delivery');
  const { saveGlobalCredentialField } = require('../lib/credentials');
  const settings = { delivery_smtp_host: 'panel-host.example', sms_provider: 'textbelt' };
  process.env.SMTP_HOST = 'env-host.example';
  await saveGlobalCredentialField(dbA, 'delivery', 'textbelt_key', 'unit-panel-key');
  delivery.invalidate();
  const cfg = await delivery.resolveDeliveryConfig(dbA, settings);
  assert.equal(cfg.smtp_host, 'panel-host.example', 'panel host wins over env host');
  assert.equal(cfg.textbelt_key, 'unit-panel-key', 'panel secret wins');
  assert.equal(cfg.effectiveProvider, 'textbelt');
  assert.ok(delivery.smsConfigured(cfg));
  const cfg2 = await delivery.resolveDeliveryConfig(dbA, settings);
  assert.equal(cfg2.smtp_host, 'panel-host.example', 'panel setting persists while env also set');
  delete process.env.SMTP_HOST;
  delivery.invalidate();
  const cfg3 = await delivery.resolveDeliveryConfig(dbA, { sms_provider: 'textbelt' });
  assert.equal(cfg3.smtp_host, '', 'no panel, no env → empty (not configured), never invented');
});

/* ---------------- Server B: nothing configured ---------------- */
const PORT_B = 4252, BASE_B = `http://127.0.0.1:${PORT_B}`;
const DBP_B = `/tmp/cp-del-b-${process.pid}.sqlite`;
let serverB, dbB, adminB;

test('B1: unconfigured boot — warning banners, honest OTP failure, OTP-D4 holds', async () => {
  serverB = await boot({ port: PORT_B, dbp: DBP_B, env: {} });
  dbB = openDb(DBP_B);
  adminB = await adminLogin(BASE_B);

  const settings = await adminB.req(AP + '/settings');
  assert.ok(settings.html.includes('Withdrawal OTP is ON but no delivery channel is configured'), 'H4-02 banner on the Settings page');
  const wds = await adminB.req(AP + '/withdrawals');
  assert.ok(wds.html.includes('Withdrawal OTP is ON but no delivery channel is configured'), 'H4-02 banner on the Withdrawals page');
  const sec = await adminB.req(AP + '/security');
  assert.ok(sec.html.includes('NOT CONFIGURED'), 'health card honest on a virgin boot');
  assert.ok(sec.html.includes('Delivery (SMTP &amp; SMS)') || sec.html.includes('Delivery (SMTP & SMS)'), 'delivery section exists to fix it');

  // OTP-D4: admin-self email change with NO delivery — must NOT apply.
  const ma = await adminB.req(AP + '/my-account');
  const ch = await adminB.req(AP + '/my-account/email', { method: 'POST', body: { _csrf: adminB.csrf(ma.html), current_password: 'DelAdminPass-2026', new_email: 'new-admin@example.com' } });
  assert.equal(ch.status, 302);
  const fol = await adminB.req(ch.loc);
  assert.ok(fol.html.includes('could not be sent'), 'honest failure flash');
  assert.ok(fol.html.includes('/verify-email/'), 'the pending link is surfaced to the admin himself');
  const me = await dbB.get("SELECT email FROM users WHERE email = 'del-admin@example.com'");
  assert.ok(me, 'admin email UNCHANGED after failed delivery (OTP-D4)');
  const pend = await dbB.get("SELECT * FROM email_verifications WHERE new_email = 'new-admin@example.com' AND used = 0");
  assert.ok(pend, 'pending verification kept, not burned');

  // Player OTP on an unconfigured boot: honest failure, no live code.
  const { hashPassword } = require('../lib/util');
  const ins = await dbB.run("INSERT INTO users (name, email, phone, password_hash, role, status, email_verified, created_at) VALUES ('B Player', 'b.player@example.com', '+15557650111', ?, 'player', 'active', 1, ?)", [await hashPassword('BPlayerPass#123'), Date.now()]);
  const jar = new Jar(BASE_B);
  const lp = await jar.req('/login');
  await jar.req('/login', { method: 'POST', body: { _csrf: jar.csrf(lp.html), email: 'b.player@example.com', password: 'BPlayerPass#123' } });
  const prof = await jar.req('/profile');
  const send = await jar.req('/profile/verify-phone', { method: 'POST', body: { _csrf: jar.csrf(prof.html) } });
  const fol2 = await jar.req(send.loc);
  assert.ok(fol2.html.includes('Could not send the verification code'), 'player told honestly that the code could not be sent');
  const live = await dbB.get("SELECT COUNT(*) AS c FROM login_otps WHERE identifier = '+15557650111' AND verified = 0");
  assert.equal(Number(live.c), 0, 'no live (guessable) code left behind');
  const log = await dbB.get("SELECT * FROM notifications_log WHERE channel = 'sms' AND to_addr = '+15557650111' ORDER BY id DESC LIMIT 1");
  assert.ok(log && log.status === 'failed', 'the failed attempt is visible in the outbox');
  void ins;
  serverB.kill();
});
