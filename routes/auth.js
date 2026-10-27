'use strict';
/* Authentication: login (+TOTP challenge), OTP-gated registration,
   logout, password reset, Google OAuth, custom captcha + reCAPTCHA hooks. */
const express = require('express');
const router = express.Router();
const { validEmail, hashPassword, verifyPassword, sha256, randHex, now, strongPassword, normalizeEmail, normalizePhone } = require('../lib/util');
const { getS, getBool, getCurrencies } = require('../lib/settings');
const { createSession, getSession, destroySession, rateLimit, verifyTotp, useBackupCode, parseUA, csrfToken, touchSession } = require('../lib/auth');
const { getExtension, extEnabled } = require('../lib/extensions');
const notify = require('../lib/notify');
const otpLib = require('../lib/otp');
const audit = require('../lib/audit');

/* ---------- custom captcha (math question, session-stored) ---------- */
async function anonSession(req, res) {
  // logged-out forms (login/register captcha, CSRF) need a session to persist
  if (req.sess) return;
  const sid = await createSession(req.db, 0, { ip: req.ip, ua: req.headers['user-agent'] || '' });
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
function checkCaptcha(req) {
  const ans = String(req.body.captcha_answer || '').trim();
  const ok = req.sessionData._captcha === sha256('captcha:' + ans + ':' + (req.sess ? req.sess.id : 'anon'));
  req.sessionData._captcha = null;
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
  const url = key === 'recaptcha' ? 'https://www.google.com/recaptcha/api/siteverify'
    : key === 'hcaptcha' ? 'https://hcaptcha.com/siteverify'
    : 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: ext.config.secret_key, response: token, remoteip: req.ip }).toString(),
    });
    const j = await r.json();
    return !!j.success;
  } catch { return false; }
}
/* Unified captcha check (v14): every ENABLED provider must verify; when no
   provider is enabled, verification passes (nothing to check). */
async function verifyCaptcha(req) {
  const capExt = await getExtension(req.db, 'custom_captcha');
  if (extEnabled(capExt) && !checkCaptcha(req)) return false;
  for (const key of ['recaptcha', 'hcaptcha', 'turnstile']) {
    const ext = await getExtension(req.db, key);
    if (!extEnabled(ext) || !ext.config.secret_key) continue;
    if (!(await verifyProvider(key, ext, req))) return false;
  }
  return true;
}

async function recordLogin(req, userId, email, success) {
  const { browser, os } = parseUA(req.headers['user-agent']);
  await req.db.run(
    'INSERT INTO login_history (user_id, email, ip, country, browser, os, success, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, email, req.ip, '', browser, os, success ? 1 : 0, now()]);
}

/* ---------- login ---------- */
router.get('/login', async (req, res) => {
  if (req.user) return res.redirect('/');
  const capExt = await getExtension(req.db, 'custom_captcha');
  if (extEnabled(capExt)) await anonSession(req, res);
  res.render('login', {
    phoneCountries: require('../lib/phone-countries').allowedCountries(req.settings),
    metaTitle: 'Sign In', metaDesc: 'Sign in to your account.',
    totpRequired: false, emailPrefill: '',
    captchaHtml: await captchaHtml(req), recaptchaHtml: await recaptchaHtml(req),
    googleOn: getBool(req.settings, 'google_oauth_enabled', false) && !!process.env.GOOGLE_CLIENT_ID,
    facebookOn: getBool(req.settings, 'facebook_oauth_enabled', false) && !!process.env.FACEBOOK_APP_ID,
    phoneOtpOn: getBool(req.settings, 'phone_otp_enabled', true),
    emailOtpOn: getBool(req.settings, 'email_otp_enabled', true),
    passwordOn: getBool(req.settings, 'password_login_enabled', false) || getBool(req.settings, 'phone_password_enabled', true) || getBool(req.settings, 'email_password_enabled', true),
    phonePwOn: getBool(req.settings, 'phone_password_enabled', true),
    emailPwOn: getBool(req.settings, 'email_password_enabled', true),
  });
});

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyFn: r => 'login:' + r.ip });

