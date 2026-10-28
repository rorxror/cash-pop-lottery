# Disprove Round — Area D (Support & Comms) — adversarial re-check vs BASELINE

Date: 2026-10-28 · Baseline under test: `~/workspace/cash-pop-push/` (production v17.1, pre-fix, read-only — nothing edited).
Scope (confirmed from COMPILED.md, source = audit-D): **DS-001, DS-009, DS-010, DS-025, DS-026, DS-027, DS-028, DS-029, DS-060, DS-061** (D-01…D-10).
Method: for each item I actively hunted for a route alias / redirect / alternate handler / assignment mechanism / wiring in the baseline that would make it a false alarm — full route enumeration across player + admin + agent + site + auth + setup + scratch + webhooks routers and `server.js` mounts, every form action in the support views, plus a live repro of the baseline on port 3354 (throwaway DB `/tmp/disprove-d.sqlite`, seeded admin `admin@cashpop.live`, ticket `SMVRSWWMR6634C0`). Server killed afterwards (`fuser -k 3354/tcp`).

**Tally: 10 SURVIVES · 0 DISPROVEN.** Two items carry a nuance note (DS-028, DS-029) about an optional, off-by-default third-party extension — neither nuance overturns the finding as written.

---

## DS-001 (D-01, Critical) — Player reply Send posts to non-existent route → 404 — **SURVIVES**

Disproof attempt — enumerate EVERY support route registered in the baseline:

| Router (mount) | Support routes |
|---|---|
| `routes/player.js` (mounted `/`, server.js:428) | GET `/support` :593 · POST `/support/new` :597 · GET `/support/:publicId` :609 · POST `/support/:publicId/reply` :618 — **no POST `/support/:publicId`** |
| `routes/admin.js` (mounted `ADMIN_PATH` = `/ops-7f3a9c-console`, server.js:433) | GET `/support`, GET `/support/:publicId`, POST `/support/:publicId/reply` :1476, POST `…/close` :1489, POST `…/reopen` :1498 — all prefixed by the stealth admin path, so none of them can catch a player POST to `/support/<id>` |
| `routes/agent.js` (mounted `/agent`) | **zero** support routes (full-file grep) |
| `routes/site.js`, `auth.js`, `setup.js`, `scratch.js` (player+admin routers), `webhooks.js` | **zero** support routes |

Other escape hatches checked and absent: no `method-override`/`_method`, no `router.all`/wildcard POST, no redirect for `/support/*` in server.js; the only fall-through is `server.js:436` → 404 `Page not found.`. No client JS touches support (`grep support public/*.js` = 0 hits).

Form actions in baseline views: `views/support.ejs:20` POST `/support/new` (correct); `views/support_view.ejs:16` `<form action="/support/<%= ticket.public_id %>" method="POST">` — missing `/reply`. Admin detail does it correctly (admin.js:1470 builds `…/support/<id>/reply`).

Live repro (baseline, port 3354): rendered ticket page's reply form action extracted verbatim = `/support/SMVRSWWMR6634C0`; submitting it exactly as rendered → **404 "Page not found."**, and the message is **absent from `support_messages`** (DB held only: initial message, a direct-route reply, the admin reply). Direct POST to `/support/<id>/reply` → 302 and the message persisted — proving the handler exists but the UI never calls it. Could not disprove.

## DS-009 (D-02, High) — After staff reply, player reply form vanishes + page falsely says "ticket is closed" — **SURVIVES**

Disproof attempt: looked for an `answered` branch anywhere else — `grep answered` over views/ and public/ = 0 hits; the only `answered` writer is `routes/admin.js:1483` (`status='answered'` on staff reply) and the only reader is the admin list tab (admin.js:1448). Baseline `views/support_view.ejs:15-25`: reply form is inside `if (ticket.status === 'open')`, the `else` (covering both `answered` and `closed`) prints "This ticket is closed. Open a new ticket…". The route disagrees — `routes/player.js:620` blocks only `closed` — so no alternate wiring rescues the UI.

Live repro: after admin reply (302, status → `answered` in DB), player GET of the ticket shows the staff message, badge `answered`, the literal text "This ticket is closed", and **no Send Reply form**. Could not disprove.

## DS-010 (D-03, High) — Tickets never reach the agent; no agent support views/assignment exist — **SURVIVES**

Disproof attempt: hunted for (a) any ticket→agent assignment column/mechanism, (b) any agent-side support route/view, (c) any indirect visibility (admin panel, player router, scratch admin).

