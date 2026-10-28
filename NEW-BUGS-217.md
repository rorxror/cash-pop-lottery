# NEW BUGS ROUND 2 — STATUS: DETAILED LIST LOST, RECOVERY BY RE-AUDIT

## What happened (sach bol — read this first)

The round-2 hunt did find **217 confirmed distinct new bugs** (tally below), but the
five detailed audit reports (G/W/M/P/D) lived only in agent handoff context and were
never saved as files. When the conversation compacted, those report texts were lost.
Searches of the whole workspace, the goals mirror, /tmp, and the memory DB found no
copies (round-1 coordinator verified this and correctly refused to fabricate a list).

A reconstruction attempt from the surviving summary headlines was started in this
file and then CAUGHT AND DELETED before any use: only the headline items in §2 below
are verifiable from the surviving record. The invented G/W/M/P sections (with made-up
line numbers) were removed on 2026-10-27 ~21:00 CDT. NO code was changed on their
basis — the fix copy's code diffs are round-1 work only (verified by markers + tests).

## §1 — Surviving verified facts (from the pre-compaction summary)

- **Tally: 217 confirmed = G 52 + W 44 + M 45 + P 38 + D 38; 0 Critical, 7 High,
  70 Medium, 140 Low**, plus ~10 needs-check items (§4). 236 claims → 19 overlaps
  merged (merge map in §3). Audit areas: M = lib/money.js, draws.js, db.js,
  scratch.js, rails.js, util.js; W = routes/auth.js, routes/webhooks.js, lib/otp.js,
  lib/auth.js, breached, credentials, phone-countries data, validate; D =
  lib/migrations.js v1–v10, settings defaults, currency data, docs, test gaps, .env
  handling; G = routes/admin.js second pass + agent deep + scratch admin; P = player
  buy flow deep, site.js remaining, responsible-play enforcement, timezone/DST, error
  handling, logging.
- Baseline: v16 (commit 29591d8). Distinct from the 235 report and all older lists.

## §2 — Verified headline items (substance survives in the summary)

