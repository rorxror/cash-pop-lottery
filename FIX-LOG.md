# FIX-LOG — v17 fix-coordinator round (fix copy only, no deploy, no push)

Baseline: v16 (commit 29591d8). All fixes are in `/home/hatch/workspace/cash-pop-fix`.
Line numbers verified by grep after all edits. Tests: `test/v17-fixes.test.js`
(new, 13 tests). Full suite: 28 pass / 0 fail / 1 skipped (Postgres live
round-trip, no PG_TEST_URL — expected).

## Priority fixes (in task order)

### (a) v16 REGRESSION — SQLite rejects FOR UPDATE entirely
- `lib/db.js:14,42,121` — adapters now expose `this.driver`
  (`sqlite` / `mysql` / `postgres`).
- `lib/money.js:76-81` — new `lockSuffix(db)` helper: `''` on SQLite
  (BEGIN IMMEDIATE serializes), `' FOR UPDATE'` otherwise. Corrects the
  false v16 comment that claimed SQLite treats FOR UPDATE as a no-op
  (empirically false: node:sqlite throws `near "UPDATE": syntax error`).
- `lib/money.js:295-311` — `settleAgentCommissions` uses the
  driver-conditional lock on the unsettled-commissions SELECT and throws /
  rolls back unless the guarded final UPDATE (`WHERE settled = 0`,
  line 309) affects exactly the selected row count.
- `lib/money.js:322-356` — `releaseReferralCredits` locks the PENDING rows
  (row-level, legal on Postgres/MySQL) instead of the aggregate SUM FOR
  UPDATE (illegal on Postgres, and SQLite rejects FOR UPDATE entirely);
  reads the released SUM plain after locking; claims each row FIRST via a
  guarded UPDATE (line 350, `pending → released`, counted only when
  `changes === 1`) before posting the ledger credit. Over-cap rows are
  marked `capped`, never paid.

### (b) D-18 — missing email/otp_login seed template (email OTP broken out of the box)
- `lib/migrations.js:103` — seed: email `otp_login` ("Your login code",
  body with `{{code}}`, 10 minutes).
- `lib/migrations.js:106` — seed: email `support_reply` ("Reply to your
  support ticket", body with `{{name}}` and `{{subject}}`), found by
  auditing every `notify.send` slug in code against the seed list
  (the other slugs were already seeded).
- Seed runs on every boot and inserts only if missing, so fresh AND
  existing DBs gain both templates.

### (c) W-7/W-8 — OAuth banned/pending/TOTP bypass
- `lib/auth.js:208-219` — new exported pure `oauthAccountCheck(u)`:
  banned → "This account has been blocked. Contact support.";
  pending_review → "Your account is pending review."; otherwise
  `{ ok: true, totpRequired: !!u.totp_secret }`.
- `routes/auth.js:550-558` — Facebook callback gates via
  `oauthAccountCheck` after resolve/create; refusal records a failed login
  and throws; `facebook_id` linking happens only after the gate passes;
  TOTP-enrolled users get `pending_user_id` + `pre_auth` stashed and the
  login TOTP-step render (mirrors the password flow).
- `routes/auth.js:616-629` — Google callback: gate moved BEFORE the
  `email_verified` mutation, same refuse / TOTP-stash flow; the old
  banned-only check after mutation is removed.

### (d) M-12 — settle double-pay guards
- `lib/draws.js:165-170` — entry UPDATE now guarded
  `AND status = 'pending'` (skips the entry when `changes !== 1`, so
  ledger/winner counting happens only on a successful claim).
- `lib/draws.js:182` — draws UPDATE now guarded
  `AND status = 'scheduled'` and throws / rolls back when `changes !== 1`.

### (e) M-11 — per-draw try/catch
- `lib/draws.js:75-92` — `settleDueDraws` wraps each `settleDraw` in
  try/catch and records `{ drawId, error }` without aborting the batch.

## Old 235-report Critical/High items (19)

- B-174 admin takeover via risk staffer:
  - `routes/admin.js:461,496,507,530,540,558,574,588` — biodata,
    reset-password, adjust, verify-contact, revoke-sessions and matrix
    handlers return 404 for missing or `role === 'admin'` targets
    (matching the block / login-as precedent).
  - `routes/admin.js:472-477` — biodata email change refuses when another
    account owns the new address (no verification row inserted).
  - `routes/auth.js:373` — `/verify-email` swap refuses (400) when another
    account already owns the new address.
- B-175 dead `admin_totp_required` toggle:
  - `server.js:346-353` — forced-action gate now derives enrollment from
    the live `totp_secret` when the toggle is on, for pre-existing admins
    who never got `force_totp_enroll` set. No DB flag needed: enrollment
    sets `totp_secret` and the gate then passes.
- B-019 agent unassigned exposure:
  - `routes/agent.js:44-47` — unassigned-players list returned only for
    admin viewers; agents get `[]`. Claim-by-ID route unchanged (agents
    who are given an ID by an operator can still claim).
- B-022 fairness pre-settle reveal:
  - `lib/draws.js:223-247` — new exported `fairnessForDraw(d)`:
    unsettled or null draw returns nulls for hash/number/verdicts;
    settled draws compute exactly as before.
  - `routes/site.js:80-82` — fairness route delegates to
    `fairnessForDraw(d)`; inline recomputation removed.
  - `views/verify.ejs:21-26` — found during live smoke testing: the
    template rendered a false `MISMATCH` badge for unsettled draws
    (`null` is falsy in the old ternary) and the badge markup was
    HTML-escaped by `<%= %>` so it showed as literal text. Now: null
    verdicts render a real `Not settled yet` badge (via `<%- %>`),
    null values render `—`. Settled draws still render MATCH/MISMATCH
    correctly (verified live: hash MATCH on a settled draw).
- B-052 ticker stored-XSS:
  - `public/app.js:183` — winners ticker HTML-escapes `w.name` and
    `w.amount_fmt` before `innerHTML` (escapes `& < > " '`).
- B-053 marketing fake stats:
  - `routes/site.js:42-54` — hero-stats marketing branch removed; stats
    are always real DB counts, `stats.mode` hardcoded `'real'`.
  - `public/app.js:102-103` — marketing setInterval random-tick branch
    and mode variable removed; count-up runs to the true value and stays
    pinned there.
  - `routes/admin.js:1618` — hero-stats settings card replaced with
    informational text (no form); the POST `/settings/hero-stats` route
    is removed.
- B-070 dark mode unreadable:
  - `public/style.css:672` — dark-mode block now also inverts the pair
    (`--white: #f5f5f7`, `--navy-900: #0b0d12`) with an explanatory
    comment. Deliberately did NOT darken `.form-card` (its `.muted` text
    uses dark `--apple-text2` and would lose contrast); pinned light
    surfaces left alone.
- B-096/B-097 migration wipe + no fingerprint:
  - `scripts/migrate-sqlite-to-postgres.js:21,70-119` — reads ALL source
    tables BEFORE deleting anything; a missing listed table aborts the
    run instead of being swallowed as zero rows; prints the target
    host/database and requires `TRANSFER_TARGET_FINGERPRINT` equal to
    the host/database derived from `TARGET_DATABASE_URL` in addition to
    `TRANSFER_WIPE_TARGET=1`; after COMMIT, re-counts every target table
    and fails on any mismatch (no more "0 failed" from source counts
    alone). Out of scope, unchanged: excluding sessions/otp_codes/
    login_otps from the transfer; unconditional TLS-verification-off.
  - `scripts/migrate-sqlite-to-postgres.js` TABLES list — added
    `responsible_play_pending` so the new pending-limits table is copied
    by the migration (otherwise pending decreases would silently vanish).
- B-105 agent-created player password retention:
  - `routes/agent.js:91-94` — agent-created player INSERT sets
    `force_password_reset = 1`; the server.js gate redirects them to
    `/force-reset` at first sign-in. Referral_code for agent-created
    players is a 235 Medium item — out of scope, not added.
- B-124 responsible-play instant removal:
  - `lib/scratch.js:35,64` — new `responsible_play_pending` table in all
    three DDL variants (sqlite/mysql/postgres) via `ensureScratchSchema`.
  - `lib/scratch.js:159-183` — `responsibleStatus` applies a due pending
    row (UPDATE main row, DELETE pending) and otherwise returns current
    limits plus the pending fields for the template notice.
  - `routes/scratch.js:48-65` — POST handler: increases apply immediately
    (and cancel any pending decrease for that field); decreases leave the
    main row untouched and write to the pending row with
    `effective_at = now + 24h`. Cooling-off/self-exclusion stay
    extend-only (`Math.max`).
  - `views/scratch_responsible.ejs:1` — pending-decrease notice line.
  - Both scratch enforcement and the new lottery check read through
    `responsibleStatus`, so both use effective limits automatically.
- B-130 phone-verified reset:
  - `routes/player.js:368-376` — profile POST sets `mobile_verified = 0`
    only when the trimmed new phone differs from the user's current phone.
- B-133 TOTP disable:
  - `routes/player.js:481-493` — disable requires password PLUS a current
    TOTP code OR a valid backup code (`useBackupCode` added to the
    `lib/auth` imports).
  - `views/security.ejs:23-24` — Disable 2FA form gains a `totp_code` field.
- B-135 backup regen:
  - `routes/player.js:495-508` — regeneration requires password PLUS a
    TOTP/backup code and audit-logs `user.totp_backup_regen`.
  - `views/security.ejs` — Regenerate form gains password + `totp_code` fields.
- B-158 notify unknown channel sent:
  - `lib/notify.js:34,89,107` — unknown channel throws in `send`,
    `sendQueued` and `sendRaw`, so the row is logged `failed` instead of
    `sent` (when a template is active; a missing template still yields
    an honest `skipped`).
- B-166 audit GENESIS:
  - `lib/audit.js:39` — `verifyChain` requires the first chained row's
    `prev_hash` to equal `'GENESIS'`; otherwise verification fails with
    reason `first chained row does not descend from GENESIS`.
- B-176 negative charges:
  - `lib/money.js:73` — `chargeFor` clamped to `>= 0`.
  - `routes/admin.js:959-968` — method create and edit validate rate /
    percent: blank still means old defaults (rate 1, percent 0); rate
    must be `> 0`; percent must not be `< 0`; garbage non-numeric rate
    throws into the existing catch/flash flow.
- B-177 dial ties:
  - `lib/phone-countries.js:64-90` — `isBlockedPhone` no longer attributes
    a shared dial to one country: a phone is blocked if ANY blocked
    country's dial is a longest-prefix match of its digits (blocking US
    blocks +1; blocking RU blocks +7 numbers including KZ, documented as
    inherent to dial-based blocking); unknown dials fail closed
    (blocked); an explicitly supplied country ISO may only ADD a block,
    never bypass the dial check. `countryForDialNumber` returns `null`
    for ambiguous shared dials instead of the first list entry.
