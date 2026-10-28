# DISCOVERY D3 — Scheduler / Cron / Notifications / Email Templates (Cash Pop v20)

Finder: D3 (discovery only — nothing fixed, no app code edited anywhere).
Tree: frozen snapshot `/tmp/hunt-snapshot/` only.
Method: live boot on port 4133, fresh SQLite `/tmp/d3.sqlite`, env
`TICKET_HMAC_SECRET=…`, `ADMIN_SEED_*` set, `BASE_URL` deliberately **unset**,
`DRAND_API=http://127.0.0.1:9` (dead beacon) where noted.
**Delivered-copy evidence = a local SMTP sink** (`/tmp/d3-sink.js`, port 4425,
`SMTP_HOST=127.0.0.1 SMTP_PORT=4425 SMTP_FROM=sender@d3.test`) — every email
below was read from the sink's captured `.eml` files, cross-checked against
`notifications_log` rows. Job effects were proven by DB before/after +
admin Run-now + real 60s scheduler ticks.
Dedupe: checked against `audits/COMPILED-LIST.md`, `deepseek-round/COMPILED.md`,
`deep-scan-round/COMPILED.md`, `owner-fix-round/LEDGER.md` and the other
owner-fix-round adjudications. All candidates below are **new** (the one
family overlap, A-09, is called out explicitly in D3-C8).

---

## Per-job table (all 10 registered handlers + scheduler core)

| Job (handler_key) | Ran? | Correct effect? | Failure behaviour | Verdict |
|---|---|---|---|---|
| Draw scheduler (`ensure_draws`) | Yes — boot tick + Run-now; 13 draws created for 7 days (past-close draws correctly skipped) | Mostly: settle + win payout exact ($1 × 13 mult = $13.00, wallet 4000−100+1300=5200) | **Lies**: per-draw settle errors and threshold-waits counted as "settled", job stays `ok`, no `cron.failed` audit (D3-C2) | **BUG D3-C2** |
| Session cleanup (`clean_sessions`) | Yes | Exact: planted expired session deleted, live session kept; message "removed 1 expired sessions" | n/a | Clean |
| Deposit expiry (`expire_deposits`) | Yes | **No**: expires deposits carrying a provider reference (D3-C9) | Reports honestly ("expired 2 stale deposits") — the effect itself is wrong | **BUG D3-C9** |
| Notification batches (`process_notifications`) | Yes | Happy path exact: due queued row delivered once, row → `sent`, message counts accurate | **Single-attempt**: transient SMTP failure → `failed` forever; due-while-notifications-off → `skipped` forever; no retry path (D3-C4). Also double-delivers under scheduler overlap (D3-C1) | **BUG D3-C4 (+C1)** |
| Ledger reconciliation (`reconcile_ledger`) | Yes | Exact: planted +999 wallet corruption reported as "1 mismatch(es)", report row + `reconcile.run` audit written, details JSON names user/currency/diff | Fails loudly via report, not silent | Clean |
| Token cleanup (`clean_tokens`) | Yes | Exact: 1 expired login OTP + 1 expired reset token + 1 expired signup code removed; NULL-expiry and future signup codes kept | n/a | Clean |
| Agent commission settlement (`settle_agent_commissions`) | Yes | Exact: 750+250 minor settled, agent wallet +1000, rows flagged settled; immediate re-run is a no-op ("settled 0 row(s)") — no double-pay | Per-agent errors logged to console.error, job continues | Clean |
| Scratch lifecycle (`scratch_lifecycle`) | Yes | Exact on all three arms: scheduled draft activated (outcomes generated), end-date series stopped+disabled, sold-out series (2/2 bought) closed to `ended`; message counts matched DB each time | Launch failures traced via scratch_events/audit (code) | Clean |
| Bonus campaign drops (`run_bonus_campaigns`) | Yes | **No**: drops silently lost + falsely reported when the bonus engine is off (D3-C3) | Reports `ok` / "drops fired" for drops that never happened | **BUG D3-C3** |
| Database backup (`backup_db`) | Yes | Exact: VACUUM INTO snapshot written at boot; retention test (24 files present) pruned to exactly the newest 7, message "pruned 17" accurate | n/a | Clean |
| Scheduler core (`lib/cron.js` tick) | Yes — 60s interval + boot tick observed | Master AUTO off freezes a due job across a full tick (last_run_at unchanged) ✓; handlerless job row → `last_status='error'` + `cron.failed` audit within one tick ✓ (fails loudly) | **No re-entrancy guard**: overlapping ticks re-run a still-running job (D3-C1) | **BUG D3-C1** |

