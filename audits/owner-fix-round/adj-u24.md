# U-24 — FINAL WAVE adjudication (v20 owner-fix round): display integrity + all pending applications

Worker: U-24 (final wave). Files touched: `server.js`, `views/error.ejs`,
`views/deposit_new.ejs`, `views/scratch_detail.ejs`, `views/transactions.ejs`,
`routes/player.js`, `routes/admin.js`, `routes/auth.js`, `routes/scratch.js`,
`lib/money.js`, `lib/migrations.js` (append v22 + v23 only), `lib/rails.js`,
`lib/admin-ui.js`, `public/style.css` → `public/admin.css` (split),
`test/v20-u24.test.js` (new), the one un-skip edit in
`test/v20-u28.test.js`, and two contract updates in OTHER workers' test
files, each forced by a spec this wave was ordered to apply (flagged
loudly in §B-11 — coordinator to note at integration).
NOT touched: LEDGER.md, `test/v19-features.test.js`,
`test/v20-admin-pass.test.js`, anything in cash-pop-push/. No push, no deploy.

E2E: port 4149, fresh SQLite per test boot, SMTP sink 4428.
Regression: `test/v20-u24.test.js` — 15/15 PASS.

---

## PART A — CORE SWEEP (no raw output anywhere)

Method: seeded boot (players with real activity — lottery ticket,
scratch ticket, deposit, support ticket — plus agent and admin),
rendered the main pages in all four roles and scanned VISIBLE text
(tags/scripts/styles stripped, entities decoded) for: HTML tags or
entities as text, raw JSON blobs, `undefined`, `NaN`,
`[object Object]`, stack traces, error class names, SQL/internal
strings, raw snake_case enum labels, unlabelled internal IDs.

### Fixes (U-24.x)

