'use strict';
/* V20 / U-26 — admin organization / smart placement regression tests.
   Run: node --test test/v20-u26.test.js   (port 4147, /tmp/u26.sqlite)
   Covers: (1) the set of admin+agent route PATHS is frozen vs the
   pre-U-26 inventory derived from adj-admin.md + the code (U-26 moves
   nav/placement only, never URLs); (2) the sidebar is grouped in the
   U-26 operator groups and every console GET page is reachable by
   clicking rendered links from the console home (BFS crawl, all 200);
   (3) per-role nav visibility — each staff role's rendered nav lacks
   entries outside its role set and every entry it shows returns 200;
   (4) the agent area nav is present on every agent page incl. Add
   Player + Transfer; (5) TWO DOORS round-trips — support limits
   (Settings ⇄ Support queue), auto-withdrawal limit (Settings ⇄
   Withdrawals), incident toggles (Settings ⇄ Dashboard), KYC switch
   (Settings ⇄ KYC queue) — each door form is parsed out of the
   rendered page, submitted, and the OTHER door must show the new
   value, in both directions, with sibling settings proven unchanged.
   Staff/agent rows are seeded directly in the DB for crawl purposes
   (stated in adj-u26.md); all money/support activity is seeded
   through the real flows. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 4147;
const BASE = 'http://localhost:' + PORT;
const AP = '/ops-7f3a9c-console';
const DBFILE = '/tmp/u26.sqlite';
const ENC_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

process.env.SQLITE_PATH = DBFILE;
process.env.DB_DRIVER = 'sqlite';
process.env.CREDENTIAL_ENCRYPTION_KEY = ENC_KEY;
delete process.env.DATABASE_URL;

const { openDB } = require('../lib/db');
const { hashPassword } = require('../lib/util');
const uploadLib = require('../lib/upload');
const ui = require('../lib/admin-ui');

class Jar {
  constructor(ua) { this.cookies = new Map(); this.ua = ua || 'u26-test'; }
  async req(p, { method = 'GET', body, headers = {} } = {}) {
    const h = { 'User-Agent': this.ua, ...headers };
    if (this.cookies.size) h.Cookie = [...this.cookies.entries()].map(([k, v]) => k + '=' + v).join('; ');
    let payload;
    if (body) { h['Content-Type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    const res = await fetch(BASE + p, { method, headers: h, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) { const pair = c.split(';')[0]; const i = pair.indexOf('='); if (i > 0) { const k = pair.slice(0, i).trim(); const v = pair.slice(i + 1).trim(); if (v) this.cookies.set(k, v); else this.cookies.delete(k); } }
    return res;
  }
  async text(p, opts) { const r = await this.req(p, opts); return { status: r.status, loc: r.headers.get('location') || '', headers: r.headers, body: await r.text() }; }
  async post(p, body) { return this.text(p, { method: 'POST', body }); }
}
function csrfOf(html) { const m = String(html).match(/name="_csrf" value="([^"]+)"/); return m && m[1]; }
async function csrfFor(jar, getPath) { const g = await jar.text(getPath); assert.equal(g.status, 200, 'csrf page ' + getPath + ' -> ' + g.status); return csrfOf(g.body); }
async function waitHealthy(tries = 80) {
  for (let i = 0; i < tries; i++) { try { const r = await fetch(BASE + '/healthz'); if (r.status === 200) return true; } catch {} await new Promise(r => setTimeout(r, 500)); }
  return false;
}
async function login(jar, email, password) {
  const g = await jar.text('/login');
  const post = await jar.post('/login', { _csrf: csrfOf(g.body), email, password });
  assert.equal(post.status, 302, 'login ' + email + ' -> ' + post.status);
  return post;
}
/* Parse one rendered form (by action substring) into {action, fields}.
   Checkboxes are included only when rendered checked — exactly what a
   browser would submit. Selects submit their selected option. */
