# RED TEAM REPORT — Cash Pop Lottery Platform

**Scope:** hostile testing of the production fix-copy snapshot (`~/workspace/cash-pop-fix/` as copied 2026-10-28) on a throwaway copy (`~/workspace/cash-pop-redteam/`, port 3299, temp SQLite DB, seeded admin + test players/agent/staff created by me). No production code was edited. All balances/DB states below are from the throwaway DB.

**Method:** live curl attacks with cookie jars + CSRF tokens scraped like a real client, parallel-request races, DB state verification after every attack, and file:line code proof where a live test was impossible.

**Headline:** 45 attacks — **1 BROKEN, 4 PARTIAL, 40 HELD.** The one real break is TOTP code replay (RT-01). The money engine, admin stealth/RBAC/maker-checker, scratch fairness and support ownership all held under live fire.

---

## 1. AUTH

### RT-01 — TOTP code replay (same code completes two separate logins) — **BROKEN, Medium**
- **Target:** `POST /login` TOTP step (`routes/auth.js:138-170`), `verifyTotp` (`lib/auth.js:113-121`).
- **Attack:** Enroll TOTP on player p1. At a fresh step boundary generate code `816359`. Password-login → pre-auth session #1 → submit code → `302 → /`, `/wallet 200`. Logout. Password-login → pre-auth session #2 → submit the **same** code `816359` → `302 → /`, `/wallet 200`.
- **Evidence:** both logins fully succeeded within the code's validity window; there is no last-used-counter/step tracking anywhere in the login handler — `verifyTotp` accepts any code in the ±1-step window any number of times.
- **Impact:** a TOTP code is not one-time. Anyone who captures a code (shoulder-surf, screenshot, phishing page) plus the password can replay it for ~90 seconds; also defeats the "possession" proof on the second login. RFC 6238 §5.2 / OWASP require rejecting re-used codes.
- **Fix direction:** record the last accepted TOTP counter per user and reject codes at or below it.

### RT-02 — Pre-auth (pending-TOTP) session abuse — HELD
- Password-only login for the TOTP user returns the Two-Factor page (200) and a user_id-0 pre-auth session. With that cookie: `GET /wallet → 302 /login`, `/profile → 302 /login`, `/support → 302 /login`, `/agent → 302 /login`, admin path → 404. Wrong code → "Invalid authenticator code", no session upgrade. Code proof: `lib/auth.js:170-186` (loadSession grants no `req.user` for user_id 0 or `pre_auth` sessions — the R-001 fix is real).

### RT-03 — Backup-code reuse — HELD
- Backup code `02F8-B366` completed login #1 (`302 → /`, `/wallet 200`). Same code at login #2 → 200 re-render "Invalid authenticator code", `/wallet 302`. The CAS consume (`routes/auth.js` R-040 guarded UPDATE) works.

### RT-04 — Session fixation — HELD
- Pre-login sid `871fa7ba…` vs post-login sid `cb62cf3e…`: rotated at `finishLogin`, and the old session row is deleted (`SELECT COUNT(*) FROM sessions WHERE id='<pre>'` = 0). Planting a foreign sid also fails CSRF (403).

### RT-05 — Password-reset token parallel double-consume — **PARTIAL, Low**
- **Target:** `POST /reset/:token` (`routes/auth.js:380-406`).
- **Attack:** Request a reset for p3, take the token from the delivered email, fire **two parallel** POSTs with different new passwords (`P3NewPass#A1`, `P3NewPass#A2`). **Both returned `302 → /login`.** Afterwards only `A2` (last writer) logs in (`302 → /`); `A1` fails. Token ends `used=1`.
- **Why only Low:** sequential reuse is correctly rejected (RT-06) and exploiting the race requires already possessing the valid token — but the consume is not CAS-guarded (`UPDATE password_resets SET used=1 WHERE id=?` with no `AND used=0`/changes check, unlike the backup-code path), so single-use semantics fail under concurrency.
- **Fix direction:** claim the token with a guarded UPDATE + changes check before changing the password.

### RT-06 — Reset token sequential reuse / lifecycle — HELD
- After a successful reset, `GET /reset/<same token>` → 400 "invalid or expired". Tokens are stored SHA-256-hashed, 1-hour expiry, issuing a new token burns prior unused ones, a successful reset burns all outstanding tokens and destroys all sessions (`routes/auth.js:359-406`).

