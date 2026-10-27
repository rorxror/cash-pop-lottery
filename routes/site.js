'use strict';
/* Public site: home, CMS pages, results, fairness verifier, currency switch,
   sitemap.xml, robots.txt. */
const express = require('express');
const router = express.Router();
const { sha256 } = require('../lib/util');
const { deriveWinningNumberLegacy, deriveWinningNumberFair, combineSeed, publicDrawInfo } = require('../lib/draws');

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
  const paidOut = await req.db.get("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE type = 'win'");
  const recentWins = await req.db.query(
    "SELECT t.amount, t.created_at, u.name FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.type = 'win' ORDER BY t.created_at DESC LIMIT 12"
  );
  res.json({
    players: players.c, tickets_today: ticketsToday.c, paid_out: paidOut.s,
    paid_out_fmt: req.fmt(paidOut.s),
    recentWins: recentWins.map(w => ({ name: String(w.name).split(' ')[0], amount: w.amount, amount_fmt: req.fmt(w.amount, 'USD'), created_at: w.created_at })),
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
  const paidOut = await req.db.get("SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE type = 'win'");
  // Hero stats: real mode uses DB counts; marketing mode uses admin-set base numbers that tick up live
  const statsMode = (req.settings && req.settings.hero_stats_mode) || 'real';
  let statPlayers = players.c, statPaid = paidOut.s;
  if (statsMode === 'marketing') {
    statPlayers = parseInt((req.settings && req.settings.hero_stats_players_base) || '1250', 10);
    statPaid = parseInt((req.settings && req.settings.hero_stats_paid_base) || '50000', 10);
  }
  const recentWins = await req.db.query(
    "SELECT t.amount, t.created_at, u.name FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.type = 'win' ORDER BY t.created_at DESC LIMIT 12"
  );
  const nextDraw = draws.length ? draws[0] : null;
  res.render('index', {
    metaTitle: 'Home', metaDesc: 'Play Cash Pop lottery — provably fair draws, instant wins.',
    draws: draws.map(d => ({ ...d, label: d.draw_type === 'DAY' ? 'Day Draw' : 'Evening Draw' })),
    recentResults, recentWins, nextDraw,
    stats: { players: statPlayers, tickets_today: ticketsToday.c, paid_out: statPaid, paid_out_fmt: req.fmt(statPaid), mode: statsMode },
  });
});

router.get('/page/:slug', async (req, res) => {
  const pg = await req.db.get('SELECT * FROM pages WHERE slug = ? AND status = ?', [req.params.slug, 'published']);
  if (!pg) return res.status(404).render('error', { status: 404, message: 'Page not found.' });
  const blocks = {};
  for (const b of await req.db.query('SELECT `key`, body FROM content_blocks')) blocks[b.key] = b.body;
  res.render('cms', {
    metaTitle: pg.meta_title || pg.title, metaDesc: pg.meta_desc || '',
    pg: { ...pg, body: resolveContent(pg.body, blocks) },
    canonical: (process.env.BASE_URL || '') + '/page/' + pg.slug,
  });
});

router.get('/results', async (req, res) => {
  const draws = await req.db.query("SELECT * FROM draws WHERE status = 'settled' ORDER BY close_at DESC LIMIT 60");
  res.render('results', { metaTitle: 'Results', metaDesc: 'Latest Cash Pop draw results.', draws });
});

router.get('/fairness', async (req, res) => {
  let result = null;
  const drawId = parseInt(req.query.draw_id, 10);
  if (drawId) {
    const d = await req.db.get('SELECT * FROM draws WHERE id = ?', [drawId]);
    if (d) {
      const recomputedHash = d.seed ? sha256(d.seed) : null;
      // v14: pre-v14 draws (no beacon fields) use the legacy %15 derivation;
      // newer draws combine the revealed seed with the recorded beacon
      // randomness and use rejection sampling — exactly as settle did.
      let recomputedNumber = null;
      if (d.seed) {
        if (!d.beacon_status) recomputedNumber = deriveWinningNumberLegacy(d.seed, d.id);
        else recomputedNumber = deriveWinningNumberFair(combineSeed(d.seed, d.beacon_randomness || ''), d.id);
      }
      result = {
        draw: publicDrawInfo(d),
        recomputed_hash: recomputedHash,
        hash_match: recomputedHash ? (recomputedHash === d.seed_hash) : null,
        recomputed_number: recomputedNumber,
        number_match: recomputedNumber !== null ? (recomputedNumber === d.winning_number) : null,
      };
    } else {
      result = { notFound: true };
    }
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