- B-178 middleware crash:
  - `lib/auth.js:145` — `loadSession` body wrapped in try/catch forwarding
    to `next(err)` (previously an uncaught DB error became an unhandled
    rejection and the `process.exit(1)` handler killed the server).
  - `server.js:351` — forced-action gate's catch now calls `next(e)`
    instead of swallowing (`catch {}` → `next()`).
  - Deliberate decision: the `process.exit(1)` handlers for
    unhandledRejection/uncaughtException are KEPT as a last resort for
    truly unknown states; the crash vector fixed here is request-path
    middleware forwarding errors to Express, not the exit handler itself.

## Lottery loss limit (new, part of B-124 scope + task verification list)
- `lib/scratch.js:211-224` — new exported `enforceLotteryLossLimit(db,
  userId, total)`: today's `ticket_purchase` spend minus today's `win`
  credits plus the new total, compared against `daily_loss_limit` via
  `responsibleStatus` (per-game accounting mirroring scratch).
- `routes/player.js:92-93` — lottery buy calls it INSIDE the buy
  transaction (after the draw re-check, before the debit), so check +
  debit are atomic. Scratch enforcement unchanged.

## Tests
- `test/v17-fixes.test.js` — 13 tests: SQLite commission settle +
  idempotence; referral cap release (1 released / 1 capped); settle
  guards (second settle skipped, no double credit); settleDueDraws batch
  isolation; email OTP template seed (failed, never skipped-as-slug,
  real subject/body); OAuth refusal matrix; fairness settled-only;
  lottery loss limit (reject over-limit, allow in-limit); responsible-play
  24h delay (untouched until due, applied after); audit GENESIS
  (tampered anchor fails, genuine chain passes); phone dial blocking
  (US→+1, RU→+7/KZ, unknown fails closed); notify unknown channel
  (failed, never sent).

## Out of scope / pending (NOT fixed this round)
- All 235-report Medium/Low items (examples: agent-created
  `referral_code`, method sort 999, template badge/NaN display issues,
  pagination, docs gaps).
- All N-list items (see NEW-BUGS-217.md — source reports not received).
- All needs-check appendix items (see NEW-BUGS-217.md — listed, not fixed).
- Migration script: excluding sessions/otp_codes/login_otps from the
  transfer; unconditional TLS-verification-off.
- Profile-completion gate's `catch {}` + `next()` (fail-open on DB error,
  cannot crash; same pattern as the old forced-action gate).
- Test draws with manual winning-number overrides show a number MISMATCH
  on the fairness page: honest, because the published number was not
  derived from the seed (the draw is labeled TEST). Hash still MATCHes.
  Beacon-disabled/fallback/ok settled draws verify correctly
  (`combineSeed(seed, '') === seed`).

## Round 2b fixes (2026-10-27/28 — COMPILED-LIST.md R-001..R-124)

Fix copy only. No push, no deploy, no zip this round. Earlier-session
fixes (lib/util, lib/auth, lib/db, lib/settings, lib/credentials,
lib/rails, lib/beacon, lib/audit, lib/money, lib/draws, lib/scratch,
lib/otp, lib/breached, lib/phone-countries, routes/auth,
routes/webhooks, server.js, routes/player, routes/site, views/results,
views/login, views/security, public/app.js) and this session's fixes
(routes/agent, routes/scratch, routes/webhooks proof-match,
routes/player decimals, views/play, views/agent/dashboard, docs,
.env.example, .gitignore, test/v17b-fixes.test.js) are all recorded
below per item. Line numbers are from the fix copy at write time.

### Critical
- R-001 (pre-auth TOTP bypass) — FIXED. `lib/auth.js` `loadSession`:
  a session with `data.pre_auth` now yields `req.user = null` and
  `req.preAuth = true`; `routes/auth.js` pending-TOTP sessions are
  created with `user_id = 0` + `PREAUTH_TTL` (15 min) and carry a CSRF
  token for the TOTP form. Regression test: `test/v17b-fixes.test.js`
  (pre-auth yields null + preAuth; normal session resolves). Smoke:
  pre-auth sid cookie on the booted server got 302 → /login on /play.

### High (14)
- R-002 (TOTP step) — FIXED. `routes/auth.js`: TOTP step exempt from
  the captcha re-check; failed TOTP re-renders the TOTP form
  (`totpRequired` from `pending_user_id`); `views/login.ejs` has a real
  TOTP second-step form (input `totp_code` + CSRF hidden field).
- R-003 (OTP id_type alias) — FIXED. `routes/auth.js`: OTP request and
  verify accept `req.body.type` as an alias for `id_type`.
- R-004 (webhook currency) — FIXED. `routes/webhooks.js`: deposit
  currency must match the payload currency when one is carried;
  missing/mismatched currency fails closed to manual review. Smoke:
  EUR webhook against a USD deposit → "NOT auto-applied (currency
  mismatch)"; USD control → "deposit approved via webhook".
- R-005 (webhook units) — FIXED. `routes/webhooks.js`
  `MINOR_UNIT_RAILS` (`cards`, `crypto`, `apple_pay`, `google_pay`,
  `samsung_pay`, `qr_pay` = minor only; all other rails = major × 100
  only, never both). Exported for tests.
- R-006 (webhook status tokens) — FIXED. `routes/webhooks.js`
  `classifyStatus()`: whole-token map; `unpaid` → `unknown` (never
  success), `payment_failed` → `refund`, `payment_intent.succeeded` →
  `payment_success`. Exported for tests.
- R-007 (beacon in txn) — FIXED. `lib/draws.js` `settleDraw`: beacon
  fetch moved BEFORE the transaction (never held the SQLite write lock
  across a network call).
- R-008 (unknown DB_DRIVER) — FIXED. `lib/db.js` `openDB`: unknown
  explicit `DB_DRIVER` throws instead of silently falling through to
  SQLite while ignoring a real `DATABASE_URL`. Regression test.
- R-009 (OTP captcha + account gate) — FIXED. `routes/auth.js`: OTP
  request verifies captcha with `keepCustom: true` (see trade-off note
  below); when registration is disabled, OTP codes go only to
  identifiers tied to an existing account. `lib/migrations.js` v11 adds
  the `login_otps` table for MySQL.
- R-010 (false CMS seeds) — FIXED. `lib/migrations.js` `CONTENT_BLOCKS`:
  "Win up to 250X" → "Win up to 13X" (real max multiplier); fabricated
  "A. Player" testimonial → neutral placeholder text; "Licensed lottery
  operator" removed → "Play responsibly. 18+ only."; "Live chat
  available 24/7" removed → support email only.