---

## Candidates (all proven live unless marked)

### D3-C1 — Scheduler overlap: a job that runs longer than 60s is started again by the next tick; queued notification batches are delivered TWICE
- Where: `lib/cron.js` — `start()` uses a bare `setInterval(() => tick(ctx), 60000)` with no in-flight flag, and `tick()` only writes `next_run_at = started + interval` **after** the handler finishes. A still-running job therefore still looks "due" (`next_run_at <= now`) to the next tick.
- Repro: SMTP sink restarted with a 75s response delay (slow provider). One queued due row inserted (`notifications_log` id 20, subject "Overlap test"). App booted 20:52:48.
- Observed: sink captured **two identical deliveries of the same queue row** — msg 1 at 2026-10-28T20:52:47Z (boot tick) and msg 2 at 20:53:47Z (the +60s tick), both `Subject: Overlap test` to the same recipient. The single `notifications_log` row ends `status='sent'`; `cron_jobs` shows one innocent "1 sent, 0 failed, 1 due".
- Expected: one delivery per queue row. Any slow handler (SMTP timeouts × up to 200 rows in `process_notifications`, a big `backup_db` VACUUM, reconcile on a large ledger) is exposed the same way; `runNow` vs tick has the same hole by code reading (only tick↔tick was proven live).

### D3-C2 — `ensure_draws` reports false success: failed and merely-waiting settlements are counted as "settled"; Automation Console shows green while draws never settle
- Where: `lib/draws.js` `settleDueDraws()` catches each draw's error into the results array (`{drawId, error}` / `{waiting}` / `{rolled}`); `lib/cron.js` `ensure_draws` handler then reports `` `settled ${settled.length}` `` — the array length is *draws attempted*, not draws settled. Same pattern for `checkThresholdDraws` → "threshold-fired N".
- Repro A (failure): settings `beacon_enabled=1`, `beacon_required=1`, `DRAND_API` pointed at a dead port; draw 2 `close_at` moved into the past; Run-now `ensure_draws`.
  Observed: draw 2 still `status='scheduled'`, `winning_number` NULL; `cron_jobs.last_status='ok'`, `last_message="ensured upcoming draws; threshold-fired 0; settled 1; exposure alerts 0"`; **zero** `cron.failed` audit rows. The Automation Console page itself rendered the process row as `ok | … settled 1` and the Failure alerts card as *"No failed automation runs recorded."*
- Repro B (waiting): `draw_trigger_mode_eve='threshold'` (threshold 100, 0 entries sold), draw 3 past close; Run-now.
  Observed: draw 3 still `scheduled`, `close_at` extended +1h (1793220955000 → 1793224562205) — i.e. it *waited* — while the job again reported "settled 1".
- Expected: the message/console must distinguish settled / waiting / rolled / **failed**, and a draw that failed to settle (beacon-required outage is exactly the fail-closed case) must surface as an error + `cron.failed` audit like other job failures do.

### D3-C3 — Scheduled bonus drops are silently destroyed (and reported as fired) when the bonus engine is off
- Where: `lib/bonus.js` `runScheduledDrops()` unconditionally runs `UPDATE bonus_campaigns SET last_drop_at = ?` after `runCampaign()`, even when `runCampaign` returned `{skipped: 'bonus engine off'}` (also: outside window / inactive). The cron handler (`lib/cron.js`) then formats any non-empty result as `'drops fired: #N (0 grants)'`. Because the scheduler query requires `last_drop_at < starts_at`, a stamped campaign can never fire again unless the operator manually moves `starts_at`.
- Repro: `bonus_enabled=0`; scheduled campaign, `starts_at` in the past, `last_drop_at=0`, fixed 500 minor, audience all. Run-now `run_bonus_campaigns` → `last_status='ok'`, `last_message="drops fired: #2 (0 grants)"`, `bonus_grants` = 0 rows, `granted_total` = 0, **`last_drop_at` stamped**. Repeated with a second campaign (same result). Then `bonus_enabled=1`, Run-now again → "no scheduled drops due" — the drop is gone forever.
- Expected: a skipped campaign must not be stamped, and the console message must say "skipped (bonus engine off)", not "drops fired".

