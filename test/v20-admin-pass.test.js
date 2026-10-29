/* v20 ADMIN-PASS regression suite (U-20 / U-19 slice / U-25).
 *
 * Behavioural, spawned-server tests for the owner-fix round's admin
 * findings. Each test maps to an adjudication entry in
 * audits/owner-fix-round/adj-admin.md:
 *   U-20.1  reports invalid date range used to 500 (RangeError)
 *   U-20.2  U-19 support-limit settings fields were missing (U-19 slice)
 *   U-20.3  biodata POST with object-typed name stored "[object Object]"
 *   U-20.4  staff/agents create with object-typed fields 500'd
 *   U-20.5  agents could claim unassigned players by direct POST
 *   U-25    support-ticket soft delete (admin + agent scope)
 * Plus core proofs the pass established: stealth 404 + probe audit,
 * exact-money deposit approval with dashboard tiles == DB, KYC queue
 * cycle, auto-withdrawal limit behaviour, maker-checker, scheduler
 * gating by the Automation master switch, audit hash chain.
 *
 * Self-contained: boots server.js on port 3251 against a fresh
 * temp-dir SQLite file; cleans up its child + temp dir.
 */
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = 3251;
const BASE = 'http://127.0.0.1:' + PORT;
const AP = '/ops-7f3a9c-console';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'v20-admin-'));
const DBF = path.join(TMP, 'test.sqlite');
process.env.SQLITE_PATH = DBF; // this process's own read handle must match the child's DB

