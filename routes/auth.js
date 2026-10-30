'use strict';
/* Authentication: login (+TOTP challenge), OTP-gated registration,
   logout, password reset, Google OAuth, custom captcha + reCAPTCHA hooks. */
const express = require('express');
const router = express.Router();
const { validEmail, hashPassword, verifyPassword, sha256, randHex, now, strongPassword, normalizeEmail, normalizePhone, emailedLinkBase } = require('../lib/util');
const { getS, getBool, getCurrencies } = require('../lib/settings');
const { createSession, getSession, destroySession, rateLimit, verifyTotp, useBackupCode, parseUA, csrfToken, touchSession, ANON_TTL, PREAUTH_TTL, scopeForRole, cookieForScope, setSessionCookie, ADMIN_COOKIE } = require('../lib/auth');
const { getExtension, extEnabled } = require('../lib/extensions');
const notify = require('../lib/notify');
const otpLib = require('../lib/otp');
const audit = require('../lib/audit');

/* ---------- custom captcha (math question, session-stored) ---------- */
async function anonSession(req, res) {
  // logged-out forms (login/register captcha, CSRF) need a session to persist
  if (req.sess) return;
  const sid = await createSession(req.db, 0, { ip: req.ip, ua: req.headers['user-agent'] || '', ttlMs: ANON_TTL });
  res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', secure: req.secure || getBool(req.settings, 'force_ssl', false), maxAge: 3600000 });
  const sess = await getSession(req.db, sid);
  req.sess = sess; req.sessionData = sess ? sess.data : {};
  req.csrfToken = csrfToken(req.sessionData);
  await touchSession(req.db, sid, { _csrf: req.sessionData._csrf });
}
function newCaptcha(req) {
  const a = 2 + Math.floor(Math.random() * 7), b = 2 + Math.floor(Math.random() * 7);
  req.sessionData._captcha = sha256('captcha:' + (a + b) + ':' + (req.sess ? req.sess.id : 'anon'));
  req.sessionData._captcha_n = 1;
  if (req.sess) { const { touchSession } = require('../lib/auth'); touchSession(req.db, req.sess.id, { _captcha: req.sessionData._captcha }); }
  return `<div class="field captcha"><label>Security check: what is ${a} + ${b}?</label><input type="text" name="captcha_answer" autocomplete="off" required></div>`;
}
function checkCaptcha(req, keep = false) {
  const ans = String(req.body.captcha_answer || '').trim();
  const ok = req.sessionData._captcha === sha256('captcha:' + ans + ':' + (req.sess ? req.sess.id : 'anon'));
  if (!keep) req.sessionData._captcha = null;
  return ok;
}
async function captchaHtml(req) {
  const ext = await getExtension(req.db, 'custom_captcha');
  return extEnabled(ext) ? newCaptcha(req) : '';
}
/* Third-party captcha widgets (v14): reCAPTCHA + hCaptcha + Turnstile all
   render through the same recaptchaHtml slot so templates need no change.
   Script tags carry the per-request CSP nonce (see server.js). */
async function recaptchaHtml(req) {
  const nonce = req.cspNonce ? ` nonce="${req.cspNonce}"` : '';
  let html = '';
  const rc = await getExtension(req.db, 'recaptcha');
  if (extEnabled(rc) && rc.config.site_key) html += `<div class="g-recaptcha" data-sitekey="${rc.config.site_key}"></div><script src="https://www.google.com/recaptcha/api.js" async defer${nonce}></script>`;
  const hc = await getExtension(req.db, 'hcaptcha');
  if (extEnabled(hc) && hc.config.site_key) html += `<div class="h-captcha" data-sitekey="${hc.config.site_key}"></div><script src="https://js.hcaptcha.com/1/api.js" async defer${nonce}></script>`;
  const ts = await getExtension(req.db, 'turnstile');
  if (extEnabled(ts) && ts.config.site_key) html += `<div class="cf-turnstile" data-sitekey="${ts.config.site_key}"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer${nonce}></script>`;
  return html;
}
async function verifyProvider(key, ext, req) {
  const field = key === 'recaptcha' ? 'g-recaptcha-response' : key === 'hcaptcha' ? 'h-captcha-response' : 'cf-turnstile-response';
  const token = req.body[field];
  if (!token) return false;
  // R-042: provider calls get a timeout (5s) so a hung provider cannot hang login. (async)
  const url = key === 'recaptcha' ? 'https://www.google.com/recaptcha/api/siteverify'
    : key === 'hcaptcha' ? 'https://hcaptcha.com/siteverify'
    : 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: ext.config.secret_key, response: token, remoteip: req.ip }).toString(),
      signal: AbortSignal.timeout(5000),
    });
    const j = await r.json();
    return !!j.success;
  } catch { return false; }
}
/* Unified captcha check (v14): every ENABLED provider must verify; when no
   provider is enabled, verification passes (nothing to check). */
/* SCAN A-09 pattern, shared: absolute links are built from BASE_URL,
   falling back to the request's own protocol + host — never a bare
   relative path (D2-C9: OAuth redirect_uri was relative without
   BASE_URL, which Google/Facebook reject outright). */
function baseUrl(req) { return process.env.BASE_URL || (req.protocol + '://' + req.get('host')); }

async function verifyCaptcha(req, opts = {}) {
  const capExt = await getExtension(req.db, 'custom_captcha');
  if (extEnabled(capExt)) {
    const ok = checkCaptcha(req, !!opts.keepCustom);
    /* D2-C4 (v20): consumption must be PERSISTED. checkCaptcha nulls the
       answer in memory only, and loadSession re-reads the row on every
       request — so one solve used to replay across requests (a second
       /forgot POST minted a second live reset token on the same answer).
       Write the null back through the session store: one solve, one use.
       (keepCustom flows — OTP request — deliberately do not consume.) */
    if (!opts.keepCustom && req.sess) await touchSession(req.db, req.sess.id, { _captcha: null });
    if (!ok) return false;
  }
  for (const key of ['recaptcha', 'hcaptcha', 'turnstile']) {
    const ext = await getExtension(req.db, key);
    // R-042: fail CLOSED when a provider is enabled but has no secret —
    // the old code silently skipped verification (widget shown, nothing checked).
    if (extEnabled(ext) && !ext.config.secret_key) return false;
    if (!extEnabled(ext)) continue;
    if (!(await verifyProvider(key, ext, req))) return false;
  }
  return true;
}

/* ---------- U-22: one identity = one account ---------- */
/* normalizePhone does NOT add a '+' to a bare digit string (lib/util.js),
   so the same international number can be stored as '1555…' (OTP path,
   typed without '+') or '+1555…' (form path). phoneVariants returns both
   spellings so every duplicate lookup sees the same identity. */
function phoneVariants(norm) {
  const p = String(norm || '');
  if (!p) return [];
  return [...new Set([p, p.startsWith('+') ? p.slice(1) : '+' + p])];
}
async function findUserByPhone(db, norm) {
  const vs = phoneVariants(norm);
  if (!vs.length) return null;
  const ph = vs.map(() => '?').join(', ');
  return db.get(`SELECT * FROM users WHERE phone IN (${ph})`, vs);
}
/* Canonical storage for NEW phone identities: the '+' form the register
   form produces, so a stored row is visible to exact checks and to the
   v20 unique index. (Bare local numbers without a country code cannot
   be canonicalized this way by any path — they carry no country code to
   prefix; every form in the app collects the dial code with the number.) */
function canonicalPhone(norm) {
  const p = String(norm || '');
  if (!p) return '';
  return p.startsWith('+') ? p : '+' + p;
}
/* An OAuth refusal whose TRUE reason is safe (and required) to show the
   user, unlike internal OAuth errors which stay generic. */
function oauthFail(message) { const e = new Error(message); e.exposeMessage = message; return e; }
const OAUTH_UNVERIFIED_EXISTING_MSG = (provider) =>
  `${provider} did not verify this email address to us, so we cannot sign you in with ${provider} for this account. Sign in with your existing method (your password or the provider you used before), then link ${provider} from inside your account while you are signed in.`;
