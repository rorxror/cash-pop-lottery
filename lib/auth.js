'use strict';
/* Auth: scrypt passwords (in util), server-side sessions in DB, CSRF tokens,
   in-memory rate limiting, TOTP (RFC 6238, stdlib only), role middleware. */
const crypto = require('node:crypto');
const { randHex, now, sha256 } = require('./util');

/* ---------------- sessions ---------------- */
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days (login sessions)
const ANON_TTL = 1000 * 60 * 60; // 1 hour (captcha/CSRF anon sessions)
const PREAUTH_TTL = 15 * 60 * 1000; // 15 minutes (pending-TOTP sessions)

/* SESSION-TAB-01: dual session scope. Cookies are per-BROWSER, not
   per-tab, so the old single `sid` cookie meant a player login and an
   admin login in the same browser kept overwriting each other (the
   owner watched the panel "become" the player account on refresh).
   Now: site scope (player/agent/anon) lives in `sid`, admin-panel
   scope lives in `sid_admin`, and the session row carries its scope
   (migration v24). loadSession loads ONLY the scope the request path
   belongs to and refuses a row whose scope does not match, so neither
   side can ever authenticate as the other. */
const SITE_COOKIE = 'sid';
const ADMIN_COOKIE = 'sid_admin';
function scopeForRole(role) { return role === 'admin' ? 'admin' : 'site'; }
function cookieForScope(scope) { return scope === 'admin' ? ADMIN_COOKIE : SITE_COOKIE; }
function scopeForPath(path, adminPath) {
  const ap = adminPath || '/ops-7f3a9c-console';
  return (path === ap || String(path || '').startsWith(ap + '/')) ? 'admin' : 'site';
}

async function createSession(db, userId, { ip = '', ua = '', extra = {}, ttlMs, scope = 'site' } = {}) {
  const id = randHex(32);
  const data = JSON.stringify(extra);
  // R-121: the DB expiry is set from the same TTL the caller uses for the
  // cookie maxAge, so cookie and DB lifetimes agree per session kind.
  const ttl = Number.isFinite(ttlMs) ? ttlMs : SESSION_TTL;
  await db.run('INSERT INTO sessions (id, user_id, data, ip, user_agent, expires_at, created_at, scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, userId, data, ip, String(ua).slice(0, 255), now() + ttl, now(), scope === 'admin' ? 'admin' : 'site']);
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
  /* D2-C2 (v20): pre-auth (pending-TOTP) sessions are stored with
     user_id = 0 and the target in data.pending_user_id, so the deletes
     above never saw them — a pre-auth session started before a password
     reset/change survived the revocation and could still complete the
     login afterwards without the new password. Revoke them too: scan
     the anon rows (few by construction) and delete those whose parsed
     payload names this user. exceptId is honoured the same way. */
  const anon = await db.query('SELECT id, data FROM sessions WHERE user_id = 0');
  for (const row of anon) {
    if (exceptId && row.id === exceptId) continue;
    let d = {};
    try { d = JSON.parse(row.data || '{}'); } catch {}
    if (d && Number(d.pending_user_id) === Number(userId)) {
      await db.run('DELETE FROM sessions WHERE id = ?', [row.id]);
    }
  }
}
async function touchSession(db, id, extra = {}, opts = {}) {
  // R-121: touch updates session DATA only — it must NOT slide expires_at.
  // The old sliding expiry let the DB session outlive the browser cookie
  // (active users logged out at day 7 anyway, while dead anon/pre-auth rows
  // lingered up to 7 days past their 1h/15m cookies).
  // D2-C1 (v20): the ONE deliberate exception is an explicit opts.ttlMs,
  // used when a session CHANGES KIND (anon -> pending-TOTP pre-auth):
  // the caller sets the new kind's absolute expiry (now + ttlMs). It is
  // never a slide — ordinary touches pass no ttlMs and keep R-121.
  const s = await db.get('SELECT data FROM sessions WHERE id = ?', [id]);
  if (!s) return;
  let data = {};
  try { data = JSON.parse(s.data || '{}'); } catch {}
  if (opts && Number.isFinite(opts.ttlMs)) {
    await db.run('UPDATE sessions SET data = ?, expires_at = ? WHERE id = ?',
      [JSON.stringify({ ...data, ...extra }), now() + opts.ttlMs, id]);
  } else {
    await db.run('UPDATE sessions SET data = ? WHERE id = ?',
      [JSON.stringify({ ...data, ...extra }), id]);
  }
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
  if (!token) return false;
  /* SESSION-TAB-01: a TOTP challenge for an admin account is carried by
     the ADMIN-scope pre-auth session while the /login request itself is
     loaded in site scope (req.pendingSess, set by loadSession). Its CSRF
     token is an equally valid proof for that one step. */
  const candidates = [];
  if (req.sessionData && req.sessionData._csrf) candidates.push(String(req.sessionData._csrf));
  if (req.pendingSess && req.pendingSess.data && req.pendingSess.data._csrf) candidates.push(String(req.pendingSess.data._csrf));
  if (!candidates.length) return false;
  // v16: timingSafeEqual THROWS on length mismatch (RangeError) — a wrong-length
  // token used to 500 instead of failing closed with 403. Compare lengths first.
  const a = String(token);
  return candidates.some(b => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)));
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
    if (b.count > max) {
      // R-038: JSON clients (OTP endpoints) get JSON, not an HTML page they
      // cannot parse.
      const wantsJson = (req.headers.accept || '').includes('application/json') || (req.headers['content-type'] || '').includes('application/json') || req.xhr;
      if (wantsJson) return res.status(429).json({ ok: false, error: 'Too many requests. Please wait a moment and try again.' });
      return res.status(429).render('error', { status: 429, message: 'Too many requests. Please wait a moment and try again.' });
    }
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
  return verifyTotpStep(secretB32, code, windowSteps) !== null;
}
/* RT-01 (red team): verifyTotp alone accepts the same code repeatedly
   inside its validity window - a captured code could complete a SECOND
   login. Returns the matched time-step counter (or null) so login can
   enforce one-use: a step at or below users.totp_last_step is a replay.
   Competing approach considered: a used-code hash table - rejected: it
   needs the same CAS discipline plus cleanup, while the counter is the
   RFC 6238 section 5.2 mechanism and a single guarded UPDATE. */
