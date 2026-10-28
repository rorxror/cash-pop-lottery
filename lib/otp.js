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
     identifier / hour, plus 5 attempts per single code. */
const crypto = require('crypto');
const { getS } = require('./settings');
const { sha256, now, hashCode, verifyCode } = require('./util');
const notify = require('./notify');

const MAX_REQUESTS_PER_HOUR = 5;
const MAX_FAILED_VERIFIES_PER_HOUR = 15;

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

async function sendOtp(db, settings, identifier, idType, code) {
  if (idType === 'phone') {
    // FREE SMS via TextBelt (no account needed, 1 SMS/day shared quota — for testing)
    // Set SMS_PROVIDER=textbelt to use it, or configure Twilio below for production
    // R-045: the sms_provider SETTING is the source of truth; the env var
    // only overrides it (previously the setting was seeded but never read).
    const smsProvider = process.env.SMS_PROVIDER || getS(settings || {}, 'sms_provider', '');
    if (smsProvider === 'textbelt') {
      // R-035: no public shared key fallback — without an explicit key,
      // TextBelt is refused (its 1 SMS/day shared quota is exhausted).
      if (!process.env.TEXTBELT_KEY) return { sent: false, via: 'none' };
      try {
        const r = await fetch('https://textbelt.com/text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: identifier, message: `Your login code: ${code}. Valid for 10 minutes.`, key: process.env.TEXTBELT_KEY }),
        });
        const j = await r.json();
        if (j.success) return { sent: true, via: 'sms-free' };
      } catch (e) { /* fall through */ }
    }
    // SMS via Twilio (if configured)
    const sid = process.env.TWILIO_SID, token = process.env.TWILIO_TOKEN, from = process.env.TWILIO_FROM;
    if (sid && token && from) {
      try {
        const auth = Buffer.from(sid + ':' + token).toString('base64');
        // R-034: Twilio must be CHECKED — the old code returned sent:true
        // even when Twilio rejected the send.
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: identifier, From: from, Body: `Your login code: ${code}. Valid for 10 minutes.` }).toString(),
        });
        if (!r.ok) return { sent: false, via: 'none' };
        const tj = await r.json().catch(() => ({}));
        if (!tj.sid) return { sent: false, via: 'none' };
        return { sent: true, via: 'sms' };
      } catch (e) { /* fall through to not-sent */ }
    }
    // No provider sent the code: NEVER return it. The caller must show a
    // "could not send" error instead of logging anyone in.
    return { sent: false, via: 'none' };
  } else {
    // Email OTP via notify system. notify.send NEVER throws on failure — it
    // returns { status: 'sent' | 'failed' | 'skipped' }. The old code ignored
    // the status and reported sent:true even when nothing was delivered.
    try {
      const r = await notify.send(db, settings, 'email', 'otp_login', identifier, { code });
      if (r && r.status === 'sent') return { sent: true, via: 'email' };
      return { sent: false, via: 'none' };
    } catch (e) {
      return { sent: false, via: 'none' };
    }
  }
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

module.exports = { generateCode, createOtp, sendOtp, verifyOtp, hashCode, verifyCode };
