# Audit D — migrations / settings / data / docs / tests (Cash Pop v17 recovery)

- Area: D only — `lib/migrations.js` (v1–v10), `lib/settings.js` and settings
  defaults/consumers, currency data/defaults, `docs/` in the fix copy,
  `test/` (all test files), `server.js` env handling and start script,
  `.env` handling and example files.
- Fix copy audited: `~/workspace/cash-pop-fix` (round-1 fixes already present).
  No code file was modified by this audit. No push, deploy, or zip.
- Sources re-read, not copied blindly: `NEW-BUGS-217.md` §2, `FIX-LOG.md`,
  `~/workspace/your_files/cash-pop-lottery/cash-pop-bug-audit-235.md`
  (B-001..B-235 — all excluded, none re-reported).
- Method: every finding below was verified by reading the code in the fix
  copy and, for settings, by grepping every seeded key for a real consumer
  outside `lib/migrations.js` and the admin settings forms. Line numbers are
  from the fix copy as read. Where a §2 headline needed correction, the
  correction is stated explicitly instead of repeating the headline.
- Tally: **17 confirmed findings — 2 High, 8 Medium, 7 Low.**
  Merged items (§3 of NEW-BUGS-217.md) are NOT counted again; they are listed
  in one line each under "Merged items (not counted)" below.

## Findings

### D-01 — High — MySQL v1 schema is missing `login_otps` and the OAuth columns
- File: `lib/migrations.js:402-433` (MySQL `users` table) vs
  `lib/migrations.js:138-149` (SQLite `users`, incl. `facebook_id`,
  `google_id`) and `lib/migrations.js:154` / `:286` (`login_otps` in SQLite
  and Postgres only).
- Verified: the MySQL `users` DDL ends at `created_at BIGINT NOT NULL`
  with no `facebook_id` / `google_id` columns, and the MySQL v1 block goes
  straight from `otp_codes` to `sessions` — there is no MySQL
  `CREATE TABLE ... login_otps` at all. SQLite and Postgres both have both.
- Consequence: on a MySQL deployment, OTP login (`lib/otp.js`
  `createOtp` inserts into `login_otps`) and OAuth account linking
  (columns `facebook_id`/`google_id`) fail with a missing-table / missing-
  column error, while the same code works on SQLite/Postgres. This is a
  driver-parity break in the "config-only switch" schema, not a cosmetic diff.
- Fix pointer: add a v11 migration adding `login_otps` and the two OAuth
  columns in all three DDL variants (and add a driver-parity check to tests).

### D-02 — Medium — Migrations are not atomic, and ALTERs have no IF NOT EXISTS (except PG v8)
- Files: `lib/migrations.js:560-585` (v3), `:587-612` (v4), `:638-760` (v7),
  `:761-772` (v8); `lib/migrations.js:848-862` (`migrate()`).
- Verified: `migrate()` runs each migration's `execScript(ddlFor(...))` and
  only then inserts the `migrations_applied` row — there is no transaction
  wrapping a migration, and no per-migration checkpoint. The SQLite/MySQL
  ALTERs are bare (`ALTER TABLE users ADD COLUMN referred_by ...`, etc.);
  only the Postgres v8 variant uses `ADD COLUMN IF NOT EXISTS`
  (`lib/migrations.js:768`). The MySQL v7 `CREATE UNIQUE INDEX
  idx_deposits_provider_txn` likewise has no `IF NOT EXISTS` guard.
- Consequence: the normal boot path is safe (applied versions are skipped),
  but an interrupted/crashed migration — or a manually re-run one — leaves a
  half-applied schema and the next boot dies with a duplicate-column /
  duplicate-index error instead of healing. That is exactly the class of
  failure that bricks a live upgrade.
- Fix pointer: wrap each migration in a transaction where the driver allows
  it, or make every ALTER/INDEX idempotent (driver-conditional existence
  check) before recording the version.

### D-03 — Low — Version-number gap (v9 missing) and v10 repair is exact-match only
- Files: `lib/migrations.js:761` (v8), `:773` (v10 — no v9 entry exists
  anywhere in the `MIGRATIONS` array).