### D3-C4 — Queued notification batches are single-attempt: any non-sent outcome permanently consumes the batch; there is no retry/requeue anywhere
- Where: `lib/notify.js` `sendQueued()` rewrites the row's status to `failed` or `skipped`; both `process_notifications` (cron) and the admin "Process due" button only ever select `status='queued' AND scheduled_at <= now`.
- Repro A (transient SMTP failure): due queued row "Retry test A" inserted; sink killed; Run-now → row `status='failed'`, error `connect ECONNREFUSED 127.0.0.1:4425`, job message "0 sent, 1 failed, 1 due". Sink restored; Run-now again → job reports **"0 due"**, row still `failed`, sink shows the mail was **never delivered**.
- Repro B (notifications toggled off): due queued row "Off test B" inserted; `notifications_enabled=0`; Run-now → row `status='skipped'`, error "notifications off". Setting re-enabled; Run-now → row still `skipped`, never delivered.
- Expected: a batch that could not be sent for a transient/config reason should stay retryable (remain `queued` with an attempt count/last error, or a requeue action in the Outbox). Today one bad minute silently deletes a whole batch of player email.

### D3-C5 — Queued broadcast batches bypass the v20 outbox secret-masking: raw secret links are stored in `notifications_log`
- Where: `routes/admin.js` notifications/send — batch 1 goes through `notify.sendRaw()` (which applies `maskForLog`), but batches 2+ are written with a **direct INSERT** (`INSERT INTO notifications_log (... 'queued' ...)`) with the raw subject/message, no `maskForLog`. `sendQueued()` later updates only status/error, so the raw text stays in the log forever, including after delivery.
- Repro: admin broadcast to `all` (2 players), `per_batch=1`, `cooling=60`, message containing `https://cashpop.example/reset/SECRETTOKEN99887766`.
  Observed in `notifications_log` for the *same* broadcast: row 16 (batch 1, sent) body = `…/reset/*** thanks` (masked ✓); row 17 (batch 2, queued) body = `…/reset/SECRETTOKEN99887766 thanks` (**raw token in the outbox log**). Row 17 was then delivered correctly by `process_notifications` — delivery is fine; the *stored log copy* is the leak.
- Note: this is a bypass of the v20 masking fix; `test/v20-log-masking.test.js` covers `send()`/`sendRaw()` only, not this insert path. Anyone with admin-outbox access can read a live reset/verify token out of a queued batch row for its whole validity window.

### D3-C6 — Withdrawal rejection email says "rejectd" (delivered copy)
- Where: `routes/admin.js` `decideWd()` builds the template var as `status: decision + 'd'` (line ~1563); the maker-checker execution path does the same (line ~3040). `'approve'+'d'` and `'revoke'+'d'` happen to spell correctly; `'reject'+'d'` does not. The admin flash uses the same expression ("Withdrawal rejectd.").
- Repro: real $20.00 withdrawal created, admin clicked Reject. Sink-captured email: **Subject: "Withdrawal rejectd"**, body: *"Hi Ravi Kumar, your withdrawal of $20.00 was rejectd."* Identical text in the `notifications_log` row.
- Expected: "Withdrawal rejected" / "was rejected".

### D3-C7 — Marking a withdrawal paid (the normal direct path) sends the player NO notification at all
- Where: `routes/admin.js` `POST /withdrawals/:id/mark-paid` (~line 1573) performs `markWithdrawalPaid` + audit + flash, with **no `notify.send`** — unlike approve/reject/revoke (`decideWd`) and unlike the maker-checker approvals path, which *does* send `withdrawal_decided` with `status:'paid'`.
- Repro: withdrawal #2 ($10.00): admin Approve → sink mail 11 "Withdrawal approved" ✓. Admin Mark as paid with provider payout ID `PSP-998877` → withdrawal `status='paid'`, **mail count unchanged (11), no new `notifications_log` row**. The player is told their money was approved but never that it was actually paid — the one status that matters most.

