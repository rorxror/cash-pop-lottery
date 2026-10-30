'use strict';
/* Shared utilities: crypto, money, validation, formatting. No dependencies. */
const crypto = require('node:crypto');

const now = () => Date.now();

function randHex(n = 16) { return crypto.randomBytes(n).toString('hex'); }
function randInt(min, max) { return crypto.randomInt(min, max + 1); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function hmac(secret, data) { return crypto.createHmac('sha256', secret).update(String(data)).digest('hex'); }

/* ---- Password hashing: scrypt (stdlib). Format: scrypt$v1$saltHex$hashHex ---- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$v1$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  try {
    const parts = String(stored).split('$');
    if (parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[2], 'hex');
    const expected = Buffer.from(parts[3], 'hex');
    const actual = crypto.scryptSync(String(password), salt, 64);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}

/* ---- Money: integer minor units everywhere. ---- */
function decimalsFor(code, currencies) {
  const c = (currencies || []).find(x => x.code === code);
  const d = c && c.decimals !== undefined && c.decimals !== null ? Number(c.decimals) : 2;
  return Number.isInteger(d) && d >= 0 && d <= 8 ? d : 2;
}
function toMinor(amountStr, decimals = 2) {
  // "12.50" -> 1250. Returns null on invalid.
  // R-026: a European decimal comma (12,50) must NEVER be silently read as
  // a thousands separator (old code stripped all commas -> 100x misparse).
  // Only a valid US thousands grouping (1,000.50) keeps its commas.
  if (amountStr === undefined || amountStr === null) return null;
  let s = String(amountStr).trim();
  if (s.includes(',')) {
    if (!/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s)) return null;
    s = s.replace(/,/g, '');
  }
  const dec = Number.isInteger(decimals) && decimals >= 0 && decimals <= 8 ? decimals : 2;
  const scale = 10 ** dec;
  if (dec === 0) {
    if (!/^\d+$/.test(s)) return null;
    const minor0 = parseInt(s, 10);
    if (!Number.isSafeInteger(minor0)) return null;
    return minor0;
  }
  if (!new RegExp('^\\d+(\\.\\d{1,' + dec + '})?$').test(s)) return null;
  const [w, d = ''] = s.split('.');
  const minor = parseInt(w, 10) * scale + parseInt((d + '0'.repeat(dec)).slice(0, dec), 10);
  // v16: absurd magnitudes lose integer precision above 2^53 (e.g. a 16-digit
  // dollar figure silently rounds). Reject instead of storing a wrong amount.
  if (!Number.isSafeInteger(minor)) return null;
  return minor;
}

/* Ticket integrity: HMAC over the stored ticket fields, computed at buy time
   (routes/player.js) and VERIFIED at settle time (lib/draws.js). A ticket whose
   stored fields were tampered with after purchase fails settlement loudly
   instead of paying out on altered pops/wager/total. Legacy tickets without
   an hmac are skipped by the verifier (fail-open only for pre-HMAC rows). */
function signTicket(secret, t) {
  return hmac(secret, [t.public_id, t.user_id, t.pops, t.wager, t.draw_ids, t.total, t.currency].join('|'));
}
function fromMinor(minor, decimals = 2) {
  const dec = Number.isInteger(decimals) && decimals >= 0 ? decimals : 2;
  return (Number(minor) / (10 ** dec)).toFixed(dec);
}

/* currencies: [{code,symbol,rate}] rate = units of currency per 1 base unit */
function fmtMoney(minor, code, currencies) {
  const c = (currencies || []).find(x => x.code === code) || { symbol: code + ' ' };
  const dec = decimalsFor(code, currencies);
  const neg = Number(minor) < 0;
  const abs = Math.abs(Number(minor));
  const str = (abs / (10 ** dec)).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return (neg ? '-' : '') + (c.symbol || (code + ' ')) + str;
}
function convertMinor(minor, fromCode, toCode, currencies) {
  // R-079: dead code that used to FAIL OPEN (unknown/zero rate -> 1:1).
  // It now throws on any unusable input so no future caller can silently
  // mis-convert; there are still zero callers in the shipped code.
  const list = currencies || [];
  const f = list.find(x => x.code === fromCode);
  const t = list.find(x => x.code === toCode);
  if (!Number.isFinite(Number(minor))) throw new Error('convertMinor: non-finite amount');
  if (!f || !t || !Number.isFinite(Number(f.rate)) || !Number.isFinite(Number(t.rate)) || Number(f.rate) === 0 || Number(t.rate) === 0)
    throw new Error('convertMinor: unknown or zero currency rate');
  /* H2-01 (v23): minor units are only comparable after DECIMAL-SCALE
     adjustment — 1 JPY minor is 1 yen, 1 USD minor is 1 cent. The old
     rate-only formula credited $10 as ¥150,000 (100x mint) and paid
     ¥10,000 out as $0.66. Scale by 10^(decTo - decFrom). */
  const scale = 10 ** (decimalsFor(toCode, list) - decimalsFor(fromCode, list));
  return Math.round(Number(minor) * (Number(t.rate) / Number(f.rate)) * scale);
}

