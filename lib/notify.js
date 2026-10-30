'use strict';
/* Notifications: editable Email/SMS/Push templates with {{variables}}.
   Delivery: every notification is logged to notifications_log (the outbox).
   Real delivery happens only when a provider is configured AND notifications
   are enabled; otherwise the site keeps working with graceful "not configured"
   states in the admin UI.
   v23: ALL provider credentials resolve through lib/delivery.js — the
   single resolver (panel config in Admin → Security → Delivery first,
   server environment second). Nothing here reads SMTP/Twilio/TextBelt
   env vars directly any more. */
const crypto = require('node:crypto');
const { now } = require('./util');
const { getS, getBool } = require('./settings');
const delivery = require('./delivery');

function renderVars(text, vars) {
  return String(text || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) =>
    vars[k] === undefined || vars[k] === null ? '' : String(vars[k]));
}

async function getTemplate(db, channel, slug) {
  return db.get('SELECT * FROM notif_templates WHERE channel = ? AND slug = ?', [channel, slug]);
}

/* v20 fix (outbox secret leak): the delivered message must carry the real
   secret, but the notifications_log COPY must never do so. Until now the
   rendered body was inserted verbatim, so anyone who could open the admin
   outbox could read a live login/withdrawal OTP (10-min window) — and,
   worse, a full password-reset link (raw randHex token, 1-hour window,
   stored only as a hash everywhere else) or an email-verification link
   (24-hour window) and take over the account, bypassing the hashing.
   maskForLog masks ONLY the log copy: exact vars.code / vars.link values
   when the caller supplied them, plus a generic scrub of any
   /reset/<token> or /verify-email/<token> URL segment as defence in
   depth (covers sendRaw and future templates). Non-secret content
   (names, amounts, ticket ids) is left byte-identical. */
function maskForLog(text, vars = {}) {
  let out = String(text || '');
  const code = vars && vars.code !== undefined && vars.code !== null ? String(vars.code) : '';
  if (code.length >= 4) out = out.split(code).join('******');
  const link = vars && vars.link ? String(vars.link) : '';
  if (link) {
    let masked = '[secret link removed from log]';
    try {
      const u = new URL(link);
      const seg = u.pathname.split('/').filter(Boolean);
      masked = u.origin + (seg.length ? '/' + seg[0] + '/***' : '/***');
    } catch (e) { /* keep the placeholder */ }
    out = out.split(link).join(masked);
  }
  out = out.replace(/(\/(?:reset|verify-email)\/)[A-Za-z0-9_-]+/g, '$1***');
  return out;
}

/* v23: shared outbox writer — send()/sendRaw() and the OTP sender
   (lib/otp.js, via logAttempt) all log identically, masked. */
async function logAttempt(db, { channel, to, subject = '', body = '', status, error = '', vars = {} }) {
  await db.run(
    'INSERT INTO notifications_log (channel, to_addr, subject, body, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [channel, String(to || ''), maskForLog(subject, vars), maskForLog(body, vars), status, error, now()]
  );
  return { status, error };
}

async function deliver(db, settings, channel, to, subject, body) {
  if (channel === 'email') await sendEmail(db, settings, to, subject, body);
  else if (channel === 'sms') await sendSms(db, settings, to, body);
  else if (channel === 'push') await sendPush(settings, to, subject, body);
  else throw new Error('Unknown notification channel: ' + channel);
}

async function send(db, settings, channel, slug, to, vars = {}) {
  const site = getS(settings, 'site_name', 'Cash Pop Lottery');
  const t = await getTemplate(db, channel, slug);
  const enabled = getBool(settings, 'notifications_enabled', true);
  const subject = t ? renderVars(t.subject, { ...vars, site }) : '';
  const body = t ? renderVars(t.body, { ...vars, site }) : renderVars(slug, vars);
  const active = enabled && t && t.enabled;

  let status = 'queued', error = '';
  if (!active) { status = 'skipped'; error = 'template disabled or notifications off'; }
  else {
    try {
      await deliver(db, settings, channel, to, subject, body);
      status = 'sent';
    } catch (e) { status = 'failed'; error = e.message; }
  }
  await logAttempt(db, { channel, to, subject, body, status, error, vars });
  return { status, error };
}

