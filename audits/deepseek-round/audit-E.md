# Audit E — Admin Panel Depth + Design (AUDIT-ONLY, no code edits)
Date: 2026-10-28 · Codebase: ~/workspace/cash-pop-fix/ · Port 3315, fresh DB
Method: static trace of routes/admin.js (2478 lines), lib/admin-ui.js, lib/rbac.js, lib/settings.js, lib/credentials.js, lib/flags.js + live curl click-through as seeded admin. Stealth 404 for non-admin = BY DESIGN, not a bug. No per-user outcome-rigging or KYC recommendations (hard exclusion).

## Findings (written as found)

## Route enumeration (live, seeded admin, fresh DB, port 3315)
All 27 admin GET routes returned 200: `/` (dashboard), /draws, /tickets, /scratch (scratch adminRouter), /users, /otp, /agents, /deposits, /withdrawals, /approvals, /reconciliation, /flags, /methods, /methods/new, /reports, /support, /extensions, /notifications, /pages, /pages/new, /cron, /login-history, /referrals, /staff, /security, /settings, /audit. Detail routes verified live where data existed (/users/2, /methods/2/credentials, /approvals). Non-admin → plain 404 stealth: by design, not a bug. No admin GET route 500s on a fresh DB.

---

### E-01 [Critical · DESIGN] Admin table links are WHITE on white — invisible
- Evidence: `public/style.css:11` `--navy-800: #ffffff` (light-theme token remap) vs `public/style.css:578` `.adm .tbl a { color: var(--navy-800); font-weight: 600; }`. No later override exists (grep: only occurrence). Computed contrast #ffffff on #ffffff = **1.00:1**.
- Repro/trace: every `ui.table()` link inside the admin panel inherits this: ticket public-ID links (routes/admin.js:386), fraud-flag user links (admin.js:2337), any table-cell anchor. Row backgrounds are white / near-white alt rows.
- Impact: clickable IDs/links in admin tables are literally invisible — operators cannot see or reliably click ticket drill-downs. This is one root of the user's "buttons blend / stay too light" complaint, in its worst form.

### E-02 [High · CODE-BUG] Gateway credentials page is readable by EVERY staff role — decrypted secrets exposed to support/risk staff
- Evidence: `lib/rbac.js:44` `if (method === 'GET') return true;` (all views readable by all roles) + `routes/admin.js:1285-1305` GET /methods/:id/credentials decrypts stored credentials via `decryptField` and renders non-password fields as form values.
- Live proof: created staff `sup@test.local` with role **support**; inserted a legacy plaintext credential (`publishable_key = pk_live_VISIBLE_KEY_123`, field_enc=0) for method 2; support login → GET credentials page returned **200 with the key value in the HTML**. Control check: the same support session POST /users/2/block correctly got 403, so action RBAC works — only the secret-bearing VIEW leaks. Text/textarea credential fields across rails include wallet addresses, UPI IDs, merchant IDs, publishable keys (lib/rails.js credentialFields); any future text-typed secret leaks the same way.
- Impact: the lowest-privilege staff account can read payment-gateway credentials. The RBAC premise "views are harmless, control lives on actions" is false for this one view.

### E-03 [High · CODE-BUG] Maker-checker deadlocks for a single-admin operator — queued money actions can NEVER be decided, with no warning
- Evidence: `routes/admin.js:986` maybeMakerChecker queues at/above `maker_checker_threshold`; `routes/admin.js:2224,2276` requester is refused ("You cannot approve your own request"); deposit/withdrawal detail pages hide their action buttons while any approval is open (admin.js:941,1061).
- Live proof: fresh DB has exactly **1** admin. Set threshold to $1.00 (POST /settings/risk → 302), POST /users/2/adjust $5.00 → flash "queued for a second approver", pending_approvals #1 open; POST /approvals/1/approve as the same (only) admin → "cannot approve your own request — a different admin must approve." No second approver exists, nothing in Settings warns that enabling the threshold with <2 staff strands every large deposit/withdrawal/adjustment, and the queued item's own page offers no path forward.
- Impact: a solo operator (this user) who enables maker-checker bricks large money movements until they happen to invent a second staff account. Needs at minimum a hard warning/block at threshold-save time when fewer than 2 admins exist.

