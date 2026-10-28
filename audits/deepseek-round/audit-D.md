# Audit D — Support & Communications (AUDIT-ONLY, no code edits)
Date: 2026-10-28 · Codebase: ~/workspace/cash-pop-fix/ · Port 3314, fresh DB /tmp/auditD.sqlite
User report: player creates ticket — does it reach admin/agent? After creating, a message box + Send appears; pressing Send → "page not found".
Method: static trace routes/player.js, routes/admin.js, routes/agent.js, views/support*.ejs, views/agent/*, lib/notify.js, lib/migrations.js templates, routes/site.js + live curl lifecycle (player/admin/agent) with CSRF scraping. Cross-checked COMPILED-LIST.md / FIX-LOG.md — do not re-report fixed items unless proven regression.
Hard exclusions honoured: no rigging, no KYC suggestions.

## Findings (written as found)

### D-01 — Critical — CODE-BUG (REGRESSION-class, see live proof below) — Player reply Send posts to a route that does not exist → 404 "Page not found"
- Evidence: `views/support_view.ejs:20` `<form action="/support/<%= ticket.public_id %>" method="POST">` (no `/reply` suffix) vs the ONLY player reply route `routes/player.js:618` `router.post('/support/:publicId/reply', …)`. There is no `POST /support/:publicId` in player.js (only GET at :609). Unmatched POST falls to `server.js:436` `res.status(404).render('error', {message:'Page not found.'})`.
- Contrast: admin detail does it correctly — `routes/admin.js:1470` form action is `…/support/<id>/reply`.
- Repro: register player → POST /support/new → land on /support/<id> → type in Reply box → Send Reply → 404. Live status codes in trace table below.
- Impact: EXACTLY the user report. A player can create a ticket and read replies but can NEVER reply from the UI. Conversation is one-shot.
- Prior-list check: FIX-LOG R-062/R-103 etc. fixed ADMIN list filters and admin close/reopen guards; no item fixed the player view form action. Not in R-001..R-124 as fixed — this is a still-open / never-fixed break in the current tree, proven live.

### D-02 — High — CODE-BUG — After admin replies, player reply form disappears and page falsely says "This ticket is closed"
- Evidence: `views/support_view.ejs:15` `<% if (ticket.status === 'open') { %> …reply form… <% } else { %> This ticket is closed. Open a new ticket…` — the else covers BOTH `closed` AND `answered`. Admin reply sets `status='answered'` (`routes/admin.js:1483`).
- So the normal flow admin-replies → player returns → no reply box, told ticket is closed (it is not), must open a duplicate ticket. Direct POST to `/support/:id/reply` would be accepted by `routes/player.js:618-620` (only `closed` is blocked) — the route and the view disagree.
- Impact: even if D-01 were fixed, a two-way conversation still dies after the first staff reply.

### D-03 — High — CODE-BUG / MISSING — Tickets never reach an AGENT; no assignment exists at all
- Evidence: (a) `support_tickets` schema has no assignee/agent column in any driver — `lib/migrations.js:230-238` (SQLite; PG/MySQL same) columns are only `id, public_id, user_id, subject, status, created_at, updated_at` (+`priority` v3). (b) `routes/agent.js` (full file, 169 lines) contains ZERO support routes: no GET list, detail, or reply; its views `views/agent/{dashboard,players,create_user,transfer,commissions}.ejs` have no ticket link. (c) The only agent-side ticket number is a KPI count on `routes/agent.js:37-38` counting LOTTERY `tickets` (not `support_tickets`) for the agent's players, rendered unlinked as "Player tickets this week" in `views/agent/dashboard.ejs:15-16`.
- "Assignment" in this codebase is player→agent (`users.agent_id`, admin user-edit / agent claim), never ticket→agent, and it changes nothing for support visibility.
- Impact: user expectation "ticket should reach admin AND the agent too" is unmet by design-in-code: the player's own agent cannot see, be notified of, or answer the ticket. Only admin-panel staff can.

### D-04 — Medium — CODE-BUG — New ticket creation notifies NOBODY (no email, no in-app, no audit row)
- Evidence: `routes/player.js:597-608` POST /support/new inserts ticket+message and redirects — no `notify.send`, no `notifications_log` row, no `audit.log` (contrast admin reply at admin.js:1485-1486 which does both). Admin only discovers it by opening the admin Support list / dashboard "Open support tickets" count (`routes/admin.js:133,225`).
- Impact: "who knows if it even reaches anywhere" — from the system's side, silently: no push to staff inbox of any kind.

### D-05 — Medium — CODE-BUG — Player reply (via the working /reply route directly) also notifies nobody; admin replies hardcode author_role
- Evidence: `routes/player.js:618-627` inserts message + sets status open, no notify/audit. Admin reply `routes/admin.js:1482,1486` inserts `author_role='admin'` and audit `actorRole:'admin'` literally, even when the actor is a `support`/`finance` staff sub-role or would be an agent — player view (`support_view.ejs:10`) therefore can only ever display "admin"/"player", losing who actually answered.

### D-06 — Medium — CODE-BUG — 4 of 15 seeded email/SMS/push templates have NO send site (dead templates)
- Seeded `lib/migrations.js:95-116` NOTIF_TEMPLATES (15). Send-site grep over routes/+lib/ for `notify.send(...)`:
  - WIRED: email welcome (auth.js:352,557), deposit_approved, deposit_rejected, approval_rejected, draw_cancelled, withdrawal_decided, win (lib/draws.js:298, email only), otp_login (lib/otp.js:93), support_reply (admin.js:1485), password_reset, email_verification.
  - DEAD (no caller anywhere): `email/otp` (migrations:104), `sms/otp` (:114), `sms/win` (:115), `push/win` (:116). Signup codes are operator-issued `otp_codes` rows (admin.js:746ff), never sent via `otp` template; wins are emailed only, never SMS/push.
- Plus `lib/notify.js:79-82` `sendPush` unconditionally throws "Push provider not configured" — push is CONFIG-NEEDED even if it were wired.
- Impact: admin editing those 4 templates in Notifications > Templates changes nothing; SMS/push win alerts silently never happen.

### D-07 — Medium — MISSING — No announcement / in-app notification system at all
- Evidence: `grep -ri announce routes/ lib/ views/ server.js public/` = 0 hits. `notifications_log` is an outbound email/SMS outbox only; no player route reads it, no bell/inbox in `views/layout.ejs`, no player notifications page. Admin "Send Notification" (`routes/admin.js` notifications tab=send, POST /notifications/send) is email-only via `notify.sendRaw` — with no SMTP configured every send is logged `failed` (lib/notify.js sendEmail throws "SMTP not configured"), there is no in-app fallback a player could ever see.
- Impact: broadcasts/announcements reach players only if SMTP is configured and delivered; otherwise zero visibility.

### D-08 — Medium — MISSING — No contact page / contact form (logged-out visitors have no way in)
- Evidence: `routes/site.js` (full file) has no `/contact` GET/POST — only `/`, `/page/:slug`, `/results`, `/fairness`, `/api/stats`, `/currency`, sitemap/robots/healthz. Seeded pages (migrations PAGES) are about/how-it-works/faq/terms/privacy — no contact page. Support itself requires login (`routes/player.js:593` requireLogin). The only contact artefact is the footer text block `footer_contact: '<p>Support: support@cashpop.live</p>'` (migrations:83, not even a mailto form).
- Impact: a logged-out / locked-out user (e.g. cannot log in — the classic support case) has no form to reach support at all.

### D-09 — Low — MISSING — No attachments on tickets
- Evidence: no `multer`/upload in package.json or support routes, no file input in `views/support.ejs`/`support_view.ejs`/admin support detail, `support_messages` schema has no attachment column. Players cannot attach a payment screenshot etc.

### D-10 — Low — CODE-BUG (by design gap) — Player cannot close or reopen their own ticket
- Evidence: player router has no close/reopen POST; `support_view.ejs:25` for a closed ticket only offers "Open a new ticket". Close/reopen exist only admin-side (`routes/admin.js:1489,1498`, R-103-guarded, WORKS). Reopen also resets an `answered` ticket to `open` (admin.js:1499 guard is `status != 'open'`).

### WORKS (verified statically, live proof in table)
- Player create → admin list/detail: routes/player.js:597-608 inserts into shared `support_tickets`/`support_messages`; admin list `routes/admin.js:1430` and detail `:1463` read the same tables unfiltered by owner — a created ticket IS visible to admin.
- Admin reply → player: admin.js:1476-1487 inserts message, sets answered, fires `support_reply` email; player GET (player.js:609-617) renders all messages regardless of author.
- Admin close/reopen: guarded UPDATEs + audit (admin.js:1489-1502).
- Staff RBAC: support sub-role may POST support actions (lib/rbac.js:23).
- Statuses in use: open → answered (admin reply) → open (player reply) / closed; priority low/medium/high validated player-side (player.js:602) and admin-filtered in SQL (R-062, admin.js:1430ff).


## Live repro (port 3314, fresh SQLite /tmp/auditD.sqlite, seeded admin admin@test.local, stealth prefix discovered from login redirect = /ops-7f3a9c-console)
Player registered via POST /register (302 → /). Ticket public_id `SMVRRLVLO8CC848`, priority high.
DB proof after all steps — `support_messages` contains ONLY 3 rows: player initial, player direct-/reply, admin reply. BOTH UI-form submissions are absent (404s never reached a handler). `audit_log` has support.reply/close/reopen (admin only) — nothing for ticket creation or player reply. `notifications_log`: welcome, support_reply, and broadcast all `failed / SMTP not configured` (CONFIG-NEEDED for email delivery; in-app DB messages still visible to the player).

Agent setup: agent created via admin POST …/agents (302, agent@test.local), player assigned to that agent (users.agent_id set to agent id; agent force_password_reset cleared in DB only as a test-setup shortcut), agent login 302 → /agent.

## Lifecycle trace table
| # | Step | Route | Status | Works? |
|---|------|-------|--------|--------|
| 1 | Player register (auto-login) | POST /register | 302 → / | ✅ |
| 2 | Player opens support | GET /support | 200 | ✅ |
| 3 | Player creates ticket | POST /support/new | 302 → /support/SMVRRLVLO8CC848 | ✅ (silent: no notify/audit — D-04) |
| 4 | Admin sees ticket in list | GET /ops-7f3a9c-console/support | 200, subject+player email present | ✅ |
| 5 | Admin opens ticket detail | GET …/support/<id> | 200, all messages visible | ✅ |
| 6 | Player opens ticket view | GET /support/<id> | 200, form action extracted = `/support/<id>` (no /reply) | ⚠️ form present, action wrong |
| 7 | **Player presses Send Reply (UI form)** | **POST /support/<id> (as rendered)** | **404 "Page not found."** | ❌ **D-01 — message NOT in DB** |
| 8 | Player reply via correct route directly | POST /support/<id>/reply | 302 → ticket, message visible everywhere | ✅ route works, UI never calls it |
| 9 | Admin replies | POST …/support/<id>/reply | 302, status → `answered`; email logged `failed` (SMTP not configured = CONFIG-NEEDED) | ✅ in-app / ⚠️ email |
| 10 | Player reads admin reply | GET /support/<id> | 200, admin message visible — BUT no reply form, page says "This ticket is closed" | ❌ **D-02** |
| 11a | Agent dashboard | GET /agent | 200, nav = Dashboard/Players/Add Player/Transfer/Commissions only, no ticket | ❌ D-03 |
| 11b | Agent support list (guessed) | GET /agent/support | 404 | ❌ D-03 |
| 11c | Agent support detail (guessed) | GET /agent/support/<id> | 404 | ❌ D-03 |
| 11d | Agent opens player's ticket via player route | GET /support/<id> (as agent) | 404 (ownership check — correct privacy, but no agent alternative) | ❌ for agent / ✅ isolation |
| 12 | Admin closes ticket | POST …/support/<id>/close | 302; player view: closed text, no form | ✅ |
| 13 | Admin reopens ticket | POST …/support/<id>/reopen | 302, status → `open`; player reply form returns | ✅ admin-side |
| 14 | Player presses Send Reply again (reopened) | POST /support/<id> (as rendered) | **404 "Page not found."** again, message NOT in DB | ❌ D-01 repeat proof |
| 15 | Admin broadcast "announcement" to player | POST …/notifications/send | 302 → outbox; outbox row `failed / SMTP not configured`; player has no inbox page (GET /notifications → 404) | ❌ D-07 (email-only, no in-app) |
| 16a | Logged-out contact form | GET /contact and GET /page/contact | 404 / 404 | ❌ D-08 |
| 16b | Logged-out support | GET /support | 302 → /login | ⚠️ login required, no alternative |

## Summary counts
- Findings: **10 total — Critical 1, High 2, Medium 5, Low 2**
  - Critical: D-01 (player reply Send → 404, user-reported, proven live twice)
  - High: D-02 (answered ticket hides reply form + false "closed"), D-03 (tickets never reach agent; no assignment exists)
  - Medium: D-04 (creation notifies nobody), D-05 (player reply notifies nobody / author_role hardcoded), D-06 (4 dead templates: email/otp, sms/otp, sms/win, push/win), D-07 (no announcement/in-app notifications), D-08 (no contact page/form)
  - Low: D-09 (no attachments), D-10 (player cannot close/reopen own ticket)
- By classification: CODE-BUG 6 (D-01, D-02, D-04, D-05, D-06, D-10) · MISSING feature 4 (D-03, D-07, D-08, D-09) · CONFIG-NEEDED 0 standalone (noted inline: SMTP for email delivery incl. support_reply; push provider in lib/notify.js sendPush always throws) · WORKS verified: create→admin list/detail, admin reply→player in-app, direct /reply route, admin close/reopen, player-ownership isolation, staff support RBAC, priority/status filters.
- Cross-check: nothing above re-reports an R-001..R-124 fixed item. R-062 (admin support filters) and R-103 (admin close/reopen guards) verified still working live. The support_reply/otp_login template seeds (v17) verified present and firing (outbox row created). The player-side reply breakage (D-01/D-02) was never in the fixed list — it is the open defect behind the user report, not a re-report.
- Server killed after audit (fuser -k 3314/tcp); no code edited.
