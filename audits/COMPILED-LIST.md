# COMPILED LIST — Cash Pop v17 recovery re-audit (round 2b)

Compiled by the coordinator from the five report FILES on disk (not from handoff
summaries): `audits/audit-M.md`, `audits/audit-W.md`, `audits/audit-D.md`,
`audits/audit-G.md`, `audits/audit-P.md`. Every entry below traces to a numbered
finding in one of those files; the fixer must read the source section for exact
file:line evidence and the full fix pointer. Nothing here is reconstructed from
memory: the lost round-2 reports were NOT reused, and §2 headlines of
NEW-BUGS-217.md were re-verified (or corrected) by the auditors against current code.

## Tallies (counted from the files, not the handoffs)
- Raw claims: 134 = M 28 (2H/11M/15L) + W 32 (1C/5H/16M/10L) + D 17 (2H/7M/8L) +
  G 38 (4H/23M/11L) + P 19 (1H/5M/13L).
  Note: the D handoff said 8M/7L; the FILE says 7M/8L — the file wins.
- Merges applied (10, same root cause / same fix pass): M-11+P-04 (session limit);
  M-09+P-05 (fee exceeds amount); G-15+D-10 (currencies admin save); G-14+D-16
  (economy admin save); G-36+D-17 (duplicate google_oauth_enabled toggle);
  W-10+G-05 (reset-token non-invalidation, user + admin issuers); G-21+M-21
  (scratch series creation validation, route + engine); G-33+M-19 (test-draw
  override validation); M-16+P-06 (scratch buy series re-check); M-25+W-29
  (webhook signing-secret fallback chain + weak credential keys).
- **Compiled total: 124 = 1 Critical, 14 High, 58 Medium, 51 Low.**
- Excluded (not counted): all B-001..B-235 items; all FIX-LOG.md round-1 fixes;
  all needs-check items (Appendix A); all "Checked and clear" items (Appendix B).

## CRITICAL (1)

- **R-001 [Critical] W-01** — Pre-auth TOTP session is already fully authenticated:
  `routes/auth.js:175` creates the pending-TOTP session with the real `user_id`
  and `lib/auth.js` `loadSession` never checks `pre_auth` (nor do server.js gates),
  so with no prior session a password-only attacker can reuse the `sid` cookie and
  browse as the user, skipping TOTP. Fix: `loadSession` + gates must refuse
  `pre_auth` sessions for authenticated routes; pending-TOTP sessions must carry no
  usable identity until the TOTP step passes.

## HIGH (14)

- **R-002 [High] W-02** — TOTP second step has no UI input (`views/login.ejs` never
  renders a `totp_code` input) and is blocked by the captcha re-check
  (`routes/auth.js:122` re-runs captcha while TOTP renders supply `captchaHtml: ''`).
  Fix: render the TOTP input; exempt the TOTP step from the captcha re-check (or
  carry the passed captcha through).
- **R-003 [High] W-03** — Phone OTP is dead: frontend `public/app.js:437,449,458`
  sends `{type}`, server `routes/auth.js:382,409` reads only `id_type`, so phone OTP
  always falls into the email branch and 400s. Fix: accept `type` (or send `id_type`).
- **R-004 [High] W-04 (= §2 W-32)** — Webhook amount check ignores currency
  (`routes/webhooks.js:87-91` compares amounts only, never `dep.currency` vs
  `ev.currency`). Fix: require currency match as part of amountOk.
- **R-005 [High] W-05** — Webhook amount check accepts BOTH minor and major units,
  so a 100× smaller payment matches on reference. Fix: accept exactly one unit
  convention per method (minor preferred); reject ambiguous matches to manual review.
- **R-006 [High] W-06 (= §2 W-33)** — Webhook status classification uses substring
  regexes (`routes/webhooks.js:29-30`): `unpaid`→success, `payment_failed`→refund/
  revoke, Stripe `*.succeeded`→unknown (never auto-approves). Fix: whole-token status
  map per provider.
- **R-007 [High] M-01** — Beacon HTTP fetch runs INSIDE the settle transaction
  (`lib/draws.js:94,122`); on SQLite (single shared connection, BEGIN IMMEDIATE) it
  holds the whole-DB write lock across a network call, fails concurrent writes, and
  lets unrelated plain writes join the settle txn and roll back with it. Fix: fetch
  the beacon BEFORE opening the transaction.
- **R-008 [High] M-02 (= §2 M-25)** — Unknown `DB_DRIVER` silently falls through to
  SQLite (`lib/db.js:195,226`), ignoring a real `DATABASE_URL`. Fix: throw on an
  unrecognised explicit driver value.
- **R-009 [High] D-01** — MySQL v1 schema gap: `lib/migrations.js:402-433` MySQL
  `users` has no `facebook_id`/`google_id`, and there is no MySQL `login_otps` table
  at all (SQLite `:154`, Postgres `:286` both have it). MySQL OTP login and OAuth
  linking fail while SQLite/Postgres work. Fix: add the missing columns + table to
  the MySQL DDL (and a repair migration for existing MySQL DBs).