router.post('/login', loginLimiter, async (req, res) => {
  const render = async (vars = {}) => res.render('login', {
    metaTitle: 'Sign In', metaDesc: 'Sign in to your account.',
    totpRequired: false, emailPrefill: req.body.email || '',
    captchaHtml: await captchaHtml(req), recaptchaHtml: await recaptchaHtml(req),
    googleOn: getBool(req.settings, 'google_oauth_enabled', false) && !!process.env.GOOGLE_CLIENT_ID,
    formError: vars.formError,
  });
  if (!(await verifyCaptcha(req))) return render({ formError: 'Captcha verification failed.' });

  // TOTP challenge step
  if (req.body.totp_code && req.sessionData.pending_user_id) {
    const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.sessionData.pending_user_id]);
    if (!u) return render({ formError: 'Session expired. Please sign in again.' });
    // v16: per-user TOTP fail limit. The IP limiter (30/15min) does not stop
    // a distributed attack against ONE account; login_history already records
    // failures, so count them (password + TOTP failures together) and refuse
    // to even verify after 10 in 15 minutes.
    try {
      const fails = await req.db.get('SELECT COUNT(*) AS c FROM login_history WHERE user_id = ? AND success = 0 AND created_at > ?', [u.id, now() - 15 * 60 * 1000]);
      if (fails && Number(fails.c) >= 10) return render({ formError: 'Too many failed sign-in attempts. Please wait 15 minutes and try again.' });
    } catch {}
    let ok = verifyTotp(u.totp_secret, req.body.totp_code);
    let usedBackup = false;
    if (!ok && u.backup_codes) {
      const remaining = useBackupCode(u.backup_codes, req.body.totp_code);
      if (remaining !== null) { await req.db.run('UPDATE users SET backup_codes = ? WHERE id = ?', [remaining, u.id]); ok = true; usedBackup = true; }
    }
    if (!ok) { await recordLogin(req, u.id, u.email, false); return render({ formError: 'Invalid authenticator code.' });
    }
    const { touchSession } = require('../lib/auth');
    await touchSession(req.db, req.sess.id, { pending_user_id: null });
    return finishLogin(req, res, u);
  }

  // Sign In (returning players only): email/phone + password. Registration is separate
  // (/register collects full details) — a password sign-in never auto-creates an account.
  const isJson = (req.headers['content-type'] || '').includes('application/json');
  const jsonErr = (msg) => isJson ? res.status(401).json({ error: msg }) : render({ formError: msg });
  const email = String(req.body.email || '').trim().toLowerCase();
  const phone = String(req.body.phone || '').trim();
  const identifier = email || phone;
  let u = email
    ? await req.db.get('SELECT * FROM users WHERE email = ?', [email])
    : await req.db.get('SELECT * FROM users WHERE phone = ?', [phone]);
  if (!u) {
    await recordLogin(req, null, identifier, false);
    return jsonErr('No account found with this ' + (email ? 'email' : 'phone') + '. Please register first.');
  }
  if (!u.password_hash || !verifyPassword(req.body.password || '', u.password_hash)) {
    await recordLogin(req, null, identifier, false);
    return jsonErr('Invalid credentials. Please try again.');
  }
  if (u.status === 'banned') { await recordLogin(req, u.id, identifier, false); return jsonErr('This account has been blocked. Contact support.'); }
  if (u.status === 'pending_review') { await recordLogin(req, u.id, identifier, false); return jsonErr('Your account is pending review.'); }

  if (u.totp_secret) {
    // stash pending auth; need a session to hold it — create temp session
    const { touchSession } = require('../lib/auth');
    let sess = req.sess;
    if (!sess) {
      const sid = await createSession(req.db, u.id, { ip: req.ip, ua: req.headers['user-agent'], extra: { pending_user_id: u.id, pre_auth: true } });
      res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', secure: req.secure || getBool(req.settings, 'force_ssl', false), maxAge: 15 * 60 * 1000 });
      return res.render('login', {
        metaTitle: 'Two-Factor', metaDesc: '', totpRequired: true, emailPrefill: email,
        captchaHtml: '', recaptchaHtml: '', googleOn: false,
      });
    }
    await touchSession(req.db, sess.id, { pending_user_id: u.id, pre_auth: true });
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
  const sid = await createSession(req.db, u.id, { ip: req.ip, ua: req.headers['user-agent'], extra });
  if (req.sess) await destroySession(req.db, req.sess.id);
  await req.db.run('UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?', [now(), req.ip, u.id]);
  // Device/IP duplicate detection (v14): flags only, never blocks login.
  try {
    const { checkSharedDevice } = require('../lib/flags');
    await checkSharedDevice(req.db, u.id, req.ip, req.headers['user-agent'] || '');
  } catch {}
  res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', secure: req.secure || getBool(req.settings, 'force_ssl', false), maxAge: 7 * 24 * 3600 * 1000 });
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
    return res.status(403).render('error', { status: 403, message: 'Registration is currently disabled.' });
  if (req.user) return res.redirect('/');
  const capExt2 = await getExtension(req.db, 'custom_captcha');
  if (extEnabled(capExt2)) await anonSession(req, res);
  const { allowedCountries } = require('../lib/phone-countries');
  res.render('register', {
    metaTitle: 'Create Account', metaDesc: 'Create your Cash Pop account.',
    phoneCountries: allowedCountries(req.settings),
    refCode: String(req.query.ref || '').trim().toUpperCase(),
    otpEnabled: getBool(req.settings, 'otp_registration', false),
    captchaHtml: await captchaHtml(req), recaptchaHtml: await recaptchaHtml(req),
    googleOn: getBool(req.settings, 'google_oauth_enabled', false) && !!process.env.GOOGLE_CLIENT_ID,
  });
});

