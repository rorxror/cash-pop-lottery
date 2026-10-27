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
function toMinor(amountStr) {
  // "12.50" -> 1250. Returns null on invalid.
  if (amountStr === undefined || amountStr === null) return null;
  const s = String(amountStr).trim().replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [w, d = ''] = s.split('.');
  const minor = parseInt(w, 10) * 100 + parseInt((d + '00').slice(0, 2), 10);
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
function fromMinor(minor) { return (Number(minor) / 100).toFixed(2); }

/* currencies: [{code,symbol,rate}] rate = units of currency per 1 base unit */
function fmtMoney(minor, code, currencies) {
  const c = (currencies || []).find(x => x.code === code) || { symbol: code + ' ' };
  const neg = Number(minor) < 0;
  const abs = Math.abs(Number(minor));
  const str = (abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (neg ? '-' : '') + (c.symbol || (code + ' ')) + str;
}
function convertMinor(minor, fromCode, toCode, currencies) {
  const list = currencies || [];
  const f = list.find(x => x.code === fromCode);
  const t = list.find(x => x.code === toCode);
  if (!f || !t || !f.rate || !t.rate) return Number(minor);
  return Math.round(Number(minor) * (t.rate / f.rate));
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
  const digits = s.replace(/\D/g, '');
  if (!digits) return '';
  return (s.startsWith('+') ? '+' : '') + digits;
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

module.exports = {
  now, randHex, randInt, sha256, hmac, hashPassword, verifyPassword,
  toMinor, fromMinor, fmtMoney, convertMinor, validEmail, validSlug,
  strongPassword, esc, parseAmountList, shortHash, normalizeEmail, normalizePhone,
  signTicket,
};