/* v23 (OTP-D6): the mail transport is cached BY CONFIG FINGERPRINT
   (host|port|user|pass-hash) — the old module-level mailer was built
   ONCE and never invalidated, so changing SMTP settings silently kept
   sending through the old server until a restart. A config change now
   rebuilds the transport on the next send. */
let mailerCache = null; // { fp, transport }
function mailerFor(cfg) {
  const passHash = crypto.createHash('sha256').update(String(cfg.smtp_pass || '')).digest('hex');
  const fp = [cfg.smtp_host, cfg.smtp_port, cfg.smtp_user, passHash].join('|');
  if (mailerCache && mailerCache.fp === fp) return mailerCache.transport;
  const nodemailer = require('nodemailer');
  const port = parseInt(cfg.smtp_port || '587', 10);
  const transport = nodemailer.createTransport({
    host: cfg.smtp_host, port,
    secure: port === 465,
    auth: cfg.smtp_user ? { user: cfg.smtp_user, pass: cfg.smtp_pass } : undefined,
  });
  if (mailerCache && mailerCache.transport && typeof mailerCache.transport.close === 'function') {
    try { mailerCache.transport.close(); } catch {}
  }
  mailerCache = { fp, transport };
  return transport;
}

async function sendEmail(db, settings, to, subject, body) {
  const cfg = await delivery.resolveDeliveryConfig(db, settings);
  if (!cfg.smtp_host) throw new Error('SMTP is not configured — add it in ' + delivery.DELIVERY_HOME);
  /* SCAN fix (D-06): never fall back to an example.com sender (a domain
     nobody owns — replies impossible, classic scam-mail signal). Fall
     back to the SMTP account itself; if neither exists, fail honestly
     so the operator sees the misconfiguration in the outbox. */
  const fromAddr = cfg.smtp_from || cfg.smtp_user || '';
  if (!fromAddr) throw new Error('SMTP sender (From) is not configured — add it in ' + delivery.DELIVERY_HOME);
  await mailerFor(cfg).sendMail({ from: fromAddr, to, subject, text: body });
}

/* ONE SMS attempt through the resolved EFFECTIVE provider (OTP-D3:
   selected provider if fully configured, else the other configured
   provider, else none). Never throws — returns the truth. Used by the
   template sender below and directly by lib/otp.js (sendOtp). */
async function sendSmsOnce(db, settings, to, body) {
  const cfg = await delivery.resolveDeliveryConfig(db, settings);
  const eff = cfg.effectiveProvider;
  if (eff === 'textbelt') {
    try {
      const res = await fetch(cfg.textbelt_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: to, message: body, key: cfg.textbelt_key }),
      });
      const j = await res.json().catch(() => ({}));
      if (!j.success) return { sent: false, via: 'none', error: 'SMS provider error (TextBelt): ' + (j.error || res.status) };
      return { sent: true, via: 'sms' };
    } catch (e) { return { sent: false, via: 'none', error: e.message }; }
  }
  if (eff === 'twilio') {
    try {
      const res = await fetch(`${cfg.twilio_base}/2010-04-01/Accounts/${cfg.twilio_sid}/Messages.json`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.twilio_sid}:${cfg.twilio_token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: to, From: cfg.twilio_from, Body: body }).toString(),
      });
      if (!res.ok) {
        let detail = '';
        try { const j = await res.json(); detail = j.message || j.error_message || ''; } catch {}
        return { sent: false, via: 'none', error: 'SMS provider error (Twilio): ' + res.status + (detail ? ' — ' + detail : '') };
      }
      return { sent: true, via: 'sms' };
    } catch (e) { return { sent: false, via: 'none', error: e.message }; }
  }
  return { sent: false, via: 'none', error: 'SMS is not configured — add it in ' + delivery.DELIVERY_HOME };
}

async function sendSms(db, settings, to, body) {
  const r = await sendSmsOnce(db, settings, to, body);
  if (!r.sent) throw new Error(r.error || 'SMS delivery failed');
}

async function sendPush(settings, to, title, body) {
  // No push provider (FCM/APNs) is integrated — say so plainly (OTP-D7).
  throw new Error('Push notifications are not integrated — no push provider is configured, so nothing was sent.');
}

/* Send one queued batch row (cooling-period batching): delivers via the
   configured provider and UPDATES the existing outbox row instead of
   logging a second one. Used by the admin "Process due" button and the
   process_notifications cron job. */