- **U-24.1 — Fraud flags showed the raw enum + a raw JSON blob
  (admin).** The Flags page and the user-detail Fraud flags card
  rendered `flag_type` verbatim (`shared_device`) and the stored
  detail as a JSON string (`{"flag":"shared_device","other_user_id":2,
  "ip":"::1",…}`). Fixed in routes/admin.js: `FLAG_LABELS`
  (`shared_device` → "Shared device / IP") and `flagDetailText()`,
  which renders the detail as readable text ("IP ::1 · shared with
  user #2 · device: …"); unknown keys fall back to spaced words,
  never JSON punctuation. Proven in the crawl + test.
- **U-24.2 — Transactions label map missed four ledger types
  (player).** views/transactions.ejs fell back to spaced raw text for
  `agent_commission`, `agent_funding`, `withdrawal_release`,
  `withdrawal_revoke`. All four now have proper labels ("Agent
  commission", "Agent funding", "Withdrawal released", "Withdrawal
  reversed"). The map now covers every type the engine writes.
- **U-24.3 — (folded into U-24.2; numbering kept for the crawl log.)**
- **U-24.4 — Raw snake_case enum labels across admin tables/selects.**
  Found by the extended admin-detail crawl (see below):
  (a) ledger `t.type` rendered raw in the user-detail Recent
  transactions table and the Reports → Transaction table
  (`scratch_purchase` etc.) → shared `TX_LABELS` map + `txLabel()`
  in routes/admin.js (fallback = the CSV humaniser, never raw);
  (b) bonus campaign/grant tables rendered raw `audience`
  (`first_n`) and `trigger_type` (`first_deposit`) → `BONUS_AUDIENCE_
  LABELS` / `BONUS_TRIGGER_LABELS`, and the create-campaign selects
  now carry {value, label} option pairs ("First N", "First deposit", …);
  (c) the KYC Gate scope select (Settings + KYC queue door) showed
  the option text `deposits_and_withdrawals` → options are now
  "Withdrawals only" / "Deposits and withdrawals" (values unchanged),
  help text reworded to match;
  (d) the payment-method Rail select listed raw rail keys
  (`mobile_money`, `bank_transfer`, …) → options now use each rail's
  human name (values unchanged).
  Single-word option values that ARE plain words (active / settled /
  manual / published / super / finance / twilio …) were adjudicated
  NOT hits and left alone.
- **U-24.5 — Bonus "Audience N" label carried raw enum values**
  (`for first_n / random_n`) — referred to this wave by U-27's
  NOT-HITS. Label is now "Audience N (for the First N and Random N
  options)".

### Adjudicated NOT-hits (with reasoning)

- **Fairness formulas (verify.ejs).** The visible tokens `seed_hash`,
  `winning_number = reject_sample(SHA256(seed + '|' +
  beacon_randomness), draw_id)` are code-formatted verifier math on
  the dedicated Fairness page — the artifacts a verifier must compare,
  protected by U-27's NOT-HITS and U-28.6, and by Part A.6 of this
  wave's brief ("labelled technical values STAY"). Left.
- **Audit-trail detail JSON** (Audit page, dashboard Recent audit
  activity, user Activity timeline). The detail column is a LABELLED
  evidence record on operator-only surfaces — the same "labelled
  technical values stay" class as fairness hashes and transaction
  references. The one workflow surface in that family (fraud-flag
  review) was humanised (U-24.1); the evidence log itself stays.
  (This is also where the crawl's last user-page token,
  `terms_accepted_at`, lives — inside a `user.register` audit detail.)
- **Form plumbing.** Hidden inputs / field names / option VALUES /
  URLs carrying snake_case (`method_id`, `f_name`, `?f=pending_review`,
  export dataset slugs in form actions) are not visible text; every
  corresponding LABEL is human. Not hits.
- **Template slugs in admin tables** (notifications list shows the
  slug in a code span BESIDE its human subject) — labelled technical
  identifiers, the operator's handle for the template. Stay.
- **Content-block editor (admin)** shows a block's HTML source inside
  its textarea — that IS the editing surface for operator-authored
  HTML, not leaked markup. Not a hit.
- **Player/agent surfaces overall:** after U-24.2, the visible-text
  snake_case scan is empty on every player and agent page crawled.

### Swept clean (named, no fix needed)

- Anon: home, results, fairness (settled + index), scratch lobby +
  detail, login, register, contact, terms, privacy, how-it-works.
- Player: home, play, wallet, profile, security, tickets, ticket
  detail, transactions, scratch lobby/detail/my-tickets/ticket/verify,
  support list + view, KYC, deposit, withdraw, announcements, results.
- Agent: dashboard, players, add-player, transfer, commissions,
  support list.
- Admin (main + detail crawl): dashboard, deposits list + detail,
  withdrawals list, users list + detail, agents, draws list + detail,
  tickets, scratch list + series detail, support queue, KYC queue,
  settings, automation, bonuses, notifications (all five tabs +
  template edit), methods list/edit/new/credentials, reports (all six
  types), audit, data, security, extensions list + configure, cron,
  pages list/edit/new, content edit, referrals, flags, OTP, login
  history, staff, approvals, reconciliation, contact messages,
  canned replies. (Admin ticket-detail and support-detail pages were
  not re-rendered in the detail crawl — the seed DB had no rows for
  them; both were reached 200 by U-26's full click crawl and follow
  the same table builders swept here. Withdrawal detail WAS rendered
  and asserted in the U-28.1 test.)

### A.2 — Error handler (server.js + views/error.ejs)

Before: the global handler rendered the friendly page but with NO
reference code — a user quoting "something went wrong" gave support
nothing to find. After: every unexpected error gets a short reference
code (`E` + base36 time + 4 hex chars). The page shows ONLY the
friendly message + `Reference: <code>`; the full error goes to the
server log as `[error] ref=<code> …` AND to the audit trail
(`error.unhandled`, entity_id = the code, detail = method/path/
message) — so the code is findable in both places.
PROOF (live, this build): a malformed cookie
(`sid=%E0%A4%A`, decodeURIComponent throws in the cookie middleware)
returned 500 with `Reference: EMVSOKQMJA5E7`; the server log contains
`[error] ref=EMVSOKQMJA5E7` and audit_log contains an
`error.unhandled` row with entity_id `EMVSOKQMJA5E7`. The committed
test re-proves all three legs with a fresh code. The 500 page carries
no error class, no stack, no SQL (asserted).

### A.3 — D4-C4: oversized body → friendly 413

Body-parser's PayloadTooLargeError previously fell into the generic
500. The handler now maps `entity.too.large` / status 413 to a 413
render in the same friendly family with the true reason ("That
submission was too large to process. Please go back and try again
with less data."; the error view's heading map gained "Submission
too large"). A malformed body (`entity.parse.failed`) likewise maps
to a friendly 400 ("That submission could not be read…") instead of
a 500. PROOF: a 2.6 MB urlencoded POST to /contact returned 413 with
the reason and no error-class leak (manual + committed test).

### A.4 — 400/403/404/500 as player and anon

Read live on this build: 404 (both roles — "Page not found", correct
status, no internals), 403 (session-less POST — "Security token
mismatch…", 403), 400 (malformed JSON → friendly 400; money-flow buy
with no pops → U-02's 400 re-render), 500 (above). All human wording,
correct status codes, zero internals. Committed tests cover each.

### A.5 — Emails re-verified on THIS build (SMTP sink)

Delivered copies read from the sink on this build: welcome (own name,
no placeholders, no HTML-as-text, no internal wording); deposit
rejected (correct spelling/amount, NO internal admin note, no
placeholders); withdrawal decided — the template changed since D3 —
rejected WITH and WITHOUT a player-facing reason (correct "rejected"
spelling, no internal note in either copy, no placeholders). The
player-facing reason itself travels in-app (wallet), as D4-C1
designed; mail carries status + amount.

### A.6 — Labelled technical values stay

Fairness hashes, revealed seeds, commitment/nonce labels, transaction
references (`public_id` under "ID"/"Reference" labels), provider
payout IDs, template slugs (admin, beside human subjects), and the
gateway publishable key (§B chain leg, with its plain-word label) all
remain — the rule applied throughout is "no UNEXPLAINED code".

---

## PART B — PENDING APPLICATIONS

### U-27.6 — buy error confession removed — APPLIED verbatim
routes/player.js: "Ticket purchases are temporarily unavailable
because ticket signing is not configured. Please contact support." →
"Ticket purchases are temporarily unavailable. Please contact
support." (source-asserted in test; the path needs a missing HMAC
secret, which a booted server refuses by design).

### U-27.7 — Terms "Template notice" heal — APPLIED as migration v22
Seed half was already fixed by U-28.5 (verified: fresh DB terms body
has no notice). v22 (lib/migrations.js, identical REPLACE/LIKE SQL on
all three drivers — both functions exist with the same semantics on
sqlite/mysql/postgres) deletes the EXACT original paragraph
(`<p><strong>Template notice:</strong> …real-money play.</p>`, text
verified against the pre-v20 backup) from the terms page, guarded by
`slug='terms' AND body LIKE '%Template notice%'`. Marker discipline:
a row whose body lacks the marker is untouched; a row with the marker
phrase but a REWORDED paragraph is untouched (REPLACE matches only
the exact seeded paragraph). Proofs: in-process upgrade test +
server-level upgrade boot (below).

### U-27.8 — raw key `admin_totp_required` out of admin copy — APPLIED
Both sites in routes/admin.js (Security page paragraph ×2 variants +
the disable flash) replaced with adj-u27's exact after-texts, naming
the existing human toggle label "Admin TOTP required". Rendered
proof: admin /security visible text contains no `admin_totp_required`
and shows the plain wording (committed test). (The string remains as
a form field NAME in Settings — plumbing, not copy.)

### U-27.9 — internal project codes out of admin copy — APPLIED (14/14)
All 14 sites from adj-u27 (12 routes/admin.js + 2 routes/scratch.js)
replaced with the exact texts given: Exposure, Smart Prize & Profit
Engine, Exposure alerts, "Invalid prize-engine value: …", KYC
requirement for this user, Auto-withdrawal limit, KYC documents,
"…so it was removed.", "Simulate first (no save)", "Operator
pre-authorization: …", "KYC — identity verification", "Multiplier
simulator — nothing was saved", Prize Pool Planner, "Launch refused
by the prize guardrail: …". Same-class extra: the auto-approval stamp
written by lib/money.js into a withdrawal's internal note also
carried "BP-22" — stripped ("operator pre-authorization"). Remaining
BP-/R- strings in these files are code COMMENTS only (adjudicated
not-visible by U-27). Rendered proof: automation/settings/user/
scratch admin pages show no /BP-\d+|R-\d{3}/ in visible text.

### U-27.10 — push card — APPLIED verbatim
"plug an FCM/APNs provider into lib/notify.js" → "push notifications
are not set up yet." Rendered proof on Notifications → Providers.

### U-27.11 — scratch fairness steps — APPLIED verbatim
views/scratch_detail.ejs steps 1/2/4 replaced with adj-u27's
after-texts; step 3 kept. Rendered proof in the committed test.

### U-27.12 — "disabled" → "closed" — APPLIED
routes/auth.js POST /register refusal now matches the app's own
voice at GET /register and the OTP path: "Registration is currently
closed." (source-asserted; live refusal needs registration toggled
off, which the settings-cache timing makes a poor test target — the
string is the whole defect).

### U-28.1 — FIELD SEPARATION — APPLIED (the substantive one)

As-built design:
- **Schema (migration v23):** `decision_reason TEXT DEFAULT ''`
  added to BOTH deposits and withdrawals (mysql: plain TEXT, per the
  v17 kyc_note pattern; postgres: IF NOT EXISTS). `admin_note` is
  unchanged and is now internal-only by construction.
- **Admin forms (routes/admin.js):** both detail pages relabel the
  note form heading to "Admin note (internal — never shown to the
  player)". The reject AND revoke forms on both detail pages gained a
  player-facing field labelled "Reason shown to the player (the
  player sees this)" (the KYC reject pattern), name
  `decision_reason`, max 500 chars.