const OAUTH_UNVERIFIED_NEW_MSG = (provider) =>
  `${provider} did not verify this email address to us, so this ${provider} sign-in cannot be used to create an account. Verify the email address with ${provider} and try again, or register with your email and password.`;

async function recordLogin(req, userId, email, success) {
  const { browser, os } = parseUA(req.headers['user-agent']);
  await req.db.run(
    'INSERT INTO login_history (user_id, email, ip, country, browser, os, success, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, email, req.ip, '', browser, os, success ? 1 : 0, now()]);
}

/* ---------- login ---------- */
router.get('/login', async (req, res) => {
  /* SESSION-TAB-01: an admin-scope session in this browser goes
     straight to the panel (the admin entry rule, unchanged). A
     site-scope sign-in no longer hard-redirects away from this form:
     with dual scopes the same browser may legitimately need to sign
     in to the OTHER scope (player in one tab, admin in another), and
     blocking the form made the second sign-in impossible without
     destroying the first. The form renders with a notice instead. */
  const adminSid = req.cookies && req.cookies[ADMIN_COOKIE];
  if (adminSid) {
    const as = await getSession(req.db, adminSid);
    if (as && as.user_id && (as.scope || 'site') === 'admin' && !(as.data && as.data.pre_auth)) {
      const au = await req.db.get('SELECT role, status FROM users WHERE id = ?', [as.user_id]);
      if (au && au.role === 'admin' && au.status !== 'banned' && au.status !== 'pending_review') return res.redirect(req.adminPath || '/');
    }
  }
  if (req.user && req.user.role === 'admin') return res.redirect(req.adminPath || '/');
  // R-036: ALWAYS create the anon session (not only when custom captcha
  // is on) so logged-out forms carry a CSRF token.
  await anonSession(req, res);
  res.render('login', {
    phoneCountries: require('../lib/phone-countries').allowedCountries(req.settings),
    metaTitle: 'Sign In', metaDesc: 'Sign in to your account.',
    signedInAs: req.user ? (req.user.name || req.user.email) : '',
    totpRequired: false, emailPrefill: '',
    captchaHtml: await captchaHtml(req), recaptchaHtml: await recaptchaHtml(req),
    googleOn: getBool(req.settings, 'google_oauth_enabled', false) && !!process.env.GOOGLE_CLIENT_ID,
    facebookOn: getBool(req.settings, 'facebook_oauth_enabled', false) && !!process.env.FACEBOOK_APP_ID,
    // R-047: OTP render and gate share fallback false (fail closed);
    // passwordOn is the single password_login_enabled toggle — the phantom
    // phone/email_password_enabled keys (never seeded) no longer force it on.
    phoneOtpOn: getBool(req.settings, 'phone_otp_enabled', false),
    emailOtpOn: getBool(req.settings, 'email_otp_enabled', false),
    passwordOn: getBool(req.settings, 'password_login_enabled', true),
    phonePwOn: getBool(req.settings, 'password_login_enabled', true),
    emailPwOn: getBool(req.settings, 'password_login_enabled', true),
  });
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyFn: r => 'login:' + r.ip });

router.post('/login', loginLimiter, async (req, res) => {
  /* SESSION-TAB-01: a pending TOTP challenge may be carried by THIS
     request's session (site scope) or by the other scope's anon
     pre-auth session (admin logins — see lib/auth loadSession). */
  const pendSess = (req.sessionData && req.sessionData.pending_user_id) ? req.sess : (req.pendingSess || null);
  const pendingUid = pendSess && pendSess.data ? pendSess.data.pending_user_id : null;
  const render = async (vars = {}) => res.render('login', {
    metaTitle: 'Sign In', metaDesc: 'Sign in to your account.',
    totpRequired: !!pendingUid, emailPrefill: req.body.email || '',
    captchaHtml: await captchaHtml(req), recaptchaHtml: await recaptchaHtml(req),
    // DS-045: pass the SAME method vars as GET /login - the re-render after
    // a failed attempt used to drop the Facebook button and the OTP UI.
    phoneCountries: require('../lib/phone-countries').allowedCountries(req.settings),
    googleOn: getBool(req.settings, 'google_oauth_enabled', false) && !!process.env.GOOGLE_CLIENT_ID,
    facebookOn: getBool(req.settings, 'facebook_oauth_enabled', false) && !!process.env.FACEBOOK_APP_ID,
    phoneOtpOn: getBool(req.settings, 'phone_otp_enabled', false),
    emailOtpOn: getBool(req.settings, 'email_otp_enabled', false),
    passwordOn: getBool(req.settings, 'password_login_enabled', true),
    phonePwOn: getBool(req.settings, 'password_login_enabled', true),
    emailPwOn: getBool(req.settings, 'password_login_enabled', true),
    formError: vars.formError,
  });
  // R-002: the TOTP second step is exempt from the captcha re-check — the
  // password step already passed captcha, and the TOTP render carries none.
  const isTotpStep = !!(req.body.totp_code && pendingUid);
  if (!isTotpStep && !(await verifyCaptcha(req))) return render({ formError: 'Captcha verification failed.' });

  // TOTP challenge step
  if (req.body.totp_code && pendingUid) {
    const u = await req.db.get('SELECT * FROM users WHERE id = ?', [pendingUid]);
    if (!u) return render({ formError: 'Session expired. Please sign in again.' });
    // v16: per-user TOTP fail limit. The IP limiter (30/15min) does not stop
    // a distributed attack against ONE account; login_history already records
    // failures, so count them (password + TOTP failures together) and refuse
    // to even verify after 10 in 15 minutes.
    try {
      const fails = await req.db.get('SELECT COUNT(*) AS c FROM login_history WHERE user_id = ? AND success = 0 AND created_at > ?', [u.id, now() - 15 * 60 * 1000]);
      if (fails && Number(fails.c) >= 10) return render({ formError: 'Too many failed sign-in attempts. Please wait 15 minutes and try again.' });
    } catch { return render({ formError: 'Sign-in temporarily unavailable. Please try again.' }); }
    // RT-01: a TOTP code is one-time. Claim its time-step with a guarded
    // UPDATE - a replayed code (step <= last accepted) and a parallel
    // duplicate both fail the claim and fall through to backup codes.
    const { verifyTotpStep } = require('../lib/auth');
    let ok = false;
    const matchedStep = verifyTotpStep(u.totp_secret, req.body.totp_code);
    if (matchedStep !== null && matchedStep > Number(u.totp_last_step == null ? -1 : u.totp_last_step)) {
      const claim = await req.db.run('UPDATE users SET totp_last_step = ? WHERE id = ? AND COALESCE(totp_last_step, -1) < ?', [matchedStep, u.id, matchedStep]);
      if (claim.changes === 1) ok = true;
    }
    let usedBackup = false;
    if (!ok && u.backup_codes) {
      const remaining = useBackupCode(u.backup_codes, req.body.totp_code);
      if (remaining !== null) {
        // R-040: guarded CAS consume — a parallel request with the same
        // backup code must not both succeed.
        const upd = await req.db.run('UPDATE users SET backup_codes = ? WHERE id = ? AND backup_codes = ?', [remaining, u.id, u.backup_codes]);
        if (upd.changes === 1) { ok = true; usedBackup = true; }
      }
    }
    if (!ok) { await recordLogin(req, u.id, u.email, false); return render({ formError: 'Invalid authenticator code.' });
    }
    if (pendSess && req.sess && pendSess.id === req.sess.id) {
      await touchSession(req.db, req.sess.id, { pending_user_id: null, pre_auth: null });
    } else if (pendSess) {
      /* The challenge lived in the OTHER scope's pre-auth session:
         retire it (finishLogin sets the fresh real session cookie);
         this request's own session — possibly a live player login —
         is not touched. */
      await destroySession(req.db, pendSess.id);
      res.clearCookie(cookieForScope(req.pendingScope || 'admin'));
    }
    await recordLogin(req, u.id, u.email, true); // R-094: TOTP successes are now logged
    return finishLogin(req, res, u);
  }

  // Sign In (returning players only): email/phone + password. Registration is separate
  // (/register collects full details) — a password sign-in never auto-creates an account.
  const isJson = (req.headers['content-type'] || '').includes('application/json');
  const jsonErr = (msg) => isJson ? res.status(401).json({ error: msg }) : render({ formError: msg });
  // R-092: server-side email/phone routing mirrors the JS rule, so phone
  // login works without JavaScript (identifier without '@' = phone).
  const rawIdent = String(req.body.email || req.body.phone || '').trim();
  const isEmailIdent = rawIdent.includes('@');
  const email = isEmailIdent ? rawIdent.toLowerCase() : '';
  const phone = isEmailIdent ? '' : normalizePhone(rawIdent);
  const identifier = rawIdent;
  // R-047 gate: password login can actually be disabled now.
  if (!getBool(req.settings, 'password_login_enabled', true)) return jsonErr('Invalid credentials.');
  let u = email
    ? await req.db.get('SELECT * FROM users WHERE email = ?', [email])
    : await req.db.get('SELECT * FROM users WHERE phone = ?', [phone]);
  // R-027: one generic message for no-account / wrong-password / banned /
  // pending — the old four messages enumerated accounts and their status.
  if (!u) {
    await recordLogin(req, null, identifier, false);
    return jsonErr('Invalid credentials.');
  }
  // R-028: per-account lockout on password failures (fail closed on error).
  try {
    const fails = await req.db.get('SELECT COUNT(*) AS c FROM login_history WHERE user_id = ? AND success = 0 AND created_at > ?', [u.id, now() - 15 * 60 * 1000]);
    if (fails && Number(fails.c) >= 10) return jsonErr('Invalid credentials.');
  } catch { return jsonErr('Invalid credentials.'); }
  if (!u.password_hash || !verifyPassword(req.body.password || '', u.password_hash)) {
    await recordLogin(req, u.id, identifier, false);
    return jsonErr('Invalid credentials.');
  }
  if (u.status === 'banned') { await recordLogin(req, u.id, identifier, false); return jsonErr('Invalid credentials.'); }
  if (u.status === 'pending_review') { await recordLogin(req, u.id, identifier, false); return jsonErr('Invalid credentials.'); }

  if (u.totp_secret) {
    if (scopeForRole(u.role) === 'admin') {
      /* SESSION-TAB-01: an admin's pending-TOTP session is created in
         the ADMIN scope (sid_admin cookie). It is NEVER stashed into
         the site session this request carried — that session may be a
         live player login in another tab of the same browser, and
         mutating it (pre_auth + pending flags) was the tab-swap bug
         in TOTP form: the player's tab silently lost its login. */
      const preSid = await createSession(req.db, 0, { ip: req.ip, ua: req.headers['user-agent'], extra: { pending_user_id: u.id, pre_auth: true }, ttlMs: PREAUTH_TTL, scope: 'admin' });
      const { touchSession: tsAdmin } = require('../lib/auth'); // aliased: the site branch below declares its own block-scoped touchSession (TDZ)
      const preTok = csrfToken({}); await tsAdmin(req.db, preSid, { _csrf: preTok }); req.csrfToken = preTok;
      setSessionCookie(res, 'admin', preSid, PREAUTH_TTL, req.secure || getBool(req.settings, 'force_ssl', false));
      return res.render('login', {
        metaTitle: 'Two-Factor', metaDesc: '', totpRequired: true, emailPrefill: email,
        captchaHtml: '', recaptchaHtml: '', googleOn: false,
      });
    }
    // stash pending auth; need a session to hold it — create temp session
    const { touchSession } = require('../lib/auth');
    let sess = req.sess;
    if (!sess) {
      // R-001: pending-TOTP session holds user_id 0 (anon) + pending id in
      // data only; loadSession grants no req.user for pre_auth sessions.
      const sid = await createSession(req.db, 0, { ip: req.ip, ua: req.headers['user-agent'], extra: { pending_user_id: u.id, pre_auth: true }, ttlMs: PREAUTH_TTL });
      res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', secure: req.secure || getBool(req.settings, 'force_ssl', false), maxAge: 15 * 60 * 1000 });
      const { csrfToken: mkCsrf, touchSession: ts2 } = require('../lib/auth');
      const tok = mkCsrf({}); await ts2(req.db, sid, { _csrf: tok }); req.csrfToken = tok;
      return res.render('login', {
        metaTitle: 'Two-Factor', metaDesc: '', totpRequired: true, emailPrefill: email,
        captchaHtml: '', recaptchaHtml: '', googleOn: false,
      });
    }
    /* D2-C1 (v20): the stash CHANGES the session's kind (anon -> pre-auth),
       so its expiry must become the 15-minute PREAUTH_TTL — touchSession
       alone deliberately never moves expires_at (R-121), which left the
       anon session's 1-hour TTL on a pending-TOTP session. The cookie
       maxAge is re-issued at the same 15 minutes so browser and DB agree. */
    await touchSession(req.db, sess.id, { pending_user_id: u.id, pre_auth: true }, { ttlMs: PREAUTH_TTL });
    res.cookie('sid', sess.id, { httpOnly: true, sameSite: 'lax', secure: req.secure || getBool(req.settings, 'force_ssl', false), maxAge: PREAUTH_TTL });
    return res.render('login', {
      metaTitle: 'Two-Factor', metaDesc: '', totpRequired: true, emailPrefill: email,
      captchaHtml: '', recaptchaHtml: '', googleOn: false,
    });
  }
  await recordLogin(req, u.id, email, true);
  return finishLogin(req, res, u);
});

async function finishLogin(req, res, u, welcomeMsg) {
  // kill pre-auth flag if present
  const extra = welcomeMsg ? { _flash: { type: 'success', msg: welcomeMsg } } : {};
  /* SESSION-TAB-01: the new session lives in the scope of the account
     being signed in (admin → admin scope + sid_admin cookie; everyone
     else → site scope + sid cookie). The session this request carried
     is destroyed ONLY when it is an anon/pre-auth session or belongs
     to the SAME scope — a live session of the OTHER scope (e.g. the
     player's, in another tab of the same browser) is never touched,
     which is the whole point of the dual scope. Same-scope destruction
     keeps the old session-fixation protection per scope. */
  const scope = scopeForRole(u.role);
  const sid = await createSession(req.db, u.id, { ip: req.ip, ua: req.headers['user-agent'], extra, scope });
  if (req.sess) {
    const prevScope = req.sess.user_id === 0 ? scope : (req.sess.scope || 'site');
    if (req.sess.user_id === 0 || (req.sess.data && req.sess.data.pre_auth) || prevScope === scope) {
      await destroySession(req.db, req.sess.id);
    }
  }
  await req.db.run('UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?', [now(), req.ip, u.id]);
  // Device/IP duplicate detection (v14): flags only, never blocks login.
  try {
    const { checkSharedDevice } = require('../lib/flags');
    await checkSharedDevice(req.db, u.id, req.ip, req.headers['user-agent'] || '');
  } catch {}
  setSessionCookie(res, scope, sid, 7 * 24 * 3600 * 1000, req.secure || getBool(req.settings, 'force_ssl', false));
  const dest = u.role === 'admin' ? (req.adminPath || '/') : (u.role === 'agent' ? '/agent' : '/');
  res.redirect(dest);
}

router.post('/logout', async (req, res) => {
  if (req.sess) await destroySession(req.db, req.sess.id);
  res.clearCookie('sid');
  res.redirect('/');
});

/* ---------- registration (OTP-gated when enabled) ---------- */
/* Separate Register page: full detail form upfront (name, email, phone, password, terms).
   Register and Sign In are DIFFERENT screens by design — registration collects details,
   sign-in is for returning players. No merged/OTP-first confusion. */
router.get('/register', async (req, res) => {
  if (!getBool(req.settings, 'registration_enabled', true))
    return res.status(403).render('error', { status: 403, message: 'Registration is currently closed.' });
  if (req.user) return res.redirect('/');
  await anonSession(req, res); // R-036: anon session for CSRF on every logged-out form
  const { allowedCountries } = require('../lib/phone-countries');
  res.render('register', {
    metaTitle: 'Create Account', metaDesc: 'Create your Cash Pop account.',
    phoneCountries: allowedCountries(req.settings),
    refCode: String(req.query.ref || '').trim().toUpperCase(),
    otpEnabled: getBool(req.settings, 'otp_registration', false),
    captchaHtml: await captchaHtml(req), recaptchaHtml: await recaptchaHtml(req),
    googleOn: getBool(req.settings, 'google_oauth_enabled', false) && !!process.env.GOOGLE_CLIENT_ID,
    facebookOn: getBool(req.settings, 'facebook_oauth_enabled', false) && !!process.env.FACEBOOK_APP_ID,
  });
});

async function consumeOtpCode(db, code) {
  // R-039/R-093: guarded atomic consume (changes===1) + scrypt verification.
  const { verifyCode } = require('../lib/util');
  const rows = await db.query('SELECT * FROM otp_codes WHERE revoked = 0 AND (expires_at IS NULL OR expires_at > ?)', [now()]);
  for (const r of rows) {
    if (verifyCode(r.code_hash, String(code).trim()) && r.uses < r.max_uses) {
      const upd = await db.run('UPDATE otp_codes SET uses = uses + 1 WHERE id = ? AND uses < max_uses', [r.id]);
      if (upd.changes === 1) return r;
    }
  }
  return null;
}

router.post('/register', rateLimit({ windowMs: 3600000, max: 20, keyFn: r => 'reg:' + r.ip }), async (req, res) => {
  /* SCAN fix (A-01): the error re-render must carry everything the GET
     render passes — without phoneCountries the country-code dropdown
     rendered EMPTY after any validation error (phone unenterable),
     without refCode the referral was silently dropped, and without
     `old` every typed field had to be re-entered. */
  const { allowedCountries } = require('../lib/phone-countries');
  const render = async (formError) => res.render('register', {
    metaTitle: 'Create Account', metaDesc: '', formError,
    phoneCountries: allowedCountries(req.settings),
    refCode: String(typeof req.body.ref === 'string' ? req.body.ref : '').trim().toUpperCase(),
    old: {
      name: typeof req.body.name === 'string' ? req.body.name : '',
      email: typeof req.body.email === 'string' ? req.body.email : '',
      phone_cc: typeof req.body.phone_cc === 'string' ? req.body.phone_cc : '',
      phone_local: typeof req.body.phone_local === 'string' ? req.body.phone_local : '',
    },
    otpEnabled: getBool(req.settings, 'otp_registration', false),
    captchaHtml: await captchaHtml(req), recaptchaHtml: await recaptchaHtml(req),
    googleOn: getBool(req.settings, 'google_oauth_enabled', false) && !!process.env.GOOGLE_CLIENT_ID,
    facebookOn: getBool(req.settings, 'facebook_oauth_enabled', false) && !!process.env.FACEBOOK_APP_ID,
  });
  if (!getBool(req.settings, 'registration_enabled', true)) return res.status(403).render('error', { status: 403, message: 'Registration is currently closed.' });
  if (!(await verifyCaptcha(req))) return render('Captcha verification failed.');

  /* SCAN fix (B-08): qs parsing turns name[x]=1 into an object — coerce
     every text field to a string up front so .trim()/.length below can
     never throw a 500 on type-confused input. */
  const strField = (v) => (typeof v === 'string' ? v : '');
  const name = strField(req.body.name), email = strField(req.body.email);
  const password = strField(req.body.password), password_confirm = strField(req.body.password_confirm), otp_code = strField(req.body.otp_code);
  const agree = req.body.agree;
  // Phone = dial code + local number (combined client-side; recombine server-side as fallback)
  // Canonicalized: the same number in any spelling (+1 555..., +1555...) is one identity.
  let phone = String(req.body.phone || '').trim();
  if (!phone && req.body.phone_local && String(req.body.phone_local).replace(/\D/g, '') && !req.body.phone_cc) {
    return render('Please choose your country code for your phone number.');
  }
  if (!phone && req.body.phone_cc && req.body.phone_local) {
    const cc = String(req.body.phone_cc).replace(/\D/g, '');
    const local = String(req.body.phone_local).replace(/\D/g, '');
    if (cc && local) phone = '+' + cc + local;
  }
  phone = normalizePhone(phone);
  // Admin-blocked countries are rejected server-side (dropdown also hides them)
  if (phone) {
    const { isBlockedPhone } = require('../lib/phone-countries');
    if (isBlockedPhone(req.settings, phone)) return render('Phone numbers from this country are not accepted on this platform.');
  }
  if (!name || name.trim().length < 2) return render('Please enter your name.');
  if (!validEmail(email)) return render('Please enter a valid email.');
  const pwErr = strongPassword(password, getBool(req.settings, 'secure_password', true));
  if (pwErr) return render(pwErr);
  if (getBool(req.settings, 'breached_password_check', true)) {
    const { isBreached } = require('../lib/breached');
    if (await isBreached(password)) return render('This password has appeared in a data breach. Please choose a different password.');
  }
  if (password !== password_confirm) return render('Passwords do not match.');
  if (getBool(req.settings, 'policy_agreement', true) && !agree) return render('You must accept the terms to register.');

  // R-039: duplicate checks run BEFORE consuming the signup code, so a
  // failed (duplicate) registration no longer burns a single-use code.
  const emailLc = normalizeEmail(email);
  const ex = await req.db.get('SELECT id FROM users WHERE email = ?', [emailLc]);
  if (ex) return render('An account with this email already exists. Please sign in instead.');
  if (phone) {
    // U-22: variant-aware — a bare-digit row stored by the OTP path is
    // the same identity as this '+' form (and vice versa).
    const exPhone = await findUserByPhone(req.db, phone);
    if (exPhone) return render('An account with this phone number already exists. Please sign in instead.');
  }
  if (getBool(req.settings, 'otp_registration', false)) {
    if (!otp_code || !(await consumeOtpCode(req.db, otp_code))) return render('Invalid or expired signup code. Ask support for a valid code.');
  }

  // Referral: ?ref=CODE on the register link credits the referrer (ViserLab-style)
  let referredBy = null;
  const refCode = String(req.query.ref || req.body.ref || '').trim().toUpperCase();
  if (refCode) {
    const ref = await req.db.get('SELECT id FROM users WHERE referral_code = ?', [refCode]);
    if (ref) referredBy = ref.id;
  }
  // U-22: the INSERT itself is guarded — if a parallel registration (or
  // the v20 unique indexes) wins the race, the loser gets the true
  // duplicate reason, never a 500 and never a second row.
  let r;
  try {
    r = await req.db.run(
      'INSERT INTO users (email, phone, name, password_hash, role, status, referred_by, terms_accepted_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [emailLc, phone, name.trim(), hashPassword(password), 'player', 'active', referredBy, agree ? now() : null, now()]);
  } catch (e) {
    if (/unique|duplicate/i.test(String(e && e.message || ''))) {
      const dupEmail = await req.db.get('SELECT id FROM users WHERE email = ?', [emailLc]);
      if (dupEmail) return render('An account with this email already exists. Please sign in instead.');
      if (phone && await findUserByPhone(req.db, phone)) return render('An account with this phone number already exists. Please sign in instead.');
      return render('An account with this email or phone number already exists. Please sign in instead.');
    }
    throw e;
  }
  // Referral code for the new player (used in their invite link)
  await req.db.run('UPDATE users SET referral_code = ? WHERE id = ?', ['CP' + r.id.toString(36).toUpperCase(), r.id]);
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [r.id]);
  await audit.log(req.db, { actorId: u.id, actorRole: 'player', action: 'user.register', entity: 'user', entityId: u.id, detail: { email: emailLc, terms_accepted_at: agree ? now() : null }, ip: req.ip });
  // SMART-ADMIN bonus engine: signup-trigger campaigns (grant failure must
  // never break registration itself).
  try { await require('../lib/bonus').onSignup(req.db, req.settings, u.id); } catch {}
  // Device/IP duplicate detection (v14): flags only, never blocks.
  try {
    const { checkSharedDevice } = require('../lib/flags');
    await checkSharedDevice(req.db, u.id, req.ip, req.headers['user-agent'] || '');
  } catch {}
  notify.send(req.db, req.settings, 'email', 'welcome', emailLc, { name: u.name }).catch(() => {});
  await recordLogin(req, u.id, emailLc, true);
  return finishLogin(req, res, u, 'Welcome, ' + u.name.split(' ')[0] + '! Your account is ready — good luck!');
});

/* ---------- forgot / reset password ---------- */
router.get('/forgot', async (req, res) => { await anonSession(req, res); res.render('forgot', { metaTitle: 'Reset Password', metaDesc: '', sent: false, captchaHtml: await captchaHtml(req), recaptchaHtml: await recaptchaHtml(req) }); });
router.post('/forgot', rateLimit({ windowMs: 3600000, max: 10, keyFn: r => 'forgot:' + r.ip }), async (req, res) => {
  // R-091: captcha on forgot-password (was captcha-free at 10/hour for any address).
  if (!(await verifyCaptcha(req))) return res.render('forgot', { metaTitle: 'Reset Password', metaDesc: '', sent: false, formError: 'Captcha verification failed.', captchaHtml: await captchaHtml(req), recaptchaHtml: await recaptchaHtml(req) });
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = await req.db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (u) {
    // R-030: issuing a new token invalidates all prior unused tokens.
    await req.db.run('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0', [u.id]);
    const token = randHex(24);
    await req.db.run('INSERT INTO password_resets (user_id, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)',
      [u.id, sha256('reset:' + token), now() + 3600000, now()]);
    /* SCAN fix (A-09): same host fallback as the verify-email flow —
       without BASE_URL the old link was a bare relative path and the
       reset email was unusable. */
    /* H3-02 (v23): the emailed link's base is BASE_URL in production —
       never the request Host (see emailedLinkBase). Without a base the
       send is skipped and the token burns below, exactly like any other
       undelivered reset. */
    const linkBase = emailedLinkBase(req);
    const link = linkBase ? linkBase + '/reset/' + token : null;
    /* AUTH-CHANNELS-01: the page stays the generic anti-enumeration text,
       but an UNDELIVERED reset token must not stay live — burn it when the
       send did not actually go out. */
    const resetSend = link ? await notify.send(req.db, req.settings, 'email', 'password_reset', email, { name: u.name, link }).catch(() => ({ status: 'failed' })) : { status: 'failed' };
    if (!resetSend || resetSend.status !== 'sent')
      await req.db.run('UPDATE password_resets SET used = 1 WHERE token_hash = ?', [sha256('reset:' + token)]);
  }
  res.render('forgot', { metaTitle: 'Reset Password', metaDesc: '', sent: true });
});
router.get('/reset/:token', async (req, res) => {
  const pr = await req.db.get('SELECT * FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > ?', [sha256('reset:' + req.params.token), now()]);
  if (!pr) return res.status(400).render('error', { status: 400, message: 'This reset link is invalid or expired.' });
  /* D2-C7 (v20): the genuine emailed-link flow must arrive at the POST
     WITH a session + CSRF token — the POST now refuses session-less
     requests like every other auth POST (server.js). Create the anon
     session here, exactly as GET /login, /register and /forgot do, so
     the rendered form's hidden _csrf field carries a real token. */
  await anonSession(req, res);
  res.render('reset', { metaTitle: 'Set New Password', metaDesc: '', token: req.params.token });
});
router.post('/reset/:token', loginLimiter, async (req, res) => { // R-091: reset POST was rate-limit-free
  const pr = await req.db.get('SELECT * FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > ?', [sha256('reset:' + req.params.token), now()]);
  if (!pr) return res.status(400).render('error', { status: 400, message: 'This reset link is invalid or expired.' });
  const target = await req.db.get('SELECT role FROM users WHERE id = ?', [pr.user_id]);
  const { passwordError } = require('../lib/validate');
  const pwErr = passwordError(req.body.password, target ? target.role : 'player', getBool(req.settings, 'secure_password', true));
  if (pwErr || req.body.password !== req.body.password2)
    return res.render('reset', { metaTitle: 'Set New Password', metaDesc: '', token: req.params.token, formError: pwErr || 'Passwords do not match.' });
  if (getBool(req.settings, 'breached_password_check', true)) {
    const { isBreached } = require('../lib/breached');
    if (await isBreached(req.body.password))
      return res.render('reset', { metaTitle: 'Set New Password', metaDesc: '', token: req.params.token, formError: 'This password has appeared in a data breach. Please choose a different one.' });
  }
  // RT-05: claim the token FIRST with a used=0 guard. Two parallel POSTs
  // with the same token both used to succeed (last writer won); now only
  // the request whose guarded UPDATE lands may change the password.
  const claim = await req.db.run('UPDATE password_resets SET used = 1 WHERE id = ? AND used = 0', [pr.id]);
  if (claim.changes !== 1) return res.status(400).render('error', { status: 400, message: 'This reset link is invalid or expired.' });
  await req.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(req.body.password), pr.user_id]);
  // R-030: a successful reset also burns every other outstanding token.
  await req.db.run('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0', [pr.user_id]);
  const { destroyUserSessions } = require('../lib/auth');
  await destroyUserSessions(req.db, pr.user_id);
  await audit.log(req.db, { actorId: pr.user_id, actorRole: '', action: 'user.password_reset', entity: 'user', entityId: pr.user_id, detail: {}, ip: req.ip });
  res.redirect('/login');
});