- Schema: `support_tickets` in all three drivers (`lib/migrations.js:230, 362, 488`) is `id, public_id, user_id, subject, status, created_at, updated_at` (+ `priority` added v3, :569/577/585). No `assignee`/`agent_id` anywhere — `grep assignee|assigned` over migrations = 0. Live DB `PRAGMA table_info(support_tickets)` confirms the same 8 columns.
- `routes/agent.js` (full file read, 169 lines): routes are only `/`, `/players`, `/players/claim`, `/players/new`, `/transfer`, `/commissions` — zero support. `views/agent/` = dashboard/players/create_user/transfer/commissions, no ticket view or link. The dashboard KPI at agent.js:37-38 counts lottery `tickets` (not `support_tickets`) and renders unlinked ("Player tickets this week", views/agent/dashboard.ejs:12).
- The only assignment in the codebase is player→agent (`users.agent_id`; admin user-edit, agent claim at agent.js `/players/claim`) and nothing joins it to support visibility. An agent hitting the player route is bound by the `user_id = own id` ownership check (player.js:610), so they cannot open their players' tickets either (audit-D live step 11d; in my repro `/agent/support` returned no route — 403/404-class dead end for non-agent/agent alike).
- Admin support list/detail (admin.js:1430/1463) is the sole staff surface, gated to role `admin` — an `agent`-role user never reaches it.

Could not disprove.

## DS-025 (D-04, Medium) — New ticket creation notifies nobody (no notify/audit) — **SURVIVES**

Disproof attempt: read the full create handler and traced every side effect. `routes/player.js:597-608` POST `/support/new` does exactly: validate → INSERT `support_tickets` → INSERT `support_messages` → redirect. Although `notify` and `audit` are imported in player.js (lines 13-14) and used elsewhere in that file (ticket.buy, deposit.create…), neither is called in the support handlers. No cron/beacon path picks new tickets up either (`grep notify lib/cron.js` = only queued-outbox processing).

Live repro: after creating ticket `SMVRSWWMR6634C0`, `notifications_log` contained only the registration `welcome` row (and later the admin `support_reply` row) — nothing for ticket creation; `audit_log` contained no support row at all until the admin's `support.reply`. The only staff discovery path remains polling the admin Support list / dashboard open-count (admin.js:133, 225), which is pull, not notification. Could not disprove.

## DS-026 (D-05, Medium) — Player reply notifies nobody; staff reply hardcodes author_role='admin' — **SURVIVES**

Disproof attempt: (a) Player reply handler `routes/player.js:618-627` — INSERT message + `status='open'` + redirect only; no `notify.send`, no `audit.log` (contrast ticket.buy/deposit handlers in the same file which do audit). Live repro confirms: the direct-route player reply added a `support_messages` row and **no** audit row and **no** `notifications_log` row. (b) Hardcoded role: `routes/admin.js:1482` inserts the literal `'admin'` as `author_role` and `:1486` logs `actorRole:'admin'` literally, while the real sub-role exists on the user (`req.user.admin_role`; lib/rbac.js SUPPORT rule :23 lets `support` sub-role POST support actions). No code path substitutes the actual sub-role, so a `support`/`finance` staff reply is indistinguishable from a super-admin reply, and `support_view.ejs` can only ever render "admin"/"player". Could not disprove either half.

## DS-027 (D-06, Medium) — 4/15 seeded templates have no send site: email/otp, sms/otp, sms/win, push/win — **SURVIVES**

Disproof attempt: enumerated **every** `notify.send`/`sendRaw`/`sendQueued` call site in routes/+lib/ and matched (channel, slug) pairs against the 15 seeded templates (`lib/migrations.js:96-116`; live DB confirms all 15 seeded).

Wired: email/welcome (auth.js:352,557), email/password_reset, email/email_verification, email/otp_login (lib/otp.js:93 — the distinct `otp_login` slug), email/support_reply (admin.js:1485), email/deposit_approved, email/deposit_rejected, email/approval_rejected, email/withdrawal_decided, email/draw_cancelled, email/win (lib/draws.js:298 — email channel only).

Dead — no caller with that (channel, slug) anywhere:
- `email/otp` (migrations:104) — signup codes are operator-issued `otp_codes` rows (admin.js:746ff), never emailed via this template; login OTP uses `otp_login`, and `notify.send` does an exact (channel, slug) lookup (lib/notify.js:15-17) with no slug fallback.
- `sms/otp` (migrations:114) — SMS login OTPs are sent by direct Twilio/Textbelt fetches with a hard-coded body in lib/otp.js:53-86, bypassing the template system entirely.
- `sms/win` (migrations:115) — wins notify email-only (draws.js:298); scratch wins send nothing (no notify call in routes/scratch.js / lib/scratch.js).
- `push/win` (migrations:116) — no push caller at all, and `lib/notify.js:71-73` `sendPush` unconditionally throws "Push provider not configured", so even a wired call could not deliver.

Could not disprove any of the four.

