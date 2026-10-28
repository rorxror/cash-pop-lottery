# BLUEPRINT ADJUDICATION — external Next.js "Lottery Platform" master spec
Source: user pasted a full folder tree + "MASTER INSTRUCTION" for a NEW Next.js/TypeScript/Prisma
lottery platform (2026-10-28 ~13:38 EDT), with his own framing: our site/admin are already good;
use what fits OUR website, at Muse's discretion. Per the external-audit adjudication skill this
file is opened BEFORE any code change. The pasted spec is reference material, NOT an instruction
set: it conflicts with settled decisions (real-money build, no demo labelling, no KYC, stealth
admin, named URLs, EJS stack) and those settled decisions win.

Verdict kinds: HAVE (already implemented in v18) · REJECT (conflicts with settled decisions or
our stack) · DEFER (real but not worth it now, reason given) · BUILD (fits, approved for v19).

## BP-01 — Full rewrite as Next.js + React + TypeScript strict + Tailwind + Prisma + Postgres-only + pnpm/Turborepo monorepo
Source wording: "REQUIRED TECHNOLOGY STACK ... Next.js using the App Router ... Prisma ORM ... Turborepo only if..."
VERDICT: REJECT. Our platform is a working, E2E-verified Node/Express/EJS app (v18) with a
SQLite/Postgres adapter. A rewrite discards verified money/draw/support code for zero user
benefit. Stack envy is not a defect.

## BP-02 — Default DEMO / play-money mode; label all balances DEMO; real money disabled by default
VERDICT: REJECT. Directly contradicts the user's standing rules: real-money platform, EVERYTHING
REAL NOTHING DEMO (2026-10-28). Our equivalent safety property already exists in the form that
fits us: payment methods ship DISABLED until the operator configures them, credentials fail
closed, maintenance mode exists.