### D3-C8 — Admin-generated password-reset and email-verification emails contain a bare relative link when `BASE_URL` is unset (A-09 pattern, new call sites)
- Where: `routes/admin.js` — user-update email change: `const link = (process.env.BASE_URL || '') + '/verify-email/' + token;` (~line 1005); admin reset-password: `const link = (process.env.BASE_URL || '') + '/reset/' + token;` (~line 1069). The player flows were fixed with a request-host fallback (SCAN A-09: `routes/auth.js` forgot, `routes/player.js` verify-email both use `BASE_URL || (req.protocol + '://' + req.get('host'))`); the two admin call sites were not.
- Repro (BASE_URL unset, the deployment default unless the operator sets it): admin clicked "reset password" for a player → sink mail body: *"reset your password here: /reset/‹token›. This link expires in 1 hour."* Admin changed a player's email → verification mail body: *"…here: /verify-email/‹token›. This link expires in 24 hours."* Contrast, same boot: the player's own forgot-password mail arrived with an absolute, working `http://127.0.0.1:4133/reset/‹token›` link.
- Expected: admin-triggered mails carry the same absolute link as the player flows (host fallback), so the recipient can actually use them.

### D3-C9 — `expire_deposits` expires deposits that carry a provider transaction reference, destroying a payable claim
- Where: `lib/cron.js` `expire_deposits` — the SQL spares only deposits whose `user_data` is non-empty. It never checks `provider_txn_id`. The handler's own comment states the intent: *"Deposits carrying any reference stay pending for admin review"* — a provider txn id is exactly such a reference (and `reconcile_ledger` treats provider-txn deposits as a distinct, tracked class).
- Repro: pending deposit, 49h old, `user_data='{}'`, `provider_txn_id='psp_txn_12345'` inserted alongside an identical no-reference control. Run-now `expire_deposits` → message "expired 2 stale deposits"; **both** rows `status='expired'`, including the provider-referenced one. Only `pending` deposits can be approved, so a gateway-paid deposit that sat unreviewed for 48h becomes unpayable by this job.

---

## Email-template findings (per template; delivered copies read from the SMTP sink)

| Template (channel/slug) | Verdict | Evidence |
|---|---|---|
| email / `welcome` | Clean | Delivered: "Welcome to Cash Pop Lottery" / "Hi Ravi Kumar, your account is ready. Good luck!" — name + site rendered, no placeholders |
| email / `password_reset` (player forgot) | Clean | Absolute link via host fallback, real token delivered, **log copy masked** (`/reset/***`) |
| email / `password_reset` (admin-triggered) | **BUG D3-C8** | Delivered link is the bare path `/reset/<token>` |
| email / `email_verification` (player) | Clean | Absolute link, real token delivered, log masked (`/verify-email/***`) |
| email / `email_verification` (admin email-change) | **BUG D3-C8** | Delivered link is the bare path `/verify-email/<token>` |
| email / `otp_login` | Clean | Delivered "Your login code is 202218. It expires in 10 minutes."; log copy masked to `******`. v20 masking verified on the **delivered** copy too (real code in the inbox, never in the log) |
| email / `otp` | Dead template (note) | Seeded + enabled, but no call site ever sends slug `otp` on email: signup codes are operator-issued and consumed in `routes/auth.js`; phone login reads the **sms**/`otp` template via `lib/otp.js`. Harmless, but the admin template list implies a signup email that does not exist |
| email / `win` | Clean | Live settle: Subject "You won $13.00!", body "Congratulations Ravi Kumar! You won $13.00 on ticket TMVSL9E295339F9CE." — amount = wager × multiplier exactly; log copy byte-identical (no over-masking) |
| sms / `win` | Clean (code + pattern) | Attempted only when the winner has a phone (test winner had none → correctly no row); same vars as the proven email path in both `lib/draws.js` and scratch reveal |
| push / `win` | Honest failure | Always attempted on a win; outbox row `failed` / "Push provider not configured" — visible, never faked as sent |
| email / `support_reply` | Clean | Live admin reply delivered: "Hi Ravi Kumar, support replied to your ticket "Where is my prize". Please sign in to read the reply." Agent path code-verified (`player_email` is selected in `agentTicket`) |
| sendRaw admin ticket alerts (no template) | Clean | New-ticket alert delivered to `support_notify_email` with correct public id, quoted subject and priority |
| email / `deposit_approved` | Clean | "your deposit of $50.00 has been approved and credited." — amount exact vs ledger credit |
| email / `deposit_rejected` | Clean | "your deposit of $30.00 was rejected. The amount was not credited." |
| email / `withdrawal_decided` | **BUGS D3-C6 + D3-C7** | `approved` copy clean; `rejected` copy reads "rejectd" (subject + body); `paid` never sent on the direct mark-paid path |
| email / `draw_cancelled` | Clean | Delivered on admin cancel; entry marked `refunded`, wallet restored exactly (+$1.00 stake) |
| email / `approval_rejected` | Code-swept only | Template exists/enabled; the single call site (`routes/admin.js` approvals-reject, ~line 3062) passes `name`, `action`, `amount` — all vars the template uses. Not triggered live (needs a second approver + maker-checker threshold) |
| Admin broadcast (`sendRaw`) | **BUG D3-C5** (queued batches) | Immediate sends delivered + log-masked correctly; queued-batch rows store raw body (see D3-C5) |