/* D3-C4 (v20): queued batches get BOUNDED retries. MAX_ATTEMPTS is 3
   delivery attempts per queued row; a failed attempt re-queues the row
   with a 60-second backoff (scheduled_at), and the 3rd failure is
   terminal 'failed' with the attempt count in the error. Rows that
   come due while notifications are OFF are NOT consumed at all: the
   row is left untouched (still 'queued', still due, no attempt spent)
   and the caller is told the outcome was 'deferred'. */
const MAX_QUEUED_ATTEMPTS = 3;
const QUEUED_RETRY_DELAY_MS = 60000;
async function sendQueued(db, settings, row) {
  const enabled = getBool(settings, 'notifications_enabled', true);
  if (!enabled) return { status: 'deferred', error: 'notifications off' };
  const attempts = (Number(row.attempts) || 0) + 1;
  let error = '';
  try {
    await deliver(db, settings, row.channel, row.to_addr, row.subject, row.body);
    try { await db.run('UPDATE notifications_log SET status = ?, error = ?, attempts = ? WHERE id = ?', ['sent', '', attempts, row.id]); }
    catch (e) { if (!/attempts/i.test(e.message)) throw e; await db.run('UPDATE notifications_log SET status = ?, error = ? WHERE id = ?', ['sent', '', row.id]); }
    return { status: 'sent', error: '', attempts };
  } catch (e) { error = e.message; }
  const terminal = attempts >= MAX_QUEUED_ATTEMPTS;
  const finalError = terminal ? (error + ' (attempts exhausted: ' + attempts + '/' + MAX_QUEUED_ATTEMPTS + ')') : error;
  try {
    if (terminal) await db.run('UPDATE notifications_log SET status = ?, error = ?, attempts = ? WHERE id = ?', ['failed', finalError, attempts, row.id]);
    else await db.run('UPDATE notifications_log SET status = ?, error = ?, attempts = ?, scheduled_at = ? WHERE id = ?', ['queued', finalError, attempts, now() + QUEUED_RETRY_DELAY_MS, row.id]);
  } catch (e2) {
    if (!/attempts|scheduled_at/i.test(e2.message)) throw e2;
    await db.run('UPDATE notifications_log SET status = ?, error = ? WHERE id = ?', [terminal ? 'failed' : 'queued', finalError, row.id]);
  }
  return { status: terminal ? 'failed' : 'queued', error: finalError, attempts, retrying: !terminal };
}

/* Ad-hoc send (admin broadcasts): raw subject/body, same try/catch + outbox logging as send(). */
async function sendRaw(db, settings, channel, to, subject, body) {
  const enabled = getBool(settings, 'notifications_enabled', true);
  let status = 'queued', error = '';
  if (!enabled) { status = 'skipped'; error = 'notifications off'; }
  else {
    try {
      await deliver(db, settings, channel, to, subject, body);
      status = 'sent';
    } catch (e) { status = 'failed'; error = e.message; }
  }
  await logAttempt(db, { channel, to, subject, body, status, error });
  return { status, error };
}

/* BP-13 (v19): per-player email notification preferences. The users table
   carries notify_win_email / notify_support_email (migration v16, default
   1 = on). These are the only two topics with player-facing email paths
   (announcements are in-app only — no email path exists to gate). The
   check gates the EMAIL send at each call site; SMS/push are untouched.
   A missing user or column fails OPEN (send): a preference lookup problem
   must never silently drop a player's win mail. */
const EMAIL_PREF_COLUMNS = { win: 'notify_win_email', support_reply: 'notify_support_email' };
async function emailPrefEnabled(db, userId, slug) {
  const col = EMAIL_PREF_COLUMNS[slug];
  if (!col || !userId) return true;
  try {
    const u = await db.get('SELECT ' + col + ' AS v FROM users WHERE id = ?', [userId]);
    if (!u || u.v === null || u.v === undefined) return true;
    return Number(u.v) !== 0;
  } catch (e) { return true; }
}

module.exports = { send, sendRaw, sendQueued, sendSmsOnce, logAttempt, getTemplate, renderVars, emailPrefEnabled, maskForLog, MAX_QUEUED_ATTEMPTS, QUEUED_RETRY_DELAY_MS };
