'use strict';
/* BP-26 tamper pack — a hacker-with-devtools battery.
   PASS CRITERION (user, 2026-10-28): a change made in the browser that
   dies on refresh is HARMLESS and expected. A case FAILS only if a
   browser-originated manipulation CROSSES to the server and PERSISTS —
   balance/result/record actually changed, visible from a clean session
   afterwards. That is why every case below asserts against DATABASE
   STATE read through a separate connection after the attack, never
   just the attack response's status code.
   Part A (lib): audit hash-chain tamper evidence (edit + delete) and
   the ledger append-only source invariant.
   Part B (HTTP): forged buy fields, invalid wager, dirty pops, forged
   scratch price, forged reveal prize, reveal replay, IDOR, profile
   balance smuggling, verify-without-pending. */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');

/* ---------------- Part A: audit chain + ledger invariant ---------------- */
test('BP-26 audit chain: intact verifies; one edited byte and one deleted row are both detected', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tamper-a-'));
  process.env.SQLITE_PATH = path.join(tmp, 'a.sqlite');
  const { openDB } = require('../lib/db');
  const { migrate } = require('../lib/migrations');
  const { db } = openDB();
  await migrate(db, 'sqlite');
  const audit = require('../lib/audit');
  for (let i = 0; i < 5; i++) await audit.log(db, { actorId: 1, actorRole: 'admin', action: 'test.row', entity: 'thing', entityId: String(i), detail: { n: i } });
  let v = await audit.verifyChain(db);
  assert.equal(v.ok, true, 'fresh chain verifies: ' + JSON.stringify(v));
  assert.equal(v.checked, 5);
  // flip one byte in a middle row's stored detail (direct SQL = insider edit)
  const mid = await db.get("SELECT id FROM audit_log WHERE action = 'test.row' ORDER BY id LIMIT 1 OFFSET 2");
  await db.run("UPDATE audit_log SET detail = ? WHERE id = ?", [JSON.stringify({ n: 999 }), mid.id]);
  v = await audit.verifyChain(db);
  assert.equal(v.ok, false, 'edited row must break the chain');
  assert.equal(v.firstBadId, mid.id, 'the edited row is identified');
  // restore, then DELETE a row instead: the successor's prev_hash dangles
  await db.run("UPDATE audit_log SET detail = ? WHERE id = ?", [JSON.stringify({ n: 2 }), mid.id]);
  v = await audit.verifyChain(db);
  assert.equal(v.ok, true, 'restored chain verifies again');
  await db.run('DELETE FROM audit_log WHERE id = ?', [mid.id]);
  v = await audit.verifyChain(db);
  assert.equal(v.ok, false, 'deleted row must break the chain');
});

test('BP-26 ledger invariant: no source path UPDATEs or DELETEs ledger/audit rows', () => {
  const files = [];
  const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p); } };
  walk(path.join(ROOT, 'lib')); walk(path.join(ROOT, 'routes'));
  const bad = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (/UPDATE\s+transactions\b/i.test(src) || /DELETE\s+FROM\s+transactions\b/i.test(src)) bad.push(path.basename(f) + ' (transactions)');
    if (/UPDATE\s+audit_log\b/i.test(src) || /DELETE\s+FROM\s+audit_log\b/i.test(src)) bad.push(path.basename(f) + ' (audit_log)');
  }
  assert.deepEqual(bad, [], 'ledger and audit tables are append-only in source');
});

/* ---------------- Part B: HTTP battery ---------------- */
const PORT = 3241;
const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'tamper-b-'));
const envB = {
  ...process.env,
  SQLITE_PATH: path.join(tmpB, 'b.sqlite'),
  KYC_UPLOAD_DIR: path.join(tmpB, 'uploads'),
  PORT: String(PORT),
  BASE_URL: `http://127.0.0.1:${PORT}`,
  TICKET_HMAC_SECRET: 'tamper-test-secret-0123456789abcdef',
  ADMIN_SEED_EMAIL: 'admin@tamper.test',
  ADMIN_SEED_PASSWORD: 'Tamper#pass1',
  ADMIN_SEED_NAME: 'Tamper Admin',
};
delete envB.CREDENTIAL_ENCRYPTION_KEY;
let serverProc = null;
let dbB = null;