- **Decision flow:** `decideDep`/`decideWd` read `decision_reason`,
  pass it to the engine, and — when maker-checker queues the decision
  — store it in the approval's detail JSON; the approvals executor
  applies `det.decision_reason` when executing, so a queued rejection
  keeps its player reason.
- **Engine (lib/money.js):** `decideDeposit(db, id, decision,
  adminId, settings, decisionReason)` stores it on approve/reject/
  revoke; `decideWithdrawal(..., adminNote, decisionReason)` stores
  both separately. One deliberate behaviour change: a blank adminNote
  at decision time no longer WIPES a previously saved internal note
  (the old UPDATE overwrote admin_note with '' on every manual
  decision); an explicit note (the auto-approval stamp) still
  replaces it.
- **Player side (routes/player.js + views/wallet.ejs):** the wallet
  Request-history selects ONLY `decision_reason` and maps it to
  `reason` (label stays "Reason"); `admin_note` is never selected
  into the view model. Deposits adjudication (task item d): deposits
  got the SAME player-facing field (their decision path previously
  took no reason at all), because the wallet shows one Reason column
  for both kinds — the field is decision_reason or nothing, never an
  internal note.
- **Mail:** decision mails carry status + amount only (unchanged
  templates); the internal note was proven absent from delivered
  copies in both the with-reason and note-only cases.
