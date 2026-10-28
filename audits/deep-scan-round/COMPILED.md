# Deep scan — compiled findings ledger (v19 round)

*Method: four read-only auditors (player frontend, backend, admin
console, trust/design/client-authority) → every claim spot-checked
against the code by the coordinator before any fix (adversarial
disprove pass) → fixes re-verified by suite tests, live E2E and a
post-login sweep. Raw area reports: `area-A.md` … `area-D.md`.
Classification per the user's framing: **GALTI** = outright error
(broken / wrong result / dead control); **KAMZORI** = works today but
fragile, inconsistent or under-guarded.*

## Totals (honest counts, deduped)

| Class | Found | Fixed | Documented, not fixed |
|---|---|---|---|
| GALTI | 31 | 31 | 0 |
| KAMZORI | 31 | 27 | 4 (SCAN-046, 047, 057 + remainder of 061) |
| DISPROVEN | 3 (+ 1 sub-point, + 3 sweep false alarms) | — | — |
| Still open (product defects) | 0 | | |

## GALTI — all fixed

| ID | Area ref | Finding (file:line at scan time) | Fix |
|---|---|---|---|
| SCAN-001 | A-01 | Register error re-render lost phone data + entire dial-code list (`routes/auth.js`) | Route passes phoneCountries/refCode/old; view keeps typed values + chosen code |
| SCAN-002 | A-02 | Login `emailPrefill` passed but never rendered (`views/login.ejs`) | Input now carries the prefill value |
| SCAN-003 | A-03 | TOTP POST renders dropped the sessions card / misrendered hasPassword (`routes/player.js`) — own BP-14 bug | Shared `securityViewModel()` for GET + all POST renders |
| SCAN-004 | A-04 | Homepage "Paid out" total summed mixed currencies, labelled base (`views/index.ejs`, `routes/site.js`) | Total filtered to base currency; count-up uses base symbol/decimals |
| SCAN-005 | A-05 | Meta description read nonexistent setting `metaDesc` — empty site-wide (`views/layout.ejs`) | Uses the `metaDesc` local routes pass |
| SCAN-006 | A-06 | KYC submissions table overflowed/clipped on mobile (`views/kyc.ejs`) | Wrapped in `.tbl-wrap` |
| SCAN-007 | A-07 | KYC-block pages were a dead end; error page generic for all statuses | Status-aware headings + "Go to the KYC page" CTA on all 5 block renders |
| SCAN-008 | A-13/D-09 | Fabricated "Today's lucky number" (calendar formula) on homepage | Removed; honest 1–15 balls copy |
| SCAN-009 | A-14/D-02 | Login claimed "Secure & Licensed" (no licence claim is the site's to make) | "Secure sign-in · 18+ only · Play responsibly" |
| SCAN-010 | B-01 | BP-22 auto-approve: withdrawal counted itself in the daily/monthly caps → auto-approve silently dead above half the cap (`lib/money.js`) — own v19 bug | `excludeWithdrawalId` in cap sums; suite test |
| SCAN-011 | B-02 | KYC decide TOCTOU/unconditional; rejecting one doc stripped an earned 'verified' | Guarded `WHERE status='pending'` + changes check; user demote guarded |
| SCAN-012 | B-03/A-08 | KYC resubmit could demote 'verified'; no submission rate limit or pending cap | Guarded demote, 10/min rate limit, one-pending cap (server-side) |
| SCAN-013 | B-04 | Scheduled scratch launch let cap-check exceptions fail OPEN; launch errors swallowed silently | Fail-closed with event + audit on both paths |
| SCAN-014 | B-05 | Auto-next clone skipped the launch-cap check; failed generation left orphan drafts | Cap check before launch (stays due-draft when blocked, audited); orphan cleanup |
| SCAN-015 | B-08 | qs bracket objects into `String()`-unsafe fields → 500s (register, support, profile, agent create) | Text-field coercion at all four sites; suite test (support case) |
| SCAN-016 | B-11/C-09 | Draw trigger 'threshold' with threshold 0 saved → neither trigger could fire, draw unsellable forever | Whole-save refusal with a clear message; suite test |
| SCAN-017 | C-01 | `language` setting: form + persistence + key-read elsewhere (via S()) but nothing ever consumes it — dead switch | Field removed from form + save list (documented in verdict) |
| SCAN-018 | C-02 | Dashboard RTP and draw-detail "Sold" summed `wager` per entry, ignoring pops count — stake understated | Stake computed as wager × pops count in JS (both places) |
| SCAN-019 | C-03 | Withdrawal button "Approve & pay" — approval never pays | Label → "Approve" |
| SCAN-020 | C-04 | "Settle now" offered on unclosed draws → dead-end error click | Rendered only when test/closed; otherwise "Settles at close" |
| SCAN-021 | C-05 | Run-now executions, announcement toggle, contact-handled toggle wrote no audit rows | `cron.run_now(_failed)`, `announcement.toggle`, `contact.handled_toggle` audited |
| SCAN-022 | C-06 | Admin biodata form could set `kyc_status` directly, bypassing the whole BP-21 review trail | Field removed; POST ignores it; status shown read-only with explanation |
| SCAN-024 | D-01 | Footer invited mail to `support@cashpop.live` — a domain the operator does not own; mail would vanish | Seed now points to the working Contact page/tickets; surgical heal replaces only the untouched old default |
| SCAN-025 | D-03 | "win credited the moment the result is out" / "Instant Win Credits" — false (settlement + review exist) | Copy corrected to the real flow |
| SCAN-026 | D-04 | "✓ Verified" badge + "verified winners" label with no verification artefact behind them | Removed from page and ticker JS |
| SCAN-027 | D-05 | Stub trust pages: lorem-style testimonials, truncated About, one-line Terms | Testimonials seed emptied (section shows only real content); About completed; Terms replaced with a substantive template + operator-review notice |
| SCAN-028 | D-06 | Mail could be sent `From: no-reply@example.com` when SMTP_USER unset | Falls back to SMTP_USER, else throws honestly |
| SCAN-029 | D-07 | No 18+/responsible-play signal on /play, /wallet, deposit, withdraw pages | Age + limits note added to all four; register label now states 18+ |
| SCAN-030 | D-17 | /play currency switch used inline `onchange` — blocked by the site's own CSP; switch was dead | Delegated handler in `public/app.js` |
| SCAN-031 | D-16 | Scratch metrics/progress bars white-on-white (invisible) | Backgrounds switched to visible tints |
| SCAN-032 | C-10 | SMS help text contradicted the code (Twilio listed, actual default textbelt); `sendSms` ignored the provider switch | Help text corrected; `sendSms` honours `sms_provider` |

## KAMZORI — fixed (27)

SCAN-033 (A-09) reset-link host fallback aligned with verify-email ·
SCAN-034 (A-10) /contact: anon-session + CSRF coverage + 5/min rate
limit (suite-tested) · SCAN-035 (A-11) `Cache-Control: no-store` on
authenticated responses · SCAN-036 (A-12) "Tickets today" → "last 24
hours" (matches the rolling query) · SCAN-037 (A-15) BP-22 auto-approve
flash texts rewritten without operator jargon · SCAN-038 (A-16) support
thread shows "Support team", not the raw role code · SCAN-039 (A-17)
/transactions silently truncated at 200 → paginated like /tickets ·
SCAN-040 (A-18/D-25) client money formatting assumed 2 decimals →
real per-currency decimals end-to-end (views + app.js `decFor`) ·
SCAN-041 (A-19) wallet KYC card blank for verified users → verified
branch · SCAN-042 (B-06) multipart parser hardened (strict CRLF
boundary; file must be the last part — kills field-overwrite forgery)
· SCAN-043 (B-07) upload middleware stops buffering past the cap,
destroys abusive streams · SCAN-044 (B-09) handlerless cron job now
records `last_status='error'` instead of fake 'ok' (suite test) ·
SCAN-045 (B-10) draw-liability alert now converts per currency
(cron + console) · SCAN-048 (C-08) console wager_options now validated
with the Economy page's rule (one garbage entry can't freeze buys) ·
SCAN-049 (C-11) empty "By country" card + always-blank Country column
removed (no geo-IP exists) · SCAN-050 (C-12) scratch admin fmt uses
real currency decimals · SCAN-051 (C-13) scratch series actions match
status (no dead Stop on drafts) · SCAN-052 (C-14) Users search no
longer drops the active tab/agent filter · SCAN-053 (C-15) agent
assignment is a real select (the `agents` query was previously dead
code; raw internal ids were player-visible) · SCAN-054 (C-16)
unreachable "stored unencrypted" flash branch removed · SCAN-055
(D-08) code fallbacks for the site name aligned to 'Cash Pop Lottery'
(remaining product-name page copy documented in the area report) ·
SCAN-056 (D-10) `--fs-md` was used but never defined — now 15px ·
SCAN-058 (D-12) /security cards sat outside the page container;
password labels now paired for/id · SCAN-059 (D-13) admin-generated
fields now emit `id` + `<label for>`; filters labelled · SCAN-060
(D-14) sub-48px touch targets raised (currency pill, tabs, ticket
tabs, pagination) · SCAN-062 (D-18) simulator "Back" button demoted
from primary · SCAN-063 (D-19) caption token `#86868b` → `#5f6368`
(the value the stylesheet itself chose for DS-063).