/* ---------- email verification link (v14, public) ---------- */
// Used both for self-verification (new_email == current email) and for
// admin-initiated email changes (new_email == the new address): the swap
// happens ONLY when the new address owner clicks the link.
router.get('/verify-email/:token', async (req, res) => {
  const row = await req.db.get('SELECT * FROM email_verifications WHERE token_hash = ? AND used = 0 AND expires_at > ?', [sha256('verify:' + req.params.token), now()]);
  if (!row) return res.status(400).render('error', { status: 400, message: 'This verification link is invalid or expired.' });
  // R-095: duplicate-check FIRST, consume only on success — the old order
  // burned a legitimate token when the address had been taken meanwhile.
  const dup = await req.db.get('SELECT id FROM users WHERE email = ? AND id != ?', [row.new_email, row.user_id]);
  if (dup) return res.status(400).render('error', { status: 400, message: 'This email address is already registered to another account.' });
  await req.db.run('UPDATE email_verifications SET used = 1 WHERE id = ?', [row.id]);
  // R-014 (consume half): consuming one verification burns all other
  // pending rows for this user, so a stale token cannot swap back later.
  await req.db.run('UPDATE email_verifications SET used = 1 WHERE user_id = ? AND used = 0 AND id != ?', [row.user_id, row.id]);
  const uBefore = await req.db.get('SELECT email FROM users WHERE id = ?', [row.user_id]);
  const isChange = !!(uBefore && uBefore.email && uBefore.email !== row.new_email);
  await req.db.run('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?', [row.new_email, row.user_id]);
  await audit.log(req.db, { actorId: row.user_id, actorRole: 'player', action: isChange ? 'user.email_changed' : 'user.email_verified', entity: 'user', entityId: row.user_id, detail: { via: 'link' }, ip: req.ip });
  try { await req.setFlash('success', 'Email verified. You can now deposit and withdraw.'); } catch {}
  res.redirect('/login');
});