### RT-07 — OAuth state/CSRF forgery — HELD
- `GET /auth/google/callback?state=deadbeef&code=fake` → 400. `GET /auth/facebook/callback?state=deadbeef&code=fake` → 400. State is stored even for anonymous starts, strictly compared, and single-use (`routes/auth.js:567-712`).

### RT-08 — Email-OTP login does not bypass TOTP/staff/status gates — HELD
- Enabled `email_otp_enabled`, requested a code for TOTP-enrolled p1 (code delivered to the mail sink), verified → `403 {"ok":false,"error":"This account has two-factor authentication enabled. Please sign in with your password."}` and no session (`/wallet → 302 /login`). Control: p2 (no TOTP) logged in by code alone, as designed. Staff/banned/pending refusals are explicit in `routes/auth.js` OTP-verify handler.

### RT-09 — Complete-profile gate bypass — HELD
- Set p2 `profile_completed=0` with a live session: `GET /wallet` and `GET /support` → `302 /login/complete-profile`; `POST /play/buy`, `POST /support/new`, `POST /deposit/new` → `403 {"ok":false,"error":"Please complete your profile first."}`; zero tickets/tickets/deposits created. Gate is server-side per-request (`server.js:380-396`), GET and POST both covered.

### RT-10 — Login brute force: rate limit + per-account lockout — HELD
- 35 wrong-password POSTs for p3: attempts 1-16 → `200 "Invalid credentials."` (message never changes when the per-account 10-failure lockout engages — no enumeration signal), attempt 17 → `429 "Too many requests"` (IP limiter 30/15 min incl. earlier test logins). `loginLimiter` (`routes/auth.js:121`) + login_history lockout both fire.

### RT-11 — OAuth sign-in bypassing banned/pending/TOTP status — HELD (code-verified; live OAuth not testable)
- Both callbacks run `oauthAccountCheck` (`lib/auth.js`) **before** any account mutation: banned and pending_review refused, TOTP-enrolled accounts are pushed into the same pre-auth TOTP step as password login; Google additionally refuses `verified_email=false` profiles. **Not live-tested:** no real Google/Facebook app credentials exist in this environment, so the provider round-trip itself could not be exercised — the callbacks' internal gates are code-proven only.

---

## 2. MONEY

### RT-12 — Lottery buy parameter tampering — HELD
- `POST /play/buy` with `wager=300` (not an offered option), `wager=-100`, `wager=0`, `pops=0`, `pops=16`, `pops=-5` → all `400`, no tickets, balance unchanged. `num_draws=999` clamps to 7 and charges exactly `1 pop × $1 × 7 draws = $7.00` (20000 → 19300). Wager whitelist is server-side (`routes/player.js:35-53`).

### RT-13 — Lottery buy race (parallel overdraw) — HELD
- Balance $193.00; three **parallel** buys of $140 each (14 draws × $10): exactly one `302`, two `400`. Final balance $53.00, never negative; ticket totals reconcile to the cent (Σ tickets = 14700 incl. the earlier $7 buy). Debit is inside the transaction with an in-txn draw re-check.

### RT-14 — Buy after draw close — HELD
- Set all DAY draws' `close_at` to the past (simulating the cron-gap window): `POST /play/buy draw_type=DAY` → `400 "Not enough upcoming DAY draws available."`, balance unchanged. Draw selection filters `close_at > now()` and re-checks inside the purchase transaction (R-072).

### RT-15 — Deposit double-approve (parallel) — HELD
- $50 manual-crypto deposit; two **parallel** admin approve POSTs → both 302, but wallet credited exactly once (5300 → 10300), exactly one `deposit` ledger row, status `approved`. Guarded transition + changes check (`lib/money.js` decideDeposit).

### RT-16 — Deposit decision state machine — HELD
- approve on approved → no-op; revoke on approved → balance back to 5300, status `revoked`; second revoke → no-op; approve after revoke → no-op. No sequence produced a double credit or a stuck state.

### RT-17 — Withdrawal amount tampering — HELD
- `POST /withdraw/new` with `amount=-50`, `0`, `0.001`, `99999` (over balance) → all `400`; zero withdrawal rows created; balance untouched. Engine re-validates with `Number.isSafeInteger(amountMinor) || amountMinor <= 0` (`lib/money.js` createWithdrawal).