## KAMZORI — documented, not fixed (with reasons)

- **SCAN-046 (B-12)** — check-then-act race on withdrawal caps exists
  only on Postgres READ COMMITTED (SQLite, the shipped adapter,
  serialises). Real fix = conditional UPDATE / advisory lock at the
  Phase-2 Postgres migration. The responsible-play deposit variant
  affects only the player's own limits against themselves.
- **SCAN-047 (C-07)** — deposit/withdrawal mode selects offer only
  'manual'; they are part of the user's demanded control matrix and
  their help text honestly says approval is always manual (BP-22's
  auto-approval is a separate, real control). Removing them would
  contradict a standing user order.
- **SCAN-057 (D-11)** — four stacked CSS theme layers with drift
  between them. Consolidation is a visual-regression risk across
  every page; deferred to a dedicated design round.
- **SCAN-061 (D-15, remainder)** — the profile page's two verification
  send-buttons were demoted (fixed part). Homepage section CTAs and
  the KYC approve/reject pair remain as section-level / decision-pair
  primaries — an accepted pattern, recorded rather than restyled.

## DISPROVEN (adversarial pass, with counter-evidence)

- **A-20** — "admin test-draw wins can appear in the public winners
  ticker": test draws are created with `draw_type='TEST'`
  (`lib/draws.js` createTestDraw) while buys only ever select DAY/EVE
  draws — a test draw can never hold player entries, so no test win
  can surface.