async function consumeOtpCode(db, code) {
  const rows = await db.query('SELECT * FROM otp_codes WHERE revoked = 0 AND (expires_at IS NULL OR expires_at > ?)', [now()]);
  for (const r of rows) {
    if (r.code_hash === sha256('otp:' + String(code).trim()) && r.uses < r.max_uses) {
      await db.run('UPDATE otp_codes SET uses = uses + 1 WHERE id = ?', [r.id]);
      return r;
    }
  }
  return null;
}

router.post('/register', rateLimit({ windowMs: 3600000, max: 20, keyFn: r => 'reg:' + r.ip }), async (req, res) => {
  const render = async (formError) => res.render('register', {
    metaTitle: 'Create Account', metaDesc: '', formError,
    otpEnabled: getBool(req.settings, 'otp_registration', false),
    captchaHtml: await captchaHtml(req), recaptchaHtml: await recaptchaHtml(req), googleOn: false,
  });
  if (!getBool(req.settings, 'registration_enabled', true)) return res.status(403).render('error', { status: 403, message: 'Registration is currently disabled.' });
  if (!(await verifyCaptcha(req))) return render('Captcha verification failed.');

  const { name, email, password, password_confirm, otp_code, agree } = req.body;
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

  if (getBool(req.settings, 'otp_registration', false)) {
    if (!otp_code || !(await consumeOtpCode(req.db, otp_code))) return render('Invalid or expired signup code. Ask the operator for a valid code.');
  }

  const emailLc = normalizeEmail(email);
  const ex = await req.db.get('SELECT id FROM users WHERE email = ?', [emailLc]);
  if (ex) return render('An account with this email already exists.');
  // Same phone, second account: blocked. (Password is NOT unique: a different
  // email/phone with the same password registers fine, as it should.)
  if (phone) {
    const exPhone = await req.db.get('SELECT id FROM users WHERE phone = ?', [phone]);
    if (exPhone) return render('An account with this phone number already exists.');
  }

  // Referral: ?ref=CODE on the register link credits the referrer (ViserLab-style)
  let referredBy = null;
  const refCode = String(req.query.ref || req.body.ref || '').trim().toUpperCase();
  if (refCode) {
    const ref = await req.db.get('SELECT id FROM users WHERE referral_code = ?', [refCode]);
    if (ref) referredBy = ref.id;
  }
  const r = await req.db.run(
    'INSERT INTO users (email, phone, name, password_hash, role, status, referred_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [emailLc, phone, name.trim(), hashPassword(password), 'player', 'active', referredBy, now()]);
  // Referral code for the new player (used in their invite link)
  await req.db.run('UPDATE users SET referral_code = ? WHERE id = ?', ['CP' + r.id.toString(36).toUpperCase(), r.id]);
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [r.id]);
  await audit.log(req.db, { actorId: u.id, actorRole: 'player', action: 'user.register', entity: 'user', entityId: u.id, detail: { email: emailLc }, ip: req.ip });
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
router.get('/forgot', (req, res) => res.render('forgot', { metaTitle: 'Reset Password', metaDesc: '', sent: false }));
router.post('/forgot', rateLimit({ windowMs: 3600000, max: 10, keyFn: r => 'forgot:' + r.ip }), async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = await req.db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (u) {
    const token = randHex(24);
    await req.db.run('INSERT INTO password_resets (user_id, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)',
      [u.id, sha256('reset:' + token), now() + 3600000, now()]);
    const link = (process.env.BASE_URL || '') + '/reset/' + token;
    await notify.send(req.db, req.settings, 'email', 'password_reset', email, { name: u.name, link }).catch(() => {});
  }
  res.render('forgot', { metaTitle: 'Reset Password', metaDesc: '', sent: true });
});
router.get('/reset/:token', async (req, res) => {
  const pr = await req.db.get('SELECT * FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > ?', [sha256('reset:' + req.params.token), now()]);
  if (!pr) return res.status(400).render('error', { status: 400, message: 'This reset link is invalid or expired.' });
  res.render('reset', { metaTitle: 'Set New Password', metaDesc: '', token: req.params.token });
});
router.post('/reset/:token', async (req, res) => {
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
  await req.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(req.body.password), pr.user_id]);
  await req.db.run('UPDATE password_resets SET used = 1 WHERE id = ?', [pr.id]);
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
  await req.db.run('UPDATE email_verifications SET used = 1 WHERE id = ?', [row.id]);
  await req.db.run('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?', [row.new_email, row.user_id]);
  await audit.log(req.db, { actorId: row.user_id, actorRole: 'player', action: 'user.email_verified', entity: 'user', entityId: row.user_id, detail: { via: 'link' }, ip: req.ip });
  try { await req.setFlash('success', 'Email verified. You can now deposit and withdraw.'); } catch {}
  res.redirect('/login');
});