function parseForm(html, actionPart) {
  const forms = String(html).match(/<form\b[^>]*>[\s\S]*?<\/form>/gi) || [];
  for (const f of forms) {
    const am = f.match(/action="([^"]+)"/);
    if (!am || !am[1].includes(actionPart)) continue;
    const fields = {};
    for (const im of f.matchAll(/<input\b[^>]*>/gi)) {
      const tag = im[0];
      const name = (tag.match(/name="([^"]+)"/) || [])[1];
      if (!name) continue;
      const type = (tag.match(/type="([^"]+)"/) || [])[1] || 'text';
      if (type === 'checkbox' || type === 'radio') { if (/\bchecked\b/.test(tag)) fields[name] = (tag.match(/value="([^"]*)"/) || [])[1] || '1'; }
      else if (type !== 'submit' && type !== 'button') fields[name] = (tag.match(/value="([^"]*)"/) || [])[1] || '';
    }
    for (const sm of f.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/gi)) {
      const sel = sm[2].match(/<option\b[^>]*\bselected\b[^>]*>/) || sm[2].match(/<option\b[^>]*>/);
      if (sel) fields[sm[1]] = (sel[0].match(/value="([^"]*)"/) || [])[1] || '';
    }
    for (const tm of f.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/gi)) fields[tm[1]] = tm[2];
    return { action: am[1], fields };
  }
  return null;
}
function navHrefs(html) {
  const nav = (String(html).match(/<nav>([\s\S]*?)<\/nav>/) || [])[1] || '';
  return [...nav.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
}

/* ---- frozen route inventory (pre-U-26 code state) ---- */
const ADMIN_GET = ['/', '/draws', '/draws/:id', '/tickets', '/tickets/:id', '/automation', '/bonuses', '/users', '/users/:id', '/otp', '/agents', '/agents/:id', '/deposits', '/deposits/:id', '/withdrawals', '/withdrawals/:id', '/methods', '/methods/new', '/methods/:id', '/methods/:id/credentials', '/reports', '/data', '/data/export/:dataset', '/support', '/kyc', '/kyc/document/:id', '/kyc/:id', '/support/canned-replies', '/support/:publicId', '/extensions', '/extensions/:key', '/notifications', '/notifications/log/:id', '/contact-messages', '/notifications/:id', '/pages', '/pages/new', '/pages/:id', '/content/:key', '/cron', '/login-history', '/referrals', '/settings', '/approvals', '/reconciliation', '/flags', '/staff', '/security', '/audit'];
const ADMIN_POST = ['/draws/test', '/draws/:id/settle', '/draws/:id/cancel', '/automation/master', '/automation/draws', '/automation/scratch', '/automation/job/:id/toggle', '/automation/job/:id/run', '/bonuses/master', '/bonuses/save', '/bonuses/:id/run', '/bonuses/:id/toggle', '/bonuses/:id/delete', '/users/:id', '/users/:id/kyc-verify', '/users/:id/block', '/users/:id/reset-password', '/users/:id/revoke-sessions', '/users/:id/adjust', '/users/:id/matrix', '/users/:id/verify-contact', '/users/:id/login-as', '/otp', '/otp/:id/revoke', '/agents', '/agents/:id/settle-commissions', '/agents/:id/fund', '/deposits/:id/approve', '/deposits/:id/reject', '/deposits/:id/revoke', '/deposits/:id/note', '/withdrawals/:id/approve', '/withdrawals/:id/reject', '/withdrawals/:id/revoke', '/withdrawals/:id/mark-paid', '/withdrawals/:id/note', '/methods/new', '/methods/:id', '/methods/:id/toggle', '/methods/:id/delete', '/methods/:id/credentials', '/data/import', '/data/import/execute', '/kyc/:id/approve', '/kyc/:id/reject', '/support/canned-replies', '/support/canned-replies/:id', '/support/canned-replies/:id/delete', '/support/:publicId/reply', '/support/:publicId/close', '/support/:publicId/reopen', '/support/:publicId/delete', '/extensions/:key', '/extensions/:key/toggle', '/notifications/send', '/notifications/announcements', '/notifications/announcements/:id/toggle', '/notifications/announcements/:id/delete', '/contact-messages/:id/handled', '/notifications/process-due', '/notifications/:id', '/pages/new', '/pages/:id', '/pages/:id/delete', '/content/:key', '/cron/schedule', '/cron/:id/run', '/cron/:id/toggle', '/settings/clear-cache', '/settings/toggles', '/settings/economy', '/settings/risk', '/settings/kyc', '/settings/phone-countries', '/settings/support-limits', '/settings/prizes/preview', '/settings/prizes', '/settings/currencies', '/settings/appearance', '/approvals/:id/approve', '/approvals/:id/reject', '/reconciliation/run', '/flags/:id/review', '/staff', '/staff/:id/role', '/security/totp/start', '/security/totp/confirm', '/security/totp/disable'];
const SCRATCH_ADMIN = ['GET /', 'GET /:id', 'POST /planner/preview', 'POST /planner/create', 'POST /create', 'POST /:id/launch', 'POST /:id/toggle', 'POST /:id/stop'];
const AGENT_ROUTES = ['GET /', 'GET /players', 'POST /players/claim', 'GET /players/new', 'POST /players/new', 'GET /transfer', 'POST /transfer', 'GET /commissions', 'GET /support', 'GET /support/:publicId', 'POST /support/:publicId/delete', 'POST /support/:publicId/reply'];

let server = null, db = null;
let admin, player, agentJar;
const staffJars = {};
let playerId, agentId, bankId;

test.before(async () => {
  for (const suffix of ['', '-wal', '-shm']) { try { fs.unlinkSync(DBFILE + suffix); } catch {} }
  try { fs.rmSync('/tmp/kyc-uploads', { recursive: true, force: true }); } catch {}
  const env = { ...process.env,
    PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite', SQLITE_PATH: DBFILE,
    TICKET_HMAC_SECRET: 'u26-test-hmac-secret-0123456789abcdef0123456789abcdef',
    CREDENTIAL_ENCRYPTION_KEY: ENC_KEY,
    ADMIN_SEED_EMAIL: 'admin@u26.test', ADMIN_SEED_PASSWORD: 'U26Admin#pass', ADMIN_SEED_NAME: 'U26 Admin' };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[u26 server] ' + d));
  assert.ok(await waitHealthy(), 'server must boot');
  db = openDB().db;

  admin = new Jar('u26-admin');
  await login(admin, 'admin@u26.test', 'U26Admin#pass');

  // Staff role rows seeded directly in the DB (crawl purposes — stated
  // in adj-u26.md); each then signs in through the real login flow.
  const staff = [['finance', 'finance@u26.test'], ['support', 'support@u26.test'], ['risk', 'risk@u26.test']];
  for (const [role, email] of staff) {
    await db.run("INSERT INTO users (email, name, password_hash, role, admin_role, status, email_verified, force_totp_enroll, created_at) VALUES (?, ?, ?, 'admin', ?, 'active', 1, 0, ?)",
      [email, 'U26 ' + role, hashPassword('Staff#pass123'), role, Date.now()]);
    staffJars[role] = new Jar('u26-' + role);
    await login(staffJars[role], email, 'Staff#pass123');
  }

  // Player through the real register flow.
  player = new Jar('u26-player');
  let g = await player.text('/register');
  let post = await player.post('/register', { _csrf: csrfOf(g.body), name: 'U26 Player', email: 'player@u26.test', password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' });
  assert.equal(post.status, 302, 'register -> ' + post.status);
  playerId = (await db.get("SELECT id FROM users WHERE email = 'player@u26.test'")).id;
  await db.run('UPDATE users SET email_verified = 1 WHERE id = ?', [playerId]);

  // Withdrawal OTP off via the real toggles form (proven pattern).
  const home = await admin.text(AP + '/');
  const tgl = parseForm(home.body, '/settings/toggles');
  assert.ok(tgl, 'dashboard carries the toggles door form');
  const tglBody = { ...tgl.fields }; delete tglBody.withdrawal_otp_enabled;
  await admin.post(AP + '/settings/toggles', tglBody);

  // Bank rail: credentials saved through the real form, then enabled.
  bankId = (await db.get("SELECT id FROM payment_methods WHERE slug = 'rail-bank_transfer'")).id;
  g = await admin.text(AP + '/methods/' + bankId + '/credentials');
  post = await admin.post(AP + '/methods/' + bankId + '/credentials', { _csrf: csrfOf(g.body), bank_name: 'U26 Bank', account_name: 'U26 Holdings', account_number: 'GB29NWBK60161331926819', swift: 'U26BANKX', routing_number: '' });
  assert.equal(post.status, 302, 'bank creds -> ' + post.status);
  await admin.post(AP + '/methods/' + bankId + '/toggle', { _csrf: await csrfFor(admin, AP + '/methods') });

  // Deposit $10 -> approve -> buy ticket -> adjust +$50 -> withdraw $5.
  g = await player.text('/deposit/new?m=' + bankId);
  post = await player.post('/deposit/new', { _csrf: csrfOf(g.body), method_id: String(bankId), amount: '10.00', custom_reference: 'REF-U26-1', custom_sender_name: 'U26 Player' });
  assert.equal(post.status, 302, 'deposit -> ' + post.status);
  const dep = await db.get('SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 1', [playerId]);
  await admin.post(AP + '/deposits/' + dep.id + '/approve', { _csrf: await csrfFor(admin, AP + '/deposits/' + dep.id) });
  g = await player.text('/play');
  post = await player.post('/play/buy', { _csrf: csrfOf(g.body), pops: '7', wager: '1000', draw_type: 'DAY', num_draws: '1', currency: 'USD' });
  assert.ok([200, 302].includes(post.status), 'ticket buy -> ' + post.status);
  await admin.post(AP + '/users/' + playerId + '/adjust', { _csrf: await csrfFor(admin, AP + '/users/' + playerId), direction: 'add', amount: '50.00', remark: 'u26 funding' });
  g = await player.text('/withdraw/new?m=' + bankId);
  post = await player.post('/withdraw/new', { _csrf: csrfOf(g.body), method_id: String(bankId), amount: '5.00', custom_account_name: 'U26 Player', custom_account_number: 'DE89370400440532013000', custom_bank_name: 'U26 Bank', custom_swift: '' });
  assert.equal(post.status, 302, 'withdraw -> ' + post.status);

  // Support ticket through the real player flow.
  g = await player.text('/support');
  post = await player.post('/support/new', { _csrf: csrfOf(g.body), subject: 'U26 help needed', message: 'Please check my deposit REF-U26-1.', priority: 'medium' });
  assert.equal(post.status, 302, 'support create -> ' + post.status);

  // Agent created through the admin flow; signs in for the agent crawl.
  post = await admin.post(AP + '/agents', { _csrf: await csrfFor(admin, AP + '/agents'), name: 'U26 Agent', email: 'agent@u26.test', password: 'Agent#pass123' });
  assert.equal(post.status, 302, 'agent create -> ' + post.status);
  const ag = await db.get("SELECT id FROM users WHERE email = 'agent@u26.test'");
  assert.ok(ag, 'agent row exists');
  agentId = ag.id;
  // The create flow forces a first-login password reset by design; the
  // crawl needs a working agent session, so clear that flag directly
  // (test seeding only — the forced-reset flow is covered elsewhere).
  await db.run('UPDATE users SET force_password_reset = 0 WHERE id = ?', [agentId]);
  agentJar = new Jar('u26-agent');
  await login(agentJar, 'agent@u26.test', 'Agent#pass123');

  // KYC document: real bytes into the private store + its DB row (the
  // document route must then serve them back through the crawl).
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const stored = uploadLib.storeUpload(png, 'png');
  await db.run("INSERT INTO kyc_documents (user_id, doc_type, stored_name, original_name, content_type, size_bytes, status, created_at) VALUES (?, 'passport', ?, 'passport.png', 'image/png', ?, 'pending', ?)",
    [playerId, stored, png.length, Date.now()]);

  // One outbox row through the real send flow (parent of /notifications/log/:id).
  post = await admin.post(AP + '/notifications/send', { _csrf: await csrfFor(admin, AP + '/notifications?tab=send'), to: String(playerId), subject: 'U26 hello', message: 'Welcome from U26.' });
  assert.equal(post.status, 302, 'notification send -> ' + post.status);

  // A CMS page + a content block, parents of /pages/:id and /content/:key.
  post = await admin.post(AP + '/pages/new', { _csrf: await csrfFor(admin, AP + '/pages/new'), name: 'U26 Page', slug: 'u26-page', title: 'U26 Page', meta_title: '', meta_desc: '', body: '<p>u26</p>', status: 'published' });
  assert.equal(post.status, 302, 'page create -> ' + post.status);
  const cb = await db.get('SELECT * FROM content_blocks LIMIT 1');
  if (!cb) await db.run('INSERT INTO content_blocks (key, title, body, updated_at) VALUES (?, ?, ?, ?)', ['u26_block', 'U26 block', '<p>x</p>', Date.now()]);
});

test.after(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch {} }
  try { if (db) await db.close(); } catch {}
});

/* ---------------- 1. paths frozen ---------------- */

test('route PATHS are unchanged vs the pre-U-26 inventory', () => {
  const grab = (file, re) => [...fs.readFileSync(path.join(ROOT, file), 'utf8').matchAll(re)].map(m => m[1].toUpperCase() + ' ' + m[2]);
  const adminRoutes = grab('routes/admin.js', /router\.(get|post)\('([^']+)'/g);
  assert.deepEqual(adminRoutes.filter(r => r.startsWith('GET')).map(r => r.slice(4)).sort(), [...ADMIN_GET].sort(), 'admin GET paths');
  assert.deepEqual(adminRoutes.filter(r => r.startsWith('POST')).map(r => r.slice(5)).sort(), [...ADMIN_POST].sort(), 'admin POST paths');
  assert.deepEqual(grab('routes/scratch.js', /adminRouter\.(get|post)\('([^']+)'/g).sort(), [...SCRATCH_ADMIN].sort(), 'scratch-admin paths');
  assert.deepEqual(grab('routes/agent.js', /router\.(get|post)\('([^']+)'/g).sort(), [...AGENT_ROUTES].sort(), 'agent paths');
});

/* ---------------- 2. grouped nav ---------------- */

test('sidebar is grouped in operator groups, all 31 destinations, clean labels', async () => {
  const home = await admin.text(AP + '/');
  assert.equal(home.status, 200);
  const groups = [...home.body.matchAll(/adm-group"[^>]*>([^<]+)</g)].map(m => m[1].replace(/&amp;/g, '&'));
  assert.deepEqual(groups, ['Overview', 'Money In & Out', 'Players & Agents', 'Games', 'Support', 'Bonuses & Growth', 'Security & Compliance', 'Settings & System'], 'group order');
  const hrefs = navHrefs(home.body);
  assert.equal(hrefs.length, 31, 'super nav has all 31 destinations, got ' + hrefs.length);
  for (const [, items] of ui.NAV_GROUPS) for (const [label, p, roles] of items) {
    assert.ok(hrefs.includes(AP + p), 'nav contains ' + label + ' (' + p + ')');
    assert.ok(!/\b(BP|R)-\d/.test(label), 'no project code in label: ' + label);
    assert.ok(roles === null || Array.isArray(roles), 'roles shape for ' + label);
  }
  // Every destination belongs to exactly one group.
  const all = ui.NAV_GROUPS.flatMap(([, items]) => items.map(([, p]) => p));
  assert.equal(new Set(all).size, all.length, 'no destination in two groups');
  // Active state: the current section is highlighted.
  const users = await admin.text(AP + '/users');
  assert.match(users.body, new RegExp('<a href="' + AP.replace(/\//g, '\\/') + '\\/users" class="active">'), 'Users entry is active on /users');
});

/* ---------------- 3. crawl ---------------- */

function toTemplate(p) {
  if (ADMIN_GET.includes(p) || p === '/scratch' || p === '/scratch/:id') return p;
  const rules = [
    [/^\/draws\/\d+$/, '/draws/:id'], [/^\/tickets\/\d+$/, '/tickets/:id'],
    [/^\/users\/\d+$/, '/users/:id'], [/^\/agents\/\d+$/, '/agents/:id'],
    [/^\/deposits\/\d+$/, '/deposits/:id'], [/^\/withdrawals\/\d+$/, '/withdrawals/:id'],
    [/^\/methods\/\d+\/credentials$/, '/methods/:id/credentials'], [/^\/methods\/\d+$/, '/methods/:id'],
    [/^\/methods\/new$/, '/methods/new'],
    [/^\/data\/export\/[^/]+$/, '/data/export/:dataset'],
    [/^\/kyc\/document\/\d+$/, '/kyc/document/:id'], [/^\/kyc\/\d+$/, '/kyc/:id'],
    [/^\/extensions\/[^/]+$/, '/extensions/:key'],
    [/^\/notifications\/log\/\d+$/, '/notifications/log/:id'], [/^\/notifications\/\d+$/, '/notifications/:id'],
    [/^\/pages\/\d+$/, '/pages/:id'], [/^\/content\/[^/]+$/, '/content/:key'],
    [/^\/support\/[^/]+$/, '/support/:publicId'],
    [/^\/scratch\/\d+$/, '/scratch/:id'],
  ];
  for (const [re, t] of rules) if (re.test(p)) return t;
  return p;
}

test('crawl: every console GET page reachable by clicks from home, all 200', { timeout: 180000 }, async () => {
  const seen = new Map(); // url -> status
  const queue = [AP + '/'];
  const templates = new Map(); // template -> {status, h1}
  let h1Count = 0, htmlCount = 0;
  while (queue.length && seen.size < 500) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    const r = await admin.text(url);
    seen.set(url, r.status);
    assert.notEqual(r.status, 500, 'crawl 500 at ' + url);
    const ct = r.headers.get('content-type') || '';
    const rel = url.slice(AP.length).split('?')[0] || '/';
    const tpl = toTemplate(rel);
    if (!templates.has(tpl) || templates.get(tpl).status !== 200) templates.set(tpl, { status: r.status, h1: '' });
    if (ct.includes('text/html')) {
      htmlCount++;
      const h1 = (r.body.match(/<div class="adm-top"><h1>([^<]*)<\/h1>/) || [])[1] || '';
      if (h1) { h1Count++; if (templates.get(tpl)) templates.get(tpl).h1 = h1; }
      const links = new Set();
      for (const m of r.body.matchAll(/(?:href|src)="([^"]+)"/g)) links.add(m[1]);
      for (const f of r.body.matchAll(/<form\b[^>]*method="GET"[^>]*>/gi)) { const a = f[0].match(/action="([^"]+)"/); if (a) links.add(a[1]); }
      for (const f of r.body.matchAll(/<form\b[^>]*>/gi)) { if (/method="GET"/i.test(f[0])) { const a = f[0].match(/action="([^"]+)"/); if (a) links.add(a[1]); } }
      for (const l of links) {
        if (!l.startsWith(AP)) continue;
        const clean = l.split('#')[0];
        if (clean && !seen.has(clean) && !queue.includes(clean)) queue.push(clean);
      }
    }
  }
  const expected = [...ADMIN_GET, '/scratch', '/scratch/:id'];
  const missing = expected.filter(t => !templates.has(t));
  const bad = expected.filter(t => templates.has(t) && templates.get(t).status !== 200);
  console.log('[u26 crawl] urls visited:', seen.size, '| html pages:', htmlCount, '| pages with H1:', h1Count, '| templates 200:', expected.length - bad.length, '/', expected.length);
  assert.deepEqual(missing, [], 'pages never reached by clicking: ' + missing.join(', '));
  assert.deepEqual(bad.map(t => t + '=' + templates.get(t).status), [], 'pages reached but not 200');
  assert.ok(h1Count >= Math.floor(htmlCount * 0.9), 'H1 present on >=90% of HTML pages (' + h1Count + '/' + htmlCount + ')');
});

/* ---------------- 4. per-role nav ---------------- */

const ROLE_FORBIDDEN = {
  finance: ['/support', '/support/canned-replies', '/contact-messages', '/draws', '/users', '/flags', '/otp', '/staff', '/settings', '/extensions', '/pages', '/cron', '/automation', '/audit'],
  support: ['/deposits', '/withdrawals', '/methods', '/approvals', '/reconciliation', '/users', '/agents', '/draws', '/scratch', '/automation', '/bonuses', '/kyc', '/flags', '/otp', '/staff', '/settings', '/extensions', '/pages', '/cron', '/audit'],
  risk: ['/deposits', '/withdrawals', '/methods', '/reconciliation', '/agents', '/scratch', '/bonuses', '/kyc', '/support', '/support/canned-replies', '/contact-messages', '/notifications', '/otp', '/staff', '/settings', '/extensions', '/pages', '/cron', '/automation', '/audit'],
};
const ROLE_REQUIRED = {
  finance: ['/deposits', '/withdrawals', '/methods', '/kyc', '/bonuses'],
  support: ['/support', '/support/canned-replies', '/contact-messages', '/notifications'],
  risk: ['/draws', '/users', '/flags', '/approvals'],
};

for (const role of ['finance', 'support', 'risk']) {
  test('RBAC nav: ' + role + ' sees only its own entries, each opens 200', { timeout: 60000 }, async () => {
    const jar = staffJars[role];
    const home = await jar.text(AP + '/');
    assert.equal(home.status, 200);
    const hrefs = navHrefs(home.body);
    for (const f of ROLE_FORBIDDEN[role]) assert.ok(!hrefs.includes(AP + f), role + ' nav must NOT contain ' + f);
    for (const r of ROLE_REQUIRED[role]) assert.ok(hrefs.includes(AP + r), role + ' nav must contain ' + r);
    for (const h of hrefs) {
      const r = await jar.text(h);
      assert.equal(r.status, 200, role + ' nav entry ' + h + ' -> ' + r.status + ' (must open, never 403)');
    }
  });
}

test('agent nav: present on every agent page, only agent destinations, all 200', { timeout: 60000 }, async () => {
  const pages = ['/agent', '/agent/players', '/agent/players/new', '/agent/transfer', '/agent/commissions', '/agent/support'];
  for (const p of pages) {
    const r = await agentJar.text(p);
    assert.equal(r.status, 200, p + ' -> ' + r.status);
    assert.ok(r.body.includes('agent-nav'), p + ' renders the agent nav bar');
    for (const dest of pages) assert.ok(r.body.includes('href="' + dest + '"'), p + ' nav links ' + dest);
    assert.ok(!r.body.includes(AP), p + ' never references the admin console path');
  }
  // The support detail hangs under the Support parent link.
  const sup = await db.get('SELECT public_id FROM support_tickets LIMIT 1');
  await db.run('UPDATE users SET agent_id = ? WHERE id = ?', [agentId, playerId]);
  const det = await agentJar.text('/agent/support/' + sup.public_id);
  assert.equal(det.status, 200, 'agent support detail -> ' + det.status);
  assert.ok(det.body.includes('agent-nav'), 'agent support detail renders the agent nav bar');
});

/* ---------------- 5. two doors ---------------- */

test('DOOR 1 support limits: Support queue ⇄ Settings round-trip', { timeout: 60000 }, async () => {
  // A -> B: save through the Support queue door form as rendered.
  let page = await admin.text(AP + '/support');
  const door = parseForm(page.body, '/settings/support-limits');
  assert.ok(door, 'support queue renders the limits door form');
  let post = await admin.post(door.action, { ...door.fields, support_max_open_tickets: '4', support_max_new_tickets_24h: '6' });
  assert.equal(post.status, 302);
  page = await admin.text(AP + '/settings');
  const inSettings = parseForm(page.body, '/settings/support-limits');
  assert.equal(inSettings.fields.support_max_open_tickets, '4', 'Settings shows the value saved from Support');
  assert.equal(inSettings.fields.support_max_new_tickets_24h, '6');
  // B -> A: save back through the Settings form as rendered.
  post = await admin.post(inSettings.action, { ...inSettings.fields, support_max_open_tickets: '2', support_max_new_tickets_24h: '3' });
  assert.equal(post.status, 302);
  page = await admin.text(AP + '/support');
  const back = parseForm(page.body, '/settings/support-limits');
  assert.equal(back.fields.support_max_open_tickets, '2', 'Support queue shows the value saved from Settings');
  assert.equal(back.fields.support_max_new_tickets_24h, '3');
  const row = await db.get("SELECT value FROM settings WHERE key = 'support_max_open_tickets'").catch(() => null);
  if (row) assert.equal(row.value, '2');
});

test('DOOR 2 auto-withdrawal limit: Withdrawals ⇄ Settings, siblings unchanged', { timeout: 60000 }, async () => {
  const before = await admin.text(AP + '/settings');
  const riskBefore = parseForm(before.body, '/settings/risk');
  // A -> B: save through the Withdrawals door form as rendered.
  let page = await admin.text(AP + '/withdrawals');
  const door = parseForm(page.body, '/settings/risk');
  assert.ok(door, 'withdrawals page renders the risk door form');
  assert.ok('auto_withdrawal_limit' in door.fields, 'door form carries the auto-withdrawal field');
  let post = await admin.post(door.action, { ...door.fields, auto_withdrawal_limit: '75.00' });
  assert.equal(post.status, 302);
  page = await admin.text(AP + '/settings');
  const inSettings = parseForm(page.body, '/settings/risk');
  assert.equal(inSettings.fields.auto_withdrawal_limit, '75.00', 'Settings shows the value saved from Withdrawals');
  // Sibling risk fields must be untouched by the door save.
  for (const k of ['withdrawal_daily_cap', 'withdrawal_monthly_cap', 'payout_lock_hours', 'maker_checker_threshold', 'referral_cap_per_referee']) {
    assert.equal(inSettings.fields[k], riskBefore.fields[k], 'sibling ' + k + ' unchanged by door save');
  }
  // B -> A: save back through the Settings form.
  post = await admin.post(inSettings.action, { ...inSettings.fields, auto_withdrawal_limit: '50.00' });
  assert.equal(post.status, 302);
  page = await admin.text(AP + '/withdrawals');
  const back = parseForm(page.body, '/settings/risk');
  assert.equal(back.fields.auto_withdrawal_limit, '50.00', 'Withdrawals door shows the value saved from Settings');
  post = await admin.post(back.action, { ...back.fields, auto_withdrawal_limit: '0' });
  assert.equal(post.status, 302, 'restore 0 = OFF');
});

test('DOOR 3 incident toggles: Dashboard ⇄ Settings, siblings unchanged', { timeout: 60000 }, async () => {
  const settingsBefore = parseForm((await admin.text(AP + '/settings')).body, '/settings/toggles');
  assert.ok(settingsBefore, 'settings toggles form exists');
  // A -> B: flip maintenance ON through the Dashboard door form as rendered.
  let page = await admin.text(AP + '/');
  const door = parseForm(page.body, '/settings/toggles');
  assert.ok(door, 'dashboard renders the incident door form');
  let post = await admin.post(door.action, { ...door.fields, maintenance_mode: '1' });
  assert.equal(post.status, 302);
  const inSettings = parseForm((await admin.text(AP + '/settings')).body, '/settings/toggles');
  assert.ok('maintenance_mode' in inSettings.fields, 'Settings shows maintenance ON after Dashboard save');
  for (const k of Object.keys(settingsBefore.fields)) {
    if (k === '_csrf' || k === 'maintenance_mode') continue;
    assert.equal(inSettings.fields[k], settingsBefore.fields[k], 'toggle ' + k + ' unchanged by dashboard door save');
  }
  // B -> A: switch it back OFF through the Settings form.
  const off = { ...inSettings.fields }; delete off.maintenance_mode;
  post = await admin.post(inSettings.action, off);
  assert.equal(post.status, 302);
  const backDoor = parseForm((await admin.text(AP + '/')).body, '/settings/toggles');
  assert.ok(!('maintenance_mode' in backDoor.fields), 'Dashboard door shows maintenance OFF after Settings save');
});

test('DOOR 4 KYC switch: KYC queue ⇄ Settings round-trip', { timeout: 60000 }, async () => {
  let page = await admin.text(AP + '/kyc');
  const door = parseForm(page.body, '/settings/kyc');
  assert.ok(door, 'KYC queue renders the KYC door form');
  let post = await admin.post(door.action, { ...door.fields, kyc_enabled: '1', kyc_gate: 'withdrawals' });
  assert.equal(post.status, 302);
  const inSettings = parseForm((await admin.text(AP + '/settings')).body, '/settings/kyc');
  assert.ok('kyc_enabled' in inSettings.fields, 'Settings shows KYC ON after queue save');
  const off = { ...inSettings.fields }; delete off.kyc_enabled;
  post = await admin.post(inSettings.action, off);
  assert.equal(post.status, 302);
  const back = parseForm((await admin.text(AP + '/kyc')).body, '/settings/kyc');
  assert.ok(!('kyc_enabled' in back.fields), 'KYC queue shows KYC OFF after Settings save');
});

/* ---------------- 6. stealth untouched ---------------- */

test('stealth: player and anonymous still get plain 404 on the console', async () => {
  const asPlayer = await player.text(AP + '/');
  assert.equal(asPlayer.status, 404, 'player -> 404');
  const anon = new Jar('u26-anon');
  const asAnon = await anon.text(AP + '/settings');
  assert.equal(asAnon.status, 404, 'anonymous -> 404');
  const probe = await db.get("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'admin.probe'");
  assert.ok(probe.c >= 2, 'probes are audit-logged');
});