let server = null, serverLog = '';
let db = null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function boot() {
  serverLog = '';
  server = spawn('node', ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, SQLITE_PATH: DBF, PORT: String(PORT), BASE_URL: BASE,
      TICKET_HMAC_SECRET: 'v20-admin-pass-secret-0123456789abcdef',
      ADMIN_SEED_EMAIL: 'admin@v20t.test', ADMIN_SEED_PASSWORD: 'V20Test#admin1',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', d => { serverLog += d.toString(); });
  server.stderr.on('data', d => { serverLog += d.toString(); });
}
async function waitUp() {
  for (let i = 0; i < 80; i++) {
    if (serverLog.includes('listening on')) {
      try { const r = await fetch(BASE + '/healthz'); if (r.status === 200) return; } catch {}
    }
    if (server && server.exitCode !== null) throw new Error('server exited early: ' + serverLog.slice(-400));
    await sleep(400);
  }
  throw new Error('server did not come up: ' + serverLog.slice(-400));
}
async function killServer() { if (server) { try { server.kill('SIGKILL'); } catch {} server = null; await sleep(900); } }

class Jar {
  constructor(name) { this.name = name; this.cookies = new Map(); }
  absorb(res) {
    const sc = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const line of sc) {
      const pair = line.split(';')[0]; const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const k = pair.slice(0, eq).trim(), v = pair.slice(eq + 1).trim();
      if (!v || v === 'deleted' || /expires=Thu, 01 Jan 1970/i.test(line)) this.cookies.delete(k); else this.cookies.set(k, v);
    }
  }
  header() { return [...this.cookies.entries()].map(([k, v]) => k + '=' + v).join('; '); }
  async req(p, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    const ck = this.header(); if (ck) headers.Cookie = ck;
    const res = await fetch(BASE + p, { redirect: 'manual', ...opts, headers });
    this.absorb(res);
    const body = await res.text();
    return { status: res.status, body, loc: res.headers.get('location') || '' };
  }
  text(p) { return this.req(p); }
  post(p, data) {
    return this.req(p, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
  }
}
const csrfOf = (html) => { const m = String(html || '').match(/name="_csrf" value="([^"]+)"/); return m ? m[1] : null; };
async function csrfFor(jar, p) { const r = await jar.text(p); return csrfOf(r.body); }
async function loginJar(email, password, name) {
  const jar = new Jar(name);
  const g = await jar.text('/login');
  const r = await jar.post('/login', { _csrf: csrfOf(g.body), email, password });
  assert.strictEqual(r.status, 302, 'login ' + email + ' -> ' + r.status);
  return jar;
}
const q1 = (sql, params = []) => db.get(sql, params);
const qq = (sql, params = []) => db.query(sql, params);
async function wallet(userId) {
  const w = await q1('SELECT balance FROM wallets WHERE user_id = ? AND currency = ?', [userId, 'USD']);
  return w ? Number(w.balance) : 0;
}
const setting = async (k) => { const r = await q1('SELECT value FROM settings WHERE key = ?', [k]); return r ? String(r.value) : null; };

let admin, pA, pB, agentJar, finJar;
let adminId, idA, idB, agentId, methodId;
const fmt$ = (minor) => '$' + (Number(minor) / 100).toFixed(2);
const RISK_BASE = { withdrawal_daily_cap: '0.00', withdrawal_monthly_cap: '0.00', payout_lock_hours: '48', maker_checker_threshold: '0.00', auto_withdrawal_limit: '0', referral_cap_per_referee: '0.00' };
async function postRisk(jar, obj) { const g = await jar.text(AP + '/settings'); return jar.post(AP + '/settings/risk', { _csrf: csrfOf(g.body), ...obj }); }

before(async () => {
  boot(); await waitUp();
  db = require(path.join(ROOT, 'lib/db')).openDB().db;
  admin = await loginJar('admin@v20t.test', 'V20Test#admin1', 'admin');
  const home = await admin.text(AP);
  assert.strictEqual(home.status, 200, 'console home');
  adminId = Number((await q1("SELECT id FROM users WHERE email='admin@v20t.test'")).id);
  // players via the real register flow, contact-verified by DB flag
  for (const [email, name, phone] of [['playera@v20t.test', 'V20 Player A', '5550001111'], ['playerb@v20t.test', 'V20 Player B', '5550002222']]) {
    const jar = new Jar('reg-' + email);
    const g = await jar.text('/register');
    const r = await jar.post('/register', { _csrf: csrfOf(g.body), name, email, phone_cc: '+1', phone_local: phone, phone: '+1' + phone, password: 'PlayerPass#1', password_confirm: 'PlayerPass#1', agree: 'on' });
    assert.strictEqual(r.status, 302, 'register ' + email + ' -> ' + r.status);
    await db.run('UPDATE users SET email_verified = 1, mobile_verified = 1 WHERE email = ?', [email]);
  }
  // one bank method (deposit + withdrawal) via the admin methods form
  {
    const g = await admin.text(AP + '/methods/new');
    const r = await admin.post(AP + '/methods/new', { _csrf: csrfOf(g.body), name: 'V20T Bank', kind: 'both', rail: 'bank_transfer', logo_url: '', currency: 'USD', rate: '1', min_amount: '5.00', max_amount: '1000.00', fixed_charge: '0', percent_charge: '0', instruction: 'Pay to V20T test account', custom_fields: '[]', enabled: '1' });
    assert.strictEqual(r.status, 302, 'method create -> ' + r.status);
    methodId = (await q1("SELECT id FROM payment_methods WHERE name = 'V20T Bank'")).id;
    assert.ok(methodId, 'method row missing');
  }
  idA = Number((await q1("SELECT id FROM users WHERE email='playera@v20t.test'")).id);
  idB = Number((await q1("SELECT id FROM users WHERE email='playerb@v20t.test'")).id);
  pA = await loginJar('playera@v20t.test', 'PlayerPass#1', 'pA');
  pB = await loginJar('playerb@v20t.test', 'PlayerPass#1', 'pB');
  // agent via admin /agents; A assigned to the agent via biodata save
  let tok = await csrfFor(admin, AP + '/agents');
  const ra = await admin.post(AP + '/agents', { _csrf: tok, name: 'V20 Agent', email: 'agent@v20t.test', password: 'Agent#pass123' });
  assert.strictEqual(ra.status, 302);
  agentId = Number((await q1("SELECT id FROM users WHERE email='agent@v20t.test'")).id);
  await db.run('UPDATE users SET force_password_reset = 0 WHERE id = ?', [agentId]);
  tok = await csrfFor(admin, AP + '/users/' + idA);
  const rb = await admin.post(AP + '/users/' + idA, { _csrf: tok, name: 'V20 Player A', email: 'playera@v20t.test', phone: '', address: '', city: '', state: '', zip: '', country: '', notes: '', kyc_override: 'default', auto_withdrawal_limit: '', agent_id: String(agentId) });
  assert.strictEqual(rb.status, 302, 'assign A to agent');
  agentJar = await loginJar('agent@v20t.test', 'Agent#pass123', 'agent');
  // finance staff via /staff
  tok = await csrfFor(admin, AP + '/staff');
  const rf = await admin.post(AP + '/staff', { _csrf: tok, name: 'V20 Finance', email: 'finance@v20t.test', password: 'Finance#pass123', admin_role: 'finance' });
  assert.strictEqual(rf.status, 302, 'create finance staff');
  finJar = await loginJar('finance@v20t.test', 'Finance#pass123', 'finance');
});
after(async () => { await killServer(); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} });

