# U-20 ADMIN PASS — adjudication ledger (adj-admin.md)

Worker: U-20 (admin pass). Files owned: `routes/admin.js`, `routes/agent.js`,
`lib/admin-ui.js`, `views/agent/**`, `test/v20-admin-pass.test.js`.
Method: behaviour-first — every control exercised end-to-end against a rich
boot (seeded admin, 2 players, agent, support+finance staff, real deposits,
lottery buys, a settled draw, scratch purchase, support threads, KYC cycle,
bonus campaign) with DB/exact-money verification. A page returning 200 was
never treated as proof. Final harness state on the fixed build:
**79 checks PASS / 0 FAIL**; regression suite `test/v20-admin-pass.test.js`:
**12/12 PASS**. Counts: ~120 controls CHECKED-WITH-EFFECT, **5 proven breaks
(all fixed)**, 3 suspicions disproven / left as noted observations (below).

Console path in all evidence: `/ops-7f3a9c-console` (stealth prefix).

---

## Proven breaks — FIXED

### U-20.1 — Reports page 500 on an invalid date range — CONFIRMED BREAK, FIXED
- Chain link failed: route render (`routes/admin.js` GET /reports).
- Evidence (pre-fix): `GET /reports?from=bad&to=worse` → **500**. Server log:
  `RangeError: Invalid time value at fmtDateInput (routes/admin.js:76)` called
  from the reports handler (~line 1812). `dateRange()` detected the NaN and
  set the "Invalid date range." error, but the handler then called
  `fmtDateInput(NaN)` while building the tabs/form — the error branch was
  unreachable because rendering the error itself crashed.
- Fix (`routes/admin.js`): `dateRange()` now substitutes a safe default range
  (last 30 days) for rendering when either date is NaN, keeping the error
  message; `fmtDateInput()` additionally returns `''` for invalid ms.
- Post-fix proof: same URL → 200 with "Invalid date range." shown; normal
  /reports 200; regression test in v20-admin-pass.test.js.

### U-20.2 — U-19 settings slice absent — CONFIRMED GAP, FIXED (see U-19 section)
Settings page had no `support_max_open_tickets` / `support_max_new_tickets_24h`
fields anywhere, so the operator could not change the limits the player
backend enforces. Added a "Support ticket limits" Settings card + POST
`/settings/support-limits` (whole-number ≥ 0 validation, atomic refuse,
audit `settings.support_limits`). Verified: defaults 2/3 shown, save 5/7
persists, invalid (`-1`) refuses BOTH keys, 0 persists (unlimited).

### U-20.3 — Biodata save stores "[object Object]" as a player's name — CONFIRMED BREAK, FIXED
- Chain link failed: route input coercion (`POST /users/:id`).
- Evidence (pre-fix): urlencoded POST with `name[a]=b` (qs parses to an
  object) → handler did `String(b.name)` → the user's name in the DB became
  the literal text `[object Object]`. No 500 — silent data corruption.
- Fix: the handler now accepts only genuine strings (`str()` helper) for
  name/phone/address/city/state/zip/country/notes/email; non-strings read as
  empty and hit the normal validation. Audit detail uses the coerced values.
- Post-fix proof: same POST leaves the name untouched; no `[object Object]`
  rows exist. Regression test included.

### U-20.4 — Staff create 500 on object-typed fields (agents create same pattern) — CONFIRMED BREAK, FIXED
- Chain link failed: route input handling (`POST /staff`, `POST /agents`).
- Evidence (pre-fix): `POST /staff` with `name[a]=b` → **500** (raw body
  destructuring, then `.trim()` on an object). `/agents` destructured the
  same way (`email.trim()`), same class.
- Fix: both handlers coerce name/email/password with `typeof === 'string'`
  guards before any string method runs; invalid shapes fall into the normal
  "required/invalid" refusals.
- Post-fix proof: object name/email on both endpoints → clean refusal,
  status < 500, no row created. Regression test included.

### U-20.5 — Agent could claim ANY unassigned player by direct POST (id enumeration) — CONFIRMED, FIXED
- Chain link failed: authorization consistency (`routes/agent.js`
  POST /players/claim).
- Evidence (pre-fix): the unassigned-player pool list was deliberately made
  operators-only (privacy fix recorded in the GET /players handler), but the
  claim endpoint still let any agent claim any unassigned player by posting
  a guessed sequential `user_id`. Harness: agent claimed player B (never
  shown to them) via direct POST; `users.agent_id` changed.
- Fix: claim is now operators-only (`req.user.role === 'admin'`); agents get
  a true-reason flash ("Only operators can claim unassigned players…").
  Agents still receive players by operator assignment or by creating them.
  Admin claim behaviour unchanged.
