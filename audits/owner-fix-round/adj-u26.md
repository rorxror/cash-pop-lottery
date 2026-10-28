# U-26 — Admin organization / smart placement (adj-u26.md)

Worker: U-26 (ORG, last admin wave). Files owned: `routes/admin.js`,
`lib/admin-ui.js`, `routes/agent.js` + `views/agent/**` (nav coherence),
`test/v20-u26.test.js`. NOT touched: routes/player.js, routes/auth.js,
server.js, routes/scratch.js, all player views, public/*.

## 0. Inventory source — adjudicated

`adj-admin.md`'s U-26 inventory ends in a literal `...[truncated 5026 chars]`
marker inside the Games-config section, so it is NOT complete on disk. The
authoritative inventory was therefore re-derived from the code itself
(regex over `router.(get|post)` in routes/admin.js, `adminRouter.*` in
routes/scratch.js, `router.*` in routes/agent.js):

- routes/admin.js: **137 routes** (49 GET, 88 POST)
- routes/scratch.js adminRouter (mounted at `<console>/scratch`): **8 routes**
  (2 GET, 6 POST)
- **Admin total: 145 routes, 51 GET pages.** (The round brief said 133 —
  that count predates U-23's /data routes and the scratch-admin split;
  the code count above is the one this map assigns, every line of it.)
- routes/agent.js: **12 routes** (7 GET, 5 POST) — matches the brief.

## 1. TARGET GROUPING (written BEFORE any move)

Order = operator workflow: daily money + support high, system low.
Every route below is assigned to exactly one home group; detail/sub-pages
hang under their parent page. Labels are operator language only — no
project codes, no internal jargon in any menu name.

### G1 Overview
- GET `/` Dashboard (parent of all KPI deep-links)
- GET `/reports` Reports (business/users/login; dashboard KPI tiles
  deep-link here — the dashboard↔report stat duplication already exists
  and is read-only, see §5)

### G2 Money In & Out
- GET `/deposits`, GET `/deposits/:id`; POST approve|reject|revoke|note
- GET `/withdrawals`, GET `/withdrawals/:id`; POST approve|reject|revoke|mark-paid|note
- GET `/methods`, `/methods/new`, `/methods/:id`, `/methods/:id/credentials`;
  POST new, :id, :id/toggle, :id/delete, :id/credentials
- GET `/approvals`; POST `/approvals/:id/approve|reject` (maker-checker —
  money first; draw approvals are decided here too, noted on the page)
- GET `/reconciliation`; POST `/reconciliation/run`

### G3 Players & Agents
- GET `/users`, GET `/users/:id`; POST :id (save), adjust, block, matrix,
  verify-contact, reset-password, revoke-sessions, login-as, kyc-verify
- GET `/agents`, GET `/agents/:id`; POST /agents, :id/fund, :id/settle-commissions

### G4 Games
- GET `/draws`, GET `/draws/:id`; POST /draws/test, :id/settle, :id/cancel
- GET `/tickets`, GET `/tickets/:id`
- GET `/scratch`, GET `/scratch/:id` (scratch adminRouter);
  POST planner/preview, planner/create, create, :id/launch|toggle|stop
- GET `/automation` Automation; POST master, draws, scratch, job/:id/toggle, job/:id/run
  (automation is the games' engine room — it creates/settles draws and runs
  the scratch lifecycle, so it lives with Games, cross-linked to Cron Jobs)

### G5 Support
- GET `/support`, GET `/support/:publicId`; POST reply|close|reopen|delete
- GET `/support/canned-replies`; POST canned-replies, :id, :id/delete
- GET `/contact-messages`; POST `/contact-messages/:id/handled`

### G6 Bonuses & Growth
- GET `/bonuses`; POST master, save, :id/run|toggle|delete
- GET `/referrals` Referrals
- GET `/notifications` (templates/outbox/send/announcements/providers);
  GET `/notifications/:id` (template edit), GET `/notifications/log/:id`;
  POST send, announcements, announcements/:id/toggle|delete, process-due, :id
  (announcements + player messaging are growth/comms, grouped here;
  the page itself is one screen with tabs, so nothing moves internally)

### G7 Security & Compliance
- GET `/kyc`, GET `/kyc/:id`, GET `/kyc/document/:id` (file serve);
  POST :id/approve|reject
- GET `/flags`; POST `/flags/:id/review`
- GET `/otp` OTP Codes; POST /otp, /otp/:id/revoke
- GET `/login-history`
- GET `/staff`; POST /staff, /staff/:id/role
- GET `/security` (own authenticator); POST totp/start|confirm|disable
- GET `/audit` Audit Trail

### G8 Settings & System
- GET `/settings`; POST clear-cache, toggles, economy, risk, kyc,
  phone-countries, support-limits, prizes/preview, prizes, currencies,
  appearance
- GET `/extensions`, GET `/extensions/:key`; POST :key, :key/toggle
- GET `/cron` Cron Jobs; POST schedule, :id/run, :id/toggle
- GET `/data` Data — Import & Export; GET `/data/export/:dataset`;
  POST /data/import, /data/import/execute (the CHAIN worker's entry,
  label kept, grouped here)
- GET `/pages` Pages & Content, GET `/pages/new`, GET `/pages/:id`,
  GET `/content/:key`; POST pages/new, pages/:id, pages/:id/delete, content/:key

Count check: G1 2 GET · G2 8 GET · G3 4 GET · G4 6 GET · G5 3 GET ·
G6 4 GET · G7 8 GET · G8 9 GET = 44 GET in admin.js… plus /data/export
(download) = 45, plus scratch-admin 2 GET under G4 = 47 console GET
pages + POST-render pages (settings prizes preview, totp enrol/confirm,
data import report, scratch planner) which hang under their parents.
All 137 admin.js routes + 8 scratch-admin routes appear above exactly once.

### Agent area target (routes/agent.js, base /agent)
One flat bar is right at this size (6 destinations): Dashboard `/`,
Players `/players`, Add Player `/players/new`, Transfer `/transfer`,
Commissions `/commissions`, Support `/support`; detail
`/support/:publicId` hangs under Support; POST claim under Players.
Coherence defect found pre-move: `views/agent/create_user.ejs` and
`views/agent/transfer.ejs` render NO agent nav bar (only a back link),
unlike the other five views — fixed in §3.

## 2. BEFORE → AFTER nav

BEFORE (lib/admin-ui.js `NAV`): one flat list of 31 links, no groups,
no role filtering — every staff role saw every entry, including entries
whose actions their role cannot perform (e.g. a support staffer saw
Settings, Staff, Payment Methods, Cron Jobs).

AFTER: `NAV_GROUPS` in lib/admin-ui.js — the 8 groups above, in the
order above, group headings rendered in the sidebar, same 31
destinations (none added, none removed, no URL changed), plus a
per-entry role list (see §6). The layout's existing active-state
mechanic (`section === path`) is unchanged and now also highlights
correctly on detail pages because every handler already passes its
parent section (verified in the crawl, §7).

Nav label changes (operator language, no path changes):
- 'Data (Import & Export)' → 'Data — Import & Export' (same words,
  cleaner punctuation; CHAIN's entry, kept in G8)
- 'Support' → 'Support Tickets' (matches the page's own H1)
- 'Pages & Content', 'OTP Codes', 'KYC', 'Staff', 'Security',
  'Audit Trail' kept verbatim. No BP-/R- codes exist in any nav
  label (grep-proven); U-27.9's BP-code hits are in page COPY inside
  handlers, outside the nav — flagged for the final wave, not edited
  here beyond the doors I add (my added copy contains no codes).

## 3. ORPHAN HUNT — method + results

Method: live BFS crawl on the U-26 boot (port 4147, seeded data with
one row in every parent list) starting at the console home as super
admin, following every rendered href under the console prefix;
each inventory GET template is then matched against the visited set.
A page counts as wired only if the crawl reaches it by clicks or a
named parent page links to it.

RESULTS: **zero orphans.** The BFS crawl (test/v20-u26.test.js)
visited 201 URLs from the console home and reached **all 51 GET page
templates** (49 in admin.js + 2 scratch-admin) by clicking rendered
links — nav links, in-page links, tab links, GET-form actions and the
KYC document `<img>` on its parent review page — every one returning
200. Named parents for the detail/sub-pages, all crawl-proven:
draws/:id ← Draws list; tickets/:id ← Tickets list; users/:id ← Users
"Manage"; agents/:id ← Agents "Manage"; deposits/:id + withdrawals/:id
← their lists' "Review"; methods/new + methods/:id + credentials ←
Payment Methods list; kyc/:id ← KYC queue "Review", kyc/document/:id
← the review page itself; support/:publicId ← Support queue "Open";
support/canned-replies ← its own nav entry + Support group;
notifications/:id ← Notifications Templates tab "Edit";
notifications/log/:id ← Notifications Outbox tab "Detail";
pages/new + pages/:id ← Pages list; content/:key ← Pages "Frontend
Content" tab; extensions/:key ← Extensions "Configure";
data/export/:dataset ← the GET download forms on the Data page.
POST-only routes render no page; each hangs under its parent page's
forms (the U-20 pass exercised every one of them with effect, and
the four new door forms in §5 were submitted from their rendered
pages by the U-26 tests). Agent area: all 7 GET pages reached from
the agent bar; /agent/support/:publicId ← the agent Support list
(crawl-proven in the agent test after assigning the player).

## 4. MISPLACEMENTS — adjudicated

1. **Support ticket limits** sat only in Settings (G8) while the
   operator works them from the Support queue (G5). → TWO DOORS (§5.1).
2. **Auto-withdrawal limit** sat only in Settings → Withdrawals &
   risk controls, while the operator reviews withdrawals on the
   Withdrawals page (G2). → TWO DOORS (§5.2).
3. **Maintenance mode + deposit/withdrawal gates** sat only in
   Settings toggles — during an incident the operator lands on the
   Dashboard. → TWO DOORS (§5.3).
4. **KYC master switch + gate scope** sat only in Settings while
   reviewers work the KYC queue. → TWO DOORS (§5.4).
5. **Game economy + prize table** live inside Settings; the Draws
   page never said so. Not moved (the Settings economy card is a
   coherent validated form set; splitting it would need handler
   changes — guardrail). Instead the Draws page gains a super-only
   pointer line to Settings → Game economy. SPEC'd, not moved.
6. **Automation (G4) vs Cron Jobs (G8)** both list/control the same
   cron_jobs rows (U-20 proved the job toggle is the same row from
   both pages — a pre-existing two-door). Kept in their groups
   (automation = game lifecycle, cron = system schedule) with a
   cross-link line added on each page naming the other.
7. **Duplicate pages for one job**: none found. Reports vs Data
   export overlap in subject but not job (on-screen viewing vs CSV
   download — the /data page already links to Reports and vice
   versa is added by grouping adjacency in G1/G8… no merge; both
   paths stay). Cron vs Automation: see 6 — same rows, different
   job framing, cross-linked, not merged.
8. Agent nav missing on Add Player + Transfer views → nav bar added
   to both views with correct active state (same 6 links, same order
   as the other five agent views).

## 5. TWO DOORS — created + proof obligations

Rule applied to every door: both forms POST to the SAME existing
route and carry the COMPLETE field set that route's handler expects
(the settings handlers are all-or-nothing: /settings/toggles rewrites
every toggle key, /settings/risk rewrites every risk key — a partial
form would silently reset siblings, so door forms carry the other
fields as hidden inputs at their current values, exactly as the
Settings form itself would submit them). No handler was changed.
Doors whose POST is super-only (all /settings/* per lib/rbac.js)
render as an editable form ONLY for the super role; other roles see
the current value read-only with a plain note — a visible control
that 403s on submit would itself be a placement defect.

- 5.1 Support limits: Settings card ⇄ Support queue card → POST
  /settings/support-limits (keys support_max_open_tickets,
  support_max_new_tickets_24h — the only two keys that handler reads).
- 5.2 Auto-withdrawal limit: Settings risk card ⇄ Withdrawals page
  card → POST /settings/risk (auto_withdrawal_limit visible; daily/
  monthly caps, payout lock, maker-checker threshold, referral cap
  and turnover flag carried hidden at current values).
- 5.3 Incident gates: Settings toggles ⇄ Dashboard "Site status"
  card → POST /settings/toggles (maintenance_mode, deposits_enabled,
  withdrawals_enabled visible; every other toggle carried hidden at
  its current value). Super-only card.
- 5.4 KYC switch: Settings KYC card ⇄ KYC queue card → POST
  /settings/kyc (kyc_enabled + kyc_gate — the complete key set).
- Pre-existing doors verified, not created: Automation ⇄ Cron job
  toggle (same cron_jobs row, U-20); Dashboard KPI tiles ⇄ Reports
  business figures (same aggregates, read-only).

Proof per door (test/v20-u26.test.js): set via door A → reload door
B → value matches; set via door B → reload door A → matches; sibling
keys proven unchanged after a door save (toggles + risk doors).

## 6. RBAC VISIBILITY — adjudication + matrix

lib/rbac.js design (unchanged): GET pages are readable by all staff
roles; POST actions enforce the role map. "Cannot open" for nav
purposes is therefore adjudicated as: the entry's WORK (its POST
actions) is closed to the role, or the page itself gates the role
(credentials/export/import handlers). Showing a money-action entry
to a support staffer who can only stare at it is exactly the
"scattered / not understandable" failure the owner named. Nav
filtering is a RENDERING change only — direct-URL GET readability
stays as rbac.js defines it (no access rule was tightened or
loosened by this wave; handlers were not touched).

Entry → roles shown (super sees all 31):
- All roles: Dashboard, Reports, Tickets, Data — Import & Export
  (the page itself filters datasets/import per role), Login History,
  Referrals, Security (own authenticator)
- finance (+super): Deposits, Withdrawals, Payment Methods,
  Approvals, Reconciliation, KYC, Agents, Scratch, Bonuses
- risk (+super): Draws, Users, Approvals, Fraud Flags
- support (+super): Support Tickets, Canned Replies, Contact
  Messages, Notifications
- super only: OTP Codes, Extensions, Pages & Content, Cron Jobs,
  Automation, Staff, Settings, Audit Trail
(Audit Trail is super-only in the nav because its rows expose every
role's actions and actor detail; the GET itself stays readable per
rbac.js. Users is risk+super: biodata/adjust actions split SAFETY/
MONEY, and the finance money path to a user runs through
Deposits/Withdrawals/Approvals, not the biodata form.)

Per-role crawl results: see §7.

## 7. VERIFY — crawl output summary

test/v20-u26.test.js: **12/12 PASS** (port 4147, /tmp/u26.sqlite).
Crawl line from the run: `urls visited: 201 | html pages: 191 |
pages with H1: 191 | templates 200: 51 / 51`.
- Reachability: 51/51 GET page templates reached by clicks, all 200,
  zero 500s anywhere in the crawl, zero orphans (§3).
- Heading/section match: every rendered HTML admin page (191/191,
  100%) carries its page H1 in the layout top bar; the nav
  active-state was asserted on /users (parent section highlighting
  works for detail pages because handlers pass their parent section —
  e.g. /kyc/:id renders with section /kyc, /content/:key with /pages).
- Per-role nav crawls: finance sees 16 entries, support 11, risk 11,
  super 31 — for each role, every forbidden entry was absent from the
  rendered nav AND every visible entry returned 200 (never 403).
  Agent bar: present on all 7 agent pages (incl. the two views that
  lacked it), contains only /agent destinations, all 200, and never
  references the console path.
- Two Doors: all four round-trips proven in both directions from the
  RENDERED door forms (parsed out of the page, submitted, other door
  re-read), with sibling-key preservation proven for the two
  all-or-nothing handlers (toggles, risk). See §5.
- Paths frozen: the test re-extracts every route pattern from
  routes/admin.js, routes/scratch.js (adminRouter) and routes/agent.js
  and deep-compares against the pre-U-26 sets (§0 counts) — identical.
- Stealth: player + anonymous still get the plain 404 on the console
  and probes are audit-logged (asserted in the same test file).
- Full suite on the settled U-26 tree (`node --test test/*.test.js`):
  **241 tests = 234 pass / 3 fail / 4 skipped.** The 3 failures are
  exactly the known integration-owned ones, none in U-26 files:
  BP-14 (UA-verbatim assertion superseded by U-04), BP-16 (/healthz
  `time` field — U-28's minimal contract wins at integration), and
  v20-admin-pass auto-withdrawal (test posts the pre-§5.3 deposit
  fields for a withdrawal; CHAIN adjudication, integration updates
  the test). No regression from this wave.

## 8. SPEC'd / not done

- routes/scratch.js renders its two admin pages via ui.layout WITHOUT
  a role argument, so on those two pages the sidebar falls back to
  the full (super) nav. One-line fix for the integration wave: pass
  `role: (req.user.admin_role || 'super')` in the four layout calls
  in routes/scratch.js (lines ~283/327/367/406). Not edited here —
  scratch.js is outside this worker's file ownership.
- U-27.9 BP-code copy inside admin page bodies (settings cards etc.)
  is page copy, not nav — final wave (U-24/U-27 application) owns it.
- Game economy / prize table stay in Settings (see §4.5).
