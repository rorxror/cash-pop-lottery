'use strict';
/* First-run setup wizard. Permanently disabled once an admin account exists. */
const express = require('express');
const router = express.Router();
const { hashPassword, validEmail, now, randHex } = require('../lib/util');
const { setSetting } = require('../lib/settings');
const { createSession } = require('../lib/auth');
const audit = require('../lib/audit');

async function adminExists(db) {
  const r = await db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
  return !!r;
}

router.get('/setup', async (req, res) => {
  if (await adminExists(req.db)) return res.status(404).render('error', { status: 404, message: 'Setup is disabled.' });
  res.render('setup', { metaTitle: 'Setup', metaDesc: 'First-run setup' });
});

router.post('/setup', async (req, res) => {
  if (await adminExists(req.db)) return res.status(404).render('error', { status: 404, message: 'Setup is disabled.' });
  const { site_name, name, email, password, password2, base_currency } = req.body;
  const errors = [];
  if (!site_name || site_name.trim().length < 3) errors.push('Site name is required.');
  if (!name || name.trim().length < 2) errors.push('Your name is required.');
  if (!validEmail(email)) errors.push('A valid email is required.');
  if (!password || password.length < 8) errors.push('Password must be at least 8 characters.');
  if (password !== password2) errors.push('Passwords do not match.');
  if (errors.length) return res.render('setup', { metaTitle: 'Setup', metaDesc: 'First-run setup', formError: errors.join(' ') });

  const emailLc = email.trim().toLowerCase();
  try {
    const userId = await req.db.transaction(async (tx) => {
      const r = await tx.run(
        'INSERT INTO users (email, phone, name, password_hash, role, status, email_verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [emailLc, '', name.trim(), hashPassword(password), 'admin', 'active', 1, now()]
      );
      return r.id;
    });
    await setSetting(req.db, req.driver, 'site_name', site_name.trim());
    if (base_currency) await setSetting(req.db, req.driver, 'base_currency', String(base_currency).toUpperCase().slice(0, 8));
    await audit.log(req.db, { actorId: userId, actorRole: 'admin', action: 'setup.complete', entity: 'user', entityId: userId, detail: { site: site_name }, ip: req.ip });
    const sid = await createSession(req.db, userId, { ip: req.ip, ua: req.headers['user-agent'] });
    res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', secure: req.secure || process.env.FORCE_SSL === '1', maxAge: 7 * 24 * 3600 * 1000 });
    res.redirect(req.adminPath || '/');
  } catch (e) {
    res.render('setup', { metaTitle: 'Setup', metaDesc: 'First-run setup', formError: 'Setup failed: ' + e.message });
  }
});

module.exports = router;
