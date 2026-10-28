'use strict';
/* Public site: home, CMS pages, results, fairness verifier, currency switch,
   sitemap.xml, robots.txt. */
const express = require('express');
const router = express.Router();
const { sha256 } = require('../lib/util');
const { keyCol, getS, getBool } = require('../lib/settings');
const { publicDrawInfo, fairnessForDraw } = require('../lib/draws');
const { createSession, getSession, touchSession, csrfToken, rateLimit, ANON_TTL } = require('../lib/auth');

function resolveContent(body, blocks) {
  return String(body || '').replace(/\{\{\s*content:([a-z0-9_]+)\s*\}\}/gi, (_, k) => blocks[k] || '');
}

/* Live homepage stats (public, real DB values only — never simulated).
   Polled by the homepage every 30s so Total paid out and player counts move
   live when REAL payouts/registrations happen. Each figure moves at its own
   real pace: paid-out moves only on real wins, players only on real signups. */
router.get('/api/stats', async (req, res) => {
  const players = await req.db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'player'");
  const ticketsToday = await req.db.get('SELECT COUNT(*) AS c FROM tickets WHERE created_at > ?', [Date.now() - 86400000]);
  // R-118: paid-out split by currency (no cross-currency sum); the
  // headline figure is the BASE-currency total only, labelled as such.
  const paidByCur = await req.db.query("SELECT currency, COALESCE(SUM(amount),0) AS s FROM transactions WHERE type IN ('win','scratch_prize') GROUP BY currency");
  const baseCur = req.settings.base_currency || 'USD';
  const paidOut = { s: Number((paidByCur.find(r => r.currency === baseCur) || { s: 0 }).s) };
  const recentWins = await req.db.query(
    "SELECT t.amount, t.currency, t.created_at, u.name FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.type IN ('win','scratch_prize') ORDER BY t.created_at DESC LIMIT 12"
  );
  res.json({
    players: players.c, tickets_today: ticketsToday.c, paid_out: paidOut.s,
    paid_out_fmt: req.fmt(paidOut.s, baseCur), paid_out_by_currency: paidByCur,
    recentWins: recentWins.map(w => ({ name: String(w.name).split(' ')[0], amount: w.amount, amount_fmt: req.fmt(w.amount, w.currency), currency: w.currency, created_at: w.created_at })),
  });
});