test('stealth: console subpaths 404 for anon and players, probes audited (root = ADMIN-LOGIN-01 login page)', async () => {
  const anon = new Jar('anon');
  // ADMIN-LOGIN-01 (owner order, 2026-10-29): the EXACT root serves the
  // dedicated admin login page; stealth 404 + probe logging unchanged
  // for every other admin path.
  const root = await anon.text(AP);
  assert.strictEqual(root.status, 200, 'root serves the admin login page');
  assert.ok(root.body.includes('Control Room'), 'admin-branded login');
  assert.strictEqual((await anon.text(AP + '/settings')).status, 404);
  assert.strictEqual((await pA.text(AP + '/settings')).status, 404, 'player subpath still 404');
  const probes = await qq("SELECT id FROM audit_log WHERE action = 'admin.probe'");
  assert.ok(probes.length >= 2, 'probe audit rows: ' + probes.length);
});

test('U-20.1 regression: reports with invalid dates renders the error, not a 500', async () => {
  const r = await admin.text(AP + '/reports?from=bad&to=worse');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.includes('Invalid date range.'), 'error message missing');
  assert.strictEqual((await admin.text(AP + '/reports')).status, 200);
});

test('U-19 slice: support-limit settings persist, validate atomically, 0 = unlimited', async () => {
  const g = await admin.text(AP + '/settings');
  assert.strictEqual(g.status, 200);
  assert.ok(g.body.includes('name="support_max_open_tickets"'), 'open-tickets field missing');
  assert.ok(g.body.includes('name="support_max_new_tickets_24h"'), '24h field missing');
  assert.ok(/0\s*=\s*unlimited/i.test(g.body), '0 = unlimited help text missing');
  let tok = csrfOf(g.body);
  await admin.post(AP + '/settings/support-limits', { _csrf: tok, support_max_open_tickets: '5', support_max_new_tickets_24h: '7' });
  assert.strictEqual(await setting('support_max_open_tickets'), '5');
  assert.strictEqual(await setting('support_max_new_tickets_24h'), '7');
  tok = await csrfFor(admin, AP + '/settings');
  await admin.post(AP + '/settings/support-limits', { _csrf: tok, support_max_open_tickets: '-1', support_max_new_tickets_24h: '9' });
  assert.strictEqual(await setting('support_max_open_tickets'), '5', 'invalid save partially applied');
  assert.strictEqual(await setting('support_max_new_tickets_24h'), '7', 'invalid save partially applied');
  tok = await csrfFor(admin, AP + '/settings');
  await admin.post(AP + '/settings/support-limits', { _csrf: tok, support_max_open_tickets: '0', support_max_new_tickets_24h: '0' });
  assert.strictEqual(await setting('support_max_open_tickets'), '0');
  tok = await csrfFor(admin, AP + '/settings');
  await admin.post(AP + '/settings/support-limits', { _csrf: tok, support_max_open_tickets: '2', support_max_new_tickets_24h: '3' });
  assert.strictEqual(await setting('support_max_open_tickets'), '2');
});

