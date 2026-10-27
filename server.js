'use strict';
/* Cash Pop Lottery — standalone server (cPanel-ready).
   Node 22+, pure-JS deps, SQLite built-in, MySQL optional via env. */
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const ejs = require('ejs');

// ---- tiny .env loader (no dependency) ----
(function loadEnv() {
  for (const p of ['.env', './.env']) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  }
})();

const { openDB } = require('./lib/db');
const { migrate } = require('./lib/migrations');
const { ensureScratchSchema } = require('./lib/scratch');
const { getSettings, getS, getBool, getCurrencies } = require('./lib/settings');
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
  if (process.env.NODE_ENV === 'production' &&
      (!process.env.TICKET_HMAC_SECRET || process.env.TICKET_HMAC_SECRET === 'dev-secret-change-me'))
    throw new Error('TICKET_HMAC_SECRET must be set to a long random value in production');
  await migrate(db, driver);
  await ensureScratchSchema(db, driver);
  console.log(`[db] ${driver} ready`);

  // Self-healing demo: Render's free-tier ephemeral disk wipes SQLite on every
  // redeploy/restart, which killed the demo admin account repeatedly ("Invalid
  // email or password"). If no admin exists after migrations, seed the demo
  // admin automatically so the demo login always works after a wipe.
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
  // operator. Same 75% RTP math as the demo series: $1 ticket, 100 tickets,
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
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // Cache-busting version for static assets: hash of the files at boot.
  // Any change to app.js/style.css produces a new ?v= so browsers never
  // serve stale JS/CSS after a deploy.
  try {
    const h = require('node:crypto').createHash('sha1');
    for (const f of ['public/app.js', 'public/style.css']) {
      h.update(fs.readFileSync(path.join(__dirname, f)));
    }
    app.locals.assetV = h.digest('hex').slice(0, 8);
  } catch { app.locals.assetV = String(Date.now()); }

  // security headers (CSP intentionally omitted: views use inline handlers)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.use((req, res, next) => { req.cookies = parseCookies(req); next(); });
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

      const blocks = await db.query('SELECT `key`, body FROM content_blocks').catch(() => []);
      const blockMap = Object.fromEntries(blocks.map(b => [b.key, b.body]));
      const exts = await getExtensions(db).catch(() => ({}));
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
        siteName: getS(req.settings, 'site_name', 'Cash Pop'),
        metaTitle: 'Home', metaDesc: '',
        currentPath: req.path,
        adminPath: ADMIN_PATH,
        captchaHtml: '', recaptchaHtml: '',
        googleOn: getBool(req.settings, 'google_oauth_enabled', false) && !!process.env.GOOGLE_CLIENT_ID,
      };
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

  // CSRF enforcement on state-changing requests (sessions only; webhooks verify signatures instead)
  app.use((req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (req.path.startsWith('/webhooks/')) return next();
    if (!req.sess) return next(); // no session (e.g. /setup) — nothing to forge against
    if (!checkCsrf(req)) return res.status(403).render('error', { status: 403, message: 'Security token mismatch. Please go back and try again.' });
    next();
  });

  // Maintenance mode (admin toggle): player site shows a maintenance page.
  // Admin panel, admin login, and static assets always stay reachable.
  app.use((req, res, next) => {
    if (req.method !== 'GET') return next();
    let mm = false;
    try { mm = req.settings && (req.settings.maintenance_mode === '1' || req.settings.maintenance_mode === 'true'); } catch {}
    if (!mm) return next();
    const isAdmin = req.user && req.user.role === 'admin';
    const adminPath = req.adminPath || '/ops-7f3a9c-console';
    if (isAdmin) return next();
    if (req.path.startsWith(adminPath) || req.path === '/login' || req.path.startsWith('/style.css') || req.path.startsWith('/app.js') || req.path === '/favicon.ico') return next();
    return res.status(503).render('maintenance', { metaTitle: 'Under Maintenance', metaDesc: '' });
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
    console.error('[error]', err);
    res.status(500).render('error', { status: 500, message: 'Something went wrong. The team has been notified.' });
  });

  const port = parseInt(process.env.PORT || '3000', 10);
  app.listen(port, () => {
    console.log(`[app] listening on :${port} — admin at ${ADMIN_PATH}`);
    console.log('[app] first run? set ADMIN_SEED_EMAIL/ADMIN_SEED_PASSWORD to create the admin account (public /setup is disabled by default)');
  });

  cron.start({ db, driver });
}

boot().catch(e => { console.error('[boot] failed:', e); process.exit(1); });
