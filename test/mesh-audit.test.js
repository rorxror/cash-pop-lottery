'use strict';
/* MESH-ID-01 + AUDIT-DETAIL-01:
   - Admin tables must never stack a public ID one letter per line: the
     served stylesheet carries the .tbl .code nowrap rule, and the
     Withdrawals/Deposits/Tickets pages render realistic 15-char public
     IDs inside .code spans in .tbl tables.
   - /audit renders detail as lossless humanized key–value lines: no
     raw JSON fragments, money keys formatted from the call-site-
     verified cents allowlist (owner ground truth: ticket.buy wager
     500 / total 7500 = $5.00 / $75.00), keys past the old 120-char cut
     present, non-JSON legacy detail escaped. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { spawn } = require('node:child_process');
const path = require('node:path');
const PORT = 4139, BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');
const DBP = `/tmp/cp-mesh-${process.pid}.sqlite`;
const LONG_ID = 'WMVT7JW3Y86FBCF'; // the owner's live example, 15 chars
const ADMIN_EMAIL = 'mesh-admin@example.com';
const ADMIN_PASSWORD = 'MeshAdminPass-2026';

let server, db, audit;
class Jar {
  constructor() { this.m = new Map(); }
  absorb(h) { const sc = h.get('set-cookie'); if (!sc) return; for (const c of sc.split(/,(?=[^;]+?=)/)) { const [p] = c.split(';'); const i = p.indexOf('='); if (i > 0) this.m.set(p.slice(0, i).trim(), p.slice(i + 1).trim()); } }
  header() { return [...this.m.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(path, { method = 'GET', body } = {}) {
    const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { cookie: this.header(), ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: body ? new URLSearchParams(body).toString() : undefined });
    this.absorb(r.headers); return { status: r.status, loc: r.headers.get('location') || '', html: await r.text() };
  }
  csrf(html) { const m = html.match(/name="_csrf" value="([^"]+)"/); assert.ok(m, 'csrf token present'); return m[1]; }
}
const admin = new Jar();

before(async () => {
  const env = { ...process.env, PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite', SQLITE_PATH: DBP,
    TICKET_HMAC_SECRET: 'mesh-test-' + 'x'.repeat(48),
    CREDENTIAL_ENCRYPTION_KEY: 'a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1',
    ADMIN_SEED_EMAIL: ADMIN_EMAIL, ADMIN_SEED_PASSWORD: ADMIN_PASSWORD, ADMIN_SEED_NAME: 'Mesh Admin' };
  delete env.DATABASE_URL; delete env.SMTP_HOST;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[mesh server] ' + d));
  let ok = false;
  for (let i = 0; i < 60 && !ok; i++) { try { const r = await fetch(BASE + '/healthz'); ok = r.status === 200; } catch {} if (!ok) await new Promise(r => setTimeout(r, 500)); }
  assert.ok(ok, 'server must boot');
  process.env.SQLITE_PATH = DBP; process.env.DB_DRIVER = 'sqlite';
  db = require('../lib/db').openDB().db;
  audit = require('../lib/audit');
  const page = await admin.req('/login');
  await admin.req('/login', { method: 'POST', body: { _csrf: admin.csrf(page.html), email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  // Realistic rows: a withdrawal + deposit carrying the long public ID,
  // a ticket, and audit rows (written through the real audit.log so the
  // hash chain stays valid).
  const u = await db.get("SELECT id FROM users WHERE role = 'admin'");
  await db.run("INSERT INTO withdrawals (public_id, user_id, method_id, currency, amount, charge, net, status, user_data, idempotency_key, created_at) VALUES (?, ?, 1, 'USD', 200, 0, 200, 'approved', '{}', ?, ?)",
    [LONG_ID, u.id, 'mesh-w-' + Date.now(), Date.now()]);
  await db.run("INSERT INTO deposits (public_id, user_id, method_id, currency, amount, charge, net, status, user_data, idempotency_key, created_at) VALUES (?, ?, 1, 'USD', 5000, 0, 5000, 'pending', '{}', ?, ?)",
    ['DP88K2LONGID99X', u.id, 'mesh-d-' + Date.now(), Date.now()]);
  await db.run("INSERT INTO support_tickets (public_id, user_id, subject, status, created_at, updated_at) VALUES (?, ?, 'Mesh test ticket', 'open', ?, ?)", ['TK99LONGTICKET1', u.id, Date.now(), Date.now()]);
  await audit.log(db, { actorId: u.id, actorRole: 'admin', action: 'ticket.buy', entity: 'ticket', entityId: LONG_ID, detail: { pops: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], wager: 500, drawType: 'DAY', numDraws: 1, total: 7500 } });
  await audit.log(db, { actorId: u.id, actorRole: 'admin', action: 'ticket.buy', entity: 'ticket', entityId: 'TK-SECOND', detail: { pops: [2, 3, 4, 6, 10], wager: 200, total: 1000 } });
  await audit.log(db, { actorId: u.id, actorRole: 'admin', action: 'settings.toggles', entity: 'settings', entityId: '', detail: { changes: { maintenance_mode: { from: '0', to: '1' }, bonus_enabled: { from: '1', to: '0' } } } });
  // A detail LONGER than the old 120-char cut, with a key that only
  // exists past the cut point.
  await audit.log(db, { actorId: u.id, actorRole: 'admin', action: 'test.long_detail', entity: 'user', entityId: '42', detail: { first_key: 'alpha', filler_one: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', filler_two: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', tail_marker_key: 'TAILVISIBLE', amount: 12345, currency: 'USD' } });
  // Legacy non-JSON detail (stored raw text by old code paths).
  await db.run('INSERT INTO audit_log (actor_id, actor_role, action, entity, entity_id, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [u.id, 'admin', 'legacy.plain', 'user', '7', 'plain text <b>not json</b> & co', '', Date.now()]);
});
after(() => { if (server) server.kill(); });

test('MESH-ID-01: served CSS keeps table identifiers on one line, prose .code unchanged', async () => {
  const css = await (await fetch(BASE + '/style.css')).text();
  assert.ok(css.includes('.tbl .code { white-space: nowrap; overflow-wrap: normal; word-break: normal; }'), 'table code nowrap rule served');
  assert.ok(css.includes('.dt { white-space: nowrap; }'), 'date nowrap rule served');
  assert.ok(css.includes('overflow-wrap: anywhere; word-break: break-word'), 'prose .code rule still present outside tables');
});

test('MESH-ID-01: withdrawals/deposits/tickets render long public IDs intact in .code spans', async () => {
  const w = await admin.req('/ops-7f3a9c-console/withdrawals');
  assert.equal(w.status, 200);
  assert.ok(w.html.includes(`<span class="code">${LONG_ID}</span>`), 'withdrawal ID intact, one token');
  assert.ok(w.html.includes('<table class="tbl">'), 'rendered inside the scrolling table');
  const d = await admin.req('/ops-7f3a9c-console/deposits');
  assert.ok(d.html.includes('<span class="code">DP88K2LONGID99X</span>'), 'deposit ID intact');
  const t = await admin.req('/ops-7f3a9c-console/support');
  assert.ok(t.html.includes('<span class="code">TK99LONGTICKET1</span>'), 'ticket ID intact');
});

test('AUDIT-DETAIL-01: ticket.buy ground truth formats money exactly; no raw JSON in default view', async () => {
  const a = await admin.req('/ops-7f3a9c-console/audit');
  assert.equal(a.status, 200);
  assert.ok(!a.html.includes('{&quot;pops&quot;') && !a.html.includes('{"pops"'), 'no raw JSON fragment in cells');
  assert.ok(a.html.includes('Wager') && a.html.includes('$5.00'), 'wager 500 → $5.00');
  assert.ok(a.html.includes('Total') && a.html.includes('$75.00'), 'total 7500 → $75.00');
  assert.ok(a.html.includes('$2.00') && a.html.includes('$10.00'), 'second row $2.00 / $10.00');
  assert.ok(a.html.includes('Draw type') && a.html.includes('DAY'), 'drawType humanized');
  assert.ok(a.html.includes('Num draws') || a.html.includes('Draws'), 'numDraws humanized');
  assert.ok(a.html.includes(`<span class="code">${LONG_ID}</span>`), 'entity ref intact on one line (MESH-ID treatment)');
  assert.ok(a.html.includes('>Ticket<') || a.html.includes('aud-ent">Ticket'), 'entity type humanized');
});

test('AUDIT-DETAIL-01: settings changes render old → new; long detail is lossless past 120 chars; legacy text escaped', async () => {
  const a = await admin.req('/ops-7f3a9c-console/audit');
  assert.ok(a.html.includes('Maintenance mode') && a.html.includes('0 → 1'), 'changes shape renders from → to');
  assert.ok(a.html.includes('Tail marker key') && a.html.includes('TAILVISIBLE'), 'key past the old 120-char cut is present (lossless)');
  assert.ok(a.html.includes('View detail (') && a.html.includes('raw'), 'long rows expand with a raw toggle');
  assert.ok(a.html.includes('$123.45'), 'amount 12345 with currency USD → $123.45');
  assert.ok(a.html.includes('plain text &lt;b&gt;not json&lt;/b&gt; &amp; co'), 'legacy non-JSON detail renders escaped, in full');
  assert.ok(!a.html.includes('<b>not json</b>'), 'legacy HTML never injected raw');
});