- Post-fix proof: harness AG2 now reports "claim refused for agent";
  `agent_id` stays NULL. Regression test included.
- NOTE for coordinator/owner: if agent self-service claiming is ever wanted
  back, it should return WITH a visible pool UI, not as a hidden endpoint.

---

## U-25 — Support ticket soft delete, staff side (owner addendum) — IMPLEMENTED + PROVEN

Migration v19 columns (`support_tickets.deleted_at`, `deleted_by`) already
existed; no schema change was made. Audit action name `support.delete`
(matches the player side; actor role distinguishes staff vs agent rows).

Admin (`routes/admin.js`):
- POST `/support/:publicId/delete` — any staff with SUPPORT permission;
  executes on click, **no confirmation popup**; sets deleted_at/deleted_by;
  audit row `support.delete` (entity = public_id, detail = ticket id +
  status at delete); **sends no notification** (verified: notifications_log
  count unchanged across a delete). Missing/already-deleted → clean
  true-reason flash.
- GET `/support?deleted=1` — "Deleted" tab with count; lists only
  soft-deleted rows with deleted-at/by shown; links to the read-only view.
- GET `/support/:publicId?view=deleted` — read-only rendering: messages +
  banner ("soft-deleted on … by …; read-only… dispute evidence"); **no
  reply/close/reopen/delete forms** (asserted in tests). Without
  `?view=deleted`, a deleted ticket 404s exactly like a missing one.
- Explainer line present on the list (both views) and on the detail page:
  "Deleting a ticket is a soft delete: it is hidden from queues and counts,
  not erased, and stays viewable read-only under the Deleted filter as
  dispute evidence."
- POST reply on a deleted ticket → flash "This ticket has been deleted and
  can no longer be replied to.", redirect to queue; no message row;
  deleted_at unchanged (no resurrection). Close/reopen UPDATEs gained
  `AND deleted_at IS NULL` with "…or deleted" in the refusal message.
- Counts: dashboard "Open support tickets" tile query and the support
  queue's Open tab count both gained `AND deleted_at IS NULL`; the list
  total/rows are filtered by the same predicate (normal) or its inverse
  (Deleted view).

Agent (`routes/agent.js`, `views/agent/support_view.ejs`):
- POST `/agent/support/:publicId/delete` — scoped by the same `agentTicket()`
  lookup as replies (own players only, live tickets only). Another agent's
  player's ticket → 404 (existence not leaked) and stays live. Sets
  deleted_at/deleted_by + audit `support.delete` (actor_role agent). No
  notification.
- Agent list + detail + reply all exclude soft-deleted rows via
  `agentTicket()` / list query. Reply POST landing on an own player's
  deleted ticket returns the true-reason flash and writes nothing.
- Delete button + one-line soft-delete note added to the agent ticket view.
  No Deleted view for agents (per spec — operators hold the evidence view).

Proof: harness FIX4/FIX5 + two tests in v20-admin-pass.test.js (admin cycle
incl. counts/audit/no-email/read-only/reply-refusal; agent scope incl.
foreign-agent 404).

Interplay note: the backend worker's U-19 open-ticket cap counts
`status != 'closed' AND deleted_at IS NULL`, and their 24h cap includes
soft-deleted rows — consistent with this implementation (a deleted ticket
frees an open slot but still counts toward the daily creation cap).

---

## U-19 — settings wiring, admin slice — DONE (see U-20.2)
Keys (exact): `support_max_open_tickets` (default 2), `support_max_new_tickets_24h`
(default 3), 0 = unlimited — help text on the form states the 0 = unlimited
choice for both fields. Enforcement is the backend worker's; this slice
verified save → settings value changes, atomic invalid refusal, and that
RBAC keeps the POST super-only (`/settings/.+` rule).

---

## Checked-with-effect (no break found) — condensed evidence map