- Verified: versions run 1–8, then 10. The v10 `UPDATE` repairs only
  `wager_options = '100,200,500,1000'` back to `'1,2,5,10'`. Any other
  corrupted/minor-unit form (partial list, operator typo, a value the draft
  wrote elsewhere) is left untouched, and a future v9 inserted into the array
  would run after v10 because `migrate()` iterates array order, not version
  order (`lib/migrations.js:855-859`).
- Consequence: audit confusion and a latent ordering trap; no live break on
  a clean v16 DB (the v9 draft never shipped, per the v10 comment itself).
- Fix pointer: either reserve/document v9 as intentionally skipped, or
  renumber, and sort migrations by version before applying.

### D-04 — High — Seeded CMS content ships false claims live (D-31 re-confirmed)
- Files: `lib/migrations.js:76` (`home_banner`), `:79` (`testimonials`),
  `:80` (`footer_about`), `:81` (`footer_contact`), `:118` (`tawkto`
  extension, `enabled: 0`); rendered by `views/index.ejs:103,168` and
  `views/layout.ejs:105,117` via `content(...)` with no filtering.
- Verified verbatim:
  - `home_banner`: `"<h2>Win up to 250X on every pop!</h2>"` — but the
    seeded prize table (`lib/migrations.js:13-15`, `DEFAULT_PRIZES`) tops
    out at multiplier 13 (1 pop → 13×, i.e. 86.7% RTP), and the admin prize
    form clamps multipliers to 1–15. 250× is ~19× the real maximum.
  - `testimonials`: `"Fast payouts and the draws are provably fair. I
    checked the seed hash myself!" — A. Player` — a fabricated quote
    attributed to a generic name, presented as a real testimonial.
  - `footer_about`: `"Licensed lottery operator."` — asserted in seeded
    content with no licence evidence anywhere in the fix copy.
  - `footer_contact`: `"Live chat available 24/7."` — while the Tawk.to
    extension is seeded disabled (`tawkto, 0, { embed_code: '' }`).
- Consequence: false advertising and an unverified licence claim on every
  fresh install's homepage and footer, plus a support channel promised
  that does not exist. Because seed is insert-if-missing (see D-15),
  existing DBs keep these claims forever even if the seed text is fixed.
- Fix pointer: change the four seed strings to honest values (max 13×,
  remove the fake testimonial or label it illustrative, drop the licence
  claim until evidenced, drop "24/7" while chat is disabled) AND add a
  one-time migration correcting already-seeded rows.

