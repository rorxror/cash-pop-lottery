'use strict';
/* V20 OWNER-FIX tests — U-18 (support turn-taking, server-enforced),
   U-19 (settings-driven creation limits), U-25 (player soft delete +
   its exact interplay with the U-19 counts).
   Run: node --test test/v20-support.test.js
   Spawned server on port 4123 (recipe env), fresh SQLite.
   Staff replies: the main unlock is done through the REAL admin route;
   later staff replies insert the exact row that route writes
   (support_messages with author_role != 'player'). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 4123;
const BASE = 'http://localhost:' + PORT;
const ADMIN_PATH = '/ops-7f3a9c-console';
const TMP_B = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-v20s-'));
let server = null;
let dbB = null;

class Jar {
  constructor(ua) { this.cookies = new Map(); this.ua = ua || 'v20-support-test'; }
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
async function waitHealthy(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.status === 200) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
async function register(jar, name, email) {
  const g = await jar.text('/register');
  const post = await jar.text('/register', { method: 'POST', body: { _csrf: csrfOf(g.body), name, email, password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' } });
  assert.equal(post.status, 302, 'register redirects, got ' + post.status);
}
async function createTicket(jar, subject) {
  const g = await jar.text('/support');
  const post = await jar.text('/support/new', { method: 'POST', body: { _csrf: csrfOf(g.body), subject, message: 'Please help with: ' + subject, priority: 'medium' } });
  const pub = post.loc.includes('/support/') && post.loc !== '/support' ? decodeURIComponent(post.loc.split('/support/')[1]) : null;
  return { post, pub };
}
async function replyAs(jar, pub, message, csrfFromPub) {
  const g = await jar.text('/support/' + (csrfFromPub || pub));
  return jar.text('/support/' + pub + '/reply', { method: 'POST', body: { _csrf: csrfOf(g.body), message } });
}
async function msgCount(pub) {
  const r = await dbB.get('SELECT COUNT(*) AS c FROM support_messages WHERE ticket_id = (SELECT id FROM support_tickets WHERE public_id = ?)', [pub]);
  return Number(r.c);
}

let adminJar, playerA, playerB, aId, bId;

test.before(async () => {
  const env = { ...process.env,
    PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite',
    SQLITE_PATH: path.join(TMP_B, 'b.sqlite'),
    TICKET_HMAC_SECRET: 'v20-support-test-secret-0123456789abcdef',
    ADMIN_SEED_EMAIL: 'admin@v20s.test', ADMIN_SEED_PASSWORD: 'V20Admin#pass', ADMIN_SEED_NAME: 'V20 Admin',
  };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[v20s server] ' + d));
  assert.ok(await waitHealthy(), 'server must boot and answer /healthz');
  process.env.SQLITE_PATH = path.join(TMP_B, 'b.sqlite');
  process.env.DB_DRIVER = 'sqlite';
  dbB = require('../lib/db').openDB().db;
  adminJar = new Jar('v20-admin');
  const g = await adminJar.text('/login');
  const post = await adminJar.text('/login', { method: 'POST', body: { _csrf: csrfOf(g.body), email: 'admin@v20s.test', password: 'V20Admin#pass' } });
  assert.equal(post.status, 302, 'admin login redirects');
  playerA = new Jar('v20-player-a');
  await register(playerA, 'Player A', 'a@v20s.test');
  playerB = new Jar('v20-player-b');
  await register(playerB, 'Player B', 'b@v20s.test');
  aId = (await dbB.get("SELECT id FROM users WHERE email = 'a@v20s.test'")).id;
  bId = (await dbB.get("SELECT id FROM users WHERE email = 'b@v20s.test'")).id;
});
test.after(async () => {
  if (server) server.kill('SIGKILL');
  try { if (dbB) await dbB.close(); } catch {}
  fs.rmSync(TMP_B, { recursive: true, force: true });
});

test('U-18: player reply is locked until staff replies, then locks again; closed stays locked', { timeout: 60000 }, async () => {
  const { pub } = await createTicket(playerA, 'Turn taking');
  assert.ok(pub, 'ticket created');
  assert.equal(await msgCount(pub), 1);
  // just created -> locked, with the true reason on the ticket page
  await replyAs(playerA, pub, 'second message in a row');
  assert.equal(await msgCount(pub), 1, 'immediate second player message is refused');
  let g = await playerA.text('/support/' + pub);
  assert.match(g.body, /You can reply again as soon as our support team has responded/, 'lock reason is shown');
  // staff reply through the REAL admin route unlocks the player
  g = await adminJar.text(ADMIN_PATH + '/support/' + pub);
  assert.equal(g.status, 200);
  const post = await adminJar.text(ADMIN_PATH + '/support/' + pub + '/reply', { method: 'POST', body: { _csrf: csrfOf(g.body), message: 'Staff reply one' } });
  assert.equal(post.status, 302);
  assert.equal(await msgCount(pub), 2);
  // player may now post exactly one reply
  await replyAs(playerA, pub, 'player answer');
  assert.equal(await msgCount(pub), 3, 'one player reply after the staff reply lands');
  // and is locked again
  await replyAs(playerA, pub, 'third in a row');
  assert.equal(await msgCount(pub), 3, 'locked again until the next staff reply');
  // closed ticket: still non-replyable, with the closed reason
  g = await playerA.text('/support/' + pub);
  await playerA.text('/support/' + pub + '/close', { method: 'POST', body: { _csrf: csrfOf(g.body) } });
  // a staff-shaped row arriving after close must not resurrect replies
  // (status gate is checked first) — reply and read the reason
  await replyAs(playerA, pub, 'anyone there?');
  assert.equal(await msgCount(pub), 3, 'closed ticket takes no replies');
  g = await playerA.text('/support/' + pub);
  assert.match(g.body, /This ticket is closed/, 'closed reason is shown');
});

test('U-19 + U-25: open cap bites, delete frees the open slot, 24h cap is NOT refunded by deletes', { timeout: 60000 }, async () => {
  const t1 = await createTicket(playerB, 'B one');
  const t2 = await createTicket(playerB, 'B two');
  assert.ok(t1.pub && t2.pub, 'first two tickets created (defaults: max 2 open)');
  // third while two are open -> open cap, naming count + limit
  const t3try = await createTicket(playerB, 'B three');
  assert.equal(t3try.pub, null, 'third open ticket is refused');
  assert.equal(t3try.post.loc, '/support');
  let g = await playerB.text('/support');
  assert.match(g.body, /already have 2 open support tickets — the limit is 2/, 'open-cap reason names the count and the limit');
  let c = await dbB.get('SELECT COUNT(*) AS c FROM support_tickets WHERE user_id = ?', [bId]);
  assert.equal(Number(c.c), 2, 'no third ticket row exists');
  // U-25 interplay (open half): deleting an open ticket frees the slot
  g = await playerB.text('/support/' + t1.pub);
  await playerB.text('/support/' + t1.pub + '/delete', { method: 'POST', body: { _csrf: csrfOf(g.body) } });
  const t3 = await createTicket(playerB, 'B three');
  assert.ok(t3.pub, 'after deleting an open ticket a new one can be created');
  // U-25 interplay (24h half): three creations exist in the window;
  // deleting the rest must NOT refund the 24h quota
  for (const p of [t2.pub, t3.pub]) {
    const gg = await playerB.text('/support/' + p);
    await playerB.text('/support/' + p + '/delete', { method: 'POST', body: { _csrf: csrfOf(gg.body) } });
  }
  const t4try = await createTicket(playerB, 'B four');
  assert.equal(t4try.pub, null, '24h cap still bites after deletes');
  g = await playerB.text('/support');
  assert.match(g.body, /opened 3 support tickets in the last 24 hours — the limit is 3/, '24h reason names the count and the limit');
  c = await dbB.get('SELECT COUNT(*) AS c FROM support_tickets WHERE user_id = ?', [bId]);
  assert.equal(Number(c.c), 3, 'still exactly the three created rows');
});

test('U-19: flipping the settings changes behaviour; 0 disables both limits', { timeout: 90000 }, async () => {
  const { setSetting } = require('../lib/settings');
  await setSetting(dbB, 'sqlite', 'support_max_open_tickets', '0');
  await setSetting(dbB, 'sqlite', 'support_max_new_tickets_24h', '0');
  // the server caches settings for up to 5s (lib/settings TTL)
  await new Promise(r => setTimeout(r, 5600));
  const t = await createTicket(playerB, 'B unlimited');
  assert.ok(t.pub, 'with both limits at 0 a ticket is created despite 3 prior creations and the earlier blocks');
  // restore the shipped defaults for the rest of the suite
  await setSetting(dbB, 'sqlite', 'support_max_open_tickets', '2');
  await setSetting(dbB, 'sqlite', 'support_max_new_tickets_24h', '3');
});

test('U-25: player deletes own ticket — gone everywhere, audited, no leak', { timeout: 60000 }, async () => {
  // fresh player so U-19 limits from earlier tests cannot interfere
  const jar = new Jar('v20-player-c');
  await register(jar, 'Player C', 'c@v20s.test');
  const { pub } = await createTicket(jar, 'Delete me');
  assert.ok(pub);
  const trow = await dbB.get('SELECT id, user_id FROM support_tickets WHERE public_id = ?', [pub]);
  const g = await jar.text('/support/' + pub);
  const post = await jar.text('/support/' + pub + '/delete', { method: 'POST', body: { _csrf: csrfOf(g.body) } });
  assert.equal(post.status, 302);
  assert.equal(post.loc, '/support');
  const row = await dbB.get('SELECT deleted_at, deleted_by FROM support_tickets WHERE public_id = ?', [pub]);
  assert.ok(Number(row.deleted_at) > 0, 'deleted_at is set');
  assert.equal(Number(row.deleted_by), Number(trow.user_id), 'deleted_by is the owner');
  const auditRow = await dbB.get("SELECT * FROM audit_log WHERE action = 'support.delete' AND entity_id = ?", [String(trow.id)]);
  assert.ok(auditRow, 'an audit-log entry records the delete');
  assert.equal(Number(auditRow.actor_id), Number(trow.user_id), 'audit actor is the player');
  const list = await jar.text('/support');
  assert.doesNotMatch(list.body, /Delete me/, 'deleted ticket is gone from the list');
  const detail = await jar.text('/support/' + pub);
  assert.equal(detail.status, 404, 'deleted ticket detail is not-found');
  assert.doesNotMatch(detail.body, /Please help with: Delete me/, 'no content leaks through the old URL');
  // reply to the deleted ticket: refused with its true reason
  const before = await msgCount(pub);
  const lg = await jar.text('/support');
  const rp = await jar.text('/support/' + pub + '/reply', { method: 'POST', body: { _csrf: csrfOf(lg.body), message: 'ghost reply' } });
  assert.equal(rp.status, 302);
  assert.equal(await msgCount(pub), before, 'no message lands on a deleted ticket');
  const after = await jar.text('/support');
  assert.match(after.body, /This ticket has been deleted/, 'deleted-reply reason is shown');
});

test('U-25: IDOR — another player cannot delete my ticket', { timeout: 60000 }, async () => {
  const jar = new Jar('v20-player-d');
  await register(jar, 'Player D', 'd@v20s.test');
  const { pub } = await createTicket(jar, 'D ticket');
  assert.ok(pub);
  // player B tries to delete D's ticket
  const g = await playerB.text('/support');
  const post = await playerB.text('/support/' + pub + '/delete', { method: 'POST', body: { _csrf: csrfOf(g.body) } });
  assert.equal(post.status, 302);
  assert.equal(post.loc, '/support');
  const row = await dbB.get('SELECT deleted_at FROM support_tickets WHERE public_id = ?', [pub]);
  assert.equal(row.deleted_at, null, "the owner's ticket is untouched");
  const gb = await playerB.text('/support');
  assert.match(gb.body, /Ticket not found\./, 'foreign delete gets the same not-found response (no existence leak)');
  const detail = await jar.text('/support/' + pub);
  assert.equal(detail.status, 200, 'owner can still open the ticket');
});
