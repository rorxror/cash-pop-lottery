'use strict';
/* Public site: home, CMS pages, results, fairness verifier, currency switch,
   sitemap.xml, robots.txt. */
const express = require('express');
const router = express.Router();
const { sha256 } = require('../lib/util');
const { deriveWinningNumber, publicDrawInfo } = require('../lib/draws');

function resolveContent(body, blocks) {
  return String(body || '').replace(/\{\{\s*content:([a-z0-9_]+)\s*\}\}/gi, (_, k) => blocks[k] || '');
}

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
  res.render('index', {
    metaTitle: 'Home', metaDesc: 'Play Cash Pop lottery — provably fair draws, instant wins.',
    draws: draws.map(d => ({ ...d, label: d.draw_type === 'DAY' ? 'Day Draw' : 'Evening Draw' })),
    recentResults, stats: { players: players.c, tickets_today: ticketsToday.c, paid_out: paidOut.s, paid_out_fmt: req.fmt(paidOut.s) },
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
      const recomputedNumber = d.seed ? deriveWinningNumber(d.seed, d.id) : null;
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
