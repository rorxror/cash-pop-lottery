# U-28 — Information-separation audit (owner rule, 2026-10-28 ~17:49 EDT)

Owner: *"aisi koi bhi cheez user ko nahi pata lagni chahiye jo mujhe
pata lagni zaruri hai."* Anything that exists for the owner/operator
to know must not be discoverable by users. Class A = user-needed
(own data, true reasons, limits as hit, pay-to details of enabled
methods, public game math, provably-fair data as designed) — never
hidden. Class B = owner-only (internal rules/build language, admin
existence/paths/capabilities, setting/key names, provider config
state incl. sandbox/live posture, automation rules, prize-engine
TARGETS/exposure, risk thresholds, audit internals, error internals,
other users' anything).

Method: own boot on port 4145, fresh SQLite (/tmp/u28.sqlite,
/tmp/u28b.sqlite), SMTP sink; seeded players A/B (distinctive names
Zqxalice/Zqxbob), an agent, a settled + an unsettled draw (planted
seed marker `u28unsettledseedSECRET…`), a settled TEST draw, scratch
buys (unrevealed + revealed), a deposit rejected after an internal
note was planted (`U28INTERNALNOTE fraud-watch do-not-tell`).
Crawled as anon / player A / player B (cross-user) / agent and
grepped every response against a marker list built from the codebase
itself: the console path `/ops-7f3a9c-console`, ~80 setting keys
(enumerated from `getS/getBool` call sites + DEFAULT_SETTINGS in
lib/migrations.js), provider field names (webhook_secret,
client_secret, secret_key, api_key…), internal phrase class
(pre-forced, maker-checker, guardrail, target RTP, liability,
audit log, BP-/DS-/R- codes, admin_note, server_seed…).

## Classification adjudications (A vs B, with reasoning)

- **Winners identification — CLASS A as built, CLEAN.** Homepage
  ticker/grid and `/api/stats.recentWins` show the winner's FIRST
  NAME ONLY (`String(name).split(' ')[0]` in routes/site.js:33 and
  `w.name.split(' ')[0]` / initial in views/index.ejs), plus amount
  and date. No surname, email, phone or user id anywhere on a public
  or cross-user surface (crawl-verified: player B's full name/email
  appear on NO page served to player A or anon; only the first name
  in the winners ticker, which is the site's existing convention).
- **Public math vs operator targets — separated, CLEAN.** The
  scratch lobby's "RTP %" is COMPUTED from public data (published
  prize tiers × quantities ÷ tickets × price — the tier table itself
  is on the public detail page); that is the game's published math
  (A). The operator's TARGET (`scratch_planner_target_rtp` and every
  other prize-engine/guardrail/liability key) appears on NO
  non-admin response (crawl-verified). Play page prize multipliers =
  A, present as designed.
- **Provably-fair data — as designed, CLEAN.** Unsettled draw:
  `/fairness?draw_id=<unsettled>` renders seed `—`, hash only, no
  recomputed number (publicDrawInfo nulls seed/winning/beacon until
  settled; planted seed marker ABSENT — crawl-verified). Settled
  draw: revealed seed present — that is the feature (A). Scratch:
  unrevealed ticket page + verify page expose commitment only; the
  outcome nonce (read from DB) is ABSENT from both rendered pages
  (crawl-verified); verify computes only when status='revealed'.
- **Pay-to details — A, CLEAN in design; live re-proof in the
  regression test.** lib/rails.js getReceivingDetails hard-skips
  secret/password fields and only maps pay-to fields. (My manual
  crawl's credential save was refused because the test key was not
  64-hex — fail-closed, itself a good sign; the regression test
  plants credentials with a valid key and asserts address present /
  webhook-secret value + key name absent on the deposit page.)
- **Support caps — A as experienced, B as key names, CLEAN.** The
  player sees "you have N open tickets (max M)" style true reasons;
  the strings `support_max_open_tickets` /
  `support_max_new_tickets_24h` appear on no non-admin response.
- **Emails — CLEAN except as noted in U-28.1's evidence.** Delivered
  copies read from the SMTP sink: welcome (own name only), deposit
  rejected (own amount, NO admin note, NO reason field — the note
  does NOT ride into mail), withdrawal wording per D3-C6 fix.
  OTP/win/support templates were D3-verified; nothing owner-only
  found in the copies this round generated.