router.get('/', async (req, res) => {
  /* U-03 (v20): complete Day+Evening pairs, in chronological order.
     The old single query (ORDER BY close_at LIMIT 4) knew nothing
     about pairs: a draw that rolls +24h individually (settleDueDraws
     'roll' mode in lib/draws.js) lands among the next date's draws, so
     the flat list could show Day, Evening, Day — or cut a pair in half
     at the LIMIT boundary. Construction here: the next 2 scheduled
     draws of EACH type, merged by close_at (tie-break draw_date, then
     type). At most 2 DAY + 2 EVE, whole pairs whenever both types
     exist; when generation leaves a type missing (per-type AUTO
     switch off, past close skipped) only the real rows render — no
     card is invented to fill a pair. */
  const drawsByType = await Promise.all(['DAY', 'EVE'].map(type => req.db.query(
    "SELECT * FROM draws WHERE status = 'scheduled' AND draw_type = ? ORDER BY close_at ASC LIMIT 2", [type]
  )));
  const draws = drawsByType.flat()
    .sort((a, b) => (Number(a.close_at) - Number(b.close_at))
      || String(a.draw_date).localeCompare(String(b.draw_date))
      || String(a.draw_type).localeCompare(String(b.draw_type)))
    .map(publicDrawInfo);
  /* U-12 (v20): homepage scratch showcase, driven by REAL series data.
     This mirrors the scratch lobby query in routes/scratch.js exactly —
     same status/enabled conditions (status='live' AND enabled=1) and
     the same remaining / top-prize expressions — so the homepage can
     never show a series the lobby would not sell. An empty list makes
     the template render no scratch section at all. */
  const scratchSeries = await req.db.query(
    `SELECT s.*, (SELECT COUNT(*) FROM scratch_outcomes o WHERE o.series_id=s.id AND o.ticket_id IS NULL) AS remaining,
      (SELECT MAX(amount) FROM scratch_prize_tiers p WHERE p.series_id=s.id) AS top_prize,
      (SELECT COALESCE(SUM(amount*quantity),0) FROM scratch_prize_tiers p WHERE p.series_id=s.id) AS total_prizes
     FROM scratch_series s WHERE s.status='live' AND s.enabled=1 ORDER BY s.launched_at DESC`);
  // DS-075: TEST draws are internal test artefacts - they never appear on
  // public surfaces (homepage results, results page).
  const recentResults = await req.db.query(
    "SELECT * FROM draws WHERE status = 'settled' AND is_test = 0 ORDER BY close_at DESC LIMIT 10"
  );
  const players = await req.db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'player'");
  const ticketsToday = await req.db.get('SELECT COUNT(*) AS c FROM tickets WHERE created_at > ?', [Date.now() - 86400000]);
  const paidOut = await req.db.get("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE type IN ('win','scratch_prize') AND currency = ?", [getS(req.settings, 'base_currency', 'USD')]);
  // Hero stats are ALWAYS real DB counts (base currency only — R-118). The old 'marketing' mode served
  // admin-invented base numbers that ticked up by random amounts on the
  // homepage — fabricated public statistics. It is removed, not just off.
  const statPlayers = players.c, statPaid = paidOut.s;
  const recentWins = await req.db.query(
    "SELECT t.amount, t.currency, t.created_at, u.name FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.type IN ('win','scratch_prize') ORDER BY t.created_at DESC LIMIT 12"
  );
  const nextDraw = draws.length ? draws[0] : null;
  res.render('index', {
    metaTitle: 'Home', metaDesc: 'Play Cash Pop lottery — provably fair draws, instant wins.',
    draws: draws.map(d => ({ ...d, label: d.draw_type === 'DAY' ? 'Day Draw' : 'Evening Draw' })),
    recentResults, recentWins, nextDraw, scratchSeries,
    /* SCAN fix (A-04): the total is a BASE-currency sum — format it in
       the base currency (as /api/stats does), not the visitor's display
       currency. fmtMoney only relabels; the old code showed the USD
       total wearing a € symbol (or rescaled for 0-decimal JPY). */
    stats: { players: statPlayers, tickets_today: ticketsToday.c, paid_out: statPaid, paid_out_fmt: req.fmt(statPaid, getS(req.settings, 'base_currency', 'USD')), mode: 'real' },
    paidBase: { symbol: (req.currencies.find(c => c.code === getS(req.settings, 'base_currency', 'USD')) || {}).symbol || '$', dec: require('../lib/util').decimalsFor(getS(req.settings, 'base_currency', 'USD'), req.currencies) },
  });
});

router.get('/page/:slug', async (req, res) => {
  const pg = await req.db.get('SELECT * FROM pages WHERE slug = ? AND status = ?', [req.params.slug, 'published']);
  if (!pg) return res.status(404).render('error', { status: 404, message: 'Page not found.' });
  const blocks = {};
  for (const b of await req.db.query(`SELECT ${keyCol(req.driver)}, body FROM content_blocks`)) blocks[b.key] = b.body;
  res.render('cms', {
    metaTitle: pg.meta_title || pg.title, metaDesc: pg.meta_desc || '',
    pg: { ...pg, body: resolveContent(pg.body, blocks) },
    canonical: (process.env.BASE_URL || '') + '/page/' + pg.slug,
  });
});

router.get('/results', async (req, res) => {
  // R-119: paginated + filterable results; each row links to its fairness proof via the template.
  const type = ['DAY', 'EVE'].includes(String(req.query.type || '')) ? req.query.type : '';
  const params = [];
  let where = "status = 'settled' AND is_test = 0"; // DS-075
  if (type) { where += ' AND draw_type = ?'; params.push(type); }
  const totalRow = await req.db.get(`SELECT COUNT(*) AS c FROM draws WHERE ${where}`, params);
  const total = Number(totalRow.c);
  // D4-C2 (v20): clamp into [1, totalPages] — an out-of-range page used
  // to render the first-run empty state ("No results yet") with an
  // impossible "Page 999 of 2" counter while results existed.
  const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), Math.max(1, Math.ceil(total / 25)));
  const draws = await req.db.query(`SELECT * FROM draws WHERE ${where} ORDER BY close_at DESC LIMIT 25 OFFSET ?`, [...params, (page - 1) * 25]);
  res.render('results', { metaTitle: 'Results', metaDesc: 'Latest Cash Pop draw results.', draws, page, totalPages: Math.max(1, Math.ceil(total / 25)), filterType: type });
});

