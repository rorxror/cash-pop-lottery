# Audit G — admin second pass + agent + scratch admin (v17 recovery, round 2 re-audit)

- Area: `routes/admin.js` (full second pass), `routes/agent.js` (deep), `routes/scratch.js` admin handlers.
- Base: fix copy `~/workspace/cash-pop-fix` (already contains round-1 fixes). AUDIT ONLY — no code file was modified.
- Files read in full: `routes/admin.js` (1934 lines), `routes/agent.js` (146 lines), `routes/scratch.js` (301 lines, adminRouter section + player handlers only where they bear on admin claims). Supporting checks: `lib/rbac.js`, `lib/money.js` (`decideDeposit`/`decideWithdrawal`/`markWithdrawalPaid`/`settleAgentCommissions`), `lib/draws.js` (`createTestDraw`, `closeAtFor`, `settleDraw`), `lib/scratch.js` (`launchSeries`, `buyTicket`, `revealTicket`, `logEvent`), `lib/auth.js` (`loadSession`), `lib/admin-ui.js` (`fieldHtml`/`formHtml`).
- Excluded (NOT re-reported): every item in `~/workspace/your_files/cash-pop-lottery/cash-pop-bug-audit-235.md` (B-001..B-235) and every fix in `~/workspace/cash-pop-fix/FIX-LOG.md` (round 1), including admin-takeover guards, the dead `admin_totp_required` gate, agent unassigned-list exposure, marketing fake-stats removal, dark mode, migration fingerprint, and agent-created `force_password_reset`.
- §2 headlines re-confirmed (not copied blindly): G-35 (staff role default), G-7 (maker-checker bypasses), G-5 (email-token non-invalidation), G-44 (series-stop seed logging). Each is re-verified below against current code with its own file:line.
- Tally: **38 confirmed findings = 4 High, 23 Medium, 11 Low.** Plus a "Checked and clear" section and a "Needs-check (NOT counted)" section. Only confirmed findings are counted.

## Findings

### G-01 — High — Staff role-change dropdown defaults to `super` (§2 G-35 RE-CONFIRMED)
- File: `routes/admin.js:1833`: hand-written `<select name="admin_role"><option value="super">super</option><option value="finance">finance</option><option value="support">support</option><option value="risk">risk</option></select>` — no `selected` attribute on any option, so the browser submits the first option, `super`.
- Contrast: the staff-*create* form at `routes/admin.js:1828` passes `value: 'support'` through `lib/admin-ui.js` `fieldHtml`, which does emit `selected` — create is safe, role-change is not.
- Consequence: a super admin who opens the Change-role form for a finance/support/risk staffer and clicks "Change role" without actively picking a role silently PROMOTES that staffer to super. The POST handler at `routes/admin.js:1852-1860` accepts `super` as valid and audits it as a normal `staff.role_change`.
- Fix pointer: render the staffer's current role as `selected` in the role-change select (or require an explicit choice with an empty first option rejected server-side).

### G-02 — High — Agent panel `?as=` lets any admin-role user WRITE as any agent, bypassing admin RBAC
- File: `routes/agent.js:15`: `function agentId(req) { return req.user.role === 'agent' ? req.user.id : parseInt(req.query.as, 10) || req.user.id; }` — used by every write: claim (`routes/agent.js:51-62`), player create (`routes/agent.js:67`), transfer (`routes/agent.js:109`).
- File: `routes/agent.js:13`: `router.use(requireLogin, requireRole('agent', 'admin'))` — no `rbacMiddleware` and no `admin_role` check, unlike `routes/admin.js:47`.
- Consequence: a staff user whose `role` is `admin` but whose `admin_role` is `support`/`risk`/`finance` (blocked from money/safety actions in the admin panel by `lib/rbac.js`) can pass `?as=<any-agent-id>` and fund players from that agent's float, claim players to that agent, and create players under that agent. Read access for admins was the stated intent ("admins get read access via the same routes", `routes/agent.js:17`); write impersonation was not.
- Fix pointer: in `routes/agent.js`, allow `?as=` for GET only, or restrict it to `admin_role === 'super'`; enforce the admin-panel role map on agent POSTs.

### G-03 — High — Maker-checker bypasses (§2 G-7 RE-CONFIRMED, expanded to this area)
- File: `routes/admin.js:782-795` (`maybeMakerChecker`) is called only from `decideDep` (`routes/admin.js:796`) and `decideWd` (`routes/admin.js:881`).
- The following money-moving actions never call it, whatever the threshold: manual balance adjustment (`routes/admin.js:538-555`, `postLedger` adjustment of any size), agent float funding (`routes/admin.js:703-715`, house money into a float), commission settlement (`routes/admin.js:692-701`, ledger credit to the agent wallet), withdrawal mark-paid (`routes/admin.js:898-905`, the final irreversible payout step), and draw settlement (`routes/admin.js:257-264`, pays all winners of a draw).
- Consequence: a single finance staffer can move arbitrarily large sums through any of these paths while the threshold + second-approver control the operator believes is in place covers only deposit/withdrawal approve/reject/revoke.
- Fix pointer: route each of these actions through `maybeMakerChecker` (with a `pending_approvals` execution path for mark-paid/settle/adjust/fund), or document explicitly that they are intentionally exempt.