/* H3-04 (v23): TOTP secrets are stored ENCRYPTED (the shared AES-256-GCM
   envelope) whenever CREDENTIAL_ENCRYPTION_KEY is configured, so a raw
   users-table dump no longer hands over every 2FA seed. Legacy plaintext
   base32 rows (written before this round, or while no key is configured)
   keep working: unwrap passes non-envelope values through untouched, and
   an envelope that cannot be decrypted fails closed (null -> no match). */
function unwrapTotpSecret(stored) {
  if (!stored) return null;
  const creds = require('./credentials');
  if (!creds.looksLikeEnvelope(stored)) return stored;
  try { return creds.decryptField(stored, true); } catch { return null; }
}
function wrapTotpSecret(plain) {
  const creds = require('./credentials');
  return creds.keyConfigured() ? creds.encryptField(String(plain)) : String(plain);
}
function verifyTotpStep(secretB32, code, windowSteps = 1) {
  secretB32 = unwrapTotpSecret(secretB32);
  if (!secretB32) return null;
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6,8}$/.test(c)) return null;
  try {
    for (let w = -windowSteps; w <= windowSteps; w++) {
      const ts = now() + w * 30000;
      const cand = totpCode(secretB32, ts);
      if (cand.length === c.length && crypto.timingSafeEqual(Buffer.from(cand), Buffer.from(c))) return Math.floor(ts / 30000);
    }
  } catch { return null; /* a corrupt stored secret fails closed, never a 500 */ }
  return null;
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
  // DS-004: backup codes are issued hyphenated (XXXX-XXXX, 9 chars) but the
  // login field used to truncate at 8 and the matcher rejected the natural
  // unhyphenated spelling. Accept both: strip spaces/hyphens, and when 8
  // hex chars remain, re-hyphenate to the issued form before hashing.
  let norm = String(code || '').toUpperCase().replace(/[\s-]/g, '');
  if (/^[0-9A-F]{8}$/.test(norm)) norm = norm.slice(0, 4) + '-' + norm.slice(4);
  let hashes = [];
  try { hashes = JSON.parse(storedJson || '[]'); } catch {}
  const h = sha256('backup:' + norm);
  const idx = hashes.findIndex(x => x === h);
  if (idx < 0) return null;
  hashes.splice(idx, 1);
  return JSON.stringify(hashes);
}