Stealth & auth: anon + logged-in player → 404 on console and scratch-admin,
each probe writing an `admin.probe` audit row; admin login redirects to the
console; 50-page admin GET sweep 200 (after U-20.1 fix).
RBAC: support staff 403 (no writes) on money/settings POSTs; finance 403 on
settings; credentials page super-only (support 403); staff create/login/role
round-trip; self-role-change refused; weak-password/duplicate staff refused
with no row; finance CAN decide KYC, support CANNOT (403); support CAN reply
to tickets.
Users: biodata valid save persists all fields (incl. KYC override,
auto-withdrawal limit, agent assignment); 4 invalid variants write NOTHING;
balance adjust ± with remark exact, without remark/bad amount refused;
deposit-block matrix gates the player (403 with reason) and restores;
ban kills sessions, unblock restores pre-ban status; verify-contact,
reset-password (token row), revoke-sessions, login-as (audited, impersonation
session works); admin-on-admin biodata/block → 404 unchanged; filters/
pagination/search sane; non-numeric and missing ids → 404.
Deposits/withdrawals: player deposit → approve credits exactly +$100.00,
reject credits nothing, note saves, double-approve no double credit,
missing id no 500; auto-withdrawal — $30 auto-approves at $50 global limit
(decided_by = 0, audit `withdrawal.auto_approve`, status approved NOT paid),
$80 stays pending, per-user override 10 makes $30 pending, mark-paid refused
without provider id and succeeds with one, approve→revoke releases the hold
exactly. Maker-checker: threshold $100 queues a $150 adjust with NO credit,
maker self-approve refused, support 403, finance approves → exactly +15000.
Draws/tickets: buy debits exactly, ticket+entry rows; dashboard tiles
(Sold/Prize/Players/Pending) equal hand-checked DB aggregates — prize total
includes `scratch_prize` (OWN-01 class re-checked); business report today's
staked == DB; real draw settle marks entry won/lost consistently with the
winning number and credits wager × prize-table multiplier; TEST draw
fixed-number settle; draw cancel refunds exactly.
Scratch (cross-boundary, routes/scratch.js is another worker's file —
exercised, not edited): buy+reveal credits exactly; planner liability hand
math $1×100 @75% RTP = exactly 7500 minor; create → launch → toggle → stop.
Prize engine: simulator RTP = multiplier/15 (×15 → 100.0%), simulator saves
nothing; prize save out-of-range refuses ALL rows atomically.
KYC: master ON via the settings form gates withdrawal (403 true reason);
player uploads PNG; admin document view returns the exact uploaded bytes;
another player 404s on it; reject without reason refused, reject with reason
shows the player the reason; resubmit → approve → verified; per-user
exempt/required override matrix; manual verify requires a note.
Settings (all atomic-validated): economy, risk (lock range 24–72 enforced,
amounts stored in minor), prizes, currencies (dup code/negative rate/base
not in list refused), appearance + blocked phone countries; toggles:
deposits_enabled OFF gates player deposits with 403; admin_totp_required
refused while the acting admin is unenrolled.
Automation & cron: master flip persists; draws/scratch save validation
(threshold mode + 0 refused atomically); job toggle is the SAME row from
both the Automation page and the Cron page; schedule save; run-now;
**scheduler gating proven by restart** — master OFF → a due job's
last_run_at holds across a reboot boot-tick; master ON → it advances.
Bonuses: create → run grants exactly $1.00 × eligible players and
granted_total matches; delete-with-grants refused; toggle-off run grants
nothing; master OFF run grants nothing; zero-amount campaign refused.
Extensions: google_analytics toggle + configure persist; unknown key 404.
Notifications: template edit persists; send-to-one lands in outbox;
bogus recipient writes nothing; announcement create → player-visible →
toggle hides → delete; process-due runs clean; outbox with garbage dates
renders (no 500).
Pages/content: page create → public 200 → invalid slug refused → edit to
draft → public 404 → delete; content block edit (footer_about) appears on
the homepage and restores.
Contact messages: visitor post → admin inbox → handled toggles both ways.
OTP signup codes: issue shows the code once in the flash; revoke; double
revoke clean. Fraud flags: review stamps reviewer/time; re-review clean.
Reconciliation: run creates a report; latest report 0 mismatches across
all wallets after the whole exercise (wallets == ledger).
Agents: float fund +$50 exact (funding a non-agent id 404s, no row);
transfer $5 exact both sides; overdraw and foreign-player transfers refused
with no movement; agent-created player lands assigned with forced password
reset; agent support list/picker/reply behavioural; unassigned pool NOT
visible to agents in the list.
TOTP: enroll → wrong code refused (nothing stored) → real code confirms
(secret stored) → disable refused with wrong password → succeeds with
password + fresh code.
Error paths: oversized canned-reply body truncates to 5000 (no 500);
missing user/deposit/KYC/draw rows 404.
U-01 class (leak sweep): 10 rendered admin pages asserted free of escaped
badge HTML (`&lt;span class="badge`), `&nbsp;` literals; source grep found
only legitimate raw-context entities (`&amp;` in a heading at
routes/admin.js settings area, `&lt;email&gt;` placeholder inside a raw
table cell) — both correct usage, not leaks.
Audit: /audit shows "Audit chain verified" over the full chained row set
after all of the above (147 rows in the final harness run).

