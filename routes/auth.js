'use strict';
/* Authentication: login (+TOTP challenge), OTP-gated registration,
   logout, password reset, Google OAuth, custom captcha + reCAPTCHA hooks. */
const express = require('express');
const router = express.Router();
const { validEmail, hashPassword, verifyPassword, sha256, randHex, now, strongPassword } = require('../lib/util');
const { getS, getBool, getCurrencies } = require('../lib/settings');
const { createSession, getSession, destroySession, rateLimit, verifyTotp, useBackupCode, parseUA, csrfToken, touchSession } = require('../lib/auth');
const { getExtension, extEnabled } = require('../lib/extensions');
const notify = require('../lib/notify');
const audit = require('../lib/audit');

/* ---------- custom captcha (math question, session-stored) ---------- */
async function anonSession(req, res) {
  // logged-out forms (login/register captcha, CSRF) need a session to persist
  if (req.sess) return;
  const sid = await createSession(req.db, 0, { ip: req.ip, ua: req.headers['user-agent'] || '' });
  res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', maxAge: 3600000 });
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
async function recaptchaHtml(req) {
  const ext = await getExtension(req.db, 'recaptcha');
  if (!extEnabled(ext) || !ext.config.site_key) return '';
  return `<div class="g-recaptcha" data-sitekey="${ext.config.site_key}"></div><script src="https://www.google.com/recaptcha/api.js" async defer></script>`;
}
async function checkRecaptcha(req) {
  const ext = await getExtension(req.db, 'recaptcha');
  if (!extEnabled(ext) || !ext.config.secret_key) return true; // not configured => skip
  const token = req.body['g-recaptcha-response'];
  if (!token) return false;
  try {
    const r = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: ext.config.secret_key, response: token, remoteip: req.ip }).toString(),
    });
    const j = await r.json();
    return !!j.success;
  } catch { return false; }
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
    metaTitle: 'Sign In', metaDesc: 'Sign in to your account.',
    totpRequired: false, emailPrefill: '',
    captchaHtml: await captchaHtml(req), recaptchaHtml: await recaptchaHtml(req),
    googleOn: getBool(req.settings, 'google_oauth_enabled', false) && !!process.env.GOOGLE_CLIENT_ID,
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
  if (!(await checkRecaptcha(req))) return render({ formError: 'Captcha verification failed.' });
  const capExt = await getExtension(req.db, 'custom_captcha');
  if (extEnabled(capExt) && !checkCaptcha(req)) return render({ formError: 'Wrong answer to the security check.' });

  // TOTP challenge step
  if (req.body.totp_code && req.sessionData.pending_user_id) {
    const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.sessionData.pending_user_id]);
    if (!u) return render({ formError: 'Session expired. Please sign in again.' });
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

  const email = String(req.body.email || '').trim().toLowerCase();
  const u = await req.db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!u || !u.password_hash || !verifyPassword(req.body.password || '', u.password_hash)) {
    await recordLogin(req, null, email, false);
    return render({ formError: 'Invalid email or password.' });
  }
  if (u.status === 'banned') { await recordLogin(req, u.id, email, false); return render({ formError: 'This account has been blocked. Contact support.' }); }
  if (u.status === 'pending_review') { await recordLogin(req, u.id, email, false); return render({ formError: 'Your account is pending review.' }); }

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