/* ---------- OTP Login (phone/email, no password) ---------- */
router.post('/login/otp/request', loginLimiter, async (req, res) => {
  // R-009: captcha on OTP request (kept custom-captcha answer so resends
  // on the same page still work) + account gate below.
  if (!(await verifyCaptcha(req, { keepCustom: true }))) return res.status(400).json({ ok: false, error: 'Captcha verification failed.' });
  // R-003: frontend sends {type}, server only read id_type — accept both.
  const idType = (req.body.id_type || req.body.type) === 'phone' ? 'phone' : 'email';
  const rawId = String(req.body.identifier || '').trim();
  const identifier = idType === 'phone' ? normalizePhone(rawId) : normalizeEmail(rawId);
  if (idType === 'email' && !validEmail(identifier))
    return res.status(400).json({ ok: false, error: 'Enter a valid email.' });
  if (idType === 'phone' && !/^\+?[0-9]{7,15}$/.test(identifier))
    return res.status(400).json({ ok: false, error: 'Enter a valid phone number.' });
  // Fail closed: OTP login is OFF unless the admin explicitly enabled it.
  if (idType === 'phone' && !getBool(req.settings, 'phone_otp_enabled', false))
    return res.status(400).json({ ok: false, error: 'Phone sign-in is unavailable right now.' });
  if (idType === 'email' && !getBool(req.settings, 'email_otp_enabled', false))
    return res.status(400).json({ ok: false, error: 'Email sign-in is unavailable right now.' });
  // R-009 (account half): when registration is disabled, OTP codes go only
  // to identifiers tied to an existing account — no pumping arbitrary
  // phones/emails at operator cost.
  if (!getBool(req.settings, 'registration_enabled', true)) {
    const acct = idType === 'phone'
      ? await findUserByPhone(req.db, identifier)
      : await req.db.get('SELECT id FROM users WHERE email = ?', [identifier]);
    if (!acct) return res.status(400).json({ ok: false, error: 'Could not send the code.' });
  }
  let code;
  try {
    code = await otpLib.createOtp(req.db, identifier, idType);
  } catch (e) {
    return res.status(429).json({ ok: false, error: e.message });
  }
  const result = await otpLib.sendOtp(req.db, req.settings, identifier, idType, code, 'login');
  await audit.log(req.db, { actorId: 0, actorRole: 'anon', action: 'otp.requested', entity: 'otp', entityId: '', detail: { idType, sent: result.sent }, ip: req.ip });
  // NEVER return the code: if no provider sent it, the user must see an
  // error, not a code that logs them in (previous demo-mode takeover hole).
  if (!result.sent) { await otpLib.expireLiveOtps(req.db, identifier, idType); return res.status(503).json({ ok: false, error: 'Could not send the code. Please try again later or use your password.' }); } // AUTH-CHANNELS-01: undelivered code dies here
  res.json({ ok: true, via: result.via });
});