No template showed raw `{{placeholders}}` in a delivered copy, no HTML leaked
into the text part (all sends are `text:` only), and no wrong names/amounts
were observed in any delivered copy other than D3-C6's wording.

---

## Unproven leads (not counted as findings)

1. **Exposure-alert silence in `ensure_draws`**: the whole BP-23 exposure block is wrapped in `catch {}` — if `prize-engine` throws, alerts vanish with no audit/log trace while the job still reports ok. Not triggered live (would need corrupt prize data); code-level lead, same family as D3-C2.
2. **`runNow` ↔ tick concurrency**: same missing claim/guard as D3-C1 by code reading; only tick↔tick overlap was proven live.
3. **Scratch guardrail `stop_auto_next`** calls `setSetting(db, db.driver, …)` relying on a `.driver` property of the db handle; the guardrail path was not exercised live (guardrails disabled in tests). Lifecycle's other arms are proven clean.
4. **`clean_tokens` vs OTP brute-force accounting**: deleting expired `login_otps` rows also deletes their attempt counters. `createOtp`'s own 24h purge and per-code/per-hour caps bound this; no exploit was demonstrated.
5. **Mailer transport is cached at first send** (`lib/notify.js`): SMTP env is boot-time in practice, so this is informational only — env changes mid-process would silently keep the old transport.
6. **Cron schedule save resets every job's `next_run_at`** (`routes/admin.js` `/cron/schedule` rewrites all rows, even unchanged ones) and **Run-now on a paused job executes it** — both appear to be by-design UI behaviour ("runnable on demand"); noted, not filed.

---

## Swept clean (with evidence, not just code reading)

- **Boot tick**: all 10 jobs ran once at boot on a fresh DB, all `last_status='ok'` with accurate messages; backup file actually written to disk.
- **Scheduler failure loudness (handler level)**: a planted handlerless job row was marked `error` with the right message and a `cron.failed` audit row within one 60s tick — the machinery fails loudly *when the handler itself throws* (contrast D3-C2, where the error never reaches the handler boundary).
- **Master AUTO kill switch**: with `automation_master_enabled=0`, a due job's `last_run_at` was byte-identical after a full tick.
- **clean_sessions / clean_tokens**: exact deletions, live/unexpired rows preserved.
- **settle_agent_commissions**: exact totals, idempotent re-run, no double-pay.
- **scratch_lifecycle**: activation / end-date stop / sold-out close each counted and effected exactly once.
- **reconcile_ledger**: planted mismatch detected and reported with correct diff; report + audit rows written.
- **backup_db**: file written; retention prunes to exactly 7 with an accurate pruned count.
- **process_notifications happy path**: due queued batch delivered exactly once, row flipped to `sent`, counts in the job message accurate.
- **Delivered-copy secret hygiene for `send()`/`sendRaw()`**: OTP code, reset token and verify token all present in the sink-delivered mail and absent (masked) in `notifications_log` — the v20 masking fix holds on every path *except* the queued-batch insert (D3-C5).
- **Templates**: welcome, forgot-reset, verify-email, OTP login, win, support_reply, deposit approved/rejected, draw_cancelled — all delivered with correct names, amounts, ticket ids and links (exceptions are D3-C6/C7/C8 above).
- **Draw settle → win notification chain**: settlement credited the exact prize and produced email (sent) + push (honest failed) outbox rows; no notification was sent for a rolled-back or non-winning entry.