- **Regression:** the pinned test in test/v20-u28.test.js is
  UN-SKIPPED and passes (deposit: internal note + reject with no
  player reason → wallet shows Rejected, note absent). The committed
  U-24 test extends it: deposit rejected WITH a player reason shows
  that reason; withdrawal rejected WITH a reason shows it; withdrawal
  with ONLY an internal note shows status and no note text on the
  page or in the delivered mail; DB rows prove the two fields stay
  separate and the internal note survives the decision.

### U-28.7 — Admin CSS split — APPLIED

public/style.css served the headed ADMIN PANEL section + all .adm*
rules to everyone. Split mechanically with a CSS parser (original
formatting preserved for unmixed rules):
- **Accounting:** before: 779 rule blocks / 979 selectors in
  style.css. After: 675 rules in style.css + 105 rules in
  public/admin.css (= 780 blocks — one mixed media rule, the 760px
  scratch block, was split into its public and admin halves).
  Selector-level accounting is EXACT: 979 selectors before = 979
  after, zero missing, zero extra, and the partition is clean (no
  admin selector remains in style.css; no non-admin selector sits in
  admin.css).
- **What moved:** every rule whose selectors are all admin-scoped
  (.adm*, .adm-*, .admin-*) plus the provably admin-only unprefixed
  classes (adm-form, adm-side-foot, share-*, daybar*, sumstrip,
  filter-form, heat/heat-cell, tabs/tab, ball-sm, prize-grid,
  admin-scratch-grid). **Agent adjudication (done BEFORE moving):**
  agent views use NO .adm* classes and none of the moved unprefixed
  classes (they use agent-nav, kpi/kpis, card, tbl, msg — all shared
  rules that STAY in style.css; .msg/.form-stack were checked and
  kept public because player/agent views use them). The moved rules
  keep their original relative order inside admin.css, which the
  admin layout links AFTER style.css (same cascade position class —
  all moved rules out-specify or follow their shared counterparts).