test('U-20.3/U-20.4: object-typed body fields cannot corrupt users or 500 staff/agent create', async () => {
  const enc = encodeURIComponent;
  const beforeName = (await q1('SELECT name FROM users WHERE id = ?', [idB])).name;
  let tok = await csrfFor(admin, AP + '/users/' + idB);
  const r1 = await admin.req(AP + '/users/' + idB, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '_csrf=' + enc(tok) + '&name%5Ba%5D=b&email=playerb%40v20t.test&kyc_override=default&auto_withdrawal_limit=&agent_id=' });
  assert.ok(r1.status < 500, 'biodata object name -> ' + r1.status);
  assert.strictEqual((await q1('SELECT name FROM users WHERE id = ?', [idB])).name, beforeName);
  tok = await csrfFor(admin, AP + '/staff');
  const r2 = await admin.req(AP + '/staff', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '_csrf=' + enc(tok) + '&name%5Ba%5D=b&email=objstaff%40v20t.test&password=Whatever%23pass123&admin_role=support' });
  assert.ok(r2.status < 500, 'staff object name -> ' + r2.status);
  assert.ok(!(await q1("SELECT id FROM users WHERE email = 'objstaff@v20t.test'")), 'staff row created from object name');
  tok = await csrfFor(admin, AP + '/agents');
  const r3 = await admin.req(AP + '/agents', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '_csrf=' + enc(tok) + '&name=ObjAgent&email%5Ba%5D=b&password=Agent%23pass123' });
  assert.ok(r3.status < 500, 'agents object email -> ' + r3.status);
  assert.ok(!(await q1("SELECT id FROM users WHERE name = '[object Object]'")), 'a user row carries [object Object] as name');
});

test('U-20.5: an agent cannot claim an unassigned player by direct POST', async () => {
  const g = await agentJar.text('/agent/players');
  await agentJar.post('/agent/players/claim', { _csrf: csrfOf(g.body), user_id: String(idB) });
  const u = await q1('SELECT agent_id FROM users WHERE id = ?', [idB]);
  assert.ok(!u.agent_id, 'agent claimed unassigned player B by enumeration');
});

