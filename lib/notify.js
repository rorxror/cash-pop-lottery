'use strict';
/* Notifications: editable Email/SMS/Push templates with {{variables}}.
   Delivery: every notification is logged to notifications_log (the outbox).
   Real delivery happens only when a provider is configured AND notifications
   are enabled; otherwise the site keeps working with graceful "not configured"
   states in the admin UI. */
const { now } = require('./util');
const { getS, getBool } = require('./settings');

function renderVars(text, vars) {
  return String(text || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) =>
    vars[k] === undefined || vars[k] === null ? '' : String(vars[k]));
}

async function getTemplate(db, channel, slug) {
  return db.get('SELECT * FROM notif_templates WHERE channel = ? AND slug = ?', [channel, slug]);
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
      if (channel === 'email') await sendEmail(settings, to, subject, body);
      else if (channel === 'sms') await sendSms(settings, to, body);
      else if (channel === 'push') await sendPush(settings, to, subject, body);
      else throw new Error('Unknown notification channel: ' + channel);
      status = 'sent';
    } catch (e) { status = 'failed'; error = e.message; }
  }
  await db.run(
    'INSERT INTO notifications_log (channel, to_addr, subject, body, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [channel, String(to || ''), subject, body, status, error, now()]
  );
  return { status, error };
}

let mailer = null;
async function sendEmail(settings, to, subject, body) {
  const host = process.env.SMTP_HOST;
  if (!host) throw new Error('SMTP not configured (see Admin > Notifications > Email)');
  if (!mailer) {
    const nodemailer = require('nodemailer');
    mailer = nodemailer.createTransport({
      host, port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: (process.env.SMTP_PORT || '587') === '465',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
  }
  /* SCAN fix (D-06): never fall back to an example.com sender (a domain
     nobody owns — replies impossible, classic scam-mail signal). Fall
     back to the SMTP account itself; if neither exists, fail honestly
     so the operator sees the misconfiguration in the outbox. */
  const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER || '';
  if (!fromAddr) throw new Error('SMTP_FROM is not configured (see .env.example) — refusing to send from an unset sender');
  await mailer.sendMail({ from: fromAddr, to, subject, text: body });
}

async function sendSms(settings, to, body) {
  /* SCAN fix (C-10): notification SMS now honours the same sms_provider
     setting as the OTP sender (lib/otp.js) — previously this path always
     used Twilio env vars and ignored the operator's provider choice. */
  const provider = process.env.SMS_PROVIDER || getS(settings || {}, 'sms_provider', '');
  if (provider === 'textbelt') {
    if (!process.env.TEXTBELT_KEY) throw new Error('SMS provider TextBelt selected but TEXTBELT_KEY is not set');
    const res = await fetch('https://textbelt.com/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: to, message: body, key: process.env.TEXTBELT_KEY }),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.success) throw new Error('SMS provider error (TextBelt): ' + (j.error || res.status));
    return;
  }
  const sid = process.env.TWILIO_SID, token = process.env.TWILIO_TOKEN, from = process.env.TWILIO_FROM;
  if (!sid || !token || !from) throw new Error('SMS provider not configured (see Admin > Notifications > SMS)');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
  });
  if (!res.ok) throw new Error('SMS provider error: ' + res.status);
}

async function sendPush(settings, to, title, body) {
  // Push provider (FCM/APNs) plugs in here when credentials are configured.
  throw new Error('Push provider not configured (see Admin > Notifications > Push)');
}

/* Send one queued batch row (cooling-period batching): delivers via the
   configured provider and UPDATES the existing outbox row instead of
   logging a second one. Used by the admin "Process due" button and the
   process_notifications cron job. */
async function sendQueued(db, settings, row) {
  const enabled = getBool(settings, 'notifications_enabled', true);
  let status = 'queued', error = '';
  if (!enabled) { status = 'skipped'; error = 'notifications off'; }
  else {
    try {
      if (row.channel === 'email') await sendEmail(settings, row.to_addr, row.subject, row.body);
      else if (row.channel === 'sms') await sendSms(settings, row.to_addr, row.body);
      else if (row.channel === 'push') await sendPush(settings, row.to_addr, row.subject, row.body);
      else throw new Error('Unknown notification channel: ' + row.channel);
      status = 'sent';
    } catch (e) { status = 'failed'; error = e.message; }
  }
  await db.run('UPDATE notifications_log SET status = ?, error = ? WHERE id = ?', [status, error, row.id]);
  return { status, error };
}

/* Ad-hoc send (admin broadcasts): raw subject/body, same try/catch + outbox logging as send(). */
async function sendRaw(db, settings, channel, to, subject, body) {
  const enabled = getBool(settings, 'notifications_enabled', true);
  let status = 'queued', error = '';
  if (!enabled) { status = 'skipped'; error = 'notifications off'; }
  else {
    try {
      if (channel === 'email') await sendEmail(settings, to, subject, body);
      else if (channel === 'sms') await sendSms(settings, to, body);
      else if (channel === 'push') await sendPush(settings, to, subject, body);
      else throw new Error('Unknown notification channel: ' + channel);
      status = 'sent';
    } catch (e) { status = 'failed'; error = e.message; }
  }
  await db.run(
    'INSERT INTO notifications_log (channel, to_addr, subject, body, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [channel, String(to || ''), subject, body, status, error, now()]
  );
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

module.exports = { send, sendRaw, sendQueued, getTemplate, renderVars, emailPrefEnabled };
