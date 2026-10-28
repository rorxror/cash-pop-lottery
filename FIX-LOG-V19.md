# FIX LOG — v19 round (blueprint + KYC + auto-withdrawal + prize engine + deep scan + tamper-proofing)

**Scope:** user-pasted external blueprint, adjudicated in
`audits/blueprint-round/VERDICT.md`, plus the user's same-day orders:
BP-21 KYC, BP-22 auto-withdrawal limits, a full deep scan with a
connections audit, BP-23 Smart Prize & Profit Engine, BP-24 open-idea
mandate, BP-25 trust pass, BP-26 server-authority/tamper-proofing.
**Working copy only (`~/workspace/cash-pop-fix/`). Nothing pushed,
nothing deployed; the live site still runs v17.1.**

## What was built (each with its behaviour proof)

- **BP-16 — /healthz with a real DB ping.** proof: fresh boot returns
  `200 {"ok":true}`; suite test kills the DB handle and observes 503.
- **BP-15 — Support canned replies.** Admin CRUD under the console's
  Support section; picker on admin AND agent ticket pages fills (never
  sends) the reply box. proof: E2E — created a reply, opened a real
  ticket, picker present with the saved body, reply sent, player saw
  it in their thread.
- **BP-13 — Player notification preferences** (win email, support-reply
  email; per-user toggles on the profile, honoured at the send sites).
  proof: E2E — win email suppressed after opting out (outbox row
  absent), support-reply email delivered while opted in.
  *Announcements DEFERRED: announcements have no email path in this
  codebase (in-app only), so there is nothing to toggle — recorded in
  the verdict, not faked.*
- **BP-14 — Session list on /security.** Real rows from the DB session
  store (sign-in time, IP, user-agent verbatim, expiry, "This session"
  badge); "sign out other sessions" uses the existing revoke endpoint
  (now audit-logged). proof: two live sessions listed; revoke-others
  left exactly the current one. *The store keeps no last-activity
  column, so none is shown — nothing fabricated.*
- **BP-17 — Docs pack.** docs/ARCHITECTURE.md, API.md, DATABASE.md,
  SECURITY.md, OPERATIONS.md, LEGAL-CHECKLIST.md — every fact checked
  against the code (53 tables, cron jobs, route surfaces, env names).
- **BP-21 — KYC system (ships OFF).** Master switch + gate scope
  (withdrawals / deposits+withdrawals), per-user override
  (default/required/exempt), player submission page (national ID /
  passport / driving licence; jpg/png/pdf, magic-byte checked, 5 MB),
  files in a private directory under random names, served only to the
  owner or staff; admin review queue with required reject reason;
  manual verify with a required note; every decision audit-logged.
  proof: manual E2E 35/35 — master OFF flows freely; ON blocks with
  the specific KYC message; reject → reason visible → resubmit →
  approve → withdrawal proceeds; 'required' alone gated with master
  OFF; 'exempt' never gated; bad extension and another user's document
  refused.
- **BP-22 — Auto-withdrawal limits.** Global setting + per-user
  override (NULL = follow global, 0 = never); at creation, after ALL
  existing gates pass, amount ≤ effective limit auto-approves
  (`decided_by` = system, audit `withdrawal.auto_approve` with the
  limit used). proof: manual E2E 15/15 — $30 auto-approved at a $50
  limit with no admin click, $80 stayed pending; per-user 10 made that
  user's $30 pending while another's still auto-approved; per-user 0
  and global 0 each stopped all auto-approval.
  *Auto = APPROVE-ONLY, stated plainly in the admin help text: this
  codebase has no gateway payout executor, so 'paid' still happens
  only via a real payout path or an admin mark-paid with a provider
  ID. The UI also warns that the limit deliberately bypasses
  maker-checker for small amounts. The R-044 history was checked
  first: the old `auto_approve_deposit_limit` row still exists but
  nothing reads it — this feature is wired and proven, not a field.*
- **BP-23 — Smart Prize & Profit Engine** (aggregate level only;
  outcomes stay provably fair — scratch predetermined + committed,
  pop beacon-derived). Prize-pool planner (price × count × target RTP
  → tier table + margin at 100/50/25% sell-through), launch liability
  cap, live guardrails (alert / close sales / stop auto-next), smart
  auto-next regenerated from the previous series' actual sell-through,
  pop multiplier simulator at the real sales mix, per-draw exposure
  with an alert threshold. proof: planner liability matched the target
  exactly on the sample series (7500 on $1×100@75%); guardrail alert
  fired on a rigged test series; a planned series launched, sold and
  revealed with commitment verification unchanged; simulator RTP
  matched hand-computed multiplier/15 for 3 pop counts.
