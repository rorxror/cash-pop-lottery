'use strict';
/* OTP login: generate 6-digit codes, send via SMS/Email, verify.
   SECURITY (2026-10-27 audit fixes):
   - Codes use crypto.randomInt, never Math.random.
   - NO demo mode: if no provider actually sends the code, sendOtp reports
     sent:false and the code is NEVER returned to the caller. Previously the
     code was returned in the API response whenever SMS/email was not
     configured (or a send failed), letting anyone log in as any user.
   - Brute-force caps are per-identifier and survive code re-requests:
     old codes are superseded (not deleted), so failed guesses keep counting.
     Caps: max 5 code requests / identifier / hour, max 15 failed verifies /
     identifier / hour, plus 5 attempts per single code.
   v23: phone sends go through notify.sendSmsOnce (the single delivery
   resolver — panel config first, env second); the private TextBelt/
   Twilio fetch blocks that lived here are DELETED. EVERY send attempt
   (phone AND email) writes a notifications_log row via
   notify.logAttempt with the code masked (OTP-D1). sendOtp takes a
   PURPOSE ('login' | 'withdrawal' | 'verify') so a withdrawal code
   never calls itself a login code (H1-07). */
const crypto = require('crypto');
const { sha256, now, hashCode, verifyCode } = require('./util');
const notify = require('./notify');

const MAX_REQUESTS_PER_HOUR = 5;
const MAX_FAILED_VERIFIES_PER_HOUR = 15;

const PURPOSES = ['login', 'withdrawal', 'verify'];
function normPurpose(p) { return PURPOSES.includes(p) ? p : 'login'; }
const PURPOSE_PHRASE = { login: 'login code', withdrawal: 'withdrawal code', verify: 'verification code' };

function generateCode() {
  return String(crypto.randomInt(100000, 1000000));
}

async function createOtp(db, identifier, idType) {
  // Per-identifier request cap (survives re-requests: old rows are kept).
  const recent = await db.get(
    'SELECT COUNT(*) AS c FROM login_otps WHERE identifier = ? AND id_type = ? AND created_at > ?',
    [identifier, idType, now() - 3600 * 1000]
  );
  if (recent && Number(recent.c) >= MAX_REQUESTS_PER_HOUR)
    throw new Error('Too many codes requested. Try again later.');
  const code = generateCode();
  const expires = now() + 10 * 60 * 1000; // 10 minutes
  // Supersede old codes (keep them for the failed-attempt accounting below)
  // and purge rows older than 24h for this identifier.
  await db.run('UPDATE login_otps SET verified = 2 WHERE identifier = ? AND id_type = ? AND verified = 0', [identifier, idType]);
  await db.run('DELETE FROM login_otps WHERE identifier = ? AND id_type = ? AND created_at < ?', [identifier, idType, now() - 24 * 3600 * 1000]);
  await db.run(
    'INSERT INTO login_otps (identifier, id_type, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    [identifier, idType, hashCode(code, identifier), expires, now()]
  );
  return code;
}

async function sendOtp(db, settings, identifier, idType, code, purpose = 'login') {
  const purp = normPurpose(purpose);
  if (idType === 'phone') {
    // Purpose template first (sms/otp_<purpose>), then the legacy
    // sms/otp template for login only, else a purpose-true fallback —
    // a withdrawal code must never say "login code" (H1-07).
    let smsBody = 'Your ' + PURPOSE_PHRASE[purp] + ': ' + code + '. Valid for 10 minutes.';
    try {
      let tpl = await notify.getTemplate(db, 'sms', 'otp_' + purp);
      if ((!tpl || !tpl.enabled || !tpl.body) && purp === 'login') tpl = await notify.getTemplate(db, 'sms', 'otp');
      if (tpl && tpl.enabled && tpl.body) smsBody = notify.renderVars(tpl.body, { code, minutes: 10 });
    } catch {}
    const r = await notify.sendSmsOnce(db, settings, identifier, smsBody);
    // OTP-D1: phone attempts are outbox-logged exactly like email ones,
    // with the code masked out of the stored copy.
    try {
      await notify.logAttempt(db, {
        channel: 'sms', to: identifier, subject: '', body: smsBody,
        status: r.sent ? 'sent' : 'failed', error: r.sent ? '' : (r.error || 'SMS delivery failed'),
        vars: { code },
      });
    } catch {}
    return r.sent ? { sent: true, via: 'sms' } : { sent: false, via: 'none' };
  }
  // Email OTP via the template system with the PURPOSE slug
  // (otp_login / otp_withdrawal / otp_verify). notify.send logs the
  // attempt itself (masked), and NEVER throws on delivery failure — it
  // returns { status: 'sent' | 'failed' | 'skipped' }.
  try {
    const r = await notify.send(db, settings, 'email', 'otp_' + purp, identifier, { code });
    if (r && r.status === 'sent') return { sent: true, via: 'email' };
    return { sent: false, via: 'none' };
  } catch (e) {
    return { sent: false, via: 'none' };
  }
}

/* AUTH-CHANNELS-01: when a code could NOT be delivered (provider not
   configured / provider error), the live row must die with the attempt —
   an undelivered code must never stay guessable into validity. Uses the
   same superseded marker (verified = 2) as createOtp's rotation, so the
   failed-attempt accounting is untouched. */
async function expireLiveOtps(db, identifier, idType) {
  await db.run('UPDATE login_otps SET verified = 2 WHERE identifier = ? AND id_type = ? AND verified = 0', [identifier, idType]);
}

async function verifyOtp(db, identifier, idType, code) {
  // Hourly failed-guess cap across ALL codes for this identifier (old rows
  // are superseded, not deleted, so re-requesting a code cannot reset it).
  const fails = await db.get(
    'SELECT COALESCE(SUM(attempts),0) AS f FROM login_otps WHERE identifier = ? AND id_type = ? AND created_at > ?',
    [identifier, idType, now() - 3600 * 1000]
  );
  if (fails && Number(fails.f) >= MAX_FAILED_VERIFIES_PER_HOUR)
    return { ok: false, error: 'Too many failed attempts. Try again later.' };
  const row = await db.get(
    'SELECT * FROM login_otps WHERE identifier = ? AND id_type = ? AND verified = 0 ORDER BY created_at DESC LIMIT 1',
    [identifier, idType]
  );
  if (!row) return { ok: false, error: 'No code found. Request a new one.' };
  if (row.expires_at < now()) return { ok: false, error: 'Code expired. Request a new one.' };
  if (row.attempts >= 5) return { ok: false, error: 'Too many attempts. Request a new code.' };

  // R-040: atomic attempt increment + atomic claim. The old check-then-act
  // let parallel verifies both succeed on one code and exceed the cap.
  const inc = await db.run('UPDATE login_otps SET attempts = attempts + 1 WHERE id = ? AND verified = 0 AND attempts < 5', [row.id]);
  if (inc.changes !== 1) return { ok: false, error: 'Too many attempts. Request a new code.' };

  if (!verifyCode(row.code_hash, code, identifier)) {
    return { ok: false, error: 'Wrong code. Try again.' };
  }

  const claim = await db.run('UPDATE login_otps SET verified = 1 WHERE id = ? AND verified = 0', [row.id]);
  if (claim.changes !== 1) return { ok: false, error: 'Code already used. Request a new one.' };
  return { ok: true };
}

module.exports = { generateCode, createOtp, sendOtp, verifyOtp, expireLiveOtps, hashCode, verifyCode };