- **Error pages — CLEAN (information angle).** Forced 404 / 403
  (session-less POST) / 500 (3 MB body → global handler) render only
  status + friendly message ("Something went wrong. The team has
  been notified.") — no stack, SQL, error class or internal code.
  (Presentation angle stays U-24's; the 500-for-oversized-body
  status itself is D4-C4, already routed there.)
- **robots.txt / sitemap.xml — CLEAN.** robots: `Allow: /` + sitemap
  URL only; sitemap lists public pages only; neither names the
  console path or any admin/data path.
- **Export endpoints (U-23, landed during this round) — pattern
  re-proved in the regression test:** as anon/player/agent,
  `<console>/data`, `<console>/data/export/users`,
  `<console>/data/export/ledger` must return the stealth 404.
  (Crawl-1 already proved the console root + /scratch sub-path
  return plain 404 for anon AND player, with no redirect.)
- **Agent surfaces — CLEAN.** Agent crawl (dashboard, players,
  commissions, transfer, support, create-player): only the agent's
  OWN players, float, commission rows and rate (their class A). No
  setting keys, no other agents' data, no provider state, no prize
  targets. Agent hitting the console path gets the stealth 404.
  Player hitting /agent gets 403 (existence of an agent area is not
  owner-only — players are recruited by agents; the CONSOLE is the
  protected surface and it 404s).
- **Transactions type labels — observation, not a hit.** A ledger
  type missing from views/transactions.ejs's label map falls back to
  the raw type with underscores spaced (e.g. "withdrawal release").
  That is the player's OWN money vocabulary (U-24 raw-enum class),
  not owner-only data; left for U-24.
- **OTP `via` field — observation.** `/login/otp/request` returns
  `{via:'sms'|'email'|'sms-free'}`: a channel label, not config.
  'sms-free' faintly hints at a free SMS provider posture; only
  reachable when OTP sign-in is enabled (default off). Not charged;
  recommend dropping to channel-only values when next touched.

## Hits

### U-28.1 — Internal admin note on deposits/withdrawals is rendered to the player (PENDING-APPLICATION; live-proven)
- Surface: GET /wallet "Request history → Reason" column
  (routes/player.js:331-335 maps `admin_note` → `reason`;
  views/wallet.ejs:101 renders it for EVERY status incl. pending).
- Evidence (live, my boot): admin opened deposit DMVSNMB61B36037,
  used the separate **"Admin note"** form (routes/admin.js:1414-1415,
  label literally *Admin note / Note / Save note* — no "player sees
  this" warning, unlike the KYC rejection form in the same file,
  routes/admin.js:2032, which explicitly says *"the player sees
  this"*), saved `U28INTERNALNOTE fraud-watch do-not-tell`, rejected
  the deposit. Player's /wallet then showed verbatim:
  `Rejected | U28INTERNALNOTE fraud-watch do-not-tell`.
- Why B: for deposits the decision path (lib/money.js
  decideDeposit) takes NO note/reason argument at all — admin_note
  can only be written by the internal note form, so every deposit
  note is operator-internal by construction. For withdrawals,
  decideWd (routes/admin.js) calls decideWithdrawal WITHOUT a note
  (defaults ''), so withdrawal admin_note likewise comes only from
  the internal form. A fraud-watch remark, a PSP reference, a staff
  name — anything an operator jots there — reaches the player.
- The conflict: D4-C1 (landed, D-FIX-B) deliberately reused this
  field as the rejection "reason" (its test sets the note before
  rejecting and asserts the player sees it). That satisfies the
  true-reason rule (A) by spending an internal field (B). The
  disciplined fix SEPARATES them; deleting the column would kill a
  class-A reason, so I do NOT fix in views/wallet.ejs.
- Exact fix (pending, files owned by CHAIN/D-FIX workers):
  1. routes/admin.js deposit + withdrawal detail: relabel the note
     form heading to "Admin note (internal — never shown to the
     player)" immediately (one string each, ~lines 1414/1569), and
     add a player-facing "Reason shown to the player" field to the
     reject forms whose value is stored separately (new column or
     the decision call's note parameter, wired like
     decideWithdrawal's existing adminNote — deposits need the
     parameter added in lib/money.js decideDeposit).
  2. routes/player.js wallet handler (~331-335): build `reason`
     ONLY from that player-facing decision reason; never select
     admin_note into a player view model.
  3. Update test/v20-discovery-fixes.test.js D4-C1 to set the reason
     via the new field; keep its wallet assertion.

### U-28.2 — /healthz returns more than {"ok":true} (FIXED)
- Surface: GET /healthz → `{"ok":true,"time":1793224503698}`.
- routes/site.js:210 returned `time: Date.now()`. Server uptime /
  clock detail is not user-needed; the brief fixes the body at
  exactly {"ok":true}. Fix: return `res.json({ ok: true })`
  (503 {"ok":false} DB-down body unchanged — equally minimal).

### U-28.3 — Rendered HTML comments leak admin/config/build internals (FIXED)
HTML comments survive rendering (unlike EJS comments) and were
found in the served page source:
- views/login.ejs:9 `<!-- Social (only when admin enabled +
  configured) -->`; :22-24 "With OTP off (the default)…"; :33
  TOTP step; :49; :68 `<!-- OTP SIGN-IN (secondary, admin toggle
  only) -->`; :104. → reveals which sign-in providers/methods the
  OPERATOR has enabled/configured and that OTP is an admin toggle
  (provider configuration state, class B). Live-verified in the
  /login page source.
- views/play.ejs:10 `<!-- R-071: wallet currency picker. The buy
  handler debits the wallet… -->` — internal rule + build code;
  plus STEP/PRIZES/SLIP markers (harmless alone, same sweep).
- views/security.ejs:85 `<!-- R-122: … -->`; :99-105
  `<!-- BP-14 (v19) + U-04c (v20): own sessions from the DB session
  store… the raw user-agent never reaches this view… -->` — build
  codes + view-model internals in a player's page source.
- Fix: convert every `<!-- -->` in these three views to EJS
  comments `<% /* … */ %>` (never rendered) or delete; visible
  markup unchanged. Regression test asserts none of the marker
  phrases render.

### U-28.4 — Public app.js comments name internals (FIXED)
- public/app.js is served to every visitor. Hits: :477
  `/* Login: OTP flow (only rendered when admin enabled OTP) */`
  (admin-toggle state language), :635-639 canned-reply picker
  header `BP-15, staff support pages` + "staff review and press
  Send" (staff-workflow/build language), plus DS-/R-/SCAN build
  codes throughout comments (DS-023 :54, DS-041 :145/:176, R-120
  :246, DS-016 :333, SCAN/D-17 :640…).
- Fix: rewrite those comment headers in plain product language and
  strip the build-code tags from comments in public/app.js;
  behaviour/code identical. (The picker CODE stays: agents — users
  for this purpose — legitimately use it on their support pages;
  it carries no reply bodies or config.)

### U-28.5 — Public Terms page carries an operator instruction (FIXED, seed)
- Surface: GET /page/terms (anon) renders, as its first paragraph:
  "**Template notice:** the operator must replace this page with
  terms reviewed for their own licence and jurisdiction before
  offering real-money play." — an instruction TO the operator,
  served to the public (also BP-25 trust damage: the site reads as
  an unfinished template). Source: seeded PAGES row in
  lib/migrations.js (Terms of Service body).
- Fix: remove the Template-notice sentence from the seed. NOTE:
  pages are seeded once — an already-initialised DB keeps the old
  body until the operator edits the page in Admin → Pages; the fix
  protects every fresh install and the regression boot.

### U-28.6 — Fairness page names audit internals + build versions (FIXED)
- views/verify.ejs:31 (TEST-draw branch): "…set by the operator
  for testing (recorded in the admin audit log at creation)…" —
  audit-log internals + admin existence phrasing on a public page.
  :36 and :46: "Pre-v14 draw — legacy derivation" — internal
  version language. (The TEST badge itself stays: D4-C3 adjudicated
  that surface; the formulas in the How-it-works list are class-A
  verification math and stay.)
- Fix: "…was set for testing, so there is no derived number to
  recompute."; "Earlier draw — no beacon was recorded for this
  draw."; "Earlier draws with no beacon recorded used the legacy
  (HMAC(seed) mod 15) + 1 derivation."

### U-28.7 — Public stylesheet contains the admin panel's CSS + build codes (PENDING-APPLICATION, U-27 worker's file)
- public/style.css is served to everyone and contains a headed
  section `ADMIN PANEL (backend renders admin HTML with .adm
  classes)` (:544), "Admin supplement — classes used by the
  programmatic admin UI" (:1480), `.admin-scratch-grid` (:1549),
  "DS admin/public contrast repair" (:1674) and DS-/U- codes
  throughout — i.e. the console's existence and UI structure are
  discoverable from a public asset, plus U-27-class build codes.
- Why pending: style.css is the U-27 worker's owned file in this
  round, and the .adm rules are load-bearing for the admin UI
  (which loads the same stylesheet). Exact fix for the owner of
  that file / coordinator: serve the .adm* rules from a separate
  stylesheet referenced ONLY by lib/admin-ui.js's layout, leaving
  public/style.css player-only; at minimum strip the section
  headers/build codes. Do NOT just delete the rules — the panel
  would break.

### U-28.8 — users.kyc_note mixes an internal attestation with the player-facing rejection reason (PENDING-APPLICATION, low)
- routes/admin.js:1042-1044 manual KYC verify REQUIRES an internal
  attestation note ("record what was verified off-platform… by
  whom") and stores it in users.kyc_note — the same field the KYC
  rejection path fills with the player-facing reason, and which
  player surfaces render WHENEVER status='rejected'
  (views/wallet.ejs:10, views/profile.ejs:60, views/kyc.ejs:10).
  Normal flows are safe (verified status never renders the note,
  and a document rejection overwrites kyc_note with its reason),
  but an admin who sets kyc_status='rejected' from the user-edit
  form after a manual verify would surface the attestation text as
  if it were the rejection reason.
- Exact fix (routes/admin.js, CHAIN-owned): manual-verify sets
  `kyc_note = ''` (the attestation already lives in the audit log
  row written on the same request, :1045).

### U-28.9 — Latent: PUBLIC_CONFIG_FIELDS includes sandbox/live `mode` (PENDING-APPLICATION, not yet a surface)
- lib/rails.js PUBLIC_CONFIG_FIELDS maps cards/paypal to include
  `mode` — the gateway's sandbox/live posture, class B by the
  brief. getPublicConfig is currently called by NO player route or
  view (grep-verified: only test/v20-payments.test.js calls it), so
  nothing leaks today. Before the U-21 §5.3 player rendering lands,
  remove 'mode' from both maps (publishable_key / client_id /
  merchant_id are public-by-design and stay). File is CHAIN-owned.

### U-28.10 — Latent: console path sits in every player render context (PENDING, coordinator)
- server.js:244 puts `adminPath: ADMIN_PATH` into res.locals for
  EVERY request. Grep + crawl prove no player/agent view renders
  it today (the string appears in zero non-admin responses), so
  this is not a live leak — but any future `<%= adminPath %>` slip
  in a player template would publish the console path site-wide.
  Recommend (coordinator, server.js is outside my edit authority
  except healthz-class leaks): only set res.locals.adminPath when
  req.user is an admin, or drop the local and keep req.adminPath
  server-side. Not edited by me (a trust-proxy change by the
  coordinator sits in the same file; do not disturb).

## Surfaces proven clean (crawl + source grep)
Anon/player/agent responses for: home, results, fairness (incl.
unsettled + TEST), scratch lobby/detail/my-tickets/ticket/verify
(revealed + unrevealed), play, wallet (except U-28.1), profile,
security (except U-28.3 comments), tickets/transactions, KYC,
deposit (pay-to only), withdraw, support list/view, contact, CMS
pages (except U-28.5), announcements, /api/stats (first-name
winners only), /robots.txt, /sitemap.xml, /setup (404 when
disabled), error pages 400/403/404/500, delivered emails
(welcome, deposit-rejected), cross-user probes (B→A scratch
ticket/verify = 404; B's PII absent from A's pages), agent area
(own data only), console stealth (anon + player + agent = plain
404 on console root, /scratch, and — in the regression test —
/data + export paths).

## Results (post-fix)

Regression: test/v20-u28.test.js — 7 pass / 0 fail / 1 skipped
(the U-28.1 pending-application test, skipped with its reason in
the test name). Full suite on the settled-at-the-time tree:
229 tests = 222 pass / 3 fail / 4 skipped. The 3 fails:
(1) BP-14 sessions/UA — known, integration-owned (LEDGER already
records the coordinator will update that test to the U-04 contract).
(2) BP-16 healthz (test/v19-features.test.js:151) asserts the body
keys are exactly ['ok','time'] — a DIRECT conflict with this
round's brief, which fixes /healthz at exactly {"ok":true} and
required the deep-equal regression above. U-28 followed the brief
(the later, specific owner-fix instruction); the coordinator must
update BP-16's expectation to ['ok'] at integration, exactly like
the superseded BP-14 expectation. Flagged, not silently resolved.
(3) v20-admin-pass auto-withdrawal (wd30 row never created) —
fails standalone too, in the withdrawal creation path in
routes/player.js, which the CHAIN worker was editing concurrently
(mtime 21:53 during this round); no U-28 file touches that path
(U-28 changed routes/site.js healthz only, four views' comments /
wording, the migrations Terms seed string, public/app.js comments).
Coordinator to re-verify after CHAIN lands.

## Marker list (regression, test/v20-u28.test.js)
Derived from real codebase strings: `/ops-7f3a9c-console`,
setting keys [support_max_open_tickets,
support_max_new_tickets_24h, scratch_planner_target_rtp,
scratch_liability_cap_pct, scratch_guardrail_action,
automation_master_enabled, auto_withdrawal_limit,
maker_checker_threshold, draw_liability_alert, draw_threshold_day,
payout_lock_hours, admin_path, kyc_gate, blocked_rails,
sms_provider], provider-config vocabulary [webhook_secret,
client_secret, secret_key, U28WEBHOOKSECRETxyz (planted value),
provider_txn_id], internal phrases [pre-forced, admin_note,
server_seed, target RTP, maker-checker, guardrail, audit log,
"admin enabled", "admin toggle", Template notice, U28INTERNALNOTE
(planted note), the planted unsettled seed]. Asserted ABSENT from
every non-admin response crawled (anon + player + agent);
class-A controls asserted PRESENT (own balance, pay-to address,
settled seed on fairness, prize tiers, first-name winners).