### RT-18 — Withdrawal OTP parallel double-verify — HELD
- Wrong code → `400 "Wrong code. Try again."` Two **parallel** verify POSTs with the correct code → one `302 → /wallet`, one `400`; exactly **one** withdrawal created and the hold applied exactly once (5300 → 3300). Atomic attempt-increment + claim in `lib/otp.js` verifyOtp (R-040).

### RT-19 — Withdrawal decide / mark-paid lifecycle — HELD
- approve → approved; approve again → no-op; reject after approve → no-op; `mark-paid` **without** `provider_payout_id` → refused (stays approved); mark-paid with ID → `paid`, ID stored; revoke after **paid** → no-op (status stays `paid`, balance stays 4300 — no refund-after-payout double money). Reject path releases the full hold (verified on the first withdrawal: revoked/released balances reconcile exactly).

### RT-20 — Payout-detail lock triggered by a REJECTED attempt — **PARTIAL, Low**
- **Target:** `routes/player.js:339-341` + `lib/money.js` checkWithdrawalRules/notePayoutDetails.
- **Repro:** W1 created with payout address `bc1qpayoutaddr`. A new withdrawal attempt with a **different** address is correctly blocked (400, 48h lock message) — **but the handler still records the new fingerprint + lock timestamp** (`if (ruleCheck.changeDetected) await notePayoutDetails(..., true)` runs before the error return). Afterwards even the **original** address is unusable for 48h: withdrawing with `bc1qpayoutaddr` → `400 "Payout details were changed recently…"`. I had to age `payout_updated_at` in the DB to continue testing.
- **Impact:** one mistaken (or malicious, via a hijacked session) *rejected* attempt permanently replaces the stored payout fingerprint and locks all withdrawals for 48h — the lock should arguably start only when changed details are actually used/verified, and at minimum the UI copy ("changed recently") is wrong for a change that never took effect.
- **Fix direction:** record the fingerprint/timestamp only after the OTP-verified creation succeeds, or keep the previous fingerprint restorable during the lock.

### RT-21 — Currency-switch balance manipulation — HELD
- `POST /play/buy currency=EUR` with a $0 EUR wallet → `400`, no EUR wallet created, no ticket, USD balance untouched. Buys settle only in a wallet the player actually holds funds in (R-071 logic + postLedger balance check).

### RT-22 — Referral self-farming / double credit — HELD
- Enabled referrals (5%): referred player p3's $1 ticket created exactly one `referral_credits` row (5 minor = 5% of stake, status `pending`); it released exactly once, with a proper `referral_commission` ledger row, only after the referee actually wagered. Referred-by is fixed at registration, credits are CAS-released and capped per referee; farming requires real stakes from real funded accounts (device/IP sharing is flagged via `fraud.flag` audit rows, 5 generated during testing).

---

## 3. SUPPORT (user-reported breakage — independently reproduced)

### RT-23 — Ticket lifecycle end-to-end — HELD in this snapshot (user report NOT reproduced)
- As a player: `POST /support/new` → `302 → /support/SMVRS0MCF1C5A9B`; ticket page 200 shows the message. **Player reply** (the reported "page not found") → `302 → /support/<id>`, message persisted. Admin list shows the ticket; admin opens it (200), sees the player reply; admin reply → 302, ticket status → `answered`; player sees the staff reply. Every form action in `views/support.ejs` / `views/support_view.ejs` and the admin `ui.formHtml` targets matches a registered route (`/support/new`, `/support/:publicId/reply|close|reopen` in both routers).
- **Honest caveat:** this snapshot of the fix copy already contains DS-025/DS-026/DS-061 support work (audit rows `support.create`/`support.reply` fire). The breakage the user hit on the live v17.1 build does not exist in this code — I could not test the deployed build from here.

### RT-24 — Support ticket IDOR — HELD
- Player p2: `GET /support/<p1's public_id>` → 404; `POST /support/<id>/reply` → 302 to own list and **zero** injected rows in `support_messages`. All player queries are scoped `WHERE public_id = ? AND user_id = ?`.

### RT-25 — Stored XSS via ticket subject/body — HELD
- Subject `<script>alert(1)</script>`, body `<img src=x onerror=alert(2)>`: admin list renders `&lt;script&gt;alert(1)` (raw payload count 0), player list likewise escaped.