## DS-028 (D-07, Medium) — No announcement/in-app notification system; admin broadcast is email-only — **SURVIVES** (with nuance)

Disproof attempt: `grep -rni announce|inbox|bell` over routes/lib/views/server.js/public = 0 relevant hits. `notifications_log` is written by lib/notify.js but read by **no** player route — player.js and site.js contain no `/notifications` route or reference, `views/layout.ejs` has no bell/inbox, and live repro: player GET `/notifications` → 404. Admin broadcast (admin.js POST `/notifications/send`, handler at :1640ff) calls `notify.sendRaw(..., 'email', ...)` with the channel hard-coded for every recipient/segment and queued batches are inserted as `'email'` rows — there is no channel selector and no in-app fallback; with no SMTP every send lands `failed` in the outbox (seen live: welcome + support_reply rows both `failed`).

Nuance (not a disproof): the Tawk.to extension (below, DS-029) is a chat widget, not an announcement/inbox system, and CMS pages are static content an operator could repurpose as a notice board — neither is a per-player in-app notification system, and neither exists as such in the baseline. Finding stands as written.

## DS-029 (D-08, Medium) — No contact page/form for logged-out users — **SURVIVES** (with nuance)

Disproof attempt: `routes/site.js` (full file) registers only `/api/stats`, `/`, `/page/:slug`, `/results`, `/fairness`, POST `/currency`, sitemap/robots/healthz — no `/contact` GET or POST. Seeded PAGES (migrations:89-95) = about / how-it-works / faq / terms / privacy — no contact page, and `/page/:slug` only renders an existing published CMS row, so live repro: GET `/contact` → 404 and GET `/page/contact` → 404 (logged out). Support itself requires login (player.js:593 `requireLogin`; live: logged-out /support flow goes to login). The only baseline contact artefact is the `footer_contact` content block (migrations:83) rendering the plain text "Support: support@cashpop.live" — an address a visitor could email from their own client, but no form, exactly as audit-D recorded.

Nuance (not a disproof): an operator *could* (i) create a CMS page with slug `contact` via Admin → Pages, yielding a static `/page/contact` — still no form/handler behind it; or (ii) enable the seeded `tawkto` extension (migrations EXTENSIONS: `['tawkto', …, 0, { embed_code: '' }]` — **disabled and unconfigured by default**) whose embed renders for all visitors when enabled+configured (views/layout.ejs:135-136). Both are operator/third-party add-ons absent from the baseline as shipped; neither is a built-in contact page/form. Finding stands as written.

## DS-060 (D-09, Low) — No attachments on support tickets — **SURVIVES**

Disproof attempt: searched the whole baseline for any upload mechanism — `grep -rni multer|formidable|busboy|enctype|type="file"` over all .js/.ejs/package.json = **0 hits** (not even for deposit proof). `views/support.ejs` and `views/support_view.ejs` contain only text/textarea/select fields; the admin support detail form (admin.js:1470) is a textarea-only `ui.formHtml`. Schema: `support_messages` in all drivers (migrations:234/366/492; live PRAGMA confirms) is `id, ticket_id, author_id, author_role, body, created_at` — no attachment/file column, and `support_tickets` has none either. Could not disprove.

## DS-061 (D-10, Low) — Player cannot close/reopen own ticket — **SURVIVES**

Disproof attempt: enumerated every player-router POST (player.js) — the only support POSTs are `/support/new` and `/support/:publicId/reply`; `grep close|reopen routes/player.js` yields only unrelated draw-close logic and the reply guard at :620. `views/support_view.ejs` offers a closed-ticket player only "Open a new ticket" (:25) — no close/reopen button or form in either support view. Close/reopen exist solely admin-side (admin.js:1489 POST `…/close`, :1498 POST `…/reopen`, R-103-guarded; verified working in audit-D live steps 12-13 and consistent with the baseline code; RBAC lib/rbac.js:23 restricts those POSTs to staff). No JS in public/ adds a player-side control. Could not disprove.

---

### Live-repro summary (baseline, port 3354, ticket SMVRSWWMR6634C0)
register 302 → create ticket 302 → rendered reply-form POST `/support/<id>` **404 "Page not found.", message absent from DB** (DS-001) → direct `/reply` POST 302, message persisted, **no audit/notify rows** (DS-026) → creation had produced **no audit/notify rows** (DS-025) → admin reply 302, status `answered`, `support_reply` outbox row created → player view then shows **"This ticket is closed" + no reply form** (DS-009) → GET `/contact` 404, GET `/page/contact` 404 (DS-029) → GET `/notifications` (player) 404 (DS-028) → DB: `support_tickets` has no assignee column, `support_messages` has no attachment column, 15 templates seeded (DS-010/060/027). Server killed after the run.
