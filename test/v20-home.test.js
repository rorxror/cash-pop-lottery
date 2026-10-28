'use strict';
/* V20 HOME (owner-fix round, wave B) regression tests — U-03/U-09/U-10/
   U-11/U-12/U-13. Run: node --test test/v20-home.test.js
   Spawned server on port 4124 with a fresh temp SQLite DB (the recipe
   env from the round brief). A fresh DB auto-seeds a live Gold Rush
   scratch series and 7 days of DAY+EVE draws, so the present-states
   are the default boot; the absent scratch state is proven by stopping
   the series in the DB and re-rendering, then restoring it.
   Draw expectations are computed from the DB itself (next 2 of EACH
   type merged by close_at) — never from the wall clock — so the pair
   construction is proven at any time of day. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-v20home-'));
const DB_PATH = path.join(TMP, 't.sqlite');
const PORT = 4124;
const BASE = 'http://localhost:' + PORT;
let server = null;

class Jar {
  constructor(ua) { this.cookies = new Map(); this.ua = ua || 'v20-home-test'; }
  async req(p, { method = 'GET', body } = {}) {
    const headers = { 'User-Agent': this.ua };
    if (this.cookies.size) headers.Cookie = [...this.cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
    let payload;
    if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    const res = await fetch(BASE + p, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const pair = c.split(';')[0]; const i = pair.indexOf('=');
      if (i > 0) { const k = pair.slice(0, i).trim(); const v = pair.slice(i + 1).trim(); if (v) this.cookies.set(k, v); else this.cookies.delete(k); }
    }
    return res;
  }
  async text(p, opts) { const r = await this.req(p, opts); return { status: r.status, loc: r.headers.get('location') || '', body: await r.text() }; }
}
function csrfOf(html) { const m = String(html).match(/name="_csrf" value="([^"]+)"/); return m && m[1]; }
function count(hay, needle) { return String(hay).split(needle).length - 1; }

function withDb(fn) {
  const db = new DatabaseSync(DB_PATH);
  try { db.exec('PRAGMA busy_timeout = 5000'); return fn(db); }
  finally { try { db.close(); } catch {} }
}
/* The U-03 construction, computed straight from the DB: next 2 of each
   type, merged by close_at (tie-break draw_date, then type). */
