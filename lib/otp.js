'use strict';
/* OTP login: generate 6-digit codes, send via SMS/Email, verify. */
const { sha256, randHex, now } = require('./util');
const notify = require('./notify');

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function createOtp(db, identifier, idType) {
  const code = generateCode();
  const expires = now() + 10 * 60 * 1000; // 10 minutes
  // Invalidate old codes for this identifier
  await db.run('DELETE FROM login_otps WHERE identifier = ? AND id_type = ?', [identifier, idType]);
  await db.run(
    'INSERT INTO login_otps (identifier, id_type, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)',
    [identifier, idType, sha256('otp:' + code + ':' + identifier), expires, now()]
  );
  return code;
}

async function sendOtp(db, settings, identifier, idType, code) {
  if (idType === 'phone') {
    // FREE SMS via TextBelt (no account needed, 1 SMS/day shared quota — for testing)
    // Set SMS_PROVIDER=textbelt to use it, or configure Twilio below for production
    const smsProvider = process.env.SMS_PROVIDER || '';
    if (smsProvider === 'textbelt') {
      try {
        const r = await fetch('https://textbelt.com/text', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone: identifier, message: `Your login code: ${code}. Valid for 10 minutes.`, key: process.env.TEXTBELT_KEY || 'textbelt' }),
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
        await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: identifier, From: from, Body: `Your login code: ${code}. Valid for 10 minutes.` }).toString(),
        });
        return { sent: true, via: 'sms' };
      } catch (e) { /* fall through to demo */ }
    }
    // Demo mode: return code for display (when SMS not configured)
    return { sent: false, via: 'demo', code };
  } else {
    // Email OTP via notify system
    try {
      await notify.send(db, settings, 'email', 'otp_login', identifier, { code });
      return { sent: true, via: 'email' };
    } catch (e) {
      return { sent: false, via: 'demo', code };
    }
  }
}

async function verifyOtp(db, identifier, idType, code) {
  const row = await db.get(
    'SELECT * FROM login_otps WHERE identifier = ? AND id_type = ? AND verified = 0 ORDER BY created_at DESC LIMIT 1',
    [identifier, idType]
  );
  if (!row) return { ok: false, error: 'No code found. Request a new one.' };
  if (row.expires_at < now()) return { ok: false, error: 'Code expired. Request a new one.' };
  if (row.attempts >= 5) return { ok: false, error: 'Too many attempts. Request a new code.' };
  
  await db.run('UPDATE login_otps SET attempts = attempts + 1 WHERE id = ?', [row.id]);
  
  if (sha256('otp:' + code + ':' + identifier) !== row.code_hash) {
    return { ok: false, error: 'Wrong code. Try again.' };
  }
  
  await db.run('UPDATE login_otps SET verified = 1 WHERE id = ?', [row.id]);
  return { ok: true };
}

module.exports = { generateCode, createOtp, sendOtp, verifyOtp };
