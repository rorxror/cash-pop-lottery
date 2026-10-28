'use strict';
/* V20 U-27 (owner-fix round) regression tests — register copy/layout +
   internal-language sweep. Run: node --test test/v20-u27.test.js
   Spawned server on port 4141 with a fresh temp SQLite DB (the round
   recipe env). Covers:
   - U-27.1 the "no country is pre-forced" helper is GONE from the
     rendered register page, and no confirmed internal phrase from the
     sweep blocklist appears on register or the main public pages
     (home, login, register, results, contact).
   - U-27.4/U-27.5 the applied homepage/scratch copy fixes render.
   - U-27.3 agreement DOM order: checkbox first, then ONE prose span
     whose text (links stripped) is exactly the owner's sentence,
     with the Terms / Privacy Policy links inline in reading order;
     and the block renders only under policy_agreement.
   - U-27.2 the phone-select sizing fix is present as CSS rules.
     Layout proof is at the CSS-RULE level by construction (headless
     Chromium in this sandbox blocks localhost, so no pixel claims):
     >400px the register select carries flex-basis/min-width 176px
     (fits "United States (+1)"); ≤400px the row stacks full-width.
   Pending-application hits (U-27.6..U-27.12, in D-FIX-B-owned files)
   are intentionally NOT asserted here — they land with the
   coordinator's application; see audits/owner-fix-round/adj-u27.md. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cashpop-v20u27-'));
const DB_PATH = path.join(TMP, 't.sqlite');
const PORT = 4141;
const BASE = 'http://localhost:' + PORT;
let server = null;

/* Confirmed internal phrases from the adj-u27 sweep — none of these
   may appear on a customer surface. */
const BLOCKLIST = [
  'pre-forced', 'not configured', 'decided on the server',
  'stored hashed', 'kept on the server', 'visual only',
  'server-side', 'backend', 'frontend', 'sample data',
  'TODO', 'FIXME', 'pre-shuffled', 'Template notice',
];
const OWNER_SENTENCE = 'I confirm I am 18 or older and I agree to the Terms and Privacy Policy.';

async function get(p) {
  const r = await fetch(BASE + p, { redirect: 'manual' });
  return { status: r.status, body: await r.text() };
}
async function waitHealthy(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(BASE + '/healthz'); if (r.status === 200) return true; } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
function withDb(fn) {
  const db = new DatabaseSync(DB_PATH);
  try { db.exec('PRAGMA busy_timeout = 5000'); return fn(db); }
  finally { try { db.close(); } catch {} }
}

let registerHtml = '';