## D-FIX-B results

Re-verified on the current tree; regression tests in `test/v20-discovery-cron.test.js` (6, lib-level + in-process SMTP sink). Note the cron API is ctx-based (`tick(ctx)`, `runNow(ctx, id)`, handlers take `ctx`); run records live on `cron_jobs.last_status/last_message` plus `audit_log`.

- **C1 — FIXED.** Per-job in-flight guard in lib/cron.js (`inFlight` set, claim-before-run, release in `finally`); tick skips claimed jobs; runNow claims too and refuses with "This job is already running — wait for the current run to finish before running it again." Test: slow handler + two overlapping ticks + one runNow → exactly ONE execution; the job schedules normally afterwards.
- **C2 — FIXED.** `ensure_draws` tallies settle/threshold results into settled / deferred (waiting|rolled|skipped) / failed; any failure throws, so tick marks the run `error` and writes the `cron.failed` audit; runNow now writes `cron.failed` on failure too (previously tick-only). Message format: `ensured upcoming draws; threshold-fired <ok>; settled <n>; deferred <n>; failed 0; exposure alerts <n>`. Test: dead beacon (DRAND_API dead + beacon_required=1) → handler rejects "Beacon unavailable", job row shows error with that message, `cron.failed` audit exists; a failing handler via tick and via runNow both record error + audit.
- **C3 — FIXED.** `runScheduledDrops` (lib/bonus.js) stamps `last_drop_at` ONLY when the campaign actually ran (no `skipped` in the result); the cron handler message renders skips as `drop skipped: #<id> (<reason>)`. Test: engine off → drop reports skipped, `last_drop_at` stays 0 (still due); engine on → fires and stamps.
- **C4 — FIXED.** Bounded retries in `notify.sendQueued` (lib/notify.js): **3 attempts total** (`MAX_QUEUED_ATTEMPTS = 3`); a failed attempt increments `attempts` (migration v21 column) and re-queues with 60s backoff; the 3rd failure is terminal `failed` with "(attempts exhausted: 3/3)" appended to the error. Rows due while notifications are OFF are NOT consumed: sendQueued returns `deferred` and leaves the row untouched (no attempt spent). The admin "Process due now" path counts sent/failed/retrying/deferred honestly with the same vocabulary. Test: off → deferred, attempts stay 0; SMTP down → attempts 1, 2 re-queue, 3 terminal failed; SMTP restored → delivered to the sink.
- **C5 — FIXED.** The admin broadcast queued-insert (routes/admin.js POST /notifications/send) now applies `notify.maskForLog` to subject and message before INSERT — the same masking the immediate-send path uses. Test (HTTP): broadcast containing a reset link with a secret token, batched → queued rows are masked; a raw-token scan over ALL notifications_log rows finds nothing.
- **C6 — FIXED.** New `decidedWord()` map in routes/admin.js (approve→approved, reject→rejected, revoke→revoked, mark_paid→paid) used by decideWd's notification + flash and the approvals-execution notification — the old `decision + 'd'` produced "rejectd". Same-pattern extra found and fixed: the decideDep flash had the identical construction ("Deposit rejectd.") and now uses the same map. Test: withdrawal rejection mail (sink) and stored outbox say "rejected", never "rejectd"; approve says "approved".
- **C7 — FIXED.** The direct mark-paid path (routes/admin.js POST /withdrawals/:id/mark-paid) now sends the same `withdrawal_decided` notification with status 'paid' as the maker-checker path, after a successful `markWithdrawalPaid`. Test: direct mark-paid → new outbox row for the player saying paid; delivered subject "Withdrawal paid".
- **C9 — FIXED.** `expire_deposits` SQL gained `AND (provider_txn_id IS NULL OR provider_txn_id = '')` — a deposit carrying any provider reference is never expired by the job (its webhook may still land). Test: 49h-old deposit with provider_txn_id survives as pending; the unreferenced one expires.
