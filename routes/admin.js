'use strict';
/* Admin control room (mounted at the hidden ADMIN_PATH).
   Every action is audit-logged. Players can never reach these routes
   (requireRole('admin')), and player routes only ever query the
   logged-in user's own rows — role separation is enforced server-side. */
const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const { now, randHex, sha256, hashPassword, verifyPassword, normalizeEmail, validEmail, toMinor, esc, fromMinor, fmtMoney, decimalsFor, validSlug } = require('../lib/util');
const { getS, getBool, setSetting, getCurrencies, getSettings, keyCol } = require('../lib/settings');
const { requireLogin, requireRole, createSession, destroySession, destroyUserSessions, verifyTotp, rateLimit, getSession, csrfToken, touchSession, useBackupCode, verifyTotpStep, setSessionCookie, ANON_TTL, PREAUTH_TTL } = require('../lib/auth');
const { decideDeposit, decideWithdrawal, getBalances, postLedger, markWithdrawalPaid, settleAgentCommissions, releaseReferralCredits, decodeUserData } = require('../lib/money');
const { RAILS, getRail, isBlockedRail, validateRailCredentials } = require('../lib/rails');
const { getExtensions, setExtension, EXTENSION_FIELDS } = require('../lib/extensions');
const { ensureUpcomingDraws, createTestDraw, settleDraw, cancelDraw, publicDrawInfo } = require('../lib/draws');
const { runNow } = require('../lib/cron');
const notify = require('../lib/notify');
const audit = require('../lib/audit');
const ui = require('../lib/admin-ui');
const kycLib = require('../lib/kyc');
const uploadLib = require('../lib/upload');
const engine = require('../lib/prize-engine');
const { rbacMiddleware } = require('../lib/rbac');
const { runReconciliation } = require('../lib/reconcile');
const { encryptField, decryptField, keyConfigured } = require('../lib/credentials');
const { isBreached, breachedCheckFailedRecently } = require('../lib/breached');
const { passwordError } = require('../lib/validate');

/* ================= ADMIN-LOGIN-01: dedicated admin entrance =======
   Owner's explicit order (2026-10-29, ViserLab pattern): the EXACT
   admin root serves a dedicated admin-branded login page instead of
   the plain 404 it used to give. The secrecy model changes at this
   ONE point only: the path itself is the secret (same model as the
   reference scripts). EVERY other admin path keeps the stealth 404 +
   probe logging below, the public site still carries zero references
   to this path, and the public /login remains a working fallback
   entrance for admins (finishLogin auto-redirects them here).
   The login creates sessions in the ADMIN scope only (SESSION-TAB-01)
   and reuses the public flow's finishLogin/recordLogin so lockout,
   one-time TOTP claims and session rules stay identical. Captcha is
   deliberately not used here: the controls are the secret path, the
   IP rate limit and the per-account lockout (both mirrored from the
   public flow), plus TOTP where enrolled. */
function adminLoginPage(req, { formError = '', totpRequired = false, emailPrefill = '' } = {}) {
  const siteName = getS(req.settings, 'site_name', 'Cash Pop');
  const csrf = req.csrfToken || (req.sessionData ? csrfToken(req.sessionData) : '');
  /* Layout reference (2026-10-29 observation of the RaffleLab demo
     LOGIN page only — its inner pages were not entered): full-screen
     bare page, ONE narrow centered card, a header band with a welcome
     heading + one-line subline, Username/Email -> Password -> one
     full-width button, "Forgot Password?" right-aligned on the
     Password label row, labels above fields with required asterisks,
     nothing else. Content, words and colors are OURS (Apple light
     premium, gold band) — never their dark vendor theme. */
  const band = (h, sub) => `<div class="alogin-band"><h1 class="alogin-h">${h}</h1><p class="alogin-sub">${sub}</p></div>`;
  const inner = totpRequired
    ? band('Two-factor authentication', `Enter the 6-digit code from your authenticator app${emailPrefill ? ` for <strong>${esc(emailPrefill)}</strong>` : ''}.`) + `
       ${formError ? `<div class="alert a-err">${esc(formError)}</div>` : ''}
       <form method="post" action="${req.adminPath}/login">
         <input type="hidden" name="_csrf" value="${esc(csrf)}">
         <div class="field"><label for="al-code">Authenticator code *</label><input class="input" id="al-code" name="totp_code" inputmode="numeric" autocomplete="one-time-code" required autofocus></div>
         <button class="btn btn-p alogin-btn" type="submit">Verify &amp; sign in</button>
       </form>`
    : band('Welcome to the Control Room', `Sign in to the ${esc(siteName)} operator console.`) + `
       ${formError ? `<div class="alert a-err">${esc(formError)}</div>` : ''}
       <form method="post" action="${req.adminPath}/login">
         <input type="hidden" name="_csrf" value="${esc(csrf)}">
         <div class="field"><label for="al-email">Email *</label><input class="input" id="al-email" name="email" type="email" autocomplete="username" value="${esc(emailPrefill)}" required autofocus></div>
         <div class="field"><div class="alogin-labelrow"><label for="al-pass">Password *</label><a href="/forgot">Forgot password?</a></div><input class="input" id="al-pass" name="password" type="password" autocomplete="current-password" required></div>
         <button class="btn btn-p alogin-btn" type="submit">Sign in</button>
       </form>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>Control Room — ${esc(siteName)}</title>
<link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/admin.css">
<style>
  body.alogin-body { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
  .alogin-card { width: 100%; max-width: 400px; background: var(--card); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 0 26px 26px; box-shadow: 0 12px 40px rgba(60,45,10,.10); overflow: hidden; }
  .alogin-band { margin: 0 -26px 20px; padding: 22px 26px 16px; background: linear-gradient(135deg, #fdf6e0, #f7e7bd); border-bottom: 1px solid var(--line); }
  .alogin-h { font-size: 22px; margin: 0 0 4px; }
  .alogin-sub { color: var(--ink-2); margin: 0; }
  .alogin-btn { width: 100%; min-height: 48px; margin-top: 6px; }
  .alogin-labelrow { display: flex; justify-content: space-between; align-items: baseline; }
  .alogin-labelrow a { font-size: var(--fs-sm); }
  .alogin-card .field { margin-bottom: 14px; }
  .alogin-card .input { min-height: 48px; }
</style></head>
<body class="alogin-body"><main class="alogin-card">${inner}</main></body></html>`;
}
async function adminAnonSession(req, res) {
  if (req.sess) return;
  const sid = await createSession(req.db, 0, { ip: req.ip, ua: req.headers['user-agent'] || '', ttlMs: ANON_TTL, scope: 'admin' });
  setSessionCookie(res, 'admin', sid, ANON_TTL, req.secure || getBool(req.settings, 'force_ssl', false));
  const sess = await getSession(req.db, sid);
  req.sess = sess; req.sessionData = sess ? sess.data : {};
  req.csrfToken = csrfToken(req.sessionData);
  await touchSession(req.db, sid, { _csrf: req.sessionData._csrf });
}
const { finishLogin, recordLogin } = require('./auth');
async function auditAdminLogin(req, u, ok, via) {
  try { await audit.log(req.db, { actorId: u ? u.id : null, actorRole: ok ? 'admin' : 'anonymous', action: 'admin.login', entity: 'user', entityId: u ? String(u.id) : '', detail: { ok, via }, ip: req.ip }); } catch {}
}
router.get('/', async (req, res, next) => {
  if (req.user && req.user.role === 'admin') return next(); // dashboard handler below
  await adminAnonSession(req, res);
  const pending = req.sessionData && req.sessionData.pending_user_id;
  res.send(adminLoginPage(req, { totpRequired: !!pending }));
});
const adminLoginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, keyFn: r => 'admin-login:' + r.ip });
router.post('/login', adminLoginLimiter, async (req, res) => {
  const render = (vars) => res.send(adminLoginPage(req, vars));
  const pendSess = (req.sessionData && req.sessionData.pending_user_id) ? req.sess : null;
  const pendingUid = pendSess ? pendSess.data.pending_user_id : null;
  /* --- TOTP second step (mirrors the public flow's one-time claim) --- */
  if (req.body.totp_code && pendingUid) {
    const u = await req.db.get('SELECT * FROM users WHERE id = ?', [pendingUid]);
    if (!u || u.role !== 'admin') return render({ formError: 'Session expired. Please sign in again.' });
    try {
      const fails = await req.db.get('SELECT COUNT(*) AS c FROM login_history WHERE user_id = ? AND success = 0 AND created_at > ?', [u.id, now() - 15 * 60 * 1000]);
      if (fails && Number(fails.c) >= 10) return render({ totpRequired: true, formError: 'Too many failed sign-in attempts. Please wait 15 minutes and try again.' });
    } catch { return render({ totpRequired: true, formError: 'Sign-in temporarily unavailable. Please try again.' }); }
    let ok = false;
    const matchedStep = verifyTotpStep(u.totp_secret, req.body.totp_code);
    if (matchedStep !== null && matchedStep > Number(u.totp_last_step == null ? -1 : u.totp_last_step)) {
      const claim = await req.db.run('UPDATE users SET totp_last_step = ? WHERE id = ? AND COALESCE(totp_last_step, -1) < ?', [matchedStep, u.id, matchedStep]);
      if (claim.changes === 1) ok = true;
    }
    if (!ok && u.backup_codes) {
      const remaining = useBackupCode(u.backup_codes, req.body.totp_code);
      if (remaining !== null) {
        const upd = await req.db.run('UPDATE users SET backup_codes = ? WHERE id = ? AND backup_codes = ?', [remaining, u.id, u.backup_codes]);
        if (upd.changes === 1) ok = true;
      }
    }
    if (!ok) { await recordLogin(req, u.id, u.email, false); await auditAdminLogin(req, u, false, 'totp'); return render({ totpRequired: true, formError: 'Invalid authenticator code.' }); }
    await recordLogin(req, u.id, u.email, true);
    await auditAdminLogin(req, u, true, 'totp');
    return finishLogin(req, res, u);
  }
  /* --- password step: ONE generic failure for everything (no account,
     player account, wrong password, banned — indistinguishable) --- */
  const email = normalizeEmail(String(req.body.email || ''));
  const fail = async (u) => { await recordLogin(req, u ? u.id : null, email, false); await auditAdminLogin(req, u, false, 'password'); return render({ formError: 'Invalid credentials.', emailPrefill: email }); };
  const u = email ? await req.db.get('SELECT * FROM users WHERE email = ?', [email]) : null;
  if (!u || u.role !== 'admin') return fail(u);
  try {
    const fails = await req.db.get('SELECT COUNT(*) AS c FROM login_history WHERE user_id = ? AND success = 0 AND created_at > ?', [u.id, now() - 15 * 60 * 1000]);
    if (fails && Number(fails.c) >= 10) return fail(u);
  } catch { return fail(u); }
  if (!u.password_hash || !verifyPassword(req.body.password || '', u.password_hash)) return fail(u);
  if (u.status === 'banned' || u.status === 'pending_review') return fail(u);
  if (u.totp_secret) {
    await adminAnonSession(req, res);
    await touchSession(req.db, req.sess.id, { pending_user_id: u.id, pre_auth: true }, { ttlMs: PREAUTH_TTL });
    setSessionCookie(res, 'admin', req.sess.id, PREAUTH_TTL, req.secure || getBool(req.settings, 'force_ssl', false));
    return render({ totpRequired: true, emailPrefill: email });
  }
  await recordLogin(req, u.id, email, true);
  await auditAdminLogin(req, u, true, 'password');
  return finishLogin(req, res, u);
});

/* STEALTH: the admin panel must not exist for anyone but a logged-in admin.
   Logged-out visitors used to be redirected to /login and logged-in players
   got 403 — both responses CONFIRM an admin area lives at this URL. Now any
   non-admin request to any admin path gets a plain 404, identical to a
   nonexistent page: no login form, no "access denied", no signal at all.
   Probes are recorded in the audit trail. The existing guards stay behind
   this as a second layer. */
router.use(async (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') {
    try {
      await audit.log(req.db, { actorId: null, actorRole: 'anonymous', action: 'admin.probe', entity: 'admin', entityId: '', detail: { path: req.path }, ip: req.ip });
    } catch (e) { /* audit failure must never reveal the panel */ }
    return res.status(404).render('error', { status: 404, message: 'Page not found.' });
  }
  next();
});
router.use(requireLogin, requireRole('admin'));

/* SESSION-TAB-01: panel sign-out. The panel's Sign out posts HERE (not
   to the site /logout): this request runs on an admin path, so
   loadSession loaded the ADMIN-scope session — destroying it and
   clearing sid_admin leaves any player/site session in the same
   browser completely untouched, and vice versa. */
router.post('/logout', async (req, res) => {
  if (req.sess) await destroySession(req.db, req.sess.id);
  res.clearCookie('sid_admin');
  res.redirect('/login');
});
/* v14 RBAC: views (GET) are readable by all staff roles; ACTIONS enforce the
   role map in lib/rbac.js (finance = money, support = tickets, risk = user
   safety + draws + flags, super = everything). Stealth above still runs
   first, so outsiders never see a 403 — only the plain 404. */
router.use(rbacMiddleware);
/* Numeric :id guard: every admin :id param is a numeric DB id (public ids use
   :publicId, content uses :key). A crafted non-numeric id (e.g. empty) would
   otherwise reach Postgres as '' and 500 with 22P02 — return 404 instead. */
router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) return notFound(req, res, 'Not found.');
  next();
});

/* ---------- helpers ---------- */
function adminPath(req) { return req.adminPath; }
function R(req, p) { return adminPath(req) + p; }
function pageOf(req, def = 1) { return Math.max(1, parseInt(req.query.page, 10) || def); }
const PER = 25;
function dateRange(req) {
  // R-061: invalid dates used to become NaN and silently empty every report;
  // an unbounded range ran 5 queries PER DAY. Invalid input now errors, and
  // the range caps at 366 days (the caller shows the cap note).
  let to = req.query.to ? new Date(req.query.to + 'T23:59:59').getTime() : now();
  let from = req.query.from ? new Date(req.query.from + 'T00:00:00').getTime() : to - 30 * 86400000;
  let error = null, capped = false;
  /* U-20.1: an invalid date used to flow NaN into fmtDateInput() when the
     handler rendered its own error state — RangeError -> 500, so the
     "Invalid date range" branch was unreachable. Substitute a safe
     default range for rendering; the error message still shows. */
  if (Number.isNaN(to) || Number.isNaN(from)) { error = 'Invalid date range.'; to = now(); from = to - 30 * 86400000; }
  else if (from > to) error = 'Start date must be before end date.';
  else if (to - from > 366 * 86400000) { from = to - 366 * 86400000; capped = true; }
  return { from, to, error, capped };
}
function fmtDateInput(ms) { const d = new Date(ms); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10); }
function d(ms) { return ms ? `<span class="dt">${new Date(ms).toLocaleString()}</span>` : '—'; } // MESH-ID-01: dates never split mid-value
function dPlain(ms) { return ms ? new Date(ms).toLocaleString() : '—'; } // plain-text twin of d() for ESCAPED contexts (card titles are esc()'d by ui.card)

/* ================= AUDIT-DETAIL-01: readable audit details =======
   The audit Detail cell used to be the raw stored JSON string,
   blindly slice(0,120)'d and wrapped mid-token by the prose .code
   rule — unreadable, and silently LOSSY past 120 chars (which breaks
   the everything-real rule: an audit row the operator cannot read is
   a broken audit). Now the detail is parsed and rendered as compact
   humanized key–value lines, LOSSLESS (every key appears), with the
   original JSON kept one click away under a "raw" toggle.
   Money formatting: ONLY the keys below, each verified at its
   audit.log call site to be minor units (cents) — ticket.buy
   wager/total, deposit/withdrawal decision amount (= net), balance
   adjust amount + old/new_balance, BP-22 limit_minor, scratch/draw
   liability + cap. A key not on this list stays a plain number: a
   unit is never guessed. Currency comes from the detail's own
   currency key when present, else the base currency. */
const AUDIT_MONEY_KEYS = new Set(['amount', 'wager', 'total', 'net', 'old_balance', 'new_balance', 'limit_minor', 'liability', 'max_liability', 'expected_liability', 'cap']);
function humanKey(k) {
  const spaced = String(k).replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim().toLowerCase();
  return spaced.replace(/^./, c => c.toUpperCase()); // sentence case: drawType -> "Draw type"
}
function auditScalar(req, key, v, currency) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'number') {
    if (AUDIT_MONEY_KEYS.has(key)) return esc(money(req, v, currency));
    if (/_at$/.test(key) && v > 1e11) return d(v);
    if (/pct|percent/i.test(key)) return esc(String(v)) + '%';
    return esc(String(v));
  }
  return esc(String(v));
}
function auditLines(req, obj, currency, prefix, out) {
  for (const [k, v] of Object.entries(obj)) {
    const label = prefix ? prefix + ' — ' + humanKey(k) : humanKey(k);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 2 && keys.includes('from') && keys.includes('to')) {
        out.push([label, auditScalar(req, k, v.from, currency) + ' → ' + auditScalar(req, k, v.to, currency)]);
      } else {
        auditLines(req, v, currency, label, out);
      }
    } else if (Array.isArray(v)) {
      out.push([label, `<span class="aud-arr">${v.map(x => auditScalar(req, k, x, currency)).join(', ')}</span>`]);
    } else {
      out.push([label, auditScalar(req, k, v, currency)]);
    }
  }
  return out;
}
function auditDetailHtml(req, raw) {
  const text = raw === null || raw === undefined ? '' : String(raw);
  if (!text) return '<span class="muted">—</span>';
  let obj = null;
  try { const p = JSON.parse(text); if (p && typeof p === 'object' && !Array.isArray(p)) obj = p; } catch {}
  if (!obj) return `<span class="aud-txt">${esc(text)}</span>`; // legacy non-JSON detail: full text, escaped, never truncated
  const currency = obj.currency || getS(req.settings, 'base_currency', 'USD');
  const lines = auditLines(req, obj, currency, '', []);
  const render = ls => ls.map(([k, v]) => `<div class="aud-line"><span class="aud-k">${esc(k)}</span> <span class="aud-v">${v}</span></div>`).join('');
  if (lines.length <= 5) return `<div class="aud-lines">${render(lines)}</div>`; // <=5 lines (the common rows, e.g. ticket.buy) read fully with no click
  const n = Object.keys(obj).length;
  return `<div class="aud-lines">${render(lines.slice(0, 3))}</div>` +
    `<details class="aud-more"><summary>View detail (${n} fields)</summary><div class="aud-lines">${render(lines)}</div>` +
    `<details class="aud-rawwrap"><summary>raw</summary><pre class="aud-raw">${esc(JSON.stringify(obj))}</pre></details></details>`;
}
function auditEntityHtml(a) {
  const ref = a.entity_id === null || a.entity_id === undefined || a.entity_id === '' ? '—' : String(a.entity_id);
  return `<div class="aud-ent">${esc(humanKey(a.entity || ''))}</div><span class="code">${esc(ref)}</span>`;
}
function money(req, minor, cur) { return req.fmt(minor, cur); }
/* R-055: corrupt JSON in one row must never crash a whole admin page (the
   ticket detail page already guarded this; list/dashboard/report did not). */
function safeJsonArray(s) { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
/* Shared by the agent-fund route and the maker-checker approval executor. */
async function fundAgentFloat(db, agentId, currency, amount) {
  const ex = await db.get('SELECT * FROM agent_floats WHERE agent_id = ? AND currency = ?', [agentId, currency]);
  if (ex) await db.run('UPDATE agent_floats SET balance = balance + ? WHERE agent_id = ? AND currency = ?', [amount, agentId, currency]);
  else await db.run('INSERT INTO agent_floats (agent_id, currency, balance) VALUES (?, ?, ?)', [agentId, currency, amount]);
}
/* Per-currency pending stakes for one draw (threshold math for maker-checker
   on settle/cancel). Refund/stake share = ticket.total / entry count, the
   same basis cancelDraw refunds on - NOT wager alone, and NOT num_draws:
   num_draws is the per-type count, so a BOTH ticket (2x entries) would be
   double-counted (DS-002). */
async function drawEntrySums(db, drawId) {
  const entries = await db.query(
    `SELECT t.pops, t.wager, t.total, t.num_draws, t.currency, te.ticket_id FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id
     WHERE te.draw_id = ? AND te.status = 'pending'`, [drawId]);
  const entryCounts = {};
  for (const e of entries) {
    if (entryCounts[e.ticket_id] === undefined) {
      const c = await db.get('SELECT COUNT(*) AS c FROM ticket_entries WHERE ticket_id = ?', [e.ticket_id]);
      entryCounts[e.ticket_id] = Number(c && c.c) || 0;
    }
  }
  const perCur = {};
  for (const e of entries) {
    const n = entryCounts[e.ticket_id] || 0;
    let share;
    if (n > 0) share = Math.round(Number(e.total) / n);
    else share = Number(e.wager) * safeJsonArray(e.pops).length;
    perCur[e.currency] = (perCur[e.currency] || 0) + share;
  }
  return perCur;
}
function maxCurEntry(perCur, fallbackCur) {
  let amt = 0, cur = fallbackCur;
  for (const [c, v] of Object.entries(perCur)) if (v > amt) { amt = v; cur = c; }
  return { amt, cur };
}
/* Players refunded by a draw cancel, for the cancellation notice (R-025). */
async function notifyDrawCancelled(db, settings, drawId) {
  const users = await db.query(
    `SELECT DISTINCT u.email, u.name FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id JOIN users u ON u.id = t.user_id
     WHERE te.draw_id = ? AND te.status = 'refunded'`, [drawId]);
  for (const u of users) {
    if (u.email) notify.send(db, settings, 'email', 'draw_cancelled', u.email, { name: u.name }).catch(() => {});
  }
}
async function csrf(req) { return req.csrfToken; }

function shell(req, section, title, body, subtitle = '') {
  /* U-26: the sidebar is grouped and filtered by staff role (see
     lib/admin-ui.js NAV_GROUPS). Rendering only — rbac.js is untouched.
     ADMIN-CLARITY-01: optional one-line page purpose under the title,
     so the panel explains itself at a glance. */
  const role = (req.user && (req.user.admin_role || 'super')) || 'super';
  return ui.layout({ adminPath: adminPath(req), section, title, body, csrf: req.csrfToken, flash: req.flashData || {}, assetV: req.app.locals.assetV || '1', role, subtitle });
}
const isSuperReq = (req) => ((req.user && (req.user.admin_role || 'super')) || 'super') === 'super';
const notFound = (req, res, msg) => res.status(404).send(shell(req, '', 'Not found', `<div class="alert a-err">${esc(msg)}</div>`));

/* ============================================================
   DASHBOARD — exposure + profit projections (admin only)
   ============================================================ */
router.get('/', async (req, res) => {
  const t = now(), day = t - 86400000;
  const users = await req.db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'player'");
  const ticketsToday = await req.db.get('SELECT COUNT(*) AS c, COALESCE(SUM(total),0) AS s FROM tickets WHERE created_at > ?', [day]);
  const winsToday = await req.db.query("SELECT currency, COALESCE(SUM(amount),0) AS s FROM transactions WHERE type IN ('win','scratch_prize') AND created_at > ? GROUP BY currency", [day]); // CURRENCY-SYSTEM-01: per-currency
  const stakedToday = await req.db.query('SELECT currency, COALESCE(SUM(total),0) AS s FROM tickets WHERE created_at > ? GROUP BY currency', [day]);
  const pendDep = await req.db.get("SELECT COUNT(*) AS c FROM deposits WHERE status = 'pending'");
  const pendWd = await req.db.get("SELECT COUNT(*) AS c FROM withdrawals WHERE status = 'pending'");
  const openSup = await req.db.get("SELECT COUNT(*) AS c FROM support_tickets WHERE status = 'open' AND deleted_at IS NULL");
  const pendAppr = await req.db.get("SELECT COUNT(*) AS c FROM pending_approvals WHERE status = 'open'");
  const openFlags = await req.db.get('SELECT COUNT(*) AS c FROM account_flags WHERE reviewed_at IS NULL');
  const lastRecon = await req.db.get('SELECT * FROM reconciliation_reports ORDER BY checked_at DESC LIMIT 1');

  // Exposure: money staked per number on upcoming draws — one query for
  // all draws, grouped in JS (R-069; the old code queried per draw).
  const upcoming = await req.db.query("SELECT * FROM draws WHERE status = 'scheduled' ORDER BY close_at LIMIT 14");
  const expEntries = upcoming.length ? await req.db.query(
    `SELECT te.draw_id, t.pops, t.wager FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id
     WHERE te.draw_id IN (${upcoming.map(() => '?').join(',')}) AND te.status = 'pending'`,
    upcoming.map(d => d.id)) : [];
  const expByDraw = {};
  for (const e of expEntries) (expByDraw[e.draw_id] = expByDraw[e.draw_id] || []).push(e);
  const expRows = [];
  for (const dr of upcoming) {
    const per = Array(16).fill(0); let staked = 0;
    for (const e of (expByDraw[dr.id] || [])) {
      const pops = safeJsonArray(e.pops); // R-055: corrupt pops must not crash the dashboard
      for (const p of pops) per[p] += e.wager;
      staked += pops.length * e.wager;
    }
    expRows.push({ draw: dr, per, staked });
  }
  // Profit projection per upcoming draw: expected payout = staked * avg(mult/15)
  const prizes = await req.db.query('SELECT pops_count, multiplier FROM prize_table');
  const avgRtp = prizes.reduce((a, r) => a + r.multiplier / 15, 0) / Math.max(1, prizes.length);
  const expTable = ui.table(
    ['Draw', 'Staked', 'Top exposure #', 'Top exposure', 'Proj. payout', 'Proj. profit'],
    expRows.map(({ draw: dr, per, staked }) => {
      let topN = 1, topV = 0;
      for (let n = 1; n <= 15; n++) if (per[n] > topV) { topV = per[n]; topN = n; }
      const payout = Math.round(staked * avgRtp), profit = staked - payout;
      return [
        `${dr.draw_type} ${esc(dr.draw_date)}`,
        money(req, staked, getS(req.settings, 'base_currency', 'USD')),
        `<span class="ball-sm">${topN}</span>`,
        money(req, topV, getS(req.settings, 'base_currency', 'USD')),
        money(req, payout, getS(req.settings, 'base_currency', 'USD')),
        `<strong class="${profit >= 0 ? 'pos' : 'neg'}">${money(req, profit, getS(req.settings, 'base_currency', 'USD'))}</strong>`,
      ];
    })
  );
  // Per-number exposure heat for the nearest draw
  let heat = '';
  if (expRows.length) {
    const { draw: dr, per } = expRows[0];
    const max = Math.max(1, ...per.slice(1));
    heat = `<div class="heat">${per.slice(1).map((v, i) =>
      `<div class="heat-cell" style="--w:${Math.round(v / max * 100)}" title="#${i + 1}: ${money(req, v, getS(req.settings, 'base_currency', 'USD'))}"><span>${i + 1}</span></div>`).join('')}</div>
      <p class="muted">Exposure per number — nearest draw: ${dr.draw_type} ${esc(dr.draw_date)}</p>`;
  }

  // Operator P&L (ViserLab-style): all-time sold vs given prize vs profit/loss.
  // CURRENCY-SYSTEM-01: these aggregates are PER CURRENCY — summing
  // different currencies into one number (as the old single SUM did)
  // is a false number the moment a second currency carries money.
  const soldAll = await req.db.query('SELECT currency, COALESCE(SUM(total),0) AS s FROM tickets GROUP BY currency');
  const prizeAll = await req.db.query("SELECT currency, COALESCE(SUM(amount),0) AS s FROM transactions WHERE type IN ('win','scratch_prize') GROUP BY currency");
  const soldMap = Object.fromEntries(soldAll.map(r => [r.currency, Number(r.s)]));
  const prizeMap = Object.fromEntries(prizeAll.map(r => [r.currency, Number(r.s)]));
  const profitRows = [...new Set([...Object.keys(soldMap), ...Object.keys(prizeMap)])].map(c => ({ currency: c, s: (soldMap[c] || 0) - (prizeMap[c] || 0) }));
  const moneyRows = (rows) => rows.length ? rows.map(r => money(req, r.s, r.currency)).join(' · ') : money(req, 0, getS(req.settings, 'base_currency', 'USD'));
  const overdueDraws = await req.db.get("SELECT COUNT(*) AS c FROM draws WHERE status = 'scheduled' AND close_at < ?", [now()]);
  // Settled-only RTP: never show a projected percentage as if it were real.
  // Until a draw has actually settled with real stakes, the honest value is "—".
  /* SCAN fix (C-02): stake per entry is wager × pops count (wager is
     PER POP) — the old SQL summed wager alone, understating settled
     stake and inflating RTP. Sum in JS with the same pops parsing the
     exposure table above already uses. */
  const settledRows = await req.db.query(
    `SELECT t.wager AS wager, t.pops AS pops, te.win_amount AS win_amount
     FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id JOIN draws d ON d.id = te.draw_id
     WHERE d.status = 'settled' AND te.status IN ('won','lost')`);
  const settled = { staked: 0, paid: 0 };
  for (const r of settledRows) { settled.staked += safeJsonArray(r.pops).length * Number(r.wager || 0); settled.paid += Number(r.win_amount || 0); }
  const rtpValue = settled.staked > 0 ? (settled.paid / settled.staked * 100).toFixed(1) + '%' : '—';
  // Login breakdown, last 30 days, from real login_history rows. Country is
  // NOT recorded (no geo-IP service is configured), so only browser + OS are
  // shown — no invented country donut.
  const loginRows = await req.db.query('SELECT browser, os FROM login_history WHERE created_at > ?', [now() - 30 * 86400000]);
  const share = (key) => { const m = {}; for (const r of loginRows) { const k = r[key] || 'Unknown'; m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 6); };
  const shareBars = (title, entries) => loginRows.length
    ? ui.card(title, entries.map(([k, c]) => `<div class="share-row"><span class="share-k">${esc(k)}</span><span class="share-bar"><span style="width:${Math.round(c / loginRows.length * 100)}%"></span></span><span class="share-v">${c} (${Math.round(c / loginRows.length * 100)}%)</span></div>`).join(''))
    : ui.card(title, '<p class="muted">No logins in the last 30 days.</p>');
  const loginCards = `<div class="grid2">${shareBars('Logins by browser (last 30 days)', share('browser'))}${shareBars('Logins by OS (last 30 days)', share('os'))}</div>
    <p class="muted">Country breakdown is not shown: logins do not record a country (no geo-IP service configured) — nothing is guessed.</p>`;
  const reconBanner = lastRecon && lastRecon.mismatch_count > 0
    ? `<div class="alert a-err">Ledger reconciliation found ${lastRecon.mismatch_count} mismatch(es) on ${d(lastRecon.checked_at)} — see <a href="${R(req, '/reconciliation')}">Reconciliation</a>.</div>`
    : '';
  /* U-26 TWO DOORS (§5.3): the incident switches (maintenance mode +
     the deposit/withdrawal gates) also live here, where an operator
     lands during an incident. The form posts to the SAME
     /settings/toggles route and carries every other toggle as a
     hidden input at its current value, because that handler rewrites
     the whole toggle set — a partial form would switch siblings off.
     Super-only: /settings/* POSTs are super-only in lib/rbac.js, so
     other roles never see a control that would refuse them. */
  const DOOR_TOGGLES = ['maintenance_mode', 'deposits_enabled', 'withdrawals_enabled'];
  const siteStatusCard = !isSuperReq(req) ? '' : ui.card('Site status — incident switches',
    `<p class="muted">These are the same switches as Settings → System configuration — one set of switches, two doors. Saving here changes them there too.</p>
     <form method="POST" action="${R(req, '/settings/toggles')}" class="adm-form"><input type="hidden" name="_csrf" value="${req.csrfToken}">
     ${TOGGLES.filter(([k]) => !DOOR_TOGGLES.includes(k) && getS(req.settings, k, '0') === '1').map(([k]) => `<input type="hidden" name="${esc(k)}" value="1">`).join('')}
     ${[['maintenance_mode', 'Maintenance mode', 'Block the player site with a maintenance page (admin panel + admin login still work).'],
        ['deposits_enabled', 'Deposits (global)', 'Master kill switch for deposits.'],
        ['withdrawals_enabled', 'Withdrawals (global)', 'Master kill switch for withdrawals.']]
       .map(([k, label, help]) => `<div class="field"><label class="check"><input type="checkbox" name="${esc(k)}" value="1" ${getS(req.settings, k, '0') === '1' ? 'checked' : ''}> ${esc(label)}</label><small class="muted">${esc(help)}</small></div>`).join('')}
     <div class="mt"><button class="btn btn-p" type="submit">Save site status</button></div></form>`);
  /* ADMIN-CLARITY-01: Common tasks — the daily jobs one click away,
     with REAL pending counts (everything-real rule; zero shows as 0). */
  const kycOn = getBool(req.settings, 'kyc_enabled', false);
  const pendKyc = kycOn ? await req.db.get("SELECT COUNT(*) AS c FROM kyc_documents WHERE status = 'pending'") : { c: 0 };
  const commonTasks = ui.card('Common tasks', `<div class="task-links">
      <a class="btn btn-g" href="${R(req, '/deposits?status=pending')}">Review pending deposits (${pendDep.c})</a>
      <a class="btn btn-g" href="${R(req, '/withdrawals?status=pending')}">Review pending withdrawals (${pendWd.c})</a>
      ${kycOn ? `<a class="btn btn-g" href="${R(req, '/kyc')}">Review KYC (${pendKyc.c} waiting)</a>` : ''}
      <a class="btn btn-g" href="${R(req, '/methods')}">Add a payment method</a>
      <a class="btn btn-g" href="${R(req, '/limits')}">Set limits</a>
    </div>`);
  const body = `
    ${reconBanner}
    ${siteStatusCard}
    ${commonTasks}
    ${ui.kpis([
      { n: moneyRows(soldAll), l: 'Sold amount (all time)', href: R(req, '/reports?type=business') },
      { n: moneyRows(prizeAll), l: 'Given prize (all time)', href: R(req, '/reports?type=business') },
      { n: moneyRows(profitRows), l: 'Profit (sold − prize, per currency)', href: R(req, '/reports?type=business') },
      { n: overdueDraws.c, l: 'Overdue draws — settle now', href: R(req, '/draws') },
      { n: users.c, l: 'Players', href: R(req, '/users') },
      { n: ticketsToday.c, l: 'Tickets (24h)', href: R(req, '/tickets') },
      { n: moneyRows(stakedToday), l: 'Staked (24h)', href: R(req, '/reports?type=business') },
      { n: moneyRows(winsToday), l: 'Paid out (24h)', href: R(req, '/reports?type=business') },
      { n: pendDep.c, l: 'Pending deposits', href: R(req, '/deposits?status=pending') },
      { n: pendWd.c, l: 'Pending withdrawals', href: R(req, '/withdrawals?status=pending') },
      { n: pendAppr.c, l: 'Pending second approvals', href: R(req, '/approvals') },
      { n: openFlags.c, l: 'Open fraud flags', href: R(req, '/flags') },
      { n: openSup.c, l: 'Open support tickets', href: R(req, '/support?status=open') },
      { n: rtpValue, l: 'RTP (settled draws only)', href: R(req, '/reports?type=business') },
    ])}
    ${loginCards}
    ${ui.card('Exposure & profit projection', heat + expTable)}
    ${ui.card('Recent audit activity', ui.table(['Time', 'Actor', 'Action', 'Detail'],
      (await req.db.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 8')).map(a =>
        [d(a.created_at), esc(a.actor_role) + ' #' + (a.actor_id || '—'), esc(a.action), auditDetailHtml(req, a.detail)])))}`;
  res.send(shell(req, '', 'Dashboard', body, 'Money in, money out, and everything waiting for your decision.'));
});

/* ============================================================ DRAWS */
router.get('/draws', async (req, res) => {
  // R-105: the old list capped at 60 with no pagination, so settled history
  // silently disappeared. Upcoming and settled now paginate separately (same
  // page number for both tables); the overdue queue is its own query.
  const page = pageOf(req);
  const overdue = await req.db.query("SELECT * FROM draws WHERE status = 'scheduled' AND close_at < ? ORDER BY close_at LIMIT 100", [now()]);
  const upcomingTotal = (await req.db.get("SELECT COUNT(*) AS c FROM draws WHERE status = 'scheduled'")).c;
  const upcoming = await req.db.query("SELECT * FROM draws WHERE status = 'scheduled' ORDER BY close_at LIMIT ? OFFSET ?", [PER, (page - 1) * PER]);
  const settledTotal = (await req.db.get("SELECT COUNT(*) AS c FROM draws WHERE status = 'settled'")).c;
  const settled = await req.db.query("SELECT * FROM draws WHERE status = 'settled' ORDER BY close_at DESC LIMIT ? OFFSET ?", [PER, (page - 1) * PER]);
  const pendingCard = overdue.length ? ui.card('⏰ Pending draws — overdue, settle now',
    ui.table(['ID', 'Type', 'Date', 'Closes', 'Overdue by', ''],
      overdue.map(dr => [
        `<a href="${R(req, '/draws/' + dr.id)}">#${dr.id}</a>`, dr.draw_type + (dr.is_test ? ' ' + ui.badge('TEST', 'warn') : ''), esc(dr.draw_date), d(dr.close_at),
        Math.max(0, Math.round((now() - dr.close_at) / 60000)) + ' min',
        `<form method="POST" action="${R(req, '/draws/' + dr.id + '/settle')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm btn-g">Draw Now</button></form>`,
      ]))) : '';
  // BP-23(e): live per-draw exposure (entries, stake, worst-case and
  // expected liability) from real entries at the current prize table.
  const pmDraws = await engine.prizeMap(req.db);
  const drawAlertMinor = toMinor(getS(req.settings, 'draw_liability_alert', '0'), 2) || 0;
  const expoByDraw = {};
  for (const dr of upcoming) expoByDraw[dr.id] = await engine.drawExposure(req.db, dr.id, pmDraws);
  const expoCell = (dr) => {
    const exps = expoByDraw[dr.id] || [];
    if (!exps.length) return '<span class="muted">no entries</span>';
    return exps.map(ex => `${ex.entries} entries · stake ${money(req, ex.stake, ex.currency)} · max ${money(req, ex.maxLiability, ex.currency)}${drawAlertMinor > 0 && ex.maxLiability > drawAlertMinor ? ' ⚠ OVER ALERT' : ''} · expected ${money(req, ex.expectedLiability, ex.currency)}`).join('<br>');
  };
  const body = `
    ${pendingCard}
    ${isSuperReq(req) ? `<p class="muted">Wager options, draw times and the prize table are set in <a href="${R(req, '/settings')}">Settings → Game economy</a>.</p>` : ''}
    ${ui.card('Upcoming draws', ui.table(['ID', 'Type', 'Date', 'Closes', 'Status', 'Seed hash', 'Winning #', 'Exposure', ''],
      upcoming.map(dr => [
        `<a href="${R(req, '/draws/' + dr.id)}">#${dr.id}</a>`, dr.draw_type + (dr.is_test ? ' ' + ui.badge('TEST', 'warn') : ''), esc(dr.draw_date), d(dr.close_at),
        ui.statusBadge(dr.status), `<span class="code">${esc(String(dr.seed_hash).slice(0, 16))}…</span>`, dr.winning_number || '—',
        expoCell(dr),
        /* SCAN fix (C-04): "Settle now" renders only when the engine
           can actually settle (test draw, or close time reached) — on a
           future draw the button was a guaranteed failure flash. */
        `${(dr.is_test || dr.close_at <= Date.now()) ? `<form method="POST" action="${R(req, '/draws/' + dr.id + '/settle')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">Settle now</button></form>` : '<span class="muted">Settles at close</span>'}
         <form method="POST" action="${R(req, '/draws/' + dr.id + '/cancel')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm btn-d">Cancel & refund</button></form>`,
      ])) + ui.paginate(R(req, '/draws'), page, PER, upcomingTotal))}
    ${ui.card('Create TEST draw', `<p class="muted">Test draws never affect real players' money flow visibility — they are labeled TEST everywhere. A fixed winning number may be set <strong>only</strong> here, and it is audit-logged.</p>` +
      ui.formHtml(R(req, '/draws/test'), [
        { key: 'date', label: 'Date', type: 'date', required: true },
        { key: 'time', label: 'Time', type: 'text', value: '12:00', help: 'HH:MM, 24h' },
        { key: 'override_number', label: 'Fixed winning number (1–15, optional)', type: 'number', help: 'Leave empty for random. Only for TEST draws.' },
      ], { csrf: req.csrfToken, submit: 'Create test draw' }))}
    ${ui.card('Recent settled draws', ui.table(['ID', 'Type', 'Date', 'Winning #', 'Test'],
      settled.map(dr => [
        `<a href="${R(req, '/draws/' + dr.id)}">#${dr.id}</a>`, dr.draw_type, esc(dr.draw_date),
        `<span class="ball-sm">${dr.winning_number}</span>`,
        dr.is_test ? ui.badge('TEST', 'warn') : '—',
      ])) + ui.paginate(R(req, '/draws'), page, PER, settledTotal))}`;
  res.send(shell(req, '/draws', 'Draws', body, 'Scheduled draws, live exposure and settlement.'));
});

router.post('/draws/test', async (req, res) => {
  // R-080 (route half): validate date/time/override here — the old route
  // passed raw input to the engine, whose throw became a 500 page.
  const dateStr = String(req.body.date || '').trim();
  const timeStr = String(req.body.time || '12:00').trim();
  const ovRaw = String(req.body.override_number || '').trim();
  const bad = (m) => req.setFlash('error', m).then(() => res.redirect(R(req, '/draws')));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || Number.isNaN(new Date(dateStr + 'T00:00:00Z').getTime())) return bad('Date must be YYYY-MM-DD.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(timeStr)) return bad('Time must be HH:MM (24h).');
  let overrideNumber = null;
  if (ovRaw !== '') {
    overrideNumber = parseInt(ovRaw, 10);
    if (!/^\d+$/.test(ovRaw) || overrideNumber < 1 || overrideNumber > 15) return bad('Fixed winning number must be an integer 1–15 (or blank for random).');
  }
  const ex = await req.db.get('SELECT id FROM draws WHERE draw_type = ? AND draw_date = ?', ['TEST', dateStr]);
  if (ex) { await req.setFlash('error', 'A TEST draw already exists for that date.'); return res.redirect(R(req, '/draws')); }
  try {
    const id = await createTestDraw(req.db, {
      dateStr, timeStr, overrideNumber, adminId: req.user.id, ip: req.ip,
      timeZone: getS(req.settings, 'site_timezone', 'UTC'),
    });
    await req.setFlash('success', 'TEST draw #' + id + ' created.');
  } catch (e) { await req.setFlash('error', 'Could not create TEST draw: ' + e.message); }
  res.redirect(R(req, '/draws'));
});

/* Draw detail: P&L + per-ticket winner breakdown (ViserLab-style winning history) */
router.get('/draws/:id', async (req, res) => {
  const dr = await req.db.get('SELECT * FROM draws WHERE id = ?', [req.params.id]);
  if (!dr) return notFound(req, res, 'Draw not found.');
  /* SCAN fix (C-02): "Sold amount" is stake = wager × pops per entry,
     summed in JS (wager alone is per-pop and understated the truth). */
  const soldRows = await req.db.query(
    `SELECT t.wager AS wager, t.pops AS pops, t.currency AS currency, te.ticket_id AS ticket_id
     FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id WHERE te.draw_id = ?`, [dr.id]);
  /* CURRENCY-SYSTEM-01 audit completion: a draw's entries can span
     currencies (players buy in their wallet currency), so the KPIs are
     per-currency — never summed into one base-currency number. */
  const soldByCur = {};
  for (const r of soldRows) soldByCur[r.currency] = (soldByCur[r.currency] || 0) + safeJsonArray(r.pops).length * Number(r.wager || 0);
  const soldTickets = new Set(soldRows.map(r => r.ticket_id)).size;
  const paidRows = await req.db.query(
    `SELECT t.currency AS currency, COALESCE(SUM(te.win_amount),0) AS s, COUNT(*) AS c
     FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id WHERE te.draw_id = ? AND te.status = 'won' GROUP BY t.currency`, [dr.id]);
  const paidByCur = {}; let paidCount = 0;
  for (const r of paidRows) { paidByCur[r.currency] = Number(r.s); paidCount += Number(r.c); }
  const perCurJoin = (map, sign) => { const ks = Object.keys(map); return ks.length ? ks.map(c => money(req, sign ? sign(map[c], c) : map[c], c)).join(' · ') : money(req, 0, getS(req.settings, 'base_currency', 'USD')); };
  const profitByCur = {}; for (const c of new Set([...Object.keys(soldByCur), ...Object.keys(paidByCur)])) profitByCur[c] = (soldByCur[c] || 0) - (paidByCur[c] || 0);
  const winners = await req.db.query(
    `SELECT te.win_amount, te.id AS entry_id, t.public_id, t.pops, t.currency, u.email, u.name
     FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id JOIN users u ON u.id = t.user_id
     WHERE te.draw_id = ? AND te.status = 'won' ORDER BY te.win_amount DESC`, [dr.id]);
  const body = `
    ${ui.kpis([
      { n: perCurJoin(soldByCur), l: 'Sold amount (per currency)' },
      { n: perCurJoin(paidByCur), l: 'Given prize (per currency)' },
      { n: perCurJoin(profitByCur), l: 'Profit (per currency)' },
      { n: paidCount + ' / ' + soldTickets, l: 'Winning tickets / tickets' },
    ])}
    ${ui.card('Draw — ' + esc(dr.draw_type) + ' ' + esc(dr.draw_date), `<p class="muted">Status: ${ui.statusBadge(dr.status)} · Winning number: <strong>${dr.winning_number || '—'}</strong> · Seed hash: <span class="code">${esc(String(dr.seed_hash || '').slice(0, 32))}…</span></p>`)}
    ${ui.card('Winners — per-ticket breakdown', ui.table(['Player', 'Ticket', 'Pops picked', 'Prize'],
      winners.map(w => [esc(w.name || w.email), `<span class="code">${esc(w.public_id)}</span>`, esc(w.pops), money(req, w.win_amount, w.currency)])))}`;
  res.send(shell(req, '/draws', 'Draw #' + dr.id, body));
});
router.post('/draws/:id/settle', async (req, res) => {
  try {
    // R-013: draw settlement is a money action — at/above the maker-checker
    // threshold it queues for a second approver instead of executing.
    const dr = await req.db.get('SELECT * FROM draws WHERE id = ?', [req.params.id]);
    if (!dr) throw new Error('Draw not found');
    if (dr.status === 'scheduled') {
      const { amt, cur } = maxCurEntry(await drawEntrySums(req.db, dr.id), getS(req.settings, 'base_currency', 'USD'));
      const mc = await maybeMakerChecker(req, 'draw.settle', 'draw', dr.id, amt, cur, {});
      if (mc) {
        await req.setFlash('success', 'This settlement exceeds the maker-checker threshold and is queued for a second approver (see Approvals).' + (mc.conflictId ? ` Note: approval #${mc.conflictId} for this draw is already open.` : ''));
        return res.redirect(R(req, '/draws'));
      }
    }
    const r = await settleDraw(req.db, parseInt(req.params.id, 10), req.settings, { actorId: req.user.id, ip: req.ip });
    req.flashData = { success: `Draw settled. Winning number: ${r.winning}. Winners: ${r.winners}.` };
  } catch (e) { req.flashData = { error: 'Settle failed: ' + e.message }; }
  res.redirect(R(req, '/draws'));
});
/* R-025 (admin half): cancel a scheduled draw — stakes refund to wallets
   (lib/draws.js cancelDraw), audited there, players notified here. */
router.post('/draws/:id/cancel', async (req, res) => {
  try {
    const dr = await req.db.get('SELECT * FROM draws WHERE id = ?', [req.params.id]);
    if (!dr) throw new Error('Draw not found');
    if (dr.status !== 'scheduled') throw new Error('Only scheduled draws can be cancelled');
    const { amt, cur } = maxCurEntry(await drawEntrySums(req.db, dr.id), getS(req.settings, 'base_currency', 'USD'));
    const mc = await maybeMakerChecker(req, 'draw.cancel', 'draw', dr.id, amt, cur, {});
    if (mc) {
      await req.setFlash('success', 'This cancellation exceeds the maker-checker threshold and is queued for a second approver (see Approvals).' + (mc.conflictId ? ` Note: approval #${mc.conflictId} for this draw is already open.` : ''));
      return res.redirect(R(req, '/draws'));
    }
    const r = await cancelDraw(req.db, dr.id, req.settings, { actorId: req.user.id, ip: req.ip });
    await notifyDrawCancelled(req.db, req.settings, dr.id);
    await req.setFlash('success', `Draw cancelled. ${r.entries} pending stake(s) refunded to wallets.`);
  } catch (e) { await req.setFlash('error', 'Cancel failed: ' + e.message); }
  res.redirect(R(req, '/draws'));
});

/* ============================================================ TICKETS */
router.get('/tickets', async (req, res) => {
  const page = pageOf(req);
  const where = [], params = [];
  if (req.query.status) { where.push('t.status = ?'); params.push(req.query.status); }
  if (req.query.q) { where.push('(LOWER(t.public_id) LIKE LOWER(?) OR LOWER(u.email) LIKE LOWER(?))'); params.push('%' + req.query.q + '%', '%' + req.query.q + '%'); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await req.db.get(`SELECT COUNT(*) AS c FROM tickets t JOIN users u ON u.id = t.user_id ${w}`, params)).c;
  const rows = await req.db.query(
    `SELECT t.*, u.email FROM tickets t JOIN users u ON u.id = t.user_id ${w} ORDER BY t.created_at DESC LIMIT ? OFFSET ?`,
    [...params, PER, (page - 1) * PER]);
  const body = ui.filtersHtml(R(req, '/tickets'), [
    { key: 'status', label: 'Status', type: 'select', options: ['active', 'settled', 'cancelled'] },
    { key: 'q', label: 'Ticket ID or email' },
  ], req.query) + ui.table(['Ticket', 'Player', 'Pops', 'Wager', 'Draws', 'Total', 'Status', 'HMAC', 'Bought'],
    rows.map(t => [
      `<a href="${R(req, '/tickets/' + t.id)}"><span class="code">${esc(t.public_id)}</span></a>`, esc(t.email),
      safeJsonArray(t.pops).join(', ') || '—', money(req, t.wager, t.currency),
      `${t.draw_type} ×${t.num_draws}`, money(req, t.total, t.currency),
      ui.statusBadge(t.status), `<span class="code">${esc(t.hmac.slice(0, 10))}…</span>`, d(t.created_at),
    ])) + ui.paginate(R(req, '/tickets'), page, PER, total);
  res.send(shell(req, '/tickets', 'Tickets', body, 'Lottery tickets bought by players.'));
});

/* Ticket detail (v15: the tickets list previously had no drill-down — an
   admin could not open a single ticket at all). Read-only. */
router.get('/tickets/:id', async (req, res) => {
  const t = await req.db.get(`SELECT t.*, u.email, u.name AS user_name FROM tickets t JOIN users u ON u.id = t.user_id WHERE t.id = ?`, [req.params.id]);
  if (!t) return notFound(req, res, 'Ticket not found.');
  const entries = await req.db.query(
    `SELECT te.*, d.draw_type, d.draw_date, d.winning_number, d.status AS draw_status FROM ticket_entries te JOIN draws d ON d.id = te.draw_id WHERE te.ticket_id = ? ORDER BY d.close_at`, [t.id]);
  let pops = [];
  try { pops = JSON.parse(t.pops || '[]'); } catch {}
  const body = ui.card('Ticket ' + t.public_id, `
    <div class="grid2"><div>
      ${ui.table(['Field', 'Value'], [
        ['Player', `${esc(t.user_name)} (${esc(t.email)})`],
        ['Pops', pops.join(', ')],
        ['Wager per pop', money(req, t.wager, t.currency)],
        ['Draws', `${t.draw_type} ×${t.num_draws}`],
        ['Total', money(req, t.total, t.currency)],
        ['Status', ui.statusBadge(t.status)],
        ['HMAC', `<span class="code">${esc(t.hmac)}</span>`],
        ['IP', esc(t.ip || '—')],
        ['Bought', d(t.created_at)],
      ])}
    </div><div>
      <h4>Draw entries</h4>
      ${entries.length ? ui.table(['Draw', 'Date', 'Winning', 'Entry status', 'Win'], entries.map(e => [
        esc(e.draw_type), esc(e.draw_date),
        e.winning_number == null ? '—' : String(e.winning_number),
        ui.statusBadge(e.status), money(req, e.win_amount || 0, t.currency),
      ])) : '<p class="muted">No entries.</p>'}
    </div></div>
    <div class="btn-row mt"><a class="btn" href="${R(req, '/tickets')}">← Back to tickets</a> <a class="btn" href="${R(req, '/users/' + t.user_id)}">View player</a></div>`);
  res.send(shell(req, '/tickets', 'Ticket ' + t.public_id, body));
});


/* ================= SMART ADMIN: Automation Console + Bonus Engine =======
   One page that shows (and really controls) the whole machine: master AUTO
   switch, per-process switches backed by cron_jobs, draw trigger settings,
   scratch lifecycle settings, live per-process status, a system-health
   block and failure alerts (failed runs are also audit-logged by the
   scheduler - no silent auto failures). Bonuses are promotional credit
   only: lib/bonus.js posts ledger rows of type 'bonus'; it has no path to
   game outcomes. */
const bonusEngine = require('../lib/bonus');

function parseWhenAdmin(v) {
  const raw = String(v || '').trim();
  if (!raw) return 0;
  const t = Date.parse(raw.replace(' ', 'T') + (raw.includes('Z') ? '' : 'Z'));
  return Number.isFinite(t) ? t : 0;
}

router.get('/automation', async (req, res) => {
  const S = req.settings;
  const master = getBool(S, 'automation_master_enabled', true);
  const jobs = await req.db.query('SELECT * FROM cron_jobs ORDER BY id');
  const failed = jobs.filter((j) => j.last_status === 'error');
  const failAudits = await req.db.query("SELECT * FROM audit_log WHERE action = 'cron.failed' ORDER BY id DESC LIMIT 5");
  let dbOk = true;
  try { await req.db.get('SELECT 1 AS x'); } catch { dbOk = false; }
  const lastBeacon = await req.db.get("SELECT beacon_status FROM draws WHERE status = 'settled' AND is_test = 0 ORDER BY id DESC LIMIT 1");
  const methodsOn = await req.db.get('SELECT COUNT(*) AS c FROM payment_methods WHERE enabled = 1');
  const creds = await req.db.get('SELECT COUNT(*) AS c FROM gateway_credentials');
  const series = await req.db.query('SELECT id, title, status FROM scratch_series ORDER BY id DESC LIMIT 50');
  const health = [
    ['Database', dbOk ? 'working' : 'ERROR - not responding'],
    ['Provably-fair beacon (drand)', getBool(S, 'beacon_enabled', true) ? 'enabled' + (lastBeacon ? ' - last settled draw: ' + (lastBeacon.beacon_status || 'n/a') : ' - no settled draws yet') : 'disabled by operator (seed-only derivation)'],
    ['Email (SMTP)', process.env.SMTP_HOST ? 'configured via server environment' : 'NOT configured - emails are logged as not-configured, never faked as sent'],
    ['SMS', 'provider: ' + (getS(S, 'sms_provider', '') || 'not selected') + ' (credentials are set via server environment variables — see .env.example)'],
    ['Payment gateways', Number(methodsOn.c) + ' method(s) enabled; ' + Number(creds.c) + ' credential record(s) stored'],
    ['Bonus engine', getBool(S, 'bonus_enabled', true) ? 'on' : 'OFF'],
  ];
  const switchForm = (on, action, label) =>
    `<form method="POST" action="${R(req, action)}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><input type="hidden" name="on" value="${on ? '0' : '1'}"><button class="btn btn-sm ${on ? 'btn-d' : 'btn-p'}">${on ? 'Turn OFF' : 'Turn ON'}</button></form> <span class="muted">${label}</span>`;
  let body = ui.card('Automation master switch',
    `<p>The master switch freezes or resumes the ENTIRE in-process scheduler (draws, settlement, scratch lifecycle, bonuses, notifications, cleanups, backups). Manual actions stay available as the backup path.</p><p>Master AUTO is <strong>${master ? 'ON' : 'OFF'}</strong> ${switchForm(master, '/automation/master', '')}</p>`);
  body += ui.card('Pop draw automation', `<p class="muted">Trigger per draw type: <strong>time</strong> = settle at the scheduled close; <strong>threshold</strong> = settle the moment N entries are sold (time alone never settles; the draw stays open); <strong>both</strong> = whichever comes first. If time wins while the threshold is unmet, the unmet behaviour applies: <strong>settle</strong> anyway, or <strong>roll</strong> the draw +24h with its entries carried over. Outcomes always come from the committed seed + public beacon - triggers change WHEN a draw settles, never WHAT it draws.</p>` +
    ui.formHtml(R(req, '/automation/draws'), [
      { key: 'auto_draw_day', label: 'Auto-create/settle DAY draws', type: 'checkbox' },
      { key: 'auto_draw_eve', label: 'Auto-create/settle EVE draws', type: 'checkbox' },
      { key: 'draw_trigger_mode_day', label: 'DAY trigger', type: 'select', options: ['time', 'threshold', 'both'] },
      { key: 'draw_trigger_mode_eve', label: 'EVE trigger', type: 'select', options: ['time', 'threshold', 'both'] },
      { key: 'draw_threshold_day', label: 'DAY threshold (entries sold)', type: 'number' },
      { key: 'draw_threshold_eve', label: 'EVE threshold (entries sold)', type: 'number' },
      { key: 'draw_unmet_day', label: 'DAY unmet-at-time behaviour', type: 'select', options: ['settle', 'roll'] },
      { key: 'draw_unmet_eve', label: 'EVE unmet-at-time behaviour', type: 'select', options: ['settle', 'roll'] },
      { key: 'wager_options', label: 'Wager amounts (major units, comma list - drives the playslip AND buy validation)', type: 'text' },
    ], {
      csrf: req.csrfToken, submit: 'Save draw automation',
      values: {
        auto_draw_day: getBool(S, 'auto_draw_day', true), auto_draw_eve: getBool(S, 'auto_draw_eve', true),
        draw_trigger_mode_day: getS(S, 'draw_trigger_mode_day', 'time'), draw_trigger_mode_eve: getS(S, 'draw_trigger_mode_eve', 'time'),
        draw_threshold_day: getS(S, 'draw_threshold_day', '100'), draw_threshold_eve: getS(S, 'draw_threshold_eve', '100'),
        draw_unmet_day: getS(S, 'draw_unmet_day', 'settle'), draw_unmet_eve: getS(S, 'draw_unmet_eve', 'settle'),
        wager_options: getS(S, 'wager_options', '1,2,5,10'),
      },
    }) + `<p class="muted">Prize multipliers per pop count are edited under Settings → Prize Table and are read by the settle engine on every draw.</p>`);
  body += ui.card('Scratch automation',
    `<p class="muted">Series activate at their scheduled launch time, stop at their end date and close automatically when sold out (set the dates on the series create form). Auto-next creates and launches a fresh series from a template whenever a series ends.</p>
     <form method="POST" action="${R(req, '/automation/scratch')}" class="adm-form"><input type="hidden" name="_csrf" value="${req.csrfToken}">
       <div class="form-grid">
         <div class="field"><label class="check"><input type="checkbox" name="scratch_auto_next_enabled" value="1" ${getBool(S, 'scratch_auto_next_enabled', false) ? 'checked' : ''}> Auto-create next series</label></div>
         <div class="field"><label>Template series</label><select name="scratch_template_series_id"><option value="">— none —</option>${series.map((x) => `<option value="${x.id}" ${String(x.id) === getS(S, 'scratch_template_series_id', '') ? 'selected' : ''}>${esc(x.title)} (#${x.id}, ${esc(x.status)})</option>`).join('')}</select></div>
       </div>
       <h4 class="mt">Smart Prize &amp; Profit Engine</h4>
       <p class="muted">Aggregate-level controls only — pools, RTP targets and exposure. Outcomes stay predetermined/committed (scratch) and beacon-derived (pop); nothing here can change a sold ticket or a single result.</p>
       <div class="form-grid">
         <div class="field"><label>Planner target RTP % (also used by smart auto-next)</label><input type="text" name="scratch_planner_target_rtp" value="${esc(getS(S, 'scratch_planner_target_rtp', '75'))}"></div>
         <div class="field"><label class="check"><input type="checkbox" name="scratch_smart_pool_enabled" value="1" ${getBool(S, 'scratch_smart_pool_enabled', false) ? 'checked' : ''}> Smart auto-next pool (regenerate from the ended series' sell-through + target RTP instead of cloning tiers)</label></div>
         <div class="field"><label class="check"><input type="checkbox" name="scratch_guardrail_enabled" value="1" ${getBool(S, 'scratch_guardrail_enabled', false) ? 'checked' : ''}> Enable exposure guardrails</label></div>
         <div class="field"><label>Launch cap — max prize liability, % of full sales value</label><input type="text" name="scratch_liability_cap_pct" value="${esc(getS(S, 'scratch_liability_cap_pct', '100'))}"></div>
         <div class="field"><label>Alert threshold — unsold-tail RTP above %</label><input type="text" name="scratch_alert_threshold_pct" value="${esc(getS(S, 'scratch_alert_threshold_pct', '90'))}"></div>
         <div class="field"><label>On threshold breach</label><select name="scratch_guardrail_action">${['alert', 'close_sales', 'stop_auto_next'].map(a => `<option value="${a}" ${getS(S, 'scratch_guardrail_action', 'alert') === a ? 'selected' : ''}>${a}</option>`).join('')}</select></div>
         <div class="field"><label>Draw liability alert (major units; 0 = off)</label><input type="text" name="draw_liability_alert" value="${esc(getS(S, 'draw_liability_alert', '0'))}"></div>
       </div>
       <div class="mt"><button class="btn btn-p" type="submit">Save scratch automation</button></div>
     </form>`);
  body += ui.card('Processes (live status)', ui.table(
    ['Process', 'Every (min)', 'Last run', 'Next run', 'Last result', 'Switch', ''],
    jobs.map((j) => [esc(j.name), j.interval_minutes, j.last_run_at ? d(j.last_run_at) : 'never', j.next_run_at ? d(j.next_run_at) : '—',
      (j.last_status ? ui.statusBadge(j.last_status) : '—') + `<br><small class="muted">${esc(j.last_message || '')}</small>`,
      j.status === 'active' ? ui.badge('active', 'ok') : ui.badge('paused', 'muted'),
      `<form method="POST" action="${R(req, '/automation/job/' + j.id + '/run')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">Run now</button></form>
       <form method="POST" action="${R(req, '/automation/job/' + j.id + '/toggle')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">${j.status === 'active' ? 'Pause' : 'Resume'}</button></form>`])));
  body += ui.card('System health', ui.table(['Component', 'State'], health.map((h) => [esc(h[0]), esc(h[1])])));
  // BP-23(e/b): live exposure alerts — computed from real entries and
  // outcomes at render time, so what you see is the current truth.
  {
    const alerts = [];
    if (getBool(S, 'scratch_guardrail_enabled')) {
      const thr = Number(getS(S, 'scratch_alert_threshold_pct', '90')) || 90;
      const liveSeries = await req.db.query("SELECT * FROM scratch_series WHERE status = 'live'");
      for (const srow of liveSeries) {
        const expo = await engine.seriesExposure(req.db, srow);
        if (expo.remainingTickets > 0 && expo.tailRtpPct > thr) alerts.push([d(now()), 'Scratch guardrail', `Series "${esc(srow.title)}" (#${srow.id}): unsold-tail RTP ${expo.tailRtpPct.toFixed(1)}% > threshold ${thr}% — remaining liability ${money(req, expo.remainingLiability, srow.currency)} over ${expo.remainingTickets} tickets.`]);
      }
    }
    const drawAlertMajor = getS(S, 'draw_liability_alert', '0');
    if (parseFloat(drawAlertMajor) > 0) {
      const pm = await engine.prizeMap(req.db);
      const open = await req.db.query("SELECT * FROM draws WHERE status = 'scheduled' AND is_test = 0 ORDER BY close_at LIMIT 50");
      for (const dr of open) {
        const exps = await engine.drawExposure(req.db, dr.id, pm);
        for (const ex of exps) {
          /* SCAN fix (B-10): per-currency minor threshold, as in cron. */
          const drawAlertMinor = toMinor(drawAlertMajor, decimalsFor(ex.currency, 'USD'));
          if (drawAlertMinor > 0 && ex.maxLiability > drawAlertMinor) alerts.push([d(now()), 'Draw exposure', `Draw #${dr.id} (${esc(dr.draw_type)} ${esc(dr.draw_date)}): max liability ${money(req, ex.maxLiability, ex.currency)} > alert threshold ${money(req, drawAlertMinor, ex.currency)} (expected ${money(req, ex.expectedLiability, ex.currency)}).`]);
        }
      }
    }
    body += ui.card('Exposure alerts', alerts.length ? ui.table(['When', 'Source', 'Detail'], alerts) : '<p class="muted">No exposure alerts right now. Scratch guardrail and draw-liability alerts appear here live when thresholds are crossed (enable them in Scratch automation above).</p>');
  }
  body += ui.card('Failure alerts', failed.length || failAudits.length
    ? ui.table(['When', 'Process', 'Detail'], [
        ...failed.map((j) => [j.last_run_at ? d(j.last_run_at) : '—', esc(j.name), esc(j.last_message || 'error')]),
        ...failAudits.map((a) => [d(a.created_at), 'scheduler', esc(a.detail || a.action)]),
      ])
    : '<p class="muted">No failed automation runs recorded. Failures appear here and in the Audit Trail the moment a run errors.</p>');
  /* U-26: Automation and Cron Jobs control the same scheduled jobs —
     say so on both pages so neither looks like a separate system. */
  body += `<p class="muted">The processes above are the same scheduled jobs listed under <a href="${R(req, '/cron')}">Cron Jobs</a> — pausing or running a job in either place changes the same job.</p>`;
  res.send(shell(req, '/automation', 'Automation Console', body, 'Automatic processes that run the site — their status and failures.'));
});

router.post('/automation/master', async (req, res) => {
  const on = req.body.on === '1' ? '1' : '0';
  await setSetting(req.db, req.driver, 'automation_master_enabled', on);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'automation.master', entity: 'settings', entityId: '', detail: { automation_master_enabled: on }, ip: req.ip });
  await req.setFlash('success', 'Automation master ' + (on === '1' ? 'ON - the scheduler is live.' : 'OFF - the scheduler is frozen.'));
  res.redirect(R(req, '/automation'));
});

router.post('/automation/draws', async (req, res) => {
  const mode = (v) => (['time', 'threshold', 'both'].includes(v) ? v : 'time');
  const unmet = (v) => (v === 'roll' ? 'roll' : 'settle');
  const num = (v, dflt) => { const n = parseInt(v, 10); return Number.isInteger(n) && n >= 0 ? String(n) : dflt; };
  const modeDay = mode(req.body.draw_trigger_mode_day), modeEve = mode(req.body.draw_trigger_mode_eve);
  const thrDay = num(req.body.draw_threshold_day, '100'), thrEve = num(req.body.draw_threshold_eve, '100');
  /* SCAN fix (B-11/C-09): threshold mode with threshold 0 can never
     settle (both engine paths require threshold > 0) and would lock a
     draw — and its stakes — open forever. Refuse the whole save. */
  if ((modeDay === 'threshold' && thrDay === '0') || (modeEve === 'threshold' && thrEve === '0')) {
    await req.setFlash('error', 'Threshold trigger mode needs a ticket threshold of at least 1 — with 0 the draw could never settle. Nothing was saved.');
    return res.redirect(R(req, '/automation'));
  }
  /* SCAN fix (C-08): wager_options gets the SAME validation here as in
     the Economy settings save — a garbage list must not silently save
     and change the playslip. */
  const wagerRaw = String(req.body.wager_options || '1,2,5,10').slice(0, 100);
  const wagerList = wagerRaw.split(',').map(x => x.trim()).filter(Boolean);
  if (!wagerList.length || !wagerList.every(x => Number.isFinite(parseFloat(x)) && parseFloat(x) > 0)) {
    await req.setFlash('error', 'Wager options must be a comma list of positive amounts (e.g. 1,2,5,10). Nothing was saved.');
    return res.redirect(R(req, '/automation'));
  }
  const vals = {
    auto_draw_day: req.body.auto_draw_day ? '1' : '0',
    auto_draw_eve: req.body.auto_draw_eve ? '1' : '0',
    draw_trigger_mode_day: modeDay, draw_trigger_mode_eve: modeEve,
    draw_threshold_day: thrDay, draw_threshold_eve: thrEve,
    draw_unmet_day: unmet(req.body.draw_unmet_day), draw_unmet_eve: unmet(req.body.draw_unmet_eve),
    wager_options: wagerRaw,
  };
  for (const [k, v] of Object.entries(vals)) await setSetting(req.db, req.driver, k, v);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'automation.draws', entity: 'settings', entityId: '', detail: vals, ip: req.ip });
  await req.setFlash('success', 'Draw automation saved.');
  res.redirect(R(req, '/automation'));
});

router.post('/automation/scratch', async (req, res) => {
  // BP-23 fields are validated as a group: a bad number refuses the whole
  // save (nothing half-written), same discipline as the risk controls.
  const pct = (v, min, max) => { const n = parseFloat(String(v || '')); return Number.isFinite(n) && n >= min && n <= max ? String(n) : null; };
  const rtp = pct(req.body.scratch_planner_target_rtp, 1, 100);
  const cap = pct(req.body.scratch_liability_cap_pct, 1, 200);
  const thr = pct(req.body.scratch_alert_threshold_pct, 1, 500);
  const action = ['alert', 'close_sales', 'stop_auto_next'].includes(req.body.scratch_guardrail_action) ? req.body.scratch_guardrail_action : null;
  const drawAlert = String(req.body.draw_liability_alert || '0').trim();
  if (rtp === null || cap === null || thr === null || !action || !/^\d+(\.\d{1,2})?$/.test(drawAlert)) {
    await req.setFlash('error', 'Invalid prize-engine value: RTP 1–100, cap 1–200, threshold 1–500, draw alert an amount like 500 or 500.00. Nothing was saved.');
    return res.redirect(R(req, '/automation'));
  }
  const vals = {
    scratch_auto_next_enabled: req.body.scratch_auto_next_enabled ? '1' : '0',
    scratch_template_series_id: String(parseInt(req.body.scratch_template_series_id, 10) || ''),
    scratch_planner_target_rtp: rtp,
    scratch_smart_pool_enabled: req.body.scratch_smart_pool_enabled ? '1' : '0',
    scratch_guardrail_enabled: req.body.scratch_guardrail_enabled ? '1' : '0',
    scratch_liability_cap_pct: cap,
    scratch_alert_threshold_pct: thr,
    scratch_guardrail_action: action,
    draw_liability_alert: drawAlert,
  };
  for (const [k, v] of Object.entries(vals)) await setSetting(req.db, req.driver, k, v);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'automation.scratch', entity: 'settings', entityId: '', detail: vals, ip: req.ip });
  await req.setFlash('success', 'Scratch automation saved.');
  res.redirect(R(req, '/automation'));
});

router.post('/automation/job/:id/toggle', async (req, res) => {
  const j = await req.db.get('SELECT * FROM cron_jobs WHERE id = ?', [req.params.id]);
  if (!j) { await req.setFlash('error', 'Process not found.'); return res.redirect(R(req, '/automation')); }
  await req.db.run("UPDATE cron_jobs SET status = CASE WHEN status='active' THEN 'paused' ELSE 'active' END, next_run_at = ? WHERE id = ?", [now() + j.interval_minutes * 60000, j.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'cron.toggle', entity: 'cron', entityId: req.params.id, detail: { old_status: j.status, new_status: j.status === 'active' ? 'paused' : 'active', via: 'automation console' }, ip: req.ip });
  res.redirect(R(req, '/automation'));
});

router.post('/automation/job/:id/run', async (req, res) => {
  /* SCAN fix (C-05): run-now can move money (e.g. settle_agent_commissions
     credits agent wallets) — it is audit-logged like every other money
     action. */
  const job = await req.db.get('SELECT handler_key FROM cron_jobs WHERE id = ?', [req.params.id]);
  try {
    const msg = await runNow({ db: req.db, driver: req.driver }, req.params.id);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'cron.run_now', entity: 'cron', entityId: req.params.id, detail: { handler: job ? job.handler_key : '', result: String(msg).slice(0, 300), via: 'automation console' }, ip: req.ip });
    await req.setFlash('success', 'Process ran: ' + msg);
  } catch (e) {
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'cron.run_now_failed', entity: 'cron', entityId: req.params.id, detail: { handler: job ? job.handler_key : '', error: e.message, via: 'automation console' }, ip: req.ip });
    await req.setFlash('error', 'Process failed: ' + e.message);
  }
  res.redirect(R(req, '/automation'));
});

/* ---------------- Bonus engine (promotional credit only) ---------------- */
router.get('/bonuses', async (req, res) => {
  const S = req.settings;
  const campaigns = await req.db.query('SELECT * FROM bonus_campaigns ORDER BY id DESC');
  const grants = await req.db.query(
    `SELECT g.*, c.name AS campaign_name, u.email AS user_email FROM bonus_grants g
     JOIN bonus_campaigns c ON c.id = g.campaign_id JOIN users u ON u.id = g.user_id ORDER BY g.id DESC LIMIT 50`);
  const currencies = getCurrencies(S).map((c) => c.code);
  const money = (minor, cur) => fmtMoney(minor, cur, getCurrencies(S));
  let body = ui.card('Bonus engine master switch',
    `<p>Promotional credit only - grants land in player wallets as <strong>bonus</strong> ledger entries (never as game wins) and every grant is logged below. Engine is <strong>${getBool(S, 'bonus_enabled', true) ? 'ON' : 'OFF'}</strong>.</p>
     <form method="POST" action="${R(req, '/bonuses/master')}"><input type="hidden" name="_csrf" value="${req.csrfToken}"><input type="hidden" name="on" value="${getBool(S, 'bonus_enabled', true) ? '0' : '1'}"><button class="btn ${getBool(S, 'bonus_enabled', true) ? 'btn-d' : 'btn-p'}">${getBool(S, 'bonus_enabled', true) ? 'Turn bonus engine OFF' : 'Turn bonus engine ON'}</button></form>`);
  body += ui.card('Campaigns', campaigns.length ? ui.table(
    ['Campaign', 'Audience', 'Amount', 'Trigger', 'Window', 'Granted', 'Caps', 'State', ''],
    campaigns.map((c) => [esc(c.name), esc(BONUS_AUDIENCE_LABELS[c.audience] || humanLabel(c.audience)) + (c.audience_n ? ' (' + c.audience_n + ')' : ''),
      c.amount_type === 'percent' ? c.amount + '% of deposit' : money(c.amount, c.currency), esc(BONUS_TRIGGER_LABELS[c.trigger_type] || humanLabel(c.trigger_type)),
      (c.starts_at ? d(c.starts_at) : '—') + ' → ' + (c.ends_at ? d(c.ends_at) : '—'),
      money(c.granted_total, c.currency),
      'per-user ' + (c.per_user_cap > 0 ? money(c.per_user_cap, c.currency) : '∞') + ' · budget ' + (c.budget_cap > 0 ? money(c.budget_cap, c.currency) : '∞'),
      c.active ? ui.badge('active', 'ok') : ui.badge('stopped', 'muted'),
      `<form method="POST" action="${R(req, '/bonuses/' + c.id + '/run')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">Run now</button></form>
       <form method="POST" action="${R(req, '/bonuses/' + c.id + '/toggle')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">${c.active ? 'Deactivate' : 'Activate'}</button></form>
       <form method="POST" action="${R(req, '/bonuses/' + c.id + '/delete')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm btn-d">Delete</button></form>`]))
    : '<p class="muted">No campaigns yet. Create the first one below.</p>');
  body += ui.card('Create campaign', ui.formHtml(R(req, '/bonuses/save'), [
    { key: 'name', label: 'Campaign name', type: 'text', required: true },
    { key: 'audience', label: 'Audience', type: 'select', options: [{ v: 'all', l: 'All players' }, { v: 'new', l: 'New players' }, { v: 'first_n', l: 'First N' }, { v: 'random_n', l: 'Random N' }] },
    { key: 'audience_n', label: 'Audience N (for the First N and Random N options)', type: 'number', value: '0' },
    { key: 'amount_type', label: 'Amount type', type: 'select', options: ['fixed', 'percent'] },
    { key: 'amount', label: 'Amount (fixed: major units e.g. 5.00 · percent: e.g. 10 = 10%)', type: 'text', required: true },
    { key: 'currency', label: 'Currency', type: 'select', options: currencies.length ? currencies : ['USD'] },
    { key: 'trigger_type', label: 'Trigger', type: 'select', options: [{ v: 'manual', l: 'Manual' }, { v: 'signup', l: 'Sign-up' }, { v: 'first_deposit', l: 'First deposit' }, { v: 'scheduled', l: 'Scheduled' }] },
    { key: 'starts_at', label: 'Valid from (optional, UTC e.g. 2026-11-01 10:00)', type: 'text' },
    { key: 'ends_at', label: 'Valid until (optional, UTC)', type: 'text' },
    { key: 'wagering_x', label: 'Wagering requirement (x grant amount, 0 = none)', type: 'text', value: '0' },
    { key: 'per_user_cap', label: 'Per-user cap (major units, 0 = unlimited)', type: 'text', value: '0' },
    { key: 'budget_cap', label: 'Total budget cap (major units, 0 = unlimited; auto-stops when exhausted)', type: 'text', value: '0' },
  ], { csrf: req.csrfToken, submit: 'Create campaign' }));
  body += ui.card('Grant log (latest 50)', grants.length ? ui.table(
    ['When', 'Campaign', 'Player', 'Amount', 'Trigger', 'Wagering progress'],
    grants.map((g) => [d(g.created_at), esc(g.campaign_name), esc(g.user_email), money(g.amount, g.currency), esc(BONUS_TRIGGER_LABELS[g.trigger_type] || humanLabel(g.trigger_type || '')),
      g.wagering_required > 0 ? money(g.wagered, g.currency) + ' / ' + money(g.wagering_required, g.currency) : '—']))
    : '<p class="muted">No grants yet.</p>');
  res.send(shell(req, '/bonuses', 'Bonus Campaigns', body, 'Promotional credit campaigns — never outcome control.'));
});

router.post('/bonuses/master', async (req, res) => {
  const on = req.body.on === '1' ? '1' : '0';
  await setSetting(req.db, req.driver, 'bonus_enabled', on);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'bonus.master', entity: 'settings', entityId: '', detail: { bonus_enabled: on }, ip: req.ip });
  res.redirect(R(req, '/bonuses'));
});

router.post('/bonuses/save', async (req, res) => {
  try {
    const { decimalsFor } = require('../lib/util');
    const currency = String(req.body.currency || 'USD').toUpperCase().slice(0, 8);
    const dec = decimalsFor(currency, getCurrencies(req.settings));
    const amountType = req.body.amount_type === 'percent' ? 'percent' : 'fixed';
    const amount = amountType === 'percent'
      ? Math.max(0, Math.floor(parseFloat(req.body.amount) || 0))
      : toMinor(req.body.amount, dec);
    if (!String(req.body.name || '').trim()) throw new Error('Campaign name is required.');
    if (!amount || amount <= 0) throw new Error('Amount must be positive.');
    const row = {
      name: String(req.body.name).trim().slice(0, 120),
      audience: ['all', 'new', 'first_n', 'random_n'].includes(req.body.audience) ? req.body.audience : 'all',
      audience_n: Math.max(0, parseInt(req.body.audience_n, 10) || 0),
      amount_type: amountType, amount, currency,
      trigger_type: ['manual', 'signup', 'first_deposit', 'scheduled'].includes(req.body.trigger_type) ? req.body.trigger_type : 'manual',
      starts_at: parseWhenAdmin(req.body.starts_at), ends_at: parseWhenAdmin(req.body.ends_at),
      wagering_x: Math.max(0, parseFloat(req.body.wagering_x) || 0),
      per_user_cap: toMinor(req.body.per_user_cap || '0', dec) || 0,
      budget_cap: toMinor(req.body.budget_cap || '0', dec) || 0,
    };
    const r = await req.db.run(
      `INSERT INTO bonus_campaigns (name, audience, audience_n, amount_type, amount, currency, trigger_type, starts_at, ends_at, wagering_x, per_user_cap, budget_cap, granted_total, active, last_drop_at, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, 0, ?, ?)`,
      [row.name, row.audience, row.audience_n, row.amount_type, row.amount, row.currency, row.trigger_type, row.starts_at, row.ends_at, row.wagering_x, row.per_user_cap, row.budget_cap, req.user.id, now()]);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'bonus.create', entity: 'bonus_campaign', entityId: r.id, detail: row, ip: req.ip });
    await req.setFlash('success', 'Campaign created and active.');
  } catch (e) { await req.setFlash('error', e.message); }
  res.redirect(R(req, '/bonuses'));
});

router.post('/bonuses/:id/run', async (req, res) => {
  try {
    const out = await bonusEngine.runCampaign(req.db, parseInt(req.params.id, 10), 'manual', req.settings, { manual: true, actorId: req.user.id });
    await req.setFlash(out.skipped ? 'error' : 'success', out.skipped ? 'Run skipped: ' + out.skipped : `Granted ${out.granted} bonus(es), total ${out.total} minor.` + (out.stopped ? ' Budget exhausted - campaign auto-stopped.' : ''));
  } catch (e) { await req.setFlash('error', e.message); }
  res.redirect(R(req, '/bonuses'));
});

router.post('/bonuses/:id/toggle', async (req, res) => {
  await req.db.run('UPDATE bonus_campaigns SET active = CASE WHEN active = 1 THEN 0 ELSE 1 END WHERE id = ?', [req.params.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'bonus.toggle', entity: 'bonus_campaign', entityId: req.params.id, detail: {}, ip: req.ip });
  res.redirect(R(req, '/bonuses'));
});

router.post('/bonuses/:id/delete', async (req, res) => {
  const g = await req.db.get('SELECT COUNT(*) AS c FROM bonus_grants WHERE campaign_id = ?', [req.params.id]);
  if (g && Number(g.c) > 0) {
    await req.setFlash('error', 'This campaign already has grants in the audit log - deactivate it instead of deleting.');
  } else {
    await req.db.run('DELETE FROM bonus_campaigns WHERE id = ?', [req.params.id]);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'bonus.delete', entity: 'bonus_campaign', entityId: req.params.id, detail: {}, ip: req.ip });
    await req.setFlash('success', 'Campaign deleted (it had no grants).');
  }
  res.redirect(R(req, '/bonuses'));
});

module.exports = router;

/* ============================================================ USERS */
const USER_FILTERS = [
  ['all', 'All'], ['active', 'Active'], ['banned', 'Banned'], ['pending_review', 'Pending review'],
  ['email_unverified', 'Email unverified'], ['mobile_unverified', 'Mobile unverified'],
  ['kyc_pending', 'KYC pending'], ['with_balance', 'With balance'],
];
router.get('/users', async (req, res) => {
  const page = pageOf(req);
  const f = req.query.f || 'all', q = req.query.q || '';
  const where = ["u.role = 'player'"], params = [];
  // R-070: agent detail "View all players" links here pre-filtered.
  if (req.query.agent) { where.push('u.agent_id = ?'); params.push(parseInt(req.query.agent, 10) || 0); }
  if (f === 'active') where.push("u.status = 'active'");
  else if (f === 'banned') where.push("u.status = 'banned'");
  else if (f === 'pending_review') where.push("u.status = 'pending_review'");
  else if (f === 'email_unverified') where.push('COALESCE(u.email_verified,0) = 0');
  else if (f === 'mobile_unverified') where.push('COALESCE(u.mobile_verified,0) = 0');
  else if (f === 'with_balance') where.push('EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = u.id AND w.balance > 0)');
  else if (f === 'kyc_pending') where.push("u.kyc_status = 'pending'");
  if (q) { where.push('(LOWER(u.email) LIKE LOWER(?) OR LOWER(u.name) LIKE LOWER(?) OR LOWER(u.phone) LIKE LOWER(?))'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const w = 'WHERE ' + where.join(' AND ');
  // live badges
  const badges = {};
  for (const [key] of USER_FILTERS) {
    let ww = ["u.role = 'player'"];
    if (key === 'active') ww.push("u.status = 'active'");
    else if (key === 'banned') ww.push("u.status = 'banned'");
    else if (key === 'pending_review') ww.push("u.status = 'pending_review'");
    else if (key === 'email_unverified') ww.push('COALESCE(u.email_verified,0) = 0');
    else if (key === 'mobile_unverified') ww.push('COALESCE(u.mobile_verified,0) = 0');
    else if (key === 'kyc_pending') ww.push("u.kyc_status = 'pending'");
    else if (key === 'with_balance') ww.push('EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = u.id AND w.balance > 0)');
    badges[key] = (await req.db.get(`SELECT COUNT(*) AS c FROM users u WHERE ${ww.join(' AND ')}`)).c;
  }
  const total = (await req.db.get(`SELECT COUNT(*) AS c FROM users u ${w}`, params)).c;
  const rows = await req.db.query(`SELECT u.* FROM users u ${w} ORDER BY u.created_at DESC LIMIT ? OFFSET ?`, [...params, PER, (page - 1) * PER]);
  const tabs = USER_FILTERS.map(([key, label]) =>
    `<a class="tab${f === key ? ' active' : ''}" href="${R(req, '/users')}?f=${key}">${esc(label)} <span class="count">${badges[key]}</span></a>`).join('');
  const body = `<div class="tabs">${tabs}</div>` +
    `<div class="btn-row" style="margin-bottom:12px"><a class="btn btn-sm" href="${R(req, '/data')}?dataset=users">Export users (CSV) →</a></div>` +
    (req.query.agent ? `<p class="muted">Showing players of agent #${esc(req.query.agent)} — <a href="${R(req, '/users')}">clear filter</a></p>` : '') +
    ui.filtersHtml(R(req, '/users'), [{ key: 'q', label: 'Search name/email/phone' }, { key: 'f', type: 'hidden' }, { key: 'agent', type: 'hidden' }], { q, f, agent: req.query.agent || '' }) +
    ui.table(['ID', 'Name', 'Email', 'Status', 'KYC', 'Agent', 'Joined', ''],
      rows.map(u => [
        u.id, esc(u.name), esc(u.email), ui.statusBadge(u.status), ui.statusBadge(u.kyc_status),
        u.agent_id ? '#' + u.agent_id : '<span class="muted">unassigned</span>', d(u.created_at),
        `<a class="btn btn-sm" href="${R(req, '/users/' + u.id)}">Manage</a>`,
      ])) + ui.paginate(`${R(req, '/users')}?f=${f}&q=${encodeURIComponent(q)}${req.query.agent ? '&agent=' + encodeURIComponent(req.query.agent) : ''}`, page, PER, total);
  res.send(shell(req, '/users', 'Users', body, 'Every account — players, agents and staff.'));
});

router.get('/users/:id', async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u) return notFound(req, res, 'User not found.');
  const wallets = await getBalances(req.db, u.id);
  const txs = await req.db.query('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 15', [u.id]);
  const logins = await req.db.query('SELECT * FROM login_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [u.id]);
  const acts = await req.db.query('SELECT * FROM audit_log WHERE actor_id = ? ORDER BY created_at DESC LIMIT 15', [u.id]);
  const tickets = await req.db.query('SELECT * FROM tickets WHERE user_id = ? ORDER BY created_at DESC LIMIT 10', [u.id]);
  /* USER-DETAIL-01: money snapshot additions — latest deposits and
     withdrawals for this user (the old page never showed them here). */
  const deps = await req.db.query('SELECT d.*, m.name AS method_name FROM deposits d LEFT JOIN payment_methods m ON m.id = d.method_id WHERE d.user_id = ? ORDER BY d.id DESC LIMIT 5', [u.id]);
  const wds = await req.db.query('SELECT w.*, m.name AS method_name FROM withdrawals w LEFT JOIN payment_methods m ON m.id = w.method_id WHERE w.user_id = ? ORDER BY w.id DESC LIMIT 5', [u.id]);
  const agents = await req.db.query("SELECT id, name FROM users WHERE role = 'agent' ORDER BY name");
  const agentOf = u.agent_id ? agents.find(a => a.id === u.agent_id) : null;
  const flags = await req.db.query('SELECT * FROM account_flags WHERE user_id = ? ORDER BY created_at DESC LIMIT 20', [u.id]);
  const kycDocs = await req.db.query('SELECT * FROM kyc_documents WHERE user_id = ? ORDER BY id DESC LIMIT 10', [u.id]);
  const refCredits = await req.db.query('SELECT * FROM referral_credits WHERE referrer_id = ? ORDER BY created_at DESC LIMIT 20', [u.id]);
  const referrer = u.referred_by ? await req.db.get('SELECT id, email FROM users WHERE id = ?', [u.referred_by]) : null;
  /* USER-DETAIL-01: the page used to open as a two-column wall —
     the 13-field biodata FORM first, Controls jammed beside it, and
     the facts an operator actually needs scattered below. Nothing is
     dropped; the page is re-assembled in operator order: summary band
     (who/what state/how much, at a glance) -> account facts -> money
     snapshot -> grouped Controls -> KYC -> fraud -> history -> and
     the EDIT form LAST (viewing is the daily job; editing is rare). */
  const initial = esc(String(u.name || u.email || '?').trim().charAt(0).toUpperCase() || '?');
  const summaryBand = `<div class="card user-summary">
    <div class="us-avatar">${initial}</div>
    <div class="us-main">
      <div class="us-name">${esc(u.name || '—')}</div>
      <div class="muted">${esc(u.email || '—')}${u.phone ? ' · ' + esc(u.phone) : ''}</div>
      <div class="us-badges">
        ${ui.badge(u.role, 'info')}
        ${u.status === 'banned' ? ui.badge('banned', 'bad') : ui.badge(u.status || 'active', 'ok')}
        ${ui.badge(u.email_verified ? 'email verified' : 'email not verified', u.email_verified ? 'ok' : 'warn')}
        ${ui.badge(u.mobile_verified ? 'phone verified' : 'phone not verified', u.mobile_verified ? 'ok' : 'warn')}
        ${ui.badge('KYC: ' + (u.kyc_status || 'none'), u.kyc_status === 'verified' ? 'ok' : 'muted')}
      </div>
      <div class="muted">Joined ${d(u.created_at)} · Last login ${u.last_login_at ? d(u.last_login_at) : 'never'}</div>
    </div>
    <div class="us-wallets">${wallets.length ? wallets.map(w => `<span class="us-chip">${esc(w.currency)} <strong>${money(req, w.balance, w.currency)}</strong></span>`).join('') : '<span class="muted">No wallets yet</span>'}</div>
  </div>`;
  const factsCard = ui.card('Account facts', ui.table(['Field', 'Value'], [
        ['Email verified', u.email_verified ? '✓ Yes' : '✗ No'],
        ['Phone verified', u.mobile_verified ? '✓ Yes' : '✗ No'],
        ['Referral code', esc(u.referral_code || '—')],
        ['Referred by', referrer ? ('#' + referrer.id + ' — ' + esc(referrer.email)) : '—'],
        ['Agent', agentOf ? ('#' + agentOf.id + ' — ' + esc(agentOf.name)) : 'Unassigned'],
        ['Two-factor (TOTP)', u.totp_secret ? '✓ Enabled' : '✗ Off'],
        ['Forced password reset', u.force_password_reset ? 'Yes — user must reset on next sign-in' : 'No'],
        ['Forced TOTP enrollment', u.force_totp_enroll ? 'Yes' : 'No'],
        ['Payout details last changed', u.payout_updated_at ? d(u.payout_updated_at) : 'Never'],
        ['Profile completed', (u.profile_completed === 0) ? '✗ Pending (signed up via OTP, name/terms not yet collected)' : '✓ Yes'],
      ]));
  const moneyCard = ui.card('Money snapshot',
      ui.table(['Currency', 'Balance'], wallets.map(w => [w.currency, money(req, w.balance, w.currency)])) +
      `<h4 class="mt">Recent deposits</h4>` + (deps.length ? ui.table(['When', 'ID', 'Method', 'Amount', 'Status'], deps.map(x => [d(x.created_at), `<span class="code">${esc(x.public_id)}</span>`, esc(x.method_name || '—'), money(req, x.net, x.currency), ui.statusBadge(x.status)])) : '<p class="muted">No deposits yet.</p>') +
      `<h4 class="mt">Recent withdrawals</h4>` + (wds.length ? ui.table(['When', 'ID', 'Method', 'Amount', 'Status'], wds.map(x => [d(x.created_at), `<span class="code">${esc(x.public_id)}</span>`, esc(x.method_name || '—'), money(req, x.net, x.currency), ui.statusBadge(x.status)])) : '<p class="muted">No withdrawals yet.</p>') +
      `<h4 class="mt">Recent tickets</h4>` + ui.table(['Ticket', 'Total', 'Status', 'When'], tickets.map(t =>
        [`<span class="code">${esc(t.public_id)}</span>`, money(req, t.total, t.currency), ui.statusBadge(t.status), d(t.created_at)])) + `<p class="mt"><a class="btn btn-sm" href="${R(req, '/tickets')}?q=${encodeURIComponent(u.email)}">View all tickets for this player →</a></p>`);
  const controlsCard = ui.card('Controls', `
        <h4>Access</h4>
        <p class="muted">Block stops sign-in and play. Revoke sessions signs the user out everywhere. Login as user opens their account in a new tab.</p>
        <div class="btn-row">
          <form method="POST" action="${R(req, '/users/' + u.id + '/block')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}">
            <button class="btn ${u.status === 'banned' ? 'btn-p' : 'btn-d'}">${u.status === 'banned' ? 'Unblock' : 'Block'}</button></form>
          <form method="POST" action="${R(req, '/users/' + u.id + '/revoke-sessions')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}">
            <button class="btn">Revoke sessions</button></form>
          <form method="POST" action="${R(req, '/users/' + u.id + '/login-as')}" style="display:inline" target="_blank"><input type="hidden" name="_csrf" value="${req.csrfToken}">
            <button class="btn btn-g">Login as user</button></form>
          <form method="POST" action="${R(req, '/users/' + u.id + '/verify-contact')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}">
            <button class="btn">Mark contact verified</button></form>
        </div>
        <h4 class="mt">Password</h4>
        <p class="muted">Reset password emails a link and lets the user choose privately. Set a new password is the opposite: YOU choose it here — for test or support cases. Either way the user is signed out everywhere, and a set password is never shown again after you submit.</p>
        <div class="btn-row">
          <form method="POST" action="${R(req, '/users/' + u.id + '/reset-password')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}">
            <button class="btn">Reset password (send link)</button></form>
        </div>
        <form method="POST" action="${R(req, '/users/' + u.id + '/set-password')}" class="adm-form">
          <input type="hidden" name="_csrf" value="${req.csrfToken}">
          <div class="field"><label for="setpw1">New password</label><input type="password" id="setpw1" name="new_password" required autocomplete="new-password"></div>
          <div class="field"><label for="setpw2">Confirm new password</label><input type="password" id="setpw2" name="new_password_confirm" required autocomplete="new-password"></div>
          <div class="field"><label><input type="checkbox" name="force_change" checked> User must change this password at next sign-in</label></div>
          <div class="mt"><button class="btn btn-p" type="submit">Set password</button></div>
        </form>
        <h4 class="mt">Money controls</h4>
        <p class="muted">Balance adjustment is a manual correction — audit-logged, with your remark. The matrix blocks this user's deposits or withdrawals only.</p>
        <form method="POST" action="${R(req, '/users/' + u.id + '/adjust')}" class="adm-form" style="display:flex;gap:8px;flex-wrap:wrap;align-items:end;">
          <input type="hidden" name="_csrf" value="${req.csrfToken}">
          <div class="field"><label>Direction</label><select name="direction"><option value="add">+ Add balance</option><option value="subtract">− Subtract balance</option></select></div>
          <div class="field"><label>Amount (major units, e.g. 10.00)</label><input type="text" name="amount" required placeholder="10.00"></div>
          <div class="field"><label>Remark (required, shown in audit)</label><input type="text" name="remark" required maxlength="200" placeholder="Why this adjustment?"></div>
          <div class="mt"><button class="btn btn-p" type="submit">Apply adjustment</button></div>
        </form>
        <h4 class="mt">Deposit / withdrawal matrix</h4>
        ${ui.formHtml(R(req, '/users/' + u.id + '/matrix'), [
          { key: 'deposit_blocked', label: 'Block deposits', type: 'checkbox', value: u.deposit_blocked },
          { key: 'withdrawal_blocked', label: 'Block withdrawals', type: 'checkbox', value: u.withdrawal_blocked },
          { key: 'deposit_mode', label: 'Deposit mode (blank = global)', type: 'select', options: ['', 'manual'], value: u.deposit_mode, help: 'Auto mode was removed: deposits are always manually reviewed, so an auto option would imply an approval that never happens.' },
          { key: 'withdrawal_mode', label: 'Withdrawal mode (blank = global)', type: 'select', options: ['', 'manual'], value: u.withdrawal_mode, help: 'Auto mode was removed: withdrawals are always manually reviewed.' },
        ], { csrf: req.csrfToken, submit: 'Save matrix' })}`);
  const kycCard = ui.card('KYC documents', (kycDocs.length ? ui.table(['#', 'Type', 'File', 'Status', 'Submitted', ''], kycDocs.map(doc => ['#' + doc.id, esc(({ national_id: 'National ID card', passport: 'Passport', driving_licence: 'Driving licence' }[doc.doc_type]) || doc.doc_type), esc(doc.original_name), ui.statusBadge(doc.status === 'approved' ? 'verified' : doc.status), d(doc.created_at), `<a class="btn btn-sm" href="${R(req, '/kyc/' + doc.id)}">Review</a>`])) : '<p class="muted">No documents submitted.</p>') + (u.kyc_status !== 'verified' ? `<h4 class="mt">Mark verified manually (off-platform verification)</h4>
        <form method="POST" action="${R(req, '/users/' + u.id + '/kyc-verify')}" class="adm-form">
          <input type="hidden" name="_csrf" value="${req.csrfToken}">
          <div class="field"><label>Attestation note (required — recorded in the audit log)</label><textarea name="note" required maxlength="500" placeholder="What was verified, where, and by whom"></textarea></div>
          <div class="mt"><button class="btn btn-p" type="submit">Mark verified manually</button></div>
        </form>` : '<p class="muted">This user is KYC-verified.</p>'));
  const fraudCard = ui.card('Fraud flags', flags.length ? ui.table(['When', 'Flag', 'Detail', 'Reviewed'], flags.map(f => [d(f.created_at), esc(FLAG_LABELS[f.flag_type] || String(f.flag_type || '').replace(/_/g, ' ')), esc(flagDetailText(f.detail)), f.reviewed_at ? '✓ ' + d(f.reviewed_at) : `<a class="btn btn-sm" href="${R(req, '/flags')}">Review</a>`])) : '<p class="muted">No flags.</p>');
  const historyCards = `
      ${ui.card('Recent transactions', ui.table(['When', 'Type', 'Amount', 'Balance after'], txs.map(t =>
        [d(t.created_at), esc(txLabel(t.type)), `<span class="${t.amount >= 0 ? 'pos' : 'neg'}">${money(req, t.amount, t.currency)}</span>`, money(req, t.balance_after, t.currency)]))) + `<p class="mt"><a class="btn btn-sm" href="${R(req, '/reports')}?type=transaction&q=${encodeURIComponent(u.email)}">View all transactions for this player →</a></p>`}
      ${ui.card('Referral credits (pending = awaiting referee deposit + wagering)', ui.table(['When', 'Referee', 'Amount', 'Status'], refCredits.map(c => [d(c.created_at), '#' + c.referee_id, money(req, c.amount, c.currency), ui.statusBadge(c.status)])))}
      ${ui.card('Login history', ui.table(['When', 'IP', 'Browser', 'OS', 'OK'], logins.map(l =>
        [d(l.created_at), esc(l.ip), esc(l.browser), esc(l.os), l.success ? '✓' : '✗']))) + `<p class="mt"><a class="btn btn-sm" href="${R(req, '/login-history')}?q=${encodeURIComponent(u.email)}">View full login history →</a></p>`}
      ${ui.card('Activity timeline', ui.table(['When', 'Action', 'Detail'], acts.map(a =>
        [d(a.created_at), esc(a.action), auditDetailHtml(req, a.detail)]))) + `<p class="mt"><a class="btn btn-sm" href="${R(req, '/audit')}?actor=${u.id}">View full audit trail for this user →</a></p>`}`;
  const biodataCard = ui.card('Edit details', ui.formHtml(R(req, '/users/' + u.id), [
        { key: 'name', label: 'Name', type: 'text', value: u.name, required: true },
        { key: 'email', label: 'Email', type: 'text', value: u.email },
        { key: 'phone', label: 'Phone', type: 'text', value: u.phone },
        { key: 'address', label: 'Address', type: 'text', value: u.address },
        { key: 'city', label: 'City', type: 'text', value: u.city },
        { key: 'state', label: 'State', type: 'text', value: u.state },
        { key: 'zip', label: 'Zip / Postal code', type: 'text', value: u.zip },
        { key: 'country', label: 'Country', type: 'text', value: u.country },
        { key: 'kyc_override', label: 'KYC requirement for this user', type: 'select', options: ['default', 'required', 'exempt'], value: u.kyc_override || 'default', help: 'default = follows the global KYC switch (Settings → KYC). required = this user must be KYC-approved before gated actions even when the global switch is off. exempt = never gated.' },
        { key: 'auto_withdrawal_limit', label: 'Auto-withdrawal limit', type: 'text', value: u.auto_withdrawal_limit === null || u.auto_withdrawal_limit === undefined ? '' : String(u.auto_withdrawal_limit), help: 'Blank = follow the global limit in Settings → Withdrawal & risk controls. A value (major units, e.g. 25.50) is this user\'s own ceiling; 0 = never auto-approve for this user. Auto-approval never pays out by itself.' },
        { key: 'agent_id', label: 'Agent', type: 'select', options: [{ v: '', l: 'Unassigned' }].concat(agents.map(a => ({ v: String(a.id), l: '#' + a.id + ' — ' + a.name }))), value: u.agent_id ? String(u.agent_id) : '' },
        { key: 'notes', label: 'Notes', type: 'textarea', value: u.notes },
      ], { csrf: req.csrfToken, submit: 'Save details' }) + `<p class="muted">KYC status: <strong>${esc(u.kyc_status)}</strong> — changes only through the KYC review queue or the manual-verification attestation (see the KYC card).</p>`);
  const body = `
  ${summaryBand}
  <div class="grid2">
    <div>${factsCard}</div>
    <div>${moneyCard}</div>
  </div>
  ${controlsCard}
  <div class="grid2">
    <div>${kycCard}</div>
    <div>${fraudCard}</div>
  </div>
  ${historyCards}
  ${biodataCard}`;
  res.send(shell(req, '/users', 'User #' + u.id + ' — ' + u.name, body, 'Who this is, what they hold, and everything you can do — in that order.'));
});

router.post('/users/:id', async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  // Staff accounts are off-limits here, exactly as in block/login-as: without
  // this, a risk-role staffer could change a super admin's email and take the
  // account over via the verification link (see below).
  if (!u || u.role === 'admin') return notFound(req, res, 'User not found.');
  // R-056: coerce every field first — the old .trim()/.toLowerCase() calls
  // crashed (500) on a missing field. R-057: whitelist kyc_status and verify
  // agent_id BEFORE writing anything.
  const b = req.body || {};
  /* U-20.3: String()-coercing a non-string body value (name[a]=b parses to
     an object under qs) stored the literal text "[object Object]" as the
     user's name. Only genuine strings are accepted; anything else reads
     as empty and fails the normal validation below. */
  const str = (v, max) => (typeof v === 'string' ? v : '').slice(0, max);
  const name = str(b.name, 255).trim();
  /* SCAN fix (C-06): kyc_status from the request body is IGNORED — the
     status changes only via the KYC queue / manual-verify attestation. */
  const kyc = u.kyc_status;
  const agentRaw = String(b.agent_id || '').trim();
  if (!name) { await req.setFlash('error', 'Name is required. Nothing was saved.'); return res.redirect(R(req, '/users/' + u.id)); }
  if (!['none', 'pending', 'verified', 'rejected'].includes(kyc)) { await req.setFlash('error', 'Invalid KYC status. Nothing was saved.'); return res.redirect(R(req, '/users/' + u.id)); }
  // BP-21/BP-22 per-user controls: validate BEFORE writing anything.
  const kycOverride = String(b.kyc_override || 'default');
  if (!['default', 'required', 'exempt'].includes(kycOverride)) { await req.setFlash('error', 'Invalid KYC requirement. Nothing was saved.'); return res.redirect(R(req, '/users/' + u.id)); }
  const autoRaw = String(b.auto_withdrawal_limit || '').trim();
  let autoLimit = null;
  if (autoRaw !== '') {
    if (!/^\d+(\.\d{1,2})?$/.test(autoRaw)) { await req.setFlash('error', 'Auto-withdrawal limit must be an amount like 25 or 25.50, or blank for the global limit. Nothing was saved.'); return res.redirect(R(req, '/users/' + u.id)); }
    autoLimit = autoRaw;
  }
  let agentId = null;
  if (agentRaw !== '') {
    agentId = parseInt(agentRaw, 10);
    const ag = await req.db.get("SELECT id FROM users WHERE id = ? AND role = 'agent'", [agentId]);
    if (!ag) { await req.setFlash('error', 'That agent does not exist. Nothing was saved.'); return res.redirect(R(req, '/users/' + u.id)); }
  }
  {
    const phoneIn = str(b.phone, 32).trim();
    if (phoneIn) {
      const { isBlockedPhone } = require('../lib/phone-countries');
      if (isBlockedPhone(req.settings, phoneIn)) { await req.setFlash('error', 'Phone numbers from this country are not accepted on this platform. Nothing was saved.'); return res.redirect(R(req, '/users/' + u.id)); }
    }
  }
  await req.db.run('UPDATE users SET name = ?, phone = ?, address = ?, city = ?, state = ?, zip = ?, country = ?, kyc_status = ?, notes = ?, agent_id = ?, kyc_override = ?, auto_withdrawal_limit = ? WHERE id = ?',
    [name, str(b.phone, 32),
     str(b.address, 255), str(b.city, 128),
     str(b.state, 128), str(b.zip, 32),
     str(b.country, 64),
     kyc, str(b.notes, 2000), agentId, kycOverride, autoLimit, u.id]);
  // v14: admin email changes NEVER swap immediately — a verification link
  // goes to the NEW address; the swap happens only when it is clicked.
  let emailChangeMsg = '';
  let emailChangeRefused = false, emailChangePending = false;
  const emailIn = typeof b.email === 'string' ? b.email : '';
  if (emailIn && validEmail(emailIn) && emailIn.toLowerCase() !== u.email) {
    const newEmail = emailIn.trim().toLowerCase();
    // Never let an admin-initiated change steal an address another account
    // owns (the verify-click swap also re-checks at click time).
    const dup = await req.db.get('SELECT id FROM users WHERE email = ? AND id != ?', [newEmail, u.id]);
    if (dup) {
      emailChangeMsg = ' Email change refused — another account already uses that address.';
      emailChangeRefused = true;
    } else {
    // R-014: invalidate prior pending verification rows first, so an older
    // A→B token cannot swap the address back after a newer A→C change.
    await req.db.run('UPDATE email_verifications SET used = 1 WHERE user_id = ? AND used = 0', [u.id]);
    emailChangePending = true;
    const token = randHex(24);
    await req.db.run('INSERT INTO email_verifications (user_id, new_email, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)',
      [u.id, newEmail, sha256('verify:' + token), now() + 24 * 3600 * 1000, now()]);
    const link = (process.env.BASE_URL || (req.protocol + '://' + req.get('host'))) + '/verify-email/' + token; // D2-C9/D3-C8: A-09 host fallback
    const sent = await notify.send(req.db, req.settings, 'email', 'email_verification', newEmail, { name: u.name, link }).catch(() => ({ status: 'failed' }));
    emailChangeMsg = sent.status === 'sent'
      ? ' Email change requested — verification link sent to the new address (old email stays until verified).'
      : ' Email change requested — no email provider configured. Forward this one-time link to the user (do not click it yourself unless attesting the address): ' + link;
    }
  }
  // R-057: audit the email actually STORED (unchanged until the new
  // address verifies), not the requested one — the old detail logged the
  // requested address even when the change was refused.
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'user.update', entity: 'user', entityId: u.id, detail: { by: req.user.id, old: { name: u.name, email: u.email, phone: u.phone, kyc_status: u.kyc_status, agent_id: u.agent_id, kyc_override: u.kyc_override || 'default', auto_withdrawal_limit: u.auto_withdrawal_limit }, new: { name, email_stored: u.email, email_requested: emailIn || u.email, email_change_refused: emailChangeRefused, email_change_pending: emailChangePending, phone: str(b.phone, 32), kyc_status: kyc, agent_id: agentId, kyc_override: kycOverride, auto_withdrawal_limit: autoLimit } }, ip: req.ip });
  await req.setFlash('success', 'User updated.' + emailChangeMsg);
  res.redirect(R(req, '/users/' + u.id));
});

/* BP-21: manual KYC verification — the admin attests the player was
   verified off-platform. A note is REQUIRED and the attestation is
   audit-logged; without a note nothing changes. */
router.post('/users/:id/kyc-verify', async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u || u.role === 'admin') return notFound(req, res, 'User not found.');
  const note = String(req.body.note || '').trim().slice(0, 500);
  if (!note) { await req.setFlash('error', 'A note is required for manual verification — record what was verified off-platform. Nothing changed.'); return res.redirect(R(req, '/users/' + u.id)); }
  await req.db.run("UPDATE users SET kyc_status = 'verified', kyc_note = '' WHERE id = ?", [u.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'kyc.manual_verify', entity: 'user', entityId: u.id, detail: { note, previous_status: u.kyc_status }, ip: req.ip });
  await req.setFlash('success', 'User marked KYC-verified (manual attestation recorded in the audit log).');
  res.redirect(R(req, '/users/' + u.id));
});

router.post('/users/:id/block', async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u || u.role === 'admin') return notFound(req, res, 'User not found.');
  // R-050: unblock restores the PRE-BAN status. The old code always landed
  // 'active', so pending_review → blocked → unblocked skipped review.
  // Users banned before v11 (no pre_ban_status) fall back to 'active'.
  let next, preBan = u.pre_ban_status || '';
  if (u.status === 'banned') {
    next = ['active', 'pending_review'].includes(preBan) ? preBan : 'active';
    await req.db.run("UPDATE users SET status = ?, pre_ban_status = '' WHERE id = ?", [next, u.id]);
  } else {
    next = 'banned';
    await req.db.run('UPDATE users SET status = ?, pre_ban_status = ? WHERE id = ?', [next, u.status, u.id]);
    await destroyUserSessions(req.db, u.id);
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: next === 'banned' ? 'user.block' : 'user.unblock', entity: 'user', entityId: u.id, detail: { old_status: u.status, new_status: next, restored_from: u.status === 'banned' ? preBan : undefined }, ip: req.ip });
  await req.setFlash('success', `User ${next}.`);
  res.redirect(R(req, '/users/' + u.id));
});

router.post('/users/:id/reset-password', async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u || u.role === 'admin') return notFound(req, res, 'User not found.');
  // v14: no temp-password flash — the user sets their own password via a
  // one-time reset link (same token flow as /forgot). If email is not
  // configured, the one-time link is shown to the admin to forward.
  // R-030 (admin half): a new reset token invalidates all prior unused
  // ones, so only the latest link works (same rule as the user flow).
  await req.db.run('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0', [u.id]);
  const token = randHex(24);
  await req.db.run('INSERT INTO password_resets (user_id, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)',
    [u.id, sha256('reset:' + token), now() + 3600000, now()]);
  await destroyUserSessions(req.db, u.id);
  const link = (process.env.BASE_URL || (req.protocol + '://' + req.get('host'))) + '/reset/' + token; // D2-C9/D3-C8: A-09 host fallback
  let msg;
  if (u.email && !u.email.endsWith('@phone.local')) {
    const sent = await notify.send(req.db, req.settings, 'email', 'password_reset', u.email, { name: u.name, link }).catch(() => ({ status: 'failed' }));
    msg = sent.status === 'sent' ? 'Password reset link emailed to the user (valid 1 hour).' : 'Password reset link created (valid 1 hour) — email is not configured, forward this one-time link: ' + link;
  } else {
    msg = 'Password reset link created (valid 1 hour) — user has no email on file, forward this one-time link: ' + link;
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'user.password_reset_admin', entity: 'user', entityId: u.id, detail: { via: 'reset_link' }, ip: req.ip });
  await req.setFlash('success', msg);
  res.redirect(R(req, '/users/' + u.id));
});

/* USER-PASS-SET-01: admin DIRECTLY sets a non-admin user's password
   (the reset-link flow above stays untouched). Same validation as a
   self-set password for that role + breached screening; all sessions
   destroyed; unused reset tokens invalidated; the audit detail carries
   ONLY the forced flag — never the password or its hash. */
router.post('/users/:id/set-password', async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u || u.role === 'admin') return notFound(req, res, 'User not found.');
  const back = R(req, '/users/' + u.id);
  const { passwordError } = require('../lib/validate');
  const { isBreached } = require('../lib/breached');
  const pw = String(req.body.new_password || '');
  const pw2 = String(req.body.new_password_confirm || '');
  let err = passwordError(pw, u.role, getBool(req.settings, 'secure_password', true));
  if (!err && pw !== pw2) err = 'Passwords do not match.';
  if (!err && getBool(req.settings, 'breached_password_check', true) && await isBreached(pw)) err = 'This password has appeared in a data breach. Please choose a different one.';
  if (err) { await req.setFlash('error', 'Password NOT set: ' + err); return res.redirect(back); }
  const forced = req.body.force_change ? 1 : 0;
  await req.db.run('UPDATE users SET password_hash = ?, force_password_reset = ? WHERE id = ?', [hashPassword(pw), forced, u.id]);
  await req.db.run('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0', [u.id]);
  await destroyUserSessions(req.db, u.id);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'user.password_set_admin', entity: 'user', entityId: u.id, detail: { forced: !!forced }, ip: req.ip });
  await req.setFlash('success', forced
    ? 'Password set for ' + u.name + '. They are signed out everywhere and must choose their own password at next sign-in.'
    : 'Password set for ' + u.name + '. They are signed out everywhere and can sign in with the new password right away.');
  res.redirect(back);
});

router.post('/users/:id/revoke-sessions', async (req, res) => {
  const tgt = await req.db.get('SELECT role FROM users WHERE id = ?', [req.params.id]);
  if (!tgt || tgt.role === 'admin') return notFound(req, res, 'User not found.');
  await destroyUserSessions(req.db, parseInt(req.params.id, 10));
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'user.sessions_revoke', entity: 'user', entityId: req.params.id, detail: {}, ip: req.ip });
  await req.setFlash('success', 'All sessions revoked.');
  res.redirect(R(req, '/users/' + req.params.id));
});

/* Manual balance adjustment (+/- with remark, audit-logged) */
router.post('/users/:id/adjust', async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u || u.role === 'admin') return notFound(req, res, 'User not found.');
  const currency = getS(req.settings, 'base_currency', 'USD');
  const amount = toMinor(req.body.amount, decimalsFor(currency, getCurrencies(req.settings))); // D1-C6: base-currency decimals, not the bare 2dp default
  const remark = String(req.body.remark || '').trim();
  if (amount === null || amount <= 0 || !remark) { await req.setFlash('error', 'Enter a valid amount and a remark.'); return res.redirect(R(req, '/users/' + u.id)); }
  const signed = req.body.direction === 'subtract' ? -amount : amount;
  // R-013: a balance adjustment is a money action — at/above the threshold
  // it queues for a second approver instead of executing immediately.
  const mc = await maybeMakerChecker(req, 'balance.adjust', 'user', u.id, Math.abs(signed), currency, { currency, signed, direction: req.body.direction, remark });
  if (mc) {
    await req.setFlash('success', 'This adjustment exceeds the maker-checker threshold and is queued for a second approver (see Approvals).' + (mc.conflictId ? ` Note: approval #${mc.conflictId} for this user is already open.` : ''));
    return res.redirect(R(req, '/users/' + u.id));
  }
  const before = (await getBalances(req.db, u.id)).find(w => w.currency === currency);
  await req.db.transaction(async (tx) => {
    await postLedger(tx, { userId: u.id, currency, type: 'adjustment', amount: signed, refType: 'admin_adjustment', refId: 'ADJ' + now(), meta: { remark, admin_id: req.user.id, direction: req.body.direction } });
  });
  const after = (await getBalances(req.db, u.id)).find(w => w.currency === currency);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'user.balance_adjust', entity: 'user', entityId: u.id, detail: { amount: signed, currency, remark, old_balance: before ? before.balance : 0, new_balance: after ? after.balance : 0 }, ip: req.ip });
  await req.setFlash('success', 'Balance adjusted by ' + money(req, signed, currency) + '.');
  res.redirect(R(req, '/users/' + u.id));
});
router.post('/users/:id/matrix', async (req, res) => {
  const tgt = await req.db.get('SELECT role FROM users WHERE id = ?', [req.params.id]);
  if (!tgt || tgt.role === 'admin') return notFound(req, res, 'User not found.');
  const old = await req.db.get('SELECT deposit_blocked, withdrawal_blocked, deposit_mode, withdrawal_mode FROM users WHERE id = ?', [req.params.id]);
  const nv = {
    deposit_blocked: req.body.deposit_blocked ? 1 : 0, withdrawal_blocked: req.body.withdrawal_blocked ? 1 : 0,
    // R-044: 'auto' is no longer accepted anywhere — a crafted POST with
    // auto falls back to blank (= global, which is manual-only).
    deposit_mode: ['', 'manual'].includes(req.body.deposit_mode) ? req.body.deposit_mode : '',
    withdrawal_mode: ['', 'manual'].includes(req.body.withdrawal_mode) ? req.body.withdrawal_mode : '',
  };
  await req.db.run('UPDATE users SET deposit_blocked = ?, withdrawal_blocked = ?, deposit_mode = ?, withdrawal_mode = ? WHERE id = ?',
    [nv.deposit_blocked, nv.withdrawal_blocked, nv.deposit_mode, nv.withdrawal_mode, req.params.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'user.matrix_update', entity: 'user', entityId: req.params.id, detail: { old: old || {}, new: nv }, ip: req.ip });
  await req.setFlash('success', 'Control matrix saved.');
  res.redirect(R(req, '/users/' + req.params.id));
});

router.post('/users/:id/verify-contact', async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u || u.role === 'admin') return notFound(req, res, 'User not found.');
  // Admin attestation: used when no email/SMS provider is configured and the
  // player cannot self-verify. Sets only the flags that have a real value on
  // file (a phone.local placeholder email never counts as verified).
  const setEmail = (u.email && !u.email.endsWith('@phone.local')) ? 1 : (u.email_verified || 0);
  const setMobile = u.phone ? 1 : (u.mobile_verified || 0);
  await req.db.run('UPDATE users SET email_verified = ?, mobile_verified = ? WHERE id = ?', [setEmail, setMobile, u.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'user.contact_verified', entity: 'user', entityId: u.id, detail: { by: req.user.id, email_verified: setEmail, mobile_verified: setMobile }, ip: req.ip });
  await req.setFlash('success', 'Contact marked verified (admin attestation).');
  res.redirect(R(req, '/users/' + u.id));
});

router.post('/users/:id/login-as', async (req, res) => {
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.params.id]);
  if (!u || u.role === 'admin') return notFound(req, res, 'User not found.');
  const sid = await createSession(req.db, u.id, { ip: req.ip, ua: req.headers['user-agent'], extra: { impersonated_by: req.user.id, impersonated_name: req.user.name } });
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'user.login_as', entity: 'user', entityId: u.id, detail: {}, ip: req.ip });
  res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', secure: req.secure || getBool(req.settings, 'force_ssl', false), maxAge: 7 * 24 * 3600 * 1000 });
  res.redirect('/');
});

/* ============================================================ OTP CODES */
router.get('/otp', async (req, res) => {
  const page = pageOf(req);
  const otpTotal = (await req.db.get('SELECT COUNT(*) AS c FROM otp_codes')).c;
  const codes = await req.db.query('SELECT * FROM otp_codes ORDER BY created_at DESC LIMIT ? OFFSET ?', [PER, (page - 1) * PER]);
  const body = ui.card('Issue signup code', `<p class="muted">Codes are single-use (or limited-use), hashed, and expire. Share a code with the player; they enter it at registration when OTP-gated registration is ON.</p>` +
    ui.formHtml(R(req, '/otp'), [
      { key: 'label', label: 'Label (e.g. player name)', type: 'text' },
      { key: 'max_uses', label: 'Max uses', type: 'number', value: '1' },
      { key: 'expires_hours', label: 'Expires in (hours)', type: 'number', value: '72' },
    ], { csrf: req.csrfToken, submit: 'Generate code' })) +
    ui.card('Codes', ui.table(['ID', 'Label', 'Uses', 'Expires', 'Revoked', 'Created', ''],
      codes.map(c => [c.id, esc(c.label), `${c.uses}/${c.max_uses}`, c.expires_at ? d(c.expires_at) : 'never',
        c.revoked ? ui.badge('revoked', 'err') : ui.badge('live', 'ok'), d(c.created_at),
        c.revoked ? '' : `<form method="POST" action="${R(req, '/otp/' + c.id + '/revoke')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm btn-d">Revoke</button></form>`]))) + ui.paginate(R(req, '/otp'), page, PER, otpTotal);
  res.send(shell(req, '/otp', 'OTP Signup Codes', body, 'One-time codes issued for sign-up and verification.'));
});

router.post('/otp', async (req, res) => {
  const code = randHex(4).toUpperCase().match(/.{4}/g).join('-');
  const hours = Math.max(1, parseInt(req.body.expires_hours, 10) || 72);
  await req.db.run('INSERT INTO otp_codes (code_hash, label, max_uses, uses, expires_at, created_by, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)',
    [sha256('otp:' + code), String(req.body.label || '').slice(0, 255), Math.max(1, parseInt(req.body.max_uses, 10) || 1), now() + hours * 3600000, req.user.id, now()]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'otp.issue', entity: 'otp', entityId: '', detail: { label: req.body.label }, ip: req.ip });
  await req.setFlash('success', 'New signup code: ' + code + ' — copy it now, it cannot be viewed again.');
  res.redirect(R(req, '/otp'));
});

router.post('/otp/:id/revoke', async (req, res) => {
  // R-103: the old revoke "succeeded" for a missing or already-revoked code.
  const r = await req.db.run('UPDATE otp_codes SET revoked = 1 WHERE id = ? AND revoked = 0', [req.params.id]);
  if (r.changes !== 1) { await req.setFlash('error', 'Code not found or already revoked.'); return res.redirect(R(req, '/otp')); }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'otp.revoke', entity: 'otp', entityId: req.params.id, detail: {}, ip: req.ip });
  await req.setFlash('success', 'Code revoked.');
  res.redirect(R(req, '/otp'));
});

/* ============================================================ AGENTS */
router.get('/agents', async (req, res) => {
  // R-069: the old list ran 3 queries PER agent (N+1). Three grouped
  // queries now serve the whole page, which also paginates.
  const page = pageOf(req);
  const total = (await req.db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'agent'")).c;
  const agents = await req.db.query("SELECT * FROM users WHERE role = 'agent' ORDER BY created_at DESC LIMIT ? OFFSET ?", [PER, (page - 1) * PER]);
  const playerCounts = await req.db.query("SELECT agent_id, COUNT(*) AS c FROM users WHERE role = 'player' AND agent_id IS NOT NULL GROUP BY agent_id");
  const commSums = await req.db.query('SELECT agent_id, currency, COALESCE(SUM(amount),0) AS s FROM commissions GROUP BY agent_id, currency'); // CURRENCY-SYSTEM-01: per-currency, never one mixed sum
  const allFloats = await req.db.query('SELECT agent_id, currency, balance FROM agent_floats');
  const pcMap = Object.fromEntries(playerCounts.map(r => [r.agent_id, r.c]));
  const csMap = {}; for (const r of commSums) (csMap[r.agent_id] = csMap[r.agent_id] || []).push(r);
  const flMap = {};
  for (const f of allFloats) (flMap[f.agent_id] = flMap[f.agent_id] || []).push(f);
  for (const a of agents) {
    a.players = pcMap[a.id] || 0;
    a.floats = flMap[a.id] || [];
    a.comm = csMap[a.id] || [];
  }
  const body = ui.card('Create agent', ui.formHtml(R(req, '/agents'), [
    { key: 'name', label: 'Name', type: 'text', required: true },
    { key: 'email', label: 'Email', type: 'text', required: true },
    { key: 'password', label: 'Password', type: 'text', required: true },
  ], { csrf: req.csrfToken, submit: 'Create agent' })) +
    ui.card('Agents', ui.table(['ID', 'Name', 'Email', 'Players', 'Float', 'Commissions', 'Status', ''],
      agents.map(a => [a.id, esc(a.name), esc(a.email), a.players,
        a.floats.map(f => `${f.currency} ${money(req, f.balance, f.currency)}`).join('<br>') || '—',
        (a.comm.length ? a.comm.map(r => money(req, r.s, r.currency)).join('<br>') : money(req, 0, getS(req.settings, 'base_currency', 'USD'))), ui.statusBadge(a.status),
        `<a class="btn btn-sm" href="${R(req, '/agents/' + a.id)}">Manage</a>`])) + ui.paginate(R(req, '/agents'), page, PER, total));
  res.send(shell(req, '/agents', 'Agents', body, 'Cash agents, their floats and commissions.'));
});

router.post('/agents', async (req, res) => {
  /* U-20.4: same object-field guard as POST /staff. */
  const name = typeof req.body.name === 'string' ? req.body.name : '';
  const email = typeof req.body.email === 'string' ? req.body.email : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  // v14: agents get a 10-char minimum + forced reset on first login (they
  // must set their own password before doing anything).
  const pwErr = passwordError(password, 'agent', getBool(req.settings, 'secure_password', true));
  if (!name || !validEmail(email) || pwErr) { await req.setFlash('error', pwErr || 'Name and valid email required.'); return res.redirect(R(req, '/agents')); }
  if (getBool(req.settings, 'breached_password_check', true) && await isBreached(password)) { await req.setFlash('error', 'This password has appeared in a data breach. Choose a different one.'); return res.redirect(R(req, '/agents')); }
  const dup = await req.db.get('SELECT id FROM users WHERE email = ?', [email.trim().toLowerCase()]);
  if (dup) { await req.setFlash('error', 'An account with that email already exists.'); return res.redirect(R(req, '/agents')); }
  const r = await req.db.run("INSERT INTO users (email, name, password_hash, role, status, force_password_reset, created_at) VALUES (?, ?, ?, 'agent', 'active', 1, ?)",
    [email.trim().toLowerCase(), name.trim(), hashPassword(password), now()]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'agent.create', entity: 'user', entityId: r.id, detail: { force_password_reset: 1 }, ip: req.ip });
  await req.setFlash('success', 'Agent created. They must set their own password on first sign-in.');
  res.redirect(R(req, '/agents'));
});

router.get('/agents/:id', async (req, res) => {
  const a = await req.db.get("SELECT * FROM users WHERE id = ? AND role = 'agent'", [req.params.id]);
  if (!a) return notFound(req, res, 'Agent not found.');
  const floats = await req.db.query('SELECT currency, balance FROM agent_floats WHERE agent_id = ?', [a.id]);
  const players = await req.db.query("SELECT id, name, email, created_at FROM users WHERE agent_id = ? AND role = 'player'", [a.id]);
  const comms = await req.db.query('SELECT * FROM commissions WHERE agent_id = ? ORDER BY created_at DESC LIMIT 25', [a.id]);
  const transfers = await req.db.query('SELECT * FROM agent_transfers WHERE from_agent = ? ORDER BY created_at DESC LIMIT 25', [a.id]);
  const unsettled = await req.db.query('SELECT currency, COUNT(*) AS n, COALESCE(SUM(amount),0) AS s FROM commissions WHERE agent_id = ? AND settled = 0 GROUP BY currency', [a.id]);
  const body = `
  <div class="grid2"><div>
    ${ui.card('Fund float', `<p class="muted">Add house funds to this agent's float. Agents fund players from their float.</p>` +
      ui.formHtml(R(req, '/agents/' + a.id + '/fund'), [
        { key: 'currency', label: 'Currency', type: 'text', value: getS(req.settings, 'base_currency', 'USD'), required: true },
        { key: 'amount', label: 'Amount', type: 'text', required: true },
        { key: 'note', label: 'Note', type: 'text' },
      ], { csrf: req.csrfToken, submit: 'Add funds' }))}
    ${ui.card('Float balances', ui.table(['Currency', 'Balance'], floats.map(f => [f.currency, money(req, f.balance, f.currency)])))}
  </div><div>
    ${ui.card('Players (' + players.length + ')', ui.table(['ID', 'Name', 'Email', 'Joined'], players.map(p => [p.id, esc(p.name), esc(p.email), d(p.created_at)])) + `<p class="mt"><a class="btn btn-sm" href="${R(req, '/users')}?agent=${a.id}">View all players for this agent →</a></p>`)}
    ${ui.card('Commissions', ui.table(['When', 'Amount', 'Rate', 'Settled'], comms.map(c => [d(c.created_at), money(req, c.amount, c.currency), c.rate + '%', c.settled ? '✓ ' + d(c.settled_at) : '—'])))}
    ${ui.card('Settle commissions', `<p class="muted">Unsettled commissions are paid to the agent's wallet through the ledger (one entry per currency) and marked settled so they can never be paid twice. ${unsettled.length ? 'Unsettled now: ' + unsettled.map(x => `${x.n} × ${money(req, x.s, x.currency)}`).join(', ') : 'Nothing unsettled.'}</p>` +
      ui.formHtml(R(req, '/agents/' + a.id + '/settle-commissions'), [], { csrf: req.csrfToken, submit: 'Settle unpaid commissions' }))}
    ${ui.card('Transfers', ui.table(['When', 'To user', 'Amount', 'Note'], transfers.map(t => [d(t.created_at), '#' + t.to_user, money(req, t.amount, t.currency), esc(t.note)])))}
  </div></div>`;
  res.send(shell(req, '/agents', 'Agent — ' + a.name, body));
});

router.post('/agents/:id/settle-commissions', async (req, res) => {
  const a = await req.db.get("SELECT * FROM users WHERE id = ? AND role = 'agent'", [req.params.id]);
  if (!a) return notFound(req, res, 'Agent not found.');
  // R-013: commission settlement is a money action — at/above the threshold
  // it queues for a second approver. The threshold compares the largest
  // single-currency unsettled total (mixed-currency sums are meaningless).
  const unsettled = await req.db.query('SELECT currency, COALESCE(SUM(amount),0) AS s FROM commissions WHERE agent_id = ? AND settled = 0 GROUP BY currency', [a.id]);
  const { amt, cur } = maxCurEntry(Object.fromEntries(unsettled.map(r => [r.currency, r.s])), getS(req.settings, 'base_currency', 'USD'));
  const mc = await maybeMakerChecker(req, 'agent.commissions_settle', 'agent', a.id, amt, cur, { per_currency: Object.fromEntries(unsettled.map(r => [r.currency, r.s])) });
  if (mc) {
    await req.setFlash('success', 'This settlement exceeds the maker-checker threshold and is queued for a second approver (see Approvals).' + (mc.conflictId ? ` Note: approval #${mc.conflictId} for this agent is already open.` : ''));
    return res.redirect(R(req, '/agents/' + req.params.id));
  }
  try {
    const r = await settleAgentCommissions(req.db, a.id, req.user.id);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'agent.commissions_settled', entity: 'user', entityId: a.id, detail: { settled: r.settled, total: r.total }, ip: req.ip });
    await req.setFlash('success', r.settled ? `Settled ${r.settled} commission(s) to the agent wallet.` : 'No unsettled commissions.');
  } catch (e) { await req.setFlash('error', e.message); }
  res.redirect(R(req, '/agents/' + req.params.id));
});

router.post('/agents/:id/fund', async (req, res) => {
  const currency = String(req.body.currency || '').toUpperCase().slice(0, 8);
  const amount = toMinor(req.body.amount, decimalsFor(currency, getCurrencies(req.settings))); // D1-C6: the funded currency's decimals
  if (!amount || amount <= 0) { await req.setFlash('error', 'Invalid amount.'); return res.redirect(R(req, '/agents/' + req.params.id)); }
  // R-051: funding used to work for ANY id — a typo funded a nonexistent
  // agent's float (or a player's id). Verify existence + agent role + active.
  const ag = await req.db.get("SELECT id, status FROM users WHERE id = ? AND role = 'agent'", [req.params.id]);
  if (!ag || ag.status !== 'active') return notFound(req, res, 'Agent not found or not active.');
  if (!getCurrencies(req.settings).some(c => c.code === currency)) { await req.setFlash('error', 'Unknown currency.'); return res.redirect(R(req, '/agents/' + req.params.id)); }
  // R-013: float funding is a money action — threshold queues it.
  const mc = await maybeMakerChecker(req, 'agent.float_fund', 'agent', ag.id, amount, currency, { currency, amount, note: String(req.body.note || '').slice(0, 255) });
  if (mc) {
    await req.setFlash('success', 'This funding exceeds the maker-checker threshold and is queued for a second approver (see Approvals).' + (mc.conflictId ? ` Note: approval #${mc.conflictId} for this agent is already open.` : ''));
    return res.redirect(R(req, '/agents/' + req.params.id));
  }
  await fundAgentFloat(req.db, ag.id, currency, amount);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'agent.float_fund', entity: 'user', entityId: req.params.id, detail: { amount, currency, note: req.body.note }, ip: req.ip });
  await req.setFlash('success', 'Float funded.');
  res.redirect(R(req, '/agents/' + req.params.id));
});

/* ============================================================ DEPOSITS */
function moneyTabs(req, base, counts, active, extra = []) {
  const tabs = [['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['revoked', 'Revoked'], ['expired', 'Expired'], ...extra];
  return `<div class="tabs"><a class="tab${!active ? ' active' : ''}" href="${base}">All <span class="count">${counts.all}</span></a>` +
    tabs.map(([k, l]) => `<a class="tab${active === k ? ' active' : ''}" href="${base}?status=${k}">${l} <span class="count">${counts[k] || 0}</span></a>`).join('') + '</div>';
}
router.get('/deposits', async (req, res) => {
  const page = pageOf(req), status = req.query.status || '';
  const counts = { all: (await req.db.get('SELECT COUNT(*) AS c FROM deposits')).c };
  for (const s of ['pending', 'approved', 'rejected', 'revoked', 'expired']) counts[s] = (await req.db.get('SELECT COUNT(*) AS c FROM deposits WHERE status = ?', [s])).c;
  // R-107: the old strip summed every currency into one base-currency
  // number. Totals now split by currency (a currency with no rows shows 0).
  const depRows = await req.db.query('SELECT currency, status, COALESCE(SUM(net),0) AS s FROM deposits GROUP BY currency, status');
  const depByCur = {};
  for (const r of depRows) (depByCur[r.currency] = depByCur[r.currency] || {})[r.status] = r.s;
  const depCurs = Object.keys(depByCur).sort();
  const depStrip = depCurs.length
    ? `<div class="sumstrip">${depCurs.map(c => `<span><strong>${esc(c)}</strong> Successful: <strong>${money(req, depByCur[c].approved || 0, c)}</strong> · Pending: <strong>${money(req, depByCur[c].pending || 0, c)}</strong> · Rejected: <strong>${money(req, depByCur[c].rejected || 0, c)}</strong> · Revoked: <strong>${money(req, depByCur[c].revoked || 0, c)}</strong> · Expired: <strong>${money(req, depByCur[c].expired || 0, c)}</strong></span>`).join('')}</div>`
    : '<div class="sumstrip"><span>No deposits yet.</span></div>';
  // DS-066: the list only filtered by status - staff could not find one
  // deposit by player, method or date. All filters compose with status.
  const fQ = String(req.query.q || '').trim();
  const fMethod = parseInt(req.query.method || '', 10) || 0;
  const fFrom = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '';
  const fTo = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '';
  const dClauses = [], dParams = [];
  if (status) { dClauses.push('d.status = ?'); dParams.push(status); }
  if (fQ) { dClauses.push('(u.email LIKE ? OR d.public_id LIKE ?)'); dParams.push('%' + fQ + '%', '%' + fQ + '%'); }
  if (fMethod) { dClauses.push('d.method_id = ?'); dParams.push(fMethod); }
  if (fFrom) { dClauses.push('d.created_at >= ?'); dParams.push(Date.parse(fFrom + 'T00:00:00Z')); }
  if (fTo) { dClauses.push('d.created_at < ?'); dParams.push(Date.parse(fTo + 'T00:00:00Z') + 86400000); }
  const where = dClauses.length ? 'WHERE ' + dClauses.join(' AND ') : '', params = dParams;
  const total = (await req.db.get(`SELECT COUNT(*) AS c FROM deposits d JOIN users u ON u.id = d.user_id ${where}`, params)).c;
  const rows = await req.db.query(
    `SELECT d.*, u.email, m.name AS method_name FROM deposits d JOIN users u ON u.id = d.user_id LEFT JOIN payment_methods m ON m.id = d.method_id
     ${where} ORDER BY d.created_at DESC LIMIT ? OFFSET ?`, [...params, PER, (page - 1) * PER]);
  const allMethods = await req.db.query('SELECT id, name FROM payment_methods ORDER BY name');
  const qsParts = [];
  if (status) qsParts.push('status=' + encodeURIComponent(status));
  if (fQ) qsParts.push('q=' + encodeURIComponent(fQ));
  if (fMethod) qsParts.push('method=' + fMethod);
  if (fFrom) qsParts.push('from=' + fFrom);
  if (fTo) qsParts.push('to=' + fTo);
  const dFilterForm = `<form method="GET" action="${R(req, '/deposits')}" class="filter-form">
    ${status ? `<input type="hidden" name="status" value="${esc(status)}">` : ''}
    <input type="search" name="q" value="${esc(fQ)}" placeholder="Player email or deposit ID">
    <select name="method"><option value="">All methods</option>${allMethods.map(m => `<option value="${m.id}"${fMethod === m.id ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
    <input type="date" name="from" value="${esc(fFrom)}"><input type="date" name="to" value="${esc(fTo)}">
    <button class="btn btn-sm" type="submit">Filter</button>
    ${(fQ || fMethod || fFrom || fTo) ? `<a class="btn btn-sm" href="${R(req, '/deposits')}${status ? '?status=' + esc(status) : ''}">Clear</a>` : ''}
  </form>`;
  const body = depStrip + moneyTabs(req, R(req, '/deposits'), counts, status) + dFilterForm + `<div class="btn-row" style="margin-bottom:12px"><a class="btn btn-sm" href="${R(req, '/data')}?dataset=deposits">Export deposits (CSV) →</a></div>` + ui.table(['ID', 'Player', 'Method', 'Amount', 'Charge', 'Net', 'Status', 'When', ''],
    rows.map(x => [`<span class="code">${esc(x.public_id)}</span>`, esc(x.email), esc(x.method_name || '—'),
      money(req, x.amount, x.currency), money(req, x.charge, x.currency), money(req, x.net, x.currency),
      ui.statusBadge(x.status), d(x.created_at), `<a class="btn btn-sm" href="${R(req, '/deposits/' + x.id)}">Review</a>`])) +
    ui.paginate(R(req, '/deposits') + (qsParts.length ? '?' + qsParts.join('&') : ''), page, PER, total);
  res.send(shell(req, '/deposits', 'Deposits', body, 'Review deposit requests and credit players.'));
});

/* MANUAL-PAYMENTS ease: player-submitted data (proof / payout
   destination) is stored under rail field KEYS (tx_hash, utr, ...).
   Admin detail pages must show the field's real LABEL, not the raw
   key, so the operator can act without decoding anything. */
function railFieldLabel(railKey, kind, key) {
  const rail = getRail(railKey);
  if (!rail) return key;
  const sets = kind === 'withdrawal' ? [rail.withdrawUserFields || [], rail.credentialFields || []] : [rail.userFields || [], rail.credentialFields || []];
  for (const set of sets) { const f = set.find(x => x.key === key); if (f) return f.label; }
  return key;
}
function labelledUserData(railKey, kind, userData) {
  return Object.entries(userData || {}).map(([k, v]) => [railFieldLabel(railKey, kind, k), v]);
}

router.get('/deposits/:id', async (req, res) => {
  const x = await req.db.get(`SELECT d.*, u.email, u.name AS user_name, m.name AS method_name, m.rail AS method_rail FROM deposits d JOIN users u ON u.id = d.user_id LEFT JOIN payment_methods m ON m.id = d.method_id WHERE d.id = ?`, [req.params.id]);
  if (!x) return notFound(req, res, 'Deposit not found.');
  let userData = {};
  try { userData = decodeUserData(x.user_data); } catch {}
  /* MANUAL-PAYMENTS ease: show the pay-to details the player was told
     to pay (the method's configured receiving details) on the SAME
     screen as the proof, so the admin verifies proof against the
     destination without opening the method's credentials page. */
  let receivingRows = [];
  try {
    const { getReceivingDetails } = require('../lib/rails');
    const mRow = await req.db.get('SELECT * FROM payment_methods WHERE id = ?', [x.method_id]);
    if (mRow) receivingRows = await getReceivingDetails(req.db, mRow);
  } catch {}
  const events = await req.db.query('SELECT * FROM webhook_events WHERE deposit_id = ? ORDER BY created_at DESC LIMIT 20', [x.id]);
  const pendAppr = await req.db.get("SELECT id FROM pending_approvals WHERE entity = 'deposit' AND entity_id = ? AND status = 'open'", [x.id]);
  const actions = pendAppr
    ? `<span class="badge b-warn">Awaiting second approval — decide in Approvals</span>`
    : x.status === 'pending'
    ? `<form method="POST" action="${R(req, '/deposits/' + x.id + '/approve')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-p">Approve & credit</button></form>
       <form method="POST" action="${R(req, '/deposits/' + x.id + '/reject')}" class="adm-form" style="display:inline-flex;gap:8px;align-items:end;flex-wrap:wrap"><input type="hidden" name="_csrf" value="${req.csrfToken}"><div class="field"><label>Reason shown to the player (the player sees this)</label><input type="text" name="decision_reason" maxlength="500" placeholder="e.g. Receipt unreadable — please re-upload"></div><button class="btn btn-d">Reject</button></form>`
    : x.status === 'approved'
    ? `<form method="POST" action="${R(req, '/deposits/' + x.id + '/revoke')}" class="adm-form" style="display:inline-flex;gap:8px;align-items:end;flex-wrap:wrap"><input type="hidden" name="_csrf" value="${req.csrfToken}"><div class="field"><label>Reason shown to the player (the player sees this)</label><input type="text" name="decision_reason" maxlength="500"></div><button class="btn btn-d">Revoke</button></form>`
    : `<span class="muted">No actions available for ${esc(x.status)} deposits.</span>`;
  const body = ui.card('Deposit ' + x.public_id, `
    <div class="grid2"><div>
      ${ui.table(['Field', 'Value'], [
        ['Player', `${esc(x.user_name)} (${esc(x.email)})`], ['Method', esc(x.method_name || '—')],
        ['Amount', money(req, x.amount, x.currency)], ['Charge', money(req, x.charge, x.currency)],
        ['Net credited', money(req, x.net, x.currency)], ['Status', ui.statusBadge(x.status)],
        ['Provider txn ID', esc(x.provider_txn_id || '—')],
        ['Created', d(x.created_at)], ['Decided', x.decided_at ? d(x.decided_at) : '—'],
      ])}
    </div><div>
      <h4>Player was told to pay to (configured receiving details)</h4>
      ${receivingRows.length ? ui.table(['Detail', 'Value'], receivingRows.map(r => [esc(r.label), esc(r.value)])) : '<p class="muted">No receiving details are configured on this method.</p>'}
      <h4 class="mt">Player-submitted proof</h4>
      ${ui.table(['Field', 'Value'], labelledUserData(x.method_rail, 'deposit', userData).map(([k, v]) => [esc(k), esc(v)]))}
      <h4 class="mt">Admin note (internal — never shown to the player)</h4>
      ${ui.formHtml(R(req, '/deposits/' + x.id + '/note'), [{ key: 'admin_note', label: 'Note', type: 'textarea', value: x.admin_note }], { csrf: req.csrfToken, submit: 'Save note', grid: false })}
    </div></div>
    <h4 class="mt">Webhook events for this deposit</h4>
    ${events.length ? ui.table(['When', 'Provider', 'Event', 'Action'], events.map(e => [d(e.created_at), esc(e.provider), `<span class="code">${esc(e.event_id)}</span>`, esc(e.action)])) : '<p class="muted">No webhook events recorded.</p>'}
    <div class="btn-row mt">${actions}</div>`);
  res.send(shell(req, '/deposits', 'Deposit ' + x.public_id, body));
});

/* v14 maker-checker: money actions at or above the threshold do NOT execute
   — they queue in pending_approvals for a DIFFERENT admin. Returns false
   below the threshold, else { queued: true, ... } (truthy, so existing
   callers' `if (await maybeMakerChecker(...))` keeps working).
   R-052: the queue check is keyed by (action + target + amount + currency),
   not target alone. The old target-only check SWALLOWED a different decision:
   with an approve queued, a reject click silently did nothing. Now an exact
   duplicate returns { duplicate: true } (no second row), while a DIFFERENT
   open decision for the same target queues separately AND reports the
   conflicting approval id, so the second approver sees both in Approvals
   (guarded status transitions prevent double execution either way).
   R-013: `detail` carries what the approval executor needs (adjustment
   remark, payout id, funding note) — stored in pending_approvals.detail
   (v11 column; '{}' for actions needing nothing). */
async function maybeMakerChecker(req, action, entity, entityId, amount, currency, detail = {}) {
  const threshold = parseInt(getS(req.settings, 'maker_checker_threshold', '0'), 10) || 0;
  if (!(threshold > 0 && amount >= threshold)) return false;
  const exact = await req.db.get("SELECT id FROM pending_approvals WHERE action = ? AND entity = ? AND entity_id = ? AND amount = ? AND currency = ? AND status = 'open'", [action, entity, entityId, amount, currency]);
  if (exact) return { queued: true, duplicate: true, approvalId: exact.id };
  const conflict = await req.db.get("SELECT id FROM pending_approvals WHERE entity = ? AND entity_id = ? AND status = 'open' ORDER BY created_at LIMIT 1", [entity, entityId]);
  await req.db.run('INSERT INTO pending_approvals (action, entity, entity_id, amount, currency, requested_by, status, created_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [action, entity, entityId, amount, currency, req.user.id, 'open', now(), JSON.stringify(detail || {})]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'approval.requested', entity, entityId, detail: { action, amount, currency }, ip: req.ip });
  return { queued: true, conflictId: conflict ? conflict.id : null };
}
/* D3-C6 (v20): decision -> past tense, spelled per word. The old
   decision + 'd' construction produced "rejectd" in delivered mail
   and admin flashes ('approve'+'d' and 'revoke'+'d' happened to spell
   correctly; 'reject'+'d' does not). */
/* U-24 (v20): fraud flags render for a human reviewer — the flag type
   gets a plain label and the stored JSON detail becomes readable
   key/value text (IP, the other account, the device) instead of a raw
   JSON blob. Unknown keys fall back to spaced words, never raw JSON. */
const FLAG_LABELS = { shared_device: 'Shared device / IP' };
/* U-24 (v20): ledger types and bonus enums render as human labels in
   admin tables/selects — never the raw snake_case value. The fallback
   is the CSV humaniser (spaced + capitalised), never the raw value. */
const TX_LABELS = { deposit: 'Deposit', deposit_revoke: 'Deposit reversed', bonus: 'Bonus', bonus_revoke: 'Bonus reversed', withdrawal: 'Withdrawal', withdrawal_hold: 'Withdrawal hold', withdrawal_release: 'Withdrawal released', withdrawal_revoke: 'Withdrawal reversed', ticket_purchase: 'Lottery ticket', win: 'Lottery win', draw_refund: 'Draw refund', scratch_purchase: 'Scratch ticket', scratch_prize: 'Scratch prize', referral_commission: 'Referral commission', agent_commission: 'Agent commission', agent_funding: 'Agent funding', adjustment: 'Adjustment', transfer_in: 'Transfer in', transfer_out: 'Transfer out', commission: 'Commission', exchange_in: 'Exchange in', exchange_out: 'Exchange out' };
const BONUS_AUDIENCE_LABELS = { all: 'All players', new: 'New players', first_n: 'First N', random_n: 'Random N' };
const BONUS_TRIGGER_LABELS = { manual: 'Manual', signup: 'Sign-up', first_deposit: 'First deposit', scheduled: 'Scheduled' };
function flagDetailText(raw) {
  try {
    const o = JSON.parse(raw || '{}');
    const parts = [];
    if (o.ip) parts.push('IP ' + o.ip);
    if (o.other_user_id) parts.push('shared with user #' + o.other_user_id);
    if (o.ua) parts.push('device: ' + o.ua);
    for (const [k, v] of Object.entries(o)) {
      if (['ip', 'ua', 'other_user_id'].includes(k)) continue;
      parts.push(k.replace(/_/g, ' ') + ': ' + v);
    }
    return parts.join(' · ') || '—';
  } catch { return String(raw || '—'); }
}
function decidedWord(decision) {
  return { approve: 'approved', reject: 'rejected', revoke: 'revoked', mark_paid: 'paid', paid: 'paid' }[decision] || decision;
}
async function decideDep(req, res, decision) {
  try {
    const row = await req.db.get('SELECT * FROM deposits WHERE id = ?', [req.params.id]);
    if (!row) throw new Error('Deposit not found');
    const playerReason = String(req.body.decision_reason || '').trim().slice(0, 500);
    const mc = await maybeMakerChecker(req, 'deposit.' + decision, 'deposit', row.id, row.net, row.currency, { decision_reason: playerReason });
    if (mc) {
      await req.setFlash('success', 'This action exceeds the maker-checker threshold and is queued for a second approver (see Approvals).' + (mc.conflictId ? ` Note: approval #${mc.conflictId} for this deposit is already open — decide each in Approvals.` : mc.duplicate ? ' (This decision was already queued.)' : ''));
      return res.redirect(R(req, '/deposits/' + req.params.id));
    }
    const dep = await decideDeposit(req.db, parseInt(req.params.id, 10), decision, req.user.id, req.settings, playerReason);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'deposit.' + decision, entity: 'deposit', entityId: dep.public_id, detail: { amount: dep.net, old_status: dep.status, new_status: decision }, ip: req.ip });
    const u = await req.db.get('SELECT email, name FROM users WHERE id = ?', [dep.user_id]);
    if (decision === 'approve') {
      notify.send(req.db, req.settings, 'email', 'deposit_approved', u.email, { name: u.name, amount: money(req, dep.net, dep.currency) }).catch(() => {});
      // Referral release trigger (v14): the referee's deposit is now approved.
      try { await releaseReferralCredits(req.db, dep.user_id, req.settings); } catch (e) { console.error('referral release failed:', e.message); }
    } else if (decision === 'reject') {
      // R-053: a direct rejection used to notify nobody — the player only
      // saw a stuck deposit. Rejections now notify like approvals do.
      notify.send(req.db, req.settings, 'email', 'deposit_rejected', u.email, { name: u.name, amount: money(req, dep.net, dep.currency) }).catch(() => {});
    }
    await req.setFlash('success', 'Deposit ' + decidedWord(decision) + '.');
  } catch (e) { await req.setFlash('error', e.message); }
  res.redirect(R(req, '/deposits/' + req.params.id));
}
router.post('/deposits/:id/approve', (req, res) => decideDep(req, res, 'approve'));
router.post('/deposits/:id/reject', (req, res) => decideDep(req, res, 'reject'));
router.post('/deposits/:id/revoke', (req, res) => decideDep(req, res, 'revoke'));
router.post('/deposits/:id/note', async (req, res) => {
  const row = await req.db.get('SELECT id FROM deposits WHERE id = ?', [req.params.id]);
  if (!row) return notFound(req, res, 'Deposit not found.');
  await req.db.run('UPDATE deposits SET admin_note = ? WHERE id = ?', [String(req.body.admin_note || '').slice(0, 2000), req.params.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'deposit.note', entity: 'deposit', entityId: req.params.id, detail: { note: String(req.body.admin_note || '').slice(0, 200) }, ip: req.ip });
  await req.setFlash('success', 'Note saved.');
  res.redirect(R(req, '/deposits/' + req.params.id));
});

/* ============================================================ WITHDRAWALS */
router.get('/withdrawals', async (req, res) => {
  const page = pageOf(req), status = req.query.status || '';
  const counts = { all: (await req.db.get('SELECT COUNT(*) AS c FROM withdrawals')).c };
  for (const s of ['pending', 'approved', 'rejected', 'revoked', 'paid']) counts[s] = (await req.db.get('SELECT COUNT(*) AS c FROM withdrawals WHERE status = ?', [s])).c;
  const wdRows = await req.db.query('SELECT currency, status, COALESCE(SUM(net),0) AS s FROM withdrawals GROUP BY currency, status');
  const wdByCur = {};
  for (const r of wdRows) (wdByCur[r.currency] = wdByCur[r.currency] || {})[r.status] = r.s;
  const wdCurs = Object.keys(wdByCur).sort();
  const wdStrip = wdCurs.length
    ? `<div class="sumstrip">${wdCurs.map(c => `<span><strong>${esc(c)}</strong> Approved: <strong>${money(req, wdByCur[c].approved || 0, c)}</strong> · Pending: <strong>${money(req, wdByCur[c].pending || 0, c)}</strong> · Rejected: <strong>${money(req, wdByCur[c].rejected || 0, c)}</strong> · Revoked: <strong>${money(req, wdByCur[c].revoked || 0, c)}</strong> · Paid: <strong>${money(req, wdByCur[c].paid || 0, c)}</strong></span>`).join('')}</div>`
    : '<div class="sumstrip"><span>No withdrawals yet.</span></div>';
  const fQ = String(req.query.q || '').trim();
  const fMethod = parseInt(req.query.method || '', 10) || 0;
  const fFrom = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : '';
  const fTo = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : '';
  const wClauses = [], wParams = [];
  if (status) { wClauses.push('w.status = ?'); wParams.push(status); }
  if (fQ) { wClauses.push('(u.email LIKE ? OR w.public_id LIKE ?)'); wParams.push('%' + fQ + '%', '%' + fQ + '%'); }
  if (fMethod) { wClauses.push('w.method_id = ?'); wParams.push(fMethod); }
  if (fFrom) { wClauses.push('w.created_at >= ?'); wParams.push(Date.parse(fFrom + 'T00:00:00Z')); }
  if (fTo) { wClauses.push('w.created_at < ?'); wParams.push(Date.parse(fTo + 'T00:00:00Z') + 86400000); }
  const where = wClauses.length ? 'WHERE ' + wClauses.join(' AND ') : '', params = wParams;
  const total = (await req.db.get(`SELECT COUNT(*) AS c FROM withdrawals w JOIN users u ON u.id = w.user_id ${where}`, params)).c;
  const rows = await req.db.query(
    `SELECT w.*, u.email, m.name AS method_name FROM withdrawals w JOIN users u ON u.id = w.user_id LEFT JOIN payment_methods m ON m.id = w.method_id
     ${where} ORDER BY w.created_at DESC LIMIT ? OFFSET ?`, [...params, PER, (page - 1) * PER]);
  const allMethodsW = await req.db.query('SELECT id, name FROM payment_methods ORDER BY name');
  const qsPartsW = [];
  if (status) qsPartsW.push('status=' + encodeURIComponent(status));
  if (fQ) qsPartsW.push('q=' + encodeURIComponent(fQ));
  if (fMethod) qsPartsW.push('method=' + fMethod);
  if (fFrom) qsPartsW.push('from=' + fFrom);
  if (fTo) qsPartsW.push('to=' + fTo);
  const wFilterForm = `<form method="GET" action="${R(req, '/withdrawals')}" class="filter-form">
    ${status ? `<input type="hidden" name="status" value="${esc(status)}">` : ''}
    <input type="search" name="q" value="${esc(fQ)}" placeholder="Player email or withdrawal ID">
    <select name="method"><option value="">All methods</option>${allMethodsW.map(m => `<option value="${m.id}"${fMethod === m.id ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>
    <input type="date" name="from" value="${esc(fFrom)}"><input type="date" name="to" value="${esc(fTo)}">
    <button class="btn btn-sm" type="submit">Filter</button>
    ${(fQ || fMethod || fFrom || fTo) ? `<a class="btn btn-sm" href="${R(req, '/withdrawals')}${status ? '?status=' + esc(status) : ''}">Clear</a>` : ''}
  </form>`;
  /* U-26 TWO DOORS (§5.2): the auto-withdrawal limit also lives here,
     on the page where withdrawals are worked. Same /settings/risk
     route, same auto_withdrawal_limit key; every other risk field is
     carried hidden at its current value because that handler rewrites
     the whole risk set. Editable only for super (the role that can
     save it in Settings); other roles see the current value. */
  const autoWdNow = getS(req.settings, 'auto_withdrawal_limit', '0');
  const riskHidden = (k, v) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`;
  const autoWdCard = ui.card('Auto-withdrawal limit',
    isSuperReq(req)
      ? `<p class="muted">A withdrawal at or under this amount is auto-approved once every gate passes (wagering, OTP, KYC, payout lock). Auto-approval never pays out by itself — payout still needs the mark-paid step. This is the same setting as Settings → Withdrawal &amp; risk controls.</p>
         <form method="POST" action="${R(req, '/settings/risk')}" class="adm-form"><input type="hidden" name="_csrf" value="${req.csrfToken}">
         ${getS(req.settings, 'withdrawal_turnover_required', '1') === '1' ? riskHidden('withdrawal_turnover_required', '1') : ''}
         ${riskHidden('withdrawal_daily_cap', (parseFloat(getS(req.settings, 'withdrawal_daily_cap', '0')) / 100).toFixed(2))}
         ${riskHidden('withdrawal_monthly_cap', (parseFloat(getS(req.settings, 'withdrawal_monthly_cap', '0')) / 100).toFixed(2))}
         ${riskHidden('payout_lock_hours', getS(req.settings, 'payout_lock_hours', '48'))}
         ${riskHidden('maker_checker_threshold', (parseFloat(getS(req.settings, 'maker_checker_threshold', '0')) / 100).toFixed(2))}
         ${riskHidden('referral_cap_per_referee', (parseFloat(getS(req.settings, 'referral_cap_per_referee', '0')) / 100).toFixed(2))}
         <div class="field"><label for="wd_auto_limit">Auto-withdrawal limit (e.g. 50.00; 0 = OFF — everything manual)</label><input id="wd_auto_limit" type="text" name="auto_withdrawal_limit" value="${esc(autoWdNow)}"></div>
         <div class="mt"><button class="btn btn-p" type="submit">Save auto-withdrawal limit</button></div></form>`
      : `<p class="muted">Auto-withdrawal limit is currently <strong>${esc(autoWdNow)}</strong> (0 = OFF — everything manual). Only the super admin can change it, in Settings → Withdrawal &amp; risk controls.</p>`);
  /* SETTINGS-FIND-01 (two doors, same pattern as the auto-limit card
     above): the wagering gate ALSO lives here, on the page where
     withdrawals are worked — the owner could not find this checkbox
     inside the mega Settings page on his phone, and a control the
     operator cannot find is a defect. Same /settings/risk route, same
     withdrawal_turnover_required key; every other risk field is
     carried hidden at its current value. Super-only editing. */
  const turnoverOn = getS(req.settings, 'withdrawal_turnover_required', '1') === '1';
  const gatesCard = ui.card('Withdrawal gates',
    isSuperReq(req)
      ? `<p class="muted">Wagering gate: while ON, a player must have wagered at least their approved deposits (1×) before any withdrawal is allowed. This is the same switch as Settings → Withdrawal &amp; risk controls.</p>
         <form method="POST" action="${R(req, '/settings/risk')}" class="adm-form"><input type="hidden" name="_csrf" value="${req.csrfToken}">
         ${riskHidden('auto_withdrawal_limit', autoWdNow)}
         ${riskHidden('withdrawal_daily_cap', (parseFloat(getS(req.settings, 'withdrawal_daily_cap', '0')) / 100).toFixed(2))}
         ${riskHidden('withdrawal_monthly_cap', (parseFloat(getS(req.settings, 'withdrawal_monthly_cap', '0')) / 100).toFixed(2))}
         ${riskHidden('payout_lock_hours', getS(req.settings, 'payout_lock_hours', '48'))}
         ${riskHidden('maker_checker_threshold', (parseFloat(getS(req.settings, 'maker_checker_threshold', '0')) / 100).toFixed(2))}
         ${riskHidden('referral_cap_per_referee', (parseFloat(getS(req.settings, 'referral_cap_per_referee', '0')) / 100).toFixed(2))}
         <div class="field"><label><input type="checkbox" name="withdrawal_turnover_required" ${turnoverOn ? 'checked' : ''}> Require 1× wagering before withdrawal</label></div>
         <div class="mt"><button class="btn btn-p" type="submit">Save withdrawal gates</button></div></form>`
      : `<p class="muted">Require 1× wagering before withdrawal is currently <strong>${turnoverOn ? 'ON' : 'OFF'}</strong>. Only the super admin can change it, in Settings → Withdrawal &amp; risk controls.</p>`);
  const body = wdStrip + autoWdCard + gatesCard + moneyTabs(req, R(req, '/withdrawals'), counts, status, [['paid', 'Paid']]) + wFilterForm + ui.table(['ID', 'Player', 'Method', 'Amount', 'Charge', 'Net payout', 'Status', 'When', ''],
    rows.map(x => [`<span class="code">${esc(x.public_id)}</span>`, esc(x.email), esc(x.method_name || '—'),
      money(req, x.amount, x.currency), money(req, x.charge, x.currency), money(req, x.net, x.currency),
      ui.statusBadge(x.status), d(x.created_at), `<a class="btn btn-sm" href="${R(req, '/withdrawals/' + x.id)}">Review</a>`])) +
    ui.paginate(R(req, '/withdrawals') + (qsPartsW.length ? '?' + qsPartsW.join('&') : ''), page, PER, total);
  res.send(shell(req, '/withdrawals', 'Withdrawals', body, 'Review payout requests and mark them paid.'));
});

router.get('/withdrawals/:id', async (req, res) => {
  const x = await req.db.get(`SELECT w.*, u.email, u.name AS user_name, m.name AS method_name, m.rail AS method_rail FROM withdrawals w JOIN users u ON u.id = w.user_id LEFT JOIN payment_methods m ON m.id = w.method_id WHERE w.id = ?`, [req.params.id]);
  if (!x) return notFound(req, res, 'Withdrawal not found.');
  let userData = {};
  try { userData = decodeUserData(x.user_data); } catch {}
  const pendAppr = await req.db.get("SELECT id FROM pending_approvals WHERE entity = 'withdrawal' AND entity_id = ? AND status = 'open'", [x.id]);
  const actions = pendAppr
    ? `<span class="badge b-warn">Awaiting second approval — decide in Approvals</span>`
    : x.status === 'pending'
    ? `<form method="POST" action="${R(req, '/withdrawals/' + x.id + '/approve')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-p">Approve</button></form>
       <form method="POST" action="${R(req, '/withdrawals/' + x.id + '/reject')}" class="adm-form" style="display:inline-flex;gap:8px;align-items:end;flex-wrap:wrap"><input type="hidden" name="_csrf" value="${req.csrfToken}"><div class="field"><label>Reason shown to the player (the player sees this)</label><input type="text" name="decision_reason" maxlength="500" placeholder="e.g. Payout details do not match your account name"></div><button class="btn btn-d">Reject & release</button></form>`
    : x.status === 'approved'
    ? `<form method="POST" action="${R(req, '/withdrawals/' + x.id + '/mark-paid')}" class="adm-form" style="display:inline-flex;gap:8px;align-items:end;"><input type="hidden" name="_csrf" value="${req.csrfToken}"><div class="field"><label>Provider payout ID (required)</label><input type="text" name="provider_payout_id" required maxlength="255" placeholder="e.g. PSP payout reference"></div><button class="btn btn-p">Mark as paid</button></form>
       <form method="POST" action="${R(req, '/withdrawals/' + x.id + '/revoke')}" class="adm-form" style="display:inline-flex;gap:8px;align-items:end;flex-wrap:wrap"><input type="hidden" name="_csrf" value="${req.csrfToken}"><div class="field"><label>Reason shown to the player (the player sees this)</label><input type="text" name="decision_reason" maxlength="500"></div><button class="btn btn-d">Revoke</button></form>`
    : `<span class="muted">No actions available.</span>`;
  const body = ui.card('Withdrawal ' + x.public_id, `
    <div class="grid2"><div>
      ${ui.table(['Field', 'Value'], [
        ['Player', `${esc(x.user_name)} (${esc(x.email)})`], ['Method', esc(x.method_name || '—')],
        ['Amount (held)', money(req, x.amount, x.currency)], ['Charge', money(req, x.charge, x.currency)],
        ['Net payout', money(req, x.net, x.currency)], ['Status', ui.statusBadge(x.status)],
        ['Provider payout ID', esc(x.provider_payout_id || '—')], ['Paid at', x.payout_at ? d(x.payout_at) : '—'],
        ['Created', d(x.created_at)], ['Decided', x.decided_at ? d(x.decided_at) : '—'],
      ])}
    </div><div>
      <h4>Player payout details — send the Net payout here</h4>
      ${ui.table(['Field', 'Value'], labelledUserData(x.method_rail, 'withdrawal', userData).map(([k, v]) => [esc(k), esc(v)]))}
      <h4 class="mt">Admin note (internal — never shown to the player)</h4>
      ${ui.formHtml(R(req, '/withdrawals/' + x.id + '/note'), [{ key: 'admin_note', label: 'Note', type: 'textarea', value: x.admin_note }], { csrf: req.csrfToken, submit: 'Save note', grid: false })}
    </div></div>
    <div class="btn-row mt">${actions}</div>`);
  res.send(shell(req, '/withdrawals', 'Withdrawal ' + x.public_id, body));
});

async function decideWd(req, res, decision) {
  try {
    const row = await req.db.get('SELECT * FROM withdrawals WHERE id = ?', [req.params.id]);
    if (!row) throw new Error('Withdrawal not found');
    const playerReason = String(req.body.decision_reason || '').trim().slice(0, 500);
    const mc = await maybeMakerChecker(req, 'withdrawal.' + decision, 'withdrawal', row.id, row.net, row.currency, { decision_reason: playerReason });
    if (mc) {
      await req.setFlash('success', 'This action exceeds the maker-checker threshold and is queued for a second approver (see Approvals).' + (mc.conflictId ? ` Note: approval #${mc.conflictId} for this withdrawal is already open — decide each in Approvals.` : mc.duplicate ? ' (This decision was already queued.)' : ''));
      return res.redirect(R(req, '/withdrawals/' + req.params.id));
    }
    const w = await decideWithdrawal(req.db, parseInt(req.params.id, 10), decision, req.user.id, '', playerReason);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'withdrawal.' + decision, entity: 'withdrawal', entityId: w.public_id, detail: { amount: w.net, old_status: w.status, new_status: decision }, ip: req.ip });
    if (decision !== 'revoke' || true) {
      const u = await req.db.get('SELECT email, name FROM users WHERE id = ?', [w.user_id]);
      notify.send(req.db, req.settings, 'email', 'withdrawal_decided', u.email, { name: u.name, amount: money(req, w.net, w.currency), status: decidedWord(decision) }).catch(() => {});
    }
    await req.setFlash('success', 'Withdrawal ' + decidedWord(decision) + '.');
  } catch (e) { await req.setFlash('error', e.message); }
  res.redirect(R(req, '/withdrawals/' + req.params.id));
}
router.post('/withdrawals/:id/approve', (req, res) => decideWd(req, res, 'approve'));
router.post('/withdrawals/:id/reject', (req, res) => decideWd(req, res, 'reject'));
router.post('/withdrawals/:id/revoke', (req, res) => decideWd(req, res, 'revoke'));
router.post('/withdrawals/:id/mark-paid', async (req, res) => {
  try {
    // R-013: marking paid moves money out — threshold queues it like the
    // other withdrawal decisions (only from 'approved'; other states fail
    // in markWithdrawalPaid as before, never queued).
    const row0 = await req.db.get('SELECT * FROM withdrawals WHERE id = ?', [req.params.id]);
    if (row0 && row0.status === 'approved') {
      const mc = await maybeMakerChecker(req, 'withdrawal.mark_paid', 'withdrawal', row0.id, row0.net, row0.currency, { provider_payout_id: String(req.body.provider_payout_id || '').trim() });
      if (mc) {
        await req.setFlash('success', 'This action exceeds the maker-checker threshold and is queued for a second approver (see Approvals).' + (mc.conflictId ? ` Note: approval #${mc.conflictId} for this withdrawal is already open.` : ''));
        return res.redirect(R(req, '/withdrawals/' + req.params.id));
      }
    }
    const w = await markWithdrawalPaid(req.db, parseInt(req.params.id, 10), req.body.provider_payout_id, req.user.id);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'withdrawal.mark_paid', entity: 'withdrawal', entityId: w.public_id, detail: { provider_payout_id: String(req.body.provider_payout_id || '').trim(), old_status: 'approved', new_status: 'paid' }, ip: req.ip });
    /* D3-C7 (v20): the direct mark-paid path sent NO notification —
       the maker-checker path sends withdrawal_decided with status
       'paid' for the same event. Same call, same template. */
    try {
      const u = await req.db.get('SELECT email, name FROM users WHERE id = ?', [w.user_id]);
      if (u && u.email) notify.send(req.db, req.settings, 'email', 'withdrawal_decided', u.email, { name: u.name, amount: money(req, w.net, w.currency), status: 'paid' }).catch(() => {});
    } catch {}
    await req.setFlash('success', 'Withdrawal marked as paid.');
  } catch (e) { await req.setFlash('error', e.message); }
  res.redirect(R(req, '/withdrawals/' + req.params.id));
});
router.post('/withdrawals/:id/note', async (req, res) => {
  const row = await req.db.get('SELECT id FROM withdrawals WHERE id = ?', [req.params.id]);
  if (!row) return notFound(req, res, 'Withdrawal not found.');
  await req.db.run('UPDATE withdrawals SET admin_note = ? WHERE id = ?', [String(req.body.admin_note || '').slice(0, 2000), req.params.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'withdrawal.note', entity: 'withdrawal', entityId: req.params.id, detail: { note: String(req.body.admin_note || '').slice(0, 200) }, ip: req.ip });
  await req.setFlash('success', 'Note saved.');
  res.redirect(R(req, '/withdrawals/' + req.params.id));
});

/* ============================================================ PAYMENT METHODS */
/* CURRENCY-SYSTEM-01: coverage warning — an enabled currency with no
   enabled deposit and/or withdrawal method is exactly the owner's INR
   bug (INR selected, only USD methods exist). Computed from the real
   methods table; shown on the Currencies card and the Methods page. */
async function currencyCoverageGaps(req) {
  const curs = getCurrencies(req.settings);
  const rows = await req.db.query("SELECT currency, kind FROM payment_methods WHERE enabled = 1");
  const gaps = [];
  for (const c of curs) {
    const hasDep = rows.some(r => r.currency === c.code && (r.kind === 'deposit' || r.kind === 'both'));
    const hasWd = rows.some(r => r.currency === c.code && (r.kind === 'withdrawal' || r.kind === 'both'));
    if (!hasDep || !hasWd) gaps.push({ code: c.code, hasDep, hasWd });
  }
  return gaps;
}
function coverageHtml(gaps) {
  if (!gaps.length) return '';
  const lines = gaps.map(g => `<li><strong>${esc(g.code)}</strong> is enabled but has ${!g.hasDep && !g.hasWd ? 'no deposit method and no withdrawal method' : !g.hasDep ? 'no deposit method' : 'no withdrawal method'} — ${esc(g.code)} players will only see other-currency methods.</li>`).join('');
  return `<div class="alert a-err">Currency coverage warning:<ul style="margin:6px 0 0">${lines}</ul></div>`;
}

router.get('/methods', async (req, res) => {
  const methods = await req.db.query('SELECT * FROM payment_methods ORDER BY sort');
  const coverageGaps = await currencyCoverageGaps(req);
  const body = coverageHtml(coverageGaps) + `<div class="btn-row" style="margin-bottom:16px"><a class="btn btn-p" href="${R(req, '/methods/new')}">+ New method</a></div>` +
    ui.table(['Logo', 'Name', 'Kind', 'Rail', 'Currency', 'Min / Max', 'Charge', 'Mode', 'Status', ''],
      methods.map(m => [
        m.logo_url ? `<img src="${esc(m.logo_url)}" alt="" style="height:28px">` : '<span class="muted">—</span>',
        esc(m.name), esc(m.kind), esc((getRail(m.rail) || {}).name || m.rail),
        esc(m.currency),
        `${money(req, m.min_amount, m.currency)} – ${m.max_amount ? money(req, m.max_amount, m.currency) : '∞'}`,
        `${money(req, m.fixed_charge, m.currency)} + ${m.percent_charge}%`,
        m.processing_mode === 'auto' ? ui.badge('Auto Pay', 'ok') : ui.badge('Manual Pay', 'muted'),
        m.enabled ? ui.badge('enabled', 'ok') : ui.badge('disabled', 'muted'),
        `<a class="btn btn-sm" href="${R(req, '/methods/' + m.id)}">Edit</a>
         <a class="btn btn-sm" href="${R(req, '/methods/' + m.id + '/credentials')}">Credentials</a>
         <form method="POST" action="${R(req, '/methods/' + m.id + '/toggle')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">${m.enabled ? 'Disable' : 'Enable'}</button></form>`,
      ]));
  res.send(shell(req, '/methods', 'Payment Methods', body, 'Payment rails — receiving details, limits and Manual / Auto mode.'));
});

const METHOD_FIELDS = (m = {}) => [
  { key: 'name', label: 'Method name', type: 'text', value: m.name, required: true },
  { key: 'kind', label: 'Kind', type: 'select', options: ['deposit', 'withdrawal', 'both'], value: m.kind || 'both' },
  { key: 'rail', label: 'Rail', type: 'select', options: RAILS.map(r => ({ v: r.key, l: r.name })), value: m.rail || 'bank_transfer', help: 'EBT is blocked by policy and cannot be saved.' },
  { key: 'logo_url', label: 'Logo URL', type: 'text', value: m.logo_url },
  { key: 'currency', label: 'Currency', type: 'text', value: m.currency || 'USD', required: true },
  { key: 'rate', label: 'Rate to base currency', type: 'text', value: m.rate || '1' },
  { key: 'min_amount', label: 'Min amount (e.g. 5.00)', type: 'text', value: m.min_amount ? fromMinor(m.min_amount) : '' },
  { key: 'max_amount', label: 'Max amount (blank = no max)', type: 'text', value: m.max_amount ? fromMinor(m.max_amount) : '' },
  { key: 'fixed_charge', label: 'Fixed charge (e.g. 0.50)', type: 'text', value: m.fixed_charge ? fromMinor(m.fixed_charge) : '' },
  { key: 'percent_charge', label: 'Percent charge %', type: 'text', value: m.percent_charge || '' },
  { key: 'instruction', label: 'Deposit how-to shown to player', type: 'textarea', value: m.instruction, help: 'Manual deposit steps. Each new line becomes a numbered step on the deposit page.' },
  { key: 'withdraw_instruction', label: 'Withdrawal how-to shown to player', type: 'textarea', value: m.withdraw_instruction || '', help: 'Withdrawal steps shown on the withdraw page. Blank = the deposit how-to is used.' },
  { key: 'custom_fields', label: 'Custom user-data fields (JSON)', type: 'textarea', value: m.custom_fields || '[]', help: 'e.g. [{"key":"account","label":"Your account number","type":"text","required":true}]' },
  { key: 'enabled', label: 'Enabled', type: 'checkbox', value: m.enabled },
];
/* R-112: validate every method field the round-1 fix left unchecked
   (kind, currency, min/max ordering, non-negative charges). Returns a
   cleaned object or throws; both create and edit use it so the rules
   cannot drift apart. toMinor(null) on a blank field means "not set". */
function validateMethodFields(body, settings) {
  const kind = String(body.kind || 'both');
  if (!['deposit', 'withdrawal', 'both'].includes(kind)) throw new Error('Invalid method kind.');
  const name = String(body.name || '').trim();
  if (!name) throw new Error('Method name is required.');
  const rail = String(body.rail || '');
  if (!getRail(rail)) throw new Error('Unknown rail.');
  const currency = String(body.currency || '').toUpperCase().trim();
  if (!getCurrencies(settings).some(c => c.code === currency)) throw new Error('Currency must be one of the configured currencies (Settings → Currencies).');
  const numOrZero = (raw, label) => {
    const t = String(raw === undefined || raw === null ? '' : raw).trim();
    if (t === '') return 0;
    const v = toMinor(t);
    if (v === null || v < 0) throw new Error(label + ' must be a valid non-negative amount.');
    return v;
  };
  const min = numOrZero(body.min_amount, 'Min amount');
  const maxRaw = String(body.max_amount === undefined || body.max_amount === null ? '' : body.max_amount).trim();
  const max = maxRaw === '' ? 0 : numOrZero(body.max_amount, 'Max amount');
  if (max > 0 && max < min) throw new Error('Max amount must be >= min amount (blank = no max).');
  const fixed = numOrZero(body.fixed_charge, 'Fixed charge');
  return { kind, name, rail, currency, min, max, fixed };
}
function parseCustomFields(raw) {
  try {
    const arr = JSON.parse(raw || '[]');
    if (!Array.isArray(arr)) throw new Error('not an array');
    return arr.filter(f => f.key && f.label).map(f => ({ key: String(f.key).slice(0, 40), label: String(f.label).slice(0, 80), type: ['text', 'number', 'textarea'].includes(f.type) ? f.type : 'text', required: !!f.required }));
  } catch { throw new Error('Custom fields must be valid JSON array.'); }
}
router.get('/methods/new', async (req, res) => {
  res.send(shell(req, '/methods', 'New Payment Method', ui.card('Method', ui.formHtml(R(req, '/methods/new'), METHOD_FIELDS(), { csrf: req.csrfToken, submit: 'Create method' }))));
});
router.post('/methods/new', async (req, res) => {
  if (isBlockedRail(req.body.rail, getS(req.settings, 'blocked_rails', ''))) { await req.setFlash('error', 'This rail is blocked by policy.'); return res.redirect(R(req, '/methods/new')); }
  try {
    // A negative percent charge makes a deposit credit MORE than was paid
    // (and a negative rate corrupts conversion); the old code passed
    // parseFloat negatives straight through. Reject them here (blank still
    // means the old defaults: rate 1, percent 0).
    const rateRawNew = String(req.body.rate ?? '').trim();
    const rateNew = rateRawNew === '' ? 1 : parseFloat(rateRawNew);
    const pctRawNew = String(req.body.percent_charge ?? '').trim();
    const pctNew = pctRawNew === '' ? 0 : parseFloat(pctRawNew);
    if (!(rateNew > 0)) throw new Error('Rate must be greater than 0.');
    if (pctNew < 0) throw new Error('Percent charge cannot be negative.');
    if (pctNew >= 100) throw new Error('Percent charge must be less than 100% — at 100% or more, a deposit would credit the player nothing and could never be approved cleanly.');
    const f = validateMethodFields(req.body, req.settings);
    const cf = parseCustomFields(req.body.custom_fields);
    const slug = 'm-' + randHex(4) + '-' + Date.now().toString(36);
    await req.db.run(`INSERT INTO payment_methods (kind, name, slug, rail, logo_url, currency, rate, min_amount, max_amount, fixed_charge, percent_charge, instruction, withdraw_instruction, custom_fields, enabled, sort)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [f.kind, f.name, slug, f.rail, req.body.logo_url || '', f.currency,
       rateNew, f.min, f.max,
       f.fixed, pctNew,
       req.body.instruction || '', req.body.withdraw_instruction || '', JSON.stringify(cf), req.body.enabled ? 1 : 0, 999]);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'method.create', entity: 'method', entityId: slug, detail: { new: { kind: f.kind, name: f.name, rail: f.rail, currency: f.currency, rate: rateNew, min: f.min, max: f.max, fixed: f.fixed, percent: pctNew } }, ip: req.ip });
    await req.setFlash('success', 'Method created.');
  } catch (e) { await req.setFlash('error', e.message); return res.redirect(R(req, '/methods/new')); }
  res.redirect(R(req, '/methods'));
});
router.get('/methods/:id', async (req, res) => {
  const m = await req.db.get('SELECT * FROM payment_methods WHERE id = ?', [req.params.id]);
  if (!m) return notFound(req, res, 'Method not found.');
  res.send(shell(req, '/methods', 'Edit — ' + m.name,
    ui.card('Method', ui.formHtml(R(req, '/methods/' + m.id), METHOD_FIELDS(m), { csrf: req.csrfToken, submit: 'Save' })) +
    `<form method="POST" action="${R(req, '/methods/' + m.id + '/delete')}" class="mt"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-d">Delete method</button></form>`));
});
router.post('/methods/:id', async (req, res) => {
  if (isBlockedRail(req.body.rail, getS(req.settings, 'blocked_rails', ''))) { await req.setFlash('error', 'This rail is blocked by policy.'); return res.redirect(R(req, '/methods/' + req.params.id)); }
  try {
    const old = await req.db.get('SELECT * FROM payment_methods WHERE id = ?', [req.params.id]);
    if (!old) return notFound(req, res, 'Method not found.');
    const rateRawEdit = String(req.body.rate ?? '').trim();
    const rateEdit = rateRawEdit === '' ? 1 : parseFloat(rateRawEdit);
    const pctRawEdit = String(req.body.percent_charge ?? '').trim();
    const pctEdit = pctRawEdit === '' ? 0 : parseFloat(pctRawEdit);
    if (!(rateEdit > 0)) throw new Error('Rate must be greater than 0.');
    if (pctEdit < 0) throw new Error('Percent charge cannot be negative.');
    if (pctEdit >= 100) throw new Error('Percent charge must be less than 100% — at 100% or more, a deposit would credit the player nothing and could never be approved cleanly.');
    const f = validateMethodFields(req.body, req.settings);
    const cf = parseCustomFields(req.body.custom_fields);
    await req.db.run(`UPDATE payment_methods SET kind=?, name=?, rail=?, logo_url=?, currency=?, rate=?, min_amount=?, max_amount=?, fixed_charge=?, percent_charge=?, instruction=?, withdraw_instruction=?, custom_fields=?, enabled=? WHERE id=?`,
      [f.kind, f.name, f.rail, req.body.logo_url || '', f.currency,
       rateEdit, f.min, f.max,
       f.fixed, pctEdit,
       req.body.instruction || '', req.body.withdraw_instruction || '', JSON.stringify(cf), req.body.enabled ? 1 : 0, req.params.id]);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'method.update', entity: 'method', entityId: req.params.id, detail: { old: { kind: old.kind, name: old.name, rail: old.rail, currency: old.currency, rate: old.rate, min: old.min_amount, max: old.max_amount, fixed: old.fixed_charge, percent: old.percent_charge }, new: { kind: f.kind, name: f.name, rail: f.rail, currency: f.currency, rate: rateEdit, min: f.min, max: f.max, fixed: f.fixed, percent: pctEdit } }, ip: req.ip });
    await req.setFlash('success', 'Method saved.');
  } catch (e) { await req.setFlash('error', e.message); }
  res.redirect(R(req, '/methods/' + req.params.id));
});
router.post('/methods/:id/toggle', async (req, res) => {
  const m = await req.db.get('SELECT enabled FROM payment_methods WHERE id = ?', [req.params.id]);
  if (!m) return notFound(req, res, 'Method not found.');
  // R-103: the old toggle flashed nothing, but a missing method silently
  // "toggled" — and R-104: the flip was never audited.
  const r = await req.db.run('UPDATE payment_methods SET enabled = 1 - enabled WHERE id = ?', [req.params.id]);
  if (r.changes !== 1) { await req.setFlash('error', 'Method not found.'); return res.redirect(R(req, '/methods')); }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'method.toggle', entity: 'method', entityId: req.params.id, detail: { old_enabled: m.enabled, new_enabled: m.enabled ? 0 : 1 }, ip: req.ip });
  res.redirect(R(req, '/methods'));
});
router.post('/methods/:id/delete', async (req, res) => {
  const m = await req.db.get('SELECT * FROM payment_methods WHERE id = ?', [req.params.id]);
  if (!m) return notFound(req, res, 'Method not found.');
  const r = await req.db.run('DELETE FROM payment_methods WHERE id = ?', [req.params.id]);
  if (r.changes !== 1) { await req.setFlash('error', 'Method not found.'); return res.redirect(R(req, '/methods')); }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'method.delete', entity: 'method', entityId: req.params.id, detail: { name: m.name, rail: m.rail, currency: m.currency }, ip: req.ip });
  await req.setFlash('success', 'Method deleted.');
  res.redirect(R(req, '/methods'));
});
/* METHOD-MODE-01 + AUTO-INTEGRATION: per-method Manual Pay / Auto Pay.
   Auto is honest or it does not exist (R-044): it can only be SAVED
   when this rail has a real provider-confirmation path AND every field
   Auto needs is already filled below (lib/rails.autoCapability decides
   per rail: PayPal -> Client ID + Secret + Webhook ID, verified by
   lib/paypal.js; Skrill -> Merchant ID + Secret Word, verified by
   lib/skrill.js; other webhook rails -> the signing secret). Rails
   with no provider-confirmation path at all (plain UPI ID, bank
   transfer, vouchers, cash agents, plain QR) stay Manual, and the
   admin is told exactly that, in plain words. */
function autoPayBlockReason(rail) {
  if (!rail) return 'Is method ki rail pehchani nahi gayi — Auto band hai, ye Manual hi chalega.';
  return 'Is method me Auto asal me nahi ho sakta — provider ki taraf se koi payment confirmation (webhook/API) nahi aati, is liye ye Manual hi chalega.';
}
async function autoPayMissingFields(req, m, rail) {
  const { loadCredentials } = require('../lib/credentials');
  const { autoCapability } = require('../lib/rails');
  const saved = await loadCredentials(req.db, m.id).catch(() => ({}));
  if (!rail) return ['(unknown rail)'];
  return autoCapability(rail, saved).missing;
}
function methodModeCard(req, m, rail) {
  const mode = m.processing_mode === 'auto' ? 'auto' : 'manual';
  const canAuto = !!(rail && rail.webhook);
  const autoLimit = getS(req.settings, 'auto_withdrawal_limit', '0');
  const autoLine = canAuto
    ? (rail && rail.key === 'paypal'
      ? 'Auto Pay: PayPal khud payment ki tasdeeq karega (signed webhook + transaction ID check) — tasdeeq par hi credit hoga, baghair tasdeeq kuch nahi. Withdrawal sirf auto-withdrawal limit tak khud approve hota hai — paisa bhejna aur mark-paid admin hi karega.'
      : 'Auto Pay: deposit provider ki signed confirmation (webhook) aane par khud credit hoga. Withdrawal sirf auto-withdrawal limit tak khud approve hota hai — paisa bhejna aur mark-paid admin hi karega.')
    : autoPayBlockReason(rail);
  const limitLine = (!autoLimit || autoLimit === '0')
    ? 'Auto-withdrawal limit abhi OFF (0) hai — Auto mode me bhi koi withdrawal khud approve nahi hoga.'
    : `Auto-withdrawal limit abhi ${esc(autoLimit)} hai — is se zyada ke withdrawals hamesha manual queue me jayenge.`;
  return ui.card('Processing mode — ' + esc(m.name),
    `<form method="POST" action="${R(req, '/methods/' + m.id + '/mode')}" class="adm-form"><input type="hidden" name="_csrf" value="${req.csrfToken}">
      <div class="field"><label for="pmode">Please select: Manual Pay / Auto Pay</label>
      <select id="pmode" name="processing_mode">
        <option value="manual"${mode === 'manual' ? ' selected' : ''}>Manual Pay</option>
        <option value="auto"${mode === 'auto' ? ' selected' : ''}${canAuto ? '' : ' disabled'}>Auto Pay</option>
      </select></div>
      <p class="muted">Manual Pay: player proof bhejega, phir admin queue me approve / reject hoga — paisa tabhi credit hoga jab admin confirm kare.</p>
      <p class="muted">${autoLine}</p>
      <p class="muted">${canAuto ? limitLine : ''}</p>
      <div class="mt"><button class="btn btn-p" type="submit">Save mode</button></div></form>`);
}
router.post('/methods/:id/mode', async (req, res) => {
  const { normalizeRole } = require('../lib/rbac');
  if (normalizeRole(req.user) !== 'super') return res.status(403).render('error', { status: 403, message: 'Only the super admin can change a method mode.' });
  const m = await req.db.get('SELECT * FROM payment_methods WHERE id = ?', [req.params.id]);
  if (!m) return notFound(req, res, 'Method not found.');
  const rail = getRail(m.rail);
  const want = String(req.body.processing_mode || 'manual');
  const back = R(req, '/methods/' + m.id + '/credentials');
  if (want !== 'manual' && want !== 'auto') { await req.setFlash('error', 'Mode not saved: choose Manual Pay or Auto Pay.'); return res.redirect(back); }
  if (want === 'auto') {
    if (!rail || !rail.webhook) {
      await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'method.mode_blocked', entity: 'method', entityId: m.id, detail: { want: 'auto', reason: 'rail has no provider confirmation path' }, ip: req.ip });
      await req.setFlash('error', 'Auto Pay NOT set: ' + autoPayBlockReason(rail));
      return res.redirect(back);
    }
    const missing = await autoPayMissingFields(req, m, rail);
    if (missing.length) {
      await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'method.mode_blocked', entity: 'method', entityId: m.id, detail: { want: 'auto', missing }, ip: req.ip });
      await req.setFlash('error', 'Auto Pay NOT set: Auto ke liye pehle ye details bharo: ' + missing.join(', ') + '. Ye details isi page par neeche bhar kar pehle Save credentials karo, phir Auto Pay select karo.');
      return res.redirect(back);
    }
  }
  await req.db.run('UPDATE payment_methods SET processing_mode = ? WHERE id = ?', [want, m.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'method.mode', entity: 'method', entityId: m.id, detail: { mode: want, rail: m.rail }, ip: req.ip });
  await req.setFlash('success', want === 'auto' ? 'Auto Pay is ON for this method.' : 'Manual Pay is set for this method.');
  return res.redirect(back);
});

router.get('/methods/:id/credentials', async (req, res) => {
  // DS-011: decrypted gateway credentials are super-admin only. RBAC lets
  // every staff role read GET pages, so this route gates itself.
  const { normalizeRole } = require('../lib/rbac');
  if (normalizeRole(req.user) !== 'super') return res.status(403).render('error', { status: 403, message: 'Only the super admin can view gateway credentials.' });
  const m = await req.db.get('SELECT * FROM payment_methods WHERE id = ?', [req.params.id]);
  if (!m) return notFound(req, res, 'Method not found.');
  const rail = getRail(m.rail);
  // v14: decrypt stored credentials for display (legacy plaintext rows read
  // as-is; envelope rows need CREDENTIAL_ENCRYPTION_KEY or show a warning).
  const saved = {};
  for (const r of await req.db.query('SELECT field_key, field_value, field_enc FROM gateway_credentials WHERE method_id = ?', [m.id])) {
    try { saved[r.field_key] = decryptField(r.field_value, r.field_enc); }
    catch (e) { saved[r.field_key] = '[unreadable — encryption key not configured]'; }
  }
  /* U-21 §5.2: pass the rails.js field definition THROUGH (help text,
     options, secret marker, required) instead of rebuilding a stripped
     copy — the old map dropped every field's help text. Password fields
     render EMPTY: a stored secret is never echoed back into the page;
     the operator sees the field's own help plus the keep-saved note. */
  /* CREDENTIALS-REAL-01: every field states WHICH mode needs it, so the
     owner never fills API fields for a manual-only setup unknowingly. */
  const { RECEIVING_FIELDS: RF, PUBLIC_CONFIG_FIELDS: PCF } = require('../lib/rails');
  const modeTag = f => {
    if (rail && (RF[rail.key] || []).includes(f.key)) return 'Needed for: Manual — this is where the player pays; it is shown on the deposit page.';
    if (rail && (PCF[rail.key] || []).includes(f.key)) return 'Shown to players as payment context. Needed for Auto/API checkout.';
    if (f.type === 'password' || /secret|api_key|api_token|client_id/.test(f.key)) return 'Needed for: Auto/API mode only — not needed for Manual.';
    if (f.key === 'mode' || f.key === 'environment') return 'Provider mode setting — used by Auto/API mode.';
    return 'Provider configuration.';
  };
  const fields = (rail ? rail.credentialFields : []).map(f => ({ ...f,
    type: f.type === 'password' ? 'password' : f.type,
    value: f.type === 'password' ? '' : (saved[f.key] || ''),
    help: ((f.help ? f.help + ' ' : '') + '[' + modeTag(f) + ']') + (f.type === 'password' ? ' Leave blank to keep the saved value.' : ''),
  }));
  const body = methodModeCard(req, m, rail) + ui.card(`Gateway credentials — ${m.name} (${rail ? rail.name : m.rail})`,
    `<p class="muted">Credentials are stored server-side. Receiving details (wallet address, UPI ID, bank account, QR code) ARE shown to players on the deposit page so they can pay; secret keys are never shown to players. ${rail && rail.webhook ? 'This rail supports provider webhooks with signature verification.' : 'This rail runs in manual mode: players submit proof, staff approves.'} ${keyConfigured() ? 'Credentials are encrypted at rest (AES-256-GCM).' : 'No encryption key is configured — credentials are stored in plaintext. Set CREDENTIAL_ENCRYPTION_KEY and re-save to encrypt.'}</p>` +
    (fields.length ? ui.formHtml(R(req, '/methods/' + m.id + '/credentials'), fields,
      { csrf: req.csrfToken, submit: 'Save credentials' })
    : '<p class="muted">This rail needs no credentials.</p>'));
  res.send(shell(req, '/methods', 'Credentials — ' + m.name, body));
});
router.post('/methods/:id/credentials', async (req, res) => {
  const m = await req.db.get('SELECT * FROM payment_methods WHERE id = ?', [req.params.id]);
  if (!m) return notFound(req, res, 'Method not found.');
  // v16: FAIL CLOSED. The old code saved gateway secrets in PLAINTEXT when
  // CREDENTIAL_ENCRYPTION_KEY was not configured (with only a warning on the
  // page). A DB dump then leaked provider keys. Now saving is refused until
  // the key is set — the operator sets the key and re-saves (existing
  // plaintext rows are re-encrypted on re-save).
  if (!keyConfigured()) {
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'method.credentials_blocked', entity: 'method', entityId: m.id, detail: { reason: 'no encryption key' }, ip: req.ip });
    await req.setFlash('error', 'Credentials NOT saved: CREDENTIAL_ENCRYPTION_KEY is not configured, so secrets would be stored in plaintext. Set the key (Render → Environment) and save again.');
    return res.redirect(R(req, '/methods/' + m.id + '/credentials'));
  }
  const rail = getRail(m.rail);
  const credFields = rail ? rail.credentialFields : [];
  /* U-21 §5.1: validate the MERGED config (posted values, with blank
     password fields taking their already-saved value — keep-saved
     semantics) BEFORE any row is written. A refusal therefore leaves
     the stored config untouched, and a required password field with no
     saved value fails with its true reason instead of silently passing
     through the old keep-saved `continue` (the blank-save bug). */
  const savedCreds = {};
  for (const r of await req.db.query('SELECT field_key, field_value, field_enc FROM gateway_credentials WHERE method_id = ?', [m.id])) {
    try { savedCreds[r.field_key] = decryptField(r.field_value, r.field_enc); } catch (e) { savedCreds[r.field_key] = ''; }
  }
  const incoming = {};
  for (const f of credFields) {
    const posted = typeof req.body[f.key] === 'string' ? req.body[f.key] : '';
    incoming[f.key] = (f.type === 'password' && !posted) ? (savedCreds[f.key] || '') : posted;
  }
  const vres = validateRailCredentials(m.rail, incoming);
  if (!vres.ok) { await req.setFlash('error', 'Credentials NOT saved: ' + vres.error); return res.redirect(R(req, '/methods/' + m.id + '/credentials')); }
  for (const f of credFields) {
    let v = typeof req.body[f.key] === 'string' ? req.body[f.key] : '';
    if (f.type === 'password' && !v) continue; // keep saved (existence already proven by the merged validation above)
    const enc = keyConfigured();
    const stored = enc ? encryptField(v) : v;
    const ex = await req.db.get('SELECT id FROM gateway_credentials WHERE method_id = ? AND field_key = ?', [m.id, f.key]);
    if (ex) await req.db.run('UPDATE gateway_credentials SET field_value = ?, field_enc = ?, updated_at = ? WHERE id = ?', [stored, enc ? 1 : 0, now(), ex.id]);
    else await req.db.run('INSERT INTO gateway_credentials (method_id, field_key, field_value, field_enc, updated_at) VALUES (?, ?, ?, ?, ?)', [m.id, f.key, stored, enc ? 1 : 0, now()]);
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'method.credentials', entity: 'method', entityId: m.id, detail: { encrypted: keyConfigured() }, ip: req.ip });
  /* SCAN fix (C-16): the encryption key is guaranteed configured here
     (the handler refuses earlier without it), so the confirmation is
     stated plainly — the old conditional warning branch was dead. */
  await req.setFlash('success', 'Credentials saved. Encrypted at rest.');
  res.redirect(R(req, '/methods/' + m.id + '/credentials'));
});

/* ============================================================ REPORTS */
router.get('/reports', async (req, res) => {
  const { from, to, error: rangeError, capped } = dateRange(req);
  const type = req.query.type || 'business';
  const page = pageOf(req);
  const q = (req.query.q || '').trim();
  const tabs = [['business', 'Business'], ['login', 'Logins'], ['ticket', 'Tickets'], ['transaction', 'Transactions'], ['payment', 'Payments'], ['withdrawal', 'Withdrawals']]
    .map(([k, l]) => `<a class="tab${type === k ? ' active' : ''}" href="${R(req, '/reports')}?type=${k}&from=${fmtDateInput(from)}&to=${fmtDateInput(to)}${q ? '&q=' + encodeURIComponent(q) : ''}">${l}</a>`).join('');
  const dateForm = `<form method="GET" action="${R(req, '/reports')}" class="filters"><input type="hidden" name="type" value="${type}">
    <input type="date" name="from" value="${fmtDateInput(from)}"><input type="date" name="to" value="${fmtDateInput(to)}">
    <input type="text" name="q" value="${esc(q)}" placeholder="Filter by player email">
    <button class="btn btn-sm" type="submit">Apply</button></form>`;
  let body = `<div class="tabs">${tabs}</div>` + dateForm;
  if (rangeError) {
    body += `<div class="alert a-err">${esc(rangeError)}</div>`;
    return res.send(shell(req, '/reports', 'Reports', body, 'Money and activity reports.'));
  }
  if (capped) body += '<div class="alert a-warn">Date range capped at 366 days.</div>';
  const repBase = `${R(req, '/reports')}?type=${type}&from=${fmtDateInput(from)}&to=${fmtDateInput(to)}${q ? '&q=' + encodeURIComponent(q) : ''}`;
  const qLike = q ? '%' + q + '%' : null;
  if (type === 'business') {
    // R-061: one GROUP BY query per metric instead of 5 queries per day,
    // range capped at 366 days, money in BASE currency only (labelled —
    // the old report summed every currency into one USD number).
    const baseCur = getS(req.settings, 'base_currency', 'USD');
    const dayExpr = req.driver === 'mysql' ? 'FLOOR(created_at / 86400000)' : req.driver === 'postgres' ? '(created_at / 86400000)' : 'CAST(created_at / 86400000 AS INTEGER)';
    const dayExprDecided = req.driver === 'mysql' ? 'FLOOR(decided_at / 86400000)' : req.driver === 'postgres' ? '(decided_at / 86400000)' : 'CAST(decided_at / 86400000 AS INTEGER)';
    const salesByDay = await req.db.query(`SELECT ${dayExpr} AS day, COUNT(*) AS c, COALESCE(SUM(total),0) AS s FROM tickets WHERE created_at BETWEEN ? AND ? AND currency = ? GROUP BY day`, [from, to, baseCur]);
    const winsByDay = await req.db.query(`SELECT ${dayExpr} AS day, COALESCE(SUM(amount),0) AS s FROM transactions WHERE type IN ('win','scratch_prize') AND created_at BETWEEN ? AND ? AND currency = ? GROUP BY day`, [from, to, baseCur]);
    const depsByDay = await req.db.query(`SELECT ${dayExprDecided} AS day, COALESCE(SUM(net),0) AS s FROM deposits WHERE status='approved' AND decided_at BETWEEN ? AND ? AND currency = ? GROUP BY day`, [from, to, baseCur]);
    const wdsByDay = await req.db.query(`SELECT ${dayExprDecided} AS day, COALESCE(SUM(net),0) AS s FROM withdrawals WHERE status='approved' AND decided_at BETWEEN ? AND ? AND currency = ? GROUP BY day`, [from, to, baseCur]);
    const usersByDay = await req.db.query(`SELECT ${dayExpr} AS day, COUNT(*) AS c FROM users WHERE role='player' AND created_at BETWEEN ? AND ? GROUP BY day`, [from, to]);
    const byDay = (rows, key) => Object.fromEntries(rows.map(r => [Number(r.day), Number(r[key] || 0)]));
    const salesC = byDay(salesByDay, 'c'), salesS = byDay(salesByDay, 's'), winsS = byDay(winsByDay, 's'),
      depsS = byDay(depsByDay, 's'), wdsS = byDay(wdsByDay, 's'), usersC = byDay(usersByDay, 'c');
    const days = []; const bars = [];
    for (let bucket = Math.floor(from / 86400000); bucket <= Math.floor(to / 86400000); bucket++) {
      const label = new Date(bucket * 86400000).toISOString().slice(0, 10);
      const s = salesS[bucket] || 0, w = winsS[bucket] || 0;
      days.push([label, salesC[bucket] || 0, money(req, s, baseCur), money(req, w, baseCur), money(req, s - w, baseCur), money(req, depsS[bucket] || 0, baseCur), money(req, wdsS[bucket] || 0, baseCur), usersC[bucket] || 0]);
      bars.push({ date: label, staked: s, paid: w });
    }
    const maxBar = Math.max(1, ...bars.map(b => b.staked));
    const barsHtml = bars.length ? ui.card('Daily staked vs paid out', bars.map(b =>
      `<div class="daybar"><span class="daybar-d">${b.date}</span><span class="daybar-track"><span class="daybar-fill stake" style="width:${Math.round(b.staked / maxBar * 100)}%"></span><span class="daybar-fill paid" style="width:${Math.round(b.paid / maxBar * 100)}%"></span></span><span class="daybar-v">${money(req, b.staked, baseCur)} staked · ${money(req, b.paid, baseCur)} paid</span></div>`).join('')
      + '<p class="muted">Gold = staked, green = paid out. Bars are scaled to the biggest day in the selected range.</p>') : '';
    body += barsHtml + `<p class="muted">Money totals are in base currency (${esc(baseCur)}) only. Other currencies are excluded here — see the per-currency strips on Deposits / Withdrawals.</p>` +
      ui.card('Business report', ui.table(['Date', 'Tickets', 'Staked', 'Paid out', 'GGR', 'Deposits', 'Withdrawals', 'New users'], days));
  } else if (type === 'login') {
    // R-109: paginated with a total; breakdowns aggregate the whole range
    // (the old page grouped only the first 500 rows, then showed 200).
    const total = (await req.db.get('SELECT COUNT(*) AS c FROM login_history WHERE created_at BETWEEN ? AND ?' + (qLike ? ' AND LOWER(email) LIKE LOWER(?)' : ''), qLike ? [from, to, qLike] : [from, to])).c;
    const rows = await req.db.query('SELECT * FROM login_history WHERE created_at BETWEEN ? AND ?' + (qLike ? ' AND LOWER(email) LIKE LOWER(?)' : '') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?', qLike ? [from, to, qLike, PER, (page - 1) * PER] : [from, to, PER, (page - 1) * PER]);
    const grpQ = async (key) => req.db.query(`SELECT ${key} AS k, COUNT(*) AS c FROM login_history WHERE created_at BETWEEN ? AND ? GROUP BY ${key} ORDER BY c DESC`, [from, to]);
    const grp = (rowsG) => rowsG.map(r => [r.k || '—', r.c]);
    const browsers = await grpQ('browser'), oss = await grpQ('os');
    /* SCAN fix (C-11): no 'By country' card — login country is never
       recorded (no geo-IP service), so the card could only ever show a
       single '—' row. The Dashboard already states this honestly. */
    body += `<div class="grid2"><div>${ui.card('By browser', ui.table(['Browser', 'Logins'], grp(browsers)))}</div>
      <div>${ui.card('By OS', ui.table(['OS', 'Logins'], grp(oss)))}</div></div>` +
      ui.card('Login attempts', ui.table(['When', 'Email', 'IP', 'Browser', 'OS', 'Success'], rows.map(l =>
        [d(l.created_at), esc(l.email), esc(l.ip), esc(l.browser), esc(l.os), l.success ? '✓' : '✗']))) +
      ui.paginate(repBase, page, PER, total);
  } else if (type === 'ticket') {
    const total = (await req.db.get(`SELECT COUNT(*) AS c FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.created_at BETWEEN ? AND ?` + (qLike ? ' AND LOWER(u.email) LIKE LOWER(?)' : ''), qLike ? [from, to, qLike] : [from, to])).c;
    const rows = await req.db.query(`SELECT t.*, u.email FROM tickets t JOIN users u ON u.id=t.user_id WHERE t.created_at BETWEEN ? AND ?` + (qLike ? ' AND LOWER(u.email) LIKE LOWER(?)' : '') + ` ORDER BY t.created_at DESC LIMIT ? OFFSET ?`, qLike ? [from, to, qLike, PER, (page - 1) * PER] : [from, to, PER, (page - 1) * PER]);
    body += ui.card('Ticket report', ui.table(['When', 'Ticket', 'Player', 'Pops', 'Wager', 'Draws', 'Total', 'Status'], rows.map(t =>
      [d(t.created_at), `<span class="code">${esc(t.public_id)}</span>`, esc(t.email), safeJsonArray(t.pops).join(','), money(req, t.wager, t.currency), `${t.draw_type}×${t.num_draws}`, money(req, t.total, t.currency), ui.statusBadge(t.status)]))) +
      ui.paginate(repBase, page, PER, total);
  } else if (type === 'transaction') {
    const total = (await req.db.get(`SELECT COUNT(*) AS c FROM transactions tr JOIN users u ON u.id=tr.user_id WHERE tr.created_at BETWEEN ? AND ?` + (qLike ? ' AND LOWER(u.email) LIKE LOWER(?)' : ''), qLike ? [from, to, qLike] : [from, to])).c;
    const rows = await req.db.query(`SELECT tr.*, u.email FROM transactions tr JOIN users u ON u.id=tr.user_id WHERE tr.created_at BETWEEN ? AND ?` + (qLike ? ' AND LOWER(u.email) LIKE LOWER(?)' : '') + ` ORDER BY tr.created_at DESC LIMIT ? OFFSET ?`, qLike ? [from, to, qLike, PER, (page - 1) * PER] : [from, to, PER, (page - 1) * PER]);
    body += ui.card('Transaction report', ui.table(['When', 'Player', 'Type', 'Amount', 'Balance after'], rows.map(t =>
      [d(t.created_at), esc(t.email), esc(txLabel(t.type)), `<span class="${t.amount >= 0 ? 'pos' : 'neg'}">${money(req, t.amount, t.currency)}</span>`, money(req, t.balance_after, t.currency)]))) +
      ui.paginate(repBase, page, PER, total);
  } else if (type === 'payment') {
    const total = (await req.db.get(`SELECT COUNT(*) AS c FROM deposits d JOIN users u ON u.id=d.user_id WHERE d.created_at BETWEEN ? AND ?` + (qLike ? ' AND LOWER(u.email) LIKE LOWER(?)' : ''), qLike ? [from, to, qLike] : [from, to])).c;
    const rows = await req.db.query(`SELECT d.*, u.email FROM deposits d JOIN users u ON u.id=d.user_id WHERE d.created_at BETWEEN ? AND ?` + (qLike ? ' AND LOWER(u.email) LIKE LOWER(?)' : '') + ` ORDER BY d.created_at DESC LIMIT ? OFFSET ?`, qLike ? [from, to, qLike, PER, (page - 1) * PER] : [from, to, PER, (page - 1) * PER]);
    const totals = await req.db.query(`SELECT currency, COALESCE(SUM(net),0) AS s FROM deposits d JOIN users u ON u.id=d.user_id WHERE d.created_at BETWEEN ? AND ?` + (qLike ? ' AND LOWER(u.email) LIKE LOWER(?)' : '') + ` GROUP BY currency`, qLike ? [from, to, qLike] : [from, to]);
    body += (totals.length ? `<p class="muted">Net totals by currency: ${totals.map(t => `${esc(t.currency)} ${money(req, t.s, t.currency)}`).join(' · ')}</p>` : '') +
      ui.card('Payment report', ui.table(['When', 'ID', 'Player', 'Amount', 'Charge', 'Net', 'Status'], rows.map(x =>
      [d(x.created_at), `<span class="code">${esc(x.public_id)}</span>`, esc(x.email), money(req, x.amount, x.currency), money(req, x.charge, x.currency), money(req, x.net, x.currency), ui.statusBadge(x.status)]))) +
      ui.paginate(repBase, page, PER, total);
  } else {
    const total = (await req.db.get(`SELECT COUNT(*) AS c FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.created_at BETWEEN ? AND ?` + (qLike ? ' AND LOWER(u.email) LIKE LOWER(?)' : ''), qLike ? [from, to, qLike] : [from, to])).c;
    const rows = await req.db.query(`SELECT w.*, u.email FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.created_at BETWEEN ? AND ?` + (qLike ? ' AND LOWER(u.email) LIKE LOWER(?)' : '') + ` ORDER BY w.created_at DESC LIMIT ? OFFSET ?`, qLike ? [from, to, qLike, PER, (page - 1) * PER] : [from, to, PER, (page - 1) * PER]);
    const totals = await req.db.query(`SELECT currency, COALESCE(SUM(net),0) AS s FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.created_at BETWEEN ? AND ?` + (qLike ? ' AND LOWER(u.email) LIKE LOWER(?)' : '') + ` GROUP BY currency`, qLike ? [from, to, qLike] : [from, to]);
    body += (totals.length ? `<p class="muted">Net totals by currency: ${totals.map(t => `${esc(t.currency)} ${money(req, t.s, t.currency)}`).join(' · ')}</p>` : '') +
      ui.card('Withdrawal report', ui.table(['When', 'ID', 'Player', 'Amount', 'Charge', 'Net', 'Status'], rows.map(x =>
      [d(x.created_at), `<span class="code">${esc(x.public_id)}</span>`, esc(x.email), money(req, x.amount, x.currency), money(req, x.charge, x.currency), money(req, x.net, x.currency), ui.statusBadge(x.status)]))) +
      ui.paginate(repBase, page, PER, total);
  }
  res.send(shell(req, '/reports', 'Reports', body, 'Money and activity reports.'));
});

/* ============================================================ DATA — IMPORT & EXPORT (U-23)
   Export: per-dataset CSV downloads (human headers, major-unit amounts,
   paged reads, honest cap, audit-logged). Import: dry-run → execute for
   adjudicated non-money master data ONLY (see adj-chain.md). Money data
   (balances, ledger, deposits, withdrawals) has NO import route at all. */
const EXPORT_CAP = 10000, EXPORT_PAGE = 500;
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  // Spreadsheet formula-injection guard for text cells (plain numbers pass).
  if (/^[=+@]/.test(s) || (/^-/.test(s) && !/^-\d+(\.\d+)?$/.test(s))) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function csvDateTime(ms) { const n = Number(ms); return n ? new Date(n).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : ''; }
function humanLabel(s) { const t = String(s === null || s === undefined ? '' : s).replace(/_/g, ' ').trim(); return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''; }
function txLabel(s) { return TX_LABELS[s] || humanLabel(s || ''); }
function yesNo(v) { return v ? 'Yes' : 'No'; }
function majorOf(req, minor, cur) { return fromMinor(Number(minor) || 0, decimalsFor(cur, req.currencies)); }
function userDataText(stored) {
  try { const o = decodeUserData(stored); return Object.entries(o || {}).filter(([, v]) => String(v) !== '').map(([k, v]) => `${k}: ${v}`).join('; '); } catch { return ''; }
}
/* roles follow lib/rbac.js sets; GETs are otherwise readable by all staff,
   so each export gates itself (same pattern as the credentials page). */
const EXPORT_DEFS = {
  users: { label: 'Users', roles: ['super', 'risk'], timed: 'u.created_at', order: 'u.id ASC',
    desc: 'Every account: players, agents and staff, with verification and KYC status.',
    headers: ['User ID', 'Full name', 'Email', 'Phone', 'Account type', 'Status', 'Email verified', 'Phone verified', 'KYC status', 'Country', 'Agent', 'Referral code', 'Referred by', 'Joined', 'Last login'],
    from: 'FROM users u LEFT JOIN users a ON a.id = u.agent_id LEFT JOIN users rb ON rb.id = u.referred_by',
    select: 'SELECT u.*, a.email AS agent_email, rb.email AS referred_by_email',
    row: (req, u) => [u.id, u.name, u.email, u.phone || '', u.role === 'admin' ? `Staff (${u.admin_role || 'super'})` : humanLabel(u.role), humanLabel(u.status), yesNo(u.email_verified), yesNo(u.mobile_verified), humanLabel(u.kyc_status || 'none'), u.country || '', u.agent_email || '', u.referral_code || '', u.referred_by_email || '', csvDateTime(u.created_at), csvDateTime(u.last_login_at)] },
  ledger: { label: 'Ledger (transactions)', roles: ['super', 'finance'], timed: 'tr.created_at', order: 'tr.id ASC',
    desc: 'The full money ledger — every credit and debit ever posted.',
    headers: ['Transaction ID', 'Date and time', 'Player email', 'Type', 'Amount', 'Currency', 'Balance after', 'Reference type', 'Reference ID', 'Details'],
    from: 'FROM transactions tr JOIN users u ON u.id = tr.user_id',
    select: 'SELECT tr.*, u.email AS user_email',
    row: (req, t) => [t.id, csvDateTime(t.created_at), t.user_email, humanLabel(t.type), majorOf(req, t.amount, t.currency), t.currency, majorOf(req, t.balance_after, t.currency), humanLabel(t.ref_type || ''), t.ref_id || '', t.meta && t.meta !== '{}' ? t.meta : ''] },
  tickets: { label: 'Lottery tickets', roles: ['super', 'finance'], timed: 't.created_at', order: 't.id ASC',
    desc: 'Lottery tickets with their entry counts and wins.',
    headers: ['Ticket reference', 'Date and time', 'Player email', 'Numbers (pops)', 'Wager per pop', 'Currency', 'Draw type', 'Number of draws', 'Total paid', 'Status', 'Entries', 'Winning entries'],
    from: 'FROM tickets t JOIN users u ON u.id = t.user_id',
    select: "SELECT t.*, u.email AS user_email, (SELECT COUNT(*) FROM ticket_entries te WHERE te.ticket_id = t.id) AS entries_count, (SELECT COUNT(*) FROM ticket_entries te2 WHERE te2.ticket_id = t.id AND te2.status = 'won') AS entries_won",
    row: (req, t) => [t.public_id, csvDateTime(t.created_at), t.user_email, safeJsonArray(t.pops).join(', '), majorOf(req, t.wager, t.currency), t.currency, humanLabel(String(t.draw_type || '').toLowerCase()), t.num_draws, majorOf(req, t.total, t.currency), humanLabel(t.status), t.entries_count, t.entries_won] },
  ticket_entries: { label: 'Ticket entries (per draw)', roles: ['super', 'finance'], timed: 't.created_at', order: 'te.id ASC',
    desc: 'One row per ticket entry in a draw, with its result.',
    headers: ['Entry ID', 'Ticket reference', 'Player email', 'Draw ID', 'Draw type', 'Draw date', 'Entry status', 'Win amount', 'Currency', 'Settled at'],
    from: 'FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id JOIN users u ON u.id = t.user_id JOIN draws dr ON dr.id = te.draw_id',
    select: 'SELECT te.*, t.public_id AS ticket_ref, t.currency AS ticket_currency, u.email AS user_email, dr.draw_type AS d_type, dr.draw_date AS d_date',
    row: (req, e) => [e.id, e.ticket_ref, e.user_email, e.draw_id, humanLabel(String(e.d_type || '').toLowerCase()), e.d_date, humanLabel(e.status), majorOf(req, e.win_amount, e.ticket_currency), e.ticket_currency, csvDateTime(e.settled_at)] },
  draws: { label: 'Draws and results', roles: ['super', 'finance'], timed: 'dr.created_at', order: 'dr.id ASC',
    desc: 'Every draw with its winning number once settled.',
    headers: ['Draw ID', 'Draw type', 'Draw date', 'Entries close', 'Status', 'Winning number', 'Test draw', 'Entries', 'Created'],
    from: 'FROM draws dr',
    select: 'SELECT dr.*, (SELECT COUNT(*) FROM ticket_entries te WHERE te.draw_id = dr.id) AS entries_count',
    row: (req, dr) => [dr.id, humanLabel(String(dr.draw_type || '').toLowerCase()), dr.draw_date, csvDateTime(dr.close_at), humanLabel(dr.status), dr.winning_number === null || dr.winning_number === undefined ? '' : dr.winning_number, yesNo(dr.is_test), dr.entries_count, csvDateTime(dr.created_at)] },
  deposits: { label: 'Deposits', roles: ['super', 'finance'], timed: 'd.created_at', order: 'd.id ASC',
    desc: 'Deposit requests with amounts, charges and the payment proof players submitted.',
    headers: ['Deposit reference', 'Date and time', 'Player email', 'Method', 'Amount', 'Charge', 'Net credited', 'Currency', 'Status', 'Payment details submitted', 'Provider reference', 'Decided at', 'Admin note'],
    from: 'FROM deposits d JOIN users u ON u.id = d.user_id LEFT JOIN payment_methods m ON m.id = d.method_id',
    select: 'SELECT d.*, u.email AS user_email, m.name AS method_name',
    row: (req, x) => [x.public_id, csvDateTime(x.created_at), x.user_email, x.method_name || '', majorOf(req, x.amount, x.currency), majorOf(req, x.charge, x.currency), majorOf(req, x.net, x.currency), x.currency, humanLabel(x.status), userDataText(x.user_data), x.provider_txn_id || '', csvDateTime(x.decided_at), x.admin_note || ''] },
  withdrawals: { label: 'Withdrawals', roles: ['super', 'finance'], timed: 'w.created_at', order: 'w.id ASC',
    desc: 'Withdrawal requests with the payout details players supplied.',
    headers: ['Withdrawal reference', 'Date and time', 'Player email', 'Method', 'Amount', 'Charge', 'Net to pay', 'Currency', 'Status', 'Payout details supplied', 'Provider payout ID', 'Decided at', 'Paid at', 'Admin note'],
    from: 'FROM withdrawals w JOIN users u ON u.id = w.user_id LEFT JOIN payment_methods m ON m.id = w.method_id',
    select: 'SELECT w.*, u.email AS user_email, m.name AS method_name',
    row: (req, x) => [x.public_id, csvDateTime(x.created_at), x.user_email, x.method_name || '', majorOf(req, x.amount, x.currency), majorOf(req, x.charge, x.currency), majorOf(req, x.net, x.currency), x.currency, humanLabel(x.status), userDataText(x.user_data), x.provider_payout_id || '', csvDateTime(x.decided_at), csvDateTime(x.payout_at), x.admin_note || ''] },
  agents: { label: 'Agents', roles: ['super', 'finance'], timed: 'u.created_at', order: 'u.id ASC',
    desc: 'Agent accounts with assigned player counts and float balances.',
    headers: ['Agent ID', 'Full name', 'Email', 'Phone', 'Status', 'Players assigned', 'Float balances', 'Joined'],
    from: "FROM users u WHERE u.role = 'agent'",
    select: 'SELECT u.*, (SELECT COUNT(*) FROM users p WHERE p.agent_id = u.id) AS players_count',
    row: (req, u, extra) => [u.id, u.name, u.email, u.phone || '', humanLabel(u.status), u.players_count, (extra && extra.floats) || '', csvDateTime(u.created_at)] },
  support_tickets: { label: 'Support tickets', roles: ['super', 'support'], timed: 's.created_at', order: 's.id ASC',
    desc: 'Support tickets (including soft-deleted ones, marked as such).',
    headers: ['Ticket reference', 'Date and time', 'Player email', 'Subject', 'Priority', 'Status', 'Messages', 'Last updated', 'Deleted'],
    from: 'FROM support_tickets s JOIN users u ON u.id = s.user_id',
    select: 'SELECT s.*, u.email AS user_email, (SELECT COUNT(*) FROM support_messages sm WHERE sm.ticket_id = s.id) AS msg_count',
    row: (req, s) => [s.public_id, csvDateTime(s.created_at), s.user_email, s.subject, humanLabel(s.priority || 'medium'), humanLabel(s.status), s.msg_count, csvDateTime(s.updated_at), yesNo(s.deleted_at)] },
};
function exportRange(req) {
  // Date filter is OPTIONAL for exports: no dates = full history (the cap
  // still applies). When dates ARE given, the shared reports helper
  // validates them (and caps the span at 366 days).
  if (!req.query.from && !req.query.to) return { from: null, to: null, error: null };
  const r = dateRange(req);
  return { from: r.from, to: r.to, error: r.error };
}
router.get('/data', async (req, res) => {
  const { normalizeRole } = require('../lib/rbac');
  const role = normalizeRole(req.user);
  const chosen = EXPORT_DEFS[req.query.dataset] ? req.query.dataset : '';
  const exportRows = Object.entries(EXPORT_DEFS).filter(([, def]) => def.roles.includes(role)).map(([key, def]) =>
    `<tr><td><strong>${esc(def.label)}</strong>${chosen === key ? ' <span class="badge b-info">selected</span>' : ''}<br><span class="muted">${esc(def.desc)}</span></td>
     <td><form method="GET" action="${R(req, '/data/export/' + key)}" class="filters">
       <input type="date" name="from" aria-label="From date"><input type="date" name="to" aria-label="To date">
       <button class="btn btn-sm" type="submit">Download CSV</button></form>
       <span class="muted">Leave the dates empty for the full history.</span></td></tr>`).join('');
  const exportCard = ui.card('Export data (CSV download)',
    `<p class="muted">Each file has clear column headings, amounts in full currency units (for example 25.00) with the currency named, and readable dates. One download holds at most ${EXPORT_CAP.toLocaleString('en-US')} rows — if a set is larger, the file says so in the download headers and the audit trail records that it was capped; narrow the date range to get the rest. Every download is recorded in the audit trail with the dataset and row count. For on-screen viewing, use <a href="${R(req, '/reports')}">Reports</a>.</p>` +
    `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Dataset</th><th>Download</th></tr></thead><tbody>${exportRows || '<tr><td colspan="2" class="muted">Your staff role cannot download data exports.</td></tr>'}</tbody></table></div>`);
  let importCard;
  if (role !== 'super') {
    importCard = ui.card('Import data', '<p class="muted">Only the super admin can import data.</p>');
  } else {
    const defList = Object.values(IMPORT_DEFS).map(def =>
      `<li><strong>${esc(def.label)}</strong> — columns: <span class="code">${def.columns.map(esc).join(', ')}</span> (matched by ${esc(def.keyDesc)}; rows that already exist are skipped, never overwritten)</li>`).join('');
    importCard = ui.card('Import data (checked before anything is saved)',
      `<div class="alert a-warn"><strong>Money can never be imported.</strong> Balances, the ledger (transaction history), deposits and withdrawals are not accepted here in any form — money records are only ever created by the payment and game flows themselves, so an imported spreadsheet can never create, change or delete money. If you need to correct a balance, use the balance adjustment on the player's page, where the change is checked and recorded.</div>
       <p class="muted">You can import only this reference content:</p><ul>${defList}</ul>
       <p class="muted">How it works: open your .csv file, copy its full contents and paste them below, then choose <strong>Check the file</strong>. Nothing is saved at that step — you get a row-by-row report first (ready / already exists / rejected with the reason), and only the separate <strong>Import</strong> button on that report saves anything. Maximum ${IMPORT_MAX_ROWS} rows and about 900 KB per import. Accounts, tickets, draws and payment settings cannot be imported — they are created in their own screens, where their checks run.</p>` +
      `<form method="POST" action="${R(req, '/data/import')}" class="adm-form"><input type="hidden" name="_csrf" value="${req.csrfToken}">
       <div class="field"><label for="imp_dataset">What are you importing?</label><select id="imp_dataset" name="dataset">${Object.entries(IMPORT_DEFS).map(([k, def]) => `<option value="${k}">${esc(def.label)}</option>`).join('')}</select></div>
       <div class="field"><label for="imp_filename">File name (for the audit record)</label><input type="text" id="imp_filename" name="filename" placeholder="e.g. pages-export.csv"></div>
       <div class="field"><label for="imp_csv">CSV contents</label><textarea id="imp_csv" name="csv_text" rows="10" required placeholder="Paste the full contents of the .csv file here"></textarea></div>
       <div class="mt"><button class="btn btn-p" type="submit">Check the file</button></div></form>`);
  }
  res.send(shell(req, '/data', 'Data — Import & Export', exportCard + importCard, 'Export or import platform data.'));
});
router.get('/data/export/:dataset', async (req, res) => {
  const { normalizeRole } = require('../lib/rbac');
  const def = EXPORT_DEFS[req.params.dataset];
  if (!def) return notFound(req, res, 'That dataset does not exist.');
  if (!def.roles.includes(normalizeRole(req.user))) return res.status(403).render('error', { status: 403, message: 'Your staff role does not permit this export.' });
  const range = exportRange(req);
  if (range.error) { await req.setFlash('error', range.error); return res.redirect(R(req, '/data')); }
  const hasRange = range.from !== null;
  const baseFrom = def.from;
  const whereSql = hasRange ? (baseFrom.includes('WHERE') ? ` AND ${def.timed} BETWEEN ? AND ?` : ` WHERE ${def.timed} BETWEEN ? AND ?`) : '';
  const params = hasRange ? [range.from, range.to] : [];
  const total = Number((await req.db.get(`SELECT COUNT(*) AS c ${baseFrom}${whereSql}`, params)).c) || 0;
  const capped = total > EXPORT_CAP;
  const fileDate = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.dataset}-${fileDate}.csv"`);
  res.setHeader('X-Export-Total', String(total));
  if (capped) res.setHeader('X-Export-Cap', String(EXPORT_CAP));
  res.write(def.headers.map(csvCell).join(',') + '\r\n');
  let written = 0;
  const limit = Math.min(total, EXPORT_CAP);
  while (written < limit) {
    const pageRows = await req.db.query(`${def.select} ${baseFrom}${whereSql} ORDER BY ${def.order} LIMIT ? OFFSET ?`, [...params, Math.min(EXPORT_PAGE, limit - written), written]);
    if (!pageRows.length) break;
    let extraById = {};
    if (req.params.dataset === 'agents' && pageRows.length) {
      const floats = await req.db.query(`SELECT agent_id, currency, balance FROM agent_floats WHERE agent_id IN (${pageRows.map(() => '?').join(',')}) ORDER BY currency`, pageRows.map(a => a.id));
      for (const f of floats) { const s = `${f.currency} ${majorOf(req, f.balance, f.currency)}`; extraById[f.agent_id] = extraById[f.agent_id] ? extraById[f.agent_id] + '; ' + s : s; }
    }
    for (const r of pageRows) {
      res.write(def.row(req, r, { floats: extraById[r.id] || '' }).map(csvCell).join(',') + '\r\n');
      written++;
    }
  }
  res.end();
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'data.export', entity: 'data', entityId: req.params.dataset, detail: { dataset: req.params.dataset, rows: written, total, capped, from: hasRange ? range.from : null, to: hasRange ? range.to : null }, ip: req.ip });
});

/* ---------- U-23 import: adjudicated non-money master data only ---------- */
const IMPORT_MAX_ROWS = 1000, IMPORT_MAX_BYTES = 900 * 1024;
/* Minimal RFC-4180 CSV parser: quoted fields, "" escapes, CRLF/LF.
   Returns { rows: string[][] } or { error } — malformed quoting fails
   the whole file cleanly; nothing is ever partially parsed into a write. */
function parseCsv(text) {
  const rows = []; let row = [], field = '', inQ = false, i = 0;
  const s = String(text || '').replace(/^\uFEFF/, '');
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  while (i < s.length) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { if (field.length) return { error: 'The CSV has a quote in the middle of a value (row ' + (rows.length + 1) + '). Please re-export or fix the file and try again.' }; inQ = true; i++; continue; }
    if (c === ',') { pushField(); i++; continue; }
    if (c === '\r') { if (s[i + 1] === '\n') i++; pushRow(); i++; continue; }
    if (c === '\n') { pushRow(); i++; continue; }
    field += c; i++;
  }
  if (inQ) return { error: 'The CSV has an unclosed quote. Please fix the file and try again.' };
  if (field.length || row.length) pushRow();
  return { rows };
}
const IMPORT_DEFS = {
  pages: { label: 'Content pages', keyDesc: 'the page address (slug)',
    columns: ['slug', 'name', 'title', 'meta_title', 'meta_desc', 'body', 'status', 'sort'], required: ['slug', 'name', 'title'],
    keyOf: r => String(r.slug || '').toLowerCase(),
    validate(r) {
      if (!validSlug(r.slug)) return 'Page address (slug) must be lowercase letters, numbers and dashes only.';
      if (r.name.length > 200) return 'Name is too long (max 200 characters).';
      if (r.title.length > 300) return 'Title is too long (max 300 characters).';
      if (r.status && !['published', 'draft'].includes(r.status)) return 'Status must be "published" or "draft".';
      if (r.sort && !/^\d{1,6}$/.test(r.sort)) return 'Sort order must be a whole number (0 or more).';
      return '';
    },
    exists: async (db, r) => !!(await db.get('SELECT id FROM pages WHERE slug = ?', [r.slug])),
    insert: async (tx, r) => { await tx.run('INSERT INTO pages (name, slug, title, meta_title, meta_desc, body, status, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [r.name, r.slug, r.title, r.meta_title || '', r.meta_desc || '', r.body || '', r.status || 'published', parseInt(r.sort || '0', 10) || 0]); } },
  canned_replies: { label: 'Canned support replies', keyDesc: 'the reply title',
    columns: ['title', 'body'], required: ['title', 'body'],
    keyOf: r => String(r.title || '').toLowerCase(),
    validate(r) {
      if (r.title.length > 120) return 'Title is too long (max 120 characters).';
      if (r.body.length > 5000) return 'Reply text is too long (max 5000 characters).';
      return '';
    },
    exists: async (db, r) => !!(await db.get('SELECT id FROM canned_replies WHERE LOWER(title) = LOWER(?)', [r.title])),
    insert: async (tx, r, req) => { const t = now(); await tx.run('INSERT INTO canned_replies (title, body, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [r.title, r.body, req.user.id, t, t]); } },
  notif_templates: { label: 'Notification templates', keyDesc: 'the channel + template name',
    columns: ['channel', 'slug', 'subject', 'body', 'enabled'], required: ['channel', 'slug', 'body'],
    keyOf: r => String(r.channel || '').toLowerCase() + ':' + String(r.slug || '').toLowerCase(),
    validate(r) {
      if (!['email', 'sms', 'push'].includes(String(r.channel || '').toLowerCase())) return 'Channel must be email, sms or push.';
      if (!/^[a-z0-9_]{1,64}$/.test(r.slug || '')) return 'Template name (slug) must be lowercase letters, numbers and underscores only.';
      if (r.subject && r.subject.length > 300) return 'Subject is too long (max 300 characters).';
      if (r.body.length > 10000) return 'Message body is too long (max 10000 characters).';
      if (r.enabled && !['1', '0', 'yes', 'no', 'true', 'false'].includes(String(r.enabled).toLowerCase())) return 'Enabled must be yes or no.';
      return '';
    },
    exists: async (db, r) => !!(await db.get('SELECT id FROM notif_templates WHERE channel = ? AND slug = ?', [String(r.channel).toLowerCase(), r.slug])),
    insert: async (tx, r) => { const en = r.enabled === undefined || r.enabled === '' ? 1 : (['1', 'yes', 'true'].includes(String(r.enabled).toLowerCase()) ? 1 : 0); await tx.run('INSERT INTO notif_templates (channel, slug, subject, body, enabled) VALUES (?, ?, ?, ?, ?)', [String(r.channel).toLowerCase(), r.slug, r.subject || '', r.body, en]); } },
  content_blocks: { label: 'Content blocks', keyDesc: 'the block key',
    columns: ['key', 'title', 'body'], required: ['key', 'body'],
    keyOf: r => String(r.key || '').toLowerCase(),
    validate(r) {
      if (!/^[a-z0-9_]{1,64}$/.test(r.key || '')) return 'Block key must be lowercase letters, numbers and underscores only.';
      if (r.title && r.title.length > 300) return 'Title is too long (max 300 characters).';
      if (r.body.length > 100000) return 'Body is too long (max 100000 characters).';
      return '';
    },
    exists: async (db, r, req) => !!(await db.get(`SELECT ${keyCol(req.driver)} AS k FROM content_blocks WHERE ${keyCol(req.driver)} = ?`, [r.key])),
    insert: async (tx, r, req) => { await tx.run(`INSERT INTO content_blocks (${keyCol(req.driver)}, title, body, updated_at) VALUES (?, ?, ?, ?)`, [r.key, r.title || '', r.body, now()]); } },
};
/* Build the full validation plan for a CSV. Writes NOTHING. Each row ends
   up ready / duplicate / rejected with the true reason. */
async function buildImportPlan(req, datasetKey, csvText) {
  const def = IMPORT_DEFS[datasetKey];
  if (!def) return { error: 'Choose what you are importing first.' };
  const text = typeof csvText === 'string' ? csvText : '';
  if (!text.trim()) return { error: 'Paste the CSV contents first — nothing was checked.' };
  if (Buffer.byteLength(text, 'utf8') > IMPORT_MAX_BYTES) return { error: 'The file is too large for one import (maximum about 900 KB). Split it into smaller files.' };
  const parsed = parseCsv(text);
  if (parsed.error) return { error: parsed.error };
  const raw = (parsed.rows || []).filter(r => !(r.length === 1 && String(r[0]).trim() === ''));
  if (!raw.length) return { error: 'The file is empty — nothing was checked.' };
  const header = raw[0].map(h => String(h || '').trim().toLowerCase());
  for (const col of def.required) if (!header.includes(col)) return { error: `The file is missing the "${col}" column, so none of its rows can be read. The first row must name the columns: ${def.columns.join(', ')}.` };
  const unknown = header.filter(h => h && !def.columns.includes(h));
  const dataRows = raw.slice(1);
  if (!dataRows.length) return { error: 'The file has column names but no data rows.' };
  if (dataRows.length > IMPORT_MAX_ROWS) return { error: `The file has ${dataRows.length} rows — one import is limited to ${IMPORT_MAX_ROWS}. Split the file and import in parts.` };
  const seen = new Map();
  const plan = { def, dataset: datasetKey, rows: [], ready: 0, duplicates: 0, rejected: 0, unknownColumns: unknown };
  for (let idx = 0; idx < dataRows.length; idx++) {
    const cells = dataRows[idx];
    const rowNo = idx + 2; // 1-based + header row
    if (cells.length !== header.length) { plan.rows.push({ n: rowNo, key: '', status: 'rejected', reason: `This row has ${cells.length} values but the file has ${header.length} columns — the row does not line up with the column names.` }); plan.rejected++; continue; }
    const rec = {};
    header.forEach((h, i) => { if (h) rec[h] = String(cells[i] === undefined ? '' : cells[i]).trim(); });
    const key = def.keyOf(rec);
    const missing = def.required.find(c => !rec[c]);
    if (missing) { plan.rows.push({ n: rowNo, key, status: 'rejected', reason: `Missing "${missing}" — every row needs a value in this column.` }); plan.rejected++; continue; }
    const verr = def.validate(rec);
    if (verr) { plan.rows.push({ n: rowNo, key, status: 'rejected', reason: verr }); plan.rejected++; continue; }
    if (seen.has(key)) { plan.rows.push({ n: rowNo, key, status: 'duplicate', reason: `The same ${def.keyDesc} already appears in this file (row ${seen.get(key)}).` }); plan.duplicates++; continue; }
    seen.set(key, rowNo);
    if (await def.exists(req.db, rec, req)) { plan.rows.push({ n: rowNo, key, status: 'duplicate', reason: 'Already exists — it will be skipped, not overwritten.' }); plan.duplicates++; continue; }
    plan.rows.push({ n: rowNo, key, status: 'ready', reason: '', data: rec });
    plan.ready++;
  }
  return plan;
}
function importFilename(raw) {
  const f = String(typeof raw === 'string' ? raw : '').trim().replace(/[^\w.\- ]/g, '').slice(0, 120);
  return f || 'pasted-import.csv';
}
router.post('/data/import', async (req, res) => {
  const { normalizeRole } = require('../lib/rbac');
  if (normalizeRole(req.user) !== 'super') return res.status(403).render('error', { status: 403, message: 'Only the super admin can import data.' });
  const dataset = typeof req.body.dataset === 'string' ? req.body.dataset : '';
  const csvText = (typeof req.importCsvText === 'string' && req.importCsvText) ? req.importCsvText : (typeof req.body.csv_text === 'string' ? req.body.csv_text : '');
  const filename = importFilename(req.body.filename);
  const plan = await buildImportPlan(req, dataset, csvText);
  if (plan.error) { await req.setFlash('error', 'Import check failed: ' + plan.error); return res.redirect(R(req, '/data')); }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'data.import_dry_run', entity: 'data', entityId: dataset, detail: { dataset, filename, ready: plan.ready, duplicates: plan.duplicates, rejected: plan.rejected }, ip: req.ip });
  const rowsHtml = plan.rows.map(r => `<tr><td>${r.n}</td><td>${esc(r.key || '—')}</td><td>${r.status === 'ready' ? ui.badge('Ready', 'ok') : r.status === 'duplicate' ? ui.badge('Already exists', 'warn') : ui.badge('Rejected', 'err')}</td><td>${esc(r.reason || '—')}</td></tr>`).join('');
  const executeForm = plan.ready ? `<form method="POST" action="${R(req, '/data/import/execute')}" class="adm-form">
      <input type="hidden" name="_csrf" value="${req.csrfToken}">
      <input type="hidden" name="dataset" value="${esc(dataset)}">
      <input type="hidden" name="filename" value="${esc(filename)}">
      <textarea name="csv_text" style="display:none">${esc(csvText)}</textarea>
      <p class="muted">The file is checked again when you import. Only the ${plan.ready} ready row(s) are saved; existing and rejected rows are never written.</p>
      <button class="btn btn-p" type="submit">Import ${plan.ready} row(s) now</button></form>` : '<p class="muted">Nothing in this file can be imported — every row already exists or was rejected.</p>';
  const body = ui.card(`Import check — ${esc(plan.def.label)} (file: ${esc(filename)})`,
    `<p><strong>${plan.ready}</strong> ready · <strong>${plan.duplicates}</strong> already exist (skipped) · <strong>${plan.rejected}</strong> rejected. <strong>Nothing has been saved yet.</strong></p>` +
    (plan.unknownColumns.length ? `<p class="muted">Columns not used for this data and ignored: ${plan.unknownColumns.map(esc).join(', ')}.</p>` : '') +
    `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Row</th><th>Key</th><th>Result</th><th>Reason</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>` + executeForm) +
    `<p class="mt"><a class="btn btn-sm" href="${R(req, '/data')}">← Back to Import &amp; Export</a></p>`;
  res.send(shell(req, '/data', 'Import Check', body));
});
router.post('/data/import/execute', async (req, res) => {
  const { normalizeRole } = require('../lib/rbac');
  if (normalizeRole(req.user) !== 'super') return res.status(403).render('error', { status: 403, message: 'Only the super admin can import data.' });
  const dataset = typeof req.body.dataset === 'string' ? req.body.dataset : '';
  const csvText = typeof req.body.csv_text === 'string' ? req.body.csv_text : '';
  const filename = importFilename(req.body.filename);
  /* Execute RE-validates the file from scratch: the numbers the operator
     saw at check time are recomputed here, and inserts run in ONE
     transaction — a failure anywhere writes nothing. */
  const plan = await buildImportPlan(req, dataset, csvText);
  if (plan.error) { await req.setFlash('error', 'Import stopped: ' + plan.error); return res.redirect(R(req, '/data')); }
  const readyRows = plan.rows.filter(r => r.status === 'ready');
  let inserted = 0;
  if (readyRows.length) {
    await req.db.transaction(async (tx) => {
      for (const r of readyRows) {
        if (await plan.def.exists(tx, r.data, req)) continue; // changed since the check — skip, never overwrite
        await plan.def.insert(tx, r.data, req);
        inserted++;
      }
    });
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'data.import', entity: 'data', entityId: dataset, detail: { dataset, filename, inserted, duplicates: plan.duplicates, rejected: plan.rejected }, ip: req.ip });
  await req.setFlash('success', `Import finished: ${inserted} new row(s) added to ${plan.def.label}. ${plan.duplicates} already existed (skipped), ${plan.rejected} rejected — see a fresh check for their reasons.`);
  res.redirect(R(req, '/data'));
});

/* ============================================================ SUPPORT */
router.get('/support', async (req, res) => {
  // R-062: the priority filter used to run AFTER the LIMIT (a High ticket
  // past row 100 was invisible), and the status tabs dropped the priority
  // filter and vice versa. Both filters now run in SQL, and every tab link
  // carries the other filter. The list also paginates (was LIMIT 100).
  const page = pageOf(req);
  const status = req.query.status || '';
  const prio = ['high', 'medium', 'low'].includes(req.query.priority) ? req.query.priority : '';
  /* U-25: soft-deleted tickets are excluded from every normal list and
     count; the Deleted view (deleted=1) shows ONLY soft-deleted rows. */
  const deletedView = req.query.deleted === '1';
  const where = [], params = [];
  where.push(deletedView ? 's.deleted_at IS NOT NULL' : 's.deleted_at IS NULL');
  if (status && !deletedView) { where.push('s.status = ?'); params.push(status); }
  if (prio) { where.push("COALESCE(s.priority, 'medium') = ?"); params.push(prio); }
  const w = 'WHERE ' + where.join(' AND ');
  const total = (await req.db.get(`SELECT COUNT(*) AS c FROM support_tickets s ${w}`, params)).c;
  const rows = await req.db.query(`SELECT s.*, u.email, du.email AS deleted_by_email FROM support_tickets s JOIN users u ON u.id=s.user_id LEFT JOIN users du ON du.id = s.deleted_by ${w} ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`, [...params, PER, (page - 1) * PER]);
  const open = (await req.db.get("SELECT COUNT(*) AS c FROM support_tickets WHERE status='open' AND deleted_at IS NULL")).c;
  const deletedCount = (await req.db.get('SELECT COUNT(*) AS c FROM support_tickets WHERE deleted_at IS NOT NULL')).c;
  const supBase = (st, pr) => `${R(req, '/support')}?${[st ? 'status=' + st : '', pr ? 'priority=' + pr : ''].filter(Boolean).join('&')}`;
  const delBase = (pr) => `${R(req, '/support')}?deleted=1${pr ? '&priority=' + pr : ''}`;
  /* U-26 TWO DOORS (§5.1): the ticket limits also live here, on the
     queue they govern. Same /settings/support-limits route and the
     same two keys the Settings card writes. Editable only for super
     (that route is super-only); other roles see the current values. */
  const supLimitsCard = ui.card('Ticket limits',
    isSuperReq(req)
      ? `<p class="muted">Caps enforced when a player opens support tickets. Set either limit to <strong>0</strong> for unlimited. This is the same setting as Settings → Support ticket limits.</p>` +
        ui.formHtml(R(req, '/settings/support-limits'), [
          { key: 'support_max_open_tickets', label: 'Max open tickets per player', type: 'number', value: getS(req.settings, 'support_max_open_tickets', '2'), help: 'Open = not closed. 0 = unlimited.' },
          { key: 'support_max_new_tickets_24h', label: 'Max new tickets per player per 24 hours', type: 'number', value: getS(req.settings, 'support_max_new_tickets_24h', '3'), help: 'Rolling 24-hour window. 0 = unlimited.' },
        ], { csrf: req.csrfToken, submit: 'Save ticket limits' })
      : `<p class="muted">Max open tickets per player: <strong>${esc(getS(req.settings, 'support_max_open_tickets', '2'))}</strong> · Max new tickets per player per 24 hours: <strong>${esc(getS(req.settings, 'support_max_new_tickets_24h', '3'))}</strong> (0 = unlimited). Only the super admin can change these, in Settings → Support ticket limits.</p>`);
  const body = supLimitsCard + `<div class="tabs"><a class="tab${!deletedView && !status ? ' active' : ''}" href="${supBase('', prio)}">All</a>
    <a class="tab${!deletedView && status === 'open' ? ' active' : ''}" href="${supBase('open', prio)}">Open <span class="count">${open}</span></a>
    <a class="tab${!deletedView && status === 'answered' ? ' active' : ''}" href="${supBase('answered', prio)}">Answered</a>
    <a class="tab${!deletedView && status === 'closed' ? ' active' : ''}" href="${supBase('closed', prio)}">Closed</a>
    <a class="tab${deletedView ? ' active' : ''}" href="${delBase(prio)}">Deleted <span class="count">${deletedCount}</span></a></div>
    <div class="tabs"><span class="muted">Priority:</span>
    <a class="tab${!prio ? ' active' : ''}" href="${deletedView ? delBase('') : supBase(status, '')}">All</a>
    <a class="tab${prio === 'high' ? ' active' : ''}" href="${deletedView ? delBase('high') : supBase(status, 'high')}">High</a>
    <a class="tab${prio === 'medium' ? ' active' : ''}" href="${deletedView ? delBase('medium') : supBase(status, 'medium')}">Medium</a>
    <a class="tab${prio === 'low' ? ' active' : ''}" href="${deletedView ? delBase('low') : supBase(status, 'low')}">Low</a></div>` +
    (deletedView
      ? `<p class="muted">Soft-deleted tickets: hidden from all queues and counts, never erased — they stay here read-only as dispute evidence.</p>`
      : `<p class="muted">Deleting a ticket is a soft delete: it is hidden from queues and counts, not erased, and stays viewable read-only under the Deleted filter as dispute evidence.</p>`) +
    ui.table(['ID', 'Player', 'Subject', 'Priority', 'Status', 'Updated', ''], rows.map(t =>
      [`<span class="code">${esc(t.public_id)}</span>`, esc(t.email), esc(t.subject),
       (t.priority || 'medium') === 'high' ? ui.badge('high', 'err') : (t.priority || 'medium') === 'low' ? ui.badge('low', 'muted') : ui.badge('medium', 'info'),
       ui.statusBadge(t.status), d(t.updated_at),
       deletedView
         ? `<a class="btn btn-sm" href="${R(req, '/support/' + t.public_id)}?view=deleted">View</a><br><span class="muted">deleted ${d(t.deleted_at)} by ${esc(t.deleted_by_email || ('#' + t.deleted_by))}</span>`
         : `<a class="btn btn-sm" href="${R(req, '/support/' + t.public_id)}">Open</a> <form method="POST" action="${R(req, '/support/' + t.public_id + '/delete')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">Delete</button></form>`])) +
    ui.paginate(deletedView ? delBase(prio) : supBase(status, prio), page, PER, total);
  res.send(shell(req, '/support', 'Support Tickets', body, 'Player help requests and your replies.'));
});
/* BP-21 (v19): KYC review queue. Player-uploaded identity documents live
   in a private store (lib/upload) and are served ONLY through the
   protected document route below; every view/decision is audit-logged.
   The module ships dormant — see Settings → KYC (kyc_enabled, kyc_gate)
   and the per-user override on each user page. */
const KYC_DOC_LABELS = { national_id: 'National ID card', passport: 'Passport', driving_licence: 'Driving licence' };
router.get('/kyc', async (req, res) => {
  const pending = await req.db.query(`SELECT kd.*, u.name AS uname, u.email AS uemail FROM kyc_documents kd JOIN users u ON u.id = kd.user_id WHERE kd.status = 'pending' ORDER BY kd.created_at ASC LIMIT 100`);
  const decided = await req.db.query(`SELECT kd.*, u.name AS uname, u.email AS uemail FROM kyc_documents kd JOIN users u ON u.id = kd.user_id WHERE kd.status != 'pending' ORDER BY kd.reviewed_at DESC LIMIT 30`);
  const rowP = (doc) => ['#' + doc.id, `<a href="${R(req, '/users/' + doc.user_id)}">${esc(doc.uname)}</a><br><span class="muted">${esc(doc.uemail)}</span>`, esc(KYC_DOC_LABELS[doc.doc_type] || doc.doc_type), esc(doc.original_name), (doc.size_bytes / 1024).toFixed(1) + ' KB', d(doc.created_at), `<a class="btn btn-sm btn-p" href="${R(req, '/kyc/' + doc.id)}">Review</a>`];
  /* U-26 TWO DOORS (§5.4): the KYC master switch + gate scope also
     live here, on the review queue. Same /settings/kyc route and the
     same two keys the Settings card writes (that handler's complete
     key set). Editable only for super; other roles keep the plain
     note below the queue. */
  const kycDoorCard = !isSuperReq(req) ? '' : ui.card('KYC requirement — master switch',
    `<p class="muted">This is the same setting as Settings → KYC — one switch, two doors.</p>` +
    ui.formHtml(R(req, '/settings/kyc'), [
      { key: 'kyc_enabled', label: 'Enable KYC requirement for all users (master switch)', type: 'checkbox', value: getS(req.settings, 'kyc_enabled', '0') === '1', help: 'With the switch off, nobody is gated unless their per-user requirement is set to "required" on their user page. Users set to "exempt" are never gated.' },
      { key: 'kyc_gate', label: 'Gate scope', type: 'select', options: [{ v: 'withdrawals', l: 'Withdrawals only' }, { v: 'deposits_and_withdrawals', l: 'Deposits and withdrawals' }], value: getS(req.settings, 'kyc_gate', 'withdrawals'), help: 'Withdrawals only = KYC approval is required before withdrawals. Deposits and withdrawals = deposits are gated too.' },
    ], { csrf: req.csrfToken, submit: 'Save KYC settings' }));
  const body = `
  ${kycDoorCard}
  ${ui.card('KYC — pending review (' + pending.length + ')', pending.length ? ui.table(['#', 'Player', 'Document', 'File', 'Size', 'Submitted', ''], pending.map(rowP)) : '<p class="muted">No documents waiting for review.</p>')}
  ${ui.card('Recently decided', decided.length ? ui.table(['#', 'Player', 'Document', 'Status', 'Reviewed', ''], decided.map(doc => ['#' + doc.id, esc(doc.uname), esc(KYC_DOC_LABELS[doc.doc_type] || doc.doc_type), ui.statusBadge(doc.status === 'approved' ? 'verified' : doc.status), d(doc.reviewed_at), `<a class="btn btn-sm" href="${R(req, '/kyc/' + doc.id)}">Open</a>`])) : '<p class="muted">Nothing decided yet.</p>')}
  <p class="muted">KYC is a switchable module (Settings → KYC). It ships OFF; per-user requirements live on each user page (KYC requirement: default / required / exempt).</p>`;
  res.send(shell(req, '/kyc', 'KYC Review', body, 'Identity documents waiting for review.'));
});
router.get('/kyc/document/:id', async (req, res) => {
  const doc = await req.db.get('SELECT * FROM kyc_documents WHERE id = ?', [req.params.id]);
  if (!doc) return notFound(req, res, 'Document not found.');
  const data = uploadLib.readStored(doc.stored_name);
  if (!data) return notFound(req, res, 'Document file not found.');
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'kyc.document_view', entity: 'kyc_document', entityId: doc.id, detail: { user_id: doc.user_id }, ip: req.ip });
  res.set('Content-Type', doc.content_type || 'application/octet-stream');
  res.set('Content-Disposition', 'inline; filename="kyc-document"');
  res.set('Cache-Control', 'private, no-store');
  res.send(data);
});
router.get('/kyc/:id', async (req, res) => {
  const doc = await req.db.get('SELECT kd.*, u.name AS uname, u.email AS uemail, u.kyc_status AS user_kyc_status, u.kyc_override AS user_kyc_override FROM kyc_documents kd JOIN users u ON u.id = kd.user_id WHERE kd.id = ?', [req.params.id]);
  if (!doc) return notFound(req, res, 'KYC submission not found.');
  const isImg = doc.content_type === 'image/jpeg' || doc.content_type === 'image/png';
  const body = `
  <div class="grid2">
    <div>${ui.card('Submission #' + doc.id, ui.table(['Field', 'Value'], [
        ['Player', `<a href="${R(req, '/users/' + doc.user_id)}">${esc(doc.uname)}</a> — ${esc(doc.uemail)}`],
        ['Document type', esc(KYC_DOC_LABELS[doc.doc_type] || doc.doc_type)],
        ['File', esc(doc.original_name) + ' (' + (doc.size_bytes / 1024).toFixed(1) + ' KB)'],
        ['Submitted', d(doc.created_at)],
        ['Submission status', ui.statusBadge(doc.status === 'approved' ? 'verified' : doc.status)],
        ['Player KYC status', ui.statusBadge(doc.user_kyc_status)],
        ['Player override', esc(doc.user_kyc_override || 'default')],
        ...(doc.reviewed_at ? [['Reviewed', d(doc.reviewed_at) + (doc.review_note ? ' — reason: ' + esc(doc.review_note) : '')]] : []),
      ]))}
      ${doc.status === 'pending' ? ui.card('Decide', `
        <form method="POST" action="${R(req, '/kyc/' + doc.id + '/approve')}" class="adm-form">
          <input type="hidden" name="_csrf" value="${req.csrfToken}">
          <button class="btn btn-p" type="submit">Approve document</button>
        </form>
        <form method="POST" action="${R(req, '/kyc/' + doc.id + '/reject')}" class="adm-form mt">
          <input type="hidden" name="_csrf" value="${req.csrfToken}">
          <div class="field"><label for="kycRejectReason">Rejection reason (required — the player sees this)</label><textarea id="kycRejectReason" name="reason" required maxlength="500" placeholder="e.g. Photo is blurry — please retake it in good light"></textarea></div>
          <button class="btn btn-d" type="submit">Reject document</button>
        </form>`) : '<p class="muted">This submission has already been decided.</p>'}
    </div>
    <div>${ui.card('Document', isImg ? `<img src="${R(req, '/kyc/document/' + doc.id)}" alt="KYC document" style="max-width:100%;border-radius:8px">` : `<p><a class="btn btn-p" href="${R(req, '/kyc/document/' + doc.id)}" target="_blank" rel="noopener">Open document (PDF)</a></p>`)}</div>
  </div>`;
  res.send(shell(req, '/kyc', 'KYC submission #' + doc.id, body));
});
router.post('/kyc/:id/approve', async (req, res) => {
  const doc = await req.db.get('SELECT * FROM kyc_documents WHERE id = ?', [req.params.id]);
  if (!doc) return notFound(req, res, 'KYC submission not found.');
  if (doc.status !== 'pending') { await req.setFlash('error', 'This submission was already decided.'); return res.redirect(R(req, '/kyc/' + doc.id)); }
  /* SCAN fix (B-02): guarded transition — the UPDATE itself carries the
     pending precondition and the changes count decides who won, so two
     staff deciding concurrently cannot both "succeed". */
  const upd = await req.db.run("UPDATE kyc_documents SET status = 'approved', reviewed_by = ?, reviewed_at = ?, review_note = '' WHERE id = ? AND status = 'pending'", [req.user.id, now(), doc.id]);
  if (!upd.changes) { await req.setFlash('error', 'This submission was already decided.'); return res.redirect(R(req, '/kyc/' + doc.id)); }
  await req.db.run("UPDATE users SET kyc_status = 'verified', kyc_note = '' WHERE id = ?", [doc.user_id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'kyc.approve', entity: 'kyc_document', entityId: doc.id, detail: { user_id: doc.user_id, doc_type: doc.doc_type }, ip: req.ip });
  await req.setFlash('success', 'Document approved — the player is now KYC-verified.');
  res.redirect(R(req, '/kyc'));
});
router.post('/kyc/:id/reject', async (req, res) => {
  const doc = await req.db.get('SELECT * FROM kyc_documents WHERE id = ?', [req.params.id]);
  if (!doc) return notFound(req, res, 'KYC submission not found.');
  if (doc.status !== 'pending') { await req.setFlash('error', 'This submission was already decided.'); return res.redirect(R(req, '/kyc/' + doc.id)); }
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  if (!reason) { await req.setFlash('error', 'A rejection reason is required — the player sees it and resubmits. Nothing changed.'); return res.redirect(R(req, '/kyc/' + doc.id)); }
  const upd = await req.db.run("UPDATE kyc_documents SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'pending'", [req.user.id, now(), reason, doc.id]);
  if (!upd.changes) { await req.setFlash('error', 'This submission was already decided.'); return res.redirect(R(req, '/kyc/' + doc.id)); }
  /* A rejection must not strip a verification the player already earned
     from another approved document (decisions are per-document; status
     is per-user) — only an unverified user drops to 'rejected'. */
  await req.db.run("UPDATE users SET kyc_status = 'rejected', kyc_note = ? WHERE id = ? AND kyc_status != 'verified'", [reason, doc.user_id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'kyc.reject', entity: 'kyc_document', entityId: doc.id, detail: { user_id: doc.user_id, doc_type: doc.doc_type, reason }, ip: req.ip });
  await req.setFlash('success', 'Document rejected with reason — the player can see it and resubmit.');
  res.redirect(R(req, '/kyc'));
});

/* BP-15 (v19): canned replies for support staff. Stored like notification
   templates (one table, admin CRUD) and inserted into the reply box by a
   picker (public/app.js, data-canned-picker) — the picker only fills the
   textarea; a human still presses Send. Routes live under /support/* so
   the existing staff RBAC rule (POST /support/.+ -> super+support) covers
   the actions. Registered BEFORE /support/:publicId on purpose. */
async function listCanned(db) {
  return db.query('SELECT * FROM canned_replies ORDER BY title, id');
}
router.get('/support/canned-replies', async (req, res) => {
  const rows = await listCanned(req.db);
  const createForm = ui.card('New canned reply', ui.formHtml(R(req, '/support/canned-replies'), [
    { key: 'title', label: 'Title', required: true, hint: 'e.g. Deposit under review' },
    { key: 'body', label: 'Reply text', type: 'textarea', required: true },
  ], { csrf: req.csrfToken, submit: 'Create canned reply', grid: false }));
  const list = rows.length ? rows.map(c => ui.card(esc(c.title), `
    <p class="muted sm">Last updated ${d(c.updated_at)}</p>
    ${ui.formHtml(R(req, '/support/canned-replies/' + c.id), [
      { key: 'title', label: 'Title', required: true },
      { key: 'body', label: 'Reply text', type: 'textarea', required: true },
    ], { values: c, csrf: req.csrfToken, submit: 'Save changes', grid: false })}
    <form method="POST" action="${R(req, '/support/canned-replies/' + c.id + '/delete')}" style="margin-top:8px">
      <input type="hidden" name="_csrf" value="${req.csrfToken}">
      <button class="btn btn-sm btn-d" type="submit">Delete</button>
    </form>`)).join('') : ui.card('Canned replies', '<p class="muted">No canned replies yet. Create the first one above — it will appear in the reply picker on every support ticket.</p>');
  res.send(shell(req, '/support/canned-replies', 'Canned Replies', createForm + list, 'Saved reply templates for support.'));
});
router.post('/support/canned-replies', async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const text = String(req.body.body || '').trim().slice(0, 5000);
  if (!title || !text) { await req.setFlash('error', 'Title and reply text are required.'); return res.redirect(R(req, '/support/canned-replies')); }
  const t = now();
  const r = await req.db.run('INSERT INTO canned_replies (title, body, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [title, text, req.user.id, t, t]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'support.canned_create', entity: 'canned_reply', entityId: r.id, detail: { title }, ip: req.ip });
  await req.setFlash('success', 'Canned reply created.');
  res.redirect(R(req, '/support/canned-replies'));
});
router.post('/support/canned-replies/:id', async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 120);
  const text = String(req.body.body || '').trim().slice(0, 5000);
  if (!title || !text) { await req.setFlash('error', 'Title and reply text are required.'); return res.redirect(R(req, '/support/canned-replies')); }
  const r = await req.db.run('UPDATE canned_replies SET title = ?, body = ?, updated_at = ? WHERE id = ?', [title, text, now(), req.params.id]);
  if (r.changes !== 1) { await req.setFlash('error', 'Canned reply not found.'); return res.redirect(R(req, '/support/canned-replies')); }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'support.canned_update', entity: 'canned_reply', entityId: req.params.id, detail: { title }, ip: req.ip });
  await req.setFlash('success', 'Canned reply saved.');
  res.redirect(R(req, '/support/canned-replies'));
});
router.post('/support/canned-replies/:id/delete', async (req, res) => {
  const r = await req.db.run('DELETE FROM canned_replies WHERE id = ?', [req.params.id]);
  if (r.changes !== 1) { await req.setFlash('error', 'Canned reply not found.'); return res.redirect(R(req, '/support/canned-replies')); }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'support.canned_delete', entity: 'canned_reply', entityId: req.params.id, detail: {}, ip: req.ip });
  await req.setFlash('success', 'Canned reply deleted.');
  res.redirect(R(req, '/support/canned-replies'));
});
router.get('/support/:publicId', async (req, res) => {
  const t = await req.db.get('SELECT s.*, u.email, du.email AS deleted_by_email FROM support_tickets s JOIN users u ON u.id=s.user_id LEFT JOIN users du ON du.id = s.deleted_by WHERE s.public_id = ?', [req.params.publicId]);
  if (!t) return notFound(req, res, 'Ticket not found.');
  /* U-25: a soft-deleted ticket is invisible in the normal flow (same
     404 as a missing ticket) and reachable ONLY via ?view=deleted from
     the Deleted filter, rendered read-only — no reply, close, reopen or
     delete controls — as dispute evidence. */
  if (t.deleted_at && req.query.view !== 'deleted') return notFound(req, res, 'Ticket not found.');
  const msgs = await req.db.query('SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY created_at', [t.id]);
  if (t.deleted_at) {
    const body = ui.card('Ticket ' + t.public_id + ' — ' + t.subject, `
    <p class="muted">From: ${esc(t.email)} · Status: ${ui.statusBadge(t.status)}</p>
    <p class="msg staff">This ticket was soft-deleted on ${d(t.deleted_at)} by ${esc(t.deleted_by_email || ('user #' + t.deleted_by))}. It is read-only: hidden from queues, retained as dispute evidence, and it cannot be replied to, closed, reopened or deleted again.</p>
    <div class="msgs">${msgs.map(m => `<div class="msg${m.author_role !== 'player' ? ' staff' : ''}"><div class="msg-h">${esc(m.author_role)} · ${d(m.created_at)}</div><div>${esc(m.body)}</div></div>`).join('')}</div>`);
    return res.send(shell(req, '/support', 'Support', body));
  }
  const canned = t.status !== 'closed' ? await listCanned(req.db) : [];
  const picker = canned.length ? `<div class="field"><label>Insert a canned reply</label><select data-canned-picker data-source="cannedData"><option value="">Choose a canned reply…</option>${canned.map(c => `<option value="${c.id}">${esc(c.title)}</option>`).join('')}</select></div><script type="application/json" id="cannedData">${JSON.stringify(canned.map(c => ({ id: c.id, body: c.body }))).replace(/</g, '\\u003c')}</script>` : '';
  const body = ui.card('Ticket ' + t.public_id + ' — ' + t.subject, `
    <p class="muted">From: ${esc(t.email)} · Status: ${ui.statusBadge(t.status)}</p>
    <div class="msgs">${msgs.map(m => `<div class="msg${m.author_role !== 'player' ? ' staff' : ''}"><div class="msg-h">${esc(m.author_role)} · ${d(m.created_at)}</div><div>${esc(m.body)}</div></div>`).join('')}</div>
    ${t.status !== 'closed' ? ui.formHtml(R(req, '/support/' + t.public_id + '/reply'), [{ key: 'message', label: 'Reply', type: 'textarea' }], { csrf: req.csrfToken, submit: 'Send reply', grid: false, extra: picker }) : '<p class="muted">Ticket closed.</p>'}
    <div class="btn-row mt">
      ${t.status !== 'closed' ? `<form method="POST" action="${R(req, '/support/' + t.public_id + '/close')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">Close ticket</button></form>` : `<form method="POST" action="${R(req, '/support/' + t.public_id + '/reopen')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">Reopen</button></form>`}
      <form method="POST" action="${R(req, '/support/' + t.public_id + '/delete')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">Delete ticket</button></form>
    </div>
    <p class="muted">Deleting is a soft delete: the ticket is hidden from queues, not erased, and stays viewable read-only under the Deleted filter as dispute evidence.</p>`);
  res.send(shell(req, '/support', 'Support', body));
});
router.post('/support/:publicId/reply', async (req, res) => {
  const t = await req.db.get('SELECT * FROM support_tickets WHERE public_id = ?', [req.params.publicId]);
  if (!t) return notFound(req, res, 'Ticket not found.');
  /* U-25: a reply must never resurrect a soft-deleted ticket. */
  if (t.deleted_at) { await req.setFlash('error', 'This ticket has been deleted and can no longer be replied to.'); return res.redirect(R(req, '/support')); }
  if (t.status === 'closed') { await req.setFlash('error', 'Ticket is closed. Reopen it before replying.'); return res.redirect(R(req, '/support/' + t.public_id)); }
  const body = String(req.body.message || '').trim().slice(0, 5000);
  if (!body) return res.redirect(R(req, '/support/' + t.public_id));
  const { normalizeRole: nrS } = require('../lib/rbac');
  const staffRole = nrS(req.user) === 'super' ? 'admin' : nrS(req.user);
  await req.db.run('INSERT INTO support_messages (ticket_id, author_id, author_role, body, created_at) VALUES (?, ?, ?, ?, ?)', [t.id, req.user.id, staffRole, body, now()]);
  await req.db.run("UPDATE support_tickets SET status='answered', updated_at=? WHERE id=?", [now(), t.id]);
  const u = await req.db.get('SELECT email, name FROM users WHERE id = ?', [t.user_id]);
  // BP-13: support-reply email respects the player's preference.
  if (await notify.emailPrefEnabled(req.db, t.user_id, 'support_reply'))
    notify.send(req.db, req.settings, 'email', 'support_reply', u.email, { name: u.name, subject: t.subject }).catch(() => {});
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'support.reply', entity: 'support', entityId: t.public_id, detail: {}, ip: req.ip });
  res.redirect(R(req, '/support/' + t.public_id));
});
router.post('/support/:publicId/close', async (req, res) => {
  // R-103: the old close/reopen flashed nothing and "succeeded" for a
  // missing ticket or an already-closed one. The status guard makes the
  // affected-row check meaningful on every driver.
  const r = await req.db.run("UPDATE support_tickets SET status='closed', updated_at=? WHERE public_id=? AND status != 'closed' AND deleted_at IS NULL", [now(), req.params.publicId]);
  if (r.changes !== 1) { await req.setFlash('error', 'Ticket not found, already closed, or deleted.'); return res.redirect(R(req, '/support/' + req.params.publicId)); }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'support.close', entity: 'support', entityId: req.params.publicId, detail: {}, ip: req.ip });
  res.redirect(R(req, '/support/' + req.params.publicId));
});
router.post('/support/:publicId/reopen', async (req, res) => {
  const r = await req.db.run("UPDATE support_tickets SET status='open', updated_at=? WHERE public_id=? AND status != 'open' AND deleted_at IS NULL", [now(), req.params.publicId]);
  if (r.changes !== 1) { await req.setFlash('error', 'Ticket not found, already open, or deleted.'); return res.redirect(R(req, '/support/' + req.params.publicId)); }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'support.reopen', entity: 'support', entityId: req.params.publicId, detail: {}, ip: req.ip });
  res.redirect(R(req, '/support/' + req.params.publicId));
});
/* U-25: staff soft delete. Sets deleted_at/deleted_by (migration v19);
   the row is NEVER hard-deleted — it leaves every queue and count and
   stays viewable read-only under the Deleted filter as dispute
   evidence. Executes on click (no confirmation, per the admin rule)
   and sends NO notification email. Already-deleted or missing tickets
   fail with a true-reason message. */
router.post('/support/:publicId/delete', async (req, res) => {
  const t = await req.db.get('SELECT * FROM support_tickets WHERE public_id = ?', [req.params.publicId]);
  if (!t || t.deleted_at) { await req.setFlash('error', 'Ticket not found or already deleted.'); return res.redirect(R(req, '/support')); }
  const r = await req.db.run('UPDATE support_tickets SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL', [now(), req.user.id, now(), t.id]);
  if (r.changes !== 1) { await req.setFlash('error', 'Ticket not found or already deleted.'); return res.redirect(R(req, '/support')); }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'support.delete', entity: 'support', entityId: t.public_id, detail: { ticket_id: t.id, status_at_delete: t.status }, ip: req.ip });
  await req.setFlash('success', 'Ticket deleted. It is hidden from queues and stays viewable read-only under the Deleted filter.');
  res.redirect(R(req, '/support'));
});

/* ============================================================ EXTENSIONS */
router.get('/extensions', async (req, res) => {
  const exts = await getExtensions(req.db);
  const cards = Object.values(exts).map(e => {
    const fields = (EXTENSION_FIELDS[e.key] || []).map(f => `${f.label}: ${e.config[f.key] ? (f.type === 'password' ? '••••••' : esc(String(e.config[f.key]).slice(0, 60))) : '<span class="muted">not set</span>'}`).join('<br>');
    return `<div class="card"><div class="card-h"><h3>${esc(e.name)}</h3><div>${e.enabled ? ui.badge('enabled', 'ok') : ui.badge('disabled', 'muted')}</div></div>
      <div class="card-b">${fields || '<span class="muted">No settings.</span>'}
      <div class="btn-row mt">
        <a class="btn btn-sm" href="${R(req, '/extensions/' + e.key)}">Configure</a>
        <form method="POST" action="${R(req, '/extensions/' + e.key + '/toggle')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}">
          <button class="btn btn-sm">${e.enabled ? 'Disable' : 'Enable'}</button></form>
      </div></div></div>`;
  }).join('');
  res.send(shell(req, '/extensions', 'Extensions', `<div class="grid2">${cards}</div>
    <p class="muted">Every integration has an on/off switch. With an extension OFF or unconfigured, the site works fully — the feature is simply skipped.</p>`, 'Optional add-on modules and their on/off switches.'));
});
router.get('/extensions/:key', async (req, res) => {
  const e = (await getExtensions(req.db))[req.params.key];
  if (!e) return notFound(req, res, 'Extension not found.');
  const fields = (EXTENSION_FIELDS[e.key] || []).map(f =>
    f.type === 'select' ? { key: f.key, label: f.label, type: 'select', options: f.options, value: e.config[f.key] || '' }
    : f.type === 'textarea' ? { key: f.key, label: f.label, type: 'textarea', value: e.config[f.key] || '' }
    : { key: f.key, label: f.label, type: f.type === 'password' ? 'password' : 'text', value: f.type === 'password' ? '' : (e.config[f.key] || ''), help: f.type === 'password' ? 'Leave blank to keep saved value.' : '' });
  const body = ui.card('Configure — ' + e.name, ui.formHtml(R(req, '/extensions/' + e.key),
    [...fields, { key: 'enabled', label: 'Enabled', type: 'checkbox', value: e.enabled }],
    { csrf: req.csrfToken, submit: 'Save' }));
  res.send(shell(req, '/extensions', 'Extension — ' + e.name, body));
});
router.post('/extensions/:key', async (req, res) => {
  const exts = await getExtensions(req.db);
  const e = exts[req.params.key];
  if (!e) return notFound(req, res, 'Extension not found.');
  const config = {};
  for (const f of (EXTENSION_FIELDS[e.key] || [])) {
    const v = String(req.body[f.key] || '');
    if (f.type === 'password' && !v) continue;
    if (f.required && !v) { await req.setFlash('error', `"${f.label}" is required.`); return res.redirect(R(req, '/extensions/' + e.key)); }
    config[f.key] = v;
  }
  const oldEnabled = e.enabled;
  await setExtension(req.db, e.key, { enabled: !!req.body.enabled, config }, req.driver);
  // mirror well-known keys into env-backed settings where the frontend reads them
  if (e.key === 'recaptcha' && config.site_key) { process.env.RECAPTCHA_SITE_KEY = config.site_key; }
  // R-104: audit WHICH config keys changed, never their values (secrets).
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'extension.update', entity: 'extension', entityId: e.key, detail: { old_enabled: oldEnabled, new_enabled: !!req.body.enabled, config_keys: Object.keys(config) }, ip: req.ip });
  await req.setFlash('success', 'Extension saved.');
  res.redirect(R(req, '/extensions'));
});
router.post('/extensions/:key/toggle', async (req, res) => {
  const e = (await getExtensions(req.db))[req.params.key];
  if (!e) return notFound(req, res, 'Extension not found.');
  await setExtension(req.db, e.key, { enabled: !e.enabled }, req.driver);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'extension.toggle', entity: 'extension', entityId: e.key, detail: { enabled: !e.enabled }, ip: req.ip });
  res.redirect(R(req, '/extensions'));
});

/* ============================================================ NOTIFICATIONS */
router.get('/notifications', async (req, res) => {
  const tab = req.query.tab || 'templates';
  const tabs = [['templates', 'Templates'], ['outbox', 'Outbox'], ['providers', 'Providers'], ['send', 'Send Notification'], ['announcements', 'Announcements']]
    .map(([k, l]) => `<a class="tab${tab === k ? ' active' : ''}" href="${R(req, '/notifications')}?tab=${k}">${l}</a>`).join('');
  let body = `<div class="tabs">${tabs}</div>`;
  if (tab === 'templates') {
    const rows = await req.db.query('SELECT * FROM notif_templates ORDER BY channel, slug');
    body += ui.table(['Channel', 'Slug', 'Subject', 'Status', ''], rows.map(t =>
      [ui.badge(t.channel, 'info'), `<span class="code">${esc(t.slug)}</span>`, esc(t.subject || '—'),
       t.enabled ? ui.badge('enabled', 'ok') : ui.badge('disabled', 'muted'),
       `<a class="btn btn-sm" href="${R(req, '/notifications/' + t.id)}">Edit</a>`]));
  } else if (tab === 'send') {
    const players = await req.db.query("SELECT id, email, name FROM users WHERE role = 'player' AND status = 'active' ORDER BY email LIMIT 500");
    body += ui.card('Send notification to players',
      `<form method="POST" action="${R(req, '/notifications/send')}" class="adm-form"><input type="hidden" name="_csrf" value="${req.csrfToken}">
      <div class="field"><label>Recipient</label><select name="to">
        <option value="all">All active players</option>
        <option value="seg:with_balance">With balance</option>
        <option value="seg:empty_balance">Empty balance</option>
        <option value="seg:deposited">Have deposited</option>
        <option value="seg:not_deposited">Never deposited</option>
        <option value="seg:pending_deposit">Pending deposit</option>
        <option value="seg:pending_withdrawal">Pending withdrawal</option>
        <option value="seg:top_depositors">Top 10 depositors</option>
        <option value="seg:inactive_7d">Inactive 7+ days (no login)</option>
        ${players.map(u => `<option value="${u.id}">${esc(u.email)} (${esc(u.name)})</option>`).join('')}
      </select></div>
      <div class="field"><label>Subject</label><input type="text" name="subject" required maxlength="150"></div>
      <div class="field"><label>Message</label><textarea name="message" rows="5" required></textarea></div>
      <div class="field"><label>Start from # (1 = first recipient in the audience list)</label><input type="number" name="start_from" value="1" min="1"></div>
      <div class="field"><label>Per batch (0 = send all at once)</label><input type="number" name="per_batch" value="0" min="0"></div>
      <div class="field"><label>Cooling period between batches (seconds, 0 = no batching)</label><input type="number" name="cooling" value="0" min="0"></div>
      <div class="mt"><button class="btn btn-p" type="submit">Send</button></div></form>
      <p class="muted">Batching: the first batch sends now; later batches are queued with cooling-period spacing and sent by the "Notification batches" cron job (every 5 minutes) or the "Process due now" button in the Outbox. Sends an email via the configured SMTP provider (or logs to the outbox when no provider is configured — nothing breaks).</p>`);
  } else if (tab === 'outbox') {
    const oq = (req.query.oq || '').trim(), ofrom = req.query.ofrom || '', oto = req.query.oto || '';
    const ow = [], op = [];
    if (oq) { ow.push('(LOWER(to_addr) LIKE LOWER(?) OR LOWER(subject) LIKE LOWER(?))'); op.push('%' + oq + '%', '%' + oq + '%'); }
    if (ofrom) { ow.push('created_at >= ?'); op.push(new Date(ofrom + 'T00:00:00Z').getTime()); }
    if (oto) { ow.push('created_at <= ?'); op.push(new Date(oto + 'T23:59:59Z').getTime()); }
    const owq = ow.length ? 'WHERE ' + ow.join(' AND ') : '';
    const opage = pageOf(req);
    const ototal = (await req.db.get(`SELECT COUNT(*) AS c FROM notifications_log ${owq}`, op)).c;
    const rows = await req.db.query(`SELECT * FROM notifications_log ${owq} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...op, PER, (opage - 1) * PER]);
    body += `<form method="GET" class="filters"><input type="hidden" name="tab" value="outbox">
      <input type="text" name="oq" value="${esc(oq)}" placeholder="Search email / subject">
      <input type="date" name="ofrom" value="${esc(ofrom)}"><input type="date" name="oto" value="${esc(oto)}">
      <button class="btn btn-sm" type="submit">Filter</button></form>
    <form method="POST" action="${R(req, '/notifications/process-due')}" style="margin-bottom:16px"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm" type="submit">Process due now (send queued batches whose cooling period elapsed)</button></form>` +
    ui.table(['When', 'Channel', 'To', 'Subject', 'Status', 'Error', ''], rows.map(l =>
      [d(l.created_at), esc(l.channel), esc(l.to_addr), esc(l.subject),
       ui.statusBadge(l.status) + (l.status === 'queued' && l.scheduled_at ? `<br><span class="muted">batch ${l.batch_no || '—'} · due ${d(l.scheduled_at)}</span>` : ''),
       esc(l.error || '—'),
       `<a class="btn btn-sm" href="${R(req, '/notifications/log/' + l.id)}">Detail</a>`])) +
    ui.paginate(`${R(req, '/notifications')}?tab=outbox${oq ? '&oq=' + encodeURIComponent(oq) : ''}${ofrom ? '&ofrom=' + ofrom : ''}${oto ? '&oto=' + oto : ''}`, opage, PER, ototal);
  } else if (tab === 'announcements') {
    // DS-028: announcements CRUD (players read them at /announcements).
    const anns = await req.db.query('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 100');
    body += ui.card('New announcement', ui.formHtml(R(req, '/notifications/announcements'), [
      { key: 'title', label: 'Title', type: 'text', required: true },
      { key: 'body', label: 'Message', type: 'textarea', required: true },
      { key: 'is_active', label: 'Published immediately', type: 'checkbox', value: true },
    ], { csrf: req.csrfToken, submit: 'Publish announcement', grid: false })) +
    ui.table(['When', 'Title', 'Status', ''], anns.map(x => [
      d(x.created_at), esc(x.title), x.active ? ui.badge('published', 'ok') : ui.badge('hidden', 'muted'),
      `<form method="POST" action="${R(req, '/notifications/announcements/' + x.id + '/toggle')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">${x.active ? 'Hide' : 'Publish'}</button></form>
       <form method="POST" action="${R(req, '/notifications/announcements/' + x.id + '/delete')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm btn-d">Delete</button></form>`,
    ]));
  } else {
    const smtp = !!process.env.SMTP_HOST, sms = !!(process.env.TWILIO_SID && process.env.TWILIO_TOKEN);
    body += ui.card('Email (SMTP)', `<p>${smtp ? ui.badge('configured', 'ok') + ' Host: ' + esc(process.env.SMTP_HOST) : ui.badge('not configured', 'warn') + ' — set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/SMTP_FROM in .env (see README).'}</p>`) +
      ui.card('SMS (Twilio)', `<p>${sms ? ui.badge('configured', 'ok') : ui.badge('not configured', 'warn') + ' — set TWILIO_SID/TWILIO_TOKEN/TWILIO_FROM in .env.'}</p>`) +
      ui.card('Push', `<p>${ui.badge('not configured', 'warn')} — push notifications are not set up yet.</p>`) +
      `<p class="muted">When a provider is not configured, notifications are logged to the outbox and the site keeps working — nothing breaks.</p>`;
  }
  res.send(shell(req, '/notifications', 'Notifications', body, 'Every email, SMS and in-app message the system sent.'));
});
router.get('/notifications/log/:id', async (req, res) => {
  const l = await req.db.get('SELECT * FROM notifications_log WHERE id = ?', [req.params.id]);
  if (!l) return notFound(req, res, 'Log entry not found.');
  const body = ui.card('Notification detail', `<p><strong>When:</strong> ${d(l.created_at)} · <strong>Channel:</strong> ${esc(l.channel)} · <strong>To:</strong> ${esc(l.to_addr)} · <strong>Status:</strong> ${ui.statusBadge(l.status)}</p>
    <p><strong>Subject:</strong> ${esc(l.subject)}</p>
    <div class="instruction"><p class="muted pre">${esc(l.body || '(no body stored)')}</p></div>
    ${l.error ? `<p><strong>Error:</strong> ${esc(l.error)}</p>` : ''}`);
  res.send(shell(req, '/notifications', 'Notification Detail', body));
});
router.post('/notifications/send', async (req, res) => {
  const notify = require('../lib/notify');
  // R-063: the old send trusted the form completely — unbounded audience,
  // untrimmed/unbounded subject/message, and an unknown `to` silently sent
  // to NOBODY while flashing success. All three are now validated.
  const subject = String(req.body.subject || '').trim();
  const message = String(req.body.message || '').trim();
  if (!subject || subject.length > 150) { await req.setFlash('error', 'Subject is required (max 150 characters).'); return res.redirect(R(req, '/notifications?tab=send')); }
  if (!message || message.length > 10000) { await req.setFlash('error', 'Message is required (max 10,000 characters).'); return res.redirect(R(req, '/notifications?tab=send')); }
  const KNOWN_TO = ['all', 'seg:with_balance', 'seg:empty_balance', 'seg:deposited', 'seg:not_deposited', 'seg:pending_deposit', 'seg:pending_withdrawal', 'seg:top_depositors', 'seg:inactive_7d'];
  const toRaw = String(req.body.to || '');
  if (!KNOWN_TO.includes(toRaw) && !/^\d+$/.test(toRaw)) { await req.setFlash('error', 'Unknown recipient selection.'); return res.redirect(R(req, '/notifications?tab=send')); }
  let targets;
  if (req.body.to === 'all') targets = await req.db.query("SELECT id, email, name FROM users WHERE role = 'player' AND status = 'active' ORDER BY id");
  else if (req.body.to === 'seg:with_balance') targets = await req.db.query("SELECT u.id, u.email, u.name FROM users u WHERE u.role = 'player' AND u.status = 'active' AND EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = u.id AND w.balance > 0) ORDER BY u.id");
  else if (req.body.to === 'seg:empty_balance') targets = await req.db.query("SELECT u.id, u.email, u.name FROM users u WHERE u.role = 'player' AND u.status = 'active' AND NOT EXISTS (SELECT 1 FROM wallets w WHERE w.user_id = u.id AND w.balance > 0) ORDER BY u.id");
  else if (req.body.to === 'seg:deposited') targets = await req.db.query("SELECT DISTINCT u.id, u.email, u.name FROM users u JOIN deposits dd ON dd.user_id = u.id AND dd.status = 'approved' WHERE u.role = 'player' AND u.status = 'active' ORDER BY u.id");
  else if (req.body.to === 'seg:not_deposited') targets = await req.db.query("SELECT u.id, u.email, u.name FROM users u WHERE u.role = 'player' AND u.status = 'active' AND NOT EXISTS (SELECT 1 FROM deposits dd WHERE dd.user_id = u.id AND dd.status = 'approved') ORDER BY u.id");
  else if (req.body.to === 'seg:pending_deposit') targets = await req.db.query("SELECT DISTINCT u.id, u.email, u.name FROM users u JOIN deposits dd ON dd.user_id = u.id AND dd.status = 'pending' WHERE u.role = 'player' AND u.status = 'active' ORDER BY u.id");
  else if (req.body.to === 'seg:pending_withdrawal') targets = await req.db.query("SELECT DISTINCT u.id, u.email, u.name FROM users u JOIN withdrawals ww ON ww.user_id = u.id AND ww.status = 'pending' WHERE u.role = 'player' AND u.status = 'active' ORDER BY u.id");
  else if (req.body.to === 'seg:top_depositors') targets = await req.db.query("SELECT u.id, u.email, u.name FROM users u JOIN deposits dd ON dd.user_id = u.id AND dd.status = 'approved' WHERE u.role = 'player' AND u.status = 'active' GROUP BY u.id ORDER BY SUM(dd.net) DESC LIMIT 10");
  else if (req.body.to === 'seg:inactive_7d') targets = await req.db.query("SELECT id, email, name FROM users WHERE role = 'player' AND status = 'active' AND (last_login_at IS NULL OR last_login_at < ?) ORDER BY id", [now() - 7 * 86400000]);
  else {
    const u = await req.db.get('SELECT id, email, name FROM users WHERE id = ?', [req.body.to]);
    if (!u) { await req.setFlash('error', 'Recipient user not found.'); return res.redirect(R(req, '/notifications?tab=send')); }
    targets = [u];
  }
  // Batching: start_from is a 1-based index into the audience list; per_batch
  // splits the remainder into batches; batch 1 sends now, later batches are
  // queued with cooling-period spacing (sent by cron or "Process due now").
  const startFrom = Math.max(1, parseInt(req.body.start_from, 10) || 1);
  let perBatch = Math.max(0, parseInt(req.body.per_batch, 10) || 0);
  let cooling = Math.max(0, parseInt(req.body.cooling, 10) || 0);
  const sliced = targets.slice(startFrom - 1);
  if (!sliced.length) { await req.setFlash('error', 'No recipients in the selected audience (check Start from #).'); return res.redirect(R(req, '/notifications?tab=send')); }
  // R-063: hard cap per send + auto-batch large sends. A 10k-player
  // synchronous send used to hold the request (and the admin) open until
  // every SMTP attempt finished. Above 500 recipients the operator must
  // segment; above 100 without batching, the send auto-batches (100/batch,
  // 60s cooling) so the request returns after batch 1.
  if (sliced.length > 500) { await req.setFlash('error', `Too many recipients (${sliced.length}; max 500 per send). Narrow the audience with a segment or Start from #.`); return res.redirect(R(req, '/notifications?tab=send')); }
  let autoBatched = false;
  if (sliced.length > 100 && (!perBatch || cooling <= 0)) { perBatch = 100; cooling = 60; autoBatched = true; }
  let sent = 0, failed = 0, queued = 0;
  if (!perBatch || cooling <= 0 || sliced.length <= perBatch) {
    for (const t of sliced) {
      const r = await notify.sendRaw(req.db, req.settings, 'email', t.email, subject, message);
      if (r.status === 'sent') sent++; else failed++;
    }
  } else {
    const batches = [];
    for (let i = 0; i < sliced.length; i += perBatch) batches.push(sliced.slice(i, i + perBatch));
    for (let bi = 0; bi < batches.length; bi++) {
      if (bi === 0) {
        for (const t of batches[bi]) {
          const r = await notify.sendRaw(req.db, req.settings, 'email', t.email, subject, message);
          if (r.status === 'sent') sent++; else failed++;
        }
      } else {
        const at = now() + cooling * 1000 * bi;
        for (const t of batches[bi]) {
          /* D3-C5 (v20): queued batches bypassed the v20 outbox
             masking — the raw subject/message (incl. any secret link)
             was INSERTed verbatim while batch 1 went through
             sendRaw/maskForLog. Same masking here, before INSERT. */
          await req.db.run("INSERT INTO notifications_log (channel, to_addr, subject, body, status, error, created_at, batch_no, scheduled_at) VALUES ('email', ?, ?, ?, 'queued', '', ?, ?, ?)", [t.email, notify.maskForLog(subject), notify.maskForLog(message), now(), bi + 1, at]);
          queued++;
        }
      }
    }
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'notify.send', entity: 'notification', entityId: '', detail: { to: req.body.to, sent, failed, queued, startFrom, perBatch, cooling, subject }, ip: req.ip });
  await req.setFlash('success', `Notification processed for ${sliced.length} player(s): ${sent} sent, ${failed} failed, ${queued} queued in later batches (see Outbox for reasons).` + (autoBatched ? ' Large send auto-batched (100 per batch, 60s cooling).' : ''));
  res.redirect(R(req, '/notifications?tab=outbox'));
});
router.post('/notifications/announcements', async (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 255);
  const bodyText = String(req.body.body || '').trim().slice(0, 5000);
  if (!title || !bodyText) { await req.setFlash('error', 'Title and message are required.'); return res.redirect(R(req, '/notifications') + '?tab=announcements'); }
  await req.db.run('INSERT INTO announcements (title, body, active, created_by, created_at) VALUES (?, ?, ?, ?, ?)', [title, bodyText, req.body.is_active ? 1 : 0, req.user.id, now()]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'announcement.create', entity: 'announcement', entityId: '', detail: { title }, ip: req.ip });
  await req.setFlash('success', 'Announcement saved.');
  res.redirect(R(req, '/notifications') + '?tab=announcements');
});
router.post('/notifications/announcements/:id/toggle', async (req, res) => {
  const r = await req.db.run('UPDATE announcements SET active = 1 - active WHERE id = ?', [req.params.id]);
  if (r.changes !== 1) await req.setFlash('error', 'Announcement not found.');
  else {
    /* SCAN fix (C-05): create/delete were audited, the visibility
       toggle was not — now it is. */
    const ann = await req.db.get('SELECT active, title FROM announcements WHERE id = ?', [req.params.id]);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'announcement.toggle', entity: 'announcement', entityId: String(req.params.id), detail: { title: ann ? ann.title : '', active: ann ? ann.active : null }, ip: req.ip });
    await req.setFlash('success', 'Announcement updated.');
  }
  res.redirect(R(req, '/notifications') + '?tab=announcements');
});
router.post('/notifications/announcements/:id/delete', async (req, res) => {
  await req.db.run('DELETE FROM announcements WHERE id = ?', [req.params.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'announcement.delete', entity: 'announcement', entityId: String(req.params.id), detail: {}, ip: req.ip });
  await req.setFlash('success', 'Announcement deleted.');
  res.redirect(R(req, '/notifications') + '?tab=announcements');
});
/* DS-029: contact-form inbox (public /contact writes contact_messages). */
router.get('/contact-messages', async (req, res) => {
  const rows = await req.db.query('SELECT * FROM contact_messages ORDER BY handled ASC, created_at DESC LIMIT 200');
  const body = ui.card('Contact messages', ui.table(['When', 'From', 'Subject', 'Message', 'Status', ''],
    rows.map(x => [d(x.created_at), esc(x.name) + ' &lt;' + esc(x.email) + '&gt;', esc(x.subject || '—'), esc(String(x.message || '').slice(0, 140)),
      x.handled ? ui.badge('handled', 'ok') : ui.badge('new', 'warn'),
      `<form method="POST" action="${R(req, '/contact-messages/' + x.id + '/handled')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">${x.handled ? 'Reopen' : 'Mark handled'}</button></form>`])));
  res.send(shell(req, '/contact-messages', 'Contact Messages', body, 'Messages sent from the public contact form.'));
});
router.post('/contact-messages/:id/handled', async (req, res) => {
  const r = await req.db.run('UPDATE contact_messages SET handled = 1 - handled WHERE id = ?', [req.params.id]);
  if (r.changes !== 1) await req.setFlash('error', 'Message not found.');
  else await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'contact.handled_toggle', entity: 'contact_message', entityId: String(req.params.id), detail: {}, ip: req.ip });
  res.redirect(R(req, '/contact-messages'));
});
router.post('/notifications/process-due', async (req, res) => {
  const notify = require('../lib/notify');
  // R-109: the old flash reported the LIMIT-200 slice as the due total.
  // Count the full backlog honestly; only 200 process per run.
  const dueTotal = (await req.db.get("SELECT COUNT(*) AS c FROM notifications_log WHERE status = 'queued' AND scheduled_at > 0 AND scheduled_at <= ?", [now()])).c;
  const due = await req.db.query("SELECT * FROM notifications_log WHERE status = 'queued' AND scheduled_at > 0 AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 200", [now()]);
  let sent = 0, failed = 0, deferred = 0, retrying = 0;
  for (const row of due) {
    const r = await notify.sendQueued(req.db, req.settings, row);
    if (r.status === 'sent') sent++;
    else if (r.status === 'deferred') deferred++;
    else if (r.status === 'queued') retrying++;
    else failed++;
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'notify.process_due', entity: 'notification', entityId: '', detail: { due: dueTotal, processed: due.length, sent, failed, retrying, deferred }, ip: req.ip });
  await req.setFlash('success', `Due batches processed: ${sent} sent, ${failed} failed, ${retrying} scheduled for retry, ${deferred} deferred (notifications off) (${dueTotal} due total, ${due.length} processed this run).`);
  res.redirect(R(req, '/notifications?tab=outbox'));
});
router.get('/notifications/:id', async (req, res) => {
  const t = await req.db.get('SELECT * FROM notif_templates WHERE id = ?', [req.params.id]);
  if (!t) return notFound(req, res, 'Template not found.');
  const body = ui.card(`Template — ${t.channel}/${t.slug}`,
    `<p class="muted">Available variables: {{site}} {{name}} {{amount}} {{ticket}} {{code}} {{minutes}} {{status}} {{link}} {{subject}}</p>` +
    ui.formHtml(R(req, '/notifications/' + t.id), [
      { key: 'subject', label: 'Subject (email/push)', type: 'text', value: t.subject },
      { key: 'body', label: 'Body', type: 'textarea', value: t.body },
      { key: 'enabled', label: 'Enabled', type: 'checkbox', value: t.enabled },
    ], { csrf: req.csrfToken, submit: 'Save template', grid: false }));
  res.send(shell(req, '/notifications', 'Edit Template', body));
});
router.post('/notifications/:id', async (req, res) => {
  const old = await req.db.get('SELECT * FROM notif_templates WHERE id = ?', [req.params.id]);
  if (!old) return notFound(req, res, 'Template not found.');
  const ns = String(req.body.subject || '').slice(0, 255), nb = String(req.body.body || ''), ne = req.body.enabled ? 1 : 0;
  await req.db.run('UPDATE notif_templates SET subject = ?, body = ?, enabled = ? WHERE id = ?',
    [ns, nb, ne, req.params.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'notif.template_update', entity: 'template', entityId: req.params.id, detail: { old: { subject: old.subject, body: String(old.body || '').slice(0, 200), enabled: old.enabled }, new: { subject: ns, body: nb.slice(0, 200), enabled: ne } }, ip: req.ip });
  await req.setFlash('success', 'Template saved.');
  res.redirect(R(req, '/notifications/' + req.params.id));
});

/* ============================================================ PAGES & CONTENT */
router.get('/pages', async (req, res) => {
  const tab = req.query.tab || 'pages';
  const tabs = [['pages', 'Manage Pages'], ['content', 'Frontend Content']]
    .map(([k, l]) => `<a class="tab${tab === k ? ' active' : ''}" href="${R(req, '/pages')}?tab=${k}">${l}</a>`).join('');
  let body = `<div class="tabs">${tabs}</div>`;
  if (tab === 'pages') {
    const rows = await req.db.query('SELECT * FROM pages ORDER BY sort, name');
    body += `<div class="btn-row" style="margin-bottom:16px"><a class="btn btn-p" href="${R(req, '/pages/new')}">+ New page</a></div>` +
      ui.table(['Name', 'Slug', 'Title', 'SEO title', 'Status', ''], rows.map(p =>
        [esc(p.name), `<span class="code">/page/${esc(p.slug)}</span>`, esc(p.title), esc(p.meta_title || '—'), ui.statusBadge(p.status),
         `<a class="btn btn-sm" href="${R(req, '/pages/' + p.id)}">Edit</a>`]));
  } else {
    const rows = await req.db.query(`SELECT * FROM content_blocks ORDER BY ${keyCol(req.driver)}`);
    body += ui.table(['Key', 'Title', 'Updated', ''], rows.map(b =>
      [`<span class="code">${esc(b.key)}</span>`, esc(b.title), d(b.updated_at), `<a class="btn btn-sm" href="${R(req, '/content/' + encodeURIComponent(b.key))}">Edit</a>`]));
  }
  res.send(shell(req, '/pages', 'Pages & Content', body, 'Site pages and editable content blocks.'));
});
const PAGE_FIELDS = (p = {}) => [
  { key: 'name', label: 'Name', type: 'text', value: p.name, required: true },
  { key: 'slug', label: 'Slug', type: 'text', value: p.slug, required: true, help: 'URL: /page/<slug> — lowercase letters, numbers, dashes.' },
  { key: 'title', label: 'Title', type: 'text', value: p.title, required: true },
  { key: 'meta_title', label: 'SEO meta title', type: 'text', value: p.meta_title },
  { key: 'meta_desc', label: 'SEO meta description', type: 'textarea', value: p.meta_desc },
  { key: 'body', label: 'Body (HTML). Use {{content:key}} to embed a content block.', type: 'textarea', value: p.body },
  { key: 'status', label: 'Status', type: 'select', options: ['published', 'draft'], value: p.status || 'published' },
];
router.get('/pages/new', (req, res) => res.send(shell(req, '/pages', 'New Page', ui.card('Page', ui.formHtml(R(req, '/pages/new'), PAGE_FIELDS(), { csrf: req.csrfToken, submit: 'Create page', grid: false })))));
router.post('/pages/new', async (req, res) => {
  // R-056: coerce before .trim() (a missing field used to 500). R-111:
  // status is whitelisted (any string was storable) and sort defaults to
  // max+1 instead of 0, so new pages append honestly instead of piling up
  // at sort 0 with no edit path.
  const b = req.body || {};
  const slug = String(b.slug || '').trim().toLowerCase();
  const name = String(b.name || '').trim(), title = String(b.title || '').trim();
  const status = String(b.status || 'published');
  if (!name || !title) { await req.setFlash('error', 'Name and title are required.'); return res.redirect(R(req, '/pages/new')); }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) { await req.setFlash('error', 'Invalid slug.'); return res.redirect(R(req, '/pages/new')); }
  if (!['published', 'draft'].includes(status)) { await req.setFlash('error', 'Invalid page status.'); return res.redirect(R(req, '/pages/new')); }
  try {
    const maxSort = (await req.db.get('SELECT COALESCE(MAX(sort),0) AS m FROM pages')).m;
    await req.db.run('INSERT INTO pages (name, slug, title, meta_title, meta_desc, body, status, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [name, slug, title, b.meta_title || '', b.meta_desc || '', b.body || '', status, Number(maxSort) + 1]);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'page.create', entity: 'page', entityId: slug, detail: { name, title, status }, ip: req.ip });
    await req.setFlash('success', 'Page created.');
  } catch (e) { await req.setFlash('error', 'Could not create page (slug may exist).'); return res.redirect(R(req, '/pages/new')); }
  res.redirect(R(req, '/pages'));
});
router.get('/pages/:id', async (req, res) => {
  const p = await req.db.get('SELECT * FROM pages WHERE id = ?', [req.params.id]);
  if (!p) return notFound(req, res, 'Page not found.');
  res.send(shell(req, '/pages', 'Edit — ' + p.name,
    ui.card('Page', ui.formHtml(R(req, '/pages/' + p.id), PAGE_FIELDS(p), { csrf: req.csrfToken, submit: 'Save page', grid: false })) +
    `<form method="POST" action="${R(req, '/pages/' + p.id + '/delete')}" class="mt"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-d">Delete page</button></form>`));
});
router.post('/pages/:id', async (req, res) => {
  const old = await req.db.get('SELECT * FROM pages WHERE id = ?', [req.params.id]);
  if (!old) return notFound(req, res, 'Page not found.');
  const b = req.body || {};
  const slug = String(b.slug || '').trim().toLowerCase();
  const name = String(b.name || '').trim(), title = String(b.title || '').trim();
  const status = String(b.status || 'draft');
  if (!name || !title) { await req.setFlash('error', 'Name and title are required.'); return res.redirect(R(req, '/pages/' + req.params.id)); }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) { await req.setFlash('error', 'Invalid slug.'); return res.redirect(R(req, '/pages/' + req.params.id)); }
  if (!['published', 'draft'].includes(status)) { await req.setFlash('error', 'Invalid page status.'); return res.redirect(R(req, '/pages/' + req.params.id)); }
  try {
    await req.db.run('UPDATE pages SET name=?, slug=?, title=?, meta_title=?, meta_desc=?, body=?, status=? WHERE id=?',
      [name, slug, title, b.meta_title || '', b.meta_desc || '', b.body || '', status, req.params.id]);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'page.update', entity: 'page', entityId: slug, detail: { old: { name: old.name, slug: old.slug, title: old.title, status: old.status }, new: { name, slug, title, status } }, ip: req.ip });
    await req.setFlash('success', 'Page saved.');
  } catch (e) { await req.setFlash('error', 'Could not save page: ' + e.message); }
  res.redirect(R(req, '/pages/' + req.params.id));
});
router.post('/pages/:id/delete', async (req, res) => {
  const p = await req.db.get('SELECT * FROM pages WHERE id = ?', [req.params.id]);
  if (!p) return notFound(req, res, 'Page not found.');
  const r = await req.db.run('DELETE FROM pages WHERE id = ?', [req.params.id]);
  if (r.changes !== 1) { await req.setFlash('error', 'Page not found.'); return res.redirect(R(req, '/pages')); }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'page.delete', entity: 'page', entityId: req.params.id, detail: { name: p.name, slug: p.slug }, ip: req.ip });
  await req.setFlash('success', 'Page deleted.');
  res.redirect(R(req, '/pages'));
});
router.get('/content/:key', async (req, res) => {
  const b = await req.db.get(`SELECT * FROM content_blocks WHERE ${keyCol(req.driver)} = ?`, [req.params.key]);
  if (!b) return notFound(req, res, 'Content block not found.');
  res.send(shell(req, '/pages', 'Content — ' + b.key,
    ui.card('Content block', ui.formHtml(R(req, '/content/' + encodeURIComponent(b.key)), [
      { key: 'title', label: 'Title', type: 'text', value: b.title },
      { key: 'body', label: 'Body (HTML)', type: 'textarea', value: b.body },
    ], { csrf: req.csrfToken, submit: 'Save content', grid: false }))));
});
router.post('/content/:key', async (req, res) => {
  const old = await req.db.get(`SELECT * FROM content_blocks WHERE ${keyCol(req.driver)} = ?`, [req.params.key]);
  if (!old) return notFound(req, res, 'Content block not found.');
  await req.db.run(`UPDATE content_blocks SET title = ?, body = ?, updated_at = ? WHERE ${keyCol(req.driver)} = ?`,
    [req.body.title || '', req.body.body || '', now(), req.params.key]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'content.update', entity: 'content', entityId: req.params.key, detail: { old: { title: old.title, body: String(old.body || '').slice(0, 200) }, new: { title: req.body.title || '', body: String(req.body.body || '').slice(0, 200) } }, ip: req.ip });
  await req.setFlash('success', 'Content saved.');
  res.redirect(R(req, '/content/' + encodeURIComponent(req.params.key)));
});

/* ============================================================ CRON JOBS */
router.get('/cron', async (req, res) => {
  const jobs = await req.db.query('SELECT * FROM cron_jobs ORDER BY id');
  const body = ui.card('Scheduled jobs', `<p class="muted">The scheduler runs inside the app (every 60s). Pause/resume or run any job on demand. These are the same jobs shown on the <a href="${R(req, '/automation')}">Automation</a> page — pausing or running a job in either place changes the same job.</p>` +
    ui.table(['Job', 'Every (min)', 'Next run', 'Last run', 'Last status', 'Message', 'Status', ''],
      jobs.map(j => [esc(j.name) + `<br><small class="muted">${esc(j.description || '')}</small>`, j.interval_minutes,
        j.next_run_at ? d(j.next_run_at) : '—', j.last_run_at ? d(j.last_run_at) : 'never',
        j.last_status ? ui.statusBadge(j.last_status) : '—', `<small>${esc(j.last_message || '')}</small>`,
        j.status === 'active' ? ui.badge('active', 'ok') : ui.badge('paused', 'muted'),
        `<form method="POST" action="${R(req, '/cron/' + j.id + '/run')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">Run now</button></form>
         <form method="POST" action="${R(req, '/cron/' + j.id + '/toggle')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">${j.status === 'active' ? 'Pause' : 'Resume'}</button></form>`])) +
    ui.card('Edit schedule', ui.formHtml(R(req, '/cron/schedule'),
      (await req.db.query('SELECT * FROM cron_jobs ORDER BY id')).map(j => ({ key: 'interval_' + j.id, label: j.name + ' (minutes)', type: 'number', value: String(j.interval_minutes) })),
      { csrf: req.csrfToken, submit: 'Save schedules' })));
  res.send(shell(req, '/cron', 'Cron Jobs', body, 'Scheduled background jobs and their last runs.'));
});
router.post('/cron/schedule', async (req, res) => {
  const jobs = await req.db.query('SELECT * FROM cron_jobs');
  const changes = {};
  for (const j of jobs) {
    const v = Math.max(1, parseInt(req.body['interval_' + j.id], 10) || j.interval_minutes);
    if (v !== j.interval_minutes) changes[j.handler_key] = { from: j.interval_minutes, to: v };
    await req.db.run('UPDATE cron_jobs SET interval_minutes = ?, next_run_at = ? WHERE id = ?', [v, now() + v * 60000, j.id]);
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'cron.schedule', entity: 'cron', entityId: '', detail: { changes }, ip: req.ip });
  await req.setFlash('success', 'Schedules saved.');
  res.redirect(R(req, '/cron'));
});
router.post('/cron/:id/run', async (req, res) => {
  const job = await req.db.get('SELECT handler_key FROM cron_jobs WHERE id = ?', [req.params.id]);
  try {
    const msg = await runNow({ db: req.db, driver: req.driver }, req.params.id);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'cron.run_now', entity: 'cron', entityId: req.params.id, detail: { handler: job ? job.handler_key : '', result: String(msg).slice(0, 300), via: 'cron page' }, ip: req.ip });
    await req.setFlash('success', 'Job ran: ' + msg);
  } catch (e) {
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'cron.run_now_failed', entity: 'cron', entityId: req.params.id, detail: { handler: job ? job.handler_key : '', error: e.message, via: 'cron page' }, ip: req.ip });
    await req.setFlash('error', 'Job failed: ' + e.message);
  }
  res.redirect(R(req, '/cron'));
});
router.post('/cron/:id/toggle', async (req, res) => {
  const j = await req.db.get('SELECT * FROM cron_jobs WHERE id = ?', [req.params.id]);
  if (!j) { await req.setFlash('error', 'Job not found.'); return res.redirect(R(req, '/cron')); }
  await req.db.run("UPDATE cron_jobs SET status = CASE WHEN status='active' THEN 'paused' ELSE 'active' END, next_run_at = ? WHERE id = ?", [now() + j.interval_minutes * 60000, j.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'cron.toggle', entity: 'cron', entityId: req.params.id, detail: { old_status: j.status, new_status: j.status === 'active' ? 'paused' : 'active' }, ip: req.ip });
  res.redirect(R(req, '/cron'));
});

/* Global login history (ViserLab-style report: IP, browser, OS, success) */
router.get('/login-history', async (req, res) => {
  // R-109: email-only search missed the key fraud signal (IP) and the user
  // name; success and date were unfilterable. All four now filter in SQL.
  const page = pageOf(req), q = (req.query.q || '').trim(), ipq = (req.query.ip || '').trim();
  const success = req.query.success === '1' ? 1 : req.query.success === '0' ? 0 : null;
  const from = req.query.from ? new Date(req.query.from + 'T00:00:00').getTime() : null;
  const to = req.query.to ? new Date(req.query.to + 'T23:59:59').getTime() : null;
  const where = [], params = [];
  if (q) { where.push('(LOWER(lh.email) LIKE LOWER(?) OR LOWER(u.name) LIKE LOWER(?))'); params.push('%' + q + '%', '%' + q + '%'); }
  if (ipq) { where.push('LOWER(lh.ip) LIKE LOWER(?)'); params.push('%' + ipq + '%'); }
  if (success !== null) { where.push('lh.success = ?'); params.push(success); }
  if (from && !Number.isNaN(from)) { where.push('lh.created_at >= ?'); params.push(from); }
  if (to && !Number.isNaN(to)) { where.push('lh.created_at <= ?'); params.push(to); }
  const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = (await req.db.get(`SELECT COUNT(*) AS c FROM login_history lh LEFT JOIN users u ON u.id = lh.user_id ${w}`, params)).c;
  const rows = await req.db.query(
    `SELECT lh.*, u.name FROM login_history lh LEFT JOIN users u ON u.id = lh.user_id
     ${w} ORDER BY lh.created_at DESC LIMIT ? OFFSET ?`, [...params, PER, (page - 1) * PER]);
  const qs = [['q', q], ['ip', ipq], ['success', req.query.success || ''], ['from', req.query.from || ''], ['to', req.query.to || '']]
    .filter(([, v]) => v !== '').map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
  const body = `<form method="GET" class="filters"><input type="text" name="q" value="${esc(q)}" placeholder="Search email or name"><input type="text" name="ip" value="${esc(ipq)}" placeholder="Filter IP"><select name="success"><option value="" ${success === null ? 'selected' : ''}>Any result</option><option value="1" ${success === 1 ? 'selected' : ''}>Success</option><option value="0" ${success === 0 ? 'selected' : ''}>Failed</option></select><input type="date" name="from" value="${esc(req.query.from || '')}"><input type="date" name="to" value="${esc(req.query.to || '')}"><button class="btn btn-sm" type="submit">Filter</button></form>` +
    ui.table(['User', 'Email', 'IP', 'Browser', 'OS', 'Result', 'When'],
      rows.map(r => [esc(r.name || '—'), esc(r.email || '—'), esc(r.ip || '—'), esc(r.browser || '—'), esc(r.os || '—'),
        r.success ? ui.badge('success', 'ok') : ui.badge('failed', 'err'), d(r.created_at)])) +
    ui.paginate(R(req, '/login-history') + (qs ? '?' + qs : ''), page, PER, total);
  res.send(shell(req, '/login-history', 'Login History', body, 'Sign-in attempts — successes and failures.'));
});
/* Referrals: who referred whom + commission earned (ViserLab-style referral) */
router.get('/referrals', async (req, res) => {
  const page = pageOf(req);
  const total = (await req.db.get('SELECT COUNT(*) AS c FROM users WHERE referred_by IS NOT NULL')).c;
  const rows = await req.db.query(
    `SELECT u.email AS referred_email, u.name AS referred_name, u.created_at, r.email AS referrer_email, r.id AS referrer_id
     FROM users u JOIN users r ON r.id = u.referred_by ORDER BY u.created_at DESC LIMIT ? OFFSET ?`,
    [PER, (page - 1) * PER]);
  /* CURRENCY-SYSTEM-01: referral earnings are summed PER CURRENCY (the old
     subquery mixed every currency into one base-labelled number). */
  const refComm = await req.db.query("SELECT user_id, currency, COALESCE(SUM(amount),0) AS s FROM transactions WHERE type = 'referral_commission' GROUP BY user_id, currency");
  const refMap = {}; for (const r of refComm) (refMap[r.user_id] = refMap[r.user_id] || []).push(r);
  const body = ui.table(['Referred player', 'Referrer', 'Joined', 'Commission earned by referrer'],
    rows.map(x => { const ec = refMap[x.referrer_id] || []; return [esc(x.referred_email) + ' (' + esc(x.referred_name) + ')', esc(x.referrer_email), d(x.created_at),
      ec.length ? ec.map(r => money(req, r.s, r.currency)).join(' · ') : money(req, 0, getS(req.settings, 'base_currency', 'USD'))]; })) +
    ui.paginate(R(req, '/referrals'), page, PER, total);
  res.send(shell(req, '/referrals', 'Referrals', body, 'Referral links, sign-ups and rewards.'));
});
/* Clear settings cache (operator tool — settings cache is 5s TTL, this forces a reload) */
router.post('/settings/clear-cache', async (req, res) => {
  const { invalidate } = require('../lib/settings');
  invalidate();
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'settings.cache_clear', entity: 'settings', entityId: '', detail: {}, ip: req.ip });
  await req.setFlash('success', 'Settings cache cleared.');
  res.redirect(R(req, '/settings'));
});
/* ============================================================ SETTINGS */
const TOGGLES = [
  ['registration_enabled', 'Registration open', 'Allow new players to register.'],
  ['force_ssl', 'Force SSL', 'Mark cookies Secure (enable when serving HTTPS).'],
  ['policy_agreement', 'Policy agreement', 'Require players to accept terms at registration.'],
  ['secure_password', 'Secure password', 'Enforce strong passwords (8+ chars, upper/lower/number).'],
  ['notifications_enabled', 'Notifications', 'Master switch for email/SMS/push notifications.'],
  ['otp_registration', 'OTP-gated registration', 'Require an operator-issued signup code to register.'],
  ['google_oauth_enabled', 'Google sign-in', 'Show Google sign-in (needs OAuth credentials).'],
  ['deposits_enabled', 'Deposits (global)', 'Master kill switch for deposits.'],
  ['withdrawals_enabled', 'Withdrawals (global)', 'Master kill switch for withdrawals.'],
  ['cookie_consent_enabled', 'Cookie consent banner', 'Show the GDPR cookie banner.'],
  ['phone_otp_enabled', 'Phone OTP login', 'Allow sign-in via SMS code (OFF by default; enable later from here)'],
  ['email_otp_enabled', 'Email OTP login', 'Allow sign-in via email code (OFF by default; enable later from here)'],
  ['withdrawal_otp_enabled', 'Withdrawal OTP', 'Require a one-time code on every withdrawal (ONLY place OTP is used; toggleable here)'],
  ['maintenance_mode', 'Maintenance mode', 'Block the player site with a maintenance page (admin panel + admin login still work).'],
  ['referral_enabled', 'Referral program', 'Players earn commission when referred friends buy tickets.'],
  ['facebook_oauth_enabled', 'Facebook login', 'Needs FACEBOOK_APP_ID/SECRET env vars'],
  ['password_login_enabled', 'Password login (legacy)', 'Keep old email+password as fallback'],
  ['verified_contact_required', 'Verified contact gate', 'Require email OR phone verification before deposit/withdraw.'],
  ['admin_totp_required', 'Admin TOTP required', 'Admins must have authenticator 2FA (enable ONLY after enrolling — see Security).'],
  ['beacon_enabled', 'Draw beacon', 'Combine the committed seed with the public drand beacon at settle.'],
  ['beacon_required', 'Beacon required (strict)', 'If ON, a draw does NOT settle when the beacon is unreachable (fail closed).'],
  ['withdrawal_same_method', 'Same-method withdrawals', 'Withdraw only via a method previously deposited with.'],
  ['breached_password_check', 'Breached-password check', 'Reject passwords found in public data breaches (HIBP, fails open offline).'],
  ['csp_enabled', 'Content-Security-Policy', 'Send the CSP header (nonce-based; disable only if a custom embed breaks).'],
];
/* ================= ADMIN-CLARITY-01: Limits & Controls hub =======
   ONE page for every global money limit ("deposit/withdraw limit set
   karne ka bhi ho, ek sath sab ki"). Every row writes the SAME single
   settings key the Settings page writes — two doors, one truth, no
   duplicate storage:
     deposit_daily_cap / deposit_monthly_cap  -> NEW (engine: money.js createDeposit)
     withdrawal_daily_cap / withdrawal_monthly_cap / payout_lock_hours /
     auto_withdrawal_limit / withdrawal_turnover_required -> /settings/risk keys
   Validations mirror /settings/risk exactly for the shared fields. */
router.get('/limits', async (req, res) => {
  const s = req.settings;
  const sup = isSuperReq(req);
  const amt = (k) => (parseFloat(getS(s, k, '0')) / 100).toFixed(2);
  const row = (name, what, inputHtml) => `<tr><td><strong>${name}</strong><div class="muted" style="font-size:12px">${what}</div></td><td style="min-width:170px">${inputHtml}</td></tr>`;
  const num = (name, val, step) => sup
    ? `<input class="input" name="${name}" type="number" step="${step || '0.01'}" min="0" value="${esc(val)}" style="min-height:48px">`
    : `<strong>${esc(val)}</strong>`;
  const rows = [
    row('Daily deposit limit (per player, per currency)', 'A player\'s deposits today (waiting + approved) may not pass this total. 0 = no limit.', num('deposit_daily_cap', amt('deposit_daily_cap'))),
    row('Monthly deposit limit (per player, per currency)', 'Same rule over the whole month. 0 = no limit.', num('deposit_monthly_cap', amt('deposit_monthly_cap'))),
    row('Daily withdrawal limit (per player, per currency)', 'A player\'s withdrawals today (waiting + approved + paid) may not pass this total. 0 = no limit.', num('withdrawal_daily_cap', amt('withdrawal_daily_cap'))),
    row('Monthly withdrawal limit (per player, per currency)', 'Same rule over the whole month. 0 = no limit.', num('withdrawal_monthly_cap', amt('withdrawal_monthly_cap'))),
    row('Auto-withdrawal limit', 'Withdrawals at or under this amount approve themselves after all safety checks; paying still happens by hand. 0 = auto off, everything manual.', num('auto_withdrawal_limit', getS(s, 'auto_withdrawal_limit', '0'))),
    row('Payout-detail change lock (hours)', 'After a player changes payout details, withdrawals to the new details wait this long (24–72).', num('payout_lock_hours', getS(s, 'payout_lock_hours', '48'), '1')),
    row('Wagering required before withdrawal', 'Players must wager at least their deposits before withdrawing (1× rule).', sup
      ? `<label class="fld-check"><input type="checkbox" name="withdrawal_turnover_required" value="1" ${getS(s, 'withdrawal_turnover_required', '0') === '1' ? 'checked' : ''}> Required</label>`
      : `<strong>${getS(s, 'withdrawal_turnover_required', '0') === '1' ? 'Required' : 'Not required'}</strong>`),
  ].join('');
  const overrides = await req.db.get('SELECT COUNT(*) AS c FROM users WHERE auto_withdrawal_limit IS NOT NULL');
  const body =
    ui.card('Global limits — apply to every player at once',
      (sup ? `<form method="post" action="${R(req, '/limits')}"><input type="hidden" name="_csrf" value="${esc(req.csrfToken || '')}">` : '') +
      `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Limit</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table></div>` +
      (sup ? `<div class="mt"><button class="btn btn-p" type="submit" style="min-height:48px">Save limits</button></div></form>` : '<p class="muted mt">Only the super admin can change limits.</p>')) +
    ui.card('Limits that live elsewhere', `<ul class="clean-list">
      <li><strong>Per-method min/max</strong> (each payment method\'s own smallest/largest payment) — set on <a href="${R(req, '/methods')}">Payment Methods</a>.</li>
      <li><strong>Per-player overrides</strong> — ${overrides.c} player(s) currently have their own auto-withdrawal limit; set them on each player\'s page via <a href="${R(req, '/users')}">Users</a>.</li>
      <li><strong>Player self-limits</strong> — players can set their own daily deposit limit on their Responsible Play page. Those are theirs; there is no editor here.</li>
    </ul>`);
  res.send(shell(req, '/limits', 'Limits & Controls', body, 'Every global deposit and withdrawal limit in one place. Changes apply to all players at once.'));
});
router.post('/limits', async (req, res) => {
  if (!isSuperReq(req)) return res.status(403).send(shell(req, '/limits', 'Limits & Controls', '<div class="alert a-err">Only the super admin can change limits.</div>'));
  const back = (msg) => req.setFlash('error', msg).then(() => res.redirect(R(req, '/limits')));
  const daily = toMinor(req.body.deposit_daily_cap), monthly = toMinor(req.body.deposit_monthly_cap);
  const wDaily = toMinor(req.body.withdrawal_daily_cap), wMonthly = toMinor(req.body.withdrawal_monthly_cap);
  const lockRaw = String(req.body.payout_lock_hours || '').trim();
  const lock = /^-?\d+$/.test(lockRaw) ? parseInt(lockRaw, 10) : null;
  const autoRaw = String(req.body.auto_withdrawal_limit || '0').trim();
  if (daily === null || monthly === null || wDaily === null || wMonthly === null) return back('Limits must be valid amounts (e.g. 500.00). Nothing was saved.');
  if (!/^\d+(\.\d{1,2})?$/.test(autoRaw)) return back('Auto-withdrawal limit must be an amount like 50 or 50.00 (0 = off). Nothing was saved.');
  if (lock === null || lock < 24 || lock > 72) return back('Payout-detail change lock must be an integer 24–72 hours. Nothing was saved.');
  const keys = { deposit_daily_cap: String(daily), deposit_monthly_cap: String(monthly), withdrawal_daily_cap: String(wDaily), withdrawal_monthly_cap: String(wMonthly), payout_lock_hours: String(lock), auto_withdrawal_limit: autoRaw, withdrawal_turnover_required: req.body.withdrawal_turnover_required ? '1' : '0' };
  const changes = {};
  for (const [k, v] of Object.entries(keys)) {
    const old = getS(req.settings, k, '');
    if (old !== v) changes[k] = { from: old, to: v };
    await setSetting(req.db, req.driver, k, v);
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'settings.limits', entity: 'settings', entityId: '', detail: { changes }, ip: req.ip });
  await req.setFlash('success', 'Limits saved. They apply to every player immediately.');
  res.redirect(R(req, '/limits'));
});

router.get('/settings', async (req, res) => {
  const s = req.settings;
  const prizes = await req.db.query('SELECT pops_count, multiplier FROM prize_table ORDER BY pops_count');
  // R-089: a failed HIBP check fails open by design — but the operator must
  // SEE that breach screening is currently blind, not discover it later.
  const breachedWarn = breachedCheckFailedRecently()
    ? '<div class="alert a-err">⚠ Breached-password check has FAILED recently (HIBP unreachable): passwords are currently accepted WITHOUT breach screening. Check the server log and network, then re-test with a known-breached password.</div>'
    : '';
  const body = `
  ${breachedWarn}
  <nav class="sumstrip" aria-label="Settings sections"><span><strong>Jump to:</strong>
    <a href="#set-economy">Game economy</a> <span class="muted">(wagers, draws, prizes)</span> ·
    <a href="#set-risk">Withdrawal &amp; risk controls</a> <span class="muted">(caps, wagering rule, payout lock)</span> ·
    <a href="#set-kyc">KYC</a> <span class="muted">(identity checks)</span> ·
    <a href="#set-currencies">Currencies</a> <span class="muted">(enabled currencies and rates)</span> ·
    <a href="#set-appearance">Appearance &amp; legal</a> <span class="muted">(name, logo, legal pages)</span></span></nav>
  ${ui.card('Operator notes', `<p class="muted">Admin path: the panel URL prefix is set at boot via the <span class="code">ADMIN_PATH</span> env var (or its default) — it is intentionally NOT editable here, so a settings save can never expose or move the hidden panel. Upcoming draw days are set in Game economy below.</p>`)}
  ${ui.card('System configuration', ui.formHtml(R(req, '/settings/toggles'),
    TOGGLES.map(([k, label, help]) => ({ key: k, label, type: 'checkbox', value: getS(s, k, '0') === '1', help })),
    { csrf: req.csrfToken, submit: 'Save toggles' }))}
  ${ui.card('Operator tools', `<form method="POST" action="${R(req, '/settings/clear-cache')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-g" type="submit">Clear settings cache</button></form><p class="muted">Forces settings to reload from the database (cache is otherwise 5 seconds).</p>`)}
  <div id="set-economy">${ui.card('Game economy — every amount is set here', ui.formHtml(R(req, '/settings/economy'), [
      { key: 'wager_options', label: 'Wager options (e.g. 1,2,5,10)', type: 'text', value: getS(s, 'wager_options', '1,2,5,10') },
      { key: 'max_pops', label: 'Max pops per ticket', type: 'number', value: getS(s, 'max_pops', '15') },
      { key: 'max_draws', label: 'Max consecutive draws', type: 'number', value: getS(s, 'max_draws', '7') },
      { key: 'day_draw_time', label: 'Day draw time (HH:MM)', type: 'text', value: getS(s, 'day_draw_time', '14:00') },
      { key: 'eve_draw_time', label: 'Evening draw time (HH:MM)', type: 'text', value: getS(s, 'eve_draw_time', '21:00') },
      { key: 'commission_rate', label: 'Agent commission % on ticket sales', type: 'text', value: getS(s, 'commission_rate', '5') },
      { key: 'deposit_mode', label: 'Deposit mode', type: 'select', options: ['manual'], value: 'manual', help: 'Deposits are ALWAYS manually reviewed. The old "auto" option implied an auto-approval that never existed, so it was removed.' },
      { key: 'withdrawal_mode', label: 'Withdrawal mode', type: 'select', options: ['manual'], value: 'manual', help: 'Withdrawals are ALWAYS manually reviewed.' },
      { key: 'upcoming_draw_days', label: 'Upcoming draw days to pre-create (0 = disabled)', type: 'number', value: getS(s, 'upcoming_draw_days', '7'), help: 'How many days of Day/Evening draws the scheduler pre-creates. 0 disables pre-creation.' },
      { key: 'referral_rate', label: 'Referral commission % on referred ticket purchases', type: 'text', value: getS(s, 'referral_rate', '5') },
      { key: 'deposit_bonus_percent', label: 'Deposit bonus % (0 = off) — credited on approved deposits', type: 'text', value: getS(s, 'deposit_bonus_percent', '0'), help: 'Bonus = percent of the net credited amount, paid as a separate wallet credit when a deposit is approved; clawed back if the deposit is revoked.' },
      { key: 'multi_draw_discounts', label: 'Multi-draw discounts (draws:percent, comma-separated, e.g. 5:12,8:14,12:20)', type: 'text', value: getS(s, 'multi_draw_discounts', ''), help: 'Exact-match bundles keyed on the number of draws selected (Both = N Day + N Evening entries, keyed as N).' },
    ], { csrf: req.csrfToken, submit: 'Save economy' }) +
    `<h4 class="mt">Prize table — multiplier per pops count (win = wager × multiplier)</h4>
     <form method="POST" action="${R(req, '/settings/prizes')}" class="adm-form"><input type="hidden" name="_csrf" value="${req.csrfToken}">
     <div class="prize-grid">${prizes.map(p => `<div class="field"><label>${p.pops_count} pop${p.pops_count > 1 ? 's' : ''} → ×</label><input type="number" name="mult_${p.pops_count}" value="${p.multiplier}" min="1"></div>`).join('')}</div>
     <div class="mt"><button class="btn btn-p" type="submit">Save prize table</button>
     <button class="btn" type="submit" formaction="${R(req, '/settings/prizes/preview')}">Simulate first (no save)</button></div></form>`)}
  </div><div id="set-risk">${ui.card('Withdrawal & risk controls', ui.formHtml(R(req, '/settings/risk'), [
      { key: 'withdrawal_turnover_required', label: 'Require 1× wagering before withdrawal', type: 'checkbox', value: getS(s, 'withdrawal_turnover_required', '1') === '1', help: 'Players must wager at least their approved deposits before withdrawing.' },
      { key: 'withdrawal_daily_cap', label: 'Daily withdrawal cap (e.g. 500.00; 0 = unlimited)', type: 'text', value: (parseFloat(getS(s, 'withdrawal_daily_cap', '0')) / 100).toFixed(2) },
      { key: 'withdrawal_monthly_cap', label: 'Monthly withdrawal cap (e.g. 5000.00; 0 = unlimited)', type: 'text', value: (parseFloat(getS(s, 'withdrawal_monthly_cap', '0')) / 100).toFixed(2) },
      { key: 'payout_lock_hours', label: 'Payout-detail change lock (hours, 24–72)', type: 'number', value: getS(s, 'payout_lock_hours', '48') },
      { key: 'maker_checker_threshold', label: 'Maker-checker threshold (e.g. 1000.00; 0 = disabled)', type: 'text', value: (parseFloat(getS(s, 'maker_checker_threshold', '0')) / 100).toFixed(2), help: 'Money actions at or above this amount need a second approver (see Approvals).' },
      { key: 'auto_withdrawal_limit', label: 'Auto-withdrawal limit (e.g. 50.00; 0 = OFF — everything manual)', type: 'text', value: getS(s, 'auto_withdrawal_limit', '0'), help: 'Operator pre-authorization: a withdrawal at or under this amount (in the withdrawal\'s own currency) is AUTO-APPROVED by the system once every existing gate passes (wagering, OTP, KYC, payout lock). This deliberately bypasses maker-checker review for small amounts — set it knowingly. Auto-approval NEVER pays out by itself: payout still happens only through the normal mark-paid step with a provider payout ID. Per-user limits on the user page override this value.' },
      { key: 'referral_cap_per_referee', label: 'Referral cap per referee (e.g. 50.00; 0 = unlimited)', type: 'text', value: (parseFloat(getS(s, 'referral_cap_per_referee', '0')) / 100).toFixed(2) },
    ], { csrf: req.csrfToken, submit: 'Save risk controls' }))}
  </div><div id="set-kyc">${ui.card('KYC — identity verification', ui.formHtml(R(req, '/settings/kyc'), [
      { key: 'kyc_enabled', label: 'Enable KYC requirement for all users (master switch)', type: 'checkbox', value: getS(s, 'kyc_enabled', '0') === '1', help: 'Ships OFF: with the switch off, nobody is gated unless their per-user requirement is set to "required" on their user page. Users set to "exempt" are never gated.' },
      { key: 'kyc_gate', label: 'Gate scope', type: 'select', options: [{ v: 'withdrawals', l: 'Withdrawals only' }, { v: 'deposits_and_withdrawals', l: 'Deposits and withdrawals' }], value: getS(s, 'kyc_gate', 'withdrawals'), help: 'Withdrawals only = KYC approval is required before withdrawals. Deposits and withdrawals = deposits are gated too. Players submit documents on their /kyc page; review them under KYC in the menu.' },
    ], { csrf: req.csrfToken, submit: 'Save KYC settings' }))}
  </div>${ui.card('Phone countries — dial codes & blocks', ui.formHtml(R(req, '/settings/phone-countries'), [
      { key: 'blocked_phone_countries', label: 'Blocked countries (ISO codes, comma-separated)', type: 'text', value: getS(s, 'blocked_phone_countries', ''), help: 'Example: PK,BD — players from these countries will NOT see their dial code in the phone dropdown and cannot register with that country number. Leave empty to allow all countries.' },
    ], { csrf: req.csrfToken, submit: 'Save phone countries' })) + `<p class="muted">The register and OTP phone fields show a country dial-code dropdown with all ${require('../lib/phone-countries').COUNTRIES.length} countries. Blocked countries are hidden from the dropdown and rejected server-side.</p>`}
  ${ui.card('Support ticket limits', `<p class="muted">Caps enforced server-side when a player opens support tickets. Set either limit to <strong>0</strong> for unlimited.</p>` + ui.formHtml(R(req, '/settings/support-limits'), [
      { key: 'support_max_open_tickets', label: 'Max open tickets per player', type: 'number', value: getS(s, 'support_max_open_tickets', '2'), help: 'Open = not closed. 0 = unlimited.' },
      { key: 'support_max_new_tickets_24h', label: 'Max new tickets per player per 24 hours', type: 'number', value: getS(s, 'support_max_new_tickets_24h', '3'), help: 'Rolling 24-hour window. 0 = unlimited.' },
    ], { csrf: req.csrfToken, submit: 'Save ticket limits' }))}
  ${ui.card('Homepage hero stats', `<p class="muted">Hero stats always show true database counts (players, tickets today, total paid out). The old 'marketing' mode — invented base numbers that ticked up by random amounts — was removed because it fabricated public statistics.</p>`)}
  <div id="set-currencies">${ui.card('Currencies', await (async () => {
    /* CURRENCY-SYSTEM-01: the currencies card is a readable TABLE now
       (one row per currency: code, symbol, "1 BASE = X CODE" rate,
       enabled, base marker) instead of a raw JSON textarea as the only
       control. The storage format underneath is UNCHANGED (the same
       currencies JSON + base_currency keys); the POST handler rebuilds
       the JSON from these rows. The raw JSON remains under Advanced.
       A currency is "enabled" by being in the list — unticking removes
       it on save, exactly like deleting it from the JSON did. Rates
       are ADMIN-SET placeholders (no live FX updater exists). */
    const curs = getCurrencies(s);
    const base = getS(s, 'base_currency', 'USD');
    const gaps = await currencyCoverageGaps(req);
    const rowsHtml = curs.map((c, i) => `<tr>
      <td><strong>${esc(c.code)}</strong><input type="hidden" name="cur_code" value="${esc(c.code)}"><input type="hidden" name="cur_decimals" value="${c.decimals === undefined ? '' : esc(String(c.decimals))}"></td>
      <td><input class="input" name="cur_symbol" value="${esc(c.symbol || '')}" maxlength="8" style="min-height:48px" aria-label="Symbol for ${esc(c.code)}"></td>
      <td><input class="input" name="cur_rate" type="number" step="any" min="0" value="${esc(String(c.rate))}" style="min-height:48px" aria-label="Rate for ${esc(c.code)}"></td>
      <td><label class="fld-check"><input type="checkbox" name="cur_enabled" value="${esc(c.code)}" checked> Enabled</label></td>
      <td><label class="fld-check"><input type="radio" name="base_currency" value="${esc(c.code)}" ${c.code === base ? 'checked' : ''}> Base</label></td>
    </tr>`).join('');
    return coverageHtml(gaps) + `<p class="muted">Rate = how many units of the currency equal 1 unit of the base currency (e.g. 1 USD = 90.50 INR). Rates are set by you — there is no live exchange-rate feed. Seeded payment rails are USD templates until you create methods per currency.</p>
    <form method="post" action="${R(req, '/settings/currencies')}">
      <input type="hidden" name="_csrf" value="${esc(req.csrfToken || '')}">
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Code</th><th>Symbol</th><th>Rate (per 1 ${esc(base)})</th><th>Enabled</th><th>Base</th></tr></thead><tbody>${rowsHtml}
      <tr><td><input class="input" name="cur_code" value="" placeholder="New code (e.g. GBP)" style="min-height:48px" aria-label="New currency code"><input type="hidden" name="cur_decimals" value=""></td>
      <td><input class="input" name="cur_symbol" value="" placeholder="£" maxlength="8" style="min-height:48px" aria-label="New currency symbol"></td>
      <td><input class="input" name="cur_rate" type="number" step="any" min="0" value="" placeholder="Rate" style="min-height:48px" aria-label="New currency rate"></td>
      <td><label class="fld-check"><input type="checkbox" name="cur_enabled" value="__new__"> Enabled</label></td><td class="muted">new</td></tr>
      </tbody></table></div>
      <div class="field mt"><label for="exfee">Wallet exchange fee (%)</label><input class="input" id="exfee" name="exchange_fee_percent" type="number" step="any" min="0" max="100" value="${esc(getS(s, 'exchange_fee_percent', '0'))}"><small class="muted">Taken from the converted amount when a player exchanges between their own wallets. 0 = no fee.</small></div>
      <div class="mt"><button class="btn btn-p" type="submit" style="min-height:48px">Save currencies</button></div>
    </form>
    <details class="mt"><summary>Advanced (JSON)</summary>
      <p class="muted">The same data as raw JSON — saving here replaces the table above. Storage format unchanged.</p>
      ${ui.formHtml(R(req, '/settings/currencies'), [
        { key: 'currencies', label: 'Currencies JSON', type: 'textarea', value: getS(s, 'currencies', '[]') },
        { key: 'base_currency', label: 'Base currency code', type: 'text', value: getS(s, 'base_currency', 'USD') },
      ], { csrf: req.csrfToken, submit: 'Save currencies (JSON)', grid: false })}
    </details>`;
  })())}
  </div><div id="set-appearance">${ui.card('Appearance & legal', ui.formHtml(R(req, '/settings/appearance'), [
      { key: 'site_name', label: 'Site name', type: 'text', value: getS(s, 'site_name', '') },
      { key: 'cookie_text', label: 'Cookie banner text', type: 'textarea', value: getS(s, 'cookie_text', '') },
      { key: 'custom_css', label: 'Custom CSS', type: 'textarea', value: getS(s, 'custom_css', '') },
      /* SCAN fix (C-01): the old 'language' select was a dead switch —
         saved but read by nothing (single option 'en', layout hardcodes
         lang="en"). Removed rather than left as decoration. */
      { key: 'site_timezone', label: 'Site timezone (IANA)', type: 'text', value: getS(s, 'site_timezone', 'UTC'), help: 'Draw dates and daily limits follow this timezone, e.g. America/Chicago. Must be a valid IANA name.' },
      { key: 'support_notify_email', label: 'Support notification email', type: 'text', value: getS(s, 'support_notify_email', ''), help: 'When set (and email is configured), every new player support ticket is emailed here.' },
      { key: 'sms_provider', label: 'SMS provider', type: 'select', options: ['', 'twilio', 'textbelt'], value: getS(s, 'sms_provider', ''), help: 'Used for phone OTP codes. Twilio needs TWILIO_* env vars; TextBelt needs TEXTBELT_KEY. The SMS_PROVIDER env var, when set, overrides this.' },
    ], { csrf: req.csrfToken, submit: 'Save appearance', grid: false }))}</div>`;
  res.send(shell(req, '/settings', 'Settings', body, 'All site settings, grouped — use the Jump to index at the top.'));
});
router.post('/settings/toggles', async (req, res) => {
  // Guard: enabling admin TOTP enforcement before the current admin has
  // enrolled would lock every admin out. Refuse until enrolled.
  if (req.body.admin_totp_required) {
    const me = await req.db.get('SELECT totp_secret FROM users WHERE id = ?', [req.user.id]);
    if (!me || !me.totp_secret) {
      await req.setFlash('error', 'Cannot enable "Admin TOTP required": enroll your own authenticator first (Admin → Security), then enable it.');
      return res.redirect(R(req, '/settings'));
    }
  }
  const old = {};
  for (const [k] of TOGGLES) old[k] = getS(req.settings, k, '0');
  const changes = {};
  for (const [k] of TOGGLES) {
    const nv = req.body[k] ? '1' : '0';
    if (old[k] !== nv) changes[k] = { from: old[k], to: nv };
    await setSetting(req.db, req.driver, k, nv);
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'settings.toggles', entity: 'settings', entityId: '', detail: { changes }, ip: req.ip });
  await req.setFlash('success', 'Toggles saved.');
  res.redirect(R(req, '/settings'));
});
router.post('/settings/economy', async (req, res) => {
  // R-058: the old handler stored raw strings unchecked — a garbage draw
  // time, a negative commission, or a non-numeric wager list went straight
  // into settings and broke buys/draws later. Validate ALL fields first;
  // on any bad value, reject the WHOLE save (nothing is written).
  // R-044: deposit/withdrawal_mode must be 'manual'; auto_approve_deposit_limit
  // is no longer saved from this form (the stored value is left untouched —
  // the setting is dead and the form no longer offers it).
  const b = req.body || {};
  const fail = async (m) => { await req.setFlash('error', m + ' Nothing was saved.'); return res.redirect(R(req, '/settings')); };
  const hhmm = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '').trim());
  const intIn = (v, lo, hi) => { const n = parseInt(String(v || '').trim(), 10); return /^-?\d+$/.test(String(v || '').trim()) && n >= lo && n <= hi ? n : null; };
  const pct = (v) => { const n = parseFloat(String(v || '').trim()); return Number.isFinite(n) && n >= 0 && n <= 100 ? String(n) : null; };
  const wagerList = String(b.wager_options || '').split(',').map(x => x.trim()).filter(Boolean);
  if (!wagerList.length || !wagerList.every(x => Number.isFinite(parseFloat(x)) && parseFloat(x) > 0)) return fail('Wager options must be a comma list of positive amounts (e.g. 1,2,5,10).');
  const maxPops = intIn(b.max_pops, 1, 15);
  if (maxPops === null) return fail('Max pops per ticket must be an integer 1–15.');
  const maxDraws = intIn(b.max_draws, 1, 31);
  if (maxDraws === null) return fail('Max consecutive draws must be an integer 1–31.');
  if (!hhmm(b.day_draw_time) || !hhmm(b.eve_draw_time)) return fail('Draw times must be HH:MM (24h).');
  const commRate = pct(b.commission_rate), refRate = pct(b.referral_rate);
  if (commRate === null || refRate === null) return fail('Commission / referral rates must be numbers 0–100.');
  const bonusPct = pct(b.deposit_bonus_percent === undefined ? '0' : b.deposit_bonus_percent);
  if (bonusPct === null) return fail('Deposit bonus must be a number 0–100.');
  if (b.deposit_mode !== 'manual' || b.withdrawal_mode !== 'manual') return fail('Deposit/withdrawal mode must be manual — auto-approval does not exist.');
  const updDays = intIn(b.upcoming_draw_days, 0, 365);
  if (updDays === null) return fail('Upcoming draw days must be an integer 0–365.');
  const discRaw = String(b.multi_draw_discounts || '').trim();
  if (discRaw !== '') {
    const okDisc = discRaw.split(',').every(part => {
      const [n, pc] = part.trim().split(':');
      return /^-?\d+$/.test((n || '').trim()) && parseInt(n, 10) >= 2 && Number.isFinite(parseFloat(pc)) && parseFloat(pc) >= 0 && parseFloat(pc) <= 100;
    });
    if (!okDisc) return fail('Multi-draw discounts must be draws:percent pairs (e.g. 5:12,8:14) with draws ≥ 2 and percent 0–100.');
  }
  const keys = { wager_options: wagerList.join(','), max_pops: String(maxPops), max_draws: String(maxDraws), day_draw_time: String(b.day_draw_time).trim(), eve_draw_time: String(b.eve_draw_time).trim(), commission_rate: commRate, deposit_mode: 'manual', withdrawal_mode: 'manual', referral_rate: refRate, deposit_bonus_percent: bonusPct, multi_draw_discounts: discRaw, upcoming_draw_days: String(updDays) };
  const changes = {};
  for (const [k, nv] of Object.entries(keys)) {
    const old = getS(req.settings, k, '');
    if (old !== nv) changes[k] = { from: old, to: nv };
    await setSetting(req.db, req.driver, k, nv);
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'settings.economy', entity: 'settings', entityId: '', detail: { changes }, ip: req.ip });
  await req.setFlash('success', 'Economy settings saved.');
  res.redirect(R(req, '/settings'));
});
router.post('/settings/risk', async (req, res) => {
  const { toMinor } = require('../lib/util');
  const daily = toMinor(req.body.withdrawal_daily_cap);
  const monthly = toMinor(req.body.withdrawal_monthly_cap);
  const threshold = toMinor(req.body.maker_checker_threshold);
  const refCap = toMinor(req.body.referral_cap_per_referee);
  // R-060: the form labels the lock 24–72h, but the old code silently
  // clamped anything to 0–168 — an admin typing 200 got 168 with no word.
  // Out-of-range or garbage input now rejects the whole save.
  const lockRaw = String(req.body.payout_lock_hours || '').trim();
  const lock = /^-?\d+$/.test(lockRaw) ? parseInt(lockRaw, 10) : null;
  // BP-22: stored as major units exactly as typed (0 = auto-withdrawal OFF).
  const autoRaw = String(req.body.auto_withdrawal_limit || '0').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(autoRaw)) {
    await req.setFlash('error', 'Auto-withdrawal limit must be an amount like 50 or 50.00 (0 = off). Nothing was saved.');
    return res.redirect(R(req, '/settings'));
  }
  if (lock === null || lock < 24 || lock > 72) {
    await req.setFlash('error', 'Payout-detail change lock must be an integer 24–72 hours (as labelled). Nothing was saved.');
    return res.redirect(R(req, '/settings'));
  }
  if (daily === null || monthly === null || threshold === null || refCap === null) {
    await req.setFlash('error', 'Caps/threshold must be valid amounts (e.g. 500.00). Nothing was saved.');
    return res.redirect(R(req, '/settings'));
  }
  // DS-012: enabling maker-checker with fewer than two approver-capable
  // staff (super/finance) deadlocks every queued action forever - the only
  // approver would be barred from approving their own requests.
  if (threshold > 0) {
    const approvers = (await req.db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND (admin_role IS NULL OR admin_role IN ('super','finance'))")).c;
    if (approvers < 2) {
      await req.setFlash('error', 'Maker-checker needs at least TWO staff accounts that can approve money actions (super or finance role). You currently have ' + approvers + ' - add another approver under Staff first. Nothing was saved.');
      return res.redirect(R(req, '/settings'));
    }
  }
  const keys = { withdrawal_turnover_required: req.body.withdrawal_turnover_required ? '1' : '0', withdrawal_daily_cap: String(daily), withdrawal_monthly_cap: String(monthly), payout_lock_hours: String(lock), maker_checker_threshold: String(threshold), referral_cap_per_referee: String(refCap), auto_withdrawal_limit: autoRaw };
  const changes = {};
  for (const [k, v] of Object.entries(keys)) {
    const old = getS(req.settings, k, '');
    if (old !== v) changes[k] = { from: old, to: v };
    await setSetting(req.db, req.driver, k, v);
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'settings.risk', entity: 'settings', entityId: '', detail: { changes }, ip: req.ip });
  await req.setFlash('success', 'Risk controls saved.');
  res.redirect(R(req, '/settings'));
});
router.post('/settings/kyc', async (req, res) => {
  const gate = String(req.body.kyc_gate || 'withdrawals');
  if (!['withdrawals', 'deposits_and_withdrawals'].includes(gate)) {
    await req.setFlash('error', 'Invalid KYC gate scope. Nothing was saved.');
    return res.redirect(R(req, '/settings'));
  }
  const keys = { kyc_enabled: req.body.kyc_enabled ? '1' : '0', kyc_gate: gate };
  const changes = {};
  for (const [k, v] of Object.entries(keys)) {
    const old = getS(req.settings, k, '');
    if (old !== v) changes[k] = { from: old, to: v };
    await setSetting(req.db, req.driver, k, v);
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'settings.kyc', entity: 'settings', entityId: '', detail: { changes }, ip: req.ip });
  await req.setFlash('success', 'KYC settings saved.');
  res.redirect(R(req, '/settings'));
});
router.post('/settings/phone-countries', async (req, res) => {
  const v = String(req.body.blocked_phone_countries || '').toUpperCase().replace(/[^A-Z,]/g, '');
  const codes = v.split(',').map(x => x.trim()).filter(Boolean);
  if (codes.some(c => !/^[A-Z]{2}$/.test(c))) { await req.setFlash('error', 'Blocked countries must be 2-letter ISO codes, comma-separated. Nothing was saved.'); return res.redirect(R(req, '/settings')); }
  const old = getS(req.settings, 'blocked_phone_countries', '');
  await setSetting(req.db, req.driver, 'blocked_phone_countries', v);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'settings.phone_countries', entity: 'settings', entityId: '', detail: { old: old, new: v }, ip: req.ip });
  await req.setFlash('success', 'Phone country settings saved.');
  res.redirect(R(req, '/settings'));
});
/* U-19 (admin slice): the player backend enforces these exact keys when
   a player opens support tickets. Both must be whole numbers >= 0;
   0 = unlimited. An invalid value rejects the WHOLE save so a bad form
   post can never half-apply one limit while persisting the other. */
router.post('/settings/support-limits', async (req, res) => {
  const keys = ['support_max_open_tickets', 'support_max_new_tickets_24h'];
  const values = {};
  for (const k of keys) {
    const raw = typeof req.body[k] === 'string' ? req.body[k].trim() : '';
    if (!/^\d+$/.test(raw)) { await req.setFlash('error', 'Ticket limits must be whole numbers of 0 or more (0 = unlimited). Nothing was saved.'); return res.redirect(R(req, '/settings')); }
    values[k] = String(parseInt(raw, 10));
  }
  for (const k of keys) await setSetting(req.db, req.driver, k, values[k]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'settings.support_limits', entity: 'settings', entityId: '', detail: values, ip: req.ip });
  await req.setFlash('success', 'Support ticket limits saved.');
  res.redirect(R(req, '/settings'));
});
router.post('/settings/prizes/preview', async (req, res) => {
  /* BP-23(d): multiplier simulator. Parses the SAME fields as the save
     route with the same validation, but writes NOTHING — it renders the
     per-pop RTP table and the projected margin at the CURRENT real
     sales mix so the operator sees the economics before committing.
     RTP per pop count = multiplier/15. The save route's 1–15 clamp
     already makes RTP >100% impossible; the simulator still flags the
     boundary (multiplier 15 = RTP 100% = zero margin on that count). */
  const rows = await req.db.query('SELECT pops_count, multiplier FROM prize_table ORDER BY pops_count');
  const preview = {};
  for (const r of rows) {
    const raw = String(req.body['mult_' + r.pops_count] ?? '').trim();
    if (!/^\d+$/.test(raw) || parseInt(raw, 10) < 1 || parseInt(raw, 10) > 15) {
      await req.setFlash('error', `Simulator: multiplier for ${r.pops_count} pop(s) must be an integer 1–15. Nothing was saved or simulated.`);
      return res.redirect(R(req, '/settings'));
    }
    preview[r.pops_count] = parseInt(raw, 10);
  }
  const mix = await engine.popSalesMix(req.db);
  const mixByPops = Object.fromEntries(mix.map(m => [m.pops, m]));
  const projPreview = await engine.projectedMargin(req.db, preview);
  const current = Object.fromEntries(rows.map(r => [r.pops_count, r.multiplier]));
  const projCurrent = await engine.projectedMargin(req.db, current);
  const fmtPct = (x) => (x === null || x === undefined ? '—' : x.toFixed(1) + '%');
  const body = ui.card('Multiplier simulator — nothing was saved',
    `<p class="muted">Projected margin uses the REAL sales mix (all non-test entries ever sold, weighted by wager). Per-count RTP = multiplier ÷ 15. Margin at mix = 1 − expected payout ÷ stakes at that mix.</p>` +
    ui.table(['Pops', 'Current ×', 'Current RTP', 'Simulated ×', 'Simulated RTP', 'Entries sold', 'Stake share', 'Warning'],
      rows.map(r => {
        const m = mixByPops[r.pops_count];
        const rtpP = engine.popRtpPct(preview[r.pops_count]);
        const totalStake = projPreview.stake || 0;
        return [r.pops_count, '×' + r.multiplier, fmtPct(engine.popRtpPct(r.multiplier)), '×' + preview[r.pops_count], fmtPct(rtpP),
          m ? m.entries : 0, m && totalStake ? (m.stake / totalStake * 100).toFixed(1) + '%' : '—',
          rtpP >= 100 ? '⚠ RTP at 100% — zero margin on this count' : ''];
      })) +
    ui.table(['Scenario', 'Total stakes (history)', 'Expected payout', 'Projected margin'],
      [['Current table', money(req, projCurrent.stake || 0, getS(req.settings, 'base_currency', 'USD')), money(req, projCurrent.expectedPayout || 0, getS(req.settings, 'base_currency', 'USD')), fmtPct(projCurrent.marginPct)],
       ['Simulated table', money(req, projPreview.stake || 0, getS(req.settings, 'base_currency', 'USD')), money(req, projPreview.expectedPayout || 0, getS(req.settings, 'base_currency', 'USD')), fmtPct(projPreview.marginPct)]]) +
    `<p class="mt"><a class="btn" href="${R(req, '/settings')}">Back to settings</a> <span class="muted">To apply the simulated values, enter them in the prize table and use Save prize table.</span></p>`);
  res.send(shell(req, '/settings', 'Multiplier Simulator', body));
});
router.post('/settings/prizes', async (req, res) => {
  // Multipliers are RTP: multiplier/15, so 1..15 keeps RTP <= 100%. The old
  // code silently rewrote bad input to x5 and wrote every row. R-059: a
  // non-integer or out-of-range multiplier now rejects the WHOLE save
  // (nothing is written), and only genuinely changed rows are updated.
  const rows = await req.db.query('SELECT pops_count, multiplier FROM prize_table');
  const parsed = [];
  for (const r of rows) {
    const raw = String(req.body['mult_' + r.pops_count] ?? '').trim();
    if (!/^\d+$/.test(raw)) { await req.setFlash('error', `Prize multiplier for ${r.pops_count} pop(s) must be an integer 1–15. Nothing was saved.`); return res.redirect(R(req, '/settings')); }
    const v = parseInt(raw, 10);
    if (v < 1 || v > 15) { await req.setFlash('error', `Prize multiplier for ${r.pops_count} pop(s) must be 1–15. Nothing was saved.`); return res.redirect(R(req, '/settings')); }
    parsed.push([r, v]);
  }
  const changes = {};
  for (const [r, v] of parsed) {
    if (v !== r.multiplier) {
      changes[r.pops_count] = { from: r.multiplier, to: v };
      await req.db.run('UPDATE prize_table SET multiplier = ? WHERE pops_count = ?', [v, r.pops_count]);
    }
  }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'settings.prizes', entity: 'settings', entityId: '', detail: { changes }, ip: req.ip });
  await req.setFlash('success', 'Prize table saved.');
  res.redirect(R(req, '/settings'));
});
router.post('/settings/currencies', async (req, res) => {
  // R-048: verified against code — the old save stored NEGATIVE rates
  // (parseFloat(-5) is truthy, so `|| 1` never fired; only NaN/0 became 1),
  // allowed duplicate codes and a base currency outside the list, and
  // audited nothing. All four are now enforced; a bad list saves nothing.
  try {
    /* CURRENCY-SYSTEM-01: the card's TABLE form posts rows, not JSON.
       Build the same list shape from the rows and let the ONE existing
       validation below judge both paths. '__new__' in cur_enabled
       marks the add-a-currency row (its code is its own input). */
    let list;
    if (req.body.currencies !== undefined && req.body.currencies !== '') {
      list = JSON.parse(req.body.currencies || '[]');
    } else {
      const arr = (v) => Array.isArray(v) ? v : (v === undefined ? [] : [v]);
      const codes = arr(req.body.cur_code), symbols = arr(req.body.cur_symbol), rates = arr(req.body.cur_rate), decs = arr(req.body.cur_decimals);
      const enabled = new Set(arr(req.body.cur_enabled));
      list = [];
      for (let i = 0; i < codes.length; i++) {
        const code = String(codes[i] || '').toUpperCase().trim();
        if (!code) continue;
        const isNewRow = i === codes.length - 1 && !getCurrencies(req.settings).some(c => c.code === code);
        const on = isNewRow ? (enabled.has('__new__') || enabled.has(code)) : enabled.has(code);
        if (!on) continue;
        const entry = { code, symbol: String(symbols[i] || ''), rate: Number(rates[i]) };
        if (String(decs[i] || '') !== '') entry.decimals = Number(decs[i]);
        list.push(entry);
      }
      if (req.body.exchange_fee_percent !== undefined) {
        const fee = parseFloat(req.body.exchange_fee_percent);
        if (!Number.isFinite(fee) || fee < 0 || fee > 100) throw new Error('Exchange fee must be between 0 and 100.');
        await setSetting(req.db, req.driver, 'exchange_fee_percent', String(fee));
      }
    }
    if (!Array.isArray(list) || !list.length) throw new Error('Currency list must be a non-empty JSON array.');
    const seen = new Set(), cleaned = [];
    for (const c of list) {
      const code = String(c.code || '').toUpperCase().trim();
      if (!/^[A-Z]{2,8}$/.test(code)) throw new Error(`Invalid currency code "${c.code}".`);
      if (seen.has(code)) throw new Error(`Duplicate currency code "${code}".`);
      seen.add(code);
      const symbol = String(c.symbol || '').trim();
      if (!symbol || symbol.length > 8) throw new Error(`Currency ${code} needs a symbol (max 8 chars).`);
      const rate = Number(c.rate);
      if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Currency ${code} needs a finite rate > 0.`);
      const entry = { code, symbol, rate };
      if (c.decimals !== undefined && c.decimals !== null) {
        const dec = Number(c.decimals);
        if (!Number.isInteger(dec) || dec < 0 || dec > 8) throw new Error(`Currency ${code} decimals must be an integer 0–8.`);
        entry.decimals = dec;
      }
      cleaned.push(entry);
    }
    const base = String(req.body.base_currency || '').toUpperCase().trim();
    if (!seen.has(base)) throw new Error(`Base currency "${base}" is not in the currency list.`);
    const oldCur = getS(req.settings, 'currencies', '[]'), oldBase = getS(req.settings, 'base_currency', 'USD');
    await setSetting(req.db, req.driver, 'currencies', JSON.stringify(cleaned));
    await setSetting(req.db, req.driver, 'base_currency', base);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'settings.currencies', entity: 'settings', entityId: '', detail: { old: { currencies: oldCur, base_currency: oldBase }, new: { currencies: JSON.stringify(cleaned), base_currency: base } }, ip: req.ip });
    await req.setFlash('success', 'Currencies saved.');
  } catch (e) { await req.setFlash('error', 'Invalid currencies: ' + e.message + ' Nothing was saved.'); }
  res.redirect(R(req, '/settings'));
});
router.post('/settings/appearance', async (req, res) => {
  const old = {}, nw = {};
  for (const k of ['site_name', 'cookie_text', 'custom_css', 'site_timezone', 'support_notify_email', 'sms_provider']) {
    old[k] = getS(req.settings, k, '');
    nw[k] = String(req.body[k] || '');
  }
  if (nw.site_timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: nw.site_timezone }); } catch { await req.setFlash('error', 'Site timezone is not a valid IANA timezone name. Nothing was saved.'); return res.redirect(R(req, '/settings')); } }
  if (nw.support_notify_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nw.support_notify_email)) { await req.setFlash('error', 'Support notification email is not a valid email address. Nothing was saved.'); return res.redirect(R(req, '/settings')); }
  const changes = {};
  for (const k of Object.keys(nw)) if (old[k] !== nw[k]) changes[k] = { from: String(old[k]).slice(0, 200), to: String(nw[k]).slice(0, 200) };
  for (const k of Object.keys(nw)) await setSetting(req.db, req.driver, k, nw[k]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'settings.appearance', entity: 'settings', entityId: '', detail: { changes }, ip: req.ip });
  await req.setFlash('success', 'Appearance saved.');
  res.redirect(R(req, '/settings'));
});

/* ============================================================ APPROVALS (maker-checker, v14) */
router.get('/approvals', async (req, res) => {
  const open = await req.db.query(`SELECT pa.*, u.email AS requester_email FROM pending_approvals pa LEFT JOIN users u ON u.id = pa.requested_by WHERE pa.status = 'open' ORDER BY pa.created_at DESC`);
  const decided = await req.db.query(`SELECT pa.*, u.email AS requester_email FROM pending_approvals pa LEFT JOIN users u ON u.id = pa.requested_by WHERE pa.status != 'open' ORDER BY pa.created_at DESC LIMIT 50`);
  const row = (a, canDecide) => [a.id, esc(a.action), esc(a.entity) + ' #' + a.entity_id, money(req, a.amount, a.currency), esc(a.requester_email || ('#' + a.requested_by)), d(a.created_at), ui.statusBadge(a.status),
    canDecide ? `<form method="POST" action="${R(req, '/approvals/' + a.id + '/approve')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm btn-g">Approve</button></form>
    <form method="POST" action="${R(req, '/approvals/' + a.id + '/reject')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm btn-d">Reject</button></form>` : ''];
  const body = ui.card('Awaiting second approval', `<p class="muted">Money actions at or above the maker-checker threshold wait here. A DIFFERENT admin must approve — the requester cannot approve their own action. Rejecting leaves the original deposit/withdrawal untouched (still pending).</p>` +
    ui.table(['ID', 'Action', 'Target', 'Amount', 'Requested by', 'Requested', 'Status', ''], open.map(a => row(a, true)))) +
    ui.card('Decided', ui.table(['ID', 'Action', 'Target', 'Amount', 'Requested by', 'Requested', 'Status', ''], decided.map(a => row(a, false))));
  res.send(shell(req, '/approvals', 'Approvals', body, 'Money actions waiting for a second approver.'));
});
router.post('/approvals/:id/approve', async (req, res) => {
  const a = await req.db.get('SELECT * FROM pending_approvals WHERE id = ?', [req.params.id]);
  if (!a || a.status !== 'open') { await req.setFlash('error', 'Approval not found or already decided.'); return res.redirect(R(req, '/approvals')); }
  if (a.requested_by === req.user.id) { await req.setFlash('error', 'You cannot approve your own request — a different admin must approve.'); return res.redirect(R(req, '/approvals')); }
  const { normalizeRole: nrA } = require('../lib/rbac');
  const deciderRole = nrA(req.user);
  const isDrawApproval = String(a.action || '').startsWith('draw.');
  const roleOk = isDrawApproval ? (deciderRole === 'super' || deciderRole === 'risk') : (deciderRole === 'super' || deciderRole === 'finance');
  if (!roleOk) { await req.setFlash('error', 'Your staff role cannot decide this type of approval.'); return res.redirect(R(req, '/approvals')); }
  try {
    // R-013: the queued money actions execute here, with the parameters
    // stored in pending_approvals.detail at queue time. Execution happens
    // BEFORE the approval is marked approved, so a failed execution leaves
    // the approval open for retry instead of silently dropping the action.
    const [entity, decision] = a.action.split('.');
    let det = {};
    try { det = JSON.parse(a.detail || '{}'); } catch {}
    if (a.action === 'withdrawal.mark_paid') {
      await markWithdrawalPaid(req.db, a.entity_id, det.provider_payout_id || '', req.user.id);
    } else if (a.action === 'balance.adjust') {
      const before = (await getBalances(req.db, a.entity_id)).find(w => w.currency === det.currency);
      await req.db.transaction(async (tx) => {
        await postLedger(tx, { userId: a.entity_id, currency: det.currency, type: 'adjustment', amount: det.signed, refType: 'admin_adjustment', refId: 'ADJ' + now(), meta: { remark: det.remark, admin_id: a.requested_by, direction: det.direction, via_approval: a.id } });
      });
      const after = (await getBalances(req.db, a.entity_id)).find(w => w.currency === det.currency);
      await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'user.balance_adjust', entity: 'user', entityId: a.entity_id, detail: { amount: det.signed, currency: det.currency, remark: det.remark, old_balance: before ? before.balance : 0, new_balance: after ? after.balance : 0, via_approval: a.id }, ip: req.ip });
    } else if (a.action === 'agent.float_fund') {
      await fundAgentFloat(req.db, a.entity_id, det.currency, det.amount);
      await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'agent.float_fund', entity: 'user', entityId: a.entity_id, detail: { amount: det.amount, currency: det.currency, note: det.note, via_approval: a.id }, ip: req.ip });
    } else if (a.action === 'agent.commissions_settle') {
      const r = await settleAgentCommissions(req.db, a.entity_id, req.user.id);
      await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'agent.commissions_settled', entity: 'user', entityId: a.entity_id, detail: { settled: r.settled, total: r.total, via_approval: a.id }, ip: req.ip });
    } else if (a.action === 'draw.settle') {
      await settleDraw(req.db, a.entity_id, req.settings, { actorId: req.user.id, ip: req.ip });
    } else if (a.action === 'draw.cancel') {
      await cancelDraw(req.db, a.entity_id, req.settings, { actorId: req.user.id, ip: req.ip });
      await notifyDrawCancelled(req.db, req.settings, a.entity_id);
    } else if (entity === 'deposit') await decideDeposit(req.db, a.entity_id, decision, req.user.id, req.settings, det.decision_reason || '');
    else if (entity === 'withdrawal') await decideWithdrawal(req.db, a.entity_id, decision, req.user.id, '', det.decision_reason || '');
    else throw new Error('Unknown approval action');
    await req.db.run("UPDATE pending_approvals SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?", [req.user.id, now(), a.id]);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'approval.approved', entity: a.entity, entityId: a.entity_id, detail: { approval_id: a.id, action: a.action, amount: a.amount }, ip: req.ip });
    if (entity === 'deposit' && decision === 'approve') {
      const dep = await req.db.get('SELECT * FROM deposits WHERE id = ?', [a.entity_id]);
      const u = await req.db.get('SELECT email, name FROM users WHERE id = ?', [dep.user_id]);
      notify.send(req.db, req.settings, 'email', 'deposit_approved', u.email, { name: u.name, amount: money(req, dep.net, dep.currency) }).catch(() => {});
      try { await releaseReferralCredits(req.db, dep.user_id, req.settings); } catch (e) { console.error('referral release failed:', e.message); }
    }
    if (entity === 'withdrawal' && (decision === 'approve' || decision === 'reject' || decision === 'revoke' || decision === 'mark_paid')) {
      const w = await req.db.get('SELECT * FROM withdrawals WHERE id = ?', [a.entity_id]);
      const u = await req.db.get('SELECT email, name FROM users WHERE id = ?', [w.user_id]);
      notify.send(req.db, req.settings, 'email', 'withdrawal_decided', u.email, { name: u.name, amount: money(req, w.net, w.currency), status: decidedWord(decision) }).catch(() => {});
    }
    await req.setFlash('success', 'Approved and executed.');
  } catch (e) { await req.setFlash('error', 'Execution failed: ' + e.message); }
  res.redirect(R(req, '/approvals'));
});
router.post('/approvals/:id/reject', async (req, res) => {
  const a = await req.db.get('SELECT * FROM pending_approvals WHERE id = ?', [req.params.id]);
  if (!a || a.status !== 'open') { await req.setFlash('error', 'Approval not found or already decided.'); return res.redirect(R(req, '/approvals')); }
  if (a.requested_by === req.user.id) { await req.setFlash('error', 'You cannot decide your own request.'); return res.redirect(R(req, '/approvals')); }
  const { normalizeRole: nrA } = require('../lib/rbac');
  const deciderRole = nrA(req.user);
  const isDrawApproval = String(a.action || '').startsWith('draw.');
  const roleOk = isDrawApproval ? (deciderRole === 'super' || deciderRole === 'risk') : (deciderRole === 'super' || deciderRole === 'finance');
  if (!roleOk) { await req.setFlash('error', 'Your staff role cannot decide this type of approval.'); return res.redirect(R(req, '/approvals')); }
  await req.db.run("UPDATE pending_approvals SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?", [req.user.id, now(), a.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'approval.rejected', entity: a.entity, entityId: a.entity_id, detail: { approval_id: a.id, action: a.action }, ip: req.ip });
  // R-053: a rejection used to notify nobody — the requester never learned
  // their action was refused, and the player saw a stuck item. Notify the
  // requesting admin, and the player for player-visible items.
  try {
    const requester = await req.db.get('SELECT email, name FROM users WHERE id = ?', [a.requested_by]);
    if (requester && requester.email) notify.send(req.db, req.settings, 'email', 'approval_rejected', requester.email, { name: requester.name, action: a.action, amount: money(req, a.amount, a.currency) }).catch(() => {});
    if (a.entity === 'deposit') {
      const dep = await req.db.get('SELECT * FROM deposits WHERE id = ?', [a.entity_id]);
      if (dep) {
        const u = await req.db.get('SELECT email, name FROM users WHERE id = ?', [dep.user_id]);
        if (u) notify.send(req.db, req.settings, 'email', 'deposit_rejected', u.email, { name: u.name, amount: money(req, dep.net, dep.currency) }).catch(() => {});
      }
    } else if (a.entity === 'withdrawal') {
      const w = await req.db.get('SELECT * FROM withdrawals WHERE id = ?', [a.entity_id]);
      if (w) {
        const u = await req.db.get('SELECT email, name FROM users WHERE id = ?', [w.user_id]);
        if (u) notify.send(req.db, req.settings, 'email', 'withdrawal_decided', u.email, { name: u.name, amount: money(req, w.net, w.currency), status: 'rejected' }).catch(() => {});
      }
    }
  } catch {}
  await req.setFlash('success', 'Approval rejected. The original item is untouched.');
  res.redirect(R(req, '/approvals'));
});

/* ============================================================ RECONCILIATION (v14) */
router.get('/reconciliation', async (req, res) => {
  const reports = await req.db.query('SELECT * FROM reconciliation_reports ORDER BY checked_at DESC LIMIT 30');
  const latest = reports[0];
  let detailHtml = '';
  if (latest) {
    let det = {};
    try { det = JSON.parse(latest.details || '{}'); } catch {}
    detailHtml = ui.card('Latest report — ' + dPlain(latest.checked_at), `<p>Wallets checked: ${latest.wallets_checked} · Mismatches: <strong>${latest.mismatch_count}</strong> · Provider txns without webhook events: ${(det.unconfirmed_provider_txns || []).length} · Stale proof deposits: ${(det.stale_proof_deposits || []).length}</p>` +
      (det.mismatches && det.mismatches.length ? ui.table(['User', 'Currency', 'Wallet', 'Ledger', 'Diff'], det.mismatches.map(m => ['#' + m.user_id, esc(m.currency), money(req, m.wallet || 0, m.currency), money(req, m.ledger, m.currency), money(req, m.diff, m.currency)])) : '<p class="muted">No wallet/ledger mismatches.</p>') +
      ((det.unconfirmed_provider_txns || []).length ? ui.table(['Deposit', 'Provider txn ID'], det.unconfirmed_provider_txns.map(x => [`<span class="code">${esc(x.public_id)}</span>`, `<span class="code">${esc(x.provider_txn_id)}</span>`])) : '') +
      ((det.stale_proof_deposits || []).length ? ui.table(['Stale proof deposit'], det.stale_proof_deposits.map(x => [`<span class="code">${esc(x.public_id)}</span>`])) : ''));
  }
  const body = ui.card('Run reconciliation', `<p class="muted">Proves wallets == ledger per user/currency, lists deposits claiming a provider transaction with no matching webhook event, and stale proof-carrying pending deposits. Runs nightly via cron; run on demand here.</p>` +
    ui.formHtml(R(req, '/reconciliation/run'), [], { csrf: req.csrfToken, submit: 'Run now' })) +
    detailHtml +
    ui.card('History', ui.table(['When', 'Wallets', 'Mismatches'], reports.map(r => [d(r.checked_at), r.wallets_checked, r.mismatch_count])));
  res.send(shell(req, '/reconciliation', 'Reconciliation', body, 'Proof that wallets and the ledger agree.'));
});
router.post('/reconciliation/run', async (req, res) => {
  try {
    const r = await runReconciliation(req.db);
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'reconciliation.run', entity: 'reconciliation', entityId: '', detail: { wallets_checked: r.wallets_checked, mismatch_count: r.mismatch_count, unconfirmed: r.unconfirmed }, ip: req.ip });
    await req.setFlash('success', `Reconciliation done: ${r.wallets_checked} wallets, ${r.mismatch_count} mismatch(es), ${r.unconfirmed} unconfirmed provider txn(s).`);
  } catch (e) { await req.setFlash('error', 'Reconciliation failed: ' + e.message); }
  res.redirect(R(req, '/reconciliation'));
});

/* ============================================================ FRAUD FLAGS (v14) */
router.get('/flags', async (req, res) => {
  const open = await req.db.query(`SELECT f.*, u.email FROM account_flags f JOIN users u ON u.id = f.user_id WHERE f.reviewed_at IS NULL ORDER BY f.created_at DESC`);
  const done = await req.db.query(`SELECT f.*, u.email FROM account_flags f JOIN users u ON u.id = f.user_id WHERE f.reviewed_at IS NOT NULL ORDER BY f.created_at DESC LIMIT 50`);
  const table = (rows, showReview) => ui.table(['When', 'User', 'Flag', 'Detail', 'Reviewed', ''], rows.map(f => [d(f.created_at), esc(f.email) + ` (<a href="${R(req, '/users/' + f.user_id)}">#${f.user_id}</a>)`, esc(FLAG_LABELS[f.flag_type] || String(f.flag_type || '').replace(/_/g, ' ')), esc(flagDetailText(f.detail)), f.reviewed_at ? '✓ ' + d(f.reviewed_at) : '—',
    showReview ? `<form method="POST" action="${R(req, '/flags/' + f.id + '/review')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><button class="btn btn-sm">Mark reviewed</button></form>` : '']));
  const body = ui.card('Open flags — review only, never auto-ban', `<p class="muted">Shared device/IP across accounts is a signal, not proof: households, agents and VPNs share IPs legitimately. Review and decide; the system never bans on a flag alone.</p>` + table(open, true)) +
    ui.card('Reviewed', table(done, false));
  res.send(shell(req, '/flags', 'Fraud Flags', body, 'Automatic risk flags that need a human look.'));
});
router.post('/flags/:id/review', async (req, res) => {
  const r = await req.db.run('UPDATE account_flags SET reviewed_by = ?, reviewed_at = ? WHERE id = ? AND reviewed_at IS NULL', [req.user.id, now(), req.params.id]);
  if (r.changes !== 1) { await req.setFlash('error', 'Flag not found or already reviewed.'); return res.redirect(R(req, '/flags')); }
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'fraud.flag_reviewed', entity: 'flag', entityId: req.params.id, detail: {}, ip: req.ip });
  await req.setFlash('success', 'Flag marked reviewed.');
  res.redirect(R(req, '/flags'));
});

/* ============================================================ STAFF & ROLES (v14) */
/* ================= ADMIN-SELF-01: My Account (self-service) ======
   The panel's own account page. Every handler operates ONLY on
   req.user.id — no id is read from the client, ever — so this page
   can never become a path into another admin's account (the generic
   user handlers keep refusing admin targets exactly as before). */
router.get('/my-account', async (req, res) => {
  const me = await req.db.get('SELECT id, name, email, role, admin_role, force_password_reset FROM users WHERE id = ?', [req.user.id]);
  res.send(shell(req, '/my-account', 'My Account',
    ui.card('Display name', `
      <form method="POST" action="${R(req, '/my-account/name')}" class="adm-form">
        <input type="hidden" name="_csrf" value="${req.csrfToken}">
        <div class="field"><label for="myname">Display name</label><input type="text" id="myname" name="name" required maxlength="80" value="${esc(me.name || '')}"></div>
        <div class="mt"><button class="btn btn-p" type="submit">Save name</button></div>
      </form>`) +
    ui.card('Login email', `
      <p class="muted">This is the email you sign in with. Changing it needs your current password. If email delivery is set up, the new address must click a verification link before the change applies; if it is not set up, the change applies straight away.</p>
      <form method="POST" action="${R(req, '/my-account/email')}" class="adm-form">
        <input type="hidden" name="_csrf" value="${req.csrfToken}">
        <div class="field"><label for="myemail">New login email</label><input type="email" id="myemail" name="new_email" required value="${esc(me.email || '')}"></div>
        <div class="field"><label for="myemailpw">Current password</label><input type="password" id="myemailpw" name="current_password" required autocomplete="current-password"></div>
        <div class="mt"><button class="btn btn-p" type="submit">Change login email</button></div>
      </form>`) +
    ui.card('Password', `
      ${me.force_password_reset ? '<p class="muted"><strong>Note:</strong> your account is currently flagged "must change password at next sign-in". Changing it here clears that flag.</p>' : ''}
      <form method="POST" action="${R(req, '/my-account/password')}" class="adm-form">
        <input type="hidden" name="_csrf" value="${req.csrfToken}">
        <div class="field"><label for="mypw0">Current password</label><input type="password" id="mypw0" name="current_password" required autocomplete="current-password"></div>
        <div class="field"><label for="mypw1">New password</label><input type="password" id="mypw1" name="new_password" required autocomplete="new-password"></div>
        <div class="field"><label for="mypw2">Confirm new password</label><input type="password" id="mypw2" name="new_password_confirm" required autocomplete="new-password"></div>
        <div class="mt"><button class="btn btn-p" type="submit">Change password</button></div>
      </form>
      <p class="muted">Changing your password signs out your OTHER sessions; this one stays signed in.</p>`) +
    ui.card('Hosting note', `<p class="muted">On the current free hosting plan, if the database is ever wiped, this admin account is re-created from the hosting seed values — name, login email and password changed here would revert unless the seed values are updated to match, or the paid disk plan is in place.</p>`), 'Your own staff account — name, sign-in email and password.'));
});

router.post('/my-account/name', async (req, res) => {
  const back = R(req, '/my-account');
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) { await req.setFlash('error', 'Name cannot be empty.'); return res.redirect(back); }
  const old = await req.db.get('SELECT name FROM users WHERE id = ?', [req.user.id]);
  await req.db.run('UPDATE users SET name = ? WHERE id = ?', [name, req.user.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'admin.self_name', entity: 'user', entityId: req.user.id, detail: { from: old ? old.name : '', to: name }, ip: req.ip });
  await req.setFlash('success', 'Display name saved.');
  res.redirect(back);
});

router.post('/my-account/email', async (req, res) => {
  const back = R(req, '/my-account');
  const me = await req.db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const fail = async (msg, reason) => {
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'admin.self_email', entity: 'user', entityId: req.user.id, detail: { ok: false, reason }, ip: req.ip });
    await req.setFlash('error', msg);
    return res.redirect(back);
  };
  if (!me.password_hash || !verifyPassword(String(req.body.current_password || ''), me.password_hash))
    return fail('Login email NOT changed: your current password is incorrect.', 'current_password');
  const email = normalizeEmail(req.body.new_email);
  if (!validEmail(email)) return fail('Login email NOT changed: that is not a valid email address.', 'invalid_email');
  if (email === String(me.email || '').toLowerCase()) return fail('That is already your login email.', 'same_email');
  const dup = await req.db.get('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user.id]);
  if (dup) return fail('Login email NOT changed: that email is already used by another account.', 'duplicate_email');
  /* Reuse the standard email_verifications machinery: the swap only
     happens when the NEW address clicks its link (routes/auth
     /verify-email/:token, with its own duplicate re-check). If email
     delivery is not configured the send reports non-'sent' — then the
     pending row is burned and the change applies immediately, and the
     page says so plainly. */
  await req.db.run('UPDATE email_verifications SET used = 1 WHERE user_id = ? AND used = 0', [req.user.id]);
  const token = randHex(24);
  await req.db.run('INSERT INTO email_verifications (user_id, new_email, token_hash, expires_at, used, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    [req.user.id, email, sha256('verify:' + token), now() + 24 * 3600 * 1000, now()]);
  const link = (process.env.BASE_URL || (req.protocol + '://' + req.get('host'))) + '/verify-email/' + token;
  const sent = await notify.send(req.db, req.settings, 'email', 'email_verification', email, { name: me.name, link }).catch(() => ({ status: 'failed' }));
  if (sent.status === 'sent') {
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'admin.self_email', entity: 'user', entityId: req.user.id, detail: { ok: true, pending_verification: true, to: email }, ip: req.ip });
    await req.setFlash('success', 'Verification link sent to ' + email + '. Your login email changes when that link is clicked.');
    return res.redirect(back);
  }
  await req.db.run('UPDATE email_verifications SET used = 1 WHERE user_id = ? AND used = 0', [req.user.id]);
  await req.db.run('UPDATE users SET email = ?, email_verified = 1 WHERE id = ?', [email, req.user.id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'admin.self_email', entity: 'user', entityId: req.user.id, detail: { ok: true, applied: 'immediate_email_not_configured', to: email }, ip: req.ip });
  await req.setFlash('success', 'Login email changed to ' + email + '. (Email delivery is not configured, so no verification link was sent and the change applied straight away.)');
  res.redirect(back);
});

router.post('/my-account/password', async (req, res) => {
  const back = R(req, '/my-account');
  const me = await req.db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const fail = async (msg, reason) => {
    await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'admin.self_password', entity: 'user', entityId: req.user.id, detail: { ok: false, reason }, ip: req.ip });
    await req.setFlash('error', msg);
    return res.redirect(back);
  };
  if (!me.password_hash || !verifyPassword(String(req.body.current_password || ''), me.password_hash))
    return fail('Password NOT changed: your current password is incorrect.', 'current_password');
  const { passwordError } = require('../lib/validate');
  const { isBreached } = require('../lib/breached');
  const pw = String(req.body.new_password || '');
  const pw2 = String(req.body.new_password_confirm || '');
  let err = passwordError(pw, me.role, getBool(req.settings, 'secure_password', true));
  if (!err && pw !== pw2) err = 'Passwords do not match.';
  if (!err && getBool(req.settings, 'breached_password_check', true) && await isBreached(pw)) err = 'This password has appeared in a data breach. Please choose a different one.';
  if (err) return fail('Password NOT changed: ' + err, 'validation');
  await req.db.run('UPDATE users SET password_hash = ?, force_password_reset = 0 WHERE id = ?', [hashPassword(pw), req.user.id]);
  // Mirror the forced-reset pattern: kill every OTHER session, keep this one.
  await destroyUserSessions(req.db, req.user.id, req.sess ? req.sess.id : null);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'admin.self_password', entity: 'user', entityId: req.user.id, detail: { ok: true }, ip: req.ip });
  await req.setFlash('success', 'Password changed. Your other sessions were signed out.');
  res.redirect(back);
});

router.get('/staff', async (req, res) => {
  const staff = await req.db.query("SELECT * FROM users WHERE role = 'admin' ORDER BY created_at");
  const isSuper = (req.user.admin_role || 'super') === 'super';
  const createCard = isSuper ? ui.card('Create staff account', `<p class="muted">Staff roles: super (everything), finance (money actions), support (support tickets), risk (user safety + draws + flags). Views are readable by all staff; actions enforce the role. New staff must set a 12+ character password${getBool(req.settings, 'admin_totp_required', false) ? ' and enroll an authenticator before doing anything' : ''}.</p>` +
    ui.formHtml(R(req, '/staff'), [
      { key: 'name', label: 'Name', type: 'text', required: true },
      { key: 'email', label: 'Email', type: 'text', required: true },
      { key: 'password', label: 'Password (12+ chars)', type: 'text', required: true },
      { key: 'admin_role', label: 'Role', type: 'select', options: ['super', 'finance', 'support', 'risk'], value: 'support' },
    ], { csrf: req.csrfToken, submit: 'Create staff' })) : ui.card('Create staff account', '<p class="muted">Only super admins can create staff accounts.</p>');
  const body = createCard +
    ui.card('Staff', ui.table(['ID', 'Name', 'Email', 'Role', 'TOTP', 'Joined', ''], staff.map(s => [s.id, esc(s.name), esc(s.email), esc(s.admin_role || 'super'), s.totp_secret ? ui.badge('on', 'ok') : ui.badge('off', 'muted'), d(s.created_at),
      s.id === req.user.id ? '<span class="muted">you</span>'
      : isSuper ? `<form method="POST" action="${R(req, '/staff/' + s.id + '/role')}" style="display:inline"><input type="hidden" name="_csrf" value="${req.csrfToken}"><select name="admin_role">${['super', 'finance', 'support', 'risk'].map(r => `<option value="${r}"${(s.admin_role || 'super') === r ? ' selected' : ''}>${r}</option>`).join('')}</select><button class="btn btn-sm">Change role</button></form>`
      : '<span class="muted">—</span>'])));
  res.send(shell(req, '/staff', 'Staff', body, 'Staff accounts and what each role may do.'));
});
router.post('/staff', async (req, res) => {
  /* U-20.4: raw body destructuring 500'd on object-typed fields
     (name[a]=b -> name.trim is not a function). Accept strings only. */
  const name = typeof req.body.name === 'string' ? req.body.name : '';
  const email = typeof req.body.email === 'string' ? req.body.email : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const admin_role = req.body.admin_role;
  const role = ['super', 'finance', 'support', 'risk'].includes(admin_role) ? admin_role : 'support';
  const pwErr = passwordError(password, 'admin', getBool(req.settings, 'secure_password', true));
  if (!name || !validEmail(email) || pwErr) { await req.setFlash('error', pwErr || 'Name and valid email required.'); return res.redirect(R(req, '/staff')); }
  if (getBool(req.settings, 'breached_password_check', true) && await isBreached(password)) { await req.setFlash('error', 'This password has appeared in a data breach. Choose a different one.'); return res.redirect(R(req, '/staff')); }
  const dup = await req.db.get('SELECT id FROM users WHERE email = ?', [email.trim().toLowerCase()]);
  if (dup) { await req.setFlash('error', 'An account with that email already exists.'); return res.redirect(R(req, '/staff')); }
  const forceTotp = getBool(req.settings, 'admin_totp_required', false) ? 1 : 0;
  const r = await req.db.run("INSERT INTO users (email, name, password_hash, role, admin_role, status, email_verified, force_totp_enroll, created_at) VALUES (?, ?, ?, 'admin', ?, 'active', 1, ?, ?)",
    [email.trim().toLowerCase(), name.trim(), hashPassword(password), role, forceTotp, now()]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'staff.create', entity: 'user', entityId: r.id, detail: { admin_role: role }, ip: req.ip });
  await req.setFlash('success', 'Staff account created' + (forceTotp ? ' — they must enroll an authenticator on first sign-in.' : '.'));
  res.redirect(R(req, '/staff'));
});
router.post('/staff/:id/role', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (id === req.user.id) { await req.setFlash('error', 'You cannot change your own role.'); return res.redirect(R(req, '/staff')); }
  const role = ['super', 'finance', 'support', 'risk'].includes(req.body.admin_role) ? req.body.admin_role : null;
  if (!role) { await req.setFlash('error', 'Invalid role.'); return res.redirect(R(req, '/staff')); }
  const old = await req.db.get("SELECT admin_role FROM users WHERE id = ? AND role = 'admin'", [id]);
  if (!old) return notFound(req, res, 'Staff not found.');
  await req.db.run("UPDATE users SET admin_role = ? WHERE id = ?", [role, id]);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'staff.role_change', entity: 'user', entityId: id, detail: { old_role: old.admin_role || 'super', new_role: role }, ip: req.ip });
  await req.setFlash('success', 'Role updated.');
  res.redirect(R(req, '/staff'));
});

/* ============================================================ ADMIN SECURITY — TOTP enrollment (v14) */
/* AUTH-CHANNELS-01: one truthful row per sign-in / verification channel.
   CONFIGURED comes from ENV PRESENCE ONLY (booleans — never values);
   the last delivery result comes from the notifications outbox. */
async function channelHealth(req) {
  const smsProvider = process.env.SMS_PROVIDER || getS(req.settings, 'sms_provider', '');
  const smsNamed = smsProvider === 'textbelt' ? 'TextBelt' : (smsProvider === 'twilio' || process.env.TWILIO_SID ? 'Twilio' : '');
  const smsConfigured = smsProvider === 'textbelt' ? !!process.env.TEXTBELT_KEY : !!(process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_FROM);
  const lastEmail = await req.db.get("SELECT status, error, created_at FROM notifications_log WHERE channel = 'email' ORDER BY id DESC LIMIT 1").catch(() => null);
  const lastSms = await req.db.get("SELECT status, error, created_at FROM notifications_log WHERE channel = 'sms' ORDER BY id DESC LIMIT 1").catch(() => null);
  const totpCount = await req.db.get("SELECT COUNT(*) AS c FROM users WHERE role IN ('admin','staff') AND totp_secret IS NOT NULL AND totp_secret != ''").catch(() => ({ c: 0 }));
  const lastStr = r => r ? `${esc(r.status)} · ${d(r.created_at)}${r.error ? ' · ' + esc(String(r.error).slice(0, 80)) : ''}` : '<span class="muted">no deliveries yet</span>';
  const conf = ok => ok ? ui.badge('CONFIGURED', 'ok') : ui.badge('NOT CONFIGURED', 'bad');
  const rows = [
    ['Email (SMTP)', conf(!!process.env.SMTP_HOST), `Login/register OTP: ${getBool(req.settings, 'email_otp_enabled', false) ? 'ON' : 'OFF'} · Withdrawal OTP uses this or SMS`, lastStr(lastEmail)],
    ['SMS' + (smsNamed ? ' (' + smsNamed + ')' : ''), conf(smsConfigured), `Phone OTP login: ${getBool(req.settings, 'phone_otp_enabled', false) ? 'ON' : 'OFF'} · set the provider under Notifications`, lastStr(lastSms)],
    ['Google sign-in', conf(!!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)), `Toggle: ${getBool(req.settings, 'google_oauth_enabled', false) ? 'ON' : 'OFF'} (Settings → Toggles)`, '<span class="muted">sign-ins are not deliveries — see Login History</span>'],
    ['Facebook sign-in', conf(!!(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET)), `Toggle: ${getBool(req.settings, 'facebook_oauth_enabled', false) ? 'ON' : 'OFF'} (Settings → Toggles)`, '<span class="muted">sign-ins are not deliveries — see Login History</span>'],
    ['Authenticator (TOTP) 2FA', conf(Number(totpCount.c) > 0), `${Number(totpCount.c)} staff account(s) enrolled · owner-verified live 2026-10-29`, '<span class="muted">verified at sign-in, nothing is sent</span>'],
  ];
  return `<div class="tbl-wrap"><table class="tbl"><tr><th>Channel</th><th>State</th><th>Notes</th><th>Last delivery</th></tr>${rows.map(r => `<tr><td><strong>${r[0]}</strong></td><td>${r[1]}</td><td>${r[2]}</td><td>${r[3]}</td></tr>`).join('')}</table></div>
  <p class="muted">NOT CONFIGURED is not a bug: until the owner adds the provider details (see the setup checklist), that channel honestly refuses on the player side instead of pretending a code was sent.</p>
  <form method="POST" action="${R(req, '/security/test-email')}" style="display:inline-block;margin-right:8px"><input type="hidden" name="_csrf" value="${req.csrfToken}"><div class="field" style="display:inline-block"><label for="test_email_to">Send test email to</label><input id="test_email_to" type="email" name="to" required placeholder="you@example.com"></div> <button class="btn btn-p" type="submit">Send test email</button></form>
  <form method="POST" action="${R(req, '/security/test-sms')}" style="display:inline-block"><input type="hidden" name="_csrf" value="${req.csrfToken}"><div class="field" style="display:inline-block"><label for="test_sms_to">Send test SMS to</label><input id="test_sms_to" type="text" name="to" required placeholder="+1..."></div> <button class="btn btn-p" type="submit">Send test SMS</button></form>`;
}
const testSendLimiter = rateLimit({ windowMs: 3600000, max: 5, keyFn: req => 'test-send:' + req.user.id });
router.post('/security/test-email', testSendLimiter, async (req, res) => {
  const to = String(req.body.to || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) { await req.setFlash('error', 'Enter a valid email address for the test.'); return res.redirect(R(req, '/security')); }
  const r = await notify.sendRaw(req.db, req.settings, 'email', to, 'Cash Pop test email', 'This is a test email from your Cash Pop admin panel. If you received it, email delivery works.');
  await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'security.test_send', entity: 'notification', entityId: '', detail: { channel: 'email', status: r.status }, ip: req.ip });
  if (r.status === 'sent') await req.setFlash('success', 'Test email sent to ' + to + '.');
  else await req.setFlash('error', 'Test email FAILED (' + r.status + ')' + (r.error ? ': ' + r.error : '') + ' — the channel is not delivering yet.');
  res.redirect(R(req, '/security'));
});
router.post('/security/test-sms', testSendLimiter, async (req, res) => {
  const to = String(req.body.to || '').trim();
  if (!to || to.length < 7) { await req.setFlash('error', 'Enter a valid phone number for the test.'); return res.redirect(R(req, '/security')); }
  const r = await notify.sendRaw(req.db, req.settings, 'sms', to, '', 'Cash Pop test SMS: if you received this, SMS delivery works.');
  await audit.log(req.db, { actorId: req.user.id, actorRole: req.user.role, action: 'security.test_send', entity: 'notification', entityId: '', detail: { channel: 'sms', status: r.status }, ip: req.ip });
  if (r.status === 'sent') await req.setFlash('success', 'Test SMS sent to ' + to + '.');
  else await req.setFlash('error', 'Test SMS FAILED (' + r.status + ')' + (r.error ? ': ' + r.error : '') + ' — the channel is not delivering yet.');
  res.redirect(R(req, '/security'));
});
router.get('/security', async (req, res) => {
  const u = await req.db.get('SELECT totp_secret FROM users WHERE id = ?', [req.user.id]);
  const enforced = getBool(req.settings, 'admin_totp_required', false);
  const health = await channelHealth(req);
  res.send(shell(req, '/security', 'Security', ui.card('Login & verification health', health) + ui.card('Authenticator (TOTP)', `
    <p class="muted">Your authenticator protects the admin panel. ${enforced ? 'TOTP is REQUIRED for admins on this site.' : 'TOTP is not required for admins yet. Enroll first, then turn on "Admin TOTP required" in Settings → Toggles.'}</p>
    <p>Status: ${u.totp_secret ? ui.badge('enabled', 'ok') : ui.badge('not enrolled', 'warn')}</p>
    ${u.totp_secret
      ? `<form method="POST" action="${R(req, '/security/totp/disable')}"><input type="hidden" name="_csrf" value="${req.csrfToken}"><div class="field"><label>Password (to confirm)</label><input type="password" name="password" required></div><div class="field"><label>Current authenticator code (or a backup code)</label><input type="text" name="totp_code" required autocomplete="off"></div><button class="btn btn-d" type="submit">Disable authenticator</button></form>`
      : `<form method="POST" action="${R(req, '/security/totp/start')}"><input type="hidden" name="_csrf" value="${req.csrfToken}"><div class="field"><label>Password (to confirm)</label><input type="password" name="password" required></div><button class="btn btn-p" type="submit">Enroll authenticator</button></form>`}
  `), 'Sign-in security — authenticator, sessions and login channel health.'));
});
router.post('/security/totp/start', rateLimit({ windowMs: 15 * 60000, max: 10, keyFn: req => `admin-totp:${req.user.id}` }), async (req, res) => {
  /* D2-C3 (v20): enrolment requires the current password, mirroring
     the disable handler below (same field, same refusal). Admin
     accounts always have a password, so no passwordless branch. */
  {
    const u = await req.db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const { verifyPassword: vpA } = require('../lib/util');
    if (!u || !vpA(req.body.password || '', u.password_hash || '')) { await req.setFlash('error', 'Wrong password.'); return res.redirect(R(req, '/security')); }
  }
  const authLib = require('../lib/auth');
  const secret = authLib.newTotpSecret();
  await authLib.touchSession(req.db, req.sess.id, { admin_totp_pending: secret });
  const uri = authLib.totpUri(secret, req.user.email, getS(req.settings, 'site_name', 'Cash Pop'));
  const qrDataUrl = await QRCode.toDataURL(uri);
  res.send(shell(req, '/security', 'Enroll Authenticator', ui.card('Scan with your authenticator app', `
    <p><img src="${qrDataUrl}" alt="TOTP QR code" style="width:200px;height:200px"></p>
    <p class="muted">Or enter this secret manually: <span class="code">${esc(secret)}</span></p>
    <form method="POST" action="${R(req, '/security/totp/confirm')}"><input type="hidden" name="_csrf" value="${req.csrfToken}">
    <div class="field"><label>Password (to confirm)</label><input type="password" name="password" required></div>
    <div class="field"><label>6-digit code from your app</label><input type="text" name="totp_code" required autocomplete="off"></div>
    <button class="btn btn-p" type="submit">Verify & enable</button></form>`)));
});
router.post('/security/totp/confirm', rateLimit({ windowMs: 15 * 60000, max: 10, keyFn: req => `admin-totp:${req.user.id}` }), async (req, res) => {
  // D2-C3: password required again at confirm (mid-enrolment theft cannot finish it).
  {
    const u = await req.db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
    const { verifyPassword: vpB } = require('../lib/util');
    if (!u || !vpB(req.body.password || '', u.password_hash || '')) { await req.setFlash('error', 'Wrong password.'); return res.redirect(R(req, '/security')); }
  }
  const secret = req.sessionData.admin_totp_pending;
  if (!secret) { await req.setFlash('error', 'Setup session expired. Start again.'); return res.redirect(R(req, '/security')); }
  if (!verifyTotp(secret, req.body.totp_code)) { await req.setFlash('error', 'Invalid code. Try again.'); return res.redirect(R(req, '/security')); }
  const authLib = require('../lib/auth');
  const codes = authLib.newBackupCodes(8);
  const enrollStepA = authLib.verifyTotpStep(secret, req.body.totp_code);
  if (enrollStepA !== null) await req.db.run('UPDATE users SET totp_last_step = ? WHERE id = ?', [enrollStepA, req.user.id]);
  await req.db.run('UPDATE users SET totp_secret = ?, backup_codes = ?, force_totp_enroll = 0 WHERE id = ?', [secret, authLib.hashBackupCodes(codes), req.user.id]);
  await authLib.touchSession(req.db, req.sess.id, { admin_totp_pending: null });
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'admin.totp_enable', entity: 'user', entityId: req.user.id, detail: {}, ip: req.ip });
  res.send(shell(req, '/security', 'Authenticator Enabled', ui.card('Backup codes', `<p class="muted">Save these somewhere safe — each works once if you lose your authenticator.</p><p class="code">${codes.join('<br>')}</p><p><a class="btn btn-p" href="${R(req, '/security')}">Done</a></p>`)));
});
router.post('/security/totp/disable', rateLimit({ windowMs: 15 * 60000, max: 10, keyFn: req => `admin-totp:${req.user.id}` }), async (req, res) => {
  // Refuse while enforcement is ON: disabling would violate the enforced policy.
  if (getBool(req.settings, 'admin_totp_required', false)) {
    await req.setFlash('error', 'Cannot disable: two-factor authentication is required for admins on this site. Turn off "Admin TOTP required" in Settings first.');
    return res.redirect(R(req, '/security'));
  }
  const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const { verifyPassword } = require('../lib/util');
  if (!verifyPassword(req.body.password || '', u.password_hash || '')) { await req.setFlash('error', 'Wrong password.'); return res.redirect(R(req, '/security')); }
  // R-054: a password alone must not defeat the second factor — require a
  // current authenticator code or a backup code (mirrors the player flow).
  // Disabling also invalidates the backup codes, so a used backup code
  // cannot be replayed afterwards.
  const { useBackupCode } = require('../lib/auth');
  const code = String(req.body.totp_code || '').trim();
  let secondOk = !!(u.totp_secret && verifyTotp(u.totp_secret, code));
  if (!secondOk && u.backup_codes) secondOk = useBackupCode(u.backup_codes, code) !== null;
  if (!secondOk) { await req.setFlash('error', 'Invalid authenticator code.'); return res.redirect(R(req, '/security')); }
  await req.db.run("UPDATE users SET totp_secret = '', backup_codes = '[]' WHERE id = ?", [req.user.id]);
  // Parity with the player flow (R-123): disabling 2FA revokes other sessions.
  await destroyUserSessions(req.db, req.user.id, req.sess ? req.sess.id : null);
  await audit.log(req.db, { actorId: req.user.id, actorRole: 'admin', action: 'admin.totp_disable', entity: 'user', entityId: req.user.id, detail: { other_sessions_revoked: true }, ip: req.ip });
  await req.setFlash('success', 'Authenticator disabled.');
  res.redirect(R(req, '/security'));
});

/* ============================================================ AUDIT TRAIL */
router.get('/audit', async (req, res) => {
  const page = pageOf(req), q = req.query.q || '';
  const actor = req.query.actor ? parseInt(req.query.actor, 10) : null;
  const whereParts = [], params = [];
  if (q) { whereParts.push('(LOWER(action) LIKE LOWER(?) OR LOWER(entity) LIKE LOWER(?) OR LOWER(detail) LIKE LOWER(?))'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  if (actor) { whereParts.push('actor_id = ?'); params.push(actor); }
  const where = whereParts.length ? 'WHERE ' + whereParts.join(' AND ') : '';
  const total = (await req.db.get(`SELECT COUNT(*) AS c FROM audit_log ${where}`, params)).c;
  const rows = await req.db.query(`SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, [...params, PER, (page - 1) * PER]);
  const chain = await audit.verifyChain(req.db).catch(() => ({ ok: false, checked: 0, firstBadId: null, reason: 'verify failed' }));
  const chainBanner = chain.ok
    ? `<div class="alert a-ok">Audit chain verified: ${chain.checked} chained row(s), no tampering detected.</div>`
    : `<div class="alert a-err">Audit chain BROKEN at row #${chain.firstBadId} (${esc(chain.reason)}). Investigate immediately.</div>`;
  const body = chainBanner + ui.filtersHtml(R(req, '/audit'), [{ key: 'q', label: 'Search action/entity' }], req.query) +
    ui.table(['When', 'Actor', 'Action', 'Entity', 'IP', 'Detail'], rows.map(a =>
      [d(a.created_at), `${esc(a.actor_role || '?')} #${a.actor_id || '—'}`, esc(a.action), auditEntityHtml(a), esc(a.ip), auditDetailHtml(req, a.detail)])) +
    ui.paginate(`${R(req, '/audit')}?q=${encodeURIComponent(q)}${actor ? '&actor=' + actor : ''}`, page, PER, total);
  res.send(shell(req, '/audit', 'Audit Trail', body, 'Every important action, recorded and tamper-evident.'));
});

module.exports = router;