- **R-010 [High] D-04 (= §2 D-31)** — Seeded CMS content ships false claims live:
  `lib/migrations.js:76` "Win up to 250X" vs real max 13×, `:79` fabricated
  "A. Player" testimonial, `:80` "Licensed lottery operator", `:81` "Live chat
  available 24/7" while Tawk.to is seeded disabled (`:118`). Rendered via
  `views/index.ejs:103,168`, `views/layout.ejs:105,117`. Fix: correct all four
  claims in the seed (and heal existing DBs — see D-15).
- **R-011 [High] G-01 (= §2 G-35)** — Staff role-change select at
  `routes/admin.js:1833` has no `selected` — browser defaults to first option
  `super`, so saving without choosing promotes any staffer to super. (Staff create
  at `:1828` is safe.) Fix: mark the current role selected; require an explicit
  change (or confirm).
- **R-012 [High] G-02** — Agent panel `?as=` (`routes/agent.js:15`) lets any
  admin-role user — including support/risk/finance sub-roles blocked by admin RBAC —
  WRITE as any agent (transfer from that agent's float, claim/create players).
  Agent router has no `rbacMiddleware`/`admin_role` check. Fix: gate the agent
  router by role (admin + agent only, with `as` restricted to admins).
- **R-013 [High] G-03 (= §2 G-7, expanded)** — Maker-checker is only called from
  deposit/withdrawal decide paths; balance adjust, agent float funding, commission
  settlement, withdrawal mark-paid, and draw settlement all bypass it at any amount.
  Fix: route those money actions through `maybeMakerChecker` at the same threshold
  (or record a documented exemption with audit flag).
- **R-014 [High] G-04 (= §2 G-5)** — Admin email-change inserts a new verification
  row (`routes/admin.js:480`) without invalidating prior pending rows, so A→B→C
  leaves the B token live to swap back (verified against `routes/auth.js:367-369`,
  which accepts any unused, unexpired row). Fix: invalidate prior pending rows on
  insert and on consume.
- **R-015 [High] P-19 (= §2 P-26)** — Production HMAC guard fires only when
  `NODE_ENV=production` (`server.js:50-52`), but `package.json` start is plain
  `node server.js`, and signing (`routes/player.js:74`) and verification
  (`lib/draws.js:151`) fall back to repo-public `'dev-secret-change-me'`. If prod
  runs without `NODE_ENV=production`, ticket-tamper protection is void. Fix: fail
  boot on unset/fallback secret regardless of NODE_ENV (and set NODE_ENV in start).

## MEDIUM (58)

- **R-016 [Medium] M-03 (= §2 M-27)** — Postgres SSL always disables certificate
  verification for non-localhost hosts (`lib/db.js:130-131,210-217`), with no
  `PGSSLMODE` value restoring verification. Fix: default `rejectUnauthorized: true`;
  opt-out only via explicit env with a boot warning.
- **R-017 [Medium] M-04 (= §2 M-16)** — Win-notification failure inside settle is
  swallowed by bare `catch {}` post-commit (`lib/draws.js:210-211`), no outbox/audit.
  Fix: write failed win notifications to the outbox + audit-log, with retry.
- **R-018 [Medium] M-05 (= §2 M-32, scratch variant; lottery variant verified FIXED)**
  — Scratch loss-limit check still runs OUTSIDE the buy transaction
  (`lib/scratch.js:224-227`). Fix: move it inside the txn (as the lottery fix does).
- **R-019 [Medium] M-06 (= §2 M-35)** — Daily-loss window is server-local midnight
  (`lib/scratch.js:198,214`) while withdrawal caps are UTC (`lib/money.js:225-226`).
  Fix: one canonical UTC window for all responsible-play/limit accounting.
- **R-020 [Medium] M-07** — Daily loss limits sum across currencies with no currency
  filter (scratch + lottery), unlike the correctly-filtered withdrawal caps. Fix:
  filter loss accounting by currency (per-wallet or converted at configured rates).
- **R-021 [Medium] M-08** — Withdrawal caps, turnover and payout-lock are checked
  OUTSIDE the creation transaction (TOCTOU): concurrent requests can exceed caps.
  Fix: check inside the creation txn (or lock the player's cap aggregate).
- **R-022 [Medium] M-09 + P-05 (merged)** — Fee/charge can exceed the amount,
  producing a negative net deposit/withdrawal (`lib/money.js:68,94,148` +
  `createDeposit`/`createWithdrawal` `:86-94,:139-148`); `chargeFor` clamps only the
  charge, not the net. Deposit approval then debits the player (or the deposit can
  never approve and sticks pending). Admin validation checks only rate > 0,
  percent ≥ 0 (`routes/admin.js:965-970`). Fix: cap charge at amount (net ≥ 0) at
  engine level + validate at admin save.
- **R-023 [Medium] M-10** — Beacon round is not pinned: settle uses whatever drand
  round is latest at settle time, so an operator with seed access + settle timing
  can shop rounds. (Distinct from B-179 signature issue, excluded.) Fix: pin the
  round at draw creation (or at close) and verify the beacon against that round.
  Narrower if cron auto-settles — still fix the pinning.
- **R-024 [Medium] M-11 + P-04 (merged)** — `session_limit_minutes` is stored,
  displayed, and returned by `responsibleStatus`, but NEVER enforced anywhere: no
  buy path, login path, or middleware reads it. A saved "protection" that does
  nothing. Fix: enforce it (session-start timestamp + middleware/buy check) or
  remove the setting from the UI.
- **R-025 [Medium] M-18 (= §2 M-43)** — No draw-cancel / refund path exists
  anywhere; an un-settleable draw locks funds with no audited remedy. Fix: add an
  admin draw-cancel that refunds stakes to wallets + audits + notifies.
- **R-026 [Medium] M-23** — `toMinor` strips commas US-style (`lib/util.js:33`), so
  `12,50` (decimal comma) parses as $1,250.00 — a 100× misparse. Fix: reject (or
  correctly interpret) decimal-comma input instead of silently stripping commas.
- **R-027 [Medium] W-07** — Password login fully enumerates accounts and their
  status (distinct no-account / invalid / banned / pending messages). Fix: one
  generic "Invalid credentials." for all login failures (status revealed only
  after authentication, if at all).
- **R-028 [Medium] W-08** — No per-account password lockout; only the TOTP step
  checks failure history. Fix: per-account lockout/throttling on password failures.
- **R-029 [Medium] W-09** — OTP request has no captcha and accepts arbitrary
  identifiers (SMS/email pumping + inbox spam at operator cost). Fix: require
  captcha on OTP request; send only to identifiers tied to an existing account
  (or a prior verified step).
- **R-030 [Medium] W-10 + G-05 (merged)** — Password-reset tokens are never
  invalidated except the one used (user-requested flow, `routes/auth.js`) and the
  admin-initiated reset likewise never invalidates prior tokens (`routes/admin.js`).
  Fix: mark all prior unused reset rows for the user used before inserting a new
  token, on both issuers.
- **R-031 [Medium] W-11** — Webhook deposit matching ignores the deposit's
  method/rail, and a pending match beats an exact `provider_txn_id` match. Fix:
  require method/rail match (or same-rail group) and prefer exact txn-id matches.
- **R-032 [Medium] W-12** — Phone normalisation does not handle 00/011 prefixes or
  trunk 0, splitting one number into several identities (verified: `003…`/`011…`
  kept verbatim, `+4407700…` ≠ `+447700…`). Fix: normalise 00/011 → `+` and strip
  trunk 0 after the country code, before dedup/lookup.
- **R-033 [Medium] W-13 (= §2 W-42)** — COUNTRIES table missing ~50 territories
  plus KR/HK/MO (verified by execution: +82/+852/+853 all fail-closed blocked, so
  those users cannot register). Fix: complete the table from ISO 3166 with correct
  E.164 dial codes.
- **R-034 [Medium] W-14 (= §2 W-30)** — Twilio `sendOtp` returns `sent:true`
  without checking the response (unlike TextBelt which checks `j.success`). Fix:
  check `r.ok` + error payload; return `sent:false` on non-2xx.
- **R-035 [Medium] W-15 (= §2 W-31)** — TextBelt without a key falls back to the
  public shared key `textbelt` (1 SMS/day shared quota, effectively exhausted).
  Fix: refuse TextBelt without explicit `TEXTBELT_KEY` (sent:false + config error).
- **R-036 [Medium] W-16 (= §2 W-4, session-less half)** — Global CSRF skips
  session-less POSTs (`server.js:260-261` + SameSite=lax), so login/forgot/logout
  CSRF works. Fix: require a CSRF token on login/OTP POSTs even without a session
  (always create the anon session on login GET, as OAuth routes already do).
- **R-037 [Medium] W-17 (= §2 W-4/W-5, OTP half)** — OTP JSON endpoints 403 when a
  session exists, because the frontend sends no CSRF token. Fix: send the session
  CSRF token (`x-csrf-token`) in OTP request/verify fetches (or exempt those two
  endpoints with their own token check).
- **R-038 [Medium] W-18 (= §2 W-24)** — Shared rate limiter renders HTML 429 even
  for JSON endpoints; the OTP client swallows the parse failure. Fix: return JSON
  `{ ok:false, error:'Too many requests...' }` for JSON requests.
- **R-039 [Medium] W-19** — Signup-code consume is non-atomic and runs before
  duplicate checks, so codes are double-spendable and burnable. Fix: consume
  atomically (`UPDATE ... SET uses = uses + 1 WHERE id = ? AND uses < max_uses`,
  proceed only if `changes === 1`) and run duplicate checks first.
- **R-040 [Medium] W-20** — OTP verification, TOTP backup codes, and per-code
  attempt caps are all check-then-act races. Fix: atomic consume / compare-and-swap
  on each (as R-039 does for signup codes).
- **R-041 [Medium] W-21** — `pending_review` does not terminate existing sessions;
  only `banned` does. Fix: kill sessions on transition to `pending_review` too
  (or re-check status in `loadSession`).
- **R-042 [Medium] W-22** — Captcha verification silently skips providers with no
  secret, and provider calls have no timeout. Fix: fail closed when an enabled
  provider has no secret (with admin warning); add `AbortSignal.timeout` (~5s).
- **R-043 [Medium] D-02** — Migrations are not atomic, and ALTERs have no
  `IF NOT EXISTS` (except PG v8). Fix: wrap migrations in transactions where the
  driver allows; add `IF NOT EXISTS` guards (or a migration-state table check).
- **R-044 [Medium] D-05 (= §2 D-9/D-10, corrected)** — `deposit_mode`/
  `withdrawal_mode` "auto" and `auto_approve_deposit_limit` have no effect: the mode
  IS read (`lib/money.js:57,64`) but the returned `mode` is ignored by all callers
  (`routes/player.js:192,204,235,260`), deposits deliberately never auto-approve,
  and the limit setting (`routes/admin.js:1599`) is never consumed. Fix: either wire
  auto-approval through the mode + limit (with the webhook amount/currency checks)
  or remove the dead switches from the admin UI so they stop implying otherwise.
- **R-045 [Medium] D-06** — `sms_provider` (`migrations.js:42`) and `blocked_rails`
  (`:58`) settings are never read: `lib/otp.js:48` uses env `SMS_PROVIDER`,
  `lib/rails.js:8` hardcodes EBT. Fix: read the settings (or remove them from UI).
- **R-046 [Medium] D-07** — `kyc_required`, `email_verification`,
  `mobile_verification` toggles (`routes/admin.js:1557-1559`) enforce nothing; only
  `verified_contact_required` (`lib/money.js:49`) blocks money movement. Fix: wire
  the toggles to their gates (or remove them from UI).
- **R-047 [Medium] D-08** — Phantom password settings defeat
  `password_login_enabled`: never-seeded `phone_password_enabled`/
  `email_password_enabled` (fallback `true`) always win at `routes/auth.js:106-108`,
  so `password_login_enabled='0'` cannot disable password login; OTP render
  fallback `true` (`:104-105`) vs gate fallback `false` (`:390-392`) is a latent
  mismatch. Fix: seed the toggles + make render and gate fallbacks agree.
- **R-048 [Medium] D-10 + G-15 (merged)** — Currency list admin save is unvalidated
  and unaudited: `routes/admin.js:1714-1715` allows duplicate codes and a
  `base_currency` not in the list; G-15 reports negative rates accepted with no
  audit, D-10 reports zero/negative/NaN rates coerced to 1 — the fixer must verify
  the actual coercion behaviour against code (the two reports describe it
  differently) and then: validate codes unique + rates finite > 0 + base in list,
  and audit the change with old/new values. Plus `lib/settings.js:40-46` silently
  falls back to USD-only on bad JSON. Fix: validate + audit + fail loudly (or fall
  back visibly) on bad stored JSON.
- **R-049 [Medium] D-14 (= §2 D-39..D-45, refined)** — Test gaps: PG test skipped
  without `PG_TEST_URL` (`test/pg-adapter.test.js:27-29`) and never runs `migrate()`
  on PG/MySQL; zero tests for `decideDeposit`/`decideWithdrawal`/`createDeposit`;
  no webhook amount-match handler test; no delete-row-1 audit-chain test (security
  test tampers row 2; v17 GENESIS test is single-row); `sendOtp` throwing-fake test
  still masks seed (v17 real-DB seed test now partially covers it). Fix: add the
  missing tests (this round's regression tests cover part of this; the PG/MySQL
  migrate test needs a live PG/MySQL or a documented skip reason).
- **R-050 [Medium] G-06** — Block/unblock does not restore the prior status:
  `pending_review` → blocked → unblocked lands `active` without ever passing
  review. Fix: restore the pre-ban status on unblock.
- **R-051 [Medium] G-07** — Agent float funding has no agent/existence check at
  all. Fix: verify the agent exists and is active before funding; audit the funding.
- **R-052 [Medium] G-08** — Maker-checker "already queued" swallows a DIFFERENT
  decision. Fix: key the queue check by (action + target + amount), not action
  alone; surface the conflicting queued item.
- **R-053 [Medium] G-09** — Approval rejection (and direct deposit rejection)
  notifies nobody. Fix: notify the requester (and the player for player-visible
  items) on rejection, or surface rejected approvals on the dashboard.
- **R-054 [Medium] G-10** — Admin TOTP disable is password-only; TOTP
  confirm/disable have no rate limit. Fix: require a current TOTP (or backup) code
  for admin TOTP disable + per-user rate limit on confirm/disable.
- **R-055 [Medium] G-11** — Unguarded `JSON.parse` crashes the dashboard, tickets
  list, and ticket report (`routes/admin.js:100,282,1107` vs guarded ticket detail
  `:297`). Fix: try/catch (skip corrupt rows) as the detail page does.
- **R-056 [Medium] G-12** — Body-parsing crashes on user biodata save and page
  create/edit (`routes/admin.js:463,1424,1442` — unguarded `.trim()`/
  `.toUpperCase()` on possibly-missing fields). Fix: coerce `String(... || '')`
  first; 400 on empty required fields.
- **R-057 [Medium] G-13** — User biodata save: unvalidated `kyc_status`,
  unvalidated `agent_id`, misleading audit on refused email. Fix: whitelist
  `kyc_status`, verify `agent_id` exists/is an agent, audit the refusal honestly.
- **R-058 [Medium] G-14 + D-16 (merged)** — Economy settings POST has no validation
  at all (`routes/admin.js:1655-1666` stores raw, unvalidated strings). Fix:
  validate numeric economy fields (finite, sane ranges) before save; reject garbage
  with an error instead of storing it.
- **R-059 [Medium] G-16** — Prize-table POST silently rewrites bad input to ×5 and
  writes every row. Fix: reject non-numeric multiplier inputs with an error; write
  only changed rows (or at least validate all rows first).
- **R-060 [Medium] G-17** — Risk POST silently clamps the payout lock outside its
  own label. Fix: clamp visibly (flash the applied value) or reject out-of-range
  input with the valid range shown.
- **R-061 [Medium] G-18** — Business report: unbounded date range × 5 queries/day,
  hardcoded USD, mixed-currency sums. Fix: cap the date range, convert (or split)
  by currency, paginate.
- **R-062 [Medium] G-19** — Support priority filter runs AFTER the LIMIT and the
  tabs drop each other's filter. Fix: filter in SQL before LIMIT; preserve filters
  across tabs.
- **R-063 [Medium] G-20** — Bulk notification send is unbounded, synchronous, and
  unvalidated. Fix: cap recipients per send, validate subject/message server-side,
  and queue (or background) the send.
- **R-064 [Medium] G-21 + M-21 (merged)** — Scratch series creation validation gaps
  (route + engine): `routes/scratch.js:245` currency only uppercased/stripped, never
  whitelisted (bogus-currency series can launch but never sell); `:247` inventory
  silently clamped (`Math.max(1, Math.min(1000000, ...))` — garbage becomes 1);
  `:252` tier labels truncated at the second colon (`100:5:Win:Big` → `Win`); engine
  `lib/scratch.js:130-137` `launchSeries` accepts negative tiers (prize pool/RTP
  distorted; negative quantity silently ignored) and unbounded inventory (1M outcome
  rows in one txn). Fix: whitelist currency, reject non-positive/non-integer counts,
  split tier lines on the first two colons only, reject negative amounts/quantities
  in `launchSeries`, cap total_tickets.
- **R-065 [Medium] G-22 (= §2 G-44)** — Scratch stop logs the full server seed in
  plaintext (`routes/scratch.js:296`); no verification flow consumes the series seed.
  Fix: stop logging the seed (log only its hash, if anything).
- **R-066 [Medium] G-23** — `scratch_events` is write-only: no reader anywhere in
  the panel. Fix: mirror series actions into `audit.log` and/or add a
  scratch-events viewer.
- **R-067 [Medium] G-24** — Scratch toggle flips `enabled` regardless of status, so
  "Enable" on a stopped series does nothing visible. Fix: refuse toggle on
  stopped/draft series with a clear message (or make toggle set status).
- **R-068 [Medium] G-25** — Agent transfer POST does not enforce the active-player
  rule its own UI shows. Fix: enforce the same active-player check server-side.
- **R-069 [Medium] G-26** — Agent panel N+1 queries (agents list, agent players,
  dashboard exposure). Fix: single GROUP BY queries.
- **R-070 [Medium] G-27** — User/agent detail truncation with no view-all path
  (txs 15, logins 10, tickets 10). Fix: "View all" links to each list pre-filtered
  to the user.
- **R-071 [Medium] P-01 (= §2 P-6)** — Lottery buys debit ONLY the base-currency
  wallet (`routes/player.js:70,:23,:95`); `convertMinor` has zero callers
  (`lib/util.js:107` export only). A EUR-funded player sees $0.00 and cannot play
  lottery at all. Fix: debit the wallet matching the ticket's currency (or convert
  at the configured rate with the fee shown). Note: this overlaps R-022's currency
  theme but is a distinct buy-path defect — keep separate.
- **R-072 [Medium] P-02** — Lottery buy re-checks draw status inside the txn but NOT
  `close_at` (`routes/player.js:86-88`); since the `ensure_draws` job runs hourly
  (`lib/migrations.js:125`, seeded active), buys succeed for up to ~60 minutes after
  every draw close. Fix: re-check `close_at` (and `scheduled_at` window) inside the
  buy txn.
- **R-073 [Medium] P-03** — No per-draw / per-user stake cap and no rate limit on
  lottery buy (`routes/player.js:30`; contrast scratch buy 10/min,
  `routes/scratch.js:107-109`). Unlimited tickets per draw; one ticket alone can be
  $2,100 at defaults (15 pops × $10 × 14 draws). Fix: per-draw per-player stake cap
  + buy rate limit mirroring scratch.

## LOW (51)

- **R-074 [Low] M-12 (= §2 P-14)** — `settleDueDraws` has NO ORDER BY at all;
  referral release orders by `created_at` with no id tiebreaker. Fix: `ORDER BY
  scheduled_at, id` (draws) and `ORDER BY created_at, id` (referral release).
- **R-075 [Low] M-13** — Settlement audit row is not part of the settlement
  transaction on Postgres/MySQL, and audit failures are swallowed. Fix: include the
  audit write in the txn (or write it before commit with a failure path that does
  not silently drop it).
- **R-076 [Low] M-14** — `postLedger` `balance_after` can be wrong under
  concurrency; first-post wallet creation races on its PK. Fix: compute
  `balance_after` inside the same locked txn; use INSERT OR IGNORE / upsert for
  wallet creation.
- **R-077 [Low] M-15** — `createDeposit`/`createWithdrawal` have no engine-level
  amount validation (routes validate, engine trusts). Fix: validate amount finite,
  integer minor, > 0 at engine entry.
- **R-078 [Low] M-16 + P-06 (merged)** — Scratch buy never re-checks series
  status/enabled inside the transaction (stop race; lottery buy does re-check
  draws, scratch does not). Fix: re-check series status inside the buy txn.
- **R-079 [Low] M-17 (= §2 M-42, corrected)** — `convertMinor` is dead code
  (zero callers) and fails open on missing/zero rates. Correction: the old
  "hardcoded rate" claim was NOT confirmed — the formula uses settings rates.
  Fix: either wire it properly (rate parameter + currency validation + callers)
  or delete it so no future caller trusts it.
- **R-080 [Low] M-19 + G-33 (merged)** — Test-draw override is silently clamped
  and garbage input becomes NaN (engine), while test-draw creation accepts
  unvalidated dates/times/override numbers (admin route). Fix: validate dates,
  times, and override numbers at creation; reject (don't clamp) garbage overrides.
- **R-081 [Low] M-20** — `ensureUpcomingDraws` silently coerces bad settings and
  aborts its loop on a duplicate-draw race. Fix: validate settings loudly; catch
  the duplicate race per-draw and continue.
- **R-082 [Low] M-22** — `responsibleStatus` swallows pending-limit errors and
  proceeds with stale limits. Fix: surface the error (or fail the limit read
  closed) instead of proceeding on stale data.
- **R-083 [Low] M-24** — All money math assumes 100 minor units per major unit,
  for every currency (breaks zero-decimal currencies). Fix: per-currency minor-unit
  table (JPY etc. = 1) used by `toMinor`/formatting.
- **R-084 [Low] M-25 + W-29 (merged)** — Webhook verification falls back to
  non-signing secrets (`lib/rails.js:131-137`: `webhook_secret || api_token ||
  secret_key`) and silently HMACs an empty body when the body was already
  JSON-parsed; a `decryptField` failure is caught and the credential becomes `''`,
  then falls back the same way (`routes/webhooks.js:50-53`); credential-key
  validation accepts any 32-byte base64 incl. all-zero/low-entropy keys
  (`lib/credentials.js:17-24`, base64 silently ignores invalid chars). Fail-closed,
  but outages look like provider failures and misconfiguration is invisible. Fix:
  accept only `webhook_secret` as a signing secret (distinct error when absent);
  throw a distinct error when the raw body is unavailable; reject weak keys at
  configuration; audit-log decrypt failures instead of substituting silently.
- **R-085 [Low] M-26** — DB adapter inconsistencies: MySQL pool has no timeouts;
  SQLite path is CWD-relative; MySQL port is unparsed. Fix: timeouts on the MySQL
  pool, absolute SQLite path resolution, parsed port.
- **R-086 [Low] M-27** — Commission settlement reuses one ledger `refId`
  (`'COM'+now()`) across currencies and same-millisecond settles. Fix: unique
  refId per commission row (include commission id + currency).
- **R-087 [Low] M-28** — Referral release checks deposit/wagering without a
  currency filter, while credits carry a currency. Fix: filter the release check
  by the credit's currency.
- **R-088 [Low] W-23** — Terms acceptance is checked but never recorded (no
  `terms_accepted_at`; audit details are `{ email }` / `{}`). Fix: record
  `terms_accepted_at` on register + profile completion, include in audit detail.
- **R-089 [Low] W-24** — Breached-password check fails open by design
  (documented, but a real hole: any HIBP outage/timeout lets breached passwords
  pass silently). Fix: log failures server-side + surface a persistent admin
  warning when the check has recently failed.
- **R-090 [Low] W-25** — Webhook endpoint has no rate limit, and dedup is
  check-then-insert with a global `event_id` scope. Fix: per-IP rate limit on
  webhooks; dedup scoped per provider/method (or unique constraint + insert-or-ignore).
- **R-091 [Low] W-26** — Forgot-password has no captcha; reset POST has no rate
  limit at all. Fix: captcha on forgot + rate limit on reset POST (as login has).
- **R-092 [Low] W-27** — Phone password login breaks without JavaScript. Fix: make
  the phone-login path work without JS (or degrade with a clear message).
- **R-093 [Low] W-28** — OTP and signup codes are stored as unsalted fast hashes
  (SHA-256) vs scrypt passwords. Fix: hash OTP/signup codes with a slow KDF (or at
  least a per-code salt + pepper), as passwords are.
- **R-094 [Low] W-30** — Successful TOTP logins are never written to
  `login_history`. Fix: log TOTP successes like password successes.
- **R-095 [Low] W-31** — Email-verification token is burned before the duplicate
  check. (Distinct from R-014 pending-rows: this is consume-before-check ordering
  inside verify-email.) Fix: duplicate-check first, consume only on success.
- **R-096 [Low] W-32** — Facebook OAuth creates an account with an empty email
  (no-email permission case; second such user hits UNIQUE). Fix: refuse Facebook
  signup without an email, or use a unique unroutable placeholder as OTP flow does.
- **R-097 [Low] D-03** — Version-number gap (v9 missing) and v10 repair is
  exact-match only. Fix: document the gap; make the v10 repair tolerant (or renumber
  cleanly with a comment) so future repairs don't silently miss variants.
- **R-098 [Low] D-09** — Settings cache is module-global, unkeyed, and returns a
  shared object (5s TTL; direct DB writes need a >5s wait before probing — and a
  caller mutating the returned object corrupts the cache). Fix: return a copy per
  caller (or freeze); key the cache if multi-tenant use ever arrives.
- **R-099 [Low] D-11** — Seeded currency rates are stale and decorative (EUR 0.92 /
  INR 83.5, no updater) and all 13 seeded rails are USD-only. Fix: mark seeded
  rates as placeholders requiring operator update, or add a rate updater; note the
  USD-only rails in admin.
- **R-100 [Low] D-12** — `.env` loader is cwd-relative (`server.js:12-22`), and the
  referenced `.env.example` does not exist (despite `README-DEPLOY.md:18,74`); no
  `.gitignore`. Fix: resolve `.env` relative to the app root; add `.env.example`
  and `.gitignore`.
- **R-101 [Low] D-13** — Docs are stale in ways that mislead the operator:
  threat-model "plaintext with warning" contradicts fail-closed
  `lib/credentials.js:35-38`; cPanel-first README omitting `pg`. Fix: update docs
  to the fail-closed behaviour and the Render-first deployment.
- **R-102 [Low] D-15** — Seed never heals tampered or corrupted rows (insert-only).
  Fix: heal known-bad seed rows on boot (at least the §2 D-31 false claims) or
  document that seed repair is manual.
- **R-103 [Low] G-28** — Phantom-success writes (no existence/changes check,
  success flashed anyway) on matrix, revoke-sessions, method delete, pages delete.
  (Different handlers from B-191.) Fix: check existence/affected rows before
  flashing/auditing.
- **R-104 [Low] G-29** — Audit-detail gaps on money-adjacent writes (detail `{}` or
  missing audit entirely). Fix: record old/new values on every money-adjacent
  admin write. (The currencies instance is covered by R-048; this item covers the
  remaining writes.)
- **R-105 [Low] G-30** — Draws list capped at 60 with no pagination; settled history
  silently disappears. Fix: paginate (pageOf + total).
- **R-106 [Low] G-31** — Users-list badge counts disagree with the list filter for
  NULL verification flags. Fix: make badges and filter use the same predicate.
- **R-107 [Low] G-32** — Deposit/withdrawal strips and report totals sum across
  currencies. Fix: split totals by currency (or convert at configured rates with
  the rate shown).
- **R-108 [Low] G-34** — Scratch series detail returns 200 for a nonexistent series.
  Fix: `res.status(404)` for not-found, as other admin paths do.
- **R-109 [Low] G-35** — Login-history search is email-only (IP is the key fraud
  signal but unfilterable); reports tabs have no pagination or totals. Fix: extend
  search to IP (and user name); paginate reports with totals.
- **R-110 [Low] G-36 + D-17 (merged)** — Duplicate `google_oauth_enabled` toggle
  row (`routes/admin.js:1562,1572`) + settings with no admin UI
  (`upcoming_draw_days`, `admin_path`). Fix: dedupe the toggle row; add UI for the
  orphan settings (or remove them).
- **R-111 [Low] G-37** — Page status unvalidated (any string storable), sort column
  dead (always 0, no edit path). Fix: whitelist `['published','draft']`; default
  sort to max+1 + reorder control (or order by name honestly).
- **R-112 [Low] G-38** — Method/payment-field validation holes left beside the
  round-1 rate/percent fix. Fix: validate the remaining method fields (min/max
  ordering, currency code, charges) at create/edit — see source report §G-38.
- **R-113 [Low] P-07** — Withdrawal OTP-verify step does not re-check the global /
  per-user withdrawal policy (`routes/player.js:320-342`). Fix: re-check policy
  (mode, limits, verified contact) at OTP-verify, not just at OTP-request.
- **R-114 [Low] P-08** — No balance check before the withdrawal OTP step:
  insufficient-balance failures surface only after the code is verified. Fix: check
  balance (amount + fee ≤ balance) before issuing the OTP.
- **R-115 [Low] P-09** — Withdrawal/deposit payout details (bank details, wallet
  addresses) are stored as plaintext JSON (`lib/money.js:94,:148`). Fix: encrypt
  payout details with the credentials key (or store only last-4 + reference).
- **R-116 [Low] P-10** — Deposit/withdrawal custom-field ("proof") values have no
  per-field length cap; verified there is NO file upload at all (no multer), so no
  allowlist surface exists. Fix: cap proof/custom-field text server-side (e.g. 2000
  chars); do not add an upload path without an allowlist.
- **R-117 [Low] P-11** — Player-route error paths echo raw error messages, which
  can include DB driver text (`routes/player.js:133,230,315,348`). Fix: generic
  user-facing messages; log details server-side only.
- **R-118 [Low] P-12** — Homepage/API stats mix currencies into one number, and
  recent-win formatting hardcodes USD (`routes/site.js:21,:27-28`;
  `routes/agent.js:22-29`). Fix: split by currency (or convert + label); format
  wins in their own currency.
- **R-119 [Low] P-13** — Results page has no pagination or filter, and result rows
  do not link to their fairness proof (`routes/site.js:70-72`). Fix: paginate +
  filter; link each row to its fairness/verify page.
- **R-120 [Low] P-14** — Countdown sticks at "Closing…" forever with no resync; a
  stale playslip can still submit (`public/app.js:198-213`). Fix: resync with the
  server every minute; disable submit past close (server already enforces — see
  R-072 for the close_at gap).
- **R-121 [Low] P-15** — Session cookie maxAge and DB session TTL disagree (units
  are all correct milliseconds; the lifetimes are not aligned:
  `lib/auth.js:8,:35-37` vs `routes/auth.js:19,:176,:203`). Fix: single TTL
  constant used by cookie and DB row.
- **R-122 [Low] P-16** — No logged-in password-change route; the only password
  changes are logged-out reset and forced reset. Fix: add an authenticated
  password-change route (with breached check + session revocation per R-123).
- **R-123 [Low] P-17** — TOTP disable and backup-code regeneration do not revoke
  other sessions (`routes/player.js:481-508` vs force-reset `:445` which does).
  Fix: revoke other sessions on TOTP disable/backup regen (keep current), with a
  notice.
- **R-124 [Low] P-18** — Referral and agent commissions accrue with no
  referrer/agent status check (banned referrers/agents still earn,
  `routes/player.js:108-121`). Fix: skip accrual for banned (and pending_review,
  if policy says so) referrers/agents; audit the skip.

## Appendix A — Needs-check (NOT counted, NOT to be fixed this round)
From the five reports (kept out of the tally by the auditors): XFF/trust-proxy
spoofability (W NC-1); Google `verified_email` absence (W NC-2); 00-prefix SMS
delivery (W NC-3); per-rail webhook HMAC formats (W NC-4 / D NC-1); PG config
precedence (M-29); MySQL FOR UPDATE semantics (P NC-1); live NODE_ENV value
(P NC-3 — decides whether R-015 bites); rails seeded kind `both` (D NC-2, product
decision); claim-route admin override (G NC-1); Postgres `LOWER(detail)` behaviour
in audit search (G NC-5); nested-transaction driver semantics; SQLite busy_timeout
under multi-process deployment; pending-without-main-row path; getRail
case-sensitivity; beacon timeout / legacy modulo bias; reCAPTCHA v3 score/hostname;
Facebook email-verification guarantee; already-logged-in OAuth TOTP-stash
interaction; D-01 not live-tested against a real MySQL instance (DDL comparison
only); licence-claim truth (no licence doc in repo); current FX values; banned
users' pending money items auto-reject (policy call); Gold Rush resurrection only
via direct DB row deletion (no UI delete exists); `ensure_draws` job status (R-072
assumes it stays active); whether the session limit was ever promised as enforced.

## Appendix B — §2 corrections (do NOT treat these as bugs)
- **P-41 SESSION_SECRET "dead": dead by design** — zero code references;
  README-DEPLOY says not required; sessions are opaque DB IDs. NOT a bug.
- **P-39 Gold Rush re-seed: fixed for all UI actions** — server respects a stopped
  series; no UI delete exists. Only direct DB row deletion resurrects. NOT a live bug.
- **P-40 scratch nonce leak: does NOT leak** — `routes/scratch.js:92` nulls the nonce
  pre-reveal. NOT a bug.
- **M-42 convertMinor "hardcoded rate": NOT confirmed** — formula uses settings
  rates. Remaining defect is dead + fail-open (R-079).
- **D-9/D-10 dead settings: corrected** — mode IS read but ignored by callers (R-044).
- **Maintenance re-check inside buy: NOT needed** — maintenance gate covers all
  methods before routers (`server.js:306-329`). NOT a bug.
- **Lottery loss limit, lockSuffix, settle guards, per-draw try/catch, OTP seeds,
  OAuth gate, round-1 19 old Critical/High: verified intact** in the fix copy —
  NOT re-reported.
- **P-14 ORDER BY: still missing** — covered by R-074 (not by the fixed try/catch).
- **P-10/M-35 window: still server-local midnight in both loss windows** vs UTC
  withdrawal caps — covered by R-019.

## Fix-round instructions (for the fixer)
Fix R-001..R-124 in the fix copy only. Minimal, behavior-preserving fixes. Record
every fix with file:line in FIX-LOG.md (append; do not overwrite round-1 entries).
Add regression tests under test/ for money/security fixes (R-001, R-004..R-008,
R-015, R-017..R-019, R-022, R-025, R-030, R-036..R-040, R-084, R-115). Verify with
`node --test test/*.test.js` until green (0 fail; 1 Postgres skip expected) + the
boot smoke in the task brief. Do NOT zip, push, or deploy.
