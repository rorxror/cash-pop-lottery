'use strict';
/* Auth: scrypt passwords (in util), server-side sessions in DB, CSRF tokens,
   in-memory rate limiting, TOTP (RFC 6238, stdlib only), role middleware. */
const crypto = require('node:crypto');
const { randHex, now, sha256 } = require('./util');

/* ---------------- sessions ---------------- */
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days

async function createSession(db, userId, { ip = '', ua = '', extra = {} } = {}) {
  const id = randHex(32);
  const data = JSON.stringify(extra);
  await db.run('INSERT INTO sessions (id, user_id, data, ip, user_agent, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, userId, data, ip, String(ua).slice(0, 255), now() + SESSION_TTL, now()]);
  return id;
}
async function getSession(db, id) {
  if (!id) return null;
  const s = await db.get('SELECT * FROM sessions WHERE id = ?', [id]);
  if (!s) return null;
  if (s.expires_at < now()) { await db.run('DELETE FROM sessions WHERE id = ?', [id]); return null; }
  let data = {};
  try { data = JSON.parse(s.data || '{}'); } catch {}
  return { ...s, data };
}
async function destroySession(db, id) { await db.run('DELETE FROM sessions WHERE id = ?', [id]); }
async function destroyUserSessions(db, userId, exceptId = null) {
  if (exceptId) await db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', [userId, exceptId]);
  else await db.run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}
async function touchSession(db, id, extra = {}) {
  const s = await db.get('SELECT data FROM sessions WHERE id = ?', [id]);
  if (!s) return;
  let data = {};
  try { data = JSON.parse(s.data || '{}'); } catch {}
  await db.run('UPDATE sessions SET data = ?, expires_at = ? WHERE id = ?',
    [JSON.stringify({ ...data, ...extra }), now() + SESSION_TTL, id]);
}

/* ---------------- CSRF ---------------- */
function csrfToken(sessionData) {
  if (!sessionData._csrf) sessionData._csrf = randHex(24);
  return sessionData._csrf;
}
function checkCsrf(req) {
  const fromBody = req.body && req.body._csrf;
  const fromHeader = req.headers['x-csrf-token'];
  const token = fromBody || fromHeader;
  return !!(token && req.sessionData && req.sessionData._csrf &&
    crypto.timingSafeEqual(Buffer.from(String(token)), Buffer.from(String(req.sessionData._csrf))));
}

/* ---------------- rate limiting (in-memory, per key) ---------------- */
const buckets = new Map();
function rateLimit({ windowMs = 60000, max = 20, keyFn } = {}) {
  return (req, res, next) => {
    const key = (keyFn ? keyFn(req) : req.ip) || 'unknown';
    const t = now();
    let b = buckets.get(key);
    if (!b || b.reset < t) b = { count: 0, reset: t + windowMs };
    b.count += 1;
    buckets.set(key, b);
    if (b.count > max) return res.status(429).render('error', { status: 429, message: 'Too many requests. Please wait a moment and try again.' });
    next();
  };
}
setInterval(() => { const t = now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60000).unref();

/* ---------------- TOTP (RFC 6238, SHA-1, 30s, 6 digits) ---------------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let out = '', bits = 0, val = 0;
  for (const byte of buf) { val = (val << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(s) {
  s = String(s).toUpperCase().replace(/=+$/, '');
  let bits = 0, val = 0; const out = [];
  for (const ch of s) { const i = B32.indexOf(ch); if (i < 0) throw new Error('bad base32'); val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}
function totpCode(secretB32, atMs = now(), step = 30, digits = 6) {
  const counter = Math.floor(atMs / 1000 / step);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1] & 0x0f;
  const code = ((h[off] & 0x7f) << 24 | h[off + 1] << 16 | h[off + 2] << 8 | h[off + 3]) % (10 ** digits);
  return String(code).padStart(digits, '0');
}
function verifyTotp(secretB32, code, windowSteps = 1) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6,8}$/.test(c)) return false;
  for (let w = -windowSteps; w <= windowSteps; w++) {
    const cand = totpCode(secretB32, now() + w * 30000);
    if (cand.length === c.length && crypto.timingSafeEqual(Buffer.from(cand), Buffer.from(c))) return true;
  }
  return false;
}
function newTotpSecret() { return b32encode(crypto.randomBytes(20)); }
function totpUri(secret, account, issuer) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
}
function newBackupCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) codes.push(randHex(4).toUpperCase().match(/.{4}/g).join('-'));
  return codes;
}
function hashBackupCodes(codes) { return JSON.stringify(codes.map(c => sha256('backup:' + c))); }
function useBackupCode(storedJson, code) {
  const norm = String(code || '').toUpperCase().replace(/\s/g, '');
  let hashes = [];
  try { hashes = JSON.parse(storedJson || '[]'); } catch {}
  const h = sha256('backup:' + norm);
  const idx = hashes.findIndex(x => x === h);
  if (idx < 0) return null;
  hashes.splice(idx, 1);
  return JSON.stringify(hashes);
}

/* ---------------- UA parsing for login reports ---------------- */
function parseUA(ua) {
  ua = String(ua || '');
  let browser = 'Unknown', os = 'Unknown';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua) && !/Chrome/.test(ua)) browser = 'Safari';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/OPR\//.test(ua)) browser = 'Opera';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Mac OS/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  return { browser, os };
}

