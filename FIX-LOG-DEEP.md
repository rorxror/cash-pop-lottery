# FIX-LOG-DEEP — DeepSeek Round (v18)

Scope: exhaustive audit + fix + E2E-verification pass over the whole platform.
Worked ONLY in `~/workspace/cash-pop-fix/`. Nothing pushed, nothing deployed.
Compiled list: `audits/deepseek-round/COMPILED.md` (audits A–F on disk beside it).

## Counts

- Audits: 6 areas, 83 raw findings → **81 compiled items DS-001…DS-081**
  (Critical 3, High 11, Medium 29, Low 37, Config 1). 2 raw findings were
  duplicates merged during compilation (B-05+F-02 → DS-014; F-transactions → DS-017).
- **Fixed: 78** · **Skipped with reason: 2** (DS-060, DS-080) · **User-side config: 1** (DS-081)
- No regressions of R-001…R-124 found by the audits (one defect, C-06/DS-024,
  lived inside R-073's stake-cap math and is fixed).
- Unit suite: **55 tests — 54 pass, 0 fail, 1 skipped** (Postgres adapter; no PG in this env — same as v17 baseline).

## Fixed items (per DS number)

Critical
- DS-001 Support reply 404: player reply form posted to `/support/<id>` instead of `/support/<id>/reply` (support_view.ejs). Fixed; E2E-proven 302.
- DS-002 BOTH-ticket cancel refunded 2×: refund basis is now the draw's actual entry count (lib/draws.js + admin drawEntrySums). E2E-proven: exactly $1 of a $2 BOTH ticket refunded.
- DS-003 Admin table links white-on-white (1.00:1): `.adm .tbl a` now #0057b8.

High
- DS-004 2FA backup codes unusable: login field maxlength 8→16; useBackupCode normalises spaces/hyphens and re-hyphenates. E2E-proven (displayed XXXX-XXXX format logs in; single-use enforced).
- DS-005 Gateway deposit page showed no receiving details: RECEIVING_FIELDS + getReceivingDetails() (decrypts only public receiving fields, never password-type); deposit page renders them + QR image. Display activates once credentials are saved (needs CREDENTIAL_ENCRYPTION_KEY — see user-side list).
- DS-006 Gateway rails carried fake "you will be redirected…" instructions: defaults rewritten as honest manual-review text + migration v12 heals existing rows that still carry the exact old strings.
- DS-007 Withdrawal OTP went to a dead `@phone.local` address for phone-only accounts: real-email channel selection in both /withdraw/new and /withdraw/verify.
- DS-008 Self-excluded / cooling-off players could still deposit: deposit GET+POST enforce enforceAccountPlayable.
- DS-009 Closed-ticket reply form hidden by status check: reply form shows unless status is closed.
- DS-010 Agents never saw support tickets: new agent support section (list/detail/reply) scoped by users.agent_id join; E2E-proven incl. cross-agent 404 isolation.
- DS-011 Gateway credentials page readable by every staff role: super-only gate on GET /methods/:id/credentials. E2E-proven (finance 403, super 200).
- DS-012 Maker-checker solo deadlock: threshold save refused when fewer than 2 approver-capable staff exist. E2E-proven both directions.
- DS-013/DS-038 Operator-internal policy reasons leaked to players ("deposits are disabled by the operator", "ask support to mark you verified"): neutral player wording everywhere; internal codes kept server-side.

Medium (29)
- DS-014 Min/max limits displayed ÷100 wrong on deposit/withdraw/wallet (major-unit attrs + conditional "No limits" text).
- DS-015 OAuth fetches had no timeout: AbortSignal.timeout(8000) on all 4 provider fetches.
- DS-016 Withdraw charge preview treated major units as minor and mislabelled the result: converts ×100, clamps, "you will receive" wording.
- DS-017 Transactions showed numeric ids, wrong signs, raw type strings: public ref_id, plain sign, friendly labels incl. bonus.
- DS-018 daily_deposit_limit existed nowhere: setting + responsible-play field + enforcement per currency/UTC day in POST /deposit/new.
- DS-019 deposit_bonus_percent was inert: decideDeposit credits floor(net × pct/100) as a 'bonus' ledger entry on approve and claws back on revoke; admin economy field added.
- DS-020 Ticket status badges derived from the wrong field: badges now from ticket status + won entries.
- DS-021 Fairness page showed false MISMATCH for test draws and hid cancelled draws: fairnessForDraw returns explicit states (settled/test_override/cancelled), verify page renders each honestly + a notFound card.
- DS-022 /play hardcoded USD: slip, prices and prize header use the selected play currency.
- DS-023 Bundle discount keyed on the wrong count + invisible in the slip: server keys on numDraws; slip shows "− X% bundle discount applied".
- DS-024 Per-draw stake cap computed on whole-ticket totals (defect inside R-073's math): per-draw stake share summed per draw.
- DS-025 Tickets reached nobody: create now audit-logs and emails the configured support_notify_email (new setting + admin field).
- DS-026 Replies unaudited + staff replies recorded as generic 'admin': audit rows added; actual staff role recorded.
- DS-027 Dead notification templates wired: sms/otp text now comes from the admin template in sendOtp; lottery + scratch wins attempt email/sms/push 'win' templates (every attempt lands in the outbox log). Remaining spare: email/otp signup template — signup codes are operator-issued by design (otp_registration), so it has no send path.
- DS-028 Announcements were settings text with no reader: migration v12 table + admin CRUD (Notifications tab) + player /announcements page + menu link. E2E-proven.
- DS-029 No contact page existed: /contact form → contact_messages (v12) → admin inbox with handled toggle. E2E-proven.
- DS-030–DS-033, DS-062–DS-065 Contrast batch (style.css): tab colours/active inversion, invisible plain .btn, danger buttons/badges, .pos/.neg, .b-info/.ball-sm, #86868b labels → #5f6368, sidebar active, primary gradient deep stop — all to ≥4.5:1 (values in audit-E table).
- DS-034 Admin draw IDs now link to the draw detail in all three draw tables.
- DS-035 Maintenance page invited "operators" to sign in — line removed.
- DS-036 Empty method lists blamed the operator: neutral "No payment methods are available right now…" (seen live in E2E before methods were enabled).
- DS-037 OAuth 503 text named the provider toggle: neutral "sign-in is unavailable right now".
- DS-039 Privacy page was placeholder text: real policy text seeded + heal for installs still carrying the placeholder marker.
- DS-040 OTP-verify endpoint leaked account state (staff/banned/pending/2FA distinctions): one generic refusal.
- DS-041 Homepage paid-out figure hardcoded '$': uses the base currency's symbol end-to-end.

Low (37)
- DS-042 Winners ticker lost the win currency (now selected + displayed).
- DS-043 Homepage claims ("Instant Payouts", "Secure & Licensed") replaced with accurate text (instant win credits; provably fair).
- DS-044 OAuth-only accounts (no password) can now SET a password from Security (was treated as a change requiring the nonexistent current one).
- DS-045/DS-046 Login POST re-render dropped facebookOn/phone toggles; register lacked social buttons: render locals completed.
- DS-047 Password field stayed visible on the TOTP step: hidden when totpRequired (seen in E2E markup).
- DS-048 FIX-LOG.md documented wrong env names: corrected to GOOGLE_CLIENT_SECRET / FACEBOOK_APP_SECRET.
- DS-049 Complete-profile sign-out was a GET link (broken by POST-only logout): POST form with CSRF.
- DS-050 No rate limit on deposit creation: added (10/min/user).
- DS-051 Wallet pending lists showed decided rows: filtered to status='pending'.
- DS-052 Referral earnings: scratch purchases now accrue referral credits like lottery (release logic already counted them), and /profile shows per-currency pending/released/capped totals.
- DS-053 Daily loss limit was per-game (doubling by switching games): combinedDailyNetLoss across lottery + scratch in both enforcers. NOTE: test v17b's message regex updated to the unified wording (enforcement unchanged, verified by the same test).
- DS-054 Wallet hid the base currency when empty: zero row shown.
- DS-055 Withdrawal verify page had no resend/cancel: POST /withdraw/verify/resend + /cancel routes + buttons (routes proven live; happy path proven with SMTP sink — see E2E).
- DS-056 ensureUpcomingDraws revived draws whose close time had passed: skipped.
- DS-057 (with DS-021) cancelled/test draw fairness states.
- DS-058 /tickets and /scratch/my-tickets now paginate (25/page + pager).
- DS-059 Draw dates ignored the configured timezone: engine computes draw dates/close times in site_timezone (Intl), admin test-draw passes it, and the setting is editable in admin (validated IANA).
- DS-061 Players can close/reopen their own tickets (routes + buttons). E2E-proven.
- DS-066 Deposits/withdrawals lists filter by player, method and date range (composes with status tabs; pagination preserves filters). E2E-proven via q= search.
- DS-067 Dead captcha 'difficulty' field removed from extension config.
- DS-068 Three INFORMATIONAL-ONLY toggles (kyc_required / email_verification / mobile_verification) removed from the settings UI.
- DS-069 Approvals RBAC: risk role can decide draw.* approvals; money approvals stay finance/super (rbac route widened + handler-level domain split).
- DS-070 sms_provider had no admin UI: select added to site settings (code precedence env > setting is the documented R-045 design).
- DS-071 Per-row gold primary buttons in admin queues demoted to secondary style (one primary per view).
- DS-072 Remaining operator-flavoured player strings neutralised ("Phone/Email sign-in is unavailable right now.", "Registration is currently closed.").
- DS-073 Scratch lobby empty state: honest "No scratch cards are on sale right now…".
- DS-074 Profile page "(operator setting)"/"(when enabled by the operator)" wording removed.
- DS-075 TEST draws leaked into homepage results + /results: is_test = 0 filters; 'TEST' removed from the results type filter.
- DS-076 Scratch reveal errors echoed engine text to players: generic player message, real error server-logged.
- DS-077 Nav active state read a settings key instead of the request path: uses the currentPath local.
- DS-078 fb-root div sat inside <head>: moved to body start.
- DS-079 /favicon.ico returned the HTML 404 page: real favicon.svg + favicon.ico shipped (E2E: 200).

## Skipped (2) — with reasons

- DS-060 Ticket file attachments: no upload/storage infrastructure exists; bolting on file upload (storage, scanning, serving) is a security project of its own, not a wiring fix. Not built.
- DS-080 Viewport zoom-lock: NO CHANGE by the user's explicit standing demand (zero zoom behaviour is a product decision the user owns).

## User-side (1 compiled + operational list)

- DS-081 OAuth go-live is configuration, not code: create Google/Facebook apps,
  set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET and FACEBOOK_APP_ID/FACEBOOK_APP_SECRET,
  set BASE_URL to the public URL, and register the redirect URIs
  (`<BASE_URL>/auth/google/callback`, `<BASE_URL>/auth/facebook/callback`) in the
  provider consoles. Code path traced + unconfigured behaviour E2E-proven.
- CREDENTIAL_ENCRYPTION_KEY must be set before gateway credentials can be saved
  (the app fails closed without it — by design). Once set, DS-005's receiving
  details (account number / wallet address / QR) display on the deposit page.
- SMTP (SMTP_HOST/PORT/USER/PASS/FROM) for email delivery — without it, OTP
  email and notifications log to the outbox as skipped/failed and
  OTP-gated flows fail closed with a clear message (proven in E2E).
- Twilio/TextBelt keys for SMS OTP + win SMS.
- A push provider (FCM/APNs) still needs plugging into lib/notify.js sendPush —
  attempts are wired and logged; delivery needs provider credentials.
- Payment methods ship disabled: enable each rail in admin after configuring it.

## E2E evidence (fix copy, port 3320, fresh SQLite, curl + cookie jars + CSRF)

Boot: admin seeded from env, Gold Rush scratch series seeded, healthz 200.

- Stealth/public: GET / 200 (no balance UI logged out) · /admin 404 · admin path 404 logged out · /favicon.ico 200 · /contact 200 · /auth/google 503 + /auth/facebook 503 with neutral text · with google toggle ON but no credentials: login shows no Google button, route still 503.
- Auth: register 302 → logged in (name in header) · /login/complete-profile 302 (already complete) · admin login 302 → panel, dashboard 200.
- 2FA (headline): POST /security/totp/start → secret; confirm with computed TOTP → 8 backup codes shown, secret stored · logout · password login → TOTP challenge (password field hidden) · wrong code 000000 rejected, not logged in · valid TOTP → 302 home, logged in · backup code in displayed XXXX-XXXX format → 302 logged in · same code re-use rejected (single-use).
- Money: deposit page shows DS-014 limits in major units ("Min $1.00 · Max $10,000.00") · POST deposit $50 + reference → 302, pending · admin DS-066 filter q=player1 finds it · approve → wallet $50.00 · transactions show "Deposit <public_id> +$50.00" (DS-017).
- Lottery: POST /play/buy BOTH pop 5 @ $1 → ticket $2.00, wallet $48 · admin cancels DAY draw → wallet $49.00 exactly (DS-002), DAY entry refunded, EVE entry pending · EVE draw settled when overdue → winning 13, entry lost, fairness page verdict MATCH (hash recompute) · test-draw early settle correctly refused ("Draw has not closed yet").
- Scratch: buy Gold Rush $1 → wallet −$1 · reveal → status revealed, predetermined prize $0, page shows commitment hash · transactions list all four movements with running balances.
- Support (headline): player creates ticket → admin list shows it, audit support.create logged · agent (player's agent) list/detail 200, reply 302, author_role 'agent' · other agent gets 404 + empty list · admin reply recorded with staff role · player sees both replies · **player reply POST → 302 (NOT 404)** and is visible · player close → closed, reopen → open (DS-061).
- Admin RBAC/settings: DS-012 refusal flash with 1 approver ("Maker-checker needs at least TWO…", nothing saved), save succeeds after adding finance staff · DS-011 credentials page: finance 403, super 200.
- Withdrawal: with no provider configured, POST /withdraw/new fails closed (503 "Could not send the verification code", no row, balance untouched). With a local SMTP sink: code delivered by email (template-rendered), POST /withdraw/verify → pending · admin approve → approved · mark-paid → paid · balance $48 → $38.
- Announcements/contact: admin creates announcement → player /announcements 200 shows it · public POST /contact → 302, admin inbox shows it, mark-handled flips handled=1.
- Sweeps: player post-login 16/16 pages 200 · admin 22/22 pages 200.
- E2E caught and fixed two defects in this round's own new code before delivery:
  announcements/contact routes used column names (is_active, user_id) that the
  v12 migration doesn't define — aligned to the migration (active; no user_id)
  and re-proven. Also completed DS-020: status badges in tickets.ejs/ticket.ejs
  were HTML-escaped (`<%=` → `<%-`).

## Suite

`node --test test/*.test.js` → 55 tests, 54 pass, 0 fail, 1 skipped (PG adapter).
One fixture updated: v17b R-018/R-019 message regex (DS-053 wording unification).

---

# APPENDIX — ADVERSARIAL VERIFICATION (owner protocol)

## Disprove pass (different agent per area, against the PRE-FIX baseline `cash-pop-push/`)
Each Phase-1 finding was attacked by an agent whose job was to kill it (guard
hunt + live repro on the baseline). Survivors are confirmed real.

| Area | Survives | Disproven | Notes |
|---|---|---|---|
| A (auth) | 12 | 0 | Set includes F-sourced DS-037/040/072; 8 of 12 live/unit-reproduced on the baseline |
| B (money) | 9 | 0 | 3 live-reproduced (502-fingerprint leak, extension save 404, ratio leak); 1 live 500 proved as a consequence chain (CSV export) |
| C (games) | 11 | 0 | Every item backed by an executable repro (counterfactual guard-removal test on DS-002/DS-024); DS-075 has TWO independent causes (is_test leak + post-login strip) |
| D (support/comms) | 10 | 0 | DS-001 live-reproduced on baseline: reply form → 404 + message lost; DS-025/026 zero audit rows on baseline; DS-028/029 survive with nuances (a static CMS page / Tawk.to extension are not built-in equivalents) |
| E (admin/design) | 27 | 0 | Contrast ratios recomputed independently at full precision (25 pairs, all failing on baseline); DS-011 proven by live route test (403/200 split reproduced) |
| F (public/leaks) | 20 | 0 | Full F set (DS-013/014/035–043/072–080); nuances on DS-043/078/040/080 mitigate but do not kill. Separately, one RAW audit-F item (pending-session merge on OAuth login, never assigned a DS number at compilation) was DISPROVEN by the prove-fix repro: no pre-auth session state exists to lose in the real flow |

**DISPROVEN findings inside the DS numbering: none.** The single kill of the
round hit a raw audit item that compilation had already excluded (see the F
row) — documented here so the tally is complete and honest.

## Independent fix verification (different agent than the author — the author of ALL fixes was the coordinator)
| Batch | Scope | Verdicts |
|---|---|---|
| verify-1 (auth) | DS-004/015/037/040/044/045/046/047/049/072 + RT-01 replay + RT-05 parallel reset race | **10 VERIFIED / 0 FAILED.** RT-01: replay of a consumed TOTP step rejected live ("Invalid authenticator code", no session), parallel duplicate loses; RT-05: 10 parallel reset POSTs → exactly 1 success. Backup codes: displayed-format login works, single-use enforced, parallel duplicate → exactly 1 session. OAuth: with toggles ON but no credentials, Google/Facebook return the neutral 503, never a credential-less provider URL. |
| verify-2 (money) | DS-005/006/007/008/013/014/016/017/018/019/036/050/051/054/055 + RT-20 full behaviour | **13 VERIFIED / 3 CODE-ONLY / 0 FAILED.** RT-20 FULL PASS live: change attempt with new details blocked once + recorded pending; retry shows "changed less than 48 hours ago"; ORIGINAL details keep working during the window (the RT-20 defect); post-window success promotes the new details. Every DS-019 grant row is type='bonus', never disguised as a win. |
| verify-3 (games/support/comms) | DS-001/002/009/010/020/021/022/023/024/025/026/027/028/029/052/053/056/057/058/061/073/075/076 + directive spot-checks | **22 VERIFIED / 1 CODE-ONLY / 0 FAILED.** No-confirm spot-check: settle + toggles complete in a single POST, no data-confirm in the served admin HTML. Everything-real spot-check: homepage counters equal live DB counts; winners ticker contains only transactions-backed wins; fake CMS heal markers are seed-only strings absent from the served homepage. DS-024 retest note: an apparent buy-3 pass was the 5s settings-cache TTL on a direct-DB write (test artefact; admin-UI writes invalidate via setSetting). |
| verify-4 (admin/design/public) | DS-003/011/012/030–035/039/041/042/043/048/059/062–071/074/077/078/079 + /admin-string audit + suite re-run | **30 VERIFIED / 4 CODE-ONLY / 0 FAILED.** All recomputed contrast pairs ≥ 4.5:1 except the one residual it flagged (public global link colour, E-08) — since FIXED by the coordinator (see below). "/admin"-string audit: the only hits in route/view code are a comment and the stealth probe-log label — NO admin URL contains "/admin". Suite independently re-run: 54 pass / 0 fail / 1 skipped. |

**Residual found by verify-4 and fixed after its pass:** public `a { color:
var(--gold-2) }` #b87a00 on white = 3.61:1 → appended override `a { color:
#8a5c00 }` = **5.81:1** (public/style.css, end of file). Class-styled
links/buttons are unaffected (element selector loses to classes).

## Competing solutions (loser + why)
- **DS-002 (BOTH-ticket refund):** (i) refund `wager × pops` per entry — wrong,
  ignores bundle discounts and multi-draw pricing; (ii) implemented:
  `ticket.total / actual entry count` with cumulative rounding — the only
  basis that returns exactly `total` across cancels (proven: BOTH $2 ticket,
  DAY cancel refunds exactly $1).
- **DS-004 (backup-code format):** (i) accept only the stored hyphenless form
  and change the display to match — breaks codes already issued on paper;
  (ii) implemented: normalize input (strip non-alphanumerics, uppercase) and
  accept both forms — old and new codes both work; single-use CAS unchanged.
- **DS-019 (deposit bonus):** percent-of-NET (implemented; matches the fee
  model — the player is bonused on what actually lands) vs percent-of-gross
  (bonuses money the player never received) vs flat-only (rejected: the
  percent setting already existed and admins use it). Grants post as
  type='bonus', clawed back on revoke in the same transaction.
- **DS-053 (combined loss limit):** (i) per-game limits (the old code) let a
  player lose 2× the limit by splitting games; (ii) transactions-only sum
  mis-counts scratch (spend/prizes are authoritative in scratch_tickets);
  (iii) implemented `combinedDailyNetLoss` — lottery net from transactions +
  scratch net from scratch_tickets, per currency/UTC day, used by both
  enforcers (live: $2 lottery + $1 scratch hits a $3 limit; the next $1 of
  either game is refused).
- **DS-003/contrast (verify-4's analysis, endorsed):** semantic rename of the
  inverted CSS variables vs appended scoped overrides. Overrides win for a
  hotfix round: the tokens are referenced pervasively (including inline
  styles generated in JS/EJS), so a rename carried high regression risk with
  no runtime proof short of re-rendering every page; the overrides are few,
  auditable, commented per-DS with old ratios, and every recomputed pair now
  passes ≥ 4.5:1. The rename remains the right FUTURE refactor, as its own
  pass with a full page sweep.
- **RT-01 (TOTP replay):** used-code hash table vs RFC 6238 §5.2 step counter.
  Counter wins: one guarded UPDATE (`totp_last_step`) claims the exact time
  step — atomic on all drivers, no table growth, covers login + enrollment
  burn; the hash table duplicates state the counter already encodes.
- **RT-20 (payout lock):** (i) note-on-success (the shipped bug: rejected
  attempts consumed the lock); (ii) note-on-block (any failed attempt starts
  the clock — griefing vector unchanged); (iii) implemented PENDING-CHANGE:
  a change attempt records `payout_pending_fingerprint` + timestamp only;
  the active fingerprint is untouched (original details keep working during
  the window); a post-window success PROMOTES the pending details. Lock
  semantics preserved, false lockout eliminated (verify-2 FULL PASS).

---

# RED-TEAM RECONCILIATION (REDTEAM.md: 45 attacks — 1 BROKEN, 4 PARTIAL, 40 HELD)
The 40 HELD results independently corroborate this round's fixes (support
lifecycle RT-23, backup-code CAS RT-03, maker-checker RT-30, stealth RT-27,
neutral wording RT-34, money races RT-13/15/18/19). Action items:

- **RT-01 BROKEN (TOTP replay in the ±1-step window) — FIXED.**
  `lib/auth.js` `verifyTotpStep()` returns the matched step counter; the
  login handler (`routes/auth.js`) claims it via a guarded UPDATE on the new
  `users.totp_last_step` column (migration v13); enrollment confirmations
  burn the setup step. Independently re-verified by verify-1 and by the
  coordinator's smoke: the same code replayed → rejected, no session.
- **RT-05 PARTIAL (reset-token parallel double-consume) — FIXED.**
  `POST /reset/:token` claims the token FIRST with a guarded
  `UPDATE … SET used=1 WHERE id=? AND used=0` + changes check, before the
  password change. Verify-1: 10 parallel POSTs → exactly 1 success.
- **RT-20 PARTIAL (payout lock consumed by REJECTED attempts) — FIXED by
  redesign** (pending-change; migration v13 columns
  `payout_pending_fingerprint`/`payout_change_at`; `lib/money.js`
  checkWithdrawalRules + `promotePayoutDetails()`; both withdraw call sites
  updated). Verify-2 FULL PASS (see above). The round's own unit test was
  rewritten to encode the new semantics.
- **RT-26 PARTIAL (agents can't see tickets) — REBUTTED.** The red-team
  snapshot predates the DS-010 fix. Current code: the agent support section
  is scoped by `users.agent_id`; coordinator E2E + verify-3 both prove the
  owning agent lists/opens/replies and a foreign agent gets 404. No assignee
  column is needed for the stated workflow.
- **RT-35 PARTIAL (residual operator wording) — REBUTTED (already neutral).**
  Google/Facebook 503 text (`routes/auth.js`) reads "…sign-in is unavailable
  right now. Please try again later."; `views/maintenance.ejs` is clean
  (DS-035); the deposit page shows the DS-036 neutral text. `/api/stats`
  returning the exact player count is BY DESIGN: the homepage hero displays
  the same real count publicly, and the user's no-fake-stats rule requires
  the real number.

---

# NO CONFIRM POPUPS IN ADMIN (user directive)
- Mechanism: ONE delegated handler (`public/app.js`) turned any
  `data-confirm` attribute into a `window.confirm()` gate.
- **Removed: 21 `data-confirm` attributes from `routes/admin.js`** (draw
  settle ×2, draw cancel, user block, reset password, revoke sessions,
  login-as, verify contact, balance adjustment, deposit
  approve/reject/revoke, withdrawal approve/reject/mark-paid/revoke,
  payment-method delete, announcement delete, page delete, approval
  approve, admin TOTP disable) **+ 2 from the scratch admin router**
  (`routes/scratch.js`: series Launch, series Stop) — **23 total**. Admin
  actions now execute on the click; CSRF, RBAC and server-side guards are
  untouched. Verify-3 spot-checked live: settle and toggles complete in a
  single POST; no `data-confirm` in served admin HTML.
- **Player-side confirms KEPT (owner's decision list, NOT removed):**
  `views/security.ejs` ×2 (Disable 2FA; Regenerate backup codes),
  `views/agent/transfer.ejs` ×1 ("Confirm this transfer?").

---

# EVERYTHING REAL, NOTHING DEMO (user directive)
Per-area evidence (grep of views/ + public/app.js + seeds, plus live checks):
- **Homepage figures** are real DB queries — independently proven equal to
  live counts (verify-3): players = `COUNT(users WHERE role='player')`, paid
  out = `SUM(transactions WHERE type IN ('win','scratch_prize'))`, winners
  ticker renders ONLY transactions-backed wins (ref_id → real ticket).
- **Seed CMS blocks are honest empty states**; the home banner "Win up to
  13X" is TRUE (max prize-table multiplier is 13). Old fakes ('250X' banner,
  'A. Player' testimonial, 'Licensed lottery operator', 'Live chat 24/7')
  survive ONLY as R-102 heal markers in `lib/migrations.js` that PURGE them
  from existing DBs on boot — they are never rendered.
- **Demo wording removed from code**: two `server.js` comments calling the
  seed a "demo" were corrected (admin seed = the env-configured operator
  account; Gold Rush = a real configured product — configured products are
  NOT demo; fabricated activity is, and there is none).
- **app.js `Math.random`** is Quick Pick (a game feature), not fake data.
- Verdict: no hardcoded stats, winners, testimonials, volumes or fake users
  exist in production code paths. If the real count is 3, the site shows 3;
  if zero, it shows an honest empty state.

---

# AUTOMATION MATRIX (user directive: "poori website apne aap handle ho")
Production reality: a single Render instance; the scheduler is IN-PROCESS
(`lib/cron.js`, started at boot from `server.js`, 60s tick, jobs stored in
`cron_jobs` and pause/resume-able in admin). Manual triggers remain only as
secured backups. Env trap checked: the server REFUSES TO BOOT without
`TICKET_HMAC_SECRET`, so the auto path cannot silently die from it.

| Process | Trigger | Status |
|---|---|---|
| Draw creation (DAY/EVE upcoming) | in-process job `ensure_draws`, every 5 min | AUTO ✔ (was 60 min — tightened) |
| Draw settlement (time trigger) | same job → `settleDueDraws` → beacon settle, winners auto-credited | AUTO ✔ |
| Draw settlement (threshold trigger) | per-purchase event check + scheduler backstop | AUTO ✔ NEW (Smart Admin) |
| Draw roll-over (unmet behaviour) | settlement pass, per operator setting | AUTO ✔ NEW |
| Scratch series lifecycle | job `scratch_lifecycle`, every 5 min (scheduled launch / end-date stop / sell-out close / auto-next) | AUTO ✔ NEW (was: manual launch/stop only; sell-out never closed) |
| Agent commissions settlement | job `settle_agent_commissions`, daily (CAS-guarded ledger settle) | AUTO ✔ NEW (was: admin button only) |
| Referral release | event-driven (deposit approval + purchase wagering checks) | AUTO ✔ |
| Bonus campaigns | signup/first-deposit events + `run_bonus_campaigns` job for scheduled drops + budget auto-stop | AUTO ✔ NEW |
| Deposit expiry (48h unproven) | job `expire_deposits`, hourly | AUTO ✔ |
| OTP / session / reset-token cleanup | jobs `clean_sessions` (hourly) + `clean_tokens` (hourly) | AUTO ✔ (clean_tokens NEW — expired codes were never cleaned) |
| Notification dispatch | job `process_notifications`, every 5 min; state-change events enqueue attempts (deposit/withdrawal decided, win, ticket reply) | AUTO ✔ |
| Ledger reconciliation | job `reconcile_ledger`, nightly; mismatches write audit + report | AUTO ✔ |
| Database backup | job `backup_db`, daily (SQLite VACUUM INTO, keep 7) | AUTO ✔ NEW (was: none). Postgres/MySQL: platform-managed (job reports so honestly) |
| Gateway deposit/withdrawal decisions | webhook → signature-verified → `decideDeposit`/`decideWithdrawal` auto-decision (red-team RT-43 proved the 401 signature gate) | AUTO ✔ when a gateway is connected (user-side credentials) |
| Manual payment methods | human decision in admin | BY DESIGN — "manual" means a person decides; NOT a gap |
| Failed runs | `cron_jobs.last_status='error'` + `cron.failed` audit row + Automation Console alerts | NO SILENT DEATH ✔ NEW |

**E2E proofs (this round):**
- *Draw settles BY ITSELF (time)*: a TEST draw created for now+2 min with
  zero further app requests settled on the scheduler's own tick (status
  scheduled → settled, winning number from the committed override; the
  `ensure_draws` job row recorded the run). Repeated for a real EVE draw in
  the Smart Admin master-switch proof (froze while OFF, settled after ON).
- *Auto notification event*: a manual-deposit approval produced
  `notifications_log` rows to the player automatically (deposit-decision
  email attempt; on the SMTP-sink instance the email was captured).
- *Boot proof*: on a fresh DB all jobs report `last_status='ok'` after the
  boot tick, and the backup job wrote a real snapshot file.

---

# SMART ADMIN — AUTOMATIC ADMIN PANEL (user build spec)
Hard line held: outcomes remain provably fair via the committed seed +
public beacon; NO per-user/per-ticket outcome control exists anywhere in
this build. Bonuses are promotional balance, ledger-labelled 'bonus', never
disguised as wins.

## A. Pop auto engine (per draw type: DAY / EVE)
- Trigger modes `time` / `threshold` / `both` (settings
  `draw_trigger_mode_day|eve`), threshold in sold entries
  (`draw_threshold_day|eve`), unmet-at-time behaviour `settle` / `roll`
  (+24h, entries carry over, `draws.rolls` counter + audit row).
- Implementation: `lib/draws.js` — `settleDueDraws` applies the mode logic;
  `checkThresholdDraws` fires at-threshold draws and is called after every
  ticket purchase (event path) and from the scheduler (backstop);
  `settleDraw` accepts a `threshold` opt that treats reaching the threshold
  as the close event — the derivation is byte-identical to a time settle.
- Auto-create respects per-type switches (`auto_draw_day|eve`) and the
  master switch; settling already-sold draws is never blocked by the
  per-type creation switch (player stakes are an obligation), only by the
  master kill switch (manual settle remains the backup).
- Wager amounts: the `wager_options` setting drives BOTH the playslip and
  buy validation (verified wired: `server.js` parse → `req.wagerOptions` →
  buy whitelist) and is editable on the Automation Console. Prize
  multipliers: the Settings → Prize Table editor writes `prize_table`,
  which `settleDraw` reads on every settle (verified wired).
- **E2E:** threshold N=2 on DAY: buy 1 → still scheduled; buy 2 → draw
  settled by itself (winning 5, seed-derived), zero admin clicks. Time mode:
  see the automation proofs above.

## B. Scratch auto
- `lib/scratch.js` `scratchLifecycle` (job every 5 min): drafts with a due
  `launch_at` launch (outcomes generated from a fresh server seed); live
  series past `ends_at` stop; sold-out series close; optional auto-next
  clones the operator's template series (fresh seed, copied tiers) and
  launches it. Series create form gained optional Auto-launch / Auto-stop
  fields (`launch_at`/`ends_at` columns on `scratch_series`).
- Prize tiers verified wired: launch builds outcomes from
  `scratch_prize_tiers` (admin-authored at create) — the E2E series launched
  with exactly its configured inventory (10 outcomes) and tier.
- **E2E:** draft with `launch_at` in the past → one scheduler tick → status
  live, enabled, 10 outcomes generated. Zero admin clicks.

## C. Bonus engine (promotional credit ONLY) — `lib/bonus.js`, migration v15
- Tables: `bonus_campaigns` (audience all/new/first_n/random_n, fixed or %
  amount, trigger signup/first_deposit/scheduled/manual, validity window,
  wagering multiplier, per-user cap, budget cap, granted_total, active) and
  `bonus_grants` (the auditable grant log: user, amount, campaign, trigger,
  wagering required vs wagered, timestamp).
- Execution: one transaction per run; grants post as ledger type 'bonus'
  with ref `bonus_campaign`; budget clamp makes the final grant partial to
  the exact remaining budget and then AUTO-STOPS the campaign (active=0 +
  audit row); per-user caps clamp repeats; random_n is chosen by the system
  (crypto shuffle of active players). Event hooks: register →
  `onSignup`; deposit approval (inside `decideDeposit`, post-commit) →
  `onFirstDeposit` (fires only when the approval is the user's first
  approved deposit). Scheduled drops run from the cron job, one drop per
  window opening (re-arm by moving starts_at).
- Wagering: purchases accrue progress (`accrueWagering` from the lottery buy
  path and scratch buyTicket); an unmet requirement blocks withdrawal in
  `checkWithdrawalRules` with a clear player message. Zero unmet = zero
  effect on normal withdrawals.
- Switches: master `bonus_enabled` + per-campaign active flags + the
  automation master gate for all non-manual runs.
- **E2E:** budget $12 / grant $5 / 3 players → grants 500+500+200, campaign
  auto-stopped at exactly 1200. Signup campaign: new player granted $2 with
  wagering_required $4 (x2); a $1 buy accrued 100 of progress.
  First-deposit 10%: $50 approval → +500 grant; balance reconciled to the
  minor (200 signup + 5000 deposit + 500 bonus = 5700). Unit tests:
  `test/smart-admin.test.js` (6 tests: budget exactness + auto-stop,
  per-user cap, first-deposit-once, wagering accrual, master freeze/resume,
  signup hook gating) — all pass.

## D. Automation Console — admin page `/automation`
Master AUTO switch; the Pop draw form (per-type switches, trigger modes,
thresholds, unmet behaviour, wager list); the Scratch auto form (auto-next
toggle + template picker); the processes table fed by live `cron_jobs`
(last run, next run, last result/message, Pause/Resume + Run now — the same
rows the scheduler writes, so the status shown IS the machine's state); a
system-health block (DB probe, beacon state + last settled draw's beacon
status, SMTP env presence, SMS provider, enabled methods + stored gateway
credentials — honest "not configured" where true); and a failure-alerts
block (jobs in error + the latest `cron.failed` audit rows).
- **E2E:** console renders 200 with all blocks; master OFF froze a due EVE
  draw across a full scheduler cycle (job forced due, draw stayed
  scheduled), master ON settled it by itself (winning 10); pausing
  `clean_sessions` from the console flipped `cron_jobs.status` to paused and
  back. RBAC: console POSTs are SUPER, bonus POSTs are MONEY.
- Scratch admin buttons also lost their `data-confirm` gates in this pass
  (2: Launch, Stop) — counted in the no-confirm section above.

## Suite after this build
61 tests: **60 pass, 0 fail, 1 skipped** (Postgres adapter). New coverage:
`test/smart-admin.test.js` (6). Full syntax sweep clean.


---

# POST-VERIFICATION CORRECTIONS (from the full worker handoffs)
Three real defects surfaced only in the verify agents' detailed reports
(the condensed handoffs hid them). All fixed + live-verified by the
coordinator on the final code:

1. **GET /scratch/responsible-play returned 500** (found by verify-2) —
   EJS compile error in `views/scratch_responsible.ejs`: a stray `<% } %>`
   where the cooling-off `if` opener was lost. PRE-EXISTING in the v17
   baseline (verified: the baseline file fails compilation identically) —
   it escaped the R-rounds and Phase 1, and the adversarial layer caught
   it. Fixed by restoring the conditional wrapper; the page now renders
   200 with the limits form, and a compile sweep of ALL views passes.
2. **Register POST error re-render dropped the social buttons** (found by
   verify-1) — `routes/auth.js` register render helper hardcoded
   `googleOn: false` and never passed `facebookOn` (the DS-045 defect
   class, on the register path; DS-046's GET fix was already correct).
   Now computes both flags like the GET. Live-verified: a failed register
   POST on a toggles-on instance re-renders with both provider buttons.
3. **"Instant Payouts" claim on the login page** (found by verify-4) —
   `views/login.ejs` branding strip claimed instant payouts while
   withdrawals are manual-review by default (DS-043's sweep missed the
   login page). Claim removed; the strip now reads "Daily Draws ·
   Provably Fair".

## Corrected adversarial tallies (full handoffs vs condensed summaries)
- Disprove sets were larger than first reported: A 12/0 · **B 18/0** ·
  **C 14/0** · D 10/0 · **E 19 items: 18 survives, 1 PARTIALLY DISPROVEN
  (DS-063, see COMPILED.md)** · F 20/0. (Sets overlap where findings were
  cross-sourced.) Net: exactly ONE partial kill in the whole round, on a
  Low-severity contrast item whose harmful half was fixed regardless.
- Verify-2's final tally: **15/15 VERIFIED + RT-20 full pass** (no
  code-only items). Verify-4's final: **31 verdicts, all VERIFIED**
  (29 DS items + the /admin-string audit + the suite re-run). Verify-1:
  9 live-verified + DS-015 code-only + RT-01/RT-05 verified. Verify-3:
  22 verified + DS-056 code-only. **Grand total across verify batches:
  zero FAILED fixes.**

## OWNER ADDENDUM — OWN-01 (found by the owner's own hands-on E2E, after the round closed)
During the owner's independent verification (fresh boot, full player/admin/agent flows run by hand), the homepage "Paid out" stat read $0.00 while the DB held a real 500-minor scratch prize. Root cause: every "prizes paid" aggregate summed only ledger type 'win' (lottery), ignoring 'scratch_prize' — so scratch payouts never counted in: routes/site.js paid-out (x2: /api/stats + homepage), the public "Recent verified winners" ticker/grid (x2), and admin wins-today / all-time prizes / business-report wins-by-day (routes/admin.js x3). The everything-real verification missed it because at its check moment both sides read 0. FIX: all 7 queries now sum type IN ('win','scratch_prize'). Verified live by the owner: /api/stats paid_out 0 -> 500, homepage Paid out $5.00, scratch winner appears in the winners grid; suite still 60 pass / 0 fail / 1 skip. Severity: Low (display truthfulness, no money impact). The v18 zip was rebuilt after this fix (new SHA in the delivery note).
Also observed by the owner (noted, not changed): notifications_log stores full email bodies, which include OTP codes for failed/sent code emails — recommend masking code-bearing bodies in a future hardening pass; codes themselves are stored hashed (login_otps) and delivery fails closed when no provider is configured (verified: 503, no code leaked to the page).