function rawRequest({ method = 'GET', path: p, jar, body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (jar && jar.size) h.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: h }, (resp) => {
      const sc = resp.headers['set-cookie'] || [];
      if (jar) for (const c of sc) { const [pair] = c.split(';'); const i = pair.indexOf('='); jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim()); }
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const form = (o) => new URLSearchParams(o).toString();
const FORM_CT = { 'Content-Type': 'application/x-www-form-urlencoded' };
function csrfOf(html) { const m = /name="_csrf" value="([^"]+)"/.exec(html); return m ? m[1] : ''; }
async function get(jar, p) { const r = await rawRequest({ path: p, jar }); return { ...r, text: r.body.toString('utf8') }; }
async function postForm(jar, p, o, headers = FORM_CT) { const r = await rawRequest({ method: 'POST', path: p, jar, body: form(o), headers }); return { ...r, text: r.body.toString('utf8') }; }
async function loginAs(email, password) {
  const jar = new Map();
  const g = await get(jar, '/login');
  await postForm(jar, '/login', { _csrf: csrfOf(g.text), email, password });
  return jar;
}
async function registerPlayer(name, email) {
  const jar = new Map();
  const g = await get(jar, '/register');
  await postForm(jar, '/register', { _csrf: csrfOf(g.text), name, email, password: 'Player#pass1', password_confirm: 'Player#pass1', agree: '1' });
  return jar;
}
async function waitHealthy() {
  for (let i = 0; i < 60; i++) {
    try { const r = await rawRequest({ path: '/healthz' }); if (r.status === 200) return; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('server did not become healthy');
}
async function balanceOf(email) {
  const u = await dbB.get('SELECT id FROM users WHERE email = ?', [email]);
  const w = await dbB.get('SELECT COALESCE(SUM(balance),0) AS s FROM wallets WHERE user_id = ?', [u.id]);
  return Number(w.s);
}

before(async () => {
  serverProc = spawn('node', ['server.js'], { cwd: ROOT, env: envB, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProc.stderr.on('data', (d) => process.stderr.write('[tamper-server] ' + d));
  await waitHealthy();
  process.env.SQLITE_PATH = path.join(tmpB, 'b.sqlite');
  const { openDB } = require('../lib/db');
  ({ db: dbB } = openDB());
});
after(() => { if (serverProc) serverProc.kill('SIGKILL'); });

test('BP-26 http: forged/replayed/cross-account requests cannot move numbers', async () => {
  const CONSOLE = '/ops-7f3a9c-console';
  const adminJar = await loginAs('admin@tamper.test', 'Tamper#pass1');
  const aJar = await registerPlayer('Tamper A', 'a@tamper.test');
  const bJar = await registerPlayer('Tamper B', 'b@tamper.test');
  await dbB.run("UPDATE users SET email_verified = 1 WHERE email IN ('a@tamper.test', 'b@tamper.test')");
  await dbB.run("UPDATE payment_methods SET enabled = 1 WHERE rail = 'bank_transfer'");
  // Fund A with $50 through the real deposit + approve flow
  {
    const g = await get(aJar, '/deposit/new');
    await postForm(aJar, '/deposit/new', { _csrf: csrfOf(g.text), method_id: '10', amount: '50.00', custom_reference: 'T1' });
    const dep = await dbB.get("SELECT id FROM deposits WHERE user_id = (SELECT id FROM users WHERE email = 'a@tamper.test') ORDER BY id DESC LIMIT 1");
    const s = await get(adminJar, CONSOLE + '/deposits');
    await postForm(adminJar, CONSOLE + `/deposits/${dep.id}/approve`, { _csrf: csrfOf(s.text) });
  }
  assert.equal(await balanceOf('a@tamper.test'), 5000);

  // 1) Forged buy fields: total/price/balance smuggled in the body are ignored;
  //    the ticket carries the SERVER-computed total and the wallet moves by it.
  {
    const g = await get(aJar, '/play');
    const r = await postForm(aJar, '/play/buy', { _csrf: csrfOf(g.text), pops: '5', wager: '100', draw_type: 'DAY', num_draws: '1', total: '1', price: '1', balance: '99999999' });
    assert.ok(r.status === 302 || r.status === 200, 'buy accepted, got ' + r.status);
    const t = await dbB.get("SELECT * FROM tickets WHERE user_id = (SELECT id FROM users WHERE email = 'a@tamper.test') ORDER BY id DESC LIMIT 1");
    assert.equal(Number(t.total), 100, 'server-computed total (1 pop × $1 × 1 draw), not the forged 1');
    assert.equal(await balanceOf('a@tamper.test'), 4900);
  }
  // 2) Wager outside the server list -> rejected, nothing moves.
  {
    const g = await get(aJar, '/play');
    const r = await postForm(aJar, '/play/buy', { _csrf: csrfOf(g.text), pops: '5', wager: '7', draw_type: 'DAY', num_draws: '1' });
    assert.equal(r.status, 400);
    assert.equal(await balanceOf('a@tamper.test'), 4900);
  }
  // 3) Dirty pops are sanitized server-side: [0, 16, 99, 5, 5] -> [5]
  {
    const g = await get(aJar, '/play');
    await postForm(aJar, '/play/buy', { _csrf: csrfOf(g.text), 'pops': '5', draw_type: 'DAY', num_draws: '1', wager: '100' }, FORM_CT);
    // send the dirty set as repeated fields instead (urlencoded array style)
    const jar = aJar;
    const g2 = await get(jar, '/play');
    const body = ['_csrf=' + encodeURIComponent(csrfOf(g2.text)), 'pops=0', 'pops=16', 'pops=99', 'pops=5', 'pops=5', 'wager=100', 'draw_type=DAY', 'num_draws=1'].join('&');
    const r = await rawRequest({ method: 'POST', path: '/play/buy', jar, body, headers: FORM_CT });
    assert.ok(r.status === 302 || r.status === 200, 'dirty-pops buy handled, got ' + r.status);
    const t = await dbB.get("SELECT * FROM tickets WHERE user_id = (SELECT id FROM users WHERE email = 'a@tamper.test') ORDER BY id DESC LIMIT 1");
    assert.deepEqual(JSON.parse(t.pops), [5]);
    assert.equal(Number(t.total), 100);
  }
  // 4) Scratch buy with a forged price: charged the series price (100), never 1.
  const series = await dbB.get("SELECT * FROM scratch_series WHERE slug = 'gold-rush'");
  assert.ok(series, 'Gold Rush live on fresh boot');
  {
    const g = await get(aJar, '/scratch');
    await postForm(aJar, `/scratch/${series.id}/buy`, { _csrf: csrfOf(g.text), price: '1', prize: '999999' });
    const tk = await dbB.get("SELECT * FROM scratch_tickets WHERE user_id = (SELECT id FROM users WHERE email = 'a@tamper.test') ORDER BY id DESC LIMIT 1");
    assert.equal(Number(tk.price), Number(series.price));
  }
  const balAfterScratchBuy = await balanceOf('a@tamper.test');
  assert.equal(balAfterScratchBuy, 4600, 'A balance: 5000 − 100 (case 1) − 100 (case 3a) − 100 (case 3b) − 100 (scratch)');

  // 5+6) Forged reveal prize + reveal replay: buy until a winning ticket exists,
  //      reveal it once WITH forged params, then reveal again — exactly one credit.
  //      FIXTURE NOTE (honest repair; every product assertion below is unchanged):
  //      hunting a winner in the Gold Rush deck is NOT deterministic — outcomes
  //      are crypto-shuffled per boot (26 winners / 74 zeros in 100) AND the buy
  //      route is rate-limited to 10 buys/min/user (routes/scratch.js), so only
  //      ~10 of any 40 rapid buys actually execute; the old 40-try loop failed
  //      whenever no winner sat in the first ~10 outcomes (observed 2026-10-29,
  //      full-suite run: 'a winning ticket was bought within 40 tries'). The hunt
  //      therefore uses a fixture series whose deck (5 prizes / 5 zeros in 10)
  //      guarantees a winner within 6 buys — inside the limiter budget together
  //      with case 4's single Gold Rush buy.
  const { launchSeries } = require('../lib/scratch');
  const { randHex, sha256 } = require('../lib/util');
  const poolSeed = randHex(32);
  const poolIns = await dbB.run(
    `INSERT INTO scratch_series (title,slug,game_type,currency,price,total_tickets,status,enabled,rules,server_seed,seed_hash,created_by,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['Tamper Pool', 'tamper-pool', 'single', 'USD', 100, 10, 'draft', 0,
     'Fixture series for the BP-26 reveal cases.', poolSeed, sha256(poolSeed), 0, Date.now()]
  );
  await dbB.run('INSERT INTO scratch_prize_tiers (series_id,amount,quantity,label) VALUES (?,?,?,?)', [poolIns.id, 300, 5, 'Win']);
  await launchSeries(dbB, poolIns.id, 0);
  let winTicket = null;
  for (let i = 0; i < 10 && !winTicket; i++) {
    const g = await get(aJar, '/scratch');
    await postForm(aJar, `/scratch/${poolIns.id}/buy`, { _csrf: csrfOf(g.text) });
    const row = await dbB.get(`SELECT st.public_id, so.prize FROM scratch_tickets st JOIN scratch_outcomes so ON so.id = st.outcome_id
      WHERE st.user_id = (SELECT id FROM users WHERE email = 'a@tamper.test') AND st.status = 'purchased' AND so.prize > 0 AND so.series_id = ? ORDER BY st.id DESC LIMIT 1`, [poolIns.id]);
    if (row) winTicket = row;
  }
  assert.ok(winTicket, 'a winning ticket was bought within 10 tries (fixture deck guarantees one within 6)');
  const balBefore = await balanceOf('a@tamper.test');
  {
    const g = await get(aJar, '/scratch/my-tickets');
    await postForm(aJar, `/scratch/ticket/${winTicket.public_id}/reveal`, { _csrf: csrfOf(g.text), prize: '99999999', win: '99999999', balance: '99999999' });
    const bal1 = await balanceOf('a@tamper.test');
    assert.equal(bal1, balBefore + Number(winTicket.prize), 'credited exactly the committed prize, not the forged one');
    const g2 = await get(aJar, '/scratch/my-tickets');
    await postForm(aJar, `/scratch/ticket/${winTicket.public_id}/reveal`, { _csrf: csrfOf(g2.text), prize: '99999999' });
    const bal2 = await balanceOf('a@tamper.test');
    assert.equal(bal2, bal1, 'replay credits nothing');
    const credits = await dbB.get("SELECT COUNT(*) AS c FROM transactions WHERE type = 'scratch_prize' AND ref_id = ?", [winTicket.public_id]);
    assert.equal(Number(credits.c), 1, 'exactly one prize ledger row');
  }
  // 7) IDOR: B cannot view or reveal A's (unrevealed) ticket.
  const aTicket = await dbB.get("SELECT public_id FROM scratch_tickets WHERE user_id = (SELECT id FROM users WHERE email = 'a@tamper.test') AND status = 'purchased' ORDER BY id DESC LIMIT 1");
  assert.ok(aTicket, 'A has an unrevealed ticket for the IDOR case');
  {
    const r = await get(bJar, `/scratch/ticket/${aTicket.public_id}`);
    assert.ok(r.status === 404 || r.status === 403 || r.status === 400, 'B view of A ticket refused, got ' + r.status);
    const g = await get(bJar, '/scratch/my-tickets');
    await postForm(bJar, `/scratch/ticket/${aTicket.public_id}/reveal`, { _csrf: csrfOf(g.text) });
    const t = await dbB.get('SELECT status FROM scratch_tickets WHERE public_id = ?', [aTicket.public_id]);
    assert.equal(t.status, 'purchased', "A's ticket untouched by B's reveal attempt");
  }
  // 8) Profile balance smuggling: extra fields are whitelisted out.
  {
    const before = await balanceOf('a@tamper.test');
    const g = await get(aJar, '/profile');
    await postForm(aJar, '/profile', { _csrf: csrfOf(g.text), name: 'Tamper A', phone: '', country: 'US', balance: '99999999', wallet: '99999999', role: 'admin' });
    assert.equal(await balanceOf('a@tamper.test'), before);
    const role = await dbB.get("SELECT role FROM users WHERE email = 'a@tamper.test'");
    assert.equal(role.role, 'player', 'role smuggling refused');
  }
  // 9) Withdrawal verify with nothing pending: clean refusal, no row created.
  {
    const g = await get(aJar, '/wallet');
    const r = await postForm(aJar, '/withdraw/verify', { _csrf: csrfOf(g.text), code: '123456' });
    assert.equal(r.status, 400);
    const c = await dbB.get("SELECT COUNT(*) AS c FROM withdrawals WHERE user_id = (SELECT id FROM users WHERE email = 'a@tamper.test')");
    assert.equal(Number(c.c), 0);
  }
});