## Observations logged, NOT fixed (not proven product breaks)
1. KYC RBAC mapping is inconsistent by surface: queue decisions ride the
   MONEY role set (`/kyc/.+` = super+finance) while manual verify on the
   user page rides SAFETY (super+risk). Both work; flagged for the
   coordinator/owner to confirm intent.
2. `views/agent/transfer.ejs` carries a pre-existing
   `data-confirm="Confirm this transfer?"`. The no-confirmation rule was
   stated for the admin console; the agent area predates it. Left as-is;
   flagged for an owner decision.
3. One transient, non-reproduced event: during a heavily parallel harness
   run (other workers' suites running concurrently), an impersonated
   session's GET /wallet returned 500 once. Re-tested immediately after on
   the same persisted DB → 200, and the identical flow passed in the other
   full runs. Recorded for honesty; no code change made on a single
   unreproduced observation.

## Cross-boundary evidence for U-21 (payments) — exercised as-is, not fixed
Payment-method config forms were exercised in their current shape only
(redesign is U-21's wave): create valid → row + player visibility after
enable; invalid variants (bad currency, negative percent charge, malformed
custom-fields JSON) refused with NO row; toggle flips DB + player
visibility both ways; edit persists; blocked rail (`ebt`) create refused.
No break found in the exercised paths. Deposit/withdrawal money movement
through the bank_transfer rail is exact (see above).

---

## U-26 INVENTORY — every admin route/page exercised (starting map for the ORG worker)

All paths below are relative to the console prefix (stealth path, currently
`/ops-7f3a9c-console`). "Exercised" = rendered AND its controls driven to a
verified effect during this pass unless noted.

### Dashboard
- GET `/` — KPI tiles (Sold/Prize/Profit totals, Players, Pending deposits/
  withdrawals, Open support tickets), recent activity. Numbers hand-checked.

### Lottery
- GET `/draws` — draw list; POST `/draws/test` — TEST draw create (fixed
  number); GET `/draws/:id` — draw detail; POST `/draws/:id/settle`;
  POST `/draws/:id/cancel` (refunds).
- GET `/tickets` — ticket list; GET `/tickets/:id` — ticket detail/entries.

### Users & staff
- GET `/users` — list + role/status/verification filters, search, pagination.
- GET `/users/:id` — biodata form, wallets, KYC override, auto-withdrawal
  limit, agent assignment; POST `/users/:id` (save), `/users/:id/adjust`
  (balance ±), `/users/:id/block` (block/unblock + access matrix),
  `/users/:id/verify-contact`, `/users/:id/reset-password`,
  `/users/:id/revoke-sessions`, `/users/:id/login-as`,
  `/users/:id/kyc-verify` (manual verify w/ attestation note),
  `/users/:id/matrix` (per-user deposit/withdrawal matrix — exercised via
  block endpoint family).
- GET `/staff` — staff list + create form; POST `/staff`;
  POST `/staff/:id/role`.
- GET `/security` — own TOTP; POST `/security/totp/start|confirm|disable`.
- GET `/login-history` — admin login history w/ date filter.
- GET `/otp` — signup codes; POST `/otp` (issue); POST `/otp/:id/revoke`.
- GET `/flags` — fraud flags; POST `/flags/:id/review`.
- GET `/approvals` — maker-checker queue; POST `/approvals/:id/approve`,
  `/approvals/:id/reject`.

### Money
- GET `/deposits` (+ `?status=`), GET `/deposits/:id`;
  POST `/deposits/:id/approve|reject|revoke|note`.
- GET `/withdrawals` (+ `?status=`), GET `/withdrawals/:id`;
  POST `/withdrawals/:id/approve|reject|revoke|mark-paid|note`.
- GET `/methods`, GET `/methods/new`, POST `/methods/new`, GET `/methods/:id`,
  POST `/methods/:id`, POST `/methods/:id/toggle`, POST `/methods/:id/delete`,
  GET `/methods/:id/credentials`, POST `/methods/:id/credentials`
  (credentials page super-only).
- GET `/reports` (+ `?type=`, `?from=&to=`) — business/users/login reports.
- GET `/reconciliation`; POST `/reconciliation/run`.
- GET `/referrals` — referral overview (rendered; read-only page).

### Agents (admin side)
- GET `/agents` — list + create; POST `/agents`; GET `/agents/:id` — detail
  + float; POST `/agents/:id/fund`; POST `/agents/:id/settle-commissions`.

### Games config
- GET `/automation` — Automation Console; POST `/automation/master`,
  `/automation/draws`, `/automation/scratch`, `/automation/job
...[truncated 5026 chars]