### Already FIXED in round 1 (verify in FIX-LOG.md, do NOT redo)
- **FOR UPDATE regression (M-5 + P-17):** SQLite rejects FOR UPDATE entirely
  (node:sqlite throws syntax error — empirically confirmed); the v16 comment claiming
  SQLite treats it as a no-op was FALSE. Consequences on live SQLite:
  settleAgentCommissions (lib/money.js:289) ALWAYS threw; releaseReferralCredits cap
  query (lib/money.js:319, SUM...FOR UPDATE) threw on SQLite AND Postgres (PG rejects
  FOR UPDATE with aggregates — also confirms the external re-audit's N-13). All 4
  callers swallowed the error. Fixed via driver-conditional locking (lockSuffix).
- **D-18:** lib/otp.js:82 sends slug `otp_login` but migrations seed only
  `['email','otp']` (migrations.js:99); withdrawal OTP defaults ON and prefers email,
  so email users hit fail-closed 503 and cannot withdraw; admin has NO template-create
  route. Fixed (seed otp_login; same audit also found email/support_reply missing).
- **W-7/W-8:** Facebook callback had NO banned/pending_review/TOTP check; Google
  callback checked only banned — banned/pending bypass + full 2FA bypass via OAuth.
  Fixed via `oauthAccountCheck`.
- **M-12:** settleDraw entry/draw UPDATEs (lib/draws.js:158,:171) had NO status guard
  and NO changes check → concurrent settle double-pays on Postgres/MySQL (SQLite safe
  via BEGIN IMMEDIATE). Fixed with guards + changes checks.
- **M-11:** settleDueDraws loop had no per-draw try/catch → one poisoned draw aborted
  the batch and starved every later draw on every tick. Fixed with per-draw try/catch.
  NOTE: P-14's ORDER BY tiebreaker note (merged into M-11) was NOT confirmed fixed in
  round 1 — re-audit must check it.
- **P-8:** lottery buy never enforced the daily loss limit (enforcement existed only in
  scratch's enforceResponsiblePlay). Fixed via enforceLotteryLossLimit in the buy txn.
- **Old 19 Critical/High from the 235 report:** B-174, B-175, B-019, B-022, B-052,
  B-053, B-070, B-096, B-097, B-105, B-124, B-130, B-133, B-135, B-158, B-166, B-176,
  B-177, B-178 — all fixed in round 1 (see FIX-LOG.md for file:line).
- **Smoke-found (B-022 scope):** views/verify.ejs showed false MISMATCH badges for
  unsettled draws (null is falsy in the old ternary) + HTML-escaped badge markup.
  Fixed (real "Not settled yet" badge).
- Round-1 verification (re-run by owner): `node --test test/*.test.js` → 28 pass /
  0 fail / 1 skipped (Postgres live round-trip, no PG_TEST_URL). Boot smoke on fresh
  SQLite port 3101 passed (home 200, register, admin login, stealth 404s, commission
  settle on SQLite, referral cap release, single settle, loss limit, OTP template).

### OPEN — verified headlines, exact locations to be re-confirmed by re-audit
- **G-35:** staff role-change dropdown has no `selected` attribute and defaults to
  'super' → saving without actively choosing PROMOTES any staffer to super.
- **G-7 + D-11:** maker-checker enforced ONLY at routes/admin.js:782 (deposit approve)
  and :867 (withdrawal approve) — balance adjust, agent float fund, commission
  settlement, and webhook auto-approvals all bypass it.
- **G-5 + W-17:** admin email-change inserts new verification rows without invalidating
  prior pending rows (A→B→C leaves the B token live to swap back).
- **G-44 + P-42:** series stop handler logs the full server seed into scratch_events
  in plaintext; no verification flow consumes the series seed.
- **W-32:** webhook amount check ignores currency (€10 can match a $10 deposit).
- **W-33:** webhook status classification uses substring regexes (`unpaid` contains
  "paid" → payment_success; `failed` → refund/revoke).
- **W-42:** COUNTRIES table missing ~50 territories (PR, GU, VI, BM, KY, etc.).
- **W-30 + D-17:** Twilio sendOtp returns sent:true without checking response status.
- **W-31 + D-16:** TextBelt without a key falls back to the public shared key `textbelt`.
- **W-4 + P-28:** login CSRF — session-less POSTs skip CSRF; login GET creates an anon
  session only when custom captcha is on (login CSRF + OTP-request abuse with captcha
  disabled; OTP JSON 403s when a session exists — see W-5).
- **W-24 + P-35:** shared login limiter renders HTML 429 even for JSON endpoints.
- **M-16 + P-15:** win-notification failure inside settle swallowed (no outbox/audit).
- **M-25 + D-22:** unknown DB_DRIVER value silently falls through to SQLite.
- **M-27 + D-23:** Postgres SSL rejectUnauthorized:false unconditional (MITM risk).
- **M-32 + P-9:** responsible-play loss check runs OUTSIDE the buy transaction.
- **M-35 + P-10:** scratch daily window local time vs UTC (up to 2x daily loss).
- **M-42 + D-20:** convertMinor dead code (zero callers), unvalidated, hardcoded rate.
- **M-43:** no draw-cancel/refund path exists anywhere.
- **P-6:** lottery buys debit ONLY the base-currency wallet; convertMinor has zero
  callers → a EUR depositor sees $0.00 play balance and cannot play lottery at all.
- **P-26 + D-24:** production HMAC guard fires only when NODE_ENV=production, but the
  start script is plain `node server.js` → fallback secret 'dev-secret-change-me'
  (repo-public) can be live.
- **P-41 + D-12:** SESSION_SECRET dead in one session-signing path.
- **P-39 + D-26:** Gold Rush re-seed on delete resurrects a deliberately deleted series.
- **D-9/D-10:** `auto_approve_deposit_limit` and `deposit_mode`/`withdrawal_mode`
  settings are never read anywhere (dead settings).
- **D-31:** seeded CMS content ships false claims live ("Win up to 250X" vs real max
  13×, fabricated testimonial, "Licensed lottery operator", "Live chat 24/7" while
  Tawk disabled).
- **D-39..D-45 test gaps:** PG round-trip skipped without PG_TEST_URL; money-transition
  core (settleDraw, decide*, releaseReferralCredits, settleAgentCommissions,
  createDeposit) has ZERO repo unit tests; webhook amount-match has no regression test;
  audit-chain test never deletes row 1 (would miss B-166); sendOtp test masks D-18 via
  a throwing fake DB.

## §3 — Merge map (applied in the original tally; re-apply on re-audit)
W-17→G-5; P-17→M-5; P-14→M-11 (keep ORDER BY note); P-10→M-35; P-42→G-44; P-9→M-32;
P-15→M-16; P-35→W-24; P-28→W-4 (keep both mechanisms); D-22→M-25; D-23→M-27;
D-24→P-26; D-12→P-41; D-16→W-31; D-17→W-30; D-26→P-39; D-11→G-7 (keep webhook aspect);
D-20→M-42. P-27 DEMOTED to needs-check (see §4).

## §4 — Needs-check appendix (NOT counted, NOT to be fixed)
G NC-1 (claim-route admin override); W NC-1 (XFF/trust-proxy exploitability,
absorbs P NC-2); W NC-2 (Google verified_email absent); W NC-3 (00-prefix SMS
delivery); W NC-4 (provider vocab); M-29 (PG config precedence); P NC-1 (MySQL
FOR UPDATE semantics); P NC-3 (live NODE_ENV value); D NC-1 (per-rail webhook HMAC
formats); D NC-2 (rails seeded kind 'both').

## §5 — Recovery plan (the only honest way to rebuild the full list)
1. Fresh re-audit of the SAME five areas against the CURRENT fix copy
   (~/workspace/cash-pop-fix, which already contains round-1 fixes).
2. Each audit agent MUST write its report to a file under
   ~/workspace/cash-pop-fix/audits/ (e.g. audit-G.md) BEFORE reporting — files
   persist, handoff context does not. The coordinator must verify the files exist
   on disk and read them from disk.
3. Exclude: every item in ~/workspace/your_files/cash-pop-lottery/cash-pop-bug-audit-235.md
   (B-001..B-235) and every fix recorded in FIX-LOG.md (round 1).
4. Compile the new verified list (fresh numbering is fine — do NOT reuse N-numbers
   unless the item matches a §2 headline exactly), then fix, test
   (`node --test test/*.test.js` until green), boot-smoke, and report per-item
   status with file:line. Do NOT zip, push, or deploy.