router.post('/login/otp/verify', loginLimiter, async (req, res) => {
  const idType = (req.body.id_type || req.body.type) === 'phone' ? 'phone' : 'email';
  const rawId = String(req.body.identifier || '').trim();
  const identifier = idType === 'phone' ? normalizePhone(rawId) : normalizeEmail(rawId);
  const code = String(req.body.code || '').trim();
  const v = await otpLib.verifyOtp(req.db, identifier, idType, code);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
  // Find or create user. Phone: the same number with/without '+' is one identity,
  // so a form-registered +1555... account is found by a bare 1555... OTP login.
  let u = null;
  if (idType === 'phone') {
    u = await findUserByPhone(req.db, identifier);
  } else {
    u = await req.db.get('SELECT * FROM users WHERE email = ?', [identifier]);
  }
  let isNew = false;
  if (!u) {
    if (!getBool(req.settings, 'registration_enabled', true))
      return res.status(403).json({ ok: false, error: 'Registration is currently closed.' });
    // Phone-only accounts have no real email. The email column is UNIQUE + NOT NULL,
    // so a second phone-only account used to crash on ''. Use an unroutable,
    // phone-derived placeholder instead (unique by construction: the phone itself
    // was just proven unused). Real email can be added to the profile later.
    const otpEmail = idType === 'email' ? identifier : 'phone' + identifier.replace(/\D/g, '') + '@phone.local';
    // U-22: store the phone in the canonical '+' form. The old code stored
    // the bare digit form when the user typed no '+', and that row was
    // invisible to the form/agent exact phone checks — the same number
    // could then register a second account through the form.
    const storedPhone = idType === 'phone' ? canonicalPhone(identifier) : '';
    let r;
    try {
      r = await req.db.run(
        'INSERT INTO users (email, phone, name, password_hash, role, status, profile_completed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [otpEmail, storedPhone, identifier.split('@')[0], '', 'player', 'active', 0, now()]);
    } catch (e) {
      if (/unique|duplicate/i.test(String(e && e.message || ''))) {
        // A parallel creation won the race (or the v20 index fired):
        // refuse with the true reason — never a twin, never a 500.
        const dupPhone = idType === 'phone' ? await findUserByPhone(req.db, identifier) : null;
        if (dupPhone) return res.status(409).json({ ok: false, error: 'An account with this phone number already exists. Please sign in instead.' });
        return res.status(409).json({ ok: false, error: 'An account with this email already exists. Please sign in instead.' });
      }
      throw e;
    }
    u = await req.db.get('SELECT * FROM users WHERE id = ?', [r.id]);
    await audit.log(req.db, { actorId: u.id, actorRole: 'player', action: 'user.register_otp', entity: 'user', entityId: u.id, detail: { idType }, ip: req.ip });
    isNew = true;
  }
  // OTP login must be exactly as strict as password login: staff accounts
  // never log in by OTP, blocked/pending accounts stay out, and accounts
  // with authenticator 2FA must use password + TOTP (no 2FA bypass via OTP).
  // DS-040: ONE generic refusal for every non-eligible case. The old
  // distinct messages enumerated whether the identifier was staff, banned,
  // pending review, or 2FA-enrolled (password path fixed in R-027; this
  // path was not). The real outcome stays server-side via recordLogin.
  const otpRefusal = 'Sign-in could not be completed with a code. Please sign in with your password, or contact support if you need help.';
  if (u.role !== 'player') return res.status(403).json({ ok: false, error: otpRefusal });
  if (u.status === 'banned') { await recordLogin(req, u.id, identifier, false); return res.status(403).json({ ok: false, error: otpRefusal }); }
  if (u.status === 'pending_review') { await recordLogin(req, u.id, identifier, false); return res.status(403).json({ ok: false, error: otpRefusal }); }
  if (u.totp_secret) { await recordLogin(req, u.id, identifier, false); return res.status(403).json({ ok: false, error: otpRefusal }); }
  await recordLogin(req, u.id, identifier, true);
  // NEW USER: details are NOT lost — collect name + terms before full login (registration step preserved)
  if (isNew) {
    const { createSession, csrfToken, touchSession } = require('../lib/auth');
    const sid = await createSession(req.db, u.id, { ip: req.ip, ua: req.headers['user-agent'], extra: { profile_pending: 1 } });
    const token = csrfToken({}); // fresh token for the profile step
    await touchSession(req.db, sid, { _csrf: token });
    res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', secure: req.secure || getBool(req.settings, 'force_ssl', false), maxAge: 7 * 24 * 3600 * 1000 });
    return res.json({ ok: true, needsProfile: true, csrf: token });
  }
  return finishLogin(req, res, u, 'Welcome back!');
});

/* ---------- Complete profile (registration details for first-time users) ----------
   A first-time user who verified via OTP/password lands here BEFORE full login.
   This preserves the old register form's details (full name + terms agreement)
   inside the unified flow — no detail is lost, and returning users never see it.
   v16: the step is now PERSISTED (users.profile_completed) and enforced by a
   server gate (server.js) — previously it lived only in the session, so a
   user could dismiss the modal and play forever without a name or terms, and
   logging out lost the step entirely. The GET page below is the gate's
   destination, so an incomplete user always has a way to finish. */
router.get('/login/complete-profile', async (req, res) => {
  // v16: admit on the PERSISTENT flag, not the session flag — a user who
  // dismissed the modal and later logged back in has no session flag left,
  // but still has profile_completed=0. Gating on the session flag here
  // would redirect-loop them (gate -> page -> '/' -> gate ...).
  if (!req.user) return res.redirect('/login');
  const u = await req.db.get('SELECT profile_completed FROM users WHERE id = ?', [req.user.id]);
  if (u && Number(u.profile_completed) !== 0) return res.redirect('/');
  let token = req.sessionData._csrf;
  if (!token) {
    const { csrfToken: mkToken, touchSession: ts } = require('../lib/auth');
    token = mkToken({});
    await ts(req.db, req.sess.id, { _csrf: token });
  }
  res.render('complete_profile', { metaTitle: 'Complete Your Profile', metaDesc: '', csrf: token });
});
router.post('/login/complete-profile', async (req, res) => {
  if (!req.sess) return res.status(401).json({ ok: false, error: 'Session expired. Please sign in again.' });
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.sess.user_id]);
  if (!u) return res.status(401).json({ ok: false, error: 'Session expired. Please sign in again.' });
  // v16: accept EITHER the session flag (fresh OTP signup) or the persistent
  // flag (returning incomplete user) — but never a user who already completed.
  if (!req.sessionData.profile_pending && Number(u.profile_completed) !== 0)
    return res.status(401).json({ ok: false, error: 'Profile already complete.' });
  const name = String(req.body.name || '').trim();
  if (name.length < 2) return res.status(400).json({ ok: false, error: 'Please enter your full name.' });
  if (!req.body.agree) return res.status(400).json({ ok: false, error: 'Please accept the Terms & Privacy Policy.' });
  await req.db.run('UPDATE users SET name = ?, profile_completed = 1, terms_accepted_at = ? WHERE id = ?', [name, now(), u.id]);
  const { touchSession } = require('../lib/auth');
  await touchSession(req.db, req.sess.id, { profile_pending: null });
  await audit.log(req.db, { actorId: u.id, actorRole: 'player', action: 'user.profile_completed', entity: 'user', entityId: u.id, detail: { terms_accepted_at: now() }, ip: req.ip });
  notify.send(req.db, req.settings, 'email', 'welcome', u.email, { name }).catch(() => {});
  // v16: the page form posts as urlencoded (redirect), the modal posts JSON.
  if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
    await req.setFlash('success', 'Welcome! Your profile is complete.');
    return res.redirect('/');
  }
  return res.json({ ok: true, redirect: '/', firstName: name.split(' ')[0] });
});