test.before(async () => {
  const env = { ...process.env,
    PORT: String(PORT), BASE_URL: BASE, DB_DRIVER: 'sqlite',
    SQLITE_PATH: DB_PATH,
    TICKET_HMAC_SECRET: 'u27-test-hmac-secret-0123456789abcdef0123',
    ADMIN_SEED_EMAIL: 'admin@v20u27.test', ADMIN_SEED_PASSWORD: 'V20U27Admin#pass', ADMIN_SEED_NAME: 'U27 Admin',
  };
  delete env.DATABASE_URL; delete env.SMTP_HOST; delete env.DATABASE_URL_PG;
  server = spawn('node', ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stderr.on('data', d => process.stderr.write('[v20-u27 server] ' + d));
  assert.ok(await waitHealthy(), 'server must boot and answer /healthz');
  registerHtml = (await get('/register')).body;
});

test.after(async () => {
  if (server) { try { server.kill('SIGKILL'); } catch {} }
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('U-27.1: register page carries no internal language (helper removed, blocklist absent)', () => {
  assert.ok(!registerHtml.includes('pre-forced'), 'rendered /register must not contain "pre-forced"');
  assert.ok(!registerHtml.includes('Choose your country code, then your number'),
    'the old helper line must be removed entirely');
  for (const phrase of BLOCKLIST) {
    assert.ok(!registerHtml.toLowerCase().includes(phrase.toLowerCase()),
      `rendered /register must not contain blocklist phrase "${phrase}"`);
  }
  /* The field contract is untouched: label + select + placeholders
     still instruct the player on their own. */
  assert.ok(registerHtml.includes('id="phoneCc"'), 'country select still present');
  assert.ok(registerHtml.includes('Select country code'), 'select closed text still present');
  assert.ok(registerHtml.includes('United States (+1)'), 'country options still rendered as Name (+dial)');
  assert.ok(registerHtml.includes('placeholder="Phone number"'), 'number input placeholder still present');
});

test('U-27 sweep: main public pages carry no confirmed internal phrases', async () => {
  for (const p of ['/', '/login', '/register', '/results', '/contact']) {
    const { status, body } = await get(p);
    assert.equal(status, 200, `${p} must render 200`);
    for (const phrase of BLOCKLIST) {
      assert.ok(!body.toLowerCase().includes(phrase.toLowerCase()),
        `${p} must not contain blocklist phrase "${phrase}"`);
    }
  }
});

test('U-27.4/U-27.5: applied copy fixes render on home + scratch lobby', async () => {
  const home = (await get('/')).body;
  assert.ok(home.includes('Your password is protected, your sign-in stays secure, and your balance and results are held on our secure servers — never in your browser, so they can\'t be changed there.'),
    'Secure Platform card uses plain customer language');
  assert.ok(home.includes('Scratching only reveals it — it never changes it.'),
    'homepage scratch intro uses plain customer language');
  const lobby = (await get('/scratch')).body;
  assert.ok(lobby.includes('Scratching only reveals it — it never changes it.'),
    'scratch lobby header uses plain customer language');
});

test('U-27.3: agreement DOM order — checkbox first, one prose span, exact owner sentence', () => {
  const m = registerHtml.match(/<div class="field check">([\s\S]*?)<\/div>/);
  assert.ok(m, 'agreement block renders by default (policy_agreement=1)');
  const block = m[1];
  const cbIdx = block.indexOf('type="checkbox"');
  const spanIdx = block.indexOf('class="agree-text"');
  assert.ok(cbIdx !== -1, 'checkbox present');
  assert.ok(spanIdx !== -1 && cbIdx < spanIdx, 'checkbox comes before the prose span');
  const text = block.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  assert.equal(text, OWNER_SENTENCE, 'stripped text is exactly the owner sentence');
  const termsIdx = block.indexOf('<a href="/page/terms">Terms</a>');
  const privIdx = block.indexOf('<a href="/page/privacy">Privacy Policy</a>');
  assert.ok(termsIdx !== -1 && privIdx !== -1 && termsIdx < privIdx,
    'Terms and Privacy Policy links are inline in reading order');
  assert.ok(block.includes('name="agree"'), 'agree field name contract preserved');
});

test('U-27.3: agreement block renders ONLY under policy_agreement', async () => {
  withDb(db => db.prepare("UPDATE settings SET value = '0' WHERE key = 'policy_agreement'").run());
  /* Settings are cached for ~5s; poll until the flip is visible. */
  let gone = false;
  for (let i = 0; i < 24 && !gone; i++) {
    const { body } = await get('/register');
    gone = !body.includes('class="agree-text"');
    if (!gone) await new Promise(r => setTimeout(r, 500));
  }
  assert.ok(gone, 'with policy_agreement=0 the agreement block must not render');
  withDb(db => db.prepare("UPDATE settings SET value = '1' WHERE key = 'policy_agreement'").run());
});

test('U-27.2: phone-select sizing fix present as CSS rules (rule-level layout proof)', async () => {
  const css = (await get('/style.css')).body;
  assert.ok(css.includes('#registerForm .phone-row select { flex: 0 0 176px; min-width: 176px; }'),
    'split rule: register select keeps a 176px basis/min-width (fits "United States (+1)")');
  assert.ok(css.includes('#registerForm .phone-row input { flex: 1 1 auto; min-width: 0; }'),
    'split rule: number input takes the rest and may shrink');
  const stackAt = css.indexOf('@media (max-width: 400px)');
  assert.ok(stackAt !== -1, 'narrow stacking breakpoint present');
  const stackBlock = css.slice(stackAt, stackAt + 400);
  assert.ok(stackBlock.includes('#registerForm .phone-row { flex-direction: column; }'),
    'at ≤400px the register phone row stacks');
  assert.ok(stackBlock.includes('width: 100%'),
    'stacked controls take the full inner width (no clipping, dial code visible)');
  assert.ok(css.includes('#registerForm .field.check label { min-height: 48px; }'),
    'agreement label keeps the 48px touch target');
  assert.ok(css.includes('#registerForm .field.check .agree-text { flex: 1 1 auto; min-width: 0; }'),
    'agreement prose is a single flex item');
});