/* ---------------- UA parsing for login reports ---------------- */
/* Contract: { browser, os } vocabulary is STABLE (routes/auth.js stores
   it in login_history). v20 (U-04) ADDS a `device` field and the
   real-world browser tokens the old chain missed — iOS Chrome is
   "CriOS" (and carries Safari/, so it used to parse as Safari), iOS
   Firefox is "FxiOS", Samsung Internet is "SamsungBrowser/", Edge on
   Android/iOS is "EdgA/"/"EdgiOS/". Nothing is renamed or re-valued.
   Device is a closed set for the sessions UI: iPhone / iPad / Android
   / Windows / Mac / Linux / Unknown device. Check order matters:
   Samsung/Edge/Opera tokens ride inside Chrome UAs, CriOS/FxiOS ride
   inside Safari UAs, and Android UAs also contain "Linux". */
function parseUA(ua) {
  ua = String(ua || '');
  let browser = 'Unknown', os = 'Unknown';
  if (/SamsungBrowser\//.test(ua)) browser = 'Samsung Internet';
  else if (/Edg\/|EdgA\/|EdgiOS\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/CriOS\//.test(ua)) browser = 'Chrome';
  else if (/FxiOS\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  if (/Windows/.test(ua)) os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Mac OS/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';
  let device = 'Unknown device';
  if (/iPad/.test(ua)) device = 'iPad';
  else if (/iPhone|iPod/.test(ua)) device = 'iPhone';
  else if (/Android/.test(ua)) device = 'Android';
  else if (/Windows/.test(ua)) device = 'Windows';
  // iPadOS 13+ Safari sends a Macintosh UA; the "Mobile/" token is the
  // only tell (desktop Mac Safari never carries it).
  else if (/Macintosh|Mac OS/.test(ua)) device = /Mobile\//.test(ua) ? 'iPad' : 'Mac';
  else if (/Linux/.test(ua)) device = 'Linux';
  return { browser, os, device };
}

/* ---------------- middleware ---------------- */
function loadSession(db, opts = {}) {
  return async (req, res, next) => {
    // Every async middleware must forward rejections to Express: previously
    // this function awaited the DB with no try/catch, so a transient DB error
    // on ANY request became an unhandled rejection and the process.exit(1)
    // handler killed the whole server (one flaky query = full outage).
    try {
      req.db = db;
      /* SESSION-TAB-01: load ONLY the scope this path belongs to, from
         that scope's own cookie. A session row whose stored scope does
         not match the requested scope is ignored (never destroyed — it
         stays valid for its own scope). */
      const scope = scopeForPath(req.path, opts.adminPath);
      const cookieName = cookieForScope(scope);
      req.sessionScope = scope;
      req.sessionCookie = cookieName;
      const sid = req.cookies && req.cookies[cookieName];
      let sess = await getSession(db, sid);
      /* H3-01 (v23): the scope check now covers ANONYMOUS sessions too.
         Before, a user_id=0 session (captcha/CSRF state) minted in one
         scope was honored in the other when its sid was copied into the
         other scope's cookie — a cross-scope state transplant. It grants
         no identity either way, but scopes must not bleed. The /login
         TOTP carrier below is unaffected: it fetches the other scope's
         pre-auth session explicitly via getSession, never via req.sess. */
      if (sess && (sess.scope || 'site') !== scope) sess = null;
      req.sess = sess;
      req.sessionData = sess ? sess.data : {};
      req.user = null;
      if (sess) {
        // user_id 0 = anonymous session (captcha/CSRF for visitors). It must
        // SURVIVE: the old code destroyed it on the next request because no
        // user 0 exists, which made captcha-protected forms unusable.
        // Anon sessions never grant req.user; only real-user sessions resolve.
        if (sess.user_id === 0) { req.user = null; }
        else if (sess.data && sess.data.pre_auth) {
          // R-001 (Critical): a pending-TOTP session carries NO usable
          // identity until the TOTP step passes. Previously the session
          // held the real user_id and loadSession resolved req.user, so a
          // password-only attacker could reuse the sid cookie and skip TOTP.
          req.user = null;
          req.preAuth = true;
        }
        else {
          const u = await db.get('SELECT * FROM users WHERE id = ?', [sess.user_id]);
          // R-041: pending_review terminates sessions exactly like banned.
          if (u && u.status !== 'banned' && u.status !== 'pending_review') req.user = u;
          else { await destroySession(db, sid); req.sess = null; req.sessionData = {}; res.clearCookie(cookieName); }
        }
      }
      /* SESSION-TAB-01 (TOTP carrier): the pending-TOTP stash for an
         ADMIN account lives in the admin scope (sid_admin) so it can
         never mutate or displace a live site-scope session in the same
         browser. The /login TOTP step runs in site scope, so expose
         that anon pre-auth session read-only as req.pendingSess. It is
         user_id 0 and grants NO identity — it only carries the pending
         challenge (and its CSRF token, accepted by checkCsrf). */
      req.pendingSess = null; req.pendingScope = null;
      if (req.path === '/login' && !(req.sessionData && req.sessionData.pending_user_id)) {
        const otherScope = scope === 'admin' ? 'site' : 'admin';
        const otherSid = req.cookies && req.cookies[cookieForScope(otherScope)];
        if (otherSid && (!sess || otherSid !== sess.id)) {
          const alt = await getSession(db, otherSid);
          if (alt && alt.user_id === 0 && alt.data && alt.data.pre_auth && alt.data.pending_user_id) {
            req.pendingSess = alt; req.pendingScope = otherScope;
          }
        }
      }
      req.setFlash = async (type, msg) => {
        if (req.sess) await touchSession(db, req.sess.id, { _flash: { type, msg } });
      };
      next();
    } catch (e) { next(e); }
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

/* OAuth login gate (mirrors password login): an OAuth sign-in must never
   bypass the account-status checks or the TOTP step that password login
   enforces. Previously the Facebook callback checked neither, and the Google
   callback checked 'banned' only (after mutating email_verified) — so banned,
   pending-review and TOTP-enrolled accounts could all sign in via OAuth.
   Returns { ok: false, error } to refuse, else { ok: true, totpRequired }. */
function oauthAccountCheck(u) {
  if (!u) return { ok: false, error: 'Account not found.' };
  if (u.status === 'banned') return { ok: false, error: 'This account has been blocked. Contact support.' };
  if (u.status === 'pending_review') return { ok: false, error: 'Your account is pending review.' };
  return { ok: true, totpRequired: !!u.totp_secret };
}

/* SESSION-TAB-01: one place that writes a session cookie, so the
   cookie NAME always matches the session's scope. `secureFlag` is the
   caller's existing rule (req.secure || force_ssl setting). */
function setSessionCookie(res, scope, sid, maxAge, secureFlag) {
  // H5-06 (v23): the documented FORCE_SSL env var is honored here, at
  // the single session-cookie writer — previously it was read in one
  // setup route only, while every real cookie decision used req.secure
  // or the force_ssl setting.
  res.cookie(cookieForScope(scope), sid, { httpOnly: true, sameSite: 'lax', secure: !!(secureFlag || process.env.FORCE_SSL === '1'), maxAge });
}

module.exports = {
  createSession, getSession, destroySession, destroyUserSessions, touchSession, SESSION_TTL, ANON_TTL, PREAUTH_TTL,
  SITE_COOKIE, ADMIN_COOKIE, scopeForRole, cookieForScope, scopeForPath, setSessionCookie,
  csrfToken, checkCsrf, rateLimit,
  totpCode, verifyTotp, verifyTotpStep, wrapTotpSecret, unwrapTotpSecret, newTotpSecret, totpUri, newBackupCodes, hashBackupCodes, useBackupCode,
  parseUA, loadSession, requireLogin, requireRole, staffContext, oauthAccountCheck,
};
