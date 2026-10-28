# OWNER-FIX ROUND (v20) — LEDGER

Owner live-tested v19 (live commit 6635060) on his phone, found real
defects the sweeps missed, and ordered this round himself. Method:
adjudicate first — every item gets a VERDICT proven against the real
code and/or a local boot BEFORE any fix (file:line or live repro).
Disproven items get evidence, not fixes. Fixes are re-checked by
behaviour, then the full suite must pass.

Baseline (coordinator, pre-round): suite 90 tests = 89 pass / 0 fail /
1 skipped (PG adapter). Backup: /tmp/cashpop-fix-pre-v20-backup.tar.gz
Working copy ONLY: ~/workspace/cash-pop-fix/. No push, no deploy.

Verdicts are collected per worker in adj-*.md in this directory and
compiled here by the coordinator.

## Items

- U-01 Escaped-HTML leaks (profile badge HTML as text; wallet `&nbsp;`) + class sweep + regression test — INSTANCES DONE (account worker: profile badges are real conditional markup now — b-ok "✓ verified" / b-warn "not verified" as actual badges; wallet `&nbsp;` removed, curl count 0; one further same-pattern instance in tickets.ejs converted though it rendered correctly. Site-wide crawl + regression sweep = U-24, final wave)
- U-02 True-reason errors, inline at point of action (money flows) — DONE (backend worker: lottery buy → direct re-render of the slip with HTTP 400 preserved, true reason + selections in locals — insufficient funds names cost/balance/shortfall; scratch buy → re-render of series page; deposit/withdraw → flash + redirect back to the form per the app's pattern. Sub-item DISPROVEN: no verified-contact/KYC gate exists in the BUY path — those gates live on deposit/withdraw only; none invented)
- U-03 Homepage draws list set + countdown format (Day/Evening/Day) — DONE (home worker: root cause — ensureUpcomingDraws creates DAY+EVE as pairs per date, but settleDueDraws rolls each draw individually (+24h/+1h), so a rolled DAY lands inside the next pair; the flat ORDER BY close_at query faithfully rendered the mess. Fix: fetch next 2 of EACH type, merge by close_at with date/type tie-breaks; no invented cards when a type is missing. Countdown unified to ALWAYS "Dd HH:MM:SS" — the only producer is app.js tick(), which had two structures; server renders an identical placeholder)
- U-04 Sessions page rebuild (human device info, real client IP, layout) — SERVER SIDE DONE (backend worker: parseUA extended — CriOS/FxiOS/Samsung/Edge variants, device labels, {browser,os} contract preserved; security view model no longer passes the raw UA at all. U-04b real IP: mechanism PROVEN by experiment — trust proxy=1 resolves req.ip to the internal 10.26.x.x hop on the Render XFF chain; coordinator APPLIED the measured fix in server.js: trust proxy = ['loopback','linklocal','uniquelocal'], which returns the true client and ignores spoofed XFF prefixes; honest note stands: already-stored sessions keep their old internal IP, only new sign-ins change. Layout DONE (account worker: wide table + raw UA deleted; stacked .v20-session-cards — deviceLabel headline, IP, signed-in, expiry fully visible; current session marked via the view model's currentSessionId (req.sess.id) with --current + "This session" badge; sign-out-others preserved; zero "Mozilla/" in the rendered page) — U-04 COMPLETE
- U-05 Header double pill → one control — DONE (chrome worker: multi-currency proven genuine — per-currency wallets, USD/EUR/INR live — so the currency pill became the ONE control carrying code+balance+switcher; user pill is name-only now; logged-out renders zero balance markup)
- U-06 Cover All state coherence on playslip — DONE (chrome worker: the ✓ was a hard-coded static glyph in play.ejs — affordance bug, click logic was already sound; ✓ removed, button now syncs aria-pressed + gold .is-active only at 15/15, Clear/Quick Pick/unselect drop it)
- U-07 Zoom lock + horizontal-overflow elimination — DONE with a partial DISPROOF (chrome worker: layout.ejs ALREADY served maximum-scale=1/user-scalable=no — the meta was not missing; real 360px overflow risks (.hero-stats 376px min-width row, un-capped .tbl-wrap, non-wrapping flex) got one site-wide guard block; honest limit: headless Chromium in the sandbox blocks localhost, so fit is guard-based, not pixel-measured)
- U-08 Flash auto-dismiss (success) / dismissible (error) — DONE (chrome worker: success flashes carry data-auto-dismiss=4000 + 300ms fade, errors persist, both get a visible 48px × close; role="alert" preserved)
- U-09 Homepage feature cards rebuild + restore post-login motion — DONE (chrome worker fixed the motion cause; home worker rebuilt the markup on .v20-feature-*: icon top → title → full-width body, equal heights. Copy honesty catches: "Secure Platform" body merely duplicated Provably Fair — replaced with backed claims (scrypt passwords, server-side sessions, server-decided balances/results); "Fast Win Credits" kept verbatim — verified true, settleDraw posts wins inside the settlement transaction, no "instant" added)
- U-10 Homepage stats boxes equal 3-up — DONE (home worker: queries verified CORRECT and left untouched — players count, tickets rolling-24h matching its label, paid-out base-currency-only; layout rebuilt as 3 equal .v20-stat-cards, decorative balls aria-hidden and clear of buttons)
- U-11 Draw cards + balls premium shine — DONE (home worker: cards on .v20-draw-* with decorative sun/moon ball — no invented numbers — real draw_date, Enter with sheen class; the app.js ticker contract (countdown class + data-close-at) preserved exactly)
- U-12 Homepage scratch section from real series data — DONE (home worker: query mirrored exactly from the scratch lobby — status='live' AND enabled=1, remaining = unclaimed outcomes, top prize = MAX tier. Hide behaviour PROVEN both ways: stopping Gold Rush removed the section AND its name from the homepage; restoring brought it back. Logged-out shows price/top-prize/remaining + Register/Sign-in CTAs, no balances; logged-in CTA goes straight to /scratch)
- U-13 How It Works: numerals inside card + scratch steps — DONE (home worker: was a raw CMS <ol> string — numerals were uncontrolled list markers; homepage now uses explicit .v20-step-cards with the numeral inside: 4 lottery steps (seeded copy carried over; the CMS block still drives /page/how-it-works — trade-off recorded in adj-home.md) + 3 scratch steps at equal prominence; "credited when you reveal it" verified against revealTicket — prize posts in the same transaction as the reveal)
- U-14 Profile sections as collapsible accordion, auto-collapse on save — DONE (account worker: Contact verification / KYC / Email notifications / Referral are <details>-based .v20-accordion items, collapsed by default, no JS needed; summaries are TRUTHFUL and computed from live state — notifications summary flips "2 of 2 on" → "1 of 2 on" after a real save; every profile POST redirects to /profile so a saved section lands collapsed with the flash confirming — that is the auto-collapse)
- U-15 Profile verified / not-verified badge — DONE (account worker: header badge renders purely off the profileVerified local — b-warn "Profile not verified" (the design system's warning family; owner's colour discretion) / b-ok "Profile verified"; the flip was proven by setting email_verified=1 in the DB and re-rendering)
- U-16 Referral link absolute URL + Copy button — DONE (account worker: read-only input carries referralUrl verbatim (rendered value starts with the configured BASE_URL); NO copy pattern existed anywhere in the codebase, so one small documented app.js handler ([data-copy-target], clipboard API + select fallback, button label flips to "Copied") was added — now the reusable site pattern; block still hidden when the user has no referral code)
- U-17 Notification checkboxes restyled to site controls — DONE (account worker: .v20-switch controls; field names/values/POST target byte-identical, and the BP-13 save contract was re-proven end-to-end by curl after the restyle)
- U-18 Support turn-taking (player replies only after staff reply, server-enforced) — DONE, server side (backend worker: gate keys off the latest support_messages author_role !== 'player' — staff inserts are never 'player', so admin/agent replies unlock naturally; closed/locked/empty/deleted replies refused with true-reason flash, never a bare 400/500. Lock UI DONE (account worker: canReply=false replaces the reply form with the server's lockReason note; U-18 COMPLETE)
- U-19 Support limits (max open 2, max new/24h 3, settings-driven) — DONE (backend worker: keys support_max_open_tickets / support_max_new_tickets_24h, defaults 2/3, 0 = unlimited, garbage values fall back to defaults; the single INSERT site in the codebase is the player route so enforcement covers all creation; rejections name live count + limit. COORDINATOR CONFIRMS the open-reading: 'answered' counts as open (status != 'closed' AND not deleted) — an answered ticket is still a live unresolved thread; admin Settings form DONE by the U-20 worker (U-20.2) — U-19 COMPLETE end-to-end)

## U-20 — Admin interior technical pass (owner addendum, 2026-10-28 ~16:31 EDT)

Owner's suspicion as brief: the admin interior still hides broken
connections. Behaviour-first exercise of EVERY admin page/control on a
seeded boot; numbers traced to DB; newer modules (KYC queue, canned
replies, Automation Console, Prize Engine, auto-withdrawal) re-proven
on THIS build; error-path + RBAC pass; U-01 leak class in admin views.
Findings logged as U-20.x below with chain-break naming
(control → route → lib → DB → visible effect).

- U-20 — COMPLETE (admin worker; full ledger in adj-admin.md).
  ~120 controls exercised with DB/exact-money effects on a seeded
  boot; behavioural harness 79/79; regression suite 12/12; audit
  hash chain verified after all changes. Verdict on the owner's
  suspicion: PARTIALLY RIGHT — the interior is overwhelmingly wired
  correctly, with 5 real breaks, all FIXED:
  - U-20.1 Reports 500 on invalid dates — dateRange crashed
    rendering its own "Invalid date range" error (RangeError in
    fmtDateInput). Fixed: safe render defaults + NaN guard; the
    error still shows, page is 200.
  - U-20.2 (= U-19 admin slice) Support-limit settings were MISSING
    entirely — "Support ticket limits" card + POST
    /settings/support-limits added (exact keys, 0 = unlimited in
    help text, atomic whole-number validation, audit row,
    super-only via the existing /settings/.+ RBAC rule). U-19 is
    now COMPLETE end-to-end.
  - U-20.3 Biodata save stored "[object Object]" as a player's name
    (qs object String()-coerced into the DB) — silent corruption,
    no error anywhere. Text fields now accept genuine strings only.
  - U-20.4 Staff create 500 on object-typed fields (.trim() on an
    object; agents create had the identical pattern) — string-type
    guards on both; invalid shapes refuse cleanly, no row written.
  - U-20.5 Agents could claim ANY unassigned player by direct POST
    (pool list was operators-only, the claim endpoint wasn't —
    sequential-id guessing, harness-proven). Claim is now
    operators-only with a true-reason message. OWNER NOTE: if
    self-service claiming is ever wanted back, it must return WITH
    a visible pool — recorded, not silently restored.
  - U-25 STAFF SIDE — COMPLETE (admin worker): admin delete on list
    + detail (no confirmation), Deleted tab + read-only deleted
    detail (no action forms), normal detail 404s, reply-to-deleted
    refused with true reason, dashboard/queue/list counts all
    exclude deleted, one-line soft-delete explainer in the UI;
    agent delete scoped to own players (foreign agent → 404,
    ticket stays live). U-25 is now COMPLETE on both sides.
  Checked-with-effect (no break): stealth 404 + probe audits; RBAC
  matrix; deposit approve exact + double-approve safe; dashboard
  tiles == hand-checked DB (prize aggregate includes scratch_prize
  — OWN-01 re-verified); reports == DB; settle/cancel exact;
  planner liability hand-math exact (7500); simulator RTP =
  multiplier/15; KYC full cycle; auto-withdrawal ($30 auto-approves
  at $50 limit, decided_by=0, NEVER auto-paid; $80 stays pending;
  per-user override; mark-paid provider-id gate); maker-checker
  (self-approve refused, finance executes exactly); SCHEDULER
  GATING PROVEN ACROSS RESTARTS (master OFF holds a due job's
  last_run_at, ON advances it); reconciliation 0 mismatches.
  OBSERVATIONS for the owner (logged, not defects): (1) KYC RBAC
  mapping inconsistency — the queue sits under MONEY roles while
  manual verify sits under SAFETY roles; both work, which roles
  SHOULD own KYC is the owner's call. (2) A pre-existing
  data-confirm on the AGENT transfer view — the no-confirm rule
  was stated for admin; noted alongside the pending player-confirm
  decision. (3) One transient impersonated-session /wallet 500
  under heavy parallel load, not reproduced (200 on retest, same
  DB) — recorded as an observation, not a finding.
  U-26 INVENTORY DELIVERED: adj-admin.md ends with all 133 admin
  routes + 12 agent routes (path + purpose) — the ORG worker's map.

## U-21 — Payment method config audit (owner addendum, 2026-10-28 ~16:33 EDT)

Every rail in lib/rails.js + its admin config UI gets a three-way
comparison: (a) config keys the deposit/withdraw code actually READS,
(b) fields the admin form COLLECTS today, (c) what the method genuinely
requires (manual rails: real pay-to destination details + instructions
+ confirmation requirement; gateway rails: the provider's real
credential set + live/sandbox mode where offered). Mismatches are
GALTI-class both directions (dead field / un-suppliable key), with
true-reason validation at save time and secrets proven encrypted at
rest in the existing credentials store. On/off + deposit/withdraw
control matrix behaviour untouched. E2E: PayPal via the real admin
form → player deposit page → admin queue; one gateway rail in
sandbox/test posture as far as the sandbox allows; one crypto rail
showing address+network exactly as saved.
FIX-LOG-V20 gets the per-method table.

- U-21 — COMPLETE (payments core + CHAIN §5 polish; adj-chain.md).
  §5.1: the credentials POST validated nothing before writing and
  the keep-saved path ran BEFORE the required check — required
  secrets passed blank and format garbage stored silently. Now a
  merged incoming map (blank password → saved value) is validated
  by validateRailCredentials BEFORE any write; refusals flash
  "Credentials NOT saved: <true reason>" and leave the stored
  config byte-identical (proven: bad UPI / missing Network → zero
  rows; blank-secret re-save did NOT wipe the saved webhook
  secret). §5.2: the GET now passes help text + secret-ness
  through (stored secrets render nowhere in the HTML; publishable
  key shows; DB holds v1: AES-GCM envelopes). §5.3: withdrawals
  were asked for DEPOSIT proof fields ("Transfer reference");
  methodCustomFields is now kind-aware — withdrawals ask the rail's
  payout fields and validate them with true reasons (missing
  account number → refused, no row); deposit path unchanged;
  gatewayPublic local now passed to the deposit view (rendering
  leg → U-24 wave, per adj-chain spec).

- U-23 — DONE (CHAIN worker; adj-chain.md). BEFORE-STATE: no CSV
  export existed anywhere (grep-proven — reports were HTML-only).
  EXPORT: GET /data + /data/export/:dataset for users, ledger,
  lottery tickets, ticket entries, draws/results, deposits,
  withdrawals, agents, support tickets — human headers, humanised
  statuses, amounts in major units with currency, UTC timestamps,
  formula-injection guard, paged streaming, CAP 10,000 rows stated
  on the page + X-Export-Cap/Total headers + audit detail;
  filenames <dataset>-<date>.csv; RBAC per dataset (users→SAFETY,
  money→MONEY, support→SUPPORT); every export audit-logged;
  player gets stealth 404 + probe row (proven). IMPORT — chosen
  (insert-only, natural-key dedupe): content pages (slug), canned
  replies (title), notification templates (channel+slug), content
  blocks (key). Excluded with reasons: users/agents/staff
  (identity), ALL money (no route exists — the UI states it in
  plain words), tickets/draws/scratch outcomes (provably-fair
  records), prize structures (payout economics — belong in the
  Prize Engine), credentials (encrypted secrets), settings,
  support/KYC/audit (evidence + hash chain). Mechanics: dry-run
  (writes nothing; per-row ready/duplicate/rejected with reasons)
  → Execute BUTTON (re-validates; one transaction; audit with
  counts); limits 1,000 rows / ~900 KB stated in UI; double-import
  adds 0 (proven); dataset=ledger refused. OPEN (integration-
  optional): a scoped multipart parser in server.js would upgrade
  import from paste-in CSV (current, honestly labelled in the UI)
  to file upload — CHAIN spec'd it (mirror the /kyc block);
  implement at integration only if the mandatory battery is green
  first. OBSERVATION (owner decision class, with the KYC RBAC
  one): credentials POST is MONEY-role while its GET is
  super-only — finance can save credentials it cannot view.
  config lives in gateway_credentials, the admin form is generated from
  rail.credentialFields, so rails.js fixes drive the form's fields.
  Headlines: PayPal DID NOT EXIST as a rail (owner's complaint proven)
  → new paypal rail (pay-to email/name, mode, client_id/secret,
  paypal_txid+sender_email user fields, webhook:false honestly);
  every webhook:true rail except cards lacked a webhook_secret field
  (webhooks unverifiable) → added; dead fields wired or honestly
  relabelled config-only (crypto confirmations now player-visible,
  cards publishable wired to a new public-config path, bank swift
  split from ABA routing, cash_agent network now required, ewallet
  api_credentials blob replaced by real client_id/secret fields);
  per-key validation with true reasons (money.js rejects malformed
  tx_hash/UTR); secrets proven encrypted at rest. E2E: crypto
  verbatim ✔, Stripe-sandbox signed webhook credits exactly, bad
  signature 401 ✔, PayPal form→encrypted→player pay-to→queue with
  txid intact ✔. Worker tests 11/11. (The §5 polish that followed
  in the CHAIN wave is recorded in the U-21 COMPLETE block above.)

## U-26 — Admin organization / smart placement pass (owner addendum, 2026-10-28 ~16:42 EDT)

The console must be understandable at a glance: coherent operator
groups, operator-language labels (U-24 applies to menu names), no
scattered controls. Deliverables: (1) full inventory + before→after
nav MAP (target grouping finalized from the REAL inventory, written
into this ledger by the ORG worker — the one authorized exception to
the no-ledger-edits rule, since it runs alone in its wave);
(2) ORPHAN HUNT — every admin page reachable by clicks from the
console or from a linking parent; URL-only pages are GALTI;
(3) MISPLACEMENT fixes — controls/settings move next to their
relatives; duplicate pages for one job consolidated;
(4) TWO DOORS RULE (owner's explicit permission) — where an operator
naturally looks in two places, the same control lives in both, both
doors reading/writing the SAME key/data, proven both directions
(change in A → reload B → matches, and reverse);
(5) full nav crawl on the E2E boot — every page reached by clicking
from console home, 200s, breadcrumb/section matches its group.
Guardrails: URL paths do NOT change (nav/placement only; a merged
page's old path redirects, never 404s); stealth untouched; no confirm
popups added; RBAC menu visibility per role preserved and checked
(support/agent roles must not SEE entries they cannot open).

- U-26 — DONE (ORG worker; adj-u26.md). BEFORE: one flat sidebar of
  31 links in lib/admin-ui.js, no groups, NO role filtering (every
  staff role saw every entry). AFTER: NAV_GROUPS — 8 operator
  groups in workflow order (Overview / Money In & Out / Players &
  Agents / Games / Support / Bonuses & Growth / Security &
  Compliance / Settings & System), all 31 destinations kept, NO
  URL changed (paths-frozen guard test deep-compares route
  patterns pre/post — identical). NOTE: adj-admin.md's route
  inventory was TRUNCATED on disk, so the map was re-derived from
  code: 145 admin routes (51 GET pages) + 12 agent routes, each
  assigned to exactly one group. ORPHANS: ZERO — BFS crawl from
  the console home visited 201 URLs; 51/51 GET pages reached by
  clicking rendered links, all 200, every detail page's parent
  link named. Agent coherence defect found + fixed: agent
  create_user + transfer pages had NO nav bar — both now carry
  the standard 6-link bar. TWO DOORS ×4 (same route, same key,
  round-trip proven both directions, sibling fields unchanged):
  support limits (Settings ⇄ Support queue), auto-withdrawal
  limit (Settings ⇄ Withdrawals), incident switches (Settings ⇄
  Dashboard "Site status" card), KYC switch+gate (Settings ⇄ KYC
  queue) — editable for super, read-only value for other roles.
  PER-ROLE NAV: role-filtered at render — super 31 / finance 16 /
  support 11 / risk 11 entries; for each role every visible entry
  opens 200 (never 403) and forbidden entries are absent.
  Heading match 191/191. Misplacement adjudication: game economy
  stays in Settings (splitting needs handler changes — spec'd;
  super-only pointer line added on the Draws page); Automation ⇄
  Cron Jobs cross-linked. SPEC for the final wave (adj-u26 §8):
  routes/scratch.js renders its 2 admin pages via ui.layout
  WITHOUT a role argument (they'd show the full super nav) —
  one-line fix ×2, assigned to U-24.

## Discovery phase (owner decision, 2026-10-28 ~16:43 EDT)

No external bug list is coming — "tu khud dhund". This round is an
independent full-stack hunt on top of U-01..U-26. Method: independent
finder passes (read-only, on a frozen snapshot at /tmp/hunt-snapshot
so repro boots never fight the fix workers), then a DISPROOF pass per
candidate — reproduce on a fresh boot of the then-current tree or it
does not count. The count is an OUTPUT, never a target; a class swept
clean with evidence is reported as "swept, nothing found" and that is
a valued result. Owner's emphasis: "kahi bhi ho sakta hai" — the
most-"finished" surfaces hid his real bugs (profile, wallet,
homepage); boring old pages and settled flows get the SAME suspicion
as new modules, including paths nobody has clicked since early rounds
(password reset, agent transfer, referral landing, email templates,
cron jobs' visible outputs). Discoveries enter below as D-xx with
verdict + evidence, fixed + regression-tested like U-items;
FIX-LOG-V20 splits found-by-owner vs found-by-hunt.

- D2 (auth/sessions) — COMPLETE (adj-discovery-auth.md). PROVEN:
  - D2-C1 Pre-auth sessions keep the 1-HOUR anon TTL instead of the
    15-min PREAUTH_TTL: the TOTP stash only touchSession()s (DB row:
    expires-created = 3,600,000 ms). Password + OAuth stash sites.
  - D2-C2 Password reset/revocation MISSES pre-auth sessions (they
    are user_id=0 rows; destroyUserSessions deletes user_id=? only):
    a pre-reset pre-auth session completed TOTP after the reset and
    reached /wallet WITHOUT the new password. Affects reset, change,
    revoke-all, TOTP disable/backup, admin block/reset/revoke.
  - D2-C3 TOTP ENROLMENT needs no password (player + admin start/
    confirm), unlike disable/backup/change which all re-auth: a
    hijacked session can enrol the ATTACKER's TOTP and lock the
    victim out of their own account.
  - D2-C4 Captcha is single-solve, MULTI-use: the answer is nulled
    in memory only, never persisted — one solve minted two reset
    tokens. (Answer space also tiny: sums 4–16.)
  - D2-C5 Blocked-country bypass via PROFILE: register refuses a
    blocked +91 correctly, but POST /profile phone save has no
    isBlockedPhone check (its only call site is register) — blocked
    number stored. Agent/admin phone writes also lack the check.
  - D2-C6 Player verify-email: NO rate limit and prior tokens never
    invalidated (admin + reset paths both invalidate): 4 POSTs → 4
    simultaneously live 24h tokens + 4 emails.
  - D2-C7 Session-less CSRF hole on POST /reset/:token: the CSRF
    exemption matching omits the parameterized path — a POST with an
    EMPTY cookie jar and no token returned 302 and CHANGED THE
    PASSWORD. (/currency also succeeds session-less — preference
    only; complete-profile/logout fail safe in-handler.)
  - D2-C8 XFF spoofing under trust proxy=1: forged X-Forwarded-For
    minted fresh rate-limit buckets and falsified login_history/
    sessions IPs (proven locally; Render edge stated as
    deployment-conditional). ROOT CAUSE = the same setting as
    U-04b — the coordinator's trust-proxy fix is ALREADY APPLIED on
    the current tree; D-fix wave re-verifies and closes or fixes
    any residue.
  - D2-C9 BASE_URL-missing link building: without BASE_URL the OAuth
    redirect_uri is relative (providers reject — OAuth silently
    dead) and the admin reset flash link is a bare path. The forgot
    flow got the host fallback in SCAN A-09; OAuth + admin didn't.
  Maps delivered: CSRF coverage (global check holds for every
  session-bearing POST — 7/7 spot checks 403; only the session-less
  fall-throughs of C7) and rate-limit coverage (login bucket shared
  across login/reset/OTP; GAPS: /withdraw/new has no cap of any
  kind; player security POSTs lack the limiter their admin twins
  have — fix wave adjudicates both).
  Leads (unproven): verify-email consume lacks the reset token's
  CAS guard (parallel race attempted, NOT reproduced on SQLite);
  TOTP rate-limit asymmetry player vs admin; forgot per-email cap
  (R-030 trade-off); POST /register lacks an already-authenticated
  guard (U-22-adjacent, IN-FLIGHT class); login-as session row for
  banned targets is destroyed on first use (net held).
  SWEPT CLEAN: fixation/rotation, pre-auth identity isolation
  (R-001), TOTP + backup-code one-use, reset-token CAS + sequential
  reuse + token burning, IP limiter (429 at attempt 31) + account
  lockout with generic errors, complete-profile gate, expired-
  session deletion, OAuth state single-use, blocked-country AT
  REGISTER (one apparent bypass was the finder's own DB write inside
  the 5s settings-cache TTL — not charged), live HIBP refusal,
  forgot anti-enumeration, impersonation exit, cookie flags as set.
  D-FIX-A RESULTS (auth worker): C1 FIXED (touchSession gained an
  explicit ttlMs exception to R-121; all three stash sites pass
  PREAUTH_TTL and re-issue the cookie at Max-Age 900 — lifetimes now
  ~900,000 ms, aged stash cannot complete login). C2 FIXED
  (destroyUserSessions in lib/auth.js now also deletes anon rows
  whose payload is pending for that user — reset/change/revoke/
  TOTP-disable/admin callers all inherit it with zero edits in
  their files; another user's sessions untouched). C4 FIXED
  (captcha consumption persisted via the session store; OTP-request
  keep exemption preserved; replay mints no second token). C7 FIXED
  (server.js session-less refusal now matches /reset/ paths AND
  GET /reset establishes the anon session + real CSRF token, so the
  genuine emailed-link flow works while the empty-jar attack gets
  403 with the password unchanged). C8 CLOSED as FIXED-BY-U-04b
  (forgery repro re-run: internal hop never recorded, spoofed
  prefix ignored, exhausted bucket stays 429 with a forged prefix;
  caveat recorded — an all-trusted-hops chain resolves by
  definition of the trust list, a topology property, and a direct
  public peer's XFF is ignored outright). C9 auth half FIXED
  (shared baseUrl(req) helper — A-09 expression — applied to
  Google/Facebook start+callback and the forgot link; no-BASE_URL
  boot now emits absolute redirect_uris; admin half routed to
  D-FIX-B). C3 + C6 REPRODUCED but SPEC'd (they live in
  routes/player.js / routes/admin.js / views/security.ejs — routed
  to D-FIX-B with exact sites: player.js:878/886 + admin.js:
  3267/3280 for TOTP re-auth; player.js:758 for verify-email
  invalidation + limiter). D-FIX-A suite: 169 = 165 pass / 1 known
  BP-14 fail / 3 skipped (PG + the two spec placeholders).
  Observations routed onward: views/forgot.ejs never renders
  formError (a refused forgot POST shows NO reason — true-reason
  rule; one-line slot → D-FIX-B); views/login.ejs renders no
  captcha markup, so with the custom-captcha extension ON, login
  demands an answer the page never asks for (adjudicate → D-FIX-B
  view half / U-24).
- D1 (money & game logic) — COMPLETE (adj-discovery-money.md).
  PROVEN candidates (live UI-route repros on the snapshot):
  - D1-C1 Net-zero deposit can NEVER be approved: a 100% percent
    charge is saveable (validation rejects only negatives); approve
    posts a 0 ledger amount → throws "Invalid ledger amount" → the
    deposit is stuck pending forever. (Net-0 WITHDRAWAL approves
    fine — asymmetry proven. Residual edge of R-022.)
  - D1-C2 A zero-amount agent-commission row poisons that agent's
    settlement forever: referral accrual has a >0 guard, commission
    insert doesn't (a $0.05 ticket at 5% → row of 0); settle throws,
    row never clears, and the daily cron swallows it per-agent — the
    agent silently never auto-settles again.
  - D1-C3 Scratch buy ignores ends_at: only the 5-min cron lifecycle
    enforces the end date (and the cron is skipped entirely when the
    automation master is off); the lottery buy re-checks close_at
    in-txn, scratch doesn't. Expired series sold a ticket live.
  - D1-C4 Turnover gate counts fully-REFUNDED purchases as wagered
    (ticket_purchase summed with no draw_refund netting): deposit $1
    → buy → draw cancelled + refunded → gate still reads wagered=$1
    with $0 actually gambled.
  - D1-C5 cancelDraw reverses the stake but NOT the buy side-effects:
    (a) the refunded ticket's agent commission stayed payable and
    SETTLED (real money out on a refunded ticket); (b) bonus
    wagering progress stayed 100/100 after the only wager was
    refunded — the bonus became withdrawable with zero real wagering.
  - D1-C6 Agent transfer uses the WRONG DECIMALS: toMinor defaults to
    2dp instead of decimalsFor(currency) — on a 0-decimal currency
    (JPY) a "500" transfer moved ¥50,000 (100×). Player routes do it
    right. Same bare-toMinor pattern flagged in admin agent funding
    + manual adjustment (fix-wave cross-scope).
  - D1-C7 Agent transfer has NO server-side double-submit protection
    (no idempotency key/form token/rate limit; only the client-side
    button disable): two parallel identical POSTs both applied —
    double money movement, two identical transfer rows.
  Leads (unproven): player deposit/withdraw never pass a client
  idempotency key (engine supports it; weaker than C7); webhooks.js
  comment claims missing currency fails closed but code treats it as
  OK (signature+amount still gate); combinedDailyNetLoss doesn't net
  draw_refund (conservative direction); unguarded scratch-series
  status UPDATEs (SQLite-backstopped, no repro); agent transfer form
  hard-labels "Amount (USD)" while currency is selectable (display).
  SWEPT CLEAN: guarded transitions on all money statuses (incl. 3
  parallel reveals → exactly one credit); OWN-01 re-audit — every SUM
  in scope checked against all 16 ledger types, none missing; engine
  amount validation; scratch sold-out/commitment checks; settle/roll
  math for thresholds ≥1; bonus budget caps; planner edges; reconcile.
  Verified still holding: webhook fail-closed (U-21); the threshold-0
  trap is refused at the only operator entry point (engine-level
  wait-forever reachable only by direct DB write — correctly NOT a
  finding); R-022 fee caps present on both deposit and withdrawal.
- D3 (scheduler/cron/notifications) — COMPLETE
  (adj-discovery-cron.md; delivered copies read from a local SMTP
  sink, cross-checked against notifications_log + DB). Per-job
  table: 11 jobs exercised — clean_sessions, reconcile_ledger
  (caught a planted +999 mismatch loudly), clean_tokens,
  settle_agent_commissions, scratch_lifecycle, backup_db (retention
  exactly 7) all EXACT. PROVEN candidates:
  - D3-C1 Scheduler has NO re-entrancy guard: next_run_at is written
    only after a handler finishes — with a slow (75s) SMTP sink, one
    queued notification row was DELIVERED TWICE by overlapping ticks;
    the log row ends innocently "sent".
  - D3-C2 ensure_draws reports FALSE SUCCESS: per-draw settle errors
    are caught into the results array and the handler reports
    "settled N" including failures — with a dead beacon, a draw
    stayed unsettled while the Automation Console showed the green
    row and "No failed automation runs recorded." (The owner's
    no-silent-death automation rule, violated in the reporting.)
  - D3-C3 Bonus drops silently DESTROYED: runScheduledDrops stamps
    last_drop_at even when the campaign skipped (engine off), and
    the cron message claims "drops fired (0 grants)" — the drop can
    never fire again even after the engine is re-enabled.
  - D3-C4 Queued notification batches are SINGLE-ATTEMPT: SMTP down
    at due time → failed forever; notifications off at due time →
    skipped forever. No retry/requeue exists anywhere.
  - D3-C5 Queued-batch inserts BYPASS the v20 log masking: the admin
    broadcast path INSERTs batch rows directly (routes/admin.js) and
    stored a RAW reset token in notifications_log; the v20 masking
    covers send/sendRaw only. Secret-at-rest in a log table.
  - D3-C6 Delivered withdrawal email says "rejectd": subject
    "Withdrawal rejectd", body "was rejectd" (status: decision+'d'
    string concat in decideWd + approvals path). Player-facing.
  - D3-C7 Direct mark-paid notifies NOBODY: no mail, no outbox row —
    the maker-checker path sends the 'paid' notice, the direct path
    doesn't. Same action, different truth to the player.
  - D3-C8 Admin-generated reset/verify links are RELATIVE without
    BASE_URL (admin.js ~1005/~1069 never got the A-09 host fallback;
    the player's own forgot mail in the same boot was absolute).
    Same family as D2-C9 — one fix pattern, two domains.
  - D3-C9 expire_deposits expires deposits WITH provider references
    (a 49h-old pending deposit carrying provider_txn_id was expired
    alongside the no-reference control), contradicting the handler's
    own "any reference stays pending" comment — and expired deposits
    cannot be approved, so a provider-paid claim becomes
    unrecoverable through the app.
  Templates live-verified clean from sink copies: welcome, player
  password_reset, player email_verification, otp_login (real code
  delivered; log masked — v20 masking confirmed on DELIVERED copies
  too), win (exact $13.00), support_reply, deposit approved/rejected
  (exact amounts), draw_cancelled (exact refund), ticket alerts,
  push/win (honest 'failed', never faked). Notes: the seeded email
  `otp` template has NO sending call site (dead template);
  `approval_rejected` is code-swept only (needs 2 approvers +
  maker-checker to trigger live).
  Leads (unproven): ensure_draws exposure-alert catch{} swallowing;
  runNow↔tick concurrency (same root as C1); scratch guardrail
  db.driver reliance; clean_tokens erasing OTP attempt counters
  (bounded); mailer transport cached at first send; cron
  schedule-save resetting next_run_at + Run-now on paused jobs
  (both appear by-design).
- D4 (pages) — COMPLETE (adj-discovery-pages.md).
- DISCOVERY FIXES — ALL 30 CANDIDATES FIXED (D-FIX-A auth domain;
  D-FIX-B money/pages/cron + cross-domain; 28 new regression tests;
  audit chain verified {ok:true} after all changes). Ledger-worthy
  specifics: D1-C4 shipped ONE shared netWagered() (purchases minus
  draw_refund, floored 0) feeding the turnover gate AND referral-
  credit release; lead L3 adjudicated STAND (the daily-loss limit
  deliberately does not net refunds — conservative direction).
  D1-C5 mechanism: bonus wagering is a STORED counter (not ledger-
  derived) → new bonus.reverseWagering (oldest-first, floored 0)
  called by cancelDraw per refunded user+currency; unsettled
  commissions for a cancelled draw are VOIDED (settled=1, voided=1,
  voided_at — never DELETEd, never settleable again); HONEST
  BOUNDARY: already-settled commissions are NOT clawed back (test
  proves them untouched; clawing back paid-out money is an operator
  decision, not an automatic one). D1-C7 design: one-time session
  token + agent_transfers.idempotency_key UNIQUE (migration v21) —
  the row inserts FIRST inside the transaction so parallel POSTs
  collide and the loser's debit rolls back. D2-C3 closed INCLUDING
  the passwordless branch (a set-password path exists at /security,
  so "set a password before enabling 2FA" is a complete flow, live-
  tested on a NULL-hash account). D3-C4: batches retry 3 attempts
  total with 60s backoff; due-while-off returns 'deferred'
  unconsumed (no attempt spent). Migration v21 (single, 3-driver,
  dirty-safe): commissions +voided/voided_at; notifications_log
  +attempts; agent_transfers +idempotency_key + UNIQUE index.
  D-FIX-B suite: 197 tests = 193 pass / 1 fail (BP-14, integration-
  owned) / 3 skipped (1 PG smoke + D-FIX-A's 2 C3/C6 placeholder
  skips, whose specs B fulfilled with its own tests). PROVEN candidates
  (on the snapshot boot; re-verify on the current tree before fixing):
  - D4-C1 Rejected deposit VANISHES in-app: after admin rejection the
    wallet shows nothing, /transactions has no row, the only notice is
    the rejection email (whose log row was status='failed' — no SMTP).
    A player who sent payment proof is told nothing anywhere in-app.
  - D4-C2 Out-of-range pagination renders FALSE empty states:
    /results?page=999 → "No results yet" + "Page 999 of 2"; same class
    on /transactions and /scratch/my-tickets. No upper clamp exists.
  - D4-C3 /fairness prints RAW badge HTML as text for TEST draws
    (verify.ejs:23 — U-01/U-24 class, new surface; the same pattern in
    results.ejs/index.ejs is unreachable behind is_test=0 filters).
  - D4-C4 Oversized form body → generic 500 (PayloadTooLargeError hits
    the 500 handler; should be a friendly 413) → routed to U-24's
    error-handler pass.
  - D4-C5 (small) Draft scratch series shows a "Live" status dot on
    the buy-error re-render (the 400 + true reason themselves were
    correct).
  Unproven leads (6, stay leads until proven): bogus referral code
  silently swallowed; /fairness?draw_id=abc silently blank (vs "Draw
  not found" for numeric misses); zero-amount ledger rows in neither
  credit nor debit filter + bogus ?type= shows all untabbed; results
  type filter is URL-only (no UI controls); maintenance nits
  (/register not allowlisted while /login is); sold-out series stays
  in lobby labelled Live/Remaining 0 (buy safely refused).
  SWEPT CLEAN with evidence: referral recording (query+body,
  case-insensitive, DB-checked), contact form end-to-end (validation,
  CSRF, 429, lands in contact_messages AND visible to admin),
  fairness verdicts (real MATCH incl. test-override + cancelled +
  no seed leak; scratch verify detects DB tampering), combined daily
  loss limit enforced on BOTH games, session limits on both games,
  RP clamping/pending decreases, maintenance core, announcements,
  CMS 404 discipline, currency switch, deposit verified-contact gate,
  agent area 403 for players, true empty states on empty accounts.
  (Finder also retracted one of its own early "failures" — a seeded
  fake win masking loss math; retested clean on a fresh user.)
- D1/D2/D3 — RUNNING.

### Coverage map (every surface named; status filled honestly)

- Public pages (home, results/draw detail, contact, CMS, announcements): U-03/U-09..U-13 (home) + D4 sweep — SWEPT (findings D4-C2/C3 + leads)
- Auth flows (register, login, forgot/reset password, verify email, complete-profile, OAuth): U-22 + D2 sweep — SWEPT (9 proven candidates D2-C1..C9; CSRF + rate-limit maps delivered)
- Player money (wallet, deposit, withdraw+verify, transactions): U-01/U-02 + D1/D4 sweep — SWEPT by D4 (D4-C1/C2/C4 candidates); D1 still running
- Player games (play, my tickets, scratch lobby/detail/my tickets, fairness verify): U-02/U-06 + D1/D4 sweep — ASSIGNED
- Player account (profile, security/2FA/sessions, KYC, support): U-01/U-04/U-14..U-19/U-25 + D4 sweep — ASSIGNED
- Agent area (dashboard, players, TRANSFER, tickets, commissions): U-20 exercise + D1 (transfer money path) — SWEPT by D1 (transfer findings D1-C6/C7; U-20 exercise still running)
- Admin console (all pages): U-20 behaviour pass — COMPLETE (U-20: ~120 controls exercised, 5 breaks fixed; U-26 organization still to run)
- Backend money/game logic (ledger, draws, scratch, prize engine, bonus, reconcile): D1 sweep — SWEPT (7 proven candidates D1-C1..C7; aggregates + transitions verified clean)
- Scheduler/cron + automation outputs (ensure_draws, settle, cleanup, backup, commission, alerts): D3 sweep — SWEPT (9 candidates D3-C1..C9; 6 of 11 jobs exact-clean)
- Notifications (email templates, outbox rows, triggers): D3 sweep + U-24 hand-check — SWEPT by D3 (templates live-verified from sink copies; findings inside D3-C4..C8; U-24 hand-check remains)
- Webhooks (payment callbacks): U-21 (verified paths) + D1 — SWEPT (fail-closed verified holding by D1; config completed by U-21)
- Display integrity (all roles, emails, error pages, flashes): U-24 sweep — QUEUED (final wave)

## U-27 — Register screen copy/layout + internal-language sweep (owner addendum, 2026-10-28 ~17:46 EDT)

Owner caught live-register wording under Phone: "Choose your country
code, then your number — no country is pre-forced." (verified:
views/register.ejs:39). "Pre-forced" is OUR internal build rule
leaked into customer copy — U-24-class internal-language leak.
Items: (1) the helper becomes plain customer language or goes;
internal rules are NEVER UI copy. (2) Sweep ALL visible copy
(public/player/agent/admin) for the class — internal rule
explanations, build terms, defensive/config-state phrasing — hits
logged as U-27.x with before/after. (3) The closed country select
truncates its placeholder at phone width ("Select country (") —
phone-row layout/select sizing fixed so text + chevron fit at
360px. (4) The agreement line garbles around its Terms/Privacy
links — one natural sentence at mobile width ("I confirm I am 18
or older and I agree to the Terms and Privacy Policy."), links
inline in reading order, checkbox aligned to the first line, 48px
target preserved. (5) Proof by fresh-boot rendered checks.

- U-27 — CORE DONE (U-27 worker; adj-u27.md). APPLIED: U-27.1 the
  "pre-forced" helper REMOVED (adjudicated: label + select text +
  placeholder already say it — a plain-language replacement would
  repeat all three word-for-word); U-27.2 select clipping fixed by
  construction (register-scoped CSS: 176px select split above
  400px, full-width STACKING at ≤400px so every "Name (+dial)"
  fits); U-27.3 agreement garble root-caused (the label was
  display:flex, making each text run and link its own flex item —
  prose now wrapped in ONE span, flows naturally, checkbox aligned
  to the first line, owner's exact sentence incl. final period,
  48px label target preserved); U-27.4 homepage "Secure Platform"
  mechanism-speak rewritten in plain words (reconciled with U-09's
  backed-claim test — one plain "servers" kept, the register gone);
  U-27.5 "Reveal is visual only" ×2 → plain language.
  PENDING-APPLICATION (exact after-text in adj-u27.md; files were
  owned/off-limits during the sweep → the U-24 wave applies them):
  U-27.6 buy error confesses "ticket signing is not configured" to
  the player (player.js); U-27.7 STRONG — the seeded TERMS page
  publishes a "Template notice" operator instruction at /page/terms
  (proven rendered; SEED half fixed by U-28.5; the marker-guarded
  heal migration for existing DBs — next free version v22 — is
  applied by the U-24 wave); U-27.8 raw setting key
  (admin_totp_required) as visible admin copy ×2 (admin.js);
  U-27.9 SYSTEMATIC — internal project codes (BP-21/22/23, R-044)
  as suffixes/labels across admin copy, 14 sites (admin.js +
  scratch.js); U-27.10 push card tells the operator to edit
  lib/notify.js (admin.js); U-27.11 scratch fairness steps in build
  register (scratch_detail.ejs); U-27.12 register POST says
  "disabled" where the app's own voice says "closed" (auth.js,
  one word — U-24 authorized to apply).
  NOT-HITS recorded with reasoning (comments are not visible copy;
  placeholder ATTRIBUTES never render the word; fairness artifact
  LABELS — seed hash/SHA-256/beacon — stay because verifiers must
  compare them; truthful empty states are the explicitly-fine
  class). admin-ui.js swept clean.
  OPEN INTEGRATION CHECK: U-27's suite run showed
  test/v20-admin-pass.test.js auto-withdrawal failing ("wd30 status
  undefined") — CHAIN was mid-edit on the admin/withdrawal files at
  that moment, so it is either a mid-edit flap or a §5.3
  regression. MUST re-run on the settled tree at integration; if it
  still fails, it routes to CHAIN's §5.3 changes first.

## U-28 — Owner-only information must never reach users (owner addendum, 2026-10-28 ~17:49 EDT)

Owner: "aisi koi bhi cheez user ko nahi pata lagni chahiye jo mujhe
pata lagni zaruri hai." Information-separation audit generalizing
U-24/U-27. Classification: (A) user-needed — the player's OWN
balances/tickets/draw state, true rejection reasons, limits as they
hit them, pay-to details of enabled methods — stays, plain
language; hiding class A would itself be a defect (the true-reason
rule stands). (B) owner-only — internal rules/build language, admin
existence/paths/capabilities beyond stealth, setting/key names,
provider configuration state, automation rules, prize-engine
targets/RTP/exposure numbers, risk/fraud thresholds, audit
internals, error internals, OTHER users' anything. Class B appears
NOWHERE a non-admin can reach it. Surfaces: rendered HTML incl.
page source (comments, data-attributes, hidden inputs, JS files,
inline scripts, meta), public JSON/API, player emails, error
pages/flashes, export endpoints (RBAC re-proved), robots/sitemap,
/healthz (minimal: ok:true only). Agents count as users for
owner-only data. Leaks = U-28.x GALTI with the surface named; fix +
crawl regression (owner-only markers absent from all non-admin
output).

- U-28 — AUDIT COMPLETE (U-28 worker; adj-u28.md; ~80-marker crawl
  over anon/player/cross-player/agent on seeded boots + SMTP sink).
  PROVEN CLEAN: winners identified by FIRST NAME ONLY on every
  public/cross-user surface (no surname/email/phone/id); public
  scratch "RTP %" is computed from the published tier table (class
  A) while the operator target/guardrail keys appear on NO
  non-admin response; unsettled draws expose hash only (planted
  seed absent from output), unrevealed scratch exposes commitment
  only; pay-to details hard-skip secret fields (regression plants
  real credentials through the admin form: address present, secret
  value AND key name absent, encrypted at rest); player emails
  clean (the admin note does NOT ride into mail); forced error
  pages carry status + friendly text only; robots/sitemap name no
  admin paths; agent area shows the agent only their own players/
  float/commissions/rate (console is stealth-404 for agents too);
  U-23 export routes re-proved stealth-404 for anon+player+agent.
  FIXED by the worker: U-28.2 /healthz → exactly {"ok":true} (was
  in routes/site.js; the BP-16 test conflict is the coordinator's
  queued integration update — U-28 contract stands); U-28.3
  rendered HTML comments carrying internals (login/play/security)
  → non-rendering EJS comments; U-28.4 public/app.js comments with
  build codes/admin references → plain product language (code
  byte-identical in behaviour); U-28.5 the Terms "Template notice"
  removed from the migrations SEED (= the seed half of U-27.7);
  U-28.6 verify.ejs wording (no more "admin audit log" citation /
  version language; formulas + TEST badge preserved).
  PENDING-APPLICATION → U-24 WAVE (exact fixes in adj-u28.md):
  - U-28.1 (MAIN HIT, live-proven) internal admin_note REACHES THE
    PLAYER: the separate "Admin note" form (admin.js) carries no
    player-visibility warning (the KYC reject form in the same
    file explicitly says "the player sees this"), yet the wallet
    Request-history card D4-C1 built maps admin_note → "Reason"
    and renders it for every status — a planted
    "fraud-watch do-not-tell" note displayed verbatim. The two
    fixes collide by design: D4-C1's class-A reason must stay, so
    the fields SEPARATE — note form relabelled internal, a
    dedicated player-facing decision reason added, player.js/
    wallet read ONLY the decision reason. A skipped regression
    test in v20-u28.test.js pins the expected behaviour; U-24
    implements + un-skips. (Deposits are safe by construction:
    their decision path takes no reason argument.)
  - U-28.7 public/style.css serves the headed ADMIN PANEL section
    + .adm* structure + build codes to everyone → split admin CSS
    into an admin-only stylesheet (don't just delete — the panel
    must keep working).
  - U-28.8 users.kyc_note mixes the internal verify attestation
    with the player-facing rejection reason → manual-verify clears
    it (attestation already lives in the audit log).
  - U-28.9 LATENT: rails.js PUBLIC_CONFIG_FIELDS includes `mode`
    (sandbox/live posture = class B); getPublicConfig has no
    player consumer YET, but CHAIN §5.3 wired gatewayPublic into
    the deposit route → U-24 removes `mode` from the public fields
    BEFORE rendering the gatewayPublic leg in deposit_new.ejs
    (CHAIN's spec'd leg, same wave).
  - U-28.10 LATENT: server.js sets res.locals.adminPath on EVERY
    request (proven: no player view renders it today) → restrict
    the local to admin renders (U-24, server.js error-path wave).
  U-28 suite: 229 = 222 pass / 3 fail (BP-14, BP-16 — both queued
  integration updates; admin-pass — the §5.3 test-fields issue,
  same queue) / 4 skipped.

## Integration notes (coordinator)

- MID-ROUND SUITE RUNS ARE NOT VERDICTS: with five+ workers editing
  concurrently, a parallel full-suite run showed 135 tests = 110 pass
  / 24 fail / 1 skip — 23 failures in other workers' in-flight files
  (BACKEND's U-02/U-04/U-15/U-16/U-18/U-19/U-25 tests, BP-14, SCAN
  http) and 1 identity test that fails only under parallel load
  (13/13 standalone; cross-process contention + mid-run lib/auth.js
  edits by the running BACKEND worker). The authoritative count is
  the coordinator's integration run on the SETTLED tree.
- INTEGRATION ACTIONS QUEUED (coordinator, settled tree):
  (1) BP-14 test (v19-features) — update the UA-verbatim assertions
  to the U-04 human-label contract (unblocked: ACCOUNT's security
  rebuild landed). (2) v20-admin-pass auto-withdrawal test — the
  U-27-run failure is EXPLAINED (CHAIN adjudication): the test
  posts the OLD deposit fields for a withdrawal, which §5.3 now
  correctly refuses; update the test to post the real payout
  fields (custom_account_name / custom_account_number /
  custom_bank_name) and re-run — the behaviour itself must pass.
  This CLOSES the former open check: not a flap, not a product
  regression — a test encoding the pre-§5.3 bug. (3) BP-16
  /healthz `time` field: the v19 test expects it; the owner's
  U-28 instruction (NEWER, explicit) requires healthz =
  {"ok":true} ONLY. U-28 wins: at integration, align the BP-16
  assertion to the minimal contract. (4) OPTIONAL, only if the
  mandatory battery is green: server.js scoped multipart parser
  for the import route (CHAIN spec) to upgrade paste-in CSV to
  file upload.

- The v19 BP-14 test asserting the sessions page shows the user-agent
  "verbatim" is SUPERSEDED by the owner's U-04 order (raw UA must NOT
  be shown). It fails against the U-04 rebuild by design, not by
  regression. Coordinator updates that test's expectation to the U-04
  contract (parsed device · browser shown, raw UA absent) during
  integration, once U-04 lands.

## U-22 — One identity = one account (owner addendum, 2026-10-28 ~16:35 EDT)

No duplicate account via ANY creation path (form register, Google
OAuth, Facebook OAuth, phone path, staff-created if it exists). Same
email OR same phone → no second account, true-reason refusal; OAuth
with provider-verified email matching an existing account lands on
THAT account + records the provider link; unverified provider email
fails safe (no merge, no twin; message points to sign-in + in-account
linking). DB backstop: unique indexes on normalized email/phone where
the schema supports them, migration proven duplicate-free on a fresh
DB. Tests assert users-count across register↔OAuth in both directions.

- U-22 — DONE (identity worker: per-path adjudication in
  adj-identity.md; fixes in routes/auth.js; migration v20 unique
  indexes WITH a dirty-DB preflight — checks for existing duplicates
  first and skips loudly rather than crashing the boot; lib/auth.js
  needed NO change, the oauthAccountCheck concern did not materialize;
  manual curl E2E: register → duplicate refused with true reason →
  users count stays 1, migration v20 recorded; own tests 13/13
  standalone)

## U-23 — Admin data import / export (owner addendum, 2026-10-28 ~16:35 EDT)

EXPORT: admin-only, RBAC-gated, audit-logged CSV downloads with human
headers (users, ledger/transactions, tickets+entries, draws/results,
deposits, withdrawals, agents, support tickets), date-range filters,
streamed/capped honestly, dataset+date filenames; players never reach
the routes (stealth/RBAC test proof). IMPORT: money data NEVER directly
importable (stated in the UI itself); only adjudicated-safe non-money
master data, via upload → dry-run validation report (per-row reasons,
duplicate detection) → explicit execute → audit entry; re-importing
the same file adds 0 (natural-key dedupe, double-import test). If no
dataset adjudicates safe: export-only + validator as preview, honestly
recorded — no fake import.

- U-23 — PENDING (dedicated worker in the wave after the U-20 pass
  frees routes/admin.js; see coordinator notes)

## U-24 — No raw output anywhere (owner addendum, 2026-10-28 ~16:35 EDT)

Generalizes U-01 into a display rule: any user-visible HTML/entities
as text, raw JSON, undefined/NaN/[object Object], stack traces, SQL/
internal error strings, raw snake_case enum labels, or unexplained
bare internal IDs = GALTI, in all three roles. Labelled technical
references (transaction refs, seed hashes on fairness pages) stay —
the rule is "no UNEXPLAINED code". Includes: crawl regression test
over the main rendered pages (player/agent/admin, seeded boot),
hand-checks of emails / forced error pages / flashes, and the global
error handler proven to render a friendly page with a short reference
code whose detail is findable in the server log.

- U-24.x findings — PENDING (display-integrity worker, final sweep
  wave, after the view-owning workers finish)

## U-25 — Support ticket soft delete (owner addendum, 2026-10-28 ~16:36 EDT)

SOFT delete both sides. Migration v19 (coordinator-added, verified):
support_tickets.deleted_at + deleted_by. Normal queries everywhere
exclude soft-deleted; admin "Deleted" filter views them read-only;
audit entry per delete. Player deletes own (open ticket = withdrawn;
other's ticket = IDOR-refused); staff delete within existing RBAC
scope; counts exclude deleted; deleting sends NO email; replies to a
deleted ticket refused with true reason by both sides. U-19 interplay:
24h creation cap counts creations INCLUDING later-deleted (no quota
refund); open cap counts live open tickets only (withdrawing frees
the slot). U-18 interplay: deleted ticket accepts no replies.

- U-25 — PLAYER SIDE DONE (backend worker: POST /support/:publicId/delete — sets deleted_at/deleted_by, audit action support.delete, NO email; list/detail/close/reopen/reply all exclude deleted; detail is a plain 404 and foreign/missing/already-deleted all return the identical "Ticket not found." — no existence leak; caps implemented exactly: 24h creation count includes later-deleted, open count is live-only so delete frees the slot. Player Delete MARKUP DONE (account worker: plain POST form matching the app's existing player close/reopen pattern — no confirm, no new pattern — on the support LIST (views/support.ejs) and detail (support_view.ejs). Coordinator-brief correction recorded: the brief named views/tickets.ejs, which is the LOTTERY ticket list; the worker proved the support list is support.ejs and placed the action there. Staff side → ADMIN worker in flight)

- INTEGRATION RESULTS (coordinator, settled tree, 2026-10-28):
  (1) BP-14 assertions updated to the U-04 human-label contract
  (device label present, raw UA absent, sessions counted as cards);
  (2) admin-pass auto-withdrawal test now posts the real §5.3
  payout fields — PASSES (the refusal of the old shape is §5.3
  working); (3) BP-16 healthz assertion aligned to the U-28
  contract (exactly {ok:true}). Affected files re-run: 18/18.
  FULL SUITE (settled tree): 256 tests = 253 pass / 0 fail /
  3 skipped (1 PG smoke — no live Postgres in the sandbox;
  2 D-FIX-A spec-pointer placeholders whose specs D-FIX-B
  fulfilled with its own passing tests).
  COORDINATOR E2E BATTERY (fresh boot, 34 legs): 30 direct PASS;
  E-07b + E-10b PASS in substance — verbatim texts captured
  ("Not enough balance: this ticket costs $2.00, but your USD
  wallet has $0.00 — you are $2.00 short. Add funds, or lower
  your wager or number of pops." / "You already have 2 open
  support tickets — the limit is 2 at a time. Please wait for a
  reply on an open ticket, or close or delete one, before
  opening another."); E-11b harness error (battery used
  ?view=deleted; the implemented list filter is ?deleted=1 —
  behaviour covered by the passing U-25 tests + battery
  E-11a/E-11c); E-13a battery ENV omission — the credentials
  handler FAILS CLOSED without CREDENTIAL_ENCRYPTION_KEY
  (refuses with the true reason + audit row, zero rows written);
  with the key set, the re-run proved rows saved field_enc=1
  (AES-GCM v1: envelopes), the pay-to email on the deposit
  page, and the manual deposit queued with encrypted
  user_data. Audit chain verified on the battery DB via the
  Audit Trail page banner. Migrations: fresh boot reaches
  v23 (U-24 also proved the v21→v23 upgrade path).
  (4) OPTIONAL multipart import upload: NOT implemented —
  paste-in CSV import works and is honestly labelled in the
  UI; end-of-round server.js surgery was not justified.
  Recorded in FIX-LOG-V20's readiness split.