### G-04 — High — Admin email-change does not invalidate prior pending verification rows (§2 G-5 RE-CONFIRMED)
- File: `routes/admin.js:478-488`: on an admin email change the handler only `INSERT`s a new `email_verifications` row (token, 24h expiry). There is no `UPDATE … SET used = 1` / delete of earlier pending rows for that user.
- File: `routes/auth.js:367-369` (verified): the verify-click handler accepts any row with `used = 0 AND expires_at > now()` and marks only that row used.
- Consequence: change A→B→C leaves the B token live until expiry; clicking it after the C change swaps the account back to B. The round-1 duplicate-address refusal (`routes/admin.js:472-477`) does not close this, because B is an address the user previously held, not another account's.
- Fix pointer: before inserting the new row, mark all prior `used = 0` rows for that user used/expired.

### G-05 — Medium — Admin password-reset likewise never invalidates prior reset tokens
- File: `routes/admin.js:505-524` (`POST /users/:id/reset-password`): inserts a fresh `password_resets` row (1h expiry) and destroys sessions, but never invalidates earlier unused reset rows for that user.
- Consequence: every reset link issued in the last hour stays live; an old link forwarded, leaked, or left in an inbox can still reset the password after a newer link was issued. Same root cause as G-04, different handler and token table, so counted separately.
- Fix pointer: mark prior unused `password_resets` rows for the user used before inserting the new one.

### G-06 — Medium — Block/unblock does not restore the prior status (pending_review → active)
- File: `routes/admin.js:494-504`: `const next = u.status === 'banned' ? 'active' : 'banned';` — the toggle is binary and the pre-ban status is never recorded.
- Consequence: a `pending_review` user who is blocked and then unblocked lands as `active`, silently skipping whatever review was pending. The audit at `routes/admin.js:501` records old/new correctly, but the operator has no restore path.
- Fix pointer: store the pre-ban status (or unblock to `pending_review` when that was the prior state) instead of hardcoding `active`.

### G-07 — Medium — Agent float funding has no agent/existence check at all
- File: `routes/admin.js:703-715` (`POST /agents/:id/fund`): reads/writes `agent_floats` keyed by `req.params.id` directly; unlike settle-commissions (`routes/admin.js:692-701`, which first fetches `users WHERE role = 'agent'` and 404s otherwise), fund never checks that the id exists or is an agent.
- Consequence: funding a mistyped id, a player id, or a nonexistent id silently creates a real `agent_floats` row (house money parked under a non-agent/ghost id), flashes "Float funded.", and audits `agent.float_fund` as if an agent was funded. It can only be found by querying the floats table directly.
- Fix pointer: fetch `users WHERE id = ? AND role = 'agent'` first and 404 otherwise, mirroring settle-commissions.

### G-08 — Medium — Maker-checker "already queued" swallows a DIFFERENT decision
- File: `routes/admin.js:782-788`: the existing-approval check is `WHERE entity = ? AND entity_id = ? AND status = 'open'` — it ignores `action`. If it finds one, it returns `true` and the caller flashes the generic "queued for a second approver" message.
- Consequence: if an approve is already queued for a deposit and an admin then tries to REJECT it, nothing is executed and nothing new is queued — the reject is silently discarded while the flash implies it was queued. The deposit can then only move via the original approve decision.
- Fix pointer: match on `action` as well, or queue/replace the new decision explicitly and say so in the flash.

### G-09 — Medium — Approval rejection (and direct deposit rejection) notifies nobody
- File: `routes/admin.js:1766-1775` (`POST /approvals/:id/reject`): updates the row and audits `approval.rejected`, but sends no notification to the requester or the player.
- Contrast: direct withdrawal decisions notify (`routes/admin.js:887-891`, notify on every decision including reject), and approval-approve notifies (`routes/admin.js:1755-1764`); direct deposit decisions (`routes/admin.js:795-810`) notify only on approve, not on reject.
- Consequence: a player whose large deposit/withdrawal was rejected by the second approver hears nothing, and the requesting admin gets no rejection signal either — the item just sits as "rejected" in Approvals while the underlying deposit/withdrawal stays pending with no visible explanation.
- Fix pointer: send the same `deposit_approved`/`withdrawal_decided` (or a rejection) notification on approval-reject and on direct deposit reject.

