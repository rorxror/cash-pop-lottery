# DeepSeek Round — COMPILED MASTER LIST (DS-001…)

Compiled 2026-10-28 from audits/deepseek-round/audit-{A,B,C,D,E,F}.md.
Cross-checked vs audits/COMPILED-LIST.md (R-001..R-124) + FIX-LOG.md: no item below re-reports a verified-fixed R-item as open. Regressions: none found by any auditor (C-06 is a defect inside the R-073 fix's math, not a revert).
Duplicates merged: B-05+F-02 → DS-014; F transactions display issues → DS-017 (with B-07).
Note: audit-F.md file truncated on disk at F-12; F-13…F-20 below come from the auditor's delivered summary and are each verified in code during Phase 2 before fixing.
Status column is filled during Phase 2/3 (see FIX-LOG-DEEP.md).

Totals: 81 items — Critical 3 · High 11 · Medium 29 · Low 37 · Config 1.
Class totals: CODE-BUG ~55 · DESIGN 14 · LEAK 13 (overlap) · MISSING/GAP 6 · CONFIG 2.

## CRITICAL
| DS | Src | Title | Evidence |
|---|---|---|---|
| DS-001 | D-01 | Player support reply Send posts to non-existent route → 404 "Page not found", message lost | views/support_view.ejs:20 form action lacks /reply; only route routes/player.js:618 POST /support/:id/reply; live-proven twice |
| DS-002 | C-01 | BOTH-ticket draw-cancel refunds 2× purchase (money creation) | lib/draws.js cancelDraw basis ticket.total/num_draws; num_draws is per-type count, BOTH has 2× entries; live: paid 200 → refunded 400 |
| DS-003 | E-01 | Admin table links white-on-white (1.00:1) — invisible | public/style.css:578 .adm .tbl a color var(--navy-800)=#ffffff (style.css:11) |

## HIGH
| DS | Src | Title | Evidence |
|---|---|---|---|
| DS-004 | A-01 | TOTP backup codes can't be typed at login (maxlength=8 vs 9-char codes; hyphen not normalised) | views/login.ejs:41; lib/auth.js newBackupCodes/useBackupCode |
| DS-005 | B-01 | Manual-rail receiving details (wallet/UPI/bank/Pix/QR) never shown to players — deposits unpayable | views/deposit_new.ejs:18; lib/rails.js credentialFields read only by webhooks/admin |
| DS-006 | B-02 | Gateway rails (cards/Apple/Google/Samsung Pay) collect nothing, promise redirect, create manual deposit | lib/rails.js userFields=[]; routes/player.js POST /deposit/new has no rail branch |
| DS-007 | B-03 | Phone-only users can NEVER withdraw — OTP sent to synthetic @phone.local email → permanent 503 | routes/auth.js:489; routes/player.js withdraw channel pick; lib/otp.js |
| DS-008 | B-04 | Self-excluded/cooling-off players can still deposit (live-proven) | lib/money.js depositPolicy lacks responsible_play check |
| DS-009 | D-02 | After staff reply, player reply form vanishes + page falsely says "ticket is closed" | views/support_view.ejs:15 status==='open' only; admin reply sets 'answered' (admin.js:1483) |
| DS-010 | D-03 | Support tickets never reach the agent; no agent support views/assignment exist | support_tickets has no assignee; routes/agent.js zero support routes |
| DS-011 | E-02 | Gateway credentials page readable by EVERY staff role (decrypted values) | lib/rbac.js:44 GET always allowed; routes/admin.js:1285; live: support role read planted key |
| DS-012 | E-03 | Maker-checker deadlocks solo operator; no warning when <2 approvers | routes/admin.js:986,2224,2276; live-proven with 1 admin |
| DS-013 | F-01 | Policy reasons leak operator switches to players ("Deposits are disabled for your account." etc.) | lib/money.js:78-79,85-86 rendered at routes/player.js:223,235,267,292,376; live-triggered |
| DS-014 | B-05/F-02 | Money pages show "Min $NaN · Max $NaN" / "No limits" — views read method.min/max, DB is min_amount/max_amount | views/deposit_new.ejs:24-27, withdraw_new.ejs:25-27, wallet.ejs:22,38; live-proven |

## MEDIUM
| DS | Src | Title |
|---|---|---|
| DS-015 | A-03 | OAuth provider fetches have no timeout (4 fetches, routes/auth.js:589,592,652,658) |
| DS-016 | B-06 | Deposit/withdraw charge preview in public/app.js:280-297 mixes major/minor units — tells $50 depositor "credited $0.00" (actual $46.50) |
| DS-017 | B-07 | Transactions: Reference column blank (t.ref vs ref_id), literal "&minus;" text, raw ledger type strings shown |
| DS-018 | B-08 | No deposit-side responsible-play limit (no daily deposit cap anywhere) |
| DS-019 | B-12 | No bonus system at all (no deposit bonus/promo, no toggle, no display) |
| DS-020 | C-02 | Settled tickets show "ACTIVE" forever (views branch on won/lost; engine writes 'settled') |
| DS-021 | C-03 | Fairness page shows ✗ MISMATCH for every settled TEST draw with fixed number; results page falsely claims TEST "excluded from payouts" |
| DS-022 | C-04 | Playslip formats prices/balance in display currency, debits wallet currency, no conversion (live: € prices, $ debit) |
| DS-023 | C-05 | Slip total/Buy button ignore bundle discount server charges; "5 × Both" silently gets no discount |
| DS-024 | C-06 | R-073 per-draw stake cap sums full multi-draw totals — legit small buys refused (defect inside R-073 fix) |
| DS-025 | D-04 | New ticket creation notifies nobody (no notify/audit) |
| DS-026 | D-05 | Player reply notifies nobody; staff reply hardcodes author_role='admin' |
| DS-027 | D-06 | 4/15 seeded templates have no send site: email/otp, sms/otp, sms/win, push/win |
| DS-028 | D-07 | No announcement/in-app notification system; admin broadcast is email-only, invisible without SMTP |
| DS-029 | D-08 | No contact page/form — logged-out/locked-out users have no way to reach support |
| DS-030 | E-04 | Admin filter tabs 2.77:1 contrast; active tab inverted (white pill), count chip 3.07:1 |
| DS-031 | E-05 | Plain .btn has transparent bg + border → admin action buttons render as bare bold text |
| DS-032 | E-06 | Danger buttons/badges 4.28:1 (dark-navy text on red #ef4444) |
| DS-033 | E-07 | .pos 2.28:1 / .neg 3.76:1 money amounts in admin tables |
| DS-034 | E-12 | Admin draw detail page (P&L + winner breakdown) is an orphan — zero inbound links |
| DS-035 | F-03 | Maintenance page announces "operator… admin panel" — breaks stealth rule (views/maintenance.ejs:6) |
| DS-036 | F-04 | "The operator has not enabled any deposit method yet" on deposit/withdraw pages |
| DS-037 | F-05 | OAuth 503 pages reveal missing provider credentials (routes/auth.js:570,636) |
| DS-038 | F-06 | Verify-contact flash reveals "(no email provider configured)" + "ask support to mark your contact verified" (player.js:454; money.js:80,87) |
| DS-039 | F-07 | Seeded Privacy Policy publicly serves "placeholder — the operator should publish…" (migrations.js:93) |
| DS-040 | F-08 | OTP sign-in verify enumerates staff/blocked/pending/2FA status (routes/auth.js:500-503) |
| DS-041 | F-09 | Homepage Paid-out JS counter hard-codes "$" (public/app.js:109,141) |
| DS-042 | F-10 | Homepage recent-winners query omits t.currency → non-USD wins shown as USD (routes/site.js:56-58) |
| DS-043 | F-11 | Hard-coded homepage claims "Instant Payouts" / "Secure & Licensed" contradict manual-review withdrawals + unverified licence (views/index.ejs:28,75-76) |

## LOW
| DS | Src | Title |
|---|---|---|
| DS-044 | A-04 | OAuth-created accounts have no password and no in-account way to set one; password-gated security actions dead-end |
| DS-045 | A-05 | Failed password login re-render drops Facebook button + OTP method UI (render() passes only googleOn) |
| DS-046 | A-06 | Register page has no social buttons (template never uses googleOn; facebookOn not passed) |
| DS-047 | A-07 | TOTP challenge screen also renders the password form underneath |
| DS-048 | A-08 | FIX-LOG.md names wrong OAuth env vars (GOOGLE_SECRET vs code's GOOGLE_CLIENT_SECRET) |
| DS-049 | A-09 | Complete-profile "Sign out" link is dead GET /logout → 404 |
| DS-050 | B-09 | POST /deposit/new has no rate limit — pending-deposit spam |
| DS-051 | B-10 | Wallet "Pending requests" includes already-decided items (no status filter) |
| DS-052 | B-11 | Referral earnings invisible to players; scratch buys never accrue referral credit |
| DS-053 | B-13 | Daily loss limit enforced per-game (2× total possible); page doesn't say per-game |
| DS-054 | B-14 | New player wallet shows empty Balances section (no $0.00 row) |
| DS-055 | B-15 | Withdraw-verify page: no OTP resend; Cancel doesn't clear pending withdrawal |
| DS-056 | C-07 | Scheduler creates today's draws after close time → instantly settle empty as phantom results |
| DS-057 | C-08 | Fairness: cancelled draws say "Not settled yet" forever; unknown draw id silently blank (no notFound branch) |
| DS-058 | C-09 | My Tickets LIMIT 100 / My Scratch LIMIT 200, no pagination |
| DS-059 | C-10 | Draw schedule UTC-only; no site-timezone setting exists (CONFIG/product decision) |
| DS-060 | D-09 | No attachments on support tickets |
| DS-061 | D-10 | Player cannot close/reopen own ticket |
| DS-062 | E-08 | .b-info/.ball-sm/global links gold-2 on white 3.61:1 |
| DS-063 | E-09 | Admin table headers + KPI labels #86868b 3.62:1 — **PARTIALLY DISPROVEN** (disprove-E): the table-header half is killed — `.adm .tbl th` (specificity 0,2,1, #5b657f = 5.81:1 PASS) overrides the `.adm table th` rule the audit cited, and every admin table carries class `tbl`. The KPI-label half STANDS (`.adm .kpi .l` = 3.62:1 FAIL) and was fixed; the header override shipped anyway is harmless. |
| DS-064 | E-10 | Sidebar active item 3.78:1 |
| DS-065 | E-11 | .btn-p gradient dark end 3.60:1 |
| DS-066 | E-13 | Admin deposits/withdrawals lists lack player/method/date filters |
| DS-067 | E-14 | Dead control: custom_captcha difficulty field consumed by nothing |
| DS-068 | E-15 | 3 dead Settings toggles remain (kyc_required, email_verification, mobile_verification — honestly labelled, still dead switches) |
| DS-069 | E-16 | Approvals RBAC money-only: risk can queue draw settlements but never second-approve any |
| DS-070 | E-17 | sms_provider: comment says setting wins, code lets env win; no admin UI for the setting |
| DS-071 | E-18 | Multiple gold .btn-p per queue page dilutes "one prominent button" |
| DS-072 | F-12 | Auth toggle announcements: "Phone login is disabled." / "Email login is disabled." / "Registration is disabled." |
| DS-073 | F-13 | Scratch lobby empty state reveals "operator has not launched a series" wording |
| DS-074 | F-14 | Profile/referral wording reveals operator settings ("(operator setting)", "(when enabled by the operator)") |
| DS-075 | F-15 | TEST draws publicly labelled/listed on results + homepage (internal test artefacts on public surfaces) |
| DS-076 | F-16 | Scratch reveal passes raw e.message to players (incl. "Outcome commitment mismatch") |
| DS-077 | F-17 | Nav .active highlighting dead — layout uses S('currentPath') (settings) instead of currentPath local |
| DS-078 | F-18 | <div id="fb-root"> rendered inside <head> |
| DS-079 | F-19 | /favicon.ico returns the HTML 404 page (no favicon) |
| DS-080 | F-20 | Viewport zoom-lock — BY USER DEMAND (recorded; accessibility note only, no change) |

## CONFIG (not code defects)
| DS | Src | Title |
|---|---|---|
| DS-081 | A-02 | OAuth operator checklist: admin toggles ON + GOOGLE_CLIENT_ID/SECRET + FACEBOOK_APP_ID/SECRET env + BASE_URL public https + redirect URIs registered in provider consoles. 503 message also conflates the two gates (fixed under DS-037 wording). |