async function finishLogin(req, res, u) {
  // kill pre-auth flag if present
  const sid = await createSession(req.db, u.id, { ip: req.ip, ua: req.headers['user-agent'] });
  if (req.sess) await destroySession(req.db, req.sess.id);
  await req.db.run('UPDATE users SET last_login_at = ?, last_login_ip = ? WHERE id = ?', [now(), req.ip, u.id]);
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
router.get('/register', async (req, res) => {
  if (!getBool(req.settings, 'registration_enabled', true))
    return res.render('error', { status: 403, message: 'Registration is currently disabled.' });
  if (req.user) return res.redirect('/');
  const capExt2 = await getExtension(req.db, 'custom_captcha');
  if (extEnabled(capExt2)) await anonSession(req, res);
  res.render('register', {
    metaTitle: 'Create Account', metaDesc: 'Create your Cash Pop account.',
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
  if (!getBool(req.settings, 'registration_enabled', true)) return res.render('error', { status: 403, message: 'Registration is currently disabled.' });
  if (!(await checkRecaptcha(req))) return render('Captcha verification failed.');
  const capExt = await getExtension(req.db, 'custom_captcha');
  if (extEnabled(capExt) && !checkCaptcha(req)) return render('Wrong answer to the security check.');

  const { name, email, phone, password, password_confirm, otp_code, agree } = req.body;
  if (!name || name.trim().length < 2) return render('Please enter your name.');
  if (!validEmail(email)) return render('Please enter a valid email.');
  const pwErr = strongPassword(password, getBool(req.settings, 'secure_password', true));
  if (pwErr) return render(pwErr);
  if (password !== password_confirm) return render('Passwords do not match.');
  if (getBool(req.settings, 'policy_agreement', true) && !agree) return render('You must accept the terms to register.');

  if (getBool(req.settings, 'otp_registration', false)) {
    if (!otp_code || !(await consumeOtpCode(req.db, otp_code))) return render('Invalid or expired signup code. Ask the operator for a valid code.');
  }

  const emailLc = email.trim().toLowerCase();
  const ex = await req.db.get('SELECT id FROM users WHERE email = ?', [emailLc]);
  if (ex) return render('An account with this email already exists.');

  const r = await req.db.run(
    'INSERT INTO users (email, phone, name, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [emailLc, String(phone || '').trim(), name.trim(), hashPassword(password), 'player', 'active', now()]);
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [r.id]);
  await audit.log(req.db, { actorId: u.id, actorRole: 'player', action: 'user.register', entity: 'user', entityId: u.id, detail: { email: emailLc }, ip: req.ip });
  notify.send(req.db, req.settings, 'email', 'welcome', emailLc, { name: u.name }).catch(() => {});
  await recordLogin(req, u.id, emailLc, true);
  return finishLogin(req, res, u);
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
  if (!pr) return res.render('error', { status: 400, message: 'This reset link is invalid or expired.' });
  res.render('reset', { metaTitle: 'Set New Password', metaDesc: '', token: req.params.token });
});
router.post('/reset/:token', async (req, res) => {
  const pr = await req.db.get('SELECT * FROM password_resets WHERE token_hash = ? AND used = 0 AND expires_at > ?', [sha256('reset:' + req.params.token), now()]);
  if (!pr) return res.render('error', { status: 400, message: 'This reset link is invalid or expired.' });
  const pwErr = strongPassword(req.body.password, getBool(req.settings, 'secure_password', true));
  if (pwErr || req.body.password !== req.body.password2)
    return res.render('reset', { metaTitle: 'Set New Password', metaDesc: '', token: req.params.token, formError: pwErr || 'Passwords do not match.' });
  await req.db.run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(req.body.password), pr.user_id]);
  await req.db.run('UPDATE password_resets SET used = 1 WHERE id = ?', [pr.id]);
  const { destroyUserSessions } = require('../lib/auth');
  await destroyUserSessions(req.db, pr.user_id);
  await audit.log(req.db, { actorId: pr.user_id, actorRole: '', action: 'user.password_reset', entity: 'user', entityId: pr.user_id, detail: {}, ip: req.ip });
  res.redirect('/login');
});

/* ---------- Google OAuth (ready; needs client ID/secret) ---------- */
router.get('/auth/google', (req, res) => {
  const id = process.env.GOOGLE_CLIENT_ID;
  if (!getBool(req.settings, 'google_oauth_enabled', false) || !id)
    return res.render('error', { status: 503, message: 'Google sign-in is not configured yet. The operator needs to add the Google OAuth credentials.' });
  const redirect = encodeURIComponent((process.env.BASE_URL || '') + '/auth/google/callback');
  const state = randHex(12);
  if (req.sess) require('../lib/auth').touchSession(req.db, req.sess.id, { oauth_state: state });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${id}&redirect_uri=${redirect}&response_type=code&scope=openid%20email%20profile&state=${state}`);
});
router.get('/auth/google/callback', async (req, res) => {
  try {
    const id = process.env.GOOGLE_CLIENT_ID, secret = process.env.GOOGLE_CLIENT_SECRET;
    if (!id || !secret) throw new Error('not configured');
    if (req.sessionData.oauth_state && req.query.state !== req.sessionData.oauth_state) throw new Error('bad state');
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
    const emailLc = String(profile.email).toLowerCase();
    let u = await req.db.get('SELECT * FROM users WHERE email = ?', [emailLc]);
    if (!u) {
      if (!getBool(req.settings, 'registration_enabled', true)) throw new Error('registration disabled');
      const r = await req.db.run(
        'INSERT INTO users (email, phone, name, password_hash, role, status, email_verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [emailLc, '', String(profile.name || emailLc.split('@')[0]), '', 'player', 'active', 1, now()]);
      u = await req.db.get('SELECT * FROM users WHERE id = ?', [r.id]);
      await audit.log(req.db, { actorId: u.id, actorRole: 'player', action: 'user.register_oauth', entity: 'user', entityId: u.id, detail: { provider: 'google' }, ip: req.ip });
    }
    if (u.status === 'banned') throw new Error('account blocked');
    await recordLogin(req, u.id, emailLc, true);
    return finishLogin(req, res, u);
  } catch (e) {
    return res.render('error', { status: 400, message: 'Google sign-in failed: ' + e.message });
  }
});

module.exports = router;
module.exports.captchaHtml = captchaHtml;
