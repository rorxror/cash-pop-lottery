'use strict';
/* Public site: home, CMS pages, results, fairness verifier, currency switch,
   sitemap.xml, robots.txt. */
const express = require('express');
const router = express.Router();
const { sha256 } = require('../lib/util');
const { keyCol, getS } = require('../lib/settings');
const { publicDrawInfo, fairnessForDraw } = require('../lib/draws');

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
  const paidByCur = await req.db.query("SELECT currency, COALESCE(SUM(amount),0) AS s FROM transactions WHERE type = 'win' GROUP BY currency");
  const baseCur = req.settings.base_currency || 'USD';
  const paidOut = { s: Number((paidByCur.find(r => r.currency === baseCur) || { s: 0 }).s) };
  const recentWins = await req.db.query(
    "SELECT t.amount, t.currency, t.created_at, u.name FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.type = 'win' ORDER BY t.created_at DESC LIMIT 12"
  );
  res.json({
    players: players.c, tickets_today: ticketsToday.c, paid_out: paidOut.s,
    paid_out_fmt: req.fmt(paidOut.s, baseCur), paid_out_by_currency: paidByCur,
    recentWins: recentWins.map(w => ({ name: String(w.name).split(' ')[0], amount: w.amount, amount_fmt: req.fmt(w.amount, w.currency), currency: w.currency, created_at: w.created_at })),
  });
});

router.get('/', async (req, res) => {
  const draws = (await req.db.query(
    "SELECT * FROM draws WHERE status = 'scheduled' AND draw_type IN ('DAY','EVE') ORDER BY close_at ASC LIMIT 4"
  )).map(publicDrawInfo);
  const recentResults = await req.db.query(
    "SELECT * FROM draws WHERE status = 'settled' ORDER BY close_at DESC LIMIT 10"
  );
  const players = await req.db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'player'");
  const ticketsToday = await req.db.get('SELECT COUNT(*) AS c FROM tickets WHERE created_at > ?', [Date.now() - 86400000]);
  const paidOut = await req.db.get("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE type = 'win' AND currency = ?", [getS(req.settings, 'base_currency', 'USD')]);
  // Hero stats are ALWAYS real DB counts (base currency only — R-118). The old 'marketing' mode served
  // admin-invented base numbers that ticked up by random amounts on the
  // homepage — fabricated public statistics. It is removed, not just off.
  const statPlayers = players.c, statPaid = paidOut.s;
  const recentWins = await req.db.query(
    "SELECT t.amount, t.created_at, u.name FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.type = 'win' ORDER BY t.created_at DESC LIMIT 12"
  );
  const nextDraw = draws.length ? draws[0] : null;
  res.render('index', {
    metaTitle: 'Home', metaDesc: 'Play Cash Pop lottery — provably fair draws, instant wins.',
    draws: draws.map(d => ({ ...d, label: d.draw_type === 'DAY' ? 'Day Draw' : 'Evening Draw' })),
    recentResults, recentWins, nextDraw,
    stats: { players: statPlayers, tickets_today: ticketsToday.c, paid_out: statPaid, paid_out_fmt: req.fmt(statPaid), mode: 'real' },
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
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const type = ['DAY', 'EVE', 'TEST'].includes(String(req.query.type || '')) ? req.query.type : '';
  const params = [];
  let where = "status = 'settled'";
  if (type) { where += ' AND draw_type = ?'; params.push(type); }
  const totalRow = await req.db.get(`SELECT COUNT(*) AS c FROM draws WHERE ${where}`, params);
  const total = Number(totalRow.c);
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

router.get('/healthz', (req, res) => res.json({ ok: true, time: Date.now() }));

module.exports = router;