/* ---- Validation ---- */
function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || '').trim()); }
/* Canonical identifiers — the same person must not get a second account by
   retyping their email/phone in a different spelling or format. Emails are
   lowercased + trimmed; phones are reduced to digits with one leading '+'
   (spaces, dashes, brackets stripped). Passwords are deliberately NOT part
   of uniqueness: two different people may freely choose the same password. */
function normalizeEmail(e) { return String(e || '').trim().toLowerCase(); }
function normalizePhone(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  let digits = s.replace(/\D/g, '');
  if (!digits) return '';
  // R-032: international prefixes collapse to '+': 00... -> +..., and the
  // NANP international prefix 011... -> +... (011 + country code).
  if (s.startsWith('00')) return '+' + digits.slice(2);
  if (s.startsWith('011') && digits.length > 3) return '+' + digits.slice(3);
  if (s.startsWith('+')) {
    // Trunk 0: +44 07700... -> +447700... Strip one leading 0 after a
    // known country dial code (never for NANP '1' / '7' groups, where a
    // leading 0 is not a trunk prefix in the same sense).
    try {
      const { COUNTRIES } = require('./phone-countries');
      const matches = COUNTRIES.filter(c => digits.startsWith(c.dial) && c.dial !== '1' && c.dial !== '7');
      if (matches.length) {
        const longest = Math.max(...matches.map(c => c.dial.length));
        const rest = digits.slice(longest);
        if (rest.startsWith('0') && rest.length > 1) digits = digits.slice(0, longest) + rest.slice(1);
      }
    } catch {}
    return '+' + digits;
  }
  return digits;
}
// Slow-KDF code hashes (R-093/R-028): OTP/signup codes were unsalted fast
// SHA-256 (6-digit space brute-forceable offline). New hashes are scrypt
// with a random salt; verifyCode still accepts legacy sha256 rows so codes
// issued just before upgrade remain usable until they expire.
function hashCode(code, identifier = '') {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(code) + ':' + String(identifier), salt, 64);
  return `scrypt$v1$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyCode(stored, code, identifier = '') {
  try {
    const parts = String(stored || '').split('$');
    if (parts[0] === 'scrypt') {
      const salt = Buffer.from(parts[2], 'hex');
      const expected = Buffer.from(parts[3], 'hex');
      const actual = crypto.scryptSync(String(code) + ':' + String(identifier), salt, 64);
      return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    }
    return stored === sha256('otp:' + String(code) + ':' + String(identifier)) || stored === sha256('otp:' + String(code));
  } catch { return false; }
}
function validSlug(s) { return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(s || '')); }
function strongPassword(pw, enabled) {
  if (!enabled) return String(pw || '').length >= 8 ? null : 'Password must be at least 8 characters.';
  if (String(pw || '').length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password needs upper, lower case and a number.';
  return null;
}

/* ---- HTML escaping (EJS <%= %> already escapes; this is for programmatic HTML) ---- */
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* Parse a "1,2,5,10" (major units) setting into minor-unit ints */
function parseAmountList(str, fallback) {
  const out = String(str || '').split(',').map(x => toMinor(x.trim())).filter(x => x !== null && x > 0);
  return out.length ? [...new Set(out)].sort((a, b) => a - b) : fallback;
}

function shortHash(h, n = 10) { return String(h || '').slice(0, n); }

/* H3-02 (v23): the base for links that LEAVE the site inside an email
   (password reset, email verification). A forged Host header on the
   request that triggers the email must never steer a victim to a
   lookalike domain, so in production BASE_URL is REQUIRED for these
   links: unset returns null and the caller fails closed (no link is
   emailed; the callers' existing delivery-truth handling burns the
   token). Outside production the request-host fallback stays for
   local development. Admin-side flows that SHOW the link to the admin
   himself keep their existing fallback — he sees the address before
   forwarding it. */
function emailedLinkBase(req) {
  if (process.env.BASE_URL) return String(process.env.BASE_URL).replace(/\/+$/, '');
  if (process.env.NODE_ENV === 'production') return null;
  return req.protocol + '://' + req.get('host');
}

module.exports = {
  now, randHex, randInt, sha256, hmac, hashPassword, verifyPassword,
  toMinor, fromMinor, fmtMoney, convertMinor, decimalsFor, hashCode, verifyCode, validEmail, validSlug,
  strongPassword, esc, parseAmountList, shortHash, normalizeEmail, normalizePhone,
  signTicket, emailedLinkBase,
};