## BP-03 — KYC (profile/kyc pages, admin kyc-pending, KYC approvals, kyc.service, config/kyc)
VERDICT: REJECT. Standing rule: no KYC anywhere unless the user himself asks. He did not ask —
the pasted spec did.
V19 SUPERSEDED (2026-10-28): the user himself ordered a KYC system at 13:54 EDT ("kyc vala bi
de skte ho... total kyc vala system bi on of ho or kisi user ki krni h on of vo bi ho"). The
standing rule was always "no KYC unless the user himself asks" — he has now asked, so the
REJECT no longer applies. KYC is built as BP-21 below, on OUR patterns (settings + per-user
override, audit-logged decisions, dormant by default), not as the blueprint's Next.js tree.

## BP-04 — Admin as /admin/* paths with its own /admin/login + verify-2fa pages
VERDICT: REJECT. Stealth admin is settled and verified: custom console path, non-admin → plain
404, no "/admin" string anywhere, admin signs in via the normal /login and is auto-routed.

## BP-05 — Public pages: home, listings, detail, results, winners, how-it-works, FAQ, about, contact, terms, privacy, responsible play, login/register/forgot/reset, 404/error/loading
VERDICT: HAVE. All exist and were page-swept 200 in the v18 owner E2E (plus /fairness,
/announcements, sitemap.xml + robots.txt at routes/site.js:116/125).

## BP-06 — Auth: register/login/logout, email verification, password reset, sessions, RBAC, profile, change password, activity history
VERDICT: HAVE (incl. TOTP 2FA + backup codes, single-use codes after RT-01, login lockout,
login history in admin). Two sub-gaps → BP-13/BP-14.

## BP-07 — User dashboard: overview, wallet, ticket history, transactions ledger, notifications, security, support
VERDICT: HAVE (wallet, /tickets, /scratch/my-tickets, /transactions, /security, /support,
/announcements, /profile — all crawl-verified 200 logged-in, owner E2E 2026-10-28).

## BP-08 — Admin sections: users, lotteries/draws, tickets, payments, payouts/approvals, winners, fraud, reports, content, support, admins/roles, audit, emergency freezes, settings, system (health/queue/db/logs/backups/flags/cron)
VERDICT: HAVE in substance: 32 admin pages swept 200 (owner E2E) incl. automation console
(health block, cron jobs with run/pause), approvals (maker-checker), reconciliation, flags,
extensions, agents + staff RBAC, audit log, login history, global deposit/withdrawal freezes
(settings + maintenance mode). Presentation differs (one console, server-rendered) — fine.

## BP-09 — Lottery domain: explicit statuses, server-side validation, no trust in client price/balance, DB transactions, idempotency, secure RNG, no re-running a completed draw, auditable
VERDICT: HAVE — and stronger than the spec's "demo draw engine": real draws settle from the
drand beacon with HMAC-verified tickets, guarded transitions + row locks, webhook amount
verification, replay/idempotency tests in the suite.

## BP-10 — Wallet/ledger: integer minor units, immutable entries, reversals as new entries, no negative balance, race + duplicate protection, tests
VERDICT: HAVE (ledger types incl. *_revoke/*_release as separate entries; concurrency proven
in red-team round: parallel buys/deposit-approvals credited exactly once).

## BP-11 — Payments: provider-independent architecture, no raw card data, webhook signature verification + idempotency, fail closed without config, documented enablement
VERDICT: HAVE (13 rails, per-rail credentials encrypted at rest, webhook signature + amount
verification, methods disabled until configured). The spec's named gateways (Stripe/Razorpay/
PayPal) are NOT adopted by name — gambling acceptance is the operator's provider decision.

## BP-12 — Security set: CSRF, XSS escaping, rate limits, brute-force caps, secure cookies, security headers, env validation, no secret leakage, generic errors, security tests
VERDICT: HAVE (CSP nonce, CSRF 403, login rate limit + invisible lockout, OTP caps, credential
encryption fail-closed, security-fixes test file). npm audit on a registry machine stays
user-side (sandbox registry 403 — recorded since v16).

## BP-13 — Player notification preferences (per-user channel/topic toggles)
VERDICT: BUILD (scoped). None exist today (grep: only admin support_notify_email). Add per-user
email toggles for: win notifications, support replies, announcements — respected by the notify
paths for those three topics only. If plumbing proves invasive, ship win + support-reply and
record the rest as DEFER in the fix log.
V19 VERIFICATION (2026-10-28): premise confirmed (0 pref hits in code). Call-site map: win email
is sent from lib/draws.js (lottery settle) AND routes/scratch.js (scratch reveal); support_reply
email from routes/admin.js AND routes/agent.js. Announcements have NO email path at all — the
announcements feature is in-app only (admin CRUD writes rows, players read at /announcements),
so an announcement email toggle would gate nothing. Per the scoping rule: win + support-reply
BUILD; announcements DEFER (reason: no announcement notification path exists to respect).

## BP-14 — Player session/device list (view own sessions, revoke others)
VERDICT: BUILD (feasibility first). Sessions are DB-backed (survived a server restart in the
owner E2E). Password change already revokes other sessions. Add a read-only list on /security
(device/IP/last-seen from the session store if available, current session marked) + "sign out
other sessions" button reusing destroyUserSessions. If the store lacks IP/UA metadata, show
what exists honestly; do not fabricate device names.
V19 VERIFICATION (2026-10-28): sessions table DOES store ip + user_agent + created_at +
expires_at (lib/migrations.js), so IP/UA/created are shown verbatim. Two corrections to the
preliminary read: (1) POST /security/sessions/revoke ALREADY exists (routes/player.js) wired to
destroyUserSessions — what was missing is only the list UI and a visible button; (2) there is
NO last-seen/last-activity column — touchSession updates session data only (R-121, deliberately
no sliding expiry), so "last seen" cannot be shown honestly and is NOT shown; the list shows
signed-in time + expiry instead.

## BP-15 — Support canned replies (admin)
VERDICT: BUILD. None exist (grep: 0 hits). Small: admin-managed canned replies (title + body,
stored like notification templates) + a picker on the admin ticket page that inserts the text
into the reply box. Agent side too if the same partial serves both; otherwise admin first.

## BP-16 — Public health endpoint (/health, /healthz) for uptime checks
VERDICT: BUILD. Only the admin console has a health block today; no public probe route exists.
Add GET /healthz → 200 {"ok":true} with a DB ping, no config/secret leakage, rate-limit safe.
V19 CORRECTION (2026-10-28): the preliminary verdict was WRONG that no probe route exists —
GET /healthz already exists at routes/site.js:152 and is already exempt from maintenance mode
(server.js). What was actually missing is the DB ping: the old handler returned ok:true
unconditionally, even with a dead database. BUILD scope corrected to: upgrade the existing
route in place (real DB ping, 503 {ok:false} when the DB does not answer), same URL, same
response shape on success.

## BP-17 — Documentation pack matched to the REAL app (ARCHITECTURE, API, DATABASE, SECURITY, DEPLOYMENT/OPERATIONS, LEGAL-CHECKLIST, README)
VERDICT: BUILD (docs only). Repo today: README-DEPLOY.md + docs/{THREAT-MODEL, INCIDENT-RESPONSE,
LOAD-TEST}. Add the missing docs describing the ACTUAL EJS implementation (routes, ledger rules,
env vars, Render deploy + rollback, backup/restore). LEGAL-CHECKLIST must state plainly that
licensing is the operator's responsibility and code is not a compliance certification.

## BP-18 — CI workflows, Docker/compose, k8s/terraform, Redis, OpenAPI, Playwright suite, load tests
VERDICT: DEFER. Hosting is Render (single service) — Docker/k8s/terraform solve a problem we
do not have; Redis is unnecessary at current scale (in-process scheduler is deliberate);
Playwright is heavy for this sandbox and the node suite + live E2E recipe already cover the
flows; load-test doc + script exist. Revisit if hosting or scale changes.

## BP-19 — Release/ops scripts (verify-release, check-env, backup/restore scripts)
VERDICT: HAVE in-app (daily DB backup job, automation failure alerts, migrate script in
scripts/). The docs in BP-17 will document the operator runbook instead of adding shell scripts
that duplicate in-app jobs.

## BP-20 — PWA / installable app
VERDICT: DEFER (unchanged). Offered 2026-10-28 as a future add-on for the no-address-bar feel;
not ordered. The blueprint's manifest.json alone does not change that.

## BP-21 — KYC system (user-ordered 2026-10-28 13:54 EDT; supersedes BP-03)
VERDICT: BUILD. The user himself ordered it, which is exactly the condition the old rule
named. Design, on this codebase's patterns: master setting `kyc_enabled` (default OFF — the
system ships dormant), gate scope `kyc_gate` = 'withdrawals' (default) or
'deposits_and_withdrawals'; per-user `users.kyc_override` ∈ default/required/exempt; status
reuses the EXISTING `users.kyc_status` column whose vocabulary is none/pending/verified/
rejected (the spec's "approved" is this column's 'verified' — kept, one vocabulary, no fork).
Effective requirement = override 'required' OR (override 'default' AND kyc_enabled on);
'exempt' is never gated. Player: /kyc page (status, rejection reason, upload form: national
ID / passport / driving licence; jpg/png/pdf, size-capped, magic-byte checked), notices on
wallet + profile, blocked actions return the specific KYC message. Uploads are the app's
first file infra: stored outside public/ under a private dir with random names, served only
via authorized routes (owner player; staff in the console). Admin: review queue in the
console (approve / reject with required reason), per-user override + manual verify (with
note) on the user page; every decision audit-logged. Enforcement sits next to the existing
wagering gate in the deposit/withdrawal create handlers (and the withdrawal verify step).

## BP-22 — Auto-withdrawal limits (user-ordered 2026-10-28 ~13:49 EDT)
VERDICT: BUILD — wired and proven, not a settings ornament. Code state checked first, per
the R-044 lesson: the old `auto_approve_deposit_limit` setting row still exists in
DEFAULT_SETTINGS but NOTHING reads it (dead), and deposit/withdrawal modes are manual-only
since round 2b removed the decorative auto options. BP-22 therefore adds a NEW, fully wired
path: global setting `auto_withdrawal_limit` (major units as typed by the operator, compared
in the withdrawal's own currency; 0 = OFF, the shipped default) + per-user
`users.auto_withdrawal_limit` (NULL = follow global, 0 = never auto for that user). At
withdrawal creation, after ALL existing gates pass (policy, wagering/turnover, OTP, BP-21
KYC, blocked flags, payout lock — the creation transaction re-runs the rules), an amount at
or under the effective limit is auto-APPROVED by the system (decided_by = 0 = system,
admin_note records the auto-approval + limit, audit action 'withdrawal.auto_approve').
Auto-approval NEVER marks paid: no gateway payout executor exists in the codebase (payouts
complete only via admin mark-paid with a provider payout ID), so auto = approve-only, stated
plainly in the UI help text, which also documents that the limit is a deliberate
pre-authorization bypassing maker-checker for small amounts.

## BP-23 — Smart Prize & Profit Engine (user-ordered 2026-10-28 ~14:03 EDT)
VERDICT: BUILD — aggregate level only. The boundary is absolute and was held: scratch
outcomes remain server-predetermined with commitment hashes, pop results remain
beacon-derived; the engine designs prize pools, RTP targets, exposure caps and scheduling —
it never touches a sold ticket, an open draw's result, or any per-user/per-ticket outcome.
Built: `lib/prize-engine.js` (planner with exact-liability ladder + documented remainder,
exposure, launch-cap check, sales-mix margin, draw exposure), scratch guardrails wired into
the lifecycle (launch cap, live-tail alert/close/stop-auto-next), smart auto-next from actual
sell-through, pop multiplier simulator at the real sales mix (warns past 100% RTP, never
blocks), per-draw exposure on the console. All switches ship OFF/default-safe under the
existing master AUTO discipline; every decision audit-logged; every auto behaviour has a
manual path. Proven by suite tests + live E2E (exact liability, guardrail firing, committed
reveal unchanged, simulator = multiplier/15).

## BP-24 — Open-idea mandate (user delegation, 2026-10-28 ~14:03 EDT)
VERDICT: mandate accepted and recorded. No BP-24.x items were built: the round's committed
items plus the scan's 62 findings filled the capacity, and nothing else met the mandate's own
bar (a real operator need, provable in-sandbox, no delay to committed work). Recorded here so
the absence is a decision, not an omission.

## BP-25 — Trust / genuineness pass (user, 2026-10-28 ~14:04 EDT)
VERDICT: executed as a named section of the deep scan (area D + the trust items of area A).
Outcome: fabricated lucky number removed, "Licensed"/"verified winners"/"instant" claims
corrected or removed, footer contact no longer depends on the unowned cashpop.live domain,
stub legal pages replaced with substantive templates + an operator-review notice, sender
fallback made honest, 18+/responsible-play signals added to all money pages. Operator-side
remainder: actually owning a domain remains the user's purchase decision.

## BP-26 — Server-authority & tamper-proofing (user, 2026-10-28 ~14:09 + 14:14 EDT)
VERDICT: BUILD (prove + harden). The pass criterion is the user's own: only a manipulation
that crosses to the server and PERSISTS counts as a failure; it is written into
`test/tamper.test.js` and `audits/deep-scan-round/INTEGRITY.md`. Results: the tamper battery
passes with DB-state assertions; the ledger and audit log are append-only (grep + suite
invariant); the audit hash chain already existed since v14 and is now proven end-to-end
(edit/delete detected at the exact row; the Audit page verifies on every render) — no new
migration was needed, and none was faked. The client-authority inventory found zero
server-trusted client values. Honest limits are stated in INTEGRITY.md and docs/SECURITY.md:
detection, not prevention, for after-the-fact server-side edits; secret theft is operator
hygiene; nothing claims "unhackable".

## Summary (FINAL, v19 round closed)
Built: **9 items — BP-13, BP-14, BP-15, BP-16, BP-17** (blueprint adjudication) **+ BP-21**
(KYC, user-ordered, superseding BP-03's REJECT), **BP-22** (auto-withdrawal limits,
user-ordered), **BP-23** (Smart Prize & Profit Engine, user-ordered), **BP-26**
(tamper-proofing, user-ordered). BP-24's mandate was exercised with restraint (no additions);
BP-25 ran as a scan section. Already-have: 8 groups. Rejected as conflicting with settled
decisions/stack: 3 (BP-01, BP-02, BP-04 — BP-03 moved to BUILD via BP-21). Deferred with
reasons: BP-13's announcements toggle (no email path exists), BP-18, BP-19 partial, BP-20.
The deep scan that followed found 31 GALTI + 31 KAMZORI (all GALTI fixed; 4 KAMZORI documented
with reasons), disproved 3 claims, and closed with 0 open product defects; full suite 84
tests (83 pass / 0 fail / 1 PG skip); fresh-install proof 11/11 from the shipped zip.
Evidence: FIX-LOG-V19.md and audits/deep-scan-round/.