/* ---------------- middleware ---------------- */
function loadSession(db) {
  return async (req, res, next) => {
    req.db = db;
    const sid = req.cookies && req.cookies.sid;
    const sess = await getSession(db, sid);
    req.sess = sess;
    req.sessionData = sess ? sess.data : {};
    req.user = null;
    if (sess) {
      // user_id 0 = anonymous session (captcha/CSRF for visitors). It must
      // SURVIVE: the old code destroyed it on the next request because no
      // user 0 exists, which made captcha-protected forms unusable.
      // Anon sessions never grant req.user; only real-user sessions resolve.
      if (sess.user_id === 0) { req.user = null; }
      else {
        const u = await db.get('SELECT * FROM users WHERE id = ?', [sess.user_id]);
        if (u && u.status !== 'banned') req.user = u;
        else { await destroySession(db, sid); req.sess = null; req.sessionData = {}; res.clearCookie('sid'); }
      }
    }
    req.setFlash = async (type, msg) => {
      if (req.sess) await touchSession(db, req.sess.id, { _flash: { type, msg } });
    };
    next();
  };
}
function requireLogin(req, res, next) {
  if (!req.user) {
    if (req.setFlash) { req.setFlash('error', 'Please sign in first.').then(() => res.redirect('/login')); return; }
    return res.redirect('/login');
  }
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (!roles.includes(req.user.role)) return res.status(403).render('error', { status: 403, message: 'Access denied.' });
    next();
  };
}
/* Staff acting as a user: req.effectiveUser is the player, req.user is the admin */
function staffContext(req, res, next) {
  req.effectiveUser = req.user;
  req.impersonator = null;
  if (req.sess && req.sess.data && req.sess.data.impersonate_admin && req.user && req.user.role === 'admin') {
    req.impersonator = { id: req.user.id, name: req.user.name };
    // req.user stays the admin; effectiveUser would be target — but we keep it
    // simple: login-as-user creates a REAL session for the target user flagged
    // impersonated_by. See admin route. This middleware just exposes the flag.
  }
  next();
}

module.exports = {
  createSession, getSession, destroySession, destroyUserSessions, touchSession,
  csrfToken, checkCsrf, rateLimit,
  totpCode, verifyTotp, newTotpSecret, totpUri, newBackupCodes, hashBackupCodes, useBackupCode,
  parseUA, loadSession, requireLogin, requireRole, staffContext,
};
