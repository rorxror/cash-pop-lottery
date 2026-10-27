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
  const site = getS(settings, 'site_name', 'Cash Pop');
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
  await mailer.sendMail({ from: process.env.SMTP_FROM || 'no-reply@example.com', to, subject, text: body });
}

async function sendSms(settings, to, body) {
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
      status = 'sent';
    } catch (e) { status = 'failed'; error = e.message; }
  }
  await db.run(
    'INSERT INTO notifications_log (channel, to_addr, subject, body, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [channel, String(to || ''), subject, body, status, error, now()]
  );
  return { status, error };
}

module.exports = { send, sendRaw, getTemplate, renderVars };