- R-011 (staff role select) — FIXED. `routes/admin.js`: staff role
  select renders `selected` for the staffer's current role; previously
  the browser defaulted to `super`, so saving without choosing
  promoted any staffer to super. (Staff create was already safe.)
- R-012 (agent ?as= writes) — FIXED. `routes/agent.js:22-33`:
  `isSuperAdmin()` + `agentId()` split — agents always act as
  themselves; `?as=` honoured ONLY for super admins; a router-level
  POST guard refuses non-super admin POSTs to agent routes with 403.
  Non-super admin GET `?as=` is ignored (falls back to own id).
- R-013 (maker-checker gaps) — FIXED. `routes/admin.js`:
  `maybeMakerChecker` now queues balance adjust, agent float fund,
  commission settlement (largest single-currency total),
  withdrawal mark-paid (only from `approved`), draw settle (max
  single-currency stake), and draw cancel (max single-currency refund).
  Approvals executor branches on full `a.action` for all six, parsing
  `pending_approvals.detail` defensively.
- R-014 (email verification rows) — FIXED. `routes/admin.js`: admin
  email change marks prior pending rows used before inserting a new
  one; `routes/auth.js`: consume burns all other pending rows for the
  user, and the duplicate-address check runs BEFORE burning the token.
- R-015 (HMAC fallback boot) — FIXED. `server.js:53-57`: boot guard
  fires whenever `TICKET_HMAC_SECRET` is unset or equals the
  repo-public fallback, in ANY `NODE_ENV`, before `migrate()`. Smoke:
  fallback secret → exit 1 with the HMAC error, nothing listening.
  Regression test spawns the server and asserts refusal.

### Medium (58)
- R-016 (Postgres TLS) — FIXED. `lib/db.js` PostgresDB: default is
  verified TLS (`rejectUnauthorized: true`) for `verify-full` /
  `verify-ca` / `require` / non-localhost; only explicit opt-out
  (`PGSSL_INSECURE=1` or `sslMode='insecure'`) disables verification,
  with a console warning. Regression test constructs a Pool without
  connecting and asserts the ssl option both ways.
- R-017 (win-notify swallow) — FIXED. `lib/draws.js` `settleDraw`:
  post-commit notify failures write a failed outbox row (with the
  recipient email — `u` hoisted before the try) + a `win.notify_failed`
  audit row; non-`sent`/non-`skipped` results also get an audit row.
  Regression test monkey-patches `notify.send` to throw and asserts
  both rows; it also proves double-settle is exactly once (second
  settle `skipped`, wallet credited once).
- R-018 (scratch loss limit outside txn) — FIXED. `lib/scratch.js`
  `buyTicket`: series status re-checked INSIDE the transaction and the
  loss-limit check moved INSIDE on the `tx` handle with the re-read
  series price/currency. Regression test: second buy over the daily
  limit throws and creates no ticket.
- R-019 (server-local loss windows) — FIXED. `lib/scratch.js`:
  `enforceResponsiblePlay` and `enforceLotteryLossLimit` use UTC
  midnight windows (`setUTCHours`) instead of server-local midnight.
  Code-verified; no TZ-flaky test written (noted honestly).
- R-020 (cross-currency loss sums) — FIXED. `lib/scratch.js` loss
  checks accept an optional currency filter; `routes/player.js`
  lottery buy passes the ticket currency; scratch buy passes the
  series currency.
- R-021 (withdrawal in-txn re-check) — FIXED. `lib/money.js`
  `createWithdrawal` accepts optional `settings`+`user` and re-checks
  withdrawal rules INSIDE the creation transaction; `routes/player.js`
  passes them from both the non-OTP create and the OTP-verify create.
- R-022 (engine amount validation / fee cap) — FIXED. `lib/money.js`:
  `createDeposit`/`createWithdrawal` validate safe integer > 0 and cap
  charge at the amount so net can never go negative. Regression test.
- R-023 (beacon round shopping) — FIXED. `lib/draws.js`: if the draw
  has `beacon_round_pinned` it fetches that exact round; otherwise it
  fetches latest and persists the pin with a guarded
  `UPDATE … WHERE beacon_round_pinned IS NULL` OUTSIDE the settle
  transaction, so a failed settle cannot re-roll the round. Column
  added by `lib/migrations.js` v11.
- R-024 (session limit, scratch half) — FIXED. `routes/scratch.js:113`
  player buy: same rule as the lottery buy (login session age from
  `req.sess.created_at` vs `session_limit_minutes` from
  `responsibleStatus`), enforced before `buyTicket`. Lottery half was
  already in `routes/player.js`.
- R-025 (draw cancel) — FIXED. `lib/draws.js:114` `cancelDraw`:
  scheduled → `cancelled` only (guarded update); per-entry refund =
  `Math.round(ticket.total / ticket.num_draws)` (discount-aware; the
  earlier draft refunded `e.wager` alone and under-refunded multi-pop
  tickets); tickets with no pending entries become `cancelled`;
  audited with `throwOnError`. `routes/admin.js`: POST
  `/draws/:id/cancel` (scheduled only, maker-checker on the refund
  total) + `notifyDrawCancelled` (draw_cancelled template). Regression
  test locks the multi-pop math (2 pops × 100 = 200 refunded in full)
  and that a second cancel throws.
- R-026 (decimal-comma misparse) — FIXED. `lib/util.js` `toMinor`:
  rejects European decimal-comma input (`12,50`) unless it is a valid
  US thousands grouping (`1,000.50`); previously all commas were
  stripped (100× misparse).
- R-027 (login enumeration) — FIXED. `routes/auth.js`: no-account /
  wrong-password / banned / pending_review all return one generic
  `Invalid credentials.`
- R-028 (password lockout + scrypt codes) — FIXED. `routes/auth.js`:
  ≥10 password failures in 15 minutes blocks the attempt (fails closed
  on count-query error); login OTP codes stored with `hashCode`
  (scrypt) and verified with `verifyCode` (`lib/util.js`, legacy
  SHA-256 rows still accepted until expiry).
- R-029 (OTP request captcha / pumping) — FIXED with a noted scope.
  `routes/auth.js:428`: captcha is required on EVERY OTP request
  (unconditional) plus the login rate limiter; the account-tied
  sending gate applies when registration is disabled (when
  registration is open, OTP-to-a-new-identifier is the signup path by
  design, so an unconditional account gate would break signup).
- R-030 (reset-token invalidation) — FIXED. `routes/auth.js` (forgot
  + reset) and `routes/admin.js` (admin reset): issuing a new token
  marks all prior unused tokens for the user used before insert;
  successful reset burns all other outstanding tokens. Regression
  test runs the exact invalidation statement.
- R-031 (webhook rail matching) — FIXED. `routes/webhooks.js`: exact
  `provider_txn_id` match wins; otherwise a proof match only against
  pending deposits whose method rail equals the webhook rail; an exact
  match whose rail differs is rejected.
- R-032 (phone normalisation) — FIXED. `lib/util.js`
  `normalizePhone`: `00…` → `+…`; NANP `011…` → `+…`; strips one trunk
  `0` after a known country dial (not for dials `1`/`7`).
- R-033 (phone countries) — FIXED. `lib/phone-countries.js`: added KR
  (82), HK (852), MO (853) plus ~50 territories (PR 1787, GU 1671,
  VI 1340, AS 1684, MP 1670, BM 1441, KY 1345, TC 1649, VG 1284,
  AI 1264, MS 1664, SH 290, FK 500, GI 350, JE/GG/IM 44, FO 298,
  GL 299, AX 358, SJ 47, AQ 672, BV 47, HM 672, CC 61, CX 61, NF 672,
  NU 683, TK 690, WF 681, PN 64, CK 682, GS 500, IO 246, TF 262,
  UM 1, EH 212, XK 383, NC 687, PF 689, YT 262, RE 262, MQ 596,
  GP 590, BL 590, MF 590, PM 508, CW 599, SX 1721, BQ 599, AW 297).
  JE/GG/IM share dial 44 with GB by design; longest-prefix grouping
  handles the ambiguity.
- R-034 (Twilio unchecked) — FIXED. `lib/otp.js`: Twilio branch checks
  `r.ok` and requires a message SID, otherwise `sent:false`.
- R-035 (TextBelt shared key) — FIXED. `lib/otp.js`: TextBelt without
  an explicit `TEXTBELT_KEY` returns `sent:false` (no public shared
  key fallback).