router.get('/fairness', async (req, res) => {
  let result = null;
  const drawId = parseInt(req.query.draw_id, 10);
  if (drawId) {
    const d = await req.db.get('SELECT * FROM draws WHERE id = ?', [drawId]);
    // Settled-only verification (see fairnessForDraw): an unsettled draw's
    // seed is committed but unrevealed, so no number/verdict is shown at all.
    if (d) result = fairnessForDraw(d);
    else result = { notFound: true };
  }
  res.render('verify', { metaTitle: 'Provably Fair', metaDesc: 'Verify any draw yourself.', result });
});

router.post('/currency', async (req, res) => {
  const code = String(req.body.code || '').toUpperCase().slice(0, 8);
  const ok = req.currencies.some(c => c.code === code);
  if (ok) {
    if (req.sess) {
      const { touchSession } = require('../lib/auth');
      await touchSession(req.db, req.sess.id, { display_currency: code });
    }
    if (req.user) await req.db.run('UPDATE users SET display_currency = ? WHERE id = ?', [code, req.user.id]);
    res.cookie('display_currency', code, { maxAge: 365 * 86400000, sameSite: 'lax' });
  }
  res.redirect(req.get('referer') || '/');
});

router.get('/sitemap.xml', async (req, res) => {
  const pages = await req.db.query("SELECT slug FROM pages WHERE status = 'published'");
  const base = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const urls = ['', '/play', '/results', '/fairness', ...pages.map(p => '/page/' + p.slug)];
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
    urls.map(u => `<url><loc>${base}${u || '/'}</loc></url>`).join('') + `</urlset>`);
});

router.get('/robots.txt', (req, res) => {
  const base = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
});

/* DS-029: there was no contact page at all - the footer block was static
   text and messages had nowhere to go. Submissions land in
   contact_messages (migration v12) for staff under Admin > Contact. */
/* SCAN fix (A-10): the contact form gets the same anon-session + CSRF
   treatment as the login/register forms (routes/auth.js anonSession) —
   without a session the CSRF check was waived and the form could be
   posted cross-origin without a token. */
async function contactAnonSession(req, res) {
  if (req.sess) return;
  const sid = await createSession(req.db, 0, { ip: req.ip, ua: req.headers['user-agent'] || '', ttlMs: ANON_TTL });
  res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', secure: req.secure || getBool(req.settings, 'force_ssl', false), maxAge: 3600000 });
  const sess = await getSession(req.db, sid);
  req.sess = sess; req.sessionData = sess ? sess.data : {};
  req.csrfToken = csrfToken(req.sessionData);
  await touchSession(req.db, sid, { _csrf: req.sessionData._csrf });
}
router.get('/contact', async (req, res) => {
  await contactAnonSession(req, res);
  res.render('contact', { metaTitle: 'Contact us', metaDesc: 'Get in touch with the Cash Pop team.' });
});
router.post('/contact', rateLimit({ windowMs: 60000, max: 5, keyFn: req => `contact:${req.ip}` }), async (req, res) => {
  const { validEmail, now: nowMs } = require('../lib/util');
  const name = String(req.body.name || '').trim().slice(0, 120);
  const email = String(req.body.email || '').trim().slice(0, 190);
  const subject = String(req.body.subject || '').trim().slice(0, 255);
  const message = String(req.body.message || '').trim().slice(0, 5000);
  if (!name || !validEmail(email) || !message) {
    await req.setFlash('error', 'Please add your name, a valid email and a message.');
    return res.redirect('/contact');
  }
  await req.db.run('INSERT INTO contact_messages (name, email, subject, message, handled, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    [name, email, subject, message, nowMs()]);
  await req.setFlash('success', 'Message sent - we will reply by email.');
  res.redirect('/contact');
});

/* BP-16 (v19): uptime probe. The pre-v19 handler returned ok:true
   unconditionally — a dead database still looked "healthy" to an uptime
   checker. Now the probe runs a real DB ping: 200 {ok:true} only when the
   database answers, 503 {ok:false} when it does not. No config, version or
   error detail is exposed. */
router.get('/healthz', async (req, res) => {
  try {
    await req.db.get('SELECT 1 AS one');
    // U-28: the probe body is exactly {"ok":true} — no clock/uptime
    // or any other server detail rides along.
    return res.json({ ok: true });
  } catch (e) {
    return res.status(503).json({ ok: false });
  }
});

module.exports = router;