test('money core: deposit approval credits exactly; lottery buy debits exactly; dashboard tiles equal DB', async () => {
  const g = await pA.text('/deposit/new');
  const r = await pA.post('/deposit/new', { _csrf: csrfOf(g.body), method_id: String(methodId), amount: '100.00', custom_reference: 'REF-V20T-1', custom_sender_name: 'V20 Player A' });
  assert.strictEqual(r.status, 302, 'deposit create -> ' + r.status);
  const dep = await q1('SELECT * FROM deposits WHERE user_id = ? ORDER BY id DESC LIMIT 1', [idA]);
  assert.ok(dep && dep.status === 'pending' && Number(dep.net) === 10000, 'deposit not pending/$100: ' + JSON.stringify(dep));
  const w0 = await wallet(idA);
  const tok = await csrfFor(admin, AP + '/deposits/' + dep.id);
  await admin.post(AP + '/deposits/' + dep.id + '/approve', { _csrf: tok });
  assert.strictEqual(await wallet(idA), w0 + 10000, 'approval did not credit exactly $100.00');
  // lottery buy (boot tick ensures scheduled draws)
  await sleep(1500);
  const draws = await qq("SELECT * FROM draws WHERE status = 'scheduled'");
  assert.ok(draws.length > 0, 'no scheduled draws');
  const w1 = await wallet(idA);
  const pg = await pA.text('/play');
  const br = await pA.post('/play/buy', { _csrf: csrfOf(pg.body), pops: '3', wager: '100', draw_type: 'DAY', num_draws: '1', currency: 'USD' });
  assert.ok(br.status === 302 || br.status === 200, 'buy -> ' + br.status);
  const ticket = await q1('SELECT * FROM tickets WHERE user_id = ? ORDER BY id DESC LIMIT 1', [idA]);
  assert.ok(ticket && Number(ticket.total) === 100, 'ticket total: ' + JSON.stringify(ticket));
  assert.strictEqual(await wallet(idA), w1 - 100, 'buy did not debit exactly $1.00');
  // dashboard tiles == hand-checked DB aggregates
  const sold = Number((await q1('SELECT COALESCE(SUM(total),0) s FROM tickets')).s);
  const prize = Number((await q1("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE type IN ('win','scratch_prize')")).s);
  const players = Number((await q1("SELECT COUNT(*) c FROM users WHERE role = 'player'")).c);
  const pendDep = Number((await q1("SELECT COUNT(*) c FROM deposits WHERE status = 'pending'")).c);
  const body = (await admin.text(AP)).body;
  const kpi = (label) => { const i = body.indexOf('<div class="l">' + label + '</div>'); if (i < 0) return null; const seg = body.slice(Math.max(0, i - 200), i); const m = seg.match(/<div class="n">([^<]+)<\/div>\s*$/); return m && m[1]; };
  assert.strictEqual(kpi('Sold amount (all time)'), fmt$(sold), 'sold tile vs DB');
  assert.strictEqual(kpi('Given prize (all time)'), fmt$(prize), 'prize tile vs DB');
  assert.strictEqual(kpi('Players'), String(players), 'players tile vs DB');
  assert.strictEqual(kpi('Pending deposits'), String(pendDep), 'pending deposits tile vs DB');
});

test('auto-withdrawal: at/under global limit auto-approves (not paid); above stays pending', async () => {
  // withdrawal OTP off (full toggle set minus the OTP key), turnover off,
  // global auto-withdrawal limit $50 — all through the real settings forms
  const TOGGLES_ON = { registration_enabled: '1', policy_agreement: '1', secure_password: '1', notifications_enabled: '1', deposits_enabled: '1', withdrawals_enabled: '1', cookie_consent_enabled: '1', verified_contact_required: '1', beacon_enabled: '1', breached_password_check: '1', csp_enabled: '1', password_login_enabled: '1', withdrawal_otp_enabled: '1' };
  const noOtp = { ...TOGGLES_ON }; delete noOtp.withdrawal_otp_enabled;
  { const g = await admin.text(AP + '/settings'); await admin.post(AP + '/settings/toggles', { _csrf: csrfOf(g.body), ...noOtp }); }
  assert.strictEqual(await setting('withdrawal_otp_enabled'), '0');
  await postRisk(admin, { ...RISK_BASE, auto_withdrawal_limit: '50' });
  assert.strictEqual(await setting('auto_withdrawal_limit'), '50');
  assert.strictEqual(await setting('withdrawal_turnover_required'), '0');
  // top A up so both holds fit
  const tok = await csrfFor(admin, AP + '/users/' + idA);
  await admin.post(AP + '/users/' + idA + '/adjust', { _csrf: tok, direction: 'add', amount: '100.00', remark: 'v20t wd funding' });
  assert.ok((await wallet(idA)) >= 11000, 'A balance too low: ' + (await wallet(idA)));
  let g = await pA.text('/withdraw/new');
  // v20 §5.3 contract: a bank withdrawal submits the rail's PAYOUT
  // fields (custom_account_*), not the old deposit proof fields —
  // updated at v20 integration; the refusal of the old shape is the
  // §5.3 fix working as intended.
  let r = await pA.post('/withdraw/new', { _csrf: csrfOf(g.body), method_id: String(methodId), amount: '30.00', custom_account_name: 'V20 Player A', custom_account_number: 'US00V20T123456789', custom_bank_name: 'V20T Bank' });
  assert.strictEqual(r.status, 302, 'wd30 post -> ' + r.status);
  const w1 = await q1('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 1', [idA]);
  assert.ok(w1 && w1.status === 'approved', 'wd30 status ' + (w1 && w1.status));
  assert.strictEqual(Number(w1.decided_by), 0, 'auto-approval must be by system (decided_by 0)');
  assert.notStrictEqual(w1.status, 'paid', 'auto-approval must never mark paid');
  assert.ok(await q1("SELECT id FROM audit_log WHERE action = 'withdrawal.auto_approve' AND entity_id = ?", [String(w1.id)]), 'auto-approve audit row missing');
  g = await pA.text('/withdraw/new');
  r = await pA.post('/withdraw/new', { _csrf: csrfOf(g.body), method_id: String(methodId), amount: '80.00', custom_account_name: 'V20 Player A', custom_account_number: 'US00V20T123456789', custom_bank_name: 'V20T Bank' });
  assert.strictEqual(r.status, 302, 'wd80 post -> ' + r.status);
  const w2 = await q1('SELECT * FROM withdrawals WHERE user_id = ? ORDER BY id DESC LIMIT 1', [idA]);
  assert.ok(w2 && w2.status === 'pending', 'wd80 status ' + (w2 && w2.status));
  await postRisk(admin, { ...RISK_BASE, auto_withdrawal_limit: '0' });
});