- R-036 (CSRF session-less) — FIXED. `server.js`: session-less POSTs
  to `/login`, `/forgot`, `/register`, `/login/otp/request`,
  `/login/otp/verify` return 403 ("open the form first") instead of
  being skipped; other session-less POSTs (e.g. `/setup`) still pass;
  webhooks remain exempt. `routes/auth.js`: GET `/login`, `/register`,
  `/forgot` always create the anon session. Smoke: login/register
  POSTs with a valid session token succeed (302); the guard itself is
  asserted by a code-shape regression test (the middleware is inline
  in `server.js` with no clean unit hook — noted honestly).
- R-037 (OTP fetches lack CSRF) — FIXED. `public/app.js`: OTP fetches
  send the session CSRF token (`x-csrf-token` from the password
  form's `_csrf` input) plus captcha fields when present. Regression
  test asserts `x-csrf-token` in `public/app.js`.
- R-038 (HTML 429 for JSON) — FIXED. `lib/auth.js` `rateLimit`:
  returns JSON `{ok:false, error:'Too many requests…'}` for JSON
  requests instead of always rendering HTML 429.
- R-039 (signup-code atomicity) — FIXED. `routes/auth.js`: guarded
  atomic consume (`UPDATE … WHERE uses < max_uses`, changes must be
  1) with scrypt verification; duplicate email/phone checks run
  BEFORE consuming, so a duplicate registration no longer burns a
  single-use code. Regression test: second consume changes 0 rows.
- R-040 (OTP/TOTP races) — FIXED. `lib/otp.js` `verifyOtp`: atomic
  attempt increment (`WHERE verified=0 AND attempts<5`, changes must
  be 1) and atomic claim (`SET verified=1 WHERE verified=0`, changes
  must be 1). `routes/auth.js`: TOTP backup-code consume is a guarded
  CAS update (`WHERE backup_codes =?`, changes must be 1).
  Regression test: second parallel OTP verify fails.
- R-041 (pending_review sessions) — FIXED. `lib/auth.js`
  `loadSession`: sessions for `pending_review` users are destroyed
  exactly like `banned`.
- R-042 (captcha fail-open / no timeout) — FIXED. `routes/auth.js`:
  `checkCaptcha`/`verifyCaptcha`; a provider enabled without a secret
  fails closed instead of being skipped; `verifyProvider` uses
  `AbortSignal.timeout(5000)`.
- R-043 (migration atomicity / guards) — PARTIAL by dialect (see
  SKIPPED note below for the transaction half). `lib/migrations.js`:
  `migrate()` sorts `MIGRATIONS` by version before applying;
  Postgres v11 uses `ADD COLUMN IF NOT EXISTS`; SQLite/MySQL ALTER
  has no such guard, so v11 runs exactly once per
  `migrations_applied` (same as the v8 precedent). MySQL cannot wrap
  DDL in a transaction, so a failed v11 leaves the version
  unrecorded and the next boot retries it. This is a documented
  dialect limitation, not a silent drop.
- R-044 (dead auto mode) — FIXED per the pre-decided judgment call:
  NO auto-approval wired (deposits deliberately never auto-approve).
  `routes/admin.js` economy form and user-matrix form offer only
  `['manual']` for `deposit_mode`/`withdrawal_mode` with help text
  explaining auto was removed; POST whitelists `['', 'manual']` (a
  crafted `auto` falls back to blank = global, which is manual-only);
  the `auto_approve_deposit_limit` field was removed from the economy
  form and is no longer saved (the stored value, if any, is dead and
  left untouched).
- R-045 (dead sms_provider / blocked_rails) — FIXED. `lib/otp.js`:
  SMS provider is now `process.env.SMS_PROVIDER ||
  getS(settings, 'sms_provider', '')` — the seeded setting is the
  source of truth, env only overrides. `lib/rails.js`
  `isBlockedRail(key, extraCsv)`: EBT stays hard-blocked always; the
  `blocked_rails` setting adds operator blocks on top. Admin method
  handlers pass the setting.
- R-046 (dead KYC/verification toggles) — FIXED by relabel, not by
  wiring (wiring them to real gates would change behaviour; the
  compiled fix allows relabel/remove). `routes/admin.js` toggles:
  `kyc_required`, `email_verification`, `mobile_verification` help
  texts now say INFORMATIONAL ONLY — they enforce nothing; money
  movement is gated by `verified_contact_required`.
- R-047 (phantom password toggles) — FIXED by removing the phantom
  reads, not by seeding. `routes/auth.js`: `passwordOn`/`phonePwOn`/
  `emailPwOn` derive from the single `password_login_enabled` toggle
  (fallback `true`); the never-seeded `phone_password_enabled` /
  `email_password_enabled` keys no longer force password login on;
  OTP render fallbacks changed from `true` to `false` to agree with
  the OTP request gate (fail closed). Seeding the phantom keys was
  deliberately NOT done — it would resurrect the confusion.
- R-048 (currencies save) — FIXED after verifying actual behaviour
  against code: the old save stored NEGATIVE rates (`parseFloat(-5)`
  is truthy, so `|| 1` never fired; only NaN/0 became 1) — so the G
  report (negative accepted) was the accurate one. `routes/admin.js`
  currencies POST now validates the full list before saving anything
  (non-empty array; code `/^[A-Z]{2,8}$/` after uppercase, unique;
  symbol non-empty ≤ 8 chars; rate finite > 0; optional `decimals`
  int 0–8 preserved; base currency must be in the list) and audits
  old/new. `lib/settings.js` `getCurrencies` logs a console error and
  keeps the last good list on corrupt/empty JSON instead of silently
  substituting USD-only.
- R-049 (test gaps) — FIXED except the PG/MySQL migrate smoke (see
  SKIPPED note below). New `test/v17b-fixes.test.js` (22 tests) covers
  the required money/security set plus: direct `decideDeposit` /
  `decideWithdrawal` tests (approve-once + guarded second-decide
  failure; reject releases the hold in full); a delete-row-1
  audit-chain test (deleted earliest row → `verifyChain` fails, never
  passes silently); a `sendOtp` test against a real seeded DB with no
  provider (returns `sent:false`, code never in the result); and the
  webhook amount/currency handler behaviour is proven by live smoke
  (EUR mismatch refused, USD match approved). The PG/MySQL
  `migrate()` smoke needs a live PG/MySQL — none available in this
  environment — so it is a documented skip, not a silent drop.
- R-050 (ban status restore) — FIXED. `routes/admin.js`: ban stores
  `pre_ban_status` (v11 column); unblock restores it if
  `active`/`pending_review`, else `'active'`; unblock clears
  `pre_ban_status`. Users banned before v11 fall back to `'active'`.
  Audit includes `restored_from`.
- R-051 (agent float funding) — FIXED. `routes/admin.js`: verifies
  the agent exists with `role='agent'` AND `status='active'` (404
  otherwise); currency must be in the settings currency list; then
  maker-checker (`agent.float_fund`); execution uses shared
  `fundAgentFloat()`.
- R-052 (maker-checker conflict swallow) — FIXED. `routes/admin.js`
  `maybeMakerChecker` returns `false` below threshold, else a truthy
  object `{queued, duplicate?, approvalId?, conflictId?}` (existing
  callers' truthiness checks keep working): exact duplicate → no
  second row, `duplicate:true`; a DIFFERENT open decision for the
  same target queues separately and returns `conflictId`. Inserts
  include `detail` JSON (v11 column).
- R-053 (rejection notifications) — FIXED. `lib/migrations.js`
  `NOTIF_TEMPLATES` seeds `deposit_rejected`, `approval_rejected`,
  and `draw_cancelled` (insert-missing on boot, so existing DBs
  heal). `routes/admin.js`: direct deposit reject notifies the
  player (`deposit_rejected`); approval rejection notifies the
  requesting admin (`approval_rejected`) and, for player-visible
  items, the player (`deposit_rejected` / `withdrawal_decided`
  `rejected`), all try/catch-wrapped. The Approvals "Decided" table
  already surfaces rejections as the fallback surface. Withdrawal
  notify maps `mark_paid` → status `'paid'` (previously
  `'mark_paidd'`).
- R-054 (admin TOTP disable) — FIXED (plus parity extra, noted).
  `routes/admin.js`: disable requires a current authenticator code
  or backup code in addition to the password; disabling clears backup
  codes so a used code cannot replay; confirm and disable POSTs have
  per-user rate limits (`admin-totp:<userId>`, 15 min, max 10).
  Extra, beyond R-054's letter: disable also revokes other sessions
  (keeping current) and audits `other_sessions_revoked: true`,
  parity with player R-123.
- R-055 (unguarded JSON.parse) — FIXED. `routes/admin.js`:
  `safeJsonArray()` helper; dashboard exposure uses ONE query for all
  upcoming draws grouped in JS (also fixes the dashboard N+1) with
  `safeJsonArray` pops; tickets list uses it with fallback `'—'`.
- R-056 (body-parse crashes) — FIXED. `routes/admin.js`: biodata
  save and page create/edit coerce with `String(... || '')` before
  `.trim()`; name required; any validation failure flashes an error
  and saves nothing.
- R-057 (biodata validation) — FIXED. `routes/admin.js`: `kyc_status`
  whitelisted to `['none','pending','verified','rejected']`;
  `agent_id` blank → null, otherwise must exist with `role='agent'`;
  audit records `email_stored` (unchanged until verification),
  `email_requested`, `email_change_refused`,
  `email_change_pending` instead of logging the requested email as
  if stored.
- R-058 (economy validation) — FIXED. `routes/admin.js` economy
  POST validates ALL fields before saving anything (wager options =
  comma list of positive finite numbers; `max_pops` int 1–15;
  `max_draws` int 1–31; day/eve times strict HH:MM;
  commission/referral rates 0–100; modes must be `'manual'`;
  `upcoming_draw_days` int 0–365; multi-draw discounts =
  `draws:percent` pairs with draws ≥ 2, percent 0–100, empty
  allowed); any bad value rejects the whole save; old/new audit.
- R-059 (prize-table rewrite) — FIXED. `routes/admin.js` prizes
  POST: every `mult_*` must match `/^\d+$/` and be 1–15 or the whole
  save is rejected with nothing written; only genuinely changed rows
  are updated; old/new audit retained.
- R-060 (risk clamp) — FIXED. `routes/admin.js` risk POST:
  `payout_lock_hours` must be an integer 24–72 (as labelled) or the
  whole save is rejected; the old silent clamp to 0–168 is gone.
- R-061 (business report) — FIXED. `routes/admin.js` reports:
  `dateRange()` returns `{from, to, error, capped}` — invalid dates
  or from > to produce an error card (previously NaN silently
  emptied every report); ranges over 366 days clamp with a warning
  banner. Business tab: one GROUP BY query per metric (driver-aware
  day bucket), money in BASE currency only with an explicit label
  ("Other currencies are excluded here — see the per-currency
  strips on Deposits / Withdrawals").
- R-062 (support filters) — FIXED. `routes/admin.js`: status +
  priority filters run in SQL before LIMIT
  (`COALESCE(s.priority,'medium') =?`; invalid priority ignored);
  list paginates with total; every status tab link carries the
  priority filter and vice versa. Close/reopen use status-guarded
  UPDATEs with `changes === 1` checks; reply on a missing ticket →
  404, on a closed ticket → error flash + redirect to the ticket
  (previously silent redirect to the list).
- R-063 (bulk notifications) — FIXED. `routes/admin.js`: send POST
  validates subject (1–150 chars) and message (1–10,000 chars);
  `to` must be a known segment or a numeric existing user id;
  empty audience after `start_from` → error; audience > 500 → error
  (must segment); audience > 100 without batching auto-batches
  (100/batch, 60s cooling) with a flash note. Outbox tab paginates
  with total and preserved filters. Process-due counts the full due
  backlog (`dueTotal`) and flashes "X due total, Y processed this
  run" (previously the LIMIT-200 slice was reported as the total).
- R-064 (scratch creation validation) — FIXED, route + engine.
  Engine `lib/scratch.js` `launchSeries`: rejects negative tier
  amount/quantity, caps `total_tickets` at 1,000,000. Route
  `routes/scratch.js:256-280` (this session): currency whitelisted
  against the settings list; total tickets must be a positive
  integer 1–1,000,000 (no silent clamp — garbage and > 1M both
  rejected); tier lines split on the FIRST TWO colons only, so labels
  containing `:` survive (`100:5:Win:Big` keeps `Win:Big`); price and
  tier amounts convert with the series currency decimals (R-083).
- R-065 (seed in plaintext log) — FIXED. `routes/scratch.js:333`
  stop handler: logs only `seedHash: s.seed_hash`, never the full
  server seed.
- R-066 (scratch_events write-only) — FIXED by mirroring.
  `routes/scratch.js`: create/launch/toggle/stop mirror into
  `audit_log` (`scratch.series_created/launched/toggled/stopped`);
  the audit search (`/audit?q=series`) is the reader. No separate
  scratch-events viewer was added (the compiled fix allows mirroring
  as the fix).
- R-067 (scratch toggle on stopped/draft) — FIXED.
  `routes/scratch.js:316` toggle: refuses stopped/draft series with
  "Cannot toggle a <status> series — launch it to put it on sale."
  (launch sets `enabled=1` itself, so refusing draft toggle is safe;
  live series may still toggle).
- R-068 (agent transfer active rule) — FIXED. `routes/agent.js:139`
  transfer POST: target lookup now requires `status = 'active'`,
  matching its own UI. Note (not changed): the claim route
  (`/players/claim`, line 75) still allows assigning any player
  regardless of status — claiming is assignment, not a money
  movement, and an admin may legitimately assign agents to
  non-active players; R-068 is about funding, so this was left
  alone deliberately.
- R-069 (N+1 queries) — FIXED. Admin agents list: three GROUP BY
  queries (player counts, commission sums, all floats grouped in JS)
  replace 3 queries per agent; list paginates with total. Admin
  dashboard exposure: one query for all upcoming draws. Agent
  players list `routes/agent.js:61`: single GROUP BY ticket-count
  query replaces one query per player.
- R-070 (view-all links) — FIXED. `routes/admin.js`: user detail
  "View all" links (tickets → `/tickets?q=<email>`; transactions →
  `/reports?type=transaction&q=<email>`; logins →
  `/login-history?q=<email>`; activity → `/audit?actor=<id>`); agent
  detail Players card links to `/users?agent=<id>`; reports and
  login-history accept and preserve the `q`/`actor` filters; audit
  trail accepts `?actor=<id>`.
- R-071 (lottery base-currency-only buys) — FIXED, route + UI.
  `routes/player.js` GET `/play` offers every funded wallet (not only
  base) and passes `wallets` + `playCurrency`; buy reads
  `req.body.currency` when it is a configured currency, else base.
  `views/play.ejs:9-19` (this session): a wallet-currency `<select
  name="currency">` (funded wallets plus the current selection;
  `onchange` reloads `/play?currency=<value>` so the displayed
  balance matches the wallet used). Smoke: playslip rendered with
  the picker; a USD buy from a USD wallet succeeded.
- R-072 (buy close_at re-check) — FIXED. `routes/player.js` buy:
  inside the transaction it re-checks both status AND
  `close_at <= now()`.
- R-073 (stake cap + buy rate limit) — FIXED. `routes/player.js`
  `/play/buy`: 10/minute per-user rate limit mirroring scratch buy;
  per-draw per-player stake cap from setting `per_draw_stake_cap`
  (minor units, 0 = off) enforced inside the buy.

### Low (51)
- R-074 (ORDER BY) — FIXED. `lib/draws.js` `settleDueDraws`:
  `ORDER BY close_at ASC, id ASC`; `lib/money.js`
  `releaseReferralCredits`: `ORDER BY created_at, id`.
- R-075 (settle audit) — FIXED. `lib/draws.js`: settle audit uses
  the transaction handle with `throwOnError: true`
  (`lib/audit.js` `log(db, entry, opts)` supports it); audit-write
  failure now fails the settle loudly instead of being swallowed by
  `console.error`.
- R-076 (postLedger races) — FIXED. `lib/money.js`: `getWallet`
  insert race handled by catching UNIQUE/duplicate and re-reading;
  `postLedger` rejects non-safe-integer amounts instead of silently
  rounding; `balance_after` is read inside the same transaction
  after the guarded UPDATE.
- R-077 (engine amount validation) — FIXED (see R-022; same code).
- R-078 (scratch buy status re-check) — FIXED. `lib/scratch.js`
  `buyTicket`: series status re-checked INSIDE the transaction (stop
  race).
- R-079 (convertMinor fail-open) — FIXED. `lib/util.js`
  `convertMinor` now throws on non-finite input or unknown/zero rate
  instead of failing open to 1:1. It still has zero callers in
  shipped code; the throw is the safe default for any future caller.
- R-080 (test-draw validation) — FIXED. `lib/draws.js`
  `createTestDraw`: override must be an integer 1–15 or the call
  throws (no clamping, no NaN stored). `routes/admin.js` test-draw
  route: validates date `YYYY-MM-DD` (real date), time `HH:MM` 24h,
  override blank or integer 1–15; engine throw becomes a flash
  error, not a 500. `lib/draws.js` `closeAtFor` strictly validates
  `YYYY-MM-DD` and `HH:MM` and rejects overflow dates (month 13, day
  32) instead of `Date.UTC` silently normalising them.
- R-081 (ensureUpcomingDraws) — FIXED. `lib/draws.js`: validates
  `upcoming_draw_days` (0 = disabled, not silently 7), validates draw
  times up front, and catches per-draw UNIQUE violations so a
  duplicate-draw race does not abort the loop.
- R-082 (responsibleStatus swallow) — FIXED. `lib/scratch.js`:
  pending-apply errors are now logged with `console.error` instead
  of silently swallowed.
- R-083 (per-currency decimals) — FIXED, with a documented
  limitation. `lib/util.js`: added `decimalsFor()`; `fromMinor` /
  `fmtMoney` honour per-currency `decimals` (0 for JPY-style
  currencies) instead of assuming 100 minor units everywhere.
  Threaded this session: `routes/player.js:239,296` deposit/withdrawal
  typed amounts convert with `decimalsFor(method.currency, …)`;
  `routes/scratch.js:263,276` series price and tier amounts convert
  with the series currency decimals. LIMITATION (not silently
  dropped): lottery wager options are parsed once per request from
  the base-currency-major setting (`server.js` `parseAmountList` via
  `toMinor`, 2 decimals assumed) and are NOT re-based per ticket
  currency — per-currency wager options would be a product/economy
  change, not a safe minimal fix. Win math (`win = wager ×
  multiplier`) is untouched.
- R-084 (webhook secret fallback + weak keys) — FIXED.
  `lib/rails.js` `verifyWebhookSignature`: accepts ONLY
  `webhook_secret` (no `api_token`/`secret_key` fallback) and returns
  a distinct error when the raw body is unavailable (already parsed).
  `routes/webhooks.js`: credential decrypt failures audit-logged as
  `webhook.credential_decrypt_failed` instead of silently substituting
  `''`, and only `webhook_secret` is used. `lib/credentials.js`
  `getKey`: rejects all-zero keys and enforces strict base64
  (previously `Buffer.from` silently ignored invalid characters).
  Regression tests for all three.
- R-085 (DB adapter) — FIXED. `lib/db.js`: MySQL pool has
  `connectTimeout: 10000`, `acquireTimeout: 10000`, parsed port;
  SQLite path resolved against the app root, not CWD, so starting
  from another directory cannot create a second empty DB.
- R-086 (commission refId) — FIXED. `lib/money.js`
  `settleAgentCommissions`: ledger `refId` includes currency and
  commission IDs, not just `'COM'+now()`.
- R-087 (referral currency gate) — FIXED. `lib/money.js`
  `releaseReferralCredits`: per-row, per-currency activity gate — a
  referee active only in USD no longer unlocks EUR credits.
- R-088 (terms_accepted_at) — FIXED. `routes/auth.js`: registration
  INSERT sets `terms_accepted_at` when `agree` is present, and the
  register audit detail includes it; complete-profile UPDATE sets it
  too. Column added by `lib/migrations.js` v11.
- R-089 (breached-check fail-open visibility) — FIXED (fail-open
  itself retained by design, now visible). `lib/breached.js`:
  records `lastFailureAt` on HIBP HTTP failure or fetch error with a
  `console.error`; exports `breachedCheckFailedRecently()` (1-hour
  window). `routes/admin.js` settings page shows a red warning card
  when it is true ("passwords are currently accepted WITHOUT breach
  screening").
- R-090 (webhook rate limit + dedup) — FIXED. `routes/webhooks.js`:
  per-IP rate limit 60/minute; dedup scoped by provider (`event_id` +
  `provider`); the final insert is an atomic claim — a UNIQUE
  violation returns "duplicate event ignored" instead of 500ing
  after side effects.
- R-091 (forgot captcha + reset rate limit) — FIXED.
  `routes/auth.js`: forgot POST verifies captcha; reset POST has the
  login rate limiter; the captcha-failure render for `/forgot`
  regenerates captcha HTML.
- R-092 (phone login without JS) — FIXED. `routes/auth.js` password
  login: identifier routing is server-side — no `@` means phone
  lookup, mirroring the JS rule, so phone login works without
  JavaScript. Added the `password_login_enabled` gate.
- R-093 (scrypt codes) — FIXED (see R-028; same code).
- R-094 (TOTP login history) — FIXED. `routes/auth.js`: successful
  TOTP logins call `recordLogin(..., true)`.
- R-095 (verify-email consume order) — FIXED (see R-014; same code:
  duplicate check before burn, plus burn-all on consume).
- R-096 (Facebook no-email) — FIXED. `routes/auth.js`: Facebook
  OAuth refuses signup when Facebook returns no email, instead of
  inserting `''`.
- R-097 (v9 gap + v10 repair) — FIXED. `lib/migrations.js`: comment
  documents that there is no v9 (unreleased draft removed, numbering
  jumps 8 → 10; do NOT renumber because applied versions are
  recorded in `migrations_applied`); v10 wager repair now matches
  both `'100,200,500,1000'` and `'100, 200, 500, 1000'` (spaced draft
  variant) in all three driver variants. HONEST SELF-CORRECTION: an
  earlier draft v9 wager migration was WRONG (setting
  `'1,2,5,10'` was already correct — `server.js` parses via `toMinor`
  to $1/$2/$5/$10); v9 was removed, v10 repair migration restores
  it, and a regression test locks the contract.
- R-098 (settings cache copy) — FIXED. `lib/settings.js`
  `getSettings` returns a copy per caller, so a caller mutating the
  object no longer corrupts the shared cache.
- R-099 (placeholder FX rates) — FIXED by labelling, not by adding
  an updater (no live FX source is configured; inventing one would be
  a new integration). `lib/migrations.js` seed comment marks EUR
  0.92 / INR 83.5 as PLACEHOLDERS with no live FX updater; operator
  must update in Admin → Settings → Currencies.
  `routes/admin.js` currencies card carries the same note plus "All
  13 seeded payment rails are USD-only templates until configured
  per currency."
- R-100 (.env loader + example + gitignore) — FIXED.
  `server.js` `.env` loader resolves from the app root (`__dirname`),
  supports `export KEY=…`, and strips trailing inline comments from
  unquoted values. Added `.env.example` (all vars from code +
  README: `TICKET_HMAC_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`,
  `DB_DRIVER`, `DATABASE_URL`, `PGSSL_INSECURE` (opt-out only),
  `ADMIN_PATH`, `BASE_URL`, `PORT`, `SMTP_*`, `TWILIO_*`,
  `SMS_PROVIDER`, `TEXTBELT_KEY`, `GOOGLE_CLIENT_ID`/`GOOGLE_SECRET`,
  `FACEBOOK_APP_ID`/`FACEBOOK_SECRET`, `DRAND_API`,
  `ADMIN_SEED_*`, `SQLITE_PATH`, MySQL/PG vars) and a minimal
  `.gitignore` (`.env`, `node_modules/`, `data/`, `*.log`).
- R-101 (stale docs) — FIXED. `README-DEPLOY.md`: Render-first
  (Option A = Render Web Service + persistent disk or Postgres Basic;
  cPanel demoted to Option B with an explicit not-recommended-for-
  real-money warning); credential-without-key line corrected to
  fail-closed (v16); Postgres SSL line corrected to verified-TLS
  default with explicit opt-out. `docs/THREAT-MODEL.md` credential
  row corrected to fail-closed. Both date-stamped 2026-10-27 (v17
  round 2b).
- R-102 (seed healing) — FIXED. `lib/migrations.js` `seed()`: after
  the content-block insert loop, for each of the four R-010 keys, if
  the existing row body still contains its known false marker
  (`250X`, `A. Player`, `Licensed lottery operator`, `Live chat
  available 24/7`), the body is replaced with the corrected
  `CONTENT_BLOCKS` value. An operator who already rewrote the block
  is never overwritten.
- R-103 (phantom-success writes) — FIXED. `routes/admin.js`:
  deposit/withdrawal notes check existence first (404 if missing),
  then UPDATE, then audit (note truncated to 200 chars); method
  toggle/delete fetch (404) + `changes === 1` checks + old/new
  audits; pages/content delete fetch (404) + `changes === 1` +
  audit; OTP revoke uses `WHERE revoked = 0` + `changes === 1`;
  support close/reopen guarded UPDATEs with error flashes;
  flag review guarded by `reviewed_at IS NULL` + `changes === 1`;
  cron toggle 404s with an error flash when the job is missing.
  `routes/scratch.js` (this session): toggle/stop flash an error on
  a missing series (and stop refuses non-live series) instead of
  silently redirecting on a no-op. User-matrix and revoke-sessions
  handlers were verified to already check existence — no change
  needed there (recorded, not assumed).
- R-104 (audit-detail gaps) — FIXED. `routes/admin.js`: method
  create audits full new values, edit audits old/new; template
  update audits old/new (bodies truncated to 200 chars); appearance
  audits old/new changes; pages/content create audits values, edit
  audits old/new; extension update audits old/new enabled plus
  changed config key NAMES (never secret values); cron schedule
  audits old/new intervals per handler key, toggle audits old/new
  status; phone-countries POST audits old/new; reconciliation run
  audit-logs `reconciliation.run` with wallets_checked /
  mismatch_count / unconfirmed. (Currencies old/new is under R-048.)
- R-105 (draws pagination) — FIXED. `routes/admin.js` draws list:
  overdue queue is its own query (scheduled AND `close_at < now()`,
  LIMIT 100); upcoming (scheduled, `ORDER BY close_at`) and settled
  (`ORDER BY close_at DESC`) each paginate with totals via the shared
  `page` param (`lib/admin-ui.js` `paginate()` hardcodes the `page`
  param, so both tables share one page number — noted). Upcoming
  rows gained a "Cancel & refund" button.
- R-106 (users badge counts) — FIXED. `routes/admin.js`: badge
  counts use `COALESCE(u.email_verified,0) = 0` /
  `COALESCE(u.mobile_verified,0) = 0`, matching the list filter.
  Added `?agent=<id>` filter with a "clear filter" note and the
  param preserved in pagination.
- R-107 (mixed-currency strips) — FIXED. `routes/admin.js`:
  deposit/withdrawal strips sum grouped by currency
  (`GROUP BY currency, status`), rendered per currency; empty state
  shows "No deposits/withdrawals yet." instead of a zero
  base-currency strip. Reports payment/withdrawal tabs show
  per-currency net totals.
- R-108 (scratch detail 200) — FIXED. `routes/scratch.js:209`:
  nonexistent series now returns `res.status(404).send(...)`
  instead of 200.
- R-109 (login-history + reports pagination) — FIXED.
  `routes/admin.js`: login history filters in SQL (`q` searches
  email OR user name, `ip` substring, `success` any/1/0, `from`/`to`
  dates) with pagination preserving all filters; reports
  ticket/transaction/payment/withdrawal tabs paginate with totals;
  login tab breakdowns aggregate the whole range (previously grouped
  only the first 500 rows, then showed 200); OTP codes list
  paginates with total.
- R-110 (duplicate toggle + orphan settings) — FIXED.
  `routes/admin.js`: duplicate `google_oauth_enabled` row removed
  (kept the first "Google sign-in" row; toggles POST still saves
  each key once). Orphan settings: `upcoming_draw_days` gained a
  number field in the Game economy form (0 = disabled); `admin_path`
  is intentionally NOT editable in settings — an "Operator notes"
  card on the settings page says it is boot-only via `ADMIN_PATH`
  env (editing it from the panel would lock the operator out of the
  panel itself).
- R-111 (page status/sort) — FIXED. `routes/admin.js`: create/edit
  whitelist status to `published`/`draft`; create uses
  `sort = max+1` instead of 0 (edit keeps existing sort).
- R-112 (method field validation) — FIXED. `routes/admin.js`
  shared `validateMethodFields(body, settings)`: kind whitelist,
  name required, rail must be a known `RAILS` key, currency must be
  in the settings currency list, min/max/fixed via `toMinor` (blank
  = 0, negative/invalid → error), max = 0 means no max, max > 0 must
  be ≥ min. Create and edit both use it (rate > 0 / percent ≥ 0
  checks retained). Blocked-rail checks pass the `blocked_rails`
  setting.
- R-113 (withdrawal OTP-verify policy) — FIXED. `routes/player.js`:
  OTP-verify re-checks `withdrawalPolicy` (global/per-user mode,
  blocks, verified contact) and clears `pending_withdrawal` on
  refusal.
- R-114 (balance before withdrawal OTP) — FIXED. `routes/player.js`:
  balance checked BEFORE the OTP step.
- R-115 (payout-details plaintext) — FIXED. `lib/money.js`:
  `encodeUserData`/`decodeUserData` — payout details AES-encrypted
  with the credentials key when configured, plaintext otherwise;
  `decodeUserData` handles both forms so old rows keep working.
  `routes/admin.js` deposit/withdrawal detail pages use
  `decodeUserData` instead of raw `JSON.parse`. `routes/webhooks.js`
  (this session): proof matching no longer SQL-LIKEs the raw column
  (which could never match an encrypted row) — it fetches the rail's
  pending deposits (oldest first, capped at 500) and matches the
  quoted reference against the DECODED details in JS, with the same
  quoted-value, case-insensitive semantics as the old LIKE. Without
  `CREDENTIAL_ENCRYPTION_KEY`, details remain plaintext JSON by
  design (documented in code); `decodeUserData` handles both.
  Regression test: encryption round-trip + legacy plaintext decode.
- R-116 (proof length cap) — FIXED. `routes/player.js`:
  deposit/withdrawal custom-field values capped at 2000 characters
  server-side. (Verified: no file upload exists anywhere — no multer
  — so no upload allowlist surface was added.)
- R-117 (error echoes) — FIXED. `routes/player.js`: route error
  echoes replaced with generic user-facing messages plus
  `console.error` server-side logging. `routes/scratch.js:122`
  (this session): scratch buy uses the same pattern (generic
  message; details in the server log only). Smoke confirmed: an
  over-limit lottery buy returned the generic "Purchase failed"
  page while the server log carried the real reason.
- R-118 (mixed-currency stats) — FIXED. `routes/site.js`
  `/api/stats`: paid-out split by currency
  (`paid_out_by_currency`); headline `paid_out` is base-currency
  only; recent wins formatted in their own currency; homepage
  paid-out query restricted to base currency. `routes/agent.js:50`
  + `views/agent/dashboard.ejs:13` (this session): agent dashboard
  commissions grouped by currency (`GROUP BY currency`) and rendered
  per currency with `fmt()` — the old single summed total is gone
  (the old route also passed a `commission_earned_fmt` the template
  never received, so the KPI was effectively empty).
- R-119 (results pagination/filter) — FIXED. `routes/site.js`
  `/results`: paginated (25/page) with `type` filter (DAY/EVE/TEST)
  and `page`/`totalPages`/`filterType` passed to the template.
  `views/results.ejs`: per-row "Verify →" link to
  `/fairness?draw_id=<id>` and Previous/Next pagination.
- R-120 (countdown freeze) — FIXED, verified wired. `public/app.js`:
  on reaching zero it no longer freezes at "Closing…" forever — it
  disables the buy form once and reloads after 30 seconds to resync.
  Selector `#buyForm, form[action$="/play/buy"]` matches the
  playslip form id `playForm`. Server-side close enforcement is via
  R-072. No further change unless smoke shows otherwise (smoke did
  not — buys behaved normally).
- R-121 (session TTL alignment) — FIXED. `lib/auth.js`: exported
  `SESSION_TTL` (7 days), `ANON_TTL` (1 hour), `PREAUTH_TTL` (15
  minutes); `createSession` accepts `ttlMs` so DB expiry matches
  the cookie `maxAge` for that session kind; `touchSession` updates
  session data only and no longer slides `expires_at` (intentional:
  DB sessions no longer outlive cookies; dead anon/pre-auth rows no
  longer linger. If a flow breaks expecting sliding sessions, the
  fix is to re-issue the cookie — do NOT silently restore sliding).
- R-122 (logged-in password change) — FIXED. `routes/player.js`:
  POST `/security/password` — logged-in change with current-password
  check, role-based password rules, breached check, revocation of
  other sessions. `views/security.ejs`: Change-password form appended
  as a card after the main section (verified in the file tail: a
  complete card div inside the layout body, renders normally).
- R-123 (TOTP disable session revocation) — FIXED.
  `routes/player.js`: TOTP disable and backup-code regeneration
  revoke all other sessions (keeping current) and audit
  `other_sessions_revoked: true`. (Admin TOTP disable parity added
  under R-054.)
- R-124 (banned referrer/agent accrual) — FIXED. `routes/player.js`
  referral/agent accrual: banned or `pending_review` referrers/agents
  are skipped, with `referral.skipped_inactive` /
  `commission.skipped_inactive` audit rows.

### SKIPPED / PARTIAL (with exact reasons — nothing silently dropped)
- R-043 transaction half: SKIPPED as a code change because MySQL
  cannot wrap DDL in a transaction and SQLite/MySQL ALTER has no
  `IF NOT EXISTS` guard; the applied-versions table
  (`migrations_applied`) + sorted application + Postgres
  `IF NOT EXISTS` + retry-on-next-boot for a failed version is the
  implemented disposition (see R-043 above). Not a silent drop.
- R-049 PG/MySQL migrate smoke: SKIPPED because no live Postgres or
  MySQL instance exists in this environment; the Postgres skip in
  the test suite (`test/pg-adapter.test.js`) remains the expected
  1 skip. Everything else in R-049 is now tested (see R-049 above).
- R-036 live-CSRF unit test: the session-less refusal is proven by
  live smoke (valid-token POSTs succeed; the guard code path is
  asserted by a code-shape regression test) because the middleware
  is inline in `server.js` with no clean unit hook. Not claimed as
  a unit test.
- R-019 UTC-window test: code-verified (`setUTCHours` in
  `lib/scratch.js`); no TZ-dependent test written because it would
  be flaky across environments. Not claimed as tested.
- Appendix A needs-check items: NOT fixed this round by the compiled
  list's own instruction (kept out of the tally by the auditors).
  None of them were treated as R-items.

### Decisions / limitations carried forward (do not "fix" by reverting)
- OTP captcha `keepCustom: true`: custom-captcha answers are reusable
  within the session for OTP requests so resends work. Deliberate
  trade-off against breaking resends; third-party provider tokens
  are still single-use by the provider.
- Beacon pinning persists the pin OUTSIDE the settle transaction on
  purpose: a failed settle must not let the operator re-roll the
  beacon round. The pin column (`beacon_round_pinned`, v11) must
  exist before any settle runs on a migrated DB.
- Payout-details encryption is active only when
  `CREDENTIAL_ENCRYPTION_KEY` is configured; without it, details
  remain plaintext JSON by design, and `decodeUserData` handles both.
- Webhook unit convention is by rail family (`MINOR_UNIT_RAILS` in
  `routes/webhooks.js`), not per-method configuration. If a rail's
  real provider uses the other unit, that rail's entry in the set is
  the single place to change it.
- The HMAC guard refuses to boot on a fallback secret in ANY
  `NODE_ENV`. Smoke testing must always set a long
  `TICKET_HMAC_SECRET`; the "refuses to boot with fallback" check
  exits with an error, which IS the pass condition.
- Maker-checker queue semantics changed (R-052): an exact duplicate
  decision returns without a second row; a different open decision
  for the same target queues separately and surfaces `conflictId`
  in the flash. Callers rely on truthiness of the return value, not
  `=== true`.
- Cancel refunds are discount-aware (`total/num_draws` per entry),
  not wager-alone. The regression test locks this with a multi-pop
  ticket.
- `lib/admin-ui.js` `paginate()` hardcodes the `page` query param —
  that is why the draws page shares one page number across its
  upcoming and settled tables, and why reports pagination builds its
  base URL with type/from/to/q already in it.
- `getSettings` returns a copy: any code that mutated the returned
  settings object expecting the mutation to persist was relying on
  a cache bug; fix the caller, not the cache.
- The v16 credential-save fail-closed rule is unchanged: without
  `CREDENTIAL_ENCRYPTION_KEY`, admin credential saves are REFUSED.
  After deploying v17, the operator must set the key (64 hex chars)
  before saving provider credentials.
- The agent claim route (`/players/claim`) deliberately still allows
  assigning non-active players (assignment ≠ funding; see R-068).
- Lottery wager options remain base-currency-major-derived (see
  R-083 limitation); per-currency wager options are a product
  change, not a round-2b fix.

### Verification (this round)
- `node --check` passed on every edited JS file (server.js, all of
  lib/*.js, routes/*.js, test/*.js, scripts/*.js).
- `node --test test/*.test.js`: 51 tests, 50 pass, 0 fail, 1 skipped
  (the expected Postgres skip without `PG_TEST_URL`). New file
  `test/v17b-fixes.test.js` contributes 22 tests, all passing.
- Boot smoke on port 3117 (fresh SQLite, long `TICKET_HMAC_SECRET`,
  no real credentials): home 200; register 302 → /; admin login 302
  → admin panel 200; stealth admin 404 logged-out AND player;
  pre-auth session 302 → /login on /play; fairness page for an
  unsettled draw 200 with recomputed number "—"; webhook EUR vs USD
  deposit → NOT auto-applied (currency mismatch, manual review);
  webhook USD match → deposit approved via webhook; lottery buy 1
  succeeded (302 → ticket page), then with daily_loss_limit=150 set
  after a 100-minor buy, the second 100-minor buy → 400 with the
  server log "This purchase would exceed your daily loss limit."
  and no second ticket; commission settlement on SQLite: 2 settled,
  1200 total, second run 0/0, agent wallet 1200; referral cap release
  with cap 500: 1 released (400) + 1 capped (400); email OTP template
  (`otp_login`) + `deposit_rejected` / `approval_rejected` /
  `draw_cancelled` all seeded; fallback HMAC secret → exit 1, nothing
  listening. Server stopped after smoke. Pristine copy
  `~/workspace/cash-pop-push` untouched (still at v16 commit 29591d8,
  clean). No push, no deploy, no zip.

## Owner verification note (2026-10-27 ~21:45 CDT) — test-fixture correction, NOT a code change
- The round-2b report claimed the suite at 50 pass / 0 fail. The owner's
  independent re-run found 51 tests: 49 pass / 1 fail / 1 skipped. The single
  failure was the round-1 test "lottery loss limit: over-limit buy rejected"
  (test/v17-fixes.test.js:190): its fixture spend was stamped at LOCAL midnight,
  but R-019 changed enforcement to the UTC-midnight canonical window, so an
  evening-CDT run puts that spend in "yesterday" UTC and the limit correctly
  does not count it. The implementation was right; the fixture was stale.
- Fix: fixture now uses setUTCHours (test/v17-fixes.test.js:194-197, with a
  comment explaining why). Owner re-ran the full suite: 51 tests, 50 pass,
  0 fail, 1 skipped (expected Postgres skip, no PG_TEST_URL). node --check
  clean on all edited files. The R-019 UTC-window behaviour itself is unchanged.

## Round 2c fixes — v17.1 (owner-directed, 2026-10-27 ~22:05 CDT)
User authorised live deploy + left fix scope to owner judgment. Fixed only
what is clearly right; the rest is recorded below as deliberately skipped.
- NF-41 profile phone (routes/player.js): profile POST now stores
  normalizePhone form (same as registration) and refuses a number another
  account already uses (normalised both sides); garbage phone input errors
  instead of storing raw text. phoneChanged compares canonical forms.
- NF-10 OAuth error leak (routes/auth.js): Facebook/Google callback catches
  now render a generic failure message and console.error the raw error
  server-side instead of echoing exception text to visitors.
- C-3 HMAC fallback removed (lib/draws.js settle verify, routes/player.js buy
  sign): missing TICKET_HMAC_SECRET now throws instead of falling back to the
  repo-public dev secret. server.js boot guard (which compares against the
  fallback string to detect it) is intentionally kept — it is the detector.
- C-11 cancelDraw rounding (lib/draws.js): cumulative rounding — the k-th
  refund of a ticket pays round(total*k/n) - round(total*(k-1)/n), so
  cancelling every draw returns exactly total (was 3x333=999 on 1000).
- C-13 test-draw override (lib/draws.js createTestDraw): winning_number UPDATE
  now throws unless changes === 1.
- C-2 webhook decided_by (routes/webhooks.js): approve/revoke now pass NULL
  instead of fake admin id 0 (column is nullable on all drivers).
- C-7 withdrawal revoke (lib/money.js decideWithdrawal): revoke-before-payout
  now credits the FULL held amount (createWithdrawal holds full; fee was
  never earned). Reject already refunded full; revoke now matches it.
- NF-32 reconciliation (routes/admin.js): latest report now renders the
  stale-proof deposits table (id, public_id from lib/reconcile.js), not just
  the count.
- B-2 docs (README-DEPLOY.md): MySQL DDL non-atomicity documented (R-043).
DELIBERATELY SKIPPED (judgment, not oversight): B-1 phantom flashes ("All
sessions revoked" is vacuously true with zero sessions; matrix re-save is
idempotent, so a changes check would wrongly error identical re-saves);
C-1 responsibleStatus catch (transient-only; next attempt heals; throwing
would 500 every buy for that user); NF-34 cron lock (single Render instance
+ M-12 guarded claims make money safe; duplicate work only); NF-40 profile
country free text (informational field; strict validation risks breaking
legitimate saves); C-4 captcha keep (bounded by OTP caps + login limiter);
C-5 PG SSL empty host (empty host -> localhost default; SSL moot locally);
C-6 series seed plaintext (pre-existing design, THREAT-MODEL residual);
C-9 session limit inside enforceResponsiblePlay (both buy routes already
check it; sole caller is buyTicket behind the route check); C-10 per-user
buy limit (standard; accounts need verified contact + captcha); NF-23 route
rate limit (admin-only action + R-063 caps/batching already bound it).