/* ---------- OTP Login (phone/email, no password) ---------- */
router.post('/login/otp/request', loginLimiter, async (req, res) => {
  const idType = req.body.id_type === 'phone' ? 'phone' : 'email';
  const rawId = String(req.body.identifier || '').trim();
  const identifier = idType === 'phone' ? normalizePhone(rawId) : normalizeEmail(rawId);
  if (idType === 'email' && !validEmail(identifier))
    return res.status(400).json({ ok: false, error: 'Enter a valid email.' });
  if (idType === 'phone' && !/^\+?[0-9]{7,15}$/.test(identifier))
    return res.status(400).json({ ok: false, error: 'Enter a valid phone number.' });
  // Fail closed: OTP login is OFF unless the admin explicitly enabled it.
  if (idType === 'phone' && !getBool(req.settings, 'phone_otp_enabled', false))
    return res.status(400).json({ ok: false, error: 'Phone login is disabled.' });
  if (idType === 'email' && !getBool(req.settings, 'email_otp_enabled', false))
    return res.status(400).json({ ok: false, error: 'Email login is disabled.' });
  let code;
  try {
    code = await otpLib.createOtp(req.db, identifier, idType);
  } catch (e) {
    return res.status(429).json({ ok: false, error: e.message });
  }
  const result = await otpLib.sendOtp(req.db, req.settings, identifier, idType, code);
  await audit.log(req.db, { actorId: 0, actorRole: 'anon', action: 'otp.requested', entity: 'otp', entityId: '', detail: { idType, sent: result.sent }, ip: req.ip });
  // NEVER return the code: if no provider sent it, the user must see an
  // error, not a code that logs them in (previous demo-mode takeover hole).
  if (!result.sent) return res.status(503).json({ ok: false, error: 'Could not send the code. Please try again later or use your password.' });
  res.json({ ok: true, via: result.via });
});