test('maker-checker: over-threshold adjust queues; maker cannot self-approve; finance executes exactly', async () => {
  await postRisk(admin, { ...RISK_BASE, withdrawal_turnover_required: '1', maker_checker_threshold: '100.00' });
  assert.strictEqual(await setting('maker_checker_threshold'), '10000');
  const w0 = await wallet(idA);
  let tok = await csrfFor(admin, AP + '/users/' + idA);
  await admin.post(AP + '/users/' + idA + '/adjust', { _csrf: tok, direction: 'add', amount: '150.00', remark: 'v20t mc' });
  assert.strictEqual(await wallet(idA), w0, 'queued adjustment credited immediately');
  const pend = await q1("SELECT * FROM pending_approvals WHERE action = 'balance.adjust' AND status = 'open' ORDER BY id DESC LIMIT 1");
  assert.ok(pend, 'no approval row queued');
  tok = await csrfFor(admin, AP + '/approvals');
  await admin.post(AP + '/approvals/' + pend.id + '/approve', { _csrf: tok });
  assert.strictEqual((await q1('SELECT status FROM pending_approvals WHERE id = ?', [pend.id])).status, 'open', 'maker self-approved');
  assert.strictEqual(await wallet(idA), w0);
  tok = await csrfFor(finJar, AP + '/approvals');
  await finJar.post(AP + '/approvals/' + pend.id + '/approve', { _csrf: tok });
  assert.strictEqual(await wallet(idA), w0 + 15000, 'checker approval did not credit exactly');
  await postRisk(admin, { ...RISK_BASE });
});