### E-04 [Medium · DESIGN] Filter/status tabs: 2.77:1 — grey text on a dark-navy pill that reads as broken
- Evidence: `public/style.css:1491-1493` `.tab { background: var(--white); color: var(--ink-soft); }` — `--white` is remapped to #17203a (dark navy), `--ink-soft` is #5b657f → **2.77:1 FAIL**. `.tab.active` flips to `--navy-800` = #ffffff background, i.e. the ACTIVE tab is a plain white pill while inactive tabs are dark — inverted emphasis. No `.adm .tab` override exists.
- Used on: Users filter tabs, Deposits/Withdrawals moneyTabs, Reports tabs, Support tabs, Notifications tabs, Pages tabs (admin.js moneyTabs:902, users:472, reports:1345, support:1450, notifications:1565, pages:1749). The count chip inside an active tab (gold-2 on gold-soft) is 3.07:1, also FAIL.

### E-05 [Medium · DESIGN] Plain `.btn` has NO background and NO visible border — most admin action buttons render as bare bold text
- Evidence: `public/style.css:135-147` `.btn { border: 1px solid transparent; }` with no background; only `.btn-p` (gold) and `.btn-d` (red) variants carry a fill, `.btn-g` is repaired only by a much later rich-layer rule. Dozens of admin controls use plain `btn`/`btn btn-sm`: Manage, Edit, Credentials, Filter, Run now, Pause/Resume, Detail, Review, Mark reviewed, Change role, Reset password, Revoke sessions, Back links, Settle now (draws list).
- Impact: on white admin cards these buttons are indistinguishable from bold body text — precisely the user's complaint that "some buttons stay too light / colours blend into each other." Fails the Apple standard the project follows (a button must read as a button; persistent, visible affordance).

### E-06 [Medium · DESIGN] Danger buttons/badges: dark-navy text on red = 4.28:1 FAIL
- Evidence: `public/style.css:153` `.btn-d { background: var(--danger); color: var(--white); }` and `:171` `.b-err` same pair. `--danger` = #ef4444, `--white` = #17203a → **4.28:1**, below WCAG AA 4.5:1 for 12–14px bold text.
- Affected: Reject / Revoke / Cancel & refund / Delete method / Delete page / Block / Disable authenticator buttons and every red status badge (banned, rejected, failed, high priority).