router.post('/login/otp/verify', loginLimiter, async (req, res) => {
  const idType = req.body.id_type === 'phone' ? 'phone' : 'email';
  const rawId = String(req.body.identifier || '').trim();
  const identifier = idType === 'phone' ? normalizePhone(rawId) : normalizeEmail(rawId);
  const code = String(req.body.code || '').trim();
  const v = await otpLib.verifyOtp(req.db, identifier, idType, code);
  if (!v.ok) return res.status(400).json({ ok: false, error: v.error });
  // Find or create user. Phone: the same number with/without '+' is one identity,
  // so a form-registered +1555... account is found by a bare 1555... OTP login.
  let u = null;
  if (idType === 'phone') {
    const alt = identifier.startsWith('+') ? identifier.slice(1) : '+' + identifier;
    u = await req.db.get('SELECT * FROM users WHERE phone = ? OR phone = ?', [identifier, alt]);
  } else {
    u = await req.db.get('SELECT * FROM users WHERE email = ?', [identifier]);
  }
  let isNew = false;
  if (!u) {
    if (!getBool(req.settings, 'registration_enabled', true))
      return res.status(403).json({ ok: false, error: 'Registration is disabled.' });
    // Phone-only accounts have no real email. The email column is UNIQUE + NOT NULL,
    // so a second phone-only account used to crash on ''. Use an unroutable,
    // phone-derived placeholder instead (unique by construction: the phone itself
    // was just proven unused). Real email can be added to the profile later.
    const otpEmail = idType === 'email' ? identifier : 'phone' + identifier.replace(/\D/g, '') + '@phone.local';
    const r = await req.db.run(
      'INSERT INTO users (email, phone, name, password_hash, role, status, profile_completed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [otpEmail, idType === 'phone' ? identifier : '', identifier.split('@')[0], '', 'player', 'active', 0, now()]);
    u = await req.db.get('SELECT * FROM users WHERE id = ?', [r.id]);
    await audit.log(req.db, { actorId: u.id, actorRole: 'player', action: 'user.register_otp', entity: 'user', entityId: u.id, detail: { idType }, ip: req.ip });
    isNew = true;
  }
  // OTP login must be exactly as strict as password login: staff accounts
  // never log in by OTP, blocked/pending accounts stay out, and accounts
  // with authenticator 2FA must use password + TOTP (no 2FA bypass via OTP).
  if (u.role !== 'player') return res.status(403).json({ ok: false, error: 'Staff accounts cannot sign in with a code. Use your password.' });
  if (u.status === 'banned') { await recordLogin(req, u.id, identifier, false); return res.status(403).json({ ok: false, error: 'This account has been blocked. Contact support.' }); }
  if (u.status === 'pending_review') { await recordLogin(req, u.id, identifier, false); return res.status(403).json({ ok: false, error: 'Your account is pending review.' }); }
  if (u.totp_secret) { await recordLogin(req, u.id, identifier, false); return res.status(403).json({ ok: false, error: 'This account has two-factor authentication enabled. Please sign in with your password.' }); }
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
  await req.db.run('UPDATE users SET name = ?, profile_completed = 1 WHERE id = ?', [name, u.id]);
  const { touchSession } = require('../lib/auth');
  await touchSession(req.db, req.sess.id, { profile_pending: null });
  await audit.log(req.db, { actorId: u.id, actorRole: 'player', action: 'user.profile_completed', entity: 'user', entityId: u.id, detail: {}, ip: req.ip });
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
    return res.status(503).render('error', { status: 503, message: 'Facebook sign-in is not configured yet.' });
  const redirect = encodeURIComponent((process.env.BASE_URL || '') + '/auth/facebook/callback');
  const state = randHex(12);
  // v16: ALWAYS store the state, even for logged-out visitors. The old code
  // only stored it when a session already existed, so an anonymous start
  // left the callback check skipped entirely (OAuth CSRF / login-CSRF).
  if (!req.sess) await anonSession(req, res);
  await require('../lib/auth').touchSession(req.db, req.sess.id, { oauth_state: state });
  res.redirect(`https://www.facebook.com/v18.0/dialog/oauth?client_id=${id}&redirect_uri=${redirect}&state=${state}&scope=email,public_profile`);
});
router.get('/auth/facebook/callback', async (req, res) => {
  try {
    const id = process.env.FACEBOOK_APP_ID, secret = process.env.FACEBOOK_APP_SECRET;
    if (!id || !secret) throw new Error('not configured');
    // v16: STRICT state check — a missing stored state now FAILS instead of
    // skipping validation, and the state is single-use (cleared after check).
    if (!req.sessionData.oauth_state || req.query.state !== req.sessionData.oauth_state) throw new Error('bad state');
    if (req.sess) await require('../lib/auth').touchSession(req.db, req.sess.id, { oauth_state: null });
    const redirect = (process.env.BASE_URL || '') + '/auth/facebook/callback';
    const tok = await fetch(`https://graph.facebook.com/v18.0/oauth/access_token?client_id=${id}&client_secret=${secret}&redirect_uri=${encodeURIComponent(redirect)}&code=${req.query.code}`);
    const tj = await tok.json();
    if (!tj.access_token) throw new Error('token exchange failed');
    const me = await fetch(`https://graph.facebook.com/me?fields=id,name,email&access_token=${tj.access_token}`);
    const profile = await me.json();
    if (!profile.id) throw new Error('no profile from Facebook');
    let u = await req.db.get('SELECT * FROM users WHERE facebook_id = ?', [profile.id]);
    if (!u && profile.email) u = await req.db.get('SELECT * FROM users WHERE email = ?', [String(profile.email).toLowerCase()]);
    if (!u) {
      if (!getBool(req.settings, 'registration_enabled', true)) throw new Error('registration disabled');
      const r = await req.db.run(
        'INSERT INTO users (email, phone, name, password_hash, role, status, facebook_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [profile.email ? String(profile.email).toLowerCase() : '', '', String(profile.name || 'Facebook User'), '', 'player', 'active', profile.id, now()]);
      u = await req.db.get('SELECT * FROM users WHERE id = ?', [r.id]);
      await audit.log(req.db, { actorId: u.id, actorRole: 'player', action: 'user.register_oauth', entity: 'user', entityId: u.id, detail: { provider: 'facebook' }, ip: req.ip });
    } else if (!u.facebook_id) {
      await req.db.run('UPDATE users SET facebook_id = ? WHERE id = ?', [profile.id, u.id]);
    }
    await recordLogin(req, u.id, u.email || profile.id, true);
    return finishLogin(req, res, u, 'Welcome back!');
  } catch (e) {
    return res.status(400).render('error', { status: 400, message: 'Facebook sign-in failed: ' + e.message });
  }
});

/* ---------- Google OAuth (ready; needs client ID/secret) ---------- */
router.get('/auth/google', async (req, res) => {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!getBool(req.settings, 'google_oauth_enabled', false) || !id)
    return res.status(503).render('error', { status: 503, message: 'Google sign-in is not configured yet. The operator needs to add the Google OAuth credentials.' });
  const redirect = encodeURIComponent((process.env.BASE_URL || '') + '/auth/google/callback');
  const state = randHex(12);
  // v16: same anonymous-start fix as Facebook (see above).
  if (!req.sess) await anonSession(req, res);
  await require('../lib/auth').touchSession(req.db, req.sess.id, { oauth_state: state });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${id}&redirect_uri=${redirect}&response_type=code&scope=openid%20email%20profile&state=${state}`);
});
router.get('/auth/google/callback', async (req, res) => {
  try {
    const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
    if (!id || !secret) throw new Error('not configured');
    // v16: STRICT single-use state check (see Facebook callback).
    if (!req.sessionData.oauth_state || req.query.state !== req.sessionData.oauth_state) throw new Error('bad state');
    if (req.sess) await require('../lib/auth').touchSession(req.db, req.sess.id, { oauth_state: null });
    const redirect = (process.env.BASE_URL || '') + '/auth/google/callback';
    const tok = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: req.query.code, client_id: id, client_secret: secret, redirect_uri: redirect, grant_type: 'authorization_code' }).toString(),
    });
    const tj = await tok.json();
    if (!tj.access_token) throw new Error('token exchange failed');
    const me = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { Authorization: 'Bearer ' + tj.access_token } });
    const profile = await me.json();
    if (!profile.email) throw new Error('no email from Google');
    // v16: Google tells us whether it verified this email — refuse an
    // explicitly unverified one instead of trusting any returned address.
    if ('verified_email' in profile && !profile.verified_email) throw new Error('email not verified by Google');
    const emailLc = String(profile.email).toLowerCase();
    let u = await req.db.get('SELECT * FROM users WHERE email = ?', [emailLc]);
    if (!u) {
      if (!getBool(req.settings, 'registration_enabled', true)) throw new Error('registration disabled');
      const r = await req.db.run(
        'INSERT INTO users (email, phone, name, password_hash, role, status, email_verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [emailLc, '', String(profile.name || emailLc.split('@')[0]), '', 'player', 'active', 1, now()]);
      u = await req.db.get('SELECT * FROM users WHERE id = ?', [r.id]);
      await audit.log(req.db, { actorId: u.id, actorRole: 'player', action: 'user.register_oauth', entity: 'user', entityId: u.id, detail: { provider: 'google' }, ip: req.ip });
    } else if (!u.email_verified) {
      // v16: an existing password-registered user who signs in via Google has
      // just proven ownership of this email — mark it verified so the
      // verified-contact gate (deposits/withdrawals) stops blocking them.
      // Previously they stayed unverified forever despite Google's proof.
      await req.db.run('UPDATE users SET email_verified = 1 WHERE id = ?', [u.id]);
      u.email_verified = 1;
    }
    if (u.status === 'banned') throw new Error('account blocked');
    await recordLogin(req, u.id, emailLc, true);
    return finishLogin(req, res, u);
  } catch (e) {
    return res.status(400).render('error', { status: 400, message: 'Google sign-in failed: ' + e.message });
  }
});

module.exports = router;
module.exports.captchaHtml = captchaHtml;