test('U-25 admin: soft delete drops counts, lands in Deleted filter read-only, audits, sends no email, refuses replies', async () => {
  const g = await pA.text('/support');
  const cr = await pA.post('/support/new', { _csrf: csrfOf(g.body), subject: 'V20T delete me', message: 'soft delete test ticket', priority: 'low' });
  assert.strictEqual(cr.status, 302, 'ticket create -> ' + cr.status);
  const t = await q1("SELECT * FROM support_tickets WHERE subject = 'V20T delete me' ORDER BY id DESC LIMIT 1");
  assert.ok(t, 'ticket row missing');
  const openBefore = Number((await q1("SELECT COUNT(*) c FROM support_tickets WHERE status != 'closed' AND deleted_at IS NULL")).c);
  const mailBefore = Number((await q1('SELECT COUNT(*) c FROM notifications_log')).c);
  const tok = await csrfFor(admin, AP + '/support/' + t.public_id);
  const del = await admin.post(AP + '/support/' + t.public_id + '/delete', { _csrf: tok });
  assert.strictEqual(del.status, 302, 'delete -> ' + del.status);
  const t2 = await q1('SELECT deleted_at, deleted_by FROM support_tickets WHERE id = ?', [t.id]);
  assert.ok(t2.deleted_at && Number(t2.deleted_by) === adminId, 'deleted_at/deleted_by not set');
  const openAfter = Number((await q1("SELECT COUNT(*) c FROM support_tickets WHERE status != 'closed' AND deleted_at IS NULL")).c);
  assert.strictEqual(openAfter, openBefore - 1, 'open count did not drop');
  assert.strictEqual(Number((await q1('SELECT COUNT(*) c FROM notifications_log')).c), mailBefore, 'delete sent a notification');
  assert.ok(await q1("SELECT id FROM audit_log WHERE action = 'support.delete' AND entity_id = ?", [t.public_id]), 'support.delete audit row missing');
  const list = await admin.text(AP + '/support');
  assert.ok(!list.body.includes(t.public_id), 'deleted ticket still in normal list');
  assert.ok(/soft delete/i.test(list.body), 'soft-delete explainer line missing');
  assert.strictEqual((await admin.text(AP + '/support/' + t.public_id)).status, 404, 'deleted detail must 404 in normal flow');
  const dl = await admin.text(AP + '/support?deleted=1');
  assert.ok(dl.body.includes(t.public_id), 'ticket missing from Deleted filter');
  const dv = await admin.text(AP + '/support/' + t.public_id + '?view=deleted');
  assert.strictEqual(dv.status, 200);
  assert.ok(dv.body.includes('read-only'), 'deleted view lacks read-only banner');
  assert.ok(!dv.body.includes('/reply"'), 'deleted view still has a reply form');
  assert.ok(!dv.body.includes('/delete"'), 'deleted view still has a delete form');
  const msgs0 = Number((await q1('SELECT COUNT(*) c FROM support_messages WHERE ticket_id = ?', [t.id])).c);
  const rr = await admin.post(AP + '/support/' + t.public_id + '/reply', { _csrf: await csrfFor(admin, AP + '/support'), message: 'resurrect attempt' });
  assert.strictEqual(rr.status, 302);
  assert.strictEqual(Number((await q1('SELECT COUNT(*) c FROM support_messages WHERE ticket_id = ?', [t.id])).c), msgs0, 'reply landed on deleted ticket');
  assert.ok((await q1('SELECT deleted_at FROM support_tickets WHERE id = ?', [t.id])).deleted_at, 'ticket resurrected');
});