### G-10 — Medium — Admin TOTP disable is password-only; TOTP confirm/disable have no rate limit
- File: `routes/admin.js:1901-1913` (`POST /security/totp/disable`): requires only `verifyPassword` — no current TOTP code and no backup code. Contrast: the round-1 player TOTP-disable fix (`routes/player.js:481-493` per FIX-LOG) requires password PLUS a current TOTP or backup code.
- File: `routes/admin.js:1890-1899` (confirm) and `1901` (disable): neither uses `rateLimit`. A grep of `routes/admin.js` and `server.js` finds no `rateLimit` import/use at all (player scratch buy/reveal do use it, `routes/scratch.js:97,108`).
- Consequence: anyone holding an admin session plus the password can strip the admin's authenticator permanently without ever possessing the second factor; and 6-digit TOTP guesses on confirm, and password guesses on disable, are unlimited.
- Fix pointer: require a current TOTP or backup code to disable (mirroring the player flow) and add a per-admin rate limit + lockout to confirm/disable.

### G-11 — Medium — Unguarded `JSON.parse` crashes the dashboard, tickets list, and ticket report
- File: `routes/admin.js:100`: dashboard exposure loop does `JSON.parse(e.pops || '[]')` with no try/catch; `routes/admin.js:282` (tickets list) and `routes/admin.js:1107` (ticket report) do the same for `t.pops`.
- Contrast: ticket detail at `routes/admin.js:297` wraps the same parse in try/catch.
- Consequence: a single malformed `pops` value in the tickets table makes the whole dashboard, the whole tickets list, or the whole ticket report 500 for every admin (the dashboard is the landing page, so this is also a panel lockout vector).
- Fix pointer: wrap all three parses in try/catch and skip/render the corrupt row, as ticket detail already does.

### G-12 — Medium — Body-parsing crashes on user biodata save and page create/edit
- File: `routes/admin.js:462-463` (`POST /users/:id`): `req.body.name.trim()` runs unconditionally before any presence check; a POST without `name` throws `TypeError` (uncaught → 500) instead of a validation flash.
- File: `routes/admin.js:1424` (`POST /pages/new`) and `routes/admin.js:1442` (`POST /pages/:id`): `const slug = req.body.slug.trim().toLowerCase();` sits OUTSIDE the try block, so a POST without `slug` 500s; the `name`/`title` trims inside the try are caught, the slug trim is not.
- Consequence: malformed or scripted POSTs (not just browser-form use) crash the request instead of failing cleanly; the user-save crash also means no audit row is written for the attempt.
- Fix pointer: guard with `String(req.body.name || '').trim()` / `String(req.body.slug || '').trim()` and return a validation flash when empty, as other handlers do.