### E-07 [Medium · DESIGN] Positive/negative money amounts in admin tables: 2.28:1 and 3.76:1 FAIL
- Evidence: `public/style.css:416-417` and `:1510-1511` `.pos { color: var(--success) }` (#22c55e on white = **2.28:1**), `.neg { color: var(--danger) }` (#ef4444 on white = **3.76:1**). Used for profit figures (dashboard, admin.js:175), transaction amounts (user detail, reports). 15px bold is still "normal text" under WCAG (large = ≥18.66px bold), so 4.5:1 applies.

### E-08 [Low · DESIGN] Info badges, winning-ball chips and inline links: gold-2 on white = 3.61:1 FAIL
- Evidence: `.b-info` (style.css:173, #b87a00 on #ffffff), `.ball-sm` (:1496, same pair), global `a { color: var(--gold-2) }` (:100, same pair on white) → **3.61:1**. Affects scheduled/answered badges, winning-number chips on the dashboard/draws, and admin inline links not caught by E-01.

### E-09 [Low · DESIGN] Admin table headers and KPI labels: #86868b on white = 3.62:1 FAIL
- Evidence: style.css:1024 `.adm table th { color: #86868b }` (13px uppercase), :1037 `.adm .kpi .l { color: #86868b }` (12px uppercase), plus `.share-v`/`.daybar-d` 13px in the same grey. All **3.62:1** < 4.5:1.

### E-10 [Low · DESIGN] Sidebar active item: Apple blue on its own tint = 3.78:1 FAIL
- Evidence: style.css:993 `.adm-side nav a.active { background: rgba(0,113,227,0.1); color: #0071e3; }` over the light sidebar → composite ≈ #dce8f5 vs #0071e3 = **3.78:1** for 15px medium text. The current-page indicator — the one nav label that must be most legible — is below AA.

### E-11 [Low · DESIGN] Primary (gold) button gradient fails at its dark end: 3.60:1
- Evidence: style.css rich layer `.btn-p { background: linear-gradient(135deg, #f7c948, var(--gold) 48%, var(--gold-deep)); color: var(--navy-ink) }`. Text #1b2340 vs light stop #f7c948 = 9.85:1 PASS, vs mid #d9940d = 6.02:1 PASS, vs deep stop #a86e00 = **3.60:1 FAIL** — the bottom-right of every primary button (Approve & credit, Save, Send, Create…) dips below AA.

### E-12 [Medium · CODE-BUG] Draw detail page is an orphan — no clickable path reaches it
- Evidence: GET /draws/:id (routes/admin.js:304) renders draw P&L + per-ticket winner breakdown, but grep of all admin/scratch routes finds **zero** hrefs to it (only settle/cancel POST form actions in the draws list, admin.js:253-258), and live-fetched /draws HTML contains no `draws/<id>` link. The ID column is plain text.
- Impact: a whole detail feature (winner breakdown, sold-vs-paid per draw) exists but is unreachable except by hand-typing the URL — "feature whose inner view is missing" in reverse: the view exists, the door doesn't.

### E-13 [Low · CODE-BUG] Deposits/Withdrawals lists have no inner filters — status tabs only
- Evidence: routes/admin.js:905 (deposits) and :1030 (withdrawals) accept only `?status=`; no player-email search, method filter, or date range, unlike Tickets (q+status), Users (q+tabs), Reports (date+q) and Login History (q/IP/success/date). On a busy money queue an operator cannot find one player's deposit from the list page and must detour through Reports.

### E-14 [Low · CODE-BUG] Dead inner control: custom-captcha "Difficulty" field is consumed by nothing
- Evidence: `lib/extensions.js:36` defines `{ key: 'difficulty', options: ['easy','medium'] }` for custom_captcha; grep for `difficulty` across lib/routes/server/views finds no reader. Saving easy vs medium changes nothing in captcha generation (routes/auth.js:40 only checks extEnabled). All other extension fields verified wired (recaptcha/hcaptcha/turnstile site+secret, GA tracking_id in views/layout.ejs:11, tawkto embed :135, fb_comments app flow, CSP allow-list server.js:296-298).

### E-15 [Low · DESIGN] Three Settings toggles still flip with zero effect (disclosed, not hidden)
- Evidence: `kyc_required`, `email_verification`, `mobile_verification` (TOGGLES, routes/admin.js:1949-1951) have **no consumer anywhere** (grep: only the toggle list + migrations seed). This is R-046, closed in FIX-LOG as "fixed by relabel": the UI now honestly says "INFORMATIONAL ONLY — enforces nothing." Not a regression and not deceptive anymore — but three dead switches remain in System Configuration, against the project's own standing rule that every toggle must actually work when flipped. Recommendation: remove them from the toggle card (the Verified-contact gate below them is the real control).

### E-16 [Low · CODE-BUG] Approvals RBAC is money-only: risk staff can queue draw settlements but can never second-approve anything
- Evidence: `lib/rbac.js:14` `['POST', /^\/approvals\/\d+\/(approve|reject)$/, MONEY]` — only super+finance may decide ANY approval, including `draw.settle`/`draw.cancel` (requested by risk, rbac.js:26) and `balance.adjust`. A finance approver thus second-approves draw settlements (a risk-domain action) while a risk approver is locked out of their own domain's queue. Combined with E-03, the effective approver pool is smaller than the UI suggests. Design/RBAC mismatch, not a bypass (no path lets a requester self-approve — verified live, E-03).

### E-17 [Low · CODE-BUG] sms_provider: comment says setting wins, code lets env win; setting has no admin UI
- Evidence: `lib/otp.js:50-52` — comment "the sms_provider SETTING is the source of truth" but code is `process.env.SMS_PROVIDER || getS(settings, 'sms_provider', '')` (env takes precedence). R-045's fix wired the setting as fallback only, and no Settings field exposes it, so an operator cannot change SMS provider from the panel at all. (blocked_rails half of R-045 is properly wired: lib/rails.js:122 + methods save checks.)

### E-18 [Low · DESIGN] "One prominent button per view" (Apple standard) is diluted on queue pages
- Evidence: overdue-draws card renders one gold `.btn-p` "Draw Now" per row (admin.js:255) and Approvals renders a `.btn-p` Approve per row (admin.js:2215) — a screen full of gold primary buttons gives no single prominent action. Touch targets otherwise PASS: the global rule (style.css ~762) gives `.btn, button` min-height 48px, and admin form fields carry persistent labels (lib/admin-ui.js fieldHtml) — both Apple requirements verified present. Note the cascade that achieves 48px is fragile: `.btn-sm` sizing (style.css:154) is overridden by two later generic `.btn` rules (:762, :919), so "small" buttons are not visually small — harmless but confusing for future edits.

---

## Toggle table — Settings → consumer → verdict
| Toggle (key) | Consumer (file:line) | Verdict |
|---|---|---|
| registration_enabled | routes/auth.js:254,288,445,483 | WORKS |
| force_ssl | routes/auth.js:19,209,238,511 (cookie Secure) + admin login-as admin.js:741 | WORKS |
| policy_agreement | routes/auth.js:318 | WORKS |
| secure_password | lib/validate.js via auth.js:311,385; player.js:492,522; agent.js:93; admin staff/agent create | WORKS |
| kyc_required | — none — | DEAD (disclosed in UI; E-15) |
| email_verification | — none (grep hits are the email_verifications table, not the setting) — | DEAD (disclosed; E-15) |
| mobile_verification | — none — | DEAD (disclosed; E-15) |
| notifications_enabled | lib/notify.js:22,81,99 (master switch, incl. template enabled flag :25) | WORKS |
| otp_registration | routes/auth.js:263,285,329 | WORKS |
| google_oauth_enabled | routes/auth.js:108,128,265,635 (also needs GOOGLE_CLIENT_ID env) | WORKS |
| deposits_enabled | lib/money.js:78 (depositPolicy) | WORKS |
| withdrawals_enabled | lib/money.js:85 (withdrawalPolicy) | WORKS |
| cookie_consent_enabled | views/layout.ejs:127 + public/app.js:228 | WORKS |
| phone_otp_enabled | routes/auth.js:113,438 | WORKS |
| email_otp_enabled | routes/auth.js:114,440 | WORKS |
| withdrawal_otp_enabled | routes/player.js:325 (default ON) | WORKS |
| maintenance_mode | server.js:328 (admin path exempt :337) | WORKS |
| referral_enabled | routes/player.js:130 | WORKS |
| facebook_oauth_enabled | routes/auth.js:109,569 (needs env creds) | WORKS |
| password_login_enabled | routes/auth.js:111-117 (single source post-R-047) | WORKS |
| verified_contact_required | lib/money.js:73 | WORKS |
| admin_totp_required | server.js:361-371 + toggles-save guard admin.js:2030 (refuses before self-enrollment) + totp/disable guard :2433 | WORKS |
| beacon_enabled | lib/draws.js:172,204 | WORKS |
| beacon_required | lib/draws.js:205 / lib/beacon.js | WORKS |
| withdrawal_same_method | lib/money.js:295 + routes/player.js:275 | WORKS |
| breached_password_check | admin.js staff/agent create; auth register/reset (5 consumers) | WORKS |
| csp_enabled | server.js:289 | WORKS |
| withdrawal_turnover_required (risk form) | lib/money.js withdrawal policy | WORKS |
| withdrawal_daily_cap / monthly_cap (risk form) | lib/money.js policy checks | WORKS |
| payout_lock_hours (risk form) | payout-detail change flow (player) | WORKS |
| maker_checker_threshold (risk form) | admin.js maybeMakerChecker (all money routes) | WORKS but deadlocks solo (E-03) |
| referral_cap_per_referee (risk form) | lib/money.js releaseReferralCredits | WORKS |
| deposit_mode / withdrawal_mode (economy + per-user matrix) | manual-only by design post-R-044; 'auto' rejected everywhere | WORKS (honest) |
| Method enabled toggle | player deposit/withdraw method lists | WORKS |
| Extension toggles (7) | auth captcha, layout injections, CSP | WORKS except custom_captcha.difficulty field (E-14) |
| Notification template enabled | lib/notify.js:25 | WORKS |
| Cron job pause/resume + intervals | lib/cron.js handlers incl. process_notifications:35 | WORKS |
| Scratch series enabled toggle | scratch playerRouter sale gate; toggle refuses draft/stopped (R-067) | WORKS |

## Contrast table (computed WCAG ratios, admin UI)
| Pair (text on background) | Where | Ratio | AA 4.5:1 |
|---|---|---|---|
| #ffffff on #ffffff — table links | .adm .tbl a (E-01) | 1.00 | FAIL |
| #5b657f on #17203a — inactive tabs | .tab (E-04) | 2.77 | FAIL |
| #22c55e on #ffffff — positive amounts | .pos (E-07) | 2.28 | FAIL |
| gold-2 on gold-soft — active tab count | .tab.active .count (E-04) | 3.07 | FAIL |
| #b87a00 on #ffffff — info badge / ball chip / links | .b-info, .ball-sm, a (E-08) | 3.61 | FAIL |
| #86868b on #ffffff — table heads, KPI labels | .adm th, .kpi .l (E-09) | 3.62 | FAIL |
| #1b2340 on #a86e00 — primary btn gradient dark end | .btn-p (E-11) | 3.60 | FAIL |
| #ef4444 on #ffffff — negative amounts | .neg (E-07) | 3.76 | FAIL |
| #0071e3 on #dce8f5 — sidebar active | .adm-side nav a.active (E-10) | 3.78 | FAIL |
| #17203a on #ef4444 — danger buttons, error badges | .btn-d, .b-err (E-06) | 4.28 | FAIL |
| #5b657f on #ffffff — muted text | .muted | 5.81 | PASS |
| #1b2340 on #d9940d — warn badge / primary mid | .b-warn, .btn-p | 6.02 | PASS |
| #17203a on #22c55e — success badge | .b-ok | 7.07 | PASS |
| #1b2340 on #f7c948 — primary gradient light end | .btn-p | 9.85 | PASS |
| #1d1d1f on #ffffff — sidebar links, body text | .adm-side nav a | ~15.9 | PASS |
| (no fill/border at all) — plain .btn on white cards | .btn (E-05) | n/a — invisible affordance | FAIL (design) |

## WORKS (verified, no re-report of fixed items)
- All 27 admin GET routes 200 as admin; detail pages render with real data.
- RBAC action matrix enforced live (support POST block → 403); scratch admin has its own super+finance POST gate (routes/scratch.js:156-164); staff self-role-change refused (admin.js:2384); TOTP disable refuses while enforcement ON and requires password + second factor (R-054 intact).
- Maker-checker mechanics themselves are sound: exact-duplicate detection, conflict surfacing (R-052), execution-before-marking so failures stay retryable, referral release + notifications on approval-path deposits, requester notification on rejection (R-053). The flaw is only the solo-operator deadlock (E-03) and approver-pool scoping (E-16).
- Credentials save FAILS CLOSED when CREDENTIAL_ENCRYPTION_KEY is unset (admin.js:1314) — verified in code; the leak in E-02 is the read side, not the write side.
- Prior-round fixes confirmed still fixed (no regressions): R-044 (manual-only modes), R-045 (blocked_rails half), R-047 (single password toggle), R-050 (pre-ban status restore), R-052/R-053, R-055…R-067 spot-checked in code, R-103/R-104 (honest no-op flashes + toggle audits), R-105 (draws pagination), R-107 (per-currency strips), R-108 (scratch detail real 404), R-109 (reports pagination, login-history IP filter), R-110 (single google toggle; upcoming_draw_days now has UI in economy form), R-111 (page status whitelist + sort max+1), R-112 (method field validation).
- Settings saves validate-and-reject-wholesale (economy R-058, prizes R-059, risk R-060, currencies R-048) and audit old→new.
- Apple-standard items present: 48px min hit height on buttons, persistent field labels, press states, admin TOTP enrollment with QR + backup codes, audit-chain verification banner on /audit.

## Summary counts
- Critical: 1 (E-01) · High: 2 (E-02, E-03) · Medium: 5 (E-04, E-05, E-06, E-07, E-12) · Low: 10 (E-08…E-11, E-13…E-18) · Total: 18
- By class: CODE-BUG 7 (E-02, E-03, E-12, E-13, E-14, E-16, E-17) · DESIGN 11 (E-01, E-04…E-11, E-15, E-18)
- Regressions of previously-fixed items: **none found** (R-046's three toggles remain dead but are now honestly labelled — recorded as E-15 design residual, not a regression).