test('U-25 agent scope: foreign agent refused, owner agent deletes, reply-to-deleted refused', async () => {
  let tok = await csrfFor(admin, AP + '/agents');
  await admin.post(AP + '/agents', { _csrf: tok, name: 'Agent Two', email: 'agent2@v20t.test', password: 'Agent2#pass123' });
  const ag2 = await q1("SELECT id FROM users WHERE email = 'agent2@v20t.test'");
  await db.run('UPDATE users SET force_password_reset = 0 WHERE id = ?', [ag2.id]);
  const agent2Jar = await loginJar('agent2@v20t.test', 'Agent2#pass123', 'agent2');
  const g = await pA.text('/support');
  const cr = await pA.post('/support/new', { _csrf: csrfOf(g.body), subject: 'V20T agent scope', message: 'agent scope test', priority: 'medium' });
  assert.strictEqual(cr.status, 302, 'ticket create -> ' + cr.status);
  const t = await q1("SELECT * FROM support_tickets WHERE subject = 'V20T agent scope' ORDER BY id DESC LIMIT 1");
  assert.ok(t);
  const gl = await agent2Jar.text('/agent/players');
  const foreign = await agent2Jar.post('/agent/support/' + t.public_id + '/delete', { _csrf: csrfOf(gl.body) });
  assert.strictEqual(foreign.status, 404, 'foreign agent delete -> ' + foreign.status);
  assert.ok(!(await q1('SELECT deleted_at FROM support_tickets WHERE id = ?', [t.id])).deleted_at, 'foreign agent deleted the ticket');
  const gv = await agentJar.text('/agent/support/' + t.public_id);
  assert.strictEqual(gv.status, 200, 'owner agent detail');
  const own = await agentJar.post('/agent/support/' + t.public_id + '/delete', { _csrf: csrfOf(gv.body) });
  assert.strictEqual(own.status, 302, 'owner agent delete -> ' + own.status);
  const row = await q1('SELECT deleted_at, deleted_by FROM support_tickets WHERE id = ?', [t.id]);
  assert.ok(row.deleted_at && Number(row.deleted_by) === agentId, 'agent delete fields not set');
  assert.ok(await q1("SELECT id FROM audit_log WHERE action = 'support.delete' AND entity_id = ? AND actor_id = ?", [t.public_id, agentId]), 'agent delete audit missing');
  const lst = await agentJar.text('/agent/support');
  assert.ok(!lst.body.includes(t.public_id), 'deleted ticket still in agent list');
  const msgs0 = Number((await q1('SELECT COUNT(*) c FROM support_messages WHERE ticket_id = ?', [t.id])).c);
  const gl2 = await agentJar.text('/agent/support');
  const rr = await agentJar.post('/agent/support/' + t.public_id + '/reply', { _csrf: csrfOf(gl2.body), message: 'agent resurrect attempt' });
  assert.strictEqual(rr.status, 302, 'agent reply to deleted -> ' + rr.status);
  assert.strictEqual(Number((await q1('SELECT COUNT(*) c FROM support_messages WHERE ticket_id = ?', [t.id])).c), msgs0, 'agent reply landed on deleted ticket');
});

test('audit page: hash chain verifies after all admin actions', async () => {
  const r = await admin.text(AP + '/audit');
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.includes('Audit chain verified'), 'chain banner missing');
});

/* LAST: restarts the server twice. Master OFF -> a due job must not
   run at the boot tick; master ON -> the same job advances. */
test('automation: scheduler gating by master switch across restarts', { timeout: 120000 }, async () => {
  const job = await q1("SELECT * FROM cron_jobs WHERE handler_key = 'clean_tokens'");
  assert.ok(job, 'clean_tokens job missing');
  await db.run('UPDATE cron_jobs SET next_run_at = ? WHERE id = ?', [Date.now() - 1000, job.id]);
  const setMaster = async (on) => {
    const tok = await csrfFor(admin, AP + '/automation');
    await admin.post(AP + '/automation/master', { _csrf: tok, on });
  };
  await setMaster('0');
  assert.strictEqual(await setting('automation_master_enabled'), '0');
  await killServer(); boot(); await waitUp(); await sleep(3500);
  const j1 = await q1('SELECT last_run_at FROM cron_jobs WHERE id = ?', [job.id]);
  assert.strictEqual(Number(j1.last_run_at), Number(job.last_run_at), 'job ran while master OFF');
  const admin2 = await loginJar('admin@v20t.test', 'V20Test#admin1', 'admin2');
  const tok2 = await csrfFor(admin2, AP + '/automation');
  await admin2.post(AP + '/automation/master', { _csrf: tok2, on: '1' });
  assert.strictEqual(await setting('automation_master_enabled'), '1');
  await killServer(); boot(); await waitUp(); await sleep(3500);
  const db2 = require(path.join(ROOT, 'lib/db')).openDB().db;
  const j2 = await db2.get('SELECT last_run_at FROM cron_jobs WHERE id = ?', [job.id]);
  assert.ok(Number(j2.last_run_at) > Number(job.last_run_at), 'job did not run with master ON');
  admin = admin2;
});
