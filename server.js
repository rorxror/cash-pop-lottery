'use strict';
/* Cash Pop Lottery — standalone server (cPanel-ready).
   Node 22+, pure-JS deps, SQLite built-in, MySQL optional via env. */
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const ejs = require('ejs');

// ---- tiny .env loader (no dependency) ----
(function loadEnv() {
  // R-100: resolve .env from the APP ROOT (not CWD), support `export`,
  // and strip trailing inline comments from unquoted values.
  for (const p of [path.join(__dirname, '.env')]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        else v = v.replace(/\s+#.*$/, '').trim();
        process.env[m[1]] = v;
      }
    }
  }
})();

const { openDB } = require('./lib/db');
const { migrate } = require('./lib/migrations');
const { ensureScratchSchema } = require('./lib/scratch');
const { getSettings, getS, getBool, getCurrencies, keyCol } = require('./lib/settings');
const { loadSession, csrfToken, checkCsrf, touchSession, destroySession } = require('./lib/auth');
const { fmtMoney, parseAmountList, now } = require('./lib/util');
const { getExtensions } = require('./lib/extensions');
const cron = require('./lib/cron');

const { driver, db } = openDB();

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (h) for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function boot() {
  // Production secret guard (2026-10-27 audit fix): ticket HMACs are signed
  // with TICKET_HMAC_SECRET. The old fallback 'dev-secret-change-me' is
  // public (it sits in the repo), so anyone could forge ticket proofs.
  // A production boot without a real secret refuses to start.
  // R-015: fail boot on an unset/fallback HMAC secret REGARDLESS of
  // NODE_ENV — package.json start never set NODE_ENV=production, so the
  // old production-only guard never fired in practice.
  if (!process.env.TICKET_HMAC_SECRET || process.env.TICKET_HMAC_SECRET === 'dev-secret-change-me')
    throw new Error('TICKET_HMAC_SECRET must be set to a long random value (refusing to boot with the repo-public fallback)');
  await migrate(db, driver);
  await ensureScratchSchema(db, driver);
  console.log(`[db] ${driver} ready`);

  // Self-healing: Render's free-tier ephemeral disk wipes SQLite on every
  // redeploy/restart, which killed the admin account repeatedly ("Invalid
  // email or password"). If no admin exists after migrations, seed the
  // configured admin automatically so the admin login always works after a wipe.
  // Override with env vars: ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD / ADMIN_SEED_NAME.
  {
    const seeded = await db.get("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
    if (!seeded) {
      const { hashPassword } = require('./lib/util');
      const seedEmail = String(process.env.ADMIN_SEED_EMAIL || '').trim().toLowerCase();
      const seedPass = String(process.env.ADMIN_SEED_PASSWORD || '');
      const seedName = String(process.env.ADMIN_SEED_NAME || 'Platform Admin').trim();
      if (seedEmail && seedPass) {
        await db.run(
          'INSERT INTO users (email, phone, name, password_hash, role, status, email_verified, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [seedEmail, '', seedName, hashPassword(seedPass), 'admin', 'active', 1, now()]
        );
        console.log(`[boot] no admin found — seeded configured admin ${seedEmail}`);
      } else {
        console.log('[boot] no admin found — configure ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD (public /setup is disabled by default; set ALLOW_SETUP=1 only to enable it temporarily)');
      }
    }
  }

  // Self-healing scratch: a fresh DB (e.g. Render free-tier wipe) ships only
  // DRAFT template series, so the lobby shows "No scratch series on sale"
  // and nothing is buyable. Seed one honest default series only when NO
  // live+enabled series exists — and never re-create it: if Gold Rush already
  // exists (e.g. the operator stopped it), that choice is respected so a
  // restart can never crash on the slug UNIQUE constraint or override the
  // operator. Standard 75% RTP math: $1 ticket, 100 tickets,
  // prizes 1x$10 + 5x$5 + 20x$2 = $75 pool. Outcomes committed via launchSeries.
  {
    const { launchSeries } = require('./lib/scratch');
    const { randHex, sha256 } = require('./lib/util');
    const live = await db.get(`SELECT COUNT(*) AS c FROM scratch_series WHERE status='live' AND enabled=1`);
    if (!live || Number(live.c) === 0) {
      const existing = await db.get(`SELECT id FROM scratch_series WHERE slug='gold-rush'`);
      if (existing) {
        console.log('[boot] no live scratch series, but Gold Rush already exists — leaving operator choice untouched');
      } else {
        const seed = randHex(32);
        const r = await db.run(
          `INSERT INTO scratch_series (title,slug,game_type,currency,price,total_tickets,status,enabled,rules,server_seed,seed_hash,created_by,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ['Gold Rush', 'gold-rush', 'single', 'USD', 100, 100, 'draft', 0,
           'Scratch to reveal your prize instantly. Prizes are locked before sale and verifiable after reveal.',
           seed, sha256(seed), 0, now()]
        );
        const tiers = [[1000, 1, 'Jackpot'], [500, 5, 'Big win'], [200, 20, 'Win']];
        for (const [amount, qty, label] of tiers) {
          await db.run('INSERT INTO scratch_prize_tiers (series_id,amount,quantity,label) VALUES (?,?,?,?)', [r.id, amount, qty, label]);
        }
        await launchSeries(db, r.id, 0);
        console.log('[boot] no live scratch series — seeded default live series Gold Rush ($1, 100 tickets, 75% RTP)');
      }
    }
  }

  const app = express();
  // v20 U-04b: trust X-Forwarded-For only from local/platform proxy hops.
  // 'trust proxy = 1' resolved req.ip to Render's internal 10.26.x.x hop;
  // this list returns the true client IP for the platform chain and ignores
  // client-spoofed XFF prefixes (measured in adj-backend.md).
  app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // Cache-busting version for static assets: hash of the files at boot.
  // Any change to app.js/style.css produces a new ?v= so browsers never
  // serve stale JS/CSS after a deploy.
  try {
    const h = require('node:crypto').createHash('sha1');
    for (const f of ['public/app.js', 'public/style.css', 'public/admin.css']) {
      h.update(fs.readFileSync(path.join(__dirname, f)));
    }
    app.locals.assetV = h.digest('hex').slice(0, 8);
  } catch { app.locals.assetV = String(Date.now()); }

  // security headers (CSP added in v14 — see the nonce middleware below;
  // inline handlers were moved into public/app.js so the policy holds)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use((req, res, next) => { req.cookies = parseCookies(req); next(); });
  // CSP nonce: one random value per request; templates add it to the few
  // remaining inline scripts (GA, tawk.to embed) and captcha widget scripts.
  app.use((req, res, next) => {
    req.cspNonce = require('node:crypto').randomBytes(16).toString('base64');
    next();
  });
  // Webhook routes verify HMAC signatures over the RAW body, so the global
  // body parsers must skip /webhooks/* — otherwise express.json() consumes
  // the stream first and the route-level express.raw() sees a parsed object
  // instead of bytes, making every valid signature fail.
  const skipWebhooks = (parser) => (req, res, next) =>
    req.path.startsWith('/webhooks/') ? next() : parser(req, res, next);
  app.use(skipWebhooks(express.urlencoded({ extended: true, limit: '2mb' })));
  app.use(skipWebhooks(express.json({ limit: '2mb' })));
  app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

  // admin path: settings override > env > default (non-guessable)
  const bootSettings = await getSettings(db, driver, true);
  const ADMIN_PATH = getS(bootSettings, 'admin_path', process.env.ADMIN_PATH || '/ops-7f3a9c-console');

  app.use(loadSession(db));

  // per-request context: settings, currencies, locals
  app.use(async (req, res, next) => {
    try {
      req.db = db; req.driver = driver;
      /* SCAN fix (A-11): authenticated pages are never cached — after
         logout, the browser Back button must not re-display wallet /
         profile / security pages from cache on a shared device. */
      if (req.user) res.set('Cache-Control', 'no-store');
      req.settings = await getSettings(db, driver);
      req.adminPath = ADMIN_PATH;
      req.currencies = getCurrencies(req.settings);
      const base = getS(req.settings, 'base_currency', 'USD');
      // display currency: user pref > session > cookie > base
      let cur = base;
      if (req.user && req.user.display_currency) cur = req.user.display_currency;
      else if (req.sessionData && req.sessionData.display_currency) cur = req.sessionData.display_currency;
      else if (req.cookies.display_currency) cur = req.cookies.display_currency;
      if (!req.currencies.some(c => c.code === cur)) cur = base;
      req.cur = cur;
      req.fmt = (minor, code) => fmtMoney(minor, code || cur, req.currencies);
      req.wagerOptions = parseAmountList(getS(req.settings, 'wager_options', '1,2,5,10'), [100, 200, 500, 1000]);

      // CSRF token (persist on first generation)
      if (req.sess && !req.sessionData._csrf) {
        csrfToken(req.sessionData);
        await touchSession(db, req.sess.id, { _csrf: req.sessionData._csrf });
      }
      req.csrfToken = (req.sessionData && req.sessionData._csrf) || '';

      // flash (session-backed, shown once)
      let flash = { error: '', success: '' };
      if (req.sess && req.sessionData._flash) {
        const f = req.sessionData._flash;
        flash = { error: '', success: '', [f.type]: f.msg };
        await touchSession(db, req.sess.id, { _flash: null });
      }
      req.flashData = flash;

      // impersonation banner
      let impersonating = false, impersonatorName = '';
      if (req.sess && req.sessionData.impersonated_by) {
        impersonating = true;
        const adm = await db.get('SELECT name FROM users WHERE id = ?', [req.sessionData.impersonated_by]);
        impersonatorName = adm ? adm.name : ('#' + req.sessionData.impersonated_by);
      }

      const blocks = await db.query(`SELECT ${keyCol(driver)}, body FROM content_blocks`).catch(() => []);
      const blockMap = Object.fromEntries(blocks.map(b => [b.key, b.body]));
      const exts = await getExtensions(db).catch(() => ({}));
      req.exts = exts;
      const footerPages = await db.query("SELECT slug, title FROM pages WHERE status='published' ORDER BY sort, name").catch(() => []);
      let wallets = [];
      if (req.user) wallets = await db.query('SELECT currency, balance FROM wallets WHERE user_id = ?', [req.user.id]).catch(() => []);

      res.locals = {
        S: (k, fb = '') => (req.settings[k] !== undefined ? req.settings[k] : fb),
        fmt: req.fmt,
        sym: (code) => (req.currencies.find(c => c.code === code) || {}).symbol || code,
        cur, user: req.user,
        isAgent: req.user && ['agent', 'admin'].includes(req.user.role),
        impersonating, impersonatorName,
        flash,
        currencies: req.currencies, wallets,
        walletBal: (code) => (wallets.find(w => w.currency === code) || { balance: 0 }).balance,
        content: (k) => blockMap[k] || '',
        extOn: (k) => !!(exts[k] && exts[k].enabled),
        extCfg: (k) => (exts[k] && exts[k].config) || {},
        footerPages,
        siteName: getS(req.settings, 'site_name', 'Cash Pop Lottery'),
        metaTitle: 'Home', metaDesc: '',
        currentPath: req.path,
        adminPath: ADMIN_PATH,
        cspNonce: req.cspNonce || '',
        captchaHtml: '', recaptchaHtml: '',
        googleOn: getBool(req.settings, 'google_oauth_enabled', false) && !!process.env.GOOGLE_CLIENT_ID,
      };
      /* U-28.10 (v20): the console path is owner-only information. It used
         to sit in res.locals on EVERY request, so one stray <%= adminPath %>
         in a player template would have published it site-wide. No player
         or agent view reads this local (admin pages receive the path
         explicitly as ui.layout's adminPath argument, from req.adminPath),
         so the local is now deleted for every non-console request. */
      if (!(req.path === ADMIN_PATH || req.path.startsWith(ADMIN_PATH + '/'))) delete res.locals.adminPath;
      // live getter: routes (e.g. anon captcha sessions) may create the session after this middleware
      Object.defineProperty(res.locals, 'csrf', { enumerable: true, configurable: true, get: () => req.csrfToken || '' });
      next();
    } catch (e) { next(e); }
  });

  // Layout wrapper: every EJS view renders inside views/layout.ejs (<%- body %>).
  // (Admin panel sends its own complete HTML via res.send — untouched.)
  app.use((req, res, next) => {
    const origRender = res.render.bind(res);
    res.render = function (view, vars, cb) {
      if (typeof vars === 'function') { cb = vars; vars = {}; }
      if (view === 'layout') return origRender(view, vars, cb);
      origRender(view, vars || {}, (err, html) => {
        if (err) { if (cb) return cb(err); return next(err); }
        origRender('layout', { ...(vars || {}), body: html }, cb);
      });
    };
    next();
  });

  // CSRF enforcement on state-changing requests (webhooks verify signatures instead).
  // R-036: session-less POSTs to auth endpoints are NOT skipped anymore —
  // a cross-site POST carries no sid cookie, so the old skip exempted
  // exactly the forged requests. Logged-out forms always create an anon
  // session (login/register/forgot GET), so a legitimate POST carries a
  // token; a POST with no session at all must have come without visiting
  // the form first, and is refused.
  /* BP-21: the app's only multipart form is POST /kyc (document upload).
     The global urlencoded/json parsers skip multipart bodies, so this
     scoped parser runs BEFORE the CSRF check for that one route: it
     reads the raw stream (hard size cap), parses fields (incl. _csrf)
     and the file into req.body / req.kycFile, and the standard CSRF
     check below then applies unchanged. Parse failures leave req.body
     empty → CSRF refuses (fail closed); file-level problems surface to
     the handler as req.kycUploadError. */
  const { parseMultipart: parseKycMultipart, MAX_BODY_BYTES: KYC_MAX_BODY } = require('./lib/upload');
  app.use((req, res, next) => {
    if (req.method !== 'POST' || req.path !== '/kyc') return next();
    const ct = String(req.headers['content-type'] || '');
    if (!ct.startsWith('multipart/form-data')) return next();
    const chunks = []; let size = 0; let tooBig = false; let destroyed = false;
    req.on('data', (c) => {
      size += c.length;
      /* SCAN fix (B-07): past the cap we stop BUFFERING (memory stays
         bounded) but keep draining so a legitimate user still gets the
         friendly error — up to a hard ceiling of 4x the cap, after
         which the stream is destroyed outright (flood cut-off). */
      if (size > KYC_MAX_BODY * 4 && !destroyed) { destroyed = true; req.destroy(); return; }
      if (size > KYC_MAX_BODY) { tooBig = true; chunks.length = 0; } else if (!tooBig) chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) { req.kycUploadError = 'Document is too large (maximum 5 MB).'; req.body = {}; return next(); }
      try {
        const parsed = parseKycMultipart(Buffer.concat(chunks), ct);
        req.body = parsed.fields;
        req.kycFile = parsed.file;
      } catch (e) { req.kycUploadError = e.message; req.body = {}; }
      next();
    });
    req.on('error', () => { req.body = {}; next(); });
  });
  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (req.path.startsWith('/webhooks/')) return next();
    if (!req.sess) {
      const authPaths = ['/login', '/forgot', '/register', '/login/otp/request', '/login/otp/verify', '/contact']; // SCAN fix (A-10): /contact joins the session-required set
      /* D2-C7 (v20): the exact-match list never matched the PARAMETERIZED
         reset path (/reset/<token>), so the most sensitive auth POST of
         all ran with no session and no CSRF token — token secrecy was
         the only barrier. The genuine flow is unaffected: GET
         /reset/:token now creates the anon session + CSRF cookie first
         (routes/auth.js), so an emailed-link visitor POSTs with a
         session and the standard check below applies. */
      if (authPaths.includes(req.path) || req.path.startsWith('/reset/')) return res.status(403).render('error', { status: 403, message: 'Security token mismatch. Please open the form first and try again.' });
      return next(); // e.g. /setup — nothing to forge against
    }
    if (!checkCsrf(req)) return res.status(403).render('error', { status: 403, message: 'Security token mismatch. Please go back and try again.' });
    next();
  });

  // Content-Security-Policy (v14, nonce-based). Inline event handlers were
  // moved into public/app.js; the remaining inline scripts (GA snippet,
  // tawk.to embed) carry the per-request nonce, and captcha widgets get it
  // on their <script> tags. style-src keeps 'unsafe-inline' for admin inline
  // styles and operator custom_css (operator-controlled, never user input).
  // Runs after the context middleware so extension state is known.
  app.use((req, res, next) => {
    try {
      if (getBool(req.settings, 'csp_enabled', true)) {
        const nonce = req.cspNonce || '';
        const exts = req.exts || {};
        const on = (k) => !!(exts[k] && exts[k].enabled);
        const scriptSrc = ["'self'", `'nonce-${nonce}'`];
        const connectSrc = ["'self'"];
        let frameSrc = "'none'";
        if (on('google_analytics')) { scriptSrc.push('https://www.googletagmanager.com', 'https://www.google-analytics.com'); connectSrc.push('https://www.google-analytics.com'); }
        if (on('tawkto')) { scriptSrc.push('https://embed.tawk.to'); connectSrc.push('https://embed.tawk.to', 'https://va.tawk.to'); }
        if (on('fb_comments')) { scriptSrc.push('https://connect.facebook.net'); frameSrc = 'https://www.facebook.com'; }
        if (on('recaptcha') || on('hcaptcha') || on('turnstile')) {
          scriptSrc.push('https://www.google.com', 'https://www.gstatic.com', 'https://js.hcaptcha.com', 'https://challenges.cloudflare.com');
          frameSrc = 'https://www.google.com https://js.hcaptcha.com https://newassets.hcaptcha.com https://challenges.cloudflare.com';
        }
        res.setHeader('Content-Security-Policy', [
          "default-src 'self'",
          'script-src ' + scriptSrc.join(' '),
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: https:",
          'connect-src ' + connectSrc.join(' '),
          'frame-src ' + frameSrc,
          "frame-ancestors 'none'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; '));
      }
    } catch {}
    next();
  });

  // Maintenance mode (admin toggle, v14): gates ALL methods, not just GET —
  // the old version let a logged-in player POST /play/buy during maintenance.
  // Admin users bypass; everyone else gets the maintenance page (GET) or a
  // 503 JSON (POST/API). Allowlist: admin path, login/logout, impersonation
  // exit, webhooks, healthz, email verification, password reset/forgot,
  // static assets.
  app.use((req, res, next) => {
    let mm = false;
    try { mm = req.settings && (req.settings.maintenance_mode === '1' || req.settings.maintenance_mode === 'true'); } catch {}
    if (!mm) return next();
    const isAdmin = req.user && req.user.role === 'admin';
    if (isAdmin) return next();
    const adminPath = req.adminPath || '/ops-7f3a9c-console';
    // v16: exact match or a real sub-path only. The old startsWith(adminPath)
    // also matched /ops-7f3a9c-consoleXYZ, letting a non-admin skip the
    // maintenance page for a guessed prefix (the admin router itself still
    // 404'd them, but the maintenance bypass itself was sloppy).
    if (req.path === adminPath || req.path.startsWith(adminPath + '/')) return next();
    if (req.path === '/login' || req.path === '/logout' || req.path === '/impersonate/exit') return next();
    if (req.path.startsWith('/webhooks/')) return next();
    if (req.path === '/healthz') return next();
    if (req.path.startsWith('/verify-email/') || req.path.startsWith('/reset/') || req.path === '/forgot' || req.path === '/force-reset') return next();
    if (req.path.startsWith('/style.css') || req.path.startsWith('/app.js') || req.path === '/favicon.ico') return next();
    if (req.method === 'GET') return res.status(503).render('maintenance', { metaTitle: 'Under Maintenance', metaDesc: '' });
    return res.status(503).json({ ok: false, error: 'Site under maintenance' });
  });

  // Forced-action gate (v14): users flagged for a forced password reset
  // (agents created by an admin) or forced TOTP enrollment (admins when
  // enforcement is on) can ONLY reach the page that clears the flag (+
  // logout + impersonation exit). Everything else redirects there. Checked
  // fresh every request so clearing the flag takes effect immediately.
  app.use(async (req, res, next) => {
    if (!req.user) return next();
    try {
      const u = await db.get('SELECT force_password_reset, force_totp_enroll, totp_secret FROM users WHERE id = ?', [req.user.id]);
      if (!u) return next();
      if (u.force_password_reset) {
        if (req.path === '/force-reset' || req.path === '/logout' || req.path === '/impersonate/exit') return next();
        return res.redirect('/force-reset');
      }
      // admin_totp_required enforcement for PRE-EXISTING admins: the toggle
      // could only be switched on by an already-enrolled admin, but other
      // admins created earlier never got force_totp_enroll set, so they kept
      // logging in with password alone while the setting claimed TOTP was
      // required. The gate now derives enrollment from the live totp_secret
      // instead of trusting the flag alone.
      const totpRequired = req.settings && (req.settings.admin_totp_required === '1' || req.settings.admin_totp_required === 'true' || req.settings.admin_totp_required === true);
      if ((u.force_totp_enroll || (totpRequired && !u.totp_secret)) && req.user.role === 'admin') {
        const adminPath = req.adminPath || '/ops-7f3a9c-console';
        if (req.path === adminPath + '/security' || req.path.startsWith(adminPath + '/security/') || req.path === '/logout' || req.path === '/impersonate/exit') return next();
        return res.redirect(adminPath + '/security');
      }
    } catch (e) { return next(e); }
    next();
  });

  // v16: profile-completion gate. OTP signups create the account before name
  // + terms are collected. That step used to live ONLY in the session, so a
  // user could dismiss the modal and play forever without a name or terms,
  // and logging out lost the step entirely. Now users.profile_completed
  // persists it, and incomplete users can only reach the completion page
  // (or log out) until they finish. Checked fresh every request, like the
  // forced-action gate above, so completing takes effect immediately.
  app.use(async (req, res, next) => {
    if (!req.user) return next();
    try {
      const u = await db.get('SELECT profile_completed FROM users WHERE id = ?', [req.user.id]);
      if (u && Number(u.profile_completed) === 0) {
        if (req.path === '/login/complete-profile' || req.path === '/logout' || req.path === '/impersonate/exit') return next();
        if (req.path.startsWith('/style.css') || req.path.startsWith('/app.js') || req.path === '/favicon.ico') return next();
        if (req.method === 'GET') return res.redirect('/login/complete-profile');
        return res.status(403).json({ ok: false, error: 'Please complete your profile first.' });
      }
    } catch {}
    next();
  });

  // exit impersonation
  app.post('/impersonate/exit', async (req, res) => {
    if (req.sess) await destroySession(db, req.sess.id);
    res.clearCookie('sid');
    res.redirect('/login');
  });

  // Convert async throws into Express errors (Express 4 doesn't catch them)
  function wrapAsync(router) {
    for (const layer of router.stack) {
      if (layer.route) {
        for (const l of layer.route.stack) {
          const fn = l.handle;
          if (fn && fn.constructor && fn.constructor.name === 'AsyncFunction') {
            l.handle = (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
          }
        }
      }
    }
    return router;
  }
  // Fatal errors must NOT be swallowed: the old handlers only logged and kept
  // running in an unknown state with real money on the line. Log, then exit
  // so the process manager restarts from a clean state.
  process.on('unhandledRejection', (e) => { console.error('[unhandledRejection]', e); process.exit(1); });
  process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); process.exit(1); });

  app.use('/', wrapAsync(require('./routes/setup')));
  app.use('/', wrapAsync(require('./routes/site')));
  app.use('/', wrapAsync(require('./routes/auth')));
  app.use('/', wrapAsync(require('./routes/player')));
  const scratchRoutes = require('./routes/scratch');
  app.use('/', wrapAsync(scratchRoutes.playerRouter));
  app.use('/agent', wrapAsync(require('./routes/agent')));
  app.use(ADMIN_PATH + '/scratch', wrapAsync(scratchRoutes.adminRouter));
  app.use(ADMIN_PATH, wrapAsync(require('./routes/admin')));
  app.use('/webhooks', wrapAsync(require('./routes/webhooks')));

  app.use((req, res) => res.status(404).render('error', { status: 404, message: 'Page not found.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    /* D4-C4 (v20): body-parser's PayloadTooLargeError used to fall into
       the generic 500. An oversized submission is the CLIENT's error —
       answer 413 with the true reason, in the same friendly family. */
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      return res.status(413).render('error', { status: 413, message: 'That submission was too large to process. Please go back and try again with less data.' });
    }
    /* A body the parsers could not read at all is likewise a 400, not a
       server fault — friendly wording, no parser internals. */
    if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400))) {
      return res.status(400).render('error', { status: 400, message: 'That submission could not be read. Please go back and try again.' });
    }
    /* U-24 (v20): an unexpected error shows the player a SHORT REFERENCE
       CODE only — no message, class, stack or SQL ever reaches the page.
       The full detail goes to the server log AND the audit trail under
       that same code, so support can find the exact failure from the
       code the user quotes. */
    const ref = 'E' + Date.now().toString(36).toUpperCase() + require('node:crypto').randomBytes(2).toString('hex').toUpperCase();
    console.error(`[error] ref=${ref}`, err);
    try {
      require('./lib/audit').log(db, { actorId: req.user ? req.user.id : null, actorRole: 'system', action: 'error.unhandled', entity: 'http', entityId: ref, detail: { method: req.method, path: req.path, error: String(err && err.message || err).slice(0, 500) }, ip: req.ip || '' }).catch(() => {});
    } catch {}
    res.status(500).render('error', { status: 500, message: 'Something went wrong. The team has been notified.', ref });
  });

  const port = parseInt(process.env.PORT || '3000', 10);
  app.listen(port, () => {
    console.log(`[app] listening on :${port} — admin at ${ADMIN_PATH}`);
    console.log('[app] first run? set ADMIN_SEED_EMAIL/ADMIN_SEED_PASSWORD to create the admin account (public /setup is disabled by default)');
  });

  cron.start({ db, driver });
}

boot().catch(e => { console.error('[boot] failed:', e); process.exit(1); });