- **Wiring:** lib/admin-ui.js `layout()` — the single head used by
  every admin page incl. the scratch admin pages (routes/scratch.js
  renders via ui.layout) — now links /admin.css after /style.css.
  Player + agent pages render through views/layout.ejs, which does
  not reference it. server.js's asset-version hash now includes
  admin.css so panel stylesheet changes bust cache too.
- **Proof (committed test):** admin HTML contains /admin.css and
  /style.css; a player page and the agent dashboard contain no
  admin.css reference and render 200 with their markup intact;
  style.css on disk contains no `.adm`/`.admin-` selector; admin.css
  holds the panel rules (≥100 blocks). U-26's per-role nav crawls and
  the full admin crawl pass unchanged on the split stylesheets.

### U-28.8 — manual KYC verify clears kyc_note — APPLIED
routes/admin.js `/users/:id/kyc-verify` now sets `kyc_note = ''`
(the attestation text still goes to the audit log on the same
request — proven: after a manual verify, users.kyc_note is '' and
the `kyc.manual_verify` audit row carries the attestation).

### U-28.9 — `mode` removed from PUBLIC_CONFIG_FIELDS — APPLIED (before the chain leg)
lib/rails.js: cards → ['provider', 'publishable_key'], paypal →
['client_id']. Sandbox/live posture is owner-only; publishable key /
client_id stay public-by-design. See §B-11 for the one test-contract
consequence.

### CHAIN LEG — gatewayPublic rendering in deposit_new.ejs — APPLIED
routes/player.js already passed `gatewayPublic` (adj-chain §5.3);
the view ignored it. views/deposit_new.ejs now renders, when the
list is non-empty, a "Payment gateway details" block under the
receiving details: each entry as `Label: value` (plain-word label
from the rail's field definition, value in a code span) — exactly
the spec'd surface, nothing more. Post-U-28.9 the field set is
class-B-free by construction, and getPublicConfig hard-skips
secret/password fields. Proof (committed test): a cards method
configured through the real admin form (publishable key + sandbox
mode + two secrets) renders the publishable key with its label on
the player deposit page, and neither "sandbox", the secret key, nor
the webhook secret appears anywhere in the page.

### U-28.10 — res.locals.adminPath restricted — APPLIED
server.js built res.locals with `adminPath: ADMIN_PATH` for EVERY
request. Now, after the locals are built, the local is deleted for
every request not already under the console path
(`req.path === ADMIN_PATH || startsWith(ADMIN_PATH + '/')`). Admin
pages are unaffected: they receive the path explicitly as
ui.layout's `adminPath` argument from `req.adminPath` (server-side,
unchanged), which the full admin crawl + U-26 tests re-prove.
Proof adjudication: grep proves NO player/agent view reads the
adminPath local, so the observable contract is (a) the console path
string appears in zero non-admin responses (asserted for player,
agent, anon in the committed test — and independently by U-28's
marker crawl) and (b) admin rendering is unchanged. A locals-
inspection probe would need a test-only route in production code;
the rendered-output contract is the cleaner proof and is what a
future template slip would actually break.