function expectedDraws() {
  return withDb(db => {
    const rows = [];
    for (const type of ['DAY', 'EVE']) {
      rows.push(...db.prepare(
        "SELECT draw_type, draw_date, close_at FROM draws WHERE status = 'scheduled' AND draw_type = ? ORDER BY close_at ASC LIMIT 2"
      ).all(type));
    }
    rows.sort((a, b) => (Number(a.close_at) - Number(b.close_at))
      || String(a.draw_date).localeCompare(String(b.draw_date))
      || String(a.draw_type).localeCompare(String(b.draw_type)));
    return rows.map(r => ({
      type: r.draw_type,
      label: r.draw_type === 'DAY' ? 'Day Draw' : 'Evening Draw',
      date: r.draw_date, close_at: Number(r.close_at),
    }));
  });
}
function parseDrawCards(html) {
  const cards = [];
  const re = /<article class="v20-draw-card">([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    const label = (body.match(/(Day Draw|Evening Draw)/) || [])[1] || '';
    const date = (body.match(/(\d{4}-\d{2}-\d{2})/) || [])[1] || '';
    const close = (body.match(/data-close-at="(\d+)"/) || [])[1] || '';
    cards.push({ label, date, close_at: Number(close), raw: body });
  }
  return cards;
}
function scratchSection(html) {
  const i = String(html).indexOf('v20-scratch-section');
  if (i === -1) return '';
  const end = String(html).indexOf('</section>', i);
  return String(html).slice(i, end === -1 ? undefined : end);
}
async function waitHealthy(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.status === 200) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

let anonHome = '';
let authHome = '';

test.before(async () => {
  const env = { ...process.env,
    PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite',
    SQLITE_PATH: DB_PATH,
    TICKET_HMAC_SECRET: '<redacted>',
    ADMIN_SEED_EMAIL: 'admin@v20home.test', ADMIN_SEED_PASSWORD: 'V20Admin#pass', ADMIN_SEED_NAME: 'V20 Admin',
  };
  delete env.DATABASE_URL; delete env.SMTP_HOST; delete env.DATABASE_URL_PG;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[v20-home server] ' + d));
  assert.ok(await waitHealthy(), 'server must boot and answer /healthz');

  // Draw generation runs from the boot cron tick; poll until the
  // homepage serves the full 4-card pair set.
  const anon = new Jar();
  for (let i = 0; i < 30; i++) {
    anonHome = (await anon.text('/')).body;
    if (parseDrawCards(anonHome).length === 4) break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.equal(parseDrawCards(anonHome).length, 4, 'seeded boot must serve 4 draw cards');

  const jar = new Jar('V20HomePlayer/1.0');
  const g = await jar.text('/register');
  const post = await jar.text('/register', { method: 'POST', body: {
    _csrf: csrfOf(g.body), name: 'V20 Home Player', email: 'player@v20home.test',
    phone_cc: '+1', phone_local: '5551113333', phone: '+15551113333',
    password: 'PlayerPass#1', password_confirm: 'PlayerPass#1', agree: 'on',
  } });
  assert.equal(post.status, 302, 'register redirects');
  authHome = (await jar.text('/')).body;
});

test.after(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch {} }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('U-03: rendered draws equal the DB pair construction (next 2 DAY + next 2 EVE, merged by close_at)', () => {
  const expected = expectedDraws();
  assert.equal(expected.length, 4, 'seeded DB must hold at least 2 scheduled draws of each type');
  assert.equal(expected.filter(d => d.type === 'DAY').length, 2, 'exactly 2 DAY in the expected set');
  assert.equal(expected.filter(d => d.type === 'EVE').length, 2, 'exactly 2 EVE in the expected set');
  const rendered = parseDrawCards(anonHome);
  assert.deepEqual(
    rendered.map(c => ({ label: c.label, date: c.date, close_at: c.close_at })),
    expected.map(d => ({ label: d.label, date: d.date, close_at: d.close_at })),
    'rendered sequence (type/date/close) must equal the pair construction'
  );
  const closes = rendered.map(c => c.close_at);
  assert.deepEqual(closes, [...closes].sort((a, b) => a - b), 'cards are in chronological order');
});

test('U-03: a +24h roll of the next DAY draw cannot duplicate a type or break the pairs', async () => {
  const next = withDb(db => db.prepare(
    "SELECT id, close_at FROM draws WHERE status = 'scheduled' AND draw_type = 'DAY' ORDER BY close_at ASC LIMIT 1"
  ).get());
  assert.ok(next, 'a next DAY draw exists');
  withDb(db => db.prepare('UPDATE draws SET close_at = ? WHERE id = ?').run(Number(next.close_at) + 86400000, next.id));
  try {
    const html = (await new Jar().text('/')).body;
    const rendered = parseDrawCards(html);
    const expected = expectedDraws();
    assert.equal(rendered.length, 4, 'still exactly 4 cards after the roll');
    assert.equal(rendered.filter(c => c.label === 'Day Draw').length, 2, 'still exactly 2 Day cards (no Day,Evening,Day duplication)');
    assert.equal(rendered.filter(c => c.label === 'Evening Draw').length, 2, 'still exactly 2 Evening cards');
    assert.deepEqual(
      rendered.map(c => ({ label: c.label, date: c.date, close_at: c.close_at })),
      expected.map(d => ({ label: d.label, date: d.date, close_at: d.close_at })),
      'post-roll rendering still equals the pair construction'
    );
  } finally {
    withDb(db => db.prepare('UPDATE draws SET close_at = ? WHERE id = ?').run(Number(next.close_at), next.id));
  }
});

test('U-03/U-11: countdown format is unified — always a day part, one ticker contract on every card', async () => {
  const js = await (await fetch(BASE + '/app.js')).text();
  assert.match(js, /el\.textContent = d \+ 'd ' \+ pad\(h\)/, 'tick always writes "Dd HH:MM:SS"');
  assert.ok(!js.includes("d > 0 ? d + 'd '"), 'the old conditional day-prefix (two structures) is gone');
  assert.match(js, /querySelectorAll\('\.countdown\[data-close-at\]'\)/, 'ticker still selects .countdown[data-close-at]');
  // Server placeholders share the same structure on banner + all cards.
  const placeholders = [...anonHome.matchAll(/class="countdown[^"]*"[^>]*>([^<]*)</g)].map(m => m[1]);
  assert.ok(placeholders.length >= 5, 'banner + 4 card countdowns render');
  assert.ok(placeholders.every(p => p === '-d --:--:--'), 'every countdown placeholder is identical: ' + JSON.stringify(placeholders));
  for (const c of parseDrawCards(anonHome)) {
    assert.match(c.raw, /class="countdown v20-draw-countdown" data-close-at="\d+"/, 'card countdown carries countdown + v20 class + epoch close');
    assert.match(c.raw, /class="v20-draw-ball"/, 'card carries the glossy v20 ball');
    assert.match(c.raw, /class="btn btn-p btn-sm btn-block v20-draw-enter"/, 'Enter button carries .v20-draw-enter');
  }
});

test('U-09: feature cards use the v20 primitives, icon → title → body, honest copy', () => {
  assert.equal(count(anonHome, 'class="v20-feature-card"'), 4, 'exactly 4 feature cards');
  assert.equal(count(anonHome, 'trust-badge'), 0, 'old trust badges are gone');
  const cards = [...anonHome.matchAll(/<div class="v20-feature-card">([\s\S]*?)<\/div>/g)].map(m => m[1]);
  assert.equal(cards.length, 4);
  const titles = cards.map(c => (c.match(/v20-feature-title">([^<]+)</) || [])[1]);
  assert.deepEqual(titles, ['Provably Fair', 'Fast Win Credits', 'Secure Platform', 'Daily Draws']);
  for (const c of cards) {
    const iIcon = c.indexOf('v20-feature-icon'), iTitle = c.indexOf('v20-feature-title'), iBody = c.indexOf('v20-feature-body');
    assert.ok(iIcon !== -1 && iTitle > iIcon && iBody > iTitle, 'icon on top, then title, then full-width body');
  }
  const fast = cards[1];
  assert.match(fast, /as soon as the draw settles/, 'Fast Win Credits keeps the settlement qualifier');
  assert.ok(!/instant/i.test(fast), 'Fast Win Credits makes no instant-payment claim');
  assert.ok(!anonHome.includes('Provably fair, transparent draws'), 'the duplicated Secure Platform body copy is gone');
  assert.match(cards[2], /server/, 'Secure Platform body states the server-side claim it can back');
});

test('U-10: stats are an equal v20 3-up with unchanged real values (0 anon → 1 player after one registration)', () => {
  assert.equal(count(anonHome, 'class="v20-stat-card"'), 3, 'exactly 3 stat cards');
  assert.equal(count(anonHome, 'class="hstat"'), 0, 'old unequal hstat boxes are gone');
  const cards = [...anonHome.matchAll(/<div class="v20-stat-card">([\s\S]*?)<\/div>/g)].map(m => m[1]);
  assert.equal(cards.length, 3);
  const labels = cards.map(c => (c.match(/v20-stat-label">([^<]+)</) || [])[1]);
  assert.deepEqual(labels, ['Players', 'Tickets in the last 24 hours', 'Paid out']);
  for (const c of cards) {
    assert.match(c, /class="v20-stat-deco" aria-hidden="true"/, 'decorative ball present and aria-hidden');
    assert.ok(!/<a[\s>]/.test(c), 'no Play/link button inside a stat card for the deco to cover');
    assert.match(c, /live-count/, 'value keeps the .live-count hook');
  }
  const anonCounts = [...anonHome.matchAll(/live-count" data-count="(\d+)"/g)].map(m => Number(m[1]));
  assert.deepEqual(anonCounts, [0, 0, 0], 'fresh DB real aggregates are 0/0/0 (nothing fabricated)');
  const authCounts = [...authHome.matchAll(/live-count" data-count="(\d+)"/g)].map(m => Number(m[1]));
  assert.equal(authCounts[0], 1, 'after exactly one registration the Players value is the real 1');
});

test('U-12: logged-out homepage showcases the live Gold Rush series with register/sign-in CTAs and no balance', () => {
  const sec = scratchSection(anonHome);
  assert.ok(sec, 'scratch section renders when a live series exists');
  assert.match(sec, /Gold Rush/, 'real seeded series name');
  assert.match(sec, /\$1\.00/, 'real series price');
  assert.match(sec, /\$10\.00/, 'real top prize from the tier table');
  assert.match(sec, /<small>Remaining<\/small><strong>100<\/strong>/, 'real unclaimed-outcome count');
  assert.match(sec, /href="\/register"/, 'logged-out CTA to register');
  assert.match(sec, /href="\/login"/, 'logged-out CTA to sign in');
  assert.ok(!/balance/i.test(sec), 'no balance of any kind in the logged-out scratch section');
});

test('U-12: logged-in homepage scratch CTA goes straight to /scratch', () => {
  const sec = scratchSection(authHome);
  assert.ok(sec, 'scratch section renders logged in');
  assert.match(sec, /Gold Rush/);
  assert.match(sec, /href="\/scratch"/, 'logged-in CTA targets /scratch');
  assert.match(sec, /Play Scratch Cards/);
  assert.ok(!sec.includes('href="/register"'), 'no register CTA inside the logged-in scratch section');
});

test('U-13: steps are v20 cards with numerals inside, lottery + scratch at equal prominence', () => {
  assert.equal(count(anonHome, 'class="v20-steps"'), 2, 'two step grids (lottery + scratch)');
  const cards = [...anonHome.matchAll(/<div class="v20-step-card">([\s\S]*?)<\/div>/g)].map(m => m[1]);
  assert.equal(cards.length, 7, '4 lottery steps + 3 scratch steps');
  for (const c of cards) {
    const iNum = c.indexOf('v20-step-num'), iTitle = c.indexOf('<strong>');
    assert.ok(iNum !== -1 && iTitle > iNum, 'numeral chip is inside the card, before its title');
  }
  for (const t of ['Pick 1–15 pops', 'Set your wager', 'Buy your ticket', 'Buy a card', 'Scratch to reveal', 'Prize credited at reveal'])
    assert.ok(anonHome.includes('<strong>' + t + '</strong>'), 'step present: ' + t);
  assert.match(anonHome, /credited to your wallet when you reveal it/, 'scratch prize wording is the truthful at-reveal credit');
  assert.ok(!anonHome.includes('<ol><li><strong>Pick 1–15 pops'), 'the raw CMS <ol> no longer renders as the homepage steps');
});

test('U-12: with no live series the homepage renders NO scratch section (and it returns when live again)', async () => {
  withDb(db => db.prepare("UPDATE scratch_series SET status = 'stopped', enabled = 0 WHERE slug = 'gold-rush'").run());
  try {
    const html = (await new Jar().text('/')).body;
    assert.equal(html.indexOf('v20-scratch-section'), -1, 'section omitted entirely when nothing is live');
    assert.ok(!html.includes('Gold Rush'), 'no series content (and no placeholder) is rendered');
  } finally {
    withDb(db => db.prepare("UPDATE scratch_series SET status = 'live', enabled = 1 WHERE slug = 'gold-rush'").run());
  }
  const html2 = (await new Jar().text('/')).body;
  assert.ok(scratchSection(html2).includes('Gold Rush'), 'section returns once the series is live again — data-driven, not static');
});