/* ---------- Facebook OAuth ---------- */
router.get('/auth/facebook', async (req, res) => {
  const id = process.env.FACEBOOK_APP_ID;
  if (!getBool(req.settings, 'facebook_oauth_enabled', false) || !id)
    return res.status(503).render('error', { status: 503, message: 'Facebook sign-in is unavailable right now. Please try again later.' });
  const redirect = encodeURIComponent(baseUrl(req) + '/auth/facebook/callback'); // D2-C9: host fallback, never relative
  const state = randHex(12);
  // v16: ALWAYS store the state, even for logged-out visitors. The old code
  // only stored it when a session already existed, so an anonymous start
  // left the callback check skipped entirely (OAuth CSRF / login-CSRF).
  if (!req.sess) await anonSession(req, res);
  // U-22: a fully signed-in user starting OAuth is LINKING the provider
  // to their account (the in-account linking entry point) — remember
  // whose account the callback must link to, never switch accounts.
  await require('../lib/auth').touchSession(req.db, req.sess.id, { oauth_state: state, oauth_link_user_id: req.user ? req.user.id : null });
  res.redirect(`https://www.facebook.com/v18.0/dialog/oauth?client_id=${id}&redirect_uri=${redirect}&state=${state}&scope=email,public_profile`);
});
router.get('/auth/facebook/callback', async (req, res) => {
  try {
    const id = process.env.FACEBOOK_APP_ID, secret = process.env.FACEBOOK_APP_SECRET;
    if (!id || !secret) throw new Error('not configured');
    // v16: STRICT state check — a missing stored state now FAILS instead of
    // skipping validation, and the state is single-use (cleared after check).
    if (!req.sessionData.oauth_state || req.query.state !== req.sessionData.oauth_state) throw new Error('bad state');
    // U-22: capture linking intent BEFORE the single-use state is cleared.
    const linkUserId = (req.user && req.user.id) || req.sessionData.oauth_link_user_id || null;
    if (req.sess) await require('../lib/auth').touchSession(req.db, req.sess.id, { oauth_state: null, oauth_link_user_id: null });
    const redirect = baseUrl(req) + '/auth/facebook/callback'; // D2-C9: host fallback, never relative
    const tok = await fetch(`https://graph.facebook.com/v18.0/oauth/access_token?client_id=${id}&client_secret=${secret}&redirect_uri=${encodeURIComponent(redirect)}&code=${req.query.code}`, { signal: AbortSignal.timeout(8000) }); // DS-015: provider calls need a deadline
    const tj = await tok.json();
    if (!tj.access_token) throw new Error('token exchange failed');
    const me = await fetch(`https://graph.facebook.com/me?fields=id,name,email&access_token=${tj.access_token}`, { signal: AbortSignal.timeout(8000) }); // DS-015
    const profile = await me.json();
    if (!profile.id) throw new Error('no profile from Facebook');
    const providerId = String(profile.id);
    const emailLc = profile.email ? normalizeEmail(profile.email) : '';
    /* U-22 identity resolution. Facebook's /me response carries NO
       email-verification field, so an email-only match is an UNVERIFIED
       claim and must never merge (the old code signed the claimant into
       the existing account and linked their facebook_id to it). Trusted
       matches, in order: (1) a signed-in user's linking intent, (2) an
       already-recorded facebook_id. Email alone only CREATES a new
       account when it matches nobody. */
    let u = await req.db.get('SELECT * FROM users WHERE facebook_id = ?', [providerId]);
    const emailUser = emailLc ? await req.db.get('SELECT * FROM users WHERE email = ?', [emailLc]) : null;
    let linking = false;
    if (linkUserId) {
      const linkUser = await req.db.get('SELECT * FROM users WHERE id = ?', [linkUserId]);
      if (!linkUser) throw oauthFail('Your signed-in session has expired. Sign in again, then link Facebook from inside your account.');
      if (u && u.id !== linkUser.id) throw oauthFail('This Facebook account is already linked to a different account, so it cannot be linked to this one.');
      if (emailUser && emailUser.id !== linkUser.id) throw oauthFail('The email address on this Facebook account belongs to a different account, so it cannot be linked to this one. Sign in to that account if it is yours.');
      if (linkUser.facebook_id && linkUser.facebook_id !== providerId) throw oauthFail('A different Facebook account is already linked to this account.');
      u = linkUser; linking = true;
    } else if (!u && emailUser) {
      throw oauthFail(OAUTH_UNVERIFIED_EXISTING_MSG('Facebook'));
    } else if (!u) {
      // R-096: refuse no-email Facebook signups instead of inserting '' (the
      // second such user used to crash on the UNIQUE email column).
      if (!emailLc) throw new Error('Facebook account has no email address on file');
      if (!getBool(req.settings, 'registration_enabled', true)) throw new Error('registration disabled');
      const r = await req.db.run(
        'INSERT INTO users (email, phone, name, password_hash, role, status, facebook_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [emailLc, '', String(profile.name || 'Facebook User'), '', 'player', 'active', providerId, now()]);
      u = await req.db.get('SELECT * FROM users WHERE id = ?', [r.id]);
      await audit.log(req.db, { actorId: u.id, actorRole: 'player', action: 'user.register_oauth', entity: 'user', entityId: u.id, detail: { provider: 'facebook' }, ip: req.ip });
    }
    // OAuth must not bypass account-status checks or the TOTP step (the
    // Facebook callback previously checked neither).
    const { oauthAccountCheck, touchSession } = require('../lib/auth');
    const chk = oauthAccountCheck(u);
    if (!chk.ok) { await recordLogin(req, u.id, u.email || providerId, false); throw new Error(chk.error); }
    if (!u.facebook_id) {
      await req.db.run('UPDATE users SET facebook_id = ? WHERE id = ?', [providerId, u.id]);
      u.facebook_id = providerId;
      if (linking) await audit.log(req.db, { actorId: u.id, actorRole: 'player', action: 'user.oauth_linked', entity: 'user', entityId: u.id, detail: { provider: 'facebook' }, ip: req.ip });
    }
    if (chk.totpRequired && !linking) {
      if (!req.sess) await anonSession(req, res);
      // D2-C1 (v20): OAuth pre-auth stash — same TTL rule as password login.
      await touchSession(req.db, req.sess.id, { pending_user_id: u.id, pre_auth: true }, { ttlMs: PREAUTH_TTL });
      res.cookie('sid', req.sess.id, { httpOnly: true, sameSite: 'lax', secure: req.secure || getBool(req.settings, 'force_ssl', false), maxAge: PREAUTH_TTL });
      return res.render('login', {
        metaTitle: 'Two-Factor', metaDesc: '', totpRequired: true, emailPrefill: u.email || '',
        captchaHtml: '', recaptchaHtml: '', googleOn: false,
      });
    }
    await recordLogin(req, u.id, u.email || providerId, true);
    return finishLogin(req, res, u, linking ? 'Facebook is now linked to your account.' : 'Welcome back!');
  } catch (e) {
    console.error('[oauth] Facebook callback failed:', e.message);
    if (e.exposeMessage) return res.status(400).render('error', { status: 400, message: e.exposeMessage });
    return res.status(400).render('error', { status: 400, message: 'Facebook sign-in failed. Please try again.' });
  }
});

/* ---------- Google OAuth (ready; needs client ID/secret) ---------- */
router.get('/auth/google', async (req, res) => {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!getBool(req.settings, 'google_oauth_enabled', false) || !id)
    return res.status(503).render('error', { status: 503, message: 'Google sign-in is unavailable right now. Please try again later.' });
  const redirect = encodeURIComponent(baseUrl(req) + '/auth/google/callback'); // D2-C9: host fallback, never relative
  const state = randHex(12);
  // v16: same anonymous-start fix as Facebook (see above).
  if (!req.sess) await anonSession(req, res);
  // U-22: linking intent, same as the Facebook start route above.
  await require('../lib/auth').touchSession(req.db, req.sess.id, { oauth_state: state, oauth_link_user_id: req.user ? req.user.id : null });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${id}&redirect_uri=${redirect}&response_type=code&scope=openid%20email%20profile&state=${state}`);
});
router.get('/auth/google/callback', async (req, res) => {
  try {
    const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
    if (!id || !secret) throw new Error('not configured');
    // v16: STRICT single-use state check (see Facebook callback).
    if (!req.sessionData.oauth_state || req.query.state !== req.sessionData.oauth_state) throw new Error('bad state');
    // U-22: capture linking intent BEFORE the single-use state is cleared.
    const linkUserId = (req.user && req.user.id) || req.sessionData.oauth_link_user_id || null;
    if (req.sess) await require('../lib/auth').touchSession(req.db, req.sess.id, { oauth_state: null, oauth_link_user_id: null });
    const redirect = baseUrl(req) + '/auth/google/callback'; // D2-C9: host fallback, never relative
    const tok = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(8000), // DS-015: provider calls need a deadline
      body: new URLSearchParams({ code: req.query.code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' }).toString(),
    });
    const tj = await tok.json();
    if (!tj.access_token) throw new Error('token exchange failed');
    const me = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tj.access_token }, signal: AbortSignal.timeout(8000) }); // DS-015
    const profile = await me.json();
    const providerId = String(profile.id || profile.sub || '');
    const emailLc = profile.email ? normalizeEmail(profile.email) : '';
    /* U-22: only a STRICTLY verified email may identify an existing
       account. v16 refused an explicitly unverified one but silently
       trusted the email when the verified_email field was absent —
       absent now means unverified too. Trusted matches, in order:
       (1) a signed-in user's linking intent, (2) an already-recorded
       google_id, (3) a provider-verified email match. */
    const emailVerified = profile.verified_email === true;
    let u = providerId ? await req.db.get('SELECT * FROM users WHERE google_id = ?', [providerId]) : null;
    const emailUser = emailLc ? await req.db.get('SELECT * FROM users WHERE email = ?', [emailLc]) : null;
    let linking = false;
    if (linkUserId) {
      if (!providerId) throw new Error('no profile id from Google');
      const linkUser = await req.db.get('SELECT * FROM users WHERE id = ?', [linkUserId]);
      if (!linkUser) throw oauthFail('Your signed-in session has expired. Sign in again, then link Google from inside your account.');
      if (u && u.id !== linkUser.id) throw oauthFail('This Google account is already linked to a different account, so it cannot be linked to this one.');
      if (emailUser && emailUser.id !== linkUser.id) throw oauthFail('The email address on this Google account belongs to a different account, so it cannot be linked to this one. Sign in to that account if it is yours.');
      if (providerId && linkUser.google_id && linkUser.google_id !== providerId) throw oauthFail('A different Google account is already linked to this account.');
      u = linkUser; linking = true;
    } else if (!u && emailUser) {
      if (!emailVerified) throw oauthFail(OAUTH_UNVERIFIED_EXISTING_MSG('Google'));
      u = emailUser;
    } else if (!u) {
      if (!emailLc) throw new Error('no email from Google');
      if (!emailVerified) throw oauthFail(OAUTH_UNVERIFIED_NEW_MSG('Google'));
      if (!getBool(req.settings, 'registration_enabled', true)) throw new Error('registration disabled');
      // U-22: the provider link (google_id) is recorded from birth —
      // the old INSERT never wrote it, so no Google account was ever
      // actually linked and a changed Google email would twin.
      const r = await req.db.run(
        'INSERT INTO users (email, phone, name, password_hash, role, status, email_verified, google_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [emailLc, '', String(profile.name || emailLc.split('@')[0]), '', 'player', 'active', 1, providerId, now()]);
      u = await req.db.get('SELECT * FROM users WHERE id = ?', [r.id]);
      await audit.log(req.db, { actorId: u.id, actorRole: 'player', action: 'user.register_oauth', entity: 'user', entityId: u.id, detail: { provider: 'google' }, ip: req.ip });
    }
    // OAuth gate BEFORE any mutation of an existing account: previously
    // 'banned' was checked only after the email_verified update, and
    // pending_review/TOTP were never checked.
    const { oauthAccountCheck, touchSession } = require('../lib/auth');
    const chk = oauthAccountCheck(u);
    if (!chk.ok) { await recordLogin(req, u.id, emailLc, false); throw new Error(chk.error); }
    // U-22: record the provider link on an existing account (the column
    // existed since v1 but was never written for Google).
    if (providerId && !u.google_id) {
      await req.db.run('UPDATE users SET google_id = ? WHERE id = ?', [providerId, u.id]);
      u.google_id = providerId;
      if (linking) await audit.log(req.db, { actorId: u.id, actorRole: 'player', action: 'user.oauth_linked', entity: 'user', entityId: u.id, detail: { provider: 'google' }, ip: req.ip });
    }
    if (!u.email_verified && emailVerified && emailLc && u.email === emailLc) {
      // v16: an existing password-registered user who signs in via Google has
      // just proven ownership of this email — mark it verified so the
      // verified-contact gate (deposits/withdrawals) stops blocking them.
      // Previously they stayed unverified forever despite Google's proof.
      // U-22: only on Google's actual verification of THIS address.
      await req.db.run('UPDATE users SET email_verified = 1 WHERE id = ?', [u.id]);
      u.email_verified = 1;
    }
    if (chk.totpRequired && !linking) {
      if (!req.sess) await anonSession(req, res);
      // D2-C1 (v20): OAuth pre-auth stash — same TTL rule as password login.
      await touchSession(req.db, req.sess.id, { pending_user_id: u.id, pre_auth: true }, { ttlMs: PREAUTH_TTL });
      res.cookie('sid', req.sess.id, { httpOnly: true, sameSite: 'lax', secure: req.secure || getBool(req.settings, 'force_ssl', false), maxAge: PREAUTH_TTL });
      return res.render('login', {
        metaTitle: 'Two-Factor', metaDesc: '', totpRequired: true, emailPrefill: emailLc,
        captchaHtml: '', recaptchaHtml: '', googleOn: false,
      });
    }
    await recordLogin(req, u.id, emailLc, true);
    return finishLogin(req, res, u, linking ? 'Google is now linked to your account.' : undefined);
  } catch (e) {
    console.error('[oauth] Google callback failed:', e.message);
    if (e.exposeMessage) return res.status(400).render('error', { status: 400, message: e.exposeMessage });
    return res.status(400).render('error', { status: 400, message: 'Google sign-in failed. Please try again.' });
  }
});

module.exports = router;
module.exports.captchaHtml = captchaHtml;
/* ADMIN-LOGIN-01: the dedicated admin login (routes/admin.js) reuses
   the EXACT sign-in completion + history recording of the public flow
   — one implementation of session creation/lockout bookkeeping, two
   entrances. */
module.exports.finishLogin = finishLogin;
module.exports.recordLogin = recordLogin;