- **B-13** — "KYC gate not re-checked when an admin credits a manual
  deposit": BP-21's own spec enforces at creation; staff-initiated
  credits are operator actions by design. Closed by spec.
- **B-05 sub-point** — "second same-template clone is lost": auto-next
  is a serial template chain guarded by the `liveTpl` check; one
  successor per completion is the designed semantics. (The cap-bypass
  and orphan-draft defects in the same item were real — SCAN-014.)
- **Post-login sweep false alarms (3)** — a deposit POST 400 was the
  app's correct required-field validation (`custom_reference`); the
  money-page 403s were the by-design verified-contact gate with a
  clear message; the agent 403s/logout miss were test-driver errors
  (uncommitted DB writes, GET on a POST-only route). All recorded as
  checked-and-correct behaviour, not findings.

## CONNECTIONS AUDIT (dedicated section, behaviour-proven)

22/22 live checks on a fresh boot (`connections.py`), each tracing
control → route → lib → DB effect → visible result: planner preview
exact liability → create → tier sum → audit row; multiplier simulator
renders and saves nothing; webhook junk on an unconfigured rail →
fail-closed, zero ledger rows, no crash; `backup_db` run-now produces
a real file + `last_status ok`; announcement created in console →
visible to the player; player ticket → admin queue → canned picker
present; guardrail group save proven in DB with a distinctive value
(threshold 77) and an invalid value refused without touching the
group. The dead-switch table (area C) confirms every settings and
automation key is wired to a reader — the single exception was
`language` (SCAN-017, removed). BP-21/22/23 keys all wired.

## POST-LOGIN (dedicated section)

Fresh-boot sweep (`postlogin.py`), 80 checks, **all pass**: 25 admin
console pages render; a brand-new player account opens 17 pages with
no 500s (money pages answer the designed 403 with a clear
verify-contact message); invalid submissions (empty support ticket,
empty profile name, bogus deposit, non-listed wager) land cleanly;
populated state: real deposit → admin approve → wallet credited
exactly 5000 minor → ticket bought → populated pages render; agent
role opens its 5 pages; role-switch attempts hit the stealth 404 /
redirects; bogus session cookie → clean login redirect; POST logout
→ protected page redirects to login; back-button protection is the
`no-store` header (SCAN-035). Mobile-width evidence is at CSS level
(token/target consistency, `.tbl-wrap` on the KYC table); no live
device render is available in this sandbox — stated honestly.

## DESIGN CONSISTENCY (dedicated section, summary)

Area D swept every surface against the Apple model in the codebase's
own tokens. GALTI-class design defects: SCAN-030 (dead currency
switch), SCAN-031 (invisible scratch metrics). KAMZORI: SCAN-055,
056, 058–063 (labels, touch targets, contrast token, container
structure, primary-button discipline) — fixed except the recorded
remainders of SCAN-057/061. New v19 pages were built with the same
helpers (admin `fieldHtml`/`formHtml`, player card layout) and were
part of the sweep.

## BP-26 (tamper-proofing) results

`test/tamper.test.js` — 3 tests, all pass, each asserting **persisted
DB state from a separate connection** after the attack (the user's
pass criterion): audit hash-chain (edit/delete detected at the exact
row; chain pre-existed since v14 and is verified on every admin Audit
page render), ledger/audit append-only source invariant, and an HTTP
battery (forged buy economics, dirty pops, invalid wager, forged
scratch price/prize, reveal replay, IDOR, profile smuggling,
verify-without-pending). Full map: `INTEGRITY.md`.