### RT-26 — Agents cannot see or be assigned support tickets — **PARTIAL (functional gap)**
- Support tickets reach **admins only**. Evidence: `support_tickets` schema has no assignee column; `grep -i assign` over admin/agent routes + lib finds no ticket-assignment code; the agent panel (`routes/agent.js`) exposes only players/transfer/commissions; `GET /agent/support` → 404; agent navigation contains no support entry. If the operator workflow expects agents to work tickets (as the user described), that path simply does not exist — tickets will pile up on admins. Not a security flaw; a missing feature relative to the stated expectation.

---

## 4. ADMIN

### RT-27 — Admin stealth (existence leak) — HELD
- Anon, player and agent sessions: `GET /ops-7f3a9c-console/`, `/users`, `/support` → **404**, response body byte-identical to a genuinely nonexistent page (diff-verified modulo tokens). Player `POST /users/1/block` at the admin path → 404. Guessed `/admin` → 404. Probes are written to `audit_log` as `admin.probe` (10 rows from this session).

### RT-28 — Privilege escalation player/agent → admin — HELD
- Covered by RT-27 (stealth 404 before any role check) plus the second-layer `requireRole('admin')`. Agent hitting admin paths after its forced password reset → still 404 on every admin route probed.

### RT-29 — RBAC sub-role enforcement — HELD
- Created a `support`-role admin (full admin login, panel readable). Its POSTs: deposit approve → **403**, balance adjust → **403**, user block → **403** ("does not permit this action"); the target deposit stayed `pending`, balances unchanged. Views are readable by staff; money/risk actions enforce `lib/rbac.js`.

### RT-30 — Maker-checker self-approval bypass — HELD
- Set `maker_checker_threshold=1000` ($10). Super admin's approve of a $30 deposit did **not** execute: deposit stayed `pending`, `pending_approvals` row #1 opened, no credit. The **same** admin POSTing `/approvals/1/approve` → refused (row stayed `open`, still no credit). Support-role admin → 403. A **second** super admin approved it → deposit `approved`, player credited exactly 3000.

### RT-31 — Audit-log coverage — HELD
- `audit_log` contains rows for every sensitive action exercised: `admin.probe`, `deposit.approve/revoke`, `withdrawal.approve/revoke/mark_paid`, `user.balance_adjust`, `support.create/reply`, `ticket.buy`, `agent.create`, `method.toggle`, `user.totp_enable`, `user.forced_reset_done`, `user.login_as`, `reconcile.run`, `fraud.flag`. No silent money or support actions found.

### RT-32 — Impersonation (login-as) — HELD (by design, audited)
- Admin `POST /users/3/login-as` → session acting as p2 (`/wallet 200` as p2), session data carries `impersonated_by`, banner data is wired, and `audit_log` records `user.login_as` actor=1 entity=3. Full-power by design; the audit trail is the control.

### RT-33 — "Dead" settings toggles — HELD (all three live-verified working)
- `registration_enabled=0` → `POST /register` 403 "Registration is currently disabled", no user created; restored → works.
- `maintenance_mode=1` → anon `GET /` 503 maintenance page, `/login` still 200, logged-in admin unaffected; off → 200.
- `admin_totp_required=1` (the old B-175 dead toggle) → unenrolled admins are force-redirected to the panel security/enroll page (reachable, 200), all other panel pages redirect there too, players unaffected; toggle off restores access. Enforcement derives from the live `totp_secret` (`server.js:361-372`).

---

## 5. INFO LEAKS

### RT-34 — Blocked-user reason leak (the user's exact complaint) — HELD
- Set p2 `deposit_blocked=1, withdrawal_blocked=1`: `GET /deposit/new` and `GET /withdraw/new` → 403 with the **neutral** text "Deposits/Withdrawals are unavailable right now. Please try again later or contact support." — identical to the global-off message; the player cannot tell they were individually blocked (DS-013/DS-038 neutral reasons in `lib/money.js` policies).