### U-26 §8 — scratch admin pages pass the role — APPLIED
routes/scratch.js: all four ui.layout calls in the admin router (the
two page renders named in adj-u26 §8, plus the planner render and
the 404 render — the same one-line change, so staff roles see their
filtered nav on every scratch-admin render) gained
`role: (req.user && req.user.admin_role) || 'super'`, matching
routes/admin.js shell()'s exact expression.

---

## B-11 — Test-contract updates in other workers' files (coordinator: note at integration)

Two test files outside my ownership encode contracts that specs
THIS wave was ordered to apply have superseded. Both updates are
minimal, commented in place, and called out here rather than hidden:

1. **test/v20-discovery-fixes.test.js (D4-C1)** — adj-u28.md's own
   §U-28.1 fix spec, step 3, orders this update: the test set the
   player's rejection reason via the internal `admin_note` form —
   the exact leak U-28.1 closes. It now saves an internal note (new
   marker text) AND posts `decision_reason` on the reject, asserting
   the reason reaches the wallet and the internal note does not.
   D4-C1's behaviour (a rejected deposit is visible in-app with its
   reason) is preserved and strengthened.
2. **test/v20-payments.test.js (U-21 public config)** — asserted
   `mode` IS part of getPublicConfig's output. U-28.9 (ordered in
   this wave, before the chain leg) removes `mode` from the public
   fields, so the assertion now checks the new contract (publishable
   key present, mode absent, secrets absent). This is the same class
   as BP-16's /healthz `time` expectation vs U-28.2 — a later,
   specific owner-fix instruction superseding an earlier test. If
   the coordinator prefers, reverting this one assertion returns the
   suite to 4 fails with this as the 4th, documented here either way.

NOT edited (per instructions): test/v19-features.test.js (BP-14,
BP-16) and test/v20-admin-pass.test.js (auto-withdrawal fields) —
their failures remain exactly the known integration-owned ones.

## Migrations — contents + upgrade proof

- **v22** "v20 U-27.7 heal: remove the operator Template notice from
  existing terms pages" — one marker-guarded UPDATE per driver
  (identical SQL; §U-27.7 above).
- **v23** "v20 U-28.1: player-facing decision_reason on deposits +
  withdrawals" — two additive ALTERs per driver (§U-28.1 above).
- **Fresh boot:** migrates cleanly to v23 (asserted: version rows,
  decision_reason columns present, terms seed clean).
- **Upgrade boot (server-level):** a DB constructed at v21 (v22/v23
  rows removed, decision_reason columns dropped, the OLD Template
  paragraph re-planted at the head of the terms body) was booted
  with the real server: /healthz 200, rendered /page/terms contains
  zero "Template notice", version reaches 23, columns present.
- **Operator-edited safety:** re-running v22 against a terms body
  that contains the marker phrase in operator wording changes
  nothing (asserted byte-identical in the committed test).
- **Audit chain:** verifies {ok:true} via the app's own
  lib/audit.verifyChain after the full U-24 flow set, and after the
  upgrade boot.

## Suite

- test/v20-u24.test.js: 15/15 pass. test/v20-u28.test.js: 8/8 pass,
  0 skipped (the U-28.1 test is live). test/v20-discovery-fixes
  .test.js and test/v20-payments.test.js pass with the §B-11 updates.
- Full suite (`node --test test/*.test.js`): see the worker's final
  report for the settled count — expected exactly the 3 known
  integration-owned failures (BP-14, BP-16 healthz, v20-admin-pass
  auto-withdrawal fields) after the §B-11.2 contract update.