### D-05 — Medium — `deposit_mode`/`withdrawal_mode` "auto" and `auto_approve_deposit_limit` have no effect (D-9/D-10, corrected)
- Files: `lib/money.js:53-68` (`depositPolicy`/`withdrawalPolicy` return
  `{ allowed, mode }`); `routes/player.js:192,204,235,260` (all four
  callers check only `policy.allowed`, never `policy.mode`);
  `routes/player.js` deposit POST comment ("NO auto-approve: a deposit is
  credited ONLY by a verified provider webhook or an admin approving");
  `routes/admin.js:1597-1599` (form offers `manual|auto` + an
  auto-approve limit) and `:1655` (economy save accepts both).
- Correction to the §2 headline: the settings are NOT "never read" —
  `lib/money.js:57,64` do read `user.deposit_mode ||
  getS(settings, 'deposit_mode', 'manual')` (same for withdrawals). The
  real bug is narrower and worse in one way: the value is read, returned,
  and then ignored by every caller, and the deposit route deliberately
  never auto-approves. So an operator who sets mode=`auto` and a limit
  (e.g. "20.00") gets exactly the same manual-only behaviour as before,
  with the admin UI implying otherwise.
- Consequence: operator misconfiguration by design — auto mode is a
  dead switch that invites the operator to believe small deposits are
  being auto-credited (or auto-paid) when they are not.
- Fix pointer: either remove `auto` from the admin form and the limit
  field, or implement a verified auto path (webhook-verified only, capped
  by the limit) and make callers act on `policy.mode`.

### D-06 — Medium — `sms_provider` and `blocked_rails` settings are never read
- Files: `lib/migrations.js:42` (`sms_provider: 'textbelt'`),
  `:58` (`blocked_rails: 'ebt'`); `lib/otp.js:48`
  (`process.env.SMS_PROVIDER`, not the setting); `lib/rails.js:8`
  (`BLOCKED_RAILS = new Set(['ebt'])`, hardcoded).
- Verified by grep: zero reads of the `sms_provider` or `blocked_rails`
  setting keys anywhere outside `lib/migrations.js` and the admin form
  save path. OTP delivery keys off the `SMS_PROVIDER` env var, and the
  EBT block keys off the hardcoded set in `lib/rails.js`.
- Consequence: an operator editing these two settings in the database
  (or expecting the admin UI to expose them — neither appears in the
  admin settings page) changes nothing. The EBT block cannot be extended
  or lifted via the setting that claims to control it.
- Fix pointer: read both settings in `lib/otp.js` / `lib/rails.js`
  (env as override, not replacement), or delete the dead defaults and
  document the env/hardcoded source of truth.

### D-07 — Medium — `kyc_required`, `email_verification`, `mobile_verification` toggles enforce nothing
- Files: `routes/admin.js:1557-1559` (toggle labels: "KYC required",
  "Email verification — Require email verification", "Mobile verification
  — Require mobile verification"); `lib/money.js:49`
  (`verified_contact_required` — the only gate that actually blocks
  deposits/withdrawals on unverified contact).
- Verified by grep: no route or lib function reads `kyc_required`,
  `email_verification`, or `mobile_verification` as a gate. The email
  verification *flow* exists (token rows in `routes/auth.js:367` and
  `routes/player.js:391`, template slug `email_verification`), but it is
  opt-in per user; flipping the toggle to ON does not block registration,
  login, deposit, or play for an unverified user. `kyc_required` is even
  labelled in-admin as "currently informational".
- Consequence: an operator who enables these three toggles believes KYC /
  verification is enforced, when the only enforced gate is the separate
  `verified_contact_required` setting. Compliance-sensitive misreading.
- Fix pointer: wire the toggles to real gates (or rename the labels to
  "informational / flow available" and point at `verified_contact_required`).

### D-08 — Medium — Phantom password settings defeat `password_login_enabled`; OTP fallbacks disagree
- Files: `routes/auth.js:104-108` (login render) vs `:390-392` (OTP
  request gate); `lib/migrations.js:43-44` (seeded OTP defaults `'0'`).
- Verified:
  - Render: `passwordOn: getBool(settings, 'password_login_enabled', false)
    || getBool(settings, 'phone_password_enabled', true)
    || getBool(settings, 'email_password_enabled', true)`. The latter two
    keys are never seeded in `DEFAULT_SETTINGS`, never appear in the
    admin settings forms, and are never written anywhere — so their
    fallback `true` always wins. Setting `password_login_enabled='0'` in
    admin therefore cannot disable password login on the rendered page.
  - OTP: the render uses fallback `true`
    (`phoneOtpOn: getBool(..., 'phone_otp_enabled', true)`), while the
    request gate uses fallback `false` (`:390-392`). On a seeded DB both
    agree (seed is `'0'` → false), so this half is only a missing-row
    inconsistency (page advertises OTP, request 400s) — not a live break.
- Consequence: the password-login kill switch is illusory; the OTP
  inconsistency is a latent UI/gate mismatch if the settings row is ever
  deleted or a fresh DB misses the seed.
- Fix pointer: delete the phantom `phone_password_enabled` /
  `email_password_enabled` reads (or seed + admin-expose them) and make
  the OTP render/gate share one fallback (`false`, fail closed).

### D-09 — Low — Settings cache is module-global, unkeyed, and returns a shared object
- Files: `lib/settings.js:6-8` (`let cache`, `cacheAt`, `TTL = 5000`),
  `:18-22` (`getSettings` returns the cached object directly),
  `:34-38` (`setSetting` clears it, but only for writes through
  `setSetting`).
- Verified: the cache is not keyed by database or driver, is shared by
  every request in the process, and is returned by reference. Direct SQL
  edits, seed writes, another process, or a test that swaps databases do
  not invalidate it; only `setSetting` does. Cron uses `force=true`
  (`lib/cron.js:10,38`), but the per-request middleware
  (`server.js:168`) uses the cached copy.
- Consequence: up to 5 seconds of stale toggles after an out-of-band
  change (minor in production, single process), and stale-settings leakage
  across databases in tests — the kind of masking that hides real
  settings bugs.
- Fix pointer: key the cache by db/driver (or drop it — one `SELECT *`
  per request is already the documented cost), and return a copy.

### D-10 — Medium — Currency list: silent fallback plus unvalidated admin save
- Files: `lib/settings.js:40-46` (`getCurrencies`); `routes/admin.js:1714-1715`
  (currencies save); `server.js:171-177` (display-currency fallback).
- Verified:
  - `getCurrencies` catches any JSON error, empty list, or non-array and
    silently returns `[{ code: 'USD', symbol: '$', rate: 1 }]` — an
    operator typo in the JSON silently drops EUR/INR from every picker,
    wallet display, and `fmtMoney` symbol lookup, with no error surfaced.
  - The admin save validates only `code && symbol` per entry, then
    `String(code).toUpperCase().slice(0, 8)`, `String(symbol).slice(0, 8)`,
    `parseFloat(rate) || 1` — so duplicate codes after upper-casing,
    zero/negative/NaN rates (all coerced to 1), and a `base_currency`
    that is not in the list are all saved as "success". `server.js:177`
    then falls back `cur` to `base`, which itself may not be in the list,
    leaving symbol lookup to the `code + ' '` fallback in `lib/util.js`.
- Consequence: a single admin typo silently re-denominates the whole
  site's display currency, and duplicate/rate-1 entries corrupt the rate
  table that `convertMinor` (dead, see merged M-42) was supposed to use.
- Fix pointer: validate on save (unique codes, rate > 0 finite, base
  currency must be a list member) and make `getCurrencies` fail loudly
  (log + keep last good list) instead of silently substituting USD.

### D-11 — Low — Seeded currency rates are stale and decorative; all seeded rails are USD-only
- Files: `lib/migrations.js:20-21` (`currencies`: USD 1, EUR 0.92,
  INR 83.5 — hardcoded, no updater, no timestamp); `lib/util.js`
  `fmtMoney` (symbol lookup only, no conversion);
  `lib/migrations.js:828-830` (seed: every rail `VALUES ('both', ...,
  'USD', 1, 100, 100000, ...)` regardless of rail).
- Verified: no code updates the seeded FX rates, and no live path converts
  amounts with them (conversion lives in the dead `convertMinor`, merged
  to M-42, not counted here). Every one of the 13 seeded payment methods
  is USD, min 100 minor ($1), max 100000 minor ($1,000), kind `both`.
- Consequence: EUR/INR users see a currency picker but only USD rails;
  the displayed rates drift from reality without any warning, and the
  uniform min/max ignores per-rail economics.
- Fix pointer: either wire a real rate source + per-rail currency/min/max
  into the seed, or label the rates as display-only and seed rails in
  their native currencies.

### D-12 — Low — `.env` loader is cwd-relative, and the referenced `.env.example` does not exist
- Files: `server.js:12-22` (loader); `README-DEPLOY.md:18,74`
  ("see `.env.example`", "`cp .env.example .env`"); fix-copy root listing
  (no `.env.example`, no `.gitignore`).
- Verified: the loader tries only `'.env'` and `'./.env'` relative to the
  process working directory, not `__dirname` — starting the app from any
  other directory silently ignores the `.env` file and falls back to
  defaults (including the public HMAC fallback outside production, see
  merged P-26). The loader also silently ignores `export KEY=...` lines
  (regex requires the line to start with the key name) and keeps inline
  trailing text (`KEY=val # comment` → value includes ` # comment`,
  from the `(.*)` capture). And there is no `.env.example` in the fix
  copy for the README's two instructions to copy, nor a `.gitignore` to
  keep a real `.env` out of version control.
- Consequence: silent misconfiguration on non-standard start commands,
  polluted values from commented `.env` lines, and a documented setup
  step that cannot be followed as written.
- Fix pointer: resolve `.env` from `__dirname`, ship a real
  `.env.example`, add a `.gitignore` excluding `.env`, and strip inline
  comments / support `export`.

### D-13 — Low — Docs are stale in ways that mislead the operator
- Files: `docs/THREAT-MODEL.md` ("Credential theft" row: "Without the env
  key, new credentials store plaintext with a warning flash");
  `lib/credentials.js:35-38` (`encryptField` throws
  `CREDENTIAL_ENCRYPTION_KEY is not configured` when the key is missing);
  `README-DEPLOY.md` Option A (cPanel) + "pure-JavaScript dependencies
  only" + install list (`express, ejs, qrcode, nodemailer`, omitting `pg`);
  `server.js:2` ("cPanel-ready"); `docs/LOAD-TEST.md` / `THREAT-MODEL.md`
  (labelled v14/v15 state, pre-dating v16/v17 fixes).
- Verified: the threat-model credential row contradicts the current
  fail-closed code (and FIX-LOG.md's v16 note that credential saves are
  refused without the key) — an operator reading the doc expects a
  plaintext-with-warning fallback that no longer exists. The deploy doc
  still leads with cPanel and omits the `pg` dependency that Postgres
  deployments need.
- Consequence: operator acts on wrong assumptions (credential fallback,
  hosting route, dependency list) at exactly the moment they configure
  secrets and hosting.
- Fix pointer: update the threat-model credential row to fail-closed,
  update README-DEPLOY.md to the current hosting/dependency reality, and
  date/version-stamp the docs.

### D-14 — Medium — Test gaps (D-39..D-45, re-confirmed with corrections)
- Files: `test/pg-adapter.test.js:27-29`; `test/security-fixes.test.js:33-46,133-156`;
  `test/v17-fixes.test.js:106-128,223-254`; grep over `test/*.js` (zero hits
  for `decideDeposit`, `decideWithdrawal`, `createDeposit`; zero hits for
  a webhook-handler amount/currency test).
- Verified, item by item:
  - PG round-trip is skipped without `PG_TEST_URL`/`DATABASE_URL`
    (`pg-adapter.test.js:29`), and even when run it covers only
    `translatePg` + a probe table — never `migrate()` or `seed()` on
    Postgres, and never MySQL at all. D-01 (MySQL schema gap) would not
    be caught by any repo test.
  - `decideDeposit`, `decideWithdrawal`, and `createDeposit` have zero
    direct tests. `settleDraw` is partially covered (v17 second-settle
    guard, `:106-128`), but no test asserts a winning settle credits
    exactly `wager × multiplier` to the wallet.
  - Webhook amount-match has no regression test: the only webhook test
    (`security-fixes.test.js:47-60`) checks HMAC signature verification
    in isolation, never the handler's amount/currency matching.
  - Audit-chain deletion of row 1 is untested: the security test tampers
    row 2 (`:133-156`), and the v17 GENESIS test (`:223-254`) uses a
    single-row table with a tampered anchor plus a genuine single row —
    neither deletes the first row of a multi-row chain, which is the
    B-166 deletion scenario the GENESIS anchor exists to catch.
  - `sendOtp` test masking (narrowed, not fully open): the security test
    (`:33-46`) uses a fake DB whose `get` throws; the phone path never
    touches the DB and the email path's `notify.getTemplate` throw is
    caught → `sent:false`, so the test passes whether or not the
    `otp_login` template is seeded. The v17 seed test (`:149-...`, real
    `migrate()` + `notify.send`) does cover the seed, so the masking now
    applies to the unit test only — but the unit test still cannot catch
    a future seed regression on its own.
- Consequence: the highest-risk paths (money decisions, webhook matching,
  cross-driver schema, chain-anchor deletion) can regress without any
  repo test failing.
- Fix pointer: add PG + MySQL `migrate()` smoke tests (or a DDL parity
  test), direct `decide*/createDeposit` tests, a webhook amount/currency
  handler test, a delete-row-1 chain test, and a `sendOtp` test against
  a real seeded DB instead of the throwing fake.

### D-15 — Low — Seed never heals tampered or corrupted rows
- Files: `lib/migrations.js:786-835` (`seed()`: every `ensureSetting`,
  prize, content-block, page, template, extension, cron, and rail insert
  is guarded by "only if missing"); `lib/migrations.js:527-558` (v2 prize
  repair matches only the exact old tuples, e.g. `(1,250)`).
- Verified: seed runs on every boot, but it never updates, repairs, or
  even warns about an existing row whose value was changed — by an
  operator typo, a bad admin save, or direct SQL. A prize multiplier
  changed to an out-of-range value by SQL, a disabled `otp_login`
  template, or a false CMS block (D-04) all persist indefinitely; v2
  only fixes the specific pre-fix tuples it lists.
- Consequence: "seed runs on every boot" sounds self-healing but is
  insert-only; corruption is sticky and silent.
- Fix pointer: add a boot-time integrity check (at least for the prize
  table and required templates) that logs/alerts on unexpected values
  instead of silently accepting them.

### D-16 — Low — Admin economy save stores raw, unvalidated strings
- Files: `routes/admin.js:1655-1666` (`POST /settings/economy`: loops
  `['wager_options','max_pops','max_draws','day_draw_time','eve_draw_time',
  'commission_rate','deposit_mode','withdrawal_mode',
  'auto_approve_deposit_limit','referral_rate','multi_draw_discounts']`
  and `setSetting(k, String(req.body[k] || ''))` with no validation).
- Verified: unlike the risk save (`routes/admin.js:1668+`, which parses
  caps through `toMinor` and refuses on `null`) and the prize save
  (clamped 1–15), the economy save accepts empty/garbage verbatim.
  Consumers then fall back inconsistently: empty `wager_options` →
  `parseAmountList` fallback `[100,200,500,1000]` (`server.js:180`);
  garbage `max_pops` → `parseInt(...) || 15` (`routes/player.js:32`).
- Consequence: an operator typo either silently changes game economics
  or is silently ignored, depending on which consumer reads the value —
  with a "saved" flash in both cases.
- Fix pointer: validate the economy fields on save (same style as the
  risk save: reject invalid input, save nothing, flash the error).

### D-17 — Low — Duplicate toggle + settings with no admin UI
- Files: `routes/admin.js:1562` and `:1572` (both list
  `google_oauth_enabled` in `TOGGLES`, so the settings page renders the
  Google toggle twice); `lib/draws.js:34` (`upcoming_draw_days`, read but
  absent from every admin form); `server.js:160` (`admin_path`, read
  once at boot from settings/env, absent from every admin form).
- Verified by grep: `upcoming_draw_days` and `admin_path` have no admin
  form field, and `google_oauth_enabled` appears twice in the same
  toggle list (the second entry's help text differs, so this is a
  copy-paste duplicate, not two distinct settings). `admin_path` is
  additionally boot-only: a database change to it requires a restart,
  which nothing documents.
- Consequence: duplicate UI confuses the operator (which checkbox won?),
  and two live settings can only be changed by direct database edits —
  `admin_path` only with a restart.
- Fix pointer: de-duplicate the toggle list, add admin fields for
  `upcoming_draw_days` (and document `admin_path` as boot-only / env-only).

## Merged items (not counted — one line each, owning area)
- D-11 → G-7: maker-checker bypass beyond deposit/withdrawal approve — owned by G (admin routes).
- D-12 → P-41: `SESSION_SECRET` dead in one session-signing path — owned by P (sessions are opaque random IDs; README-DEPLOY.md:28 already notes no signing secret is required).
- D-16 → W-31: TextBelt fallback to the public shared key `textbelt` — owned by W (`lib/otp.js:55`).
- D-17 → W-30: Twilio `sendOtp` returns `sent:true` without checking response status — owned by W (`lib/otp.js:66-72`).
- D-20 → M-42: `convertMinor` dead code, unvalidated, hardcoded rate — owned by M (`lib/util.js`, zero callers).
- D-22 → M-25: unknown `DB_DRIVER` silently falls through to SQLite — owned by M (`lib/db.js` `openDB`).
- D-23 → M-27: Postgres SSL `rejectUnauthorized:false` unconditional — owned by M (`lib/db.js` Postgres adapter).
- D-24 → P-26: production HMAC guard fires only when `NODE_ENV=production`, but the start script is plain `node server.js` — owned by P (`server.js:50-52`, `package.json` `start`, fallbacks at `lib/draws.js:151` and `routes/player.js:74`).
- D-26 → P-39: Gold Rush re-seed on delete resurrects a deliberately deleted series — owned by P (`server.js` boot scratch seed).

## Checked and clear (verified NOT bugs in this area)
- D-18 (round-1 fix, excluded from tally): `otp_login` and `support_reply`
  templates ARE now seeded (`lib/migrations.js:103,106`), and the v17 seed
  test (`test/v17-fixes.test.js:149+`) proves they resolve on a fresh DB.
- Seed does not clobber operator changes: `ensureSetting` and all other
  seed inserts are insert-if-missing only (`lib/migrations.js:786-835`).
- Postgres fail-fast: `ddlFor` throws when a migration lacks a Postgres
  variant instead of running SQLite DDL on Postgres
  (`lib/migrations.js:840-846`).
- Global/per-user deposit and withdrawal blocks and the verified-contact
  gate ARE enforced (`lib/money.js:49-68`, called from
  `routes/player.js:192,204,235,260`) — only the `auto` mode value is dead
  (D-05), not the matrix itself.
- `getCurrencies` fallback to USD prevents a crash on corrupt settings
  (`lib/settings.js:40-46`) — the bug is the silence (D-10), not a crash.
- `SESSION_SECRET` absence is not a live hole: sessions are opaque random
  IDs in the DB (`lib/auth.js`), and README-DEPLOY.md:28 correctly says
  no signing secret is required — the merged D-12 item is a dead-config
  note, not a session-forgery vector.
- Prize economics in the seed are sane: `DEFAULT_PRIZES` caps at 13×
  (`lib/migrations.js:13-15`) and v2 repairs the old 250× table
  (`:527-558`) — the 250× problem survives only in CMS copy (D-04), not
  in payout math.
- Wager-option contract is locked: `server.js:180` parses the setting as
  major dollars via `parseAmountList`, v10 repairs the minor-unit form,
  and `test/v16-fixes.test.js` locks the contract — the remaining gap is
  only v10's exact-match narrowness (D-03).
- No `.env` values are committed in the fix copy itself (no `.env` file
  present); the D-12 finding is about the missing example/ignore files
  and the cwd-relative loader, not a leaked secret found on disk.

## Needs-check (NOT counted)
- D NC-1 (from NEW-BUGS-217.md §4): per-rail webhook HMAC formats — could
  not be verified from the D-area files alone; owned jointly with W.
- D NC-2 (from §4): rails seeded with kind `'both'`
  (`lib/migrations.js:828-830`) — verified as the seeded value, but
  whether each rail should be deposit-only, withdrawal-only, or both is
  a product decision, not a code fact; not counted.
- Whether the MySQL gap (D-01) breaks a live MySQL boot: verified by DDL
  text comparison across the three v1 variants, not by running against a
  live MySQL instance (none available in this audit).
- Whether the "Licensed lottery operator" footer claim (D-04) is true in
  the operator's jurisdiction: no licence document exists in the fix
  copy, so the claim is unverified from code — the finding is that the
  site asserts it unconditionally, not a legal verdict.
- Current FX for the seeded EUR 0.92 / INR 83.5 rates (D-11): no rate
  source exists in the repo to check them against; the finding is the
  absence of any updater, not a specific stale-rate figure.