### RT-35 — Residual operator-state wording — **PARTIAL, Low**
- `GET /auth/google` (unconfigured) → 503: *"Google sign-in is not configured yet. **The operator needs to add the Google OAuth credentials.**"* — tells any visitor exactly which operator credential is missing. (Facebook's equivalent says only "not configured yet".)
- `views/deposit_new.ejs:38` / `views/withdraw_new.ejs:39`: *"The operator has not enabled any deposit/withdrawal method yet"* — reveals operator configuration state to players when no method is enabled.
- `GET /api/stats` (public) returns the exact registered-player count (`{"players":3,…}`) — aggregate, but it is live business data served to anonymous visitors.
- `views/maintenance.ejs` tells visitors an admin panel exists behind `/login` (already the documented admin entry point — negligible).

### RT-36 — Error pages / stack traces — HELD
- Nonexistent page → generic 404, no paths/stack. Malformed JSON body to `POST /login` → generic 500 page "Something went wrong. The team has been notified." with zero `SyntaxError`/stack content (cosmetic note: a 400 would be more correct than 500). Forged reset/verify tokens → generic 400s.

---

## 6. GAMES

### RT-37 — Scratch pre-reveal outcome leak — HELD
- Bought Gold Rush ticket `SMVRS8ANJFDA90803`: ticket page and `/scratch/ticket/<id>/verify` show **only** the SHA-256 commitment; `scratch_tickets.prize` is NULL until reveal; verify page states the prize and nonce stay hidden until reveal. No outcome data in HTML/JSON (the DB outcome row is only joinable with DB access).

### RT-38 — Scratch reveal double-credit / replay — HELD
- Winning ticket (prize 500): reveal → balance 3300 → 3800, exactly one credit; second reveal POST → 302, balance unchanged, status stays `revealed`. Losing ticket reveal credited 0 and closed the ticket.

### RT-39 — Scratch ticket IDOR — HELD
- p2 on p1's scratch ticket: `GET /scratch/ticket/<id>` → 404, `GET …/verify` → 404, `POST …/reveal` → 400, no state change.

### RT-40 — Scratch parallel-buy outcome double-claim — HELD
- Six parallel buys: 6 tickets issued, exactly 600 charged, and `SELECT outcome_id … GROUP BY outcome_id HAVING COUNT(*)>1` = 0 rows — no pre-generated outcome was sold twice. (Sequential burst buying also reconciles: 9 tickets = 9 charges when the rate limiter cut the rest.)

### RT-41 — Fairness/results unsettled-data leak — HELD
- Today's draws are `scheduled` with `winning_number` NULL in the DB; `/results` shows "No results yet"; `/fairness` exposes only the commit–reveal verification form for settled draws; `/api/stats` `paid_out` is aggregate-only. No endpoint served an unsettled winning number or seed.

### RT-42 — Lottery ticket IDOR — HELD
- p1 `GET /ticket/<p3's public_id>` → 404; anonymous → 302 to login.

---

## 7. MISC

### RT-43 — Webhook forgery — HELD
- `POST /webhooks/crypto` with an unsigned junk payload → **401**; no deposit created or approved (approved-deposit count unchanged). `POST /webhooks/stripe` → 404 (no such rail slug registered — only the crypto rail was probeable to its signature check; I did not fuzz every rail slug).

### RT-44 — Agent float transfer abuse — HELD
- Agent with **no float wallet** POSTs `/agent/transfer` of $100 to p1 → redirected with an error; agent still has no wallet, p1's balance moved only by an unrelated, legitimate referral release (+5, ledger-verified). Agents act strictly as themselves (`routes/agent.js` agentId; `?as=` honoured only for super admins).

### RT-45 — CSRF token absence on state-changing routes — HELD
- `POST /play/buy` without `_csrf` → 403 "Security token mismatch"; JSON auth endpoints without the token → 403 (the real client sends `x-csrf-token`). Global CSRF middleware covers player, auth and admin POSTs (admin attempts die even earlier at stealth).

---

## Not tested / limits
- **Live OAuth round-trips** (Google/Facebook): no provider app credentials in this environment; callback internals code-verified only (RT-11).
- **Postgres/MySQL drivers:** all live tests ran on SQLite (the production driver's `FOR UPDATE` paths differ; guarded-transition logic is driver-agnostic in code but not re-proven here).
- **Deployed v17.1 build:** not reachable from this sandbox; RT-23's caveat applies — findings describe the fix-copy snapshot, which already contains the DS-round support fixes.
- **Webhook rails other than `crypto`:** slug probing only.