- **BP-26 — Server-authority & tamper-proofing.** proof:
  `test/tamper.test.js` (3 tests) — a devtools battery (forged buy
  economics, dirty pops, invalid wager, forged scratch price/prize,
  reveal replay, IDOR, profile smuggling) asserting **persisted DB
  state from a clean connection after each attack** (the user's pass
  criterion: only a manipulation that crosses to the server and
  persists counts). Ledger + audit log verified append-only from
  source; the audit **hash chain** (present since v14) proven: one
  edited byte → verify names the exact row; a deleted row → chain
  fails; the admin Audit page verifies on every render. Full map:
  `audits/deep-scan-round/INTEGRITY.md`.
- **BP-24 — open-idea mandate:** no BP-24.x items were built. The scan
  produced fixes and the items above; nothing else met the bar
  (operator need + provable in-sandbox) without delaying committed
  work. No novelty was added for its own sake.
- **Packaging:** top-level README (unzip → install → boot → admin →
  payment method → money rehearsal) and a rewritten `.env.example`
  (it previously named two OAuth secrets the code never reads — a
  real GALTI, fixed; every env var the code reads is now listed).

## Deep scan (own section, per the user's classification)

Four read-only auditors → coordinator disprove pass → fixes →
re-verification. Full ledger: `audits/deep-scan-round/COMPILED.md`
(+ `area-A…D.md`, `INTEGRITY.md`).

- **GALTI: 31 found, 31 fixed.** Including three of this round's own
  bugs (BP-22's cap double-count, BP-14's POST-render breakage, KYC
  resubmit demoting verified users) and long-standing ones: dashboard
  RTP understating stake, a dead `language` switch, a CSP-killed
  currency switch, a fabricated "lucky number", an unowned support
  email in the footer, stub legal pages.
- **KAMZORI: 31 found, 27 fixed, 4 documented-not-fixed** —
  Postgres-only cap race (Phase-2 fix; SQLite serialises), the
  manual-only mode selects (part of the user's control matrix, help
  text honest), the four stacked CSS theme layers (consolidation is a
  visual-regression risk), and the documented remainder of the
  primary-button pass.
- **DISPROVEN: 3** (+1 sub-point, +3 sweep false alarms that turned
  out to be the app correctly enforcing its own rules) — each with
  counter-evidence in the ledger.
- **Still open: 0 product defects.**
- **Connections audit: 22/22** live end-to-end checks (control →
  route → lib → DB effect → visible result), including a guardrail
  save proven in the DB with a distinctive value and an invalid value
  refused without touching the group.
- **Post-login sweep: 80/80** checks (25 admin pages; player empty +
  populated states; agent pages; invalid submissions; role-switch
  stealth; session edges). Mobile-width evidence is CSS-level (token
  and touch-target consistency); no live device render exists in this
  sandbox — stated, not dressed up.

## Test counts (coordinator's own runs)

Full suite `node --test test/*.test.js`: **84 tests — 83 pass,
0 fail, 1 skipped** (the Postgres adapter smoke, which needs a live
Postgres the sandbox does not have). Three consecutive full runs
green; one earlier run showed a single non-reproducing failure,
recorded here rather than hidden. New suite files this round:
`test/v19-features.test.js`, `test/v19-kyc-auto.test.js`,
`test/v19-prize-engine.test.js`, `test/v19-scan-fixes.test.js`,
`test/tamper.test.js`.

## Fresh-install proof (mandatory acceptance step)

The shipped zip was unzipped into a brand-new directory, installed
with `npm ci` from the lockfile, booted with ONLY the documented env
vars, and driven end-to-end — **11/11 checks pass**: /healthz, admin
login → console, register, deposit → admin approve → wallet credited
exactly, ticket bought, the real engine settled the draw, operator
turned the turnover rule off through the real admin form, withdrawal
completed through the real emailed-OTP step → pending withdrawal.
Every intermediate failure during this proof was a proof-driver error
or the app correctly enforcing its own rules (breached-password
rejection, required custom field, wagering gate with a to-the-cent
message) — **zero product defects found; no undocumented tweak was
needed.**

## Production readiness — honest split

**(a) Proven in this round:** all flows above on fresh boots; the
full suite; tamper battery; connections and post-login sweeps;
fresh-install from the shipped zip using only documented steps.
**(b) Operator-side only (NOT proven, cannot be from here):** real
provider credentials (payments/OAuth/SMS/SMTP) and one live
deposit/withdrawal through a real gateway; the paid Render upgrade
(or Postgres) so the database survives redeploys; owning a domain
(the footer no longer depends on `cashpop.live`, but the domain
itself is the operator's to buy); the gambling licence/LLC position
(the operator states this is handled — not verified by this code);
a live Postgres/MySQL migration smoke (needs a live server).
Nothing in (b) is stamped "ready" by this log.