### G-13 — Medium — User biodata save: unvalidated `kyc_status`, unvalidated `agent_id`, misleading audit on refused email
- File: `routes/admin.js:462-466`: `kyc_status` is stored verbatim from `req.body.kyc_status` (no whitelist against the form's `none/pending/verified/rejected`), and `agent_id` is stored as `parseInt(req.body.agent_id, 10)` with no check that the id exists or has `role = 'agent'` (a non-numeric value yields `NaN`).
- File: `routes/admin.js:488-490`: the audit row's `new.email` is `req.body.email` unconditionally, even when the change was refused as a duplicate (`routes/admin.js:472-477`) or silently ignored as invalid/empty — the audit then claims the new email is an address the account never got.
- Consequence: a typo or crafted value can park a player under a nonexistent/non-agent "agent" (breaking agent reporting/claims) or an invented KYC state, and the audit trail misstates what the account's email became.
- Fix pointer: whitelist `kyc_status`, validate `agent_id` against `users WHERE role = 'agent'` (null when blank), and audit the email actually stored, not the requested one.

### G-14 — Medium — Economy settings POST has no validation at all
- File: `routes/admin.js:1654-1665` (`POST /settings/economy`): loops `wager_options, max_pops, max_draws, day_draw_time, eve_draw_time, commission_rate, deposit_mode, withdrawal_mode, auto_approve_deposit_limit, referral_rate, multi_draw_discounts` and stores each raw string; the only check is old-vs-new for the audit.
- Consequence: a typo stores `commission_rate = "abc"`, `max_pops = "-3"`, `day_draw_time = "99:99"`, or a malformed `multi_draw_discounts` string that downstream parsers then misread — money math (commission, referral, wager options) changes silently with a "saved" flash and a truthful-looking audit entry.
- Fix pointer: validate each field (numeric ranges for pops/draws/rates, HH:MM for times, enum for modes, parseable discount list) and reject the whole save on any bad value, as the risk POST already does for caps.

### G-15 — Medium — Currencies POST: no audit, negative rates accepted, base currency need not be in the list
- File: `routes/admin.js:1710-1719`: parses the JSON list, requires only `code` + `symbol`, then maps `rate: parseFloat(c.rate) || 1` and stores `base_currency` from a separate field. There is no `audit.log` call in this handler (contrast toggles/economy/risk/prizes, all audited).
- Consequence: (a) a negative rate (e.g. `-2`) is truthy, so it is stored as-is and corrupts conversion math; a zero rate is silently rewritten to `1`; (b) `base_currency` can be set to a code absent from the list, leaving the display/default currency undefined; (c) duplicate codes are not rejected; (d) none of it appears in the audit trail, so a bad currency change is undiscoverable from the panel.
- Fix pointer: require `rate > 0` finite, reject duplicate codes, require `base_currency` to be in the list, and audit old/new lists.

### G-16 — Medium — Prize-table POST silently rewrites bad input to ×5 and writes every row
- File: `routes/admin.js:1695-1708`: `const v = Math.min(15, Math.max(1, parseInt(req.body['mult_' + r.pops_count], 10) || 5));` then an unconditional `UPDATE` per row.
- Consequence: typing garbage, a decimal (`13.9` → 13), or leaving a field blank for one pops-count silently sets that multiplier to 5 (or a truncated value) while the flash says "Prize table saved." — an RTP change the operator did not intend, with only the audit `changes` map (which does record it) as a clue.
- Fix pointer: reject non-integer/out-of-range multipliers with an error flash and write nothing, instead of falling back to 5.

### G-17 — Medium — Risk POST silently clamps the payout lock outside its own label
- File: `routes/admin.js:1673`: `const lock = Math.max(0, Math.min(168, parseInt(...) || 0));` while the form label at `routes/admin.js:1611` says "Payout-detail change lock (hours, 24–72)".
- Consequence: garbage input becomes `0` (lock disabled — the least safe value) with a success flash; `200` becomes `168`, not the labelled 24–72 range. An operator who thinks they set a 48h lock can unknowingly have none.
- Fix pointer: validate `24 ≤ lock ≤ 72` (or whatever the intended range is) and reject out-of-range/garbage input instead of clamping.

### G-18 — Medium — Business report: unbounded date range × 5 queries/day, hardcoded USD, mixed-currency sums
- File: `routes/admin.js:61-66` (`dateRange`): no validation, no cap, no from≤to check; `routes/admin.js:1082-1092` loops one day at a time issuing 5 queries per day (sales, wins, deposits, withdrawals, new users).
- File: `routes/admin.js:1089`: every money column is rendered with `money(req, …, 'USD')` regardless of ticket/deposit currency; the same mixed-currency `SUM(net)` pattern feeds the deposit/withdrawal strips (`routes/admin.js:727`, `routes/admin.js:828`), which are then labelled with the base currency.
- Consequence: `from=2000-01-01&to=2030-01-01` issues ~55,000 sequential queries from one admin request (panel hang / DB load); and a multi-currency site's "Staked / Deposits / Withdrawals" totals add USD + EUR + … minor units as if they were one currency.
- Fix pointer: cap the range (e.g. 366 days), reject from>to and invalid dates, aggregate per day in one query, and either group totals by currency or label mixed-currency sums as such.

### G-19 — Medium — Support priority filter runs AFTER the LIMIT and the tabs drop each other's filter
- File: `routes/admin.js:1128-1131`: the SQL fetches `LIMIT 100` newest tickets, THEN `rows.filter(...)` applies the priority filter in JS; the status tabs link only `?status=…` and the priority tabs link only `?priority=…`.
- Consequence: with >100 tickets, older high-priority tickets are invisible under the High filter (they were cut off before filtering); and status + priority cannot be combined at all — clicking a priority tab silently drops an active `status=open` filter and vice versa.
- Fix pointer: push priority into the SQL WHERE clause (with pagination) and preserve both query params in every tab link.

### G-20 — Medium — Bulk notification send is unbounded, synchronous, and unvalidated
- File: `routes/admin.js:1314-1325`: the `all` and segment queries have no LIMIT (the send-form dropdown at `routes/admin.js:1251` is capped at 500, but the send itself is not); `routes/admin.js:1336-1346` then loops `notify.sendRaw` sequentially inside the request when batching is off.
- File: `routes/admin.js:1309-1312`: only `if (!subject || !message)` is checked — whitespace-only subject/message pass, there is no length cap (the form's `maxlength="150"` is client-side only), and an unrecognised `to` value falls through to the single-user branch, yielding 0 targets with a "processed for 0 player(s)" success flash.
- Consequence: a site-wide send to tens of thousands of players runs in one HTTP request (timeout → unknown partial state; resume is manual via `start_from`), and oversized/blank messages can be queued/emailed with no server-side bound.
- Fix pointer: cap or always-batch bulk sends (queue + background/cron processing), trim + length-check subject/message server-side, and reject unknown `to` values instead of treating them as a user id.

### G-21 — Medium — Scratch series create: no currency whitelist, silent inventory clamp, tier-label truncation
- File: `routes/scratch.js:245`: `currency` is only uppercased, stripped of non-letters, and sliced to 8 chars — never checked against the supported-currencies list. A series in a bogus currency (e.g. `XXX`) can be created and launched; `lib/scratch.js` `buyTicket` then debits a wallet in that currency, which players never hold, so the series can never actually sell.
- File: `routes/scratch.js:247`: `totalTickets = Math.max(1, Math.min(1000000, parseInt(...) || 0))` — garbage or negative input silently becomes 1 (or 1,000,000 for huge input) with a success flash, not a validation error.
- File: `routes/scratch.js:252`: `line.split(':')` takes only the third element as the label, so a tier line like `100:5:Win:Big` stores label `Win` and silently drops `:Big`.
- Fix pointer: validate currency against the settings list, reject non-positive/non-integer ticket counts, and split tier lines on the first two colons only (rest = label).

### G-22 — Medium — Scratch stop logs the full server seed in plaintext (§2 G-44 RE-CONFIRMED)
- File: `routes/scratch.js:292-299`: on stop, `logEvent(…, 'series.stopped', 'series', s.id, { seedReveal: s.server_seed })` writes the live server seed into `scratch_events` in plaintext.
- Consequence: anyone with DB/`scratch_events` read access after a stop learns the seed that generated the series' outcomes (the seed is also stored plaintext in `scratch_series.server_seed`, so this doubles the exposure surface into a second table with no reader or retention control — see G-23). No verification flow consumes the series seed (per §2), so the reveal buys nothing.
- Fix pointer: log only the `seed_hash` on stop (as is already stored), and stop writing the plaintext seed to events; if a public reveal is ever wanted, publish it through a dedicated, access-controlled verification page.

### G-23 — Medium — `scratch_events` is write-only: no reader anywhere in the panel
- Grep-verified: `scratch_events` is written by `lib/scratch.js` (`logEvent`, `launchSeries`, `buyTicket`, `revealTicket`) and by `routes/scratch.js:269,287,296` (create/toggle/stop), but no route in `routes/admin.js` or `routes/scratch.js` ever SELECTs from it.
- Consequence: series create/launch/toggle/stop (including the G-22 plaintext seed reveal) and every ticket purchase/reveal event are invisible to the operator from the panel — the audit trail the operator actually sees (`/audit`) contains none of it, so a stopped/seed-revealed series or a suspicious toggle leaves no panel-visible trace.
- Fix pointer: add a scratch-events viewer under the scratch admin (paginated, filterable by series/event) or mirror series lifecycle events into `audit_log`.

### G-24 — Medium — Scratch toggle flips `enabled` regardless of status, so "Enable" on a stopped series does nothing visible
- File: `routes/scratch.js:283-290`: toggle only flips `enabled`; `status` is untouched. The player lobby (`routes/scratch.js:11-15` and detail `routes/scratch.js:180-185`) requires `status='live' AND enabled=1`.
- Consequence: an operator who "enables" a stopped series (or a draft) sees the list flip to "on" and believes it is back on sale, but it never appears to players because `status` is still `stopped`/`draft`. Conversely a draft can carry `enabled=1` before launch, which reads as live in the list.
- Fix pointer: block toggle for non-live series (or make toggle on a stopped series an explicit relaunch/revive action that also sets status), and show status + enabled as one combined sale state.

### G-25 — Medium — Agent transfer POST does not enforce the active-player rule its own UI shows
- File: `routes/agent.js:104-107` (GET transfer form): players list is `status = 'active'` only. File: `routes/agent.js:116` (POST): the target lookup is `WHERE id = ? AND agent_id = ? AND role = 'player'` — no status check.
- Consequence: a direct POST funds a banned or `pending_review` player from the agent float even though the UI never offers that player — the UI's active-only list is not a control, it is a suggestion.
- Fix pointer: add `AND status = 'active'` to the POST target lookup (and, for symmetry, to the claim handler's expectations).

### G-26 — Medium — Agent panel N+1 queries (agents list, agent players, dashboard exposure)
- File: `routes/admin.js:629-638` (agents list): one query for all agents, then 3 more queries PER agent (player count, floats, commission sum) — no LIMIT on the agent list either.
- File: `routes/agent.js:38-42` (agent players): one ticket-count query per player; `routes/admin.js:79-140` (dashboard): one entries query per upcoming draw (up to 14).
- Consequence: page latency and DB load grow linearly with agents/players/draws; the agents list is the worst case because it is unbounded.
- Fix pointer: aggregate with GROUP BY / single JOIN queries (counts, float sums, commission sums in one pass) and paginate the agents list.

### G-27 — Medium — User/agent detail truncation with no view-all path
- File: `routes/admin.js:376-379` (user detail): transactions LIMIT 15, logins LIMIT 10, audit LIMIT 15, tickets LIMIT 10, flags/referral credits LIMIT 20 — rendered with no link to the full list. File: `routes/admin.js:670-671` (agent detail): commissions/transfers LIMIT 25, same gap.
- Consequence: an operator investigating a user/agent sees only the newest slice and has no in-panel path from the detail page to the rest (tickets list has no user filter link, transactions have no user filter, logins require retyping the email into `/login-history?q=`).
- Fix pointer: add "View all" links from each card to the corresponding filtered list (or paginate the cards).

### G-28 — Low — Phantom-success writes (no existence/changes check, success flashed anyway)
- Verified instances, all following the same pattern (UPDATE/DELETE, then success flash/redirect with no `changes` check):
  - `routes/admin.js:622` OTP revoke — "Code revoked." even for a nonexistent or already-revoked id.
  - `routes/admin.js:816,907` deposit/withdrawal notes — "Note saved." even for a nonexistent id (and notes are never audit-logged — see G-29).
  - `routes/admin.js:1010` method toggle — silent redirect, no flash and no audit, even for a nonexistent id; `routes/admin.js:1014-1017` method delete — "Method deleted." even for a nonexistent id.
  - `routes/admin.js:1173-1182` support close/reopen — audit-logged as `support.close`/`support.reopen` even when no ticket with that publicId exists.
  - `routes/admin.js:1812-1817` flag review — "Flag marked reviewed." even for a nonexistent flag id.
  - `routes/admin.js:1507-1512` cron toggle — silent redirect when the job does not exist; `routes/scratch.js:283-290,292-299` scratch toggle/stop — silent redirect when the series does not exist or (stop) is not live, with no flash either way.
- Consequence: operators cannot tell a real change from a stale-link/double-click no-op, and the audit trail records actions that changed nothing.
- Fix pointer: check `changes === 1` (or fetch the row first) and flash 404/error when nothing was affected, as the user handlers already do.

### G-29 — Low — Audit-detail gaps on money-adjacent writes (detail `{}` or missing audit entirely)
- Verified: method create audits only `{name}` and method update audits `{}` (`routes/admin.js:980,1004`) — no old/new rate, percent, min/max, currency, rail, or enabled; notification template update audits `{}` (`routes/admin.js:1389`) — no old/new subject/body for templates that send deposit/withdrawal/support mail; appearance update audits `{}` (`routes/admin.js:1723`) — no site_name/custom_css diff; page/content updates audit `{}` (`routes/admin.js:1447,1470`); extension update audits only `{enabled}` (`routes/admin.js:1226`) — no config keys changed.
- Missing audit entirely: currencies POST (`routes/admin.js:1710-1719`), phone-countries POST (`routes/admin.js:1689-1694`), cron schedule POST (`routes/admin.js:1491-1499`), cron toggle (`routes/admin.js:1507-1512`), reconciliation run (`routes/admin.js:1794-1801`), method toggle (`routes/admin.js:1009-1012`).
- Scratch-side same gap: series create logs only `{title, gameType, totalTickets}` (`routes/scratch.js:269`) — no price, currency, or prize pool/RTP; toggle logs only `{enabled}` (`routes/scratch.js:287`); stop logs only the seed (`routes/scratch.js:296`) — no sold/revenue snapshot at stop.
- Consequence: after a bad money/config change, the audit trail cannot answer "what changed, from what, to what" — the exact question it exists for.
- Fix pointer: audit old/new values for every write above (values only, never secret values for credentials/templates with secrets).

### G-30 — Low — Draws list capped at 60 with no pagination; settled history silently disappears
- File: `routes/admin.js:187`: `SELECT * FROM draws ORDER BY close_at DESC LIMIT 60`, then the same 60 rows are split into "upcoming" and "recent settled" cards.
- Consequence: once a site has >60 draws, older settled draws vanish from the panel entirely (no page param, no total, no archive link) — draw history and its per-draw detail pages become unreachable except by guessing `/draws/<id>`.
- Fix pointer: paginate the draws list (separate upcoming vs settled queries with totals).

### G-31 — Low — Users-list badge counts disagree with the list filter for NULL verification flags
- File: `routes/admin.js:338` (list filter): `COALESCE(u.email_verified,0) = 0` (and the same for mobile at `routes/admin.js:339`); file: `routes/admin.js:351-352` (badge counts): plain `u.email_verified = 0` / `u.mobile_verified = 0`, which excludes NULL rows.
- Consequence: the "Email unverified" tab badge shows a smaller number than the list it opens when any user has a NULL flag — the badge and the list disagree on the same filter.
- Fix pointer: use the same `COALESCE(…,0) = 0` predicate in both places.

### G-32 — Low — Deposit/withdrawal strips and report totals sum across currencies
- File: `routes/admin.js:727` (deposit sums by status) and `routes/admin.js:828` (withdrawal sums): `SUM(net)` over all rows regardless of currency, rendered under the base-currency label; same issue inside the business report at `routes/admin.js:1086-1089`.
- Consequence: on a multi-currency site the strip figures are not amounts in any real currency — they are minor-unit sums across currencies, presented as if they were base-currency totals.
- Fix pointer: group the strips by currency (or restrict to base currency and label the restriction).

### G-33 — Low — Test-draw creation accepts unvalidated dates/times/override numbers
- File: `routes/admin.js:220-229`: only `req.body.date` presence is checked. File: `lib/draws.js:22-30` (`closeAtFor`): splits on `-`/`:` and feeds `Date.UTC`, which silently normalises overflow (month 13 → next year, day 32 → next month) instead of rejecting it; file: `lib/draws.js:62-64`: the override is clamped with `Math.max(1, Math.min(15, parseInt(...)))`, which yields `NaN` for non-numeric input and stores that.
- Consequence: a typo'd test-draw date creates a draw on a different date than the operator intended (or a corrupt winning number), with a success flash and an audit entry recording the intended values, not the stored ones.
- Fix pointer: validate date as real `YYYY-MM-DD`, time as `HH:MM` in range, and override as an integer 1–15 (or empty) before calling `createTestDraw`.

### G-34 — Low — Scratch series detail returns 200 for a nonexistent series
- File: `routes/scratch.js:195-198`: `if (!series) return res.send(ui.layout(… 'Not found' …))` — no `.status(404)`.
- Consequence: monitoring, link-checkers, and any client distinguishing "exists" from "not found" by status see a successful page for a series that does not exist; inconsistent with the admin panel's `notFound` helper (`routes/admin.js:74`) and the scratch player routes (404 on missing ticket/series).
- Fix pointer: `return res.status(404).send(ui.layout(…))`.

### G-35 — Low — Login-history search is email-only; reports tabs have no pagination or totals
- File: `routes/admin.js:1514-1528`: the only filter is `LOWER(lh.email) LIKE …` — no IP, success/failure, browser/OS, or date filter, although the table shows all of those columns.
- File: `routes/admin.js:1098-1117`: every non-business report tab fetches `LIMIT 500` with no pagination and no total; the login tab additionally renders only `rows.slice(0, 200)` (`routes/admin.js:1102`) without saying 300 rows were dropped.
- File: `routes/admin.js:1280` (outbox) and `routes/admin.js:597` (OTP codes): `LIMIT 100`, no pagination, no total; `routes/admin.js:1364` (process-due): `LIMIT 200` with a flash reporting `due.length` as if it were the full due count.
- Consequence: operators cannot find a login by IP or isolate failures, and report/outbox/OTP views silently truncate — the visible rows look complete when they are not.
- Fix pointer: add IP/success/date filters to login-history, paginate every report/outbox/OTP list with totals, and report the uncapped due count (or "200+ processed") on process-due.

### G-36 — Low — Duplicate `google_oauth_enabled` toggle row
- File: `routes/admin.js:1562` ("Google sign-in") and `routes/admin.js:1572` ("Google login") list the same setting key twice in `TOGGLES`; the settings POST (`routes/admin.js:1632-1650`) then writes the same key twice per save.
- Consequence: the toggles page shows two checkboxes for one setting (confusing, and a second checkbox state can mask the first in form submission), and the audit `changes` map can record the same key twice.
- Fix pointer: delete one of the two entries.

### G-37 — Low — Page status unvalidated, sort column dead
- File: `routes/admin.js:1423-1432` (create): `status` is inserted verbatim from the body (no whitelist against `published/draft`); `routes/admin.js:1441-1451` (edit): `status || 'draft'` accepts any string as well. Create always inserts `sort = 0` and no UI or handler ever changes `sort`, while the list orders by `sort, name` (`routes/admin.js:1403`).
- Consequence: a crafted or mistyped status (e.g. `publish`) creates a page that is neither published nor draft in any UI filter, and page ordering cannot actually be controlled despite the sort column existing.
- Fix pointer: whitelist status to `published/draft` on both handlers and either expose sort editing or drop the column from the ordering.

### G-38 — Low — Method/payment-field validation holes left beside the round-1 rate/percent fix
- File: `routes/admin.js:956-1008` (method create/edit): rate and percent are now validated (round-1 B-176), but `min_amount`, `max_amount`, and `fixed_charge` go through `toMinor(...) || 0` with no negativity check, and `currency` is stored uppercased with no check against the supported-currencies list.
- Consequence: a negative min/max/fixed charge or a bogus currency can be saved and offered to players; the negative-charge effect is mitigated downstream by the `chargeFor` ≥0 clamp (FIX-LOG B-176), but the stored method itself is wrong and the min/max checks then operate on nonsense bounds.
- Fix pointer: reject negative min/max/fixed charge and require `currency` to be in the settings currencies list, mirroring the rate/percent validation.

## Checked and clear (verified NOT bugs — do not re-report)

- **Decide audit old_status is correct.** `lib/money.js:109-135` (`decideDeposit`) and `:166-195` (`decideWithdrawal`) return the pre-update row object, so `dep.status`/`w.status` in the admin audit detail (`routes/admin.js:800,887`) genuinely is the old status. The `new_status: decision` value uses the verb (`approve`) rather than the stored state (`approved`) — cosmetic only.
- **Early settle is blocked.** `lib/draws.js:97-101`: `settleDraw` refuses non-test draws whose `close_at` is in the future; test draws are intentionally exempt. The admin settle button (`routes/admin.js:257`) therefore cannot settle a real draw early.
- **Login-as a banned player is inert.** `lib/auth.js:143-170` (`loadSession`) loads the user fresh from the DB on every request and destroys the session when `status === 'banned'`, so a session created by login-as (`routes/admin.js:586-595`) for a banned user dies on its first use. Staff-role changes are likewise immediate for the same reason (fresh load, no cached role in the session).
- **Staff create role default is safe.** `routes/admin.js:1828` passes `value: 'support'` and `lib/admin-ui.js` `fieldHtml` emits `selected` for it — only the hand-written role-*change* select (G-01) is broken.
- **Agent claim-by-ID retained by design.** FIX-LOG (B-019) records that agents given an ID may still claim; only the unassigned-list exposure was fixed (`routes/agent.js:44-47`). Claim-by-ID is therefore not counted here.
- **Scratch stop does not void sold tickets, and reveal does not check series status** (`lib/scratch.js` `revealTicket` joins tickets/outcomes only). This reads as intended "stop sales, honour sold tickets" behaviour, not a double-pay — reveal is still guarded by the purchase-time commitment check and the claimed-status update. Left as a product decision (see Needs-check NC-2), not counted.
- **Method create/edit name/currency trims inside try are caught.** `routes/admin.js:956-1008` wraps those trims in try/catch → flash error, unlike the page/user handlers in G-12.
- **Mark-paid payout-id validation lives in lib.** `lib/money.js:276-289` trims and rejects an empty payout id and guards the approved→paid transition, so the handler's raw pass-through (`routes/admin.js:898-905`) cannot mark-paid without one.
- **Withdrawal charge retention on approve is correct.** `lib/money.js:171-182`: approve posts nothing back (the hold already debited the full amount); the fee is retained implicitly, not refunded.
- **Admin stealth + RBAC layering intact.** `routes/admin.js:33-47` (stealth 404 before `requireLogin`/`requireRole`/`rbacMiddleware`) and `routes/scratch.js` admin stealth + super/finance-only POST gate were re-read and behave as documented.

## Needs-check (NOT counted)

- **NC-1 — Pending money items for banned users.** `decideWithdrawal`/`decideDeposit` check only the item's own status, not the owner's current status. Whether a banned user's pending withdrawal should be auto-rejected/held on ban (vs. left for an admin decision) is a policy call I could not verify from this area's code; no finding counted on it.
- **NC-2 — Stopped-series ticket policy.** Whether already-sold tickets of a stopped series should remain revealable/payable (current behaviour, see Checked-and-clear) or be voided/refunded is a product decision; no refund/void path exists in this area either way.
- **NC-3 — Agent transfer currency whitelist.** The transfer POST (`routes/agent.js:109-135`) accepts any 8-char currency and fails closed only when no float row covers it (guarded UPDATE). Whether floats should be restricted to settings currencies could not be settled from this area alone.
- **NC-4 — Support `priority` values.** The priority filter (`routes/admin.js:1131`) assumes `high/medium/low` (defaulting to `medium`); whether other priority values can exist in the table (e.g. via player submission) was not verified here.
- **NC-5 — Audit search on Postgres.** The audit search (`routes/admin.js:1919-1924`) applies `LOWER(detail)` to the detail column; whether that column is text (fine) or JSON on Postgres (which would error) was not verified from this area's code and is left to the migrations audit, not counted here.
