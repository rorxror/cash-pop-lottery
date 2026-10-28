# DISCOVERY FINDER D1 — Money & Game Logic (v20 owner-fix round)

Finder: D1 (backend money/game logic + settled money flows + agent transfer E2E).
Snapshot: `/tmp/hunt-snapshot/` (frozen). Nothing in the app tree was edited.
Boot used for all repros: port 4131, fresh SQLite `/tmp/d1.sqlite`,
`ADMIN_SEED_EMAIL=admin@d1.test` (seeded admin), players registered via the real
register flow, `email_verified=1` set via DB for deposit flows (per brief).
Admin console path on this boot: `/ops-7f3a9c-console`.
Admin percent/charge edits, bonus campaign creation, draw cancels and commission
settles were all driven through the real admin UI routes, not just the lib.

Dedupe: COMPILED-LIST.md, deepseek-round/COMPILED.md, deep-scan-round/COMPILED.md
and the U-01..U-26 ledger were checked before reporting. R-022 (fee capped at
amount, net ≥ 0) is the nearest prior item to D1-C1 — C1 is the residual edge
that fix created/left (net **exactly** 0), reproduced live on this snapshot, not
a re-report of R-022 itself.

---

## CANDIDATES (each with a live repro on the snapshot boot)

### D1-C1 — A deposit whose charge ≥ amount (net = 0) can be created but can NEVER be approved; it is stuck in `pending` forever

- Surface: player deposit → admin deposit approve (lib/money.js `createDeposit` /
  `decideDeposit` / `postLedger`).
- Root chain:
  - Admin method validation rejects only a **negative** percent charge
    (`routes/admin.js:1683` create, `:1715` edit: `if (pctNew < 0) throw`) — 100%
    or more is saveable. A fixed charge ≥ the method minimum produces the same
    state without any percent at all.
  - `lib/money.js:125` `charge = Math.min(chargeFor(method, amountMinor), amountMinor)`
    (the R-022 cap) → `net = amount − charge = 0`.
  - `decideDeposit` approve posts the credit at `lib/money.js:164`:
    `postLedger(..., type:'deposit', amount: d.net)` with `d.net = 0`.
  - `postLedger` at `lib/money.js:48` rejects zero:
    `if (!Number.isSafeInteger(amount) || amount === 0) throw new Error('Invalid ledger amount')`.
    The whole decision transaction rolls back; the deposit stays `pending`.
- Repro (boot, real UI routes):
  1. Set method 10 (Bank Transfer) `percent_charge=100`, enabled (DB equivalent
     of the admin edit form, which accepts 100).
  2. Player p1 (verified) POST `/deposit/new` amount `10.00`, method 10, with the
     rail's required `custom_reference` → deposit created:
     `amount=1000, charge=1000, net=0, status='pending'`.
  3. Admin POST `/ops-7f3a9c-console/deposits/1/approve` → redirected back to the
     deposit page with error flash **`Invalid ledger amount`** (extracted from the
     rendered page).
  4. DB after: deposit still `pending`; no wallet row, no transactions for the
     player. Retrying approve can never succeed — only reject can clear it.
- Expected vs observed: an operator who configures a 100%-fee (or fixed-fee ≥
  minimum) method gets deposits that either credit 0 cleanly or are refused at
  creation with the true reason. Observed: creation succeeds, approval is
  mathematically impossible, and the admin sees only "Invalid ledger amount"
  with the deposit permanently pending.
- Asymmetry verified: the same net=0 state on the **withdrawal** side approves
  fine (approve posts nothing; hold was taken at creation). Driven live: method
  at 100%, withdrawal of 100 → `charge=100, net=0`, admin approve → `approved`.
  So this is deposit-approve specific.
- Severity note: money is not lost or double-credited; it is an operator trap +
  a permanently stuck queue item + a player whose paid deposit can never be
  credited from the UI.

### D1-C2 — A zero-amount agent commission row is created by a legitimate small ticket, and then that agent's commission settlement fails forever with "Invalid ledger amount"

- Surface: lottery buy (routes/player.js commission accrual) → admin/cron
  `settleAgentCommissions` (lib/money.js).
- Root chain:
  - `routes/player.js:226-227`: `const amt = Math.round(total * rate / 100);`
    then the commission row is inserted **unconditionally** — unlike the referral
    accrual a few lines above it, there is no `comm > 0` guard. With the default
    5% rate, any ticket total < 10 minor produces `amt = 0` (e.g. a $0.05 wager
    option — `wager_options` is an operator setting parsed via
    `parseAmountList`, any positive amount is allowed).
  - `lib/money.js:402` (`settleAgentCommissions`): per-currency totals are posted
    via `postLedger`. When an agent's unsettled rows in a currency sum to
    exactly 0, that post is `amount: 0` → `postLedger` throws
    `Invalid ledger amount` (lib/money.js:48) → the whole settle transaction
    rolls back, rows stay `settled=0`.
- Repro (boot, real routes):
  1. `wager_options='0.05'`, commission rate default 5%. Player p2 assigned to
     agent2 buys 1 pop × wager 5 minor × 1 draw → ticket total 5.
  2. DB: `commissions` row for agent2: `amount=0, settled=0`.
  3. Admin POST `/agents/<agent2>/settle-commissions` → agent page renders
     **`Invalid ledger amount`**; row stays `settled=0`; agent wallet: no row.
     A second identical attempt fails identically.
  4. Control case: agent1 with rows {0, 5} in USD settled fine (the 0 aggregated
     into a 5-minor post, wallet +5) — so the poison is precisely a
     **per-currency unsettled total of exactly 0**, most simply an agent whose
     only commissions are zero rows.
- Expected vs observed: settlement of a zero total should be a no-op success
  (mark rows settled, post nothing). Observed: hard failure, repeatable forever,
  for both the admin button and the daily cron job (lib/cron.js
  `settle_agent_commissions` catches per-agent, so other agents still settle —
  the affected agent silently never does, error only in the server log).

### D1-C3 — Scratch `buyTicket` never checks `ends_at`: a series whose end date has passed still sells tickets and takes money

- Surface: player scratch buy (lib/scratch.js `buyTicket`).
- Root: `lib/scratch.js:259` and the in-transaction re-check at `:265` both test
  only `status='live' AND enabled=1`. `ends_at` is consulted **only** by the
  cron lifecycle (`scratchLifecycle`), which runs on a 5-minute job interval
  and is skipped entirely when the automation master switch is off. Contrast
  the lottery buy, which re-checks `close_at` inside the purchase transaction
  (routes/player.js, R-072) precisely so a stale window cannot sell.
- Repro (boot):
  1. Gold Rush (series 5, live+enabled) → set `ends_at = now − 1 hour` via DB
     (the state the series is in between its end time and the next lifecycle
     tick — permanently, if automation is off).
  2. Player p1 POST `/scratch/5/buy` → **200, redirected to a new ticket**
     `SMVSL7A8OF8D7A6FF`, status `purchased`.
  3. Wallet debited exactly the price: 1895 → 1795 minor. Series still
     `live/enabled=1` afterwards.
- Expected vs observed: a buy after `ends_at` should be refused ("not on sale")
  by the engine itself. Observed: sale completes and money moves; only the
  scheduler eventually closes the window.

### D1-C4 — Withdrawal turnover gate counts fully-refunded ticket purchases as "wagered": a player who gambled net $0 passes the 1× wagering requirement and withdraws the whole deposit

- Surface: `checkWithdrawalRules` turnover check (lib/money.js:290-291) +
  `cancelDraw` refunds (lib/draws.js).
- Root: wagered is `SUM(ABS(amount))` over `ticket_purchase`/`scratch_purchase`
  rows. A draw cancellation posts a separate `draw_refund` credit — the
  original purchase row is never netted out, in this gate, in
  `releaseReferralCredits`' wagering check (lib/money.js:423/439, same pattern),
  and in bonus wagering (see D1-C5b).
- Repro (boot, one continuous chain, player p3):
  1. Deposit $1.00 → admin approves → wallet 100, approved-deposit net total 100.
  2. Buy 1 EVE ticket, total 100 → wallet 0.
  3. Admin cancels that draw → entry `refunded`, `draw_refund +100` → wallet 100.
     The player's net amount ever at risk: **0**.
  4. POST `/withdraw/new` $1.00 (OTP disabled in settings for the test) →
     withdrawal **created and held** (`WMVSL83YI64FDD2`, `pending`), wallet 0.
     The gate's own inputs at that moment: deposited(approved) = 100,
     wagered(per the gate's SQL) = 100 → `wagered < deposited` false → pass.
- Expected vs observed: a 100%-refunded purchase is not wagering; the gate
  should count 0 and refuse ("Wager $1.00 more before withdrawing"). Observed:
  full withdrawal of the deposit succeeds on refunded stakes alone. Repeatable
  per cancellation — an operator who cancels a draw (a normal, sometimes
  necessary action) hands every ticket holder instant turnover satisfaction.

### D1-C5 — `cancelDraw` reverses the stake but none of the purchase's side-effects: (a) agent commission on a refunded ticket is still paid out; (b) bonus wagering progress from a refunded ticket is kept

- Surface: lib/draws.js `cancelDraw` (refunds entries only) vs the buy-time
  side-effects created in routes/player.js (commissions insert :226-227;
  bonus `accrueWagering` call :243 → lib/bonus.js).
- Repro (a) — same p3 chain as D1-C4:
  - The refunded ticket (total 100, fully refunded) carried
    `commissions` row id 4: `amount=5, settled=0`.
  - After the cancellation, admin POST `/agents/3/settle-commissions` →
    row becomes `settled=1` and agent1's wallet goes **5 → 10 minor**: the
    house paid commission on a sale that netted it $0.
- Repro (b) — same boot, player p3 again:
  - Admin creates bonus campaign (fixed $1.00, `wagering_x=1`) and runs it →
    p3 grant: `amount=100, wagering_required=100, wagered=0`; wallet 100 → 200.
  - p3 buys a $1.00 DAY ticket → grant becomes `wagered=100/100` (requirement met).
  - Admin cancels that draw → entry refunded, wallet restored to 200.
  - Grant after cancel: still `wagering_required=100, wagered=100`. The bonus
    is now withdrawable (subject to other gates) although the only wager that
    "played it through" was refunded in full.
- Expected vs observed: cancelling a draw should void/never-pay the commission
  accrued on its refunded entries and reverse wagering progress those entries
  produced. Observed: both survive intact and pay out.

### D1-C6 — Agent transfer parses the amount with the wrong decimals: for a 0-decimal currency it moves 100× the typed amount

- Surface: POST `/agent/transfer` (routes/agent.js:133-138).
- Root: `routes/agent.js:138` `const amount = toMinor(req.body.amount);` —
  `toMinor`'s decimals argument defaults to 2 and the transfer route never
  passes the currency's real decimals. The player money routes do this
  correctly (routes/player.js:375 and :453 pass
  `decimalsFor(method.currency, getCurrencies(req.settings))`). Default
  currencies (USD/EUR/INR, all 2dp) mask it; any operator-added currency with
  `decimals ≠ 2` (currencies are an editable setting with a `decimals` field)
  is mis-scaled.
- Repro (boot):
  1. Add JPY (`decimals: 0`) to the currencies setting. Fund agent1's JPY float
     with 100,000 minor (DB; float balances are raw minor units).
  2. Agent POST `/agent/transfer`: `to_user_id=<own player>`, `currency=JPY`,
     `amount=500`.
  3. Observed: float 100,000 → **50,000**; player JPY wallet credited
     **50,000 minor** (displays as ¥50,000 in a 0-decimal currency);
     `agent_transfers` row records `amount=50000`. Intended ¥500 became ¥50,000
     — a 100× over-transfer out of the agent's float.
- Same pattern (not driven, flagging for the admin-scope finder): the two other
  bare `toMinor(req.body.amount)` call sites — admin agent-float funding
  `routes/admin.js:1289` and admin balance adjustment `routes/admin.js:1093`
  (the latter is base-currency only, so it bites only if the base currency
  itself is non-2dp).

### D1-C7 — Agent transfer has no server-side double-submit protection: two parallel identical POSTs both execute (float debited twice, player credited twice)

- Surface: POST `/agent/transfer` (routes/agent.js:133). No idempotency key,
  no form token, no rate limit on the route (contrast: the deposit/withdrawal
  engine in lib/money.js is built around `idempotency_key`, and player money
  POSTs carry rate limits). The only guard is client-side: public/app.js (c1)
  disables the submit button after a submit — it cannot stop two requests
  already in flight, a replay, or a scripted repeat.
- Repro (boot):
  1. Agent1 float USD 10,000 minor; player p1 USD wallet 1,795.
  2. Two **parallel** POSTs `/agent/transfer` (same agent session + CSRF,
     identical body: player p1, USD, `10.00`, note `double`).
  3. Observed: both return 200; float 10,000 → **8,000**; player wallet
     1,795 → **3,795** (+2,000 for one intended $10 transfer); two identical
     `agent_transfers` rows of 1,000; two `agent_funding` ledger credits.
- Expected vs observed: a duplicated submission of one transfer intent should
  apply once (idempotency) or at minimum be rate-limited. Observed: every
  replay applies in full, bounded only by the float balance.

---

## UNPROVEN LEADS (suspicious, not promoted — no full repro)

- **L1 — Player deposit/withdrawal routes never pass a client idempotency key.**
  `createDeposit`/`createWithdrawal` (lib/money.js) accept `idempotencyKey` but
  routes/player.js calls both without one, so the engine generates a random key
  per call and a replayed POST creates a second record. Weaker than D1-C7
  (deposits still need an admin/webhook approval before crediting; a second
  withdrawal hold fails if the balance no longer covers it), and not driven
  end-to-end — recorded as a lead only.
- **L2 — Webhook missing-currency handling contradicts its own comment.**
  routes/webhooks.js: the comment at the amount-verification block says a
  missing payload currency "fails closed to manual review", but the code is
  `currencyOk = !ev.currency || <match>` — a payload with an amount but no
  currency can still auto-approve. Signature + exact amount + reference still
  gate it, so no exploit was demonstrated; the code/comment mismatch is the
  finding-shaped part.
- **L3 — Daily-loss accounting (`combinedDailyNetLoss`, lib/scratch.js:226-236)
  does not net `draw_refund`.** Lottery "won" counts only type `win`; a
  same-day refunded purchase still counts its full stake toward the day's net
  loss. Direction is conservative (blocks the player earlier, never pays out),
  so it is a fairness/accuracy lead, not a money leak.
- **L4 — Unguarded scratch-series status writes.** `launchSeries`' final UPDATE
  (lib/scratch.js:169) and the lifecycle stop/ended UPDATEs (:389, :399) carry
  no `WHERE status=...` guard. On the snapshot's SQLite (BEGIN IMMEDIATE) the
  in-transaction re-check plus the `UNIQUE(series_id, ordinal)` outcome insert
  backstop a double launch, and no failure could be produced; on
  Postgres/MySQL the launch guard rests on that UNIQUE failure rolling the
  second launch back. No repro — lead only.
- **L5 — Agent transfer form labels the amount "Amount (USD)" while the
  currency is selectable** (views/agent/transfer.ejs). Display-only (may belong
  to the D4/U-24 sweep); noted here because it sits on the D1-C6 surface — an
  agent transferring EUR/INR/JPY is told the field is USD.

---

## SWEPT CLEAN (evidence stated; "nothing found" is the result)

- **Guarded transitions (money statuses).** Grepped every status UPDATE in
  lib/money.js, lib/draws.js, lib/scratch.js, routes/agent.js. Deposit
  approve/reject/revoke, withdrawal approve/reject/revoke, mark-paid,
  referral claim/cap, commission settle count-check, draw settle/cancel,
  ticket-entry claim (settle + cancel), scratch-outcome claim and scratch
  reveal all carry a from-state `WHERE` guard plus a `changes` check.
  Live evidence: 3 parallel reveals of a winning scratch ticket (prize 200)
  credited exactly once (balance +200, one `scratch_prize` ledger row).
  Exceptions are the non-money or backstopped writes in L4.
- **Ledger-aggregate re-audit (the OWN-01 lesson).** Full ledger type list
  enumerated from every `postLedger` call site (deposit, bonus,
  deposit_revoke, bonus_revoke, withdrawal_hold, withdrawal_release,
  withdrawal_revoke, agent_commission, referral_commission, ticket_purchase,
  scratch_purchase, win, scratch_prize, draw_refund, agent_funding,
  adjustment). Every SUM in the in-scope files was checked against it:
  reconcile.js sums **all** types (complete by construction); prize totals in
  lib/prize-engine.js and the win totals use `win` + `scratch_prize` (both —
  the OWN-01 omission does not recur in scope); wagering sums use exactly the
  two purchase types (their defect is the refund netting of D1-C4, not a
  missing type). No aggregate in scope silently misses a ledger type.
- **Zero / negative / huge amounts at the engine.** `postLedger` rejects 0,
  non-integers and unsafe integers (lib/money.js:48); `createDeposit` /
  `createWithdrawal` reject ≤ 0; `toMinor` rejects malformed, comma-ambiguous
  and >2^53 inputs (lib/util.js). Scratch series creation requires price ≥ 1
  (routes/scratch.js:300, :426), so a 0-price series cannot reach `buyTicket`.
  The one place a rejected zero surfaces as a *stuck state* instead of a clean
  refusal is D1-C1/D1-C2 above.
- **Scratch lifecycle edges other than D1-C3.** Sold-out: `buyTicket` re-reads
  an unclaimed outcome inside the transaction and fails with "sold out";
  sell-out closure, expiry stop and auto-next cloning are cron-owned and were
  read line-by-line — no second defect proven. Reveal: commitment verified
  against the ticket's stored commitment before crediting, prize clamped ≥ 0,
  duplicate reveal returns the recorded prize without re-crediting (also
  proven under parallelism, above).
- **Draw settle / threshold interplay.** `settleDraw` refuses early settle for
  non-test draws except the operator-configured threshold path; entry claims
  are guarded; cancel-refund uses cumulative rounding over the ticket's actual
  entry count (the refunded amounts in the D1-C4 chain were exact: 100 in,
  100 back). Threshold roll (+24h, `rolls` counter, audit row) and the
  threshold-mode hourly extension behave as documented for thresholds ≥ 1.
- **Bonus engine budget/caps.** `runCampaign` runs in one transaction; the
  per-user cap and budget cap are re-read inside it and auto-stop flips the
  campaign inactive; percent campaigns with no base amount grant 0;
  `onFirstDeposit` counts `type='deposit'` ledger rows (fires once). The only
  bonus defect found is the wagering-reversal gap, D1-C5b.
- **Prize-engine planner.** `planPrizePool` was exercised across edge inputs
  (1 ticket, RTP 100%, tiny prices) by hand-checking the ladder math: winner
  count can never exceed inventory (liability ≤ gross ⇒ winners at minimum
  amount ≤ tickets), the 1× fill makes liability exact or reports the
  remainder as `unallocated`. Nothing found.
- **Reconcile.** Sums every transaction type per user/currency against wallet
  balances and reports (never hides) provider-txn deposits with no webhook
  event. Nothing found in scope.
- **Agent area other than transfer.** Player claim refuses already-assigned
  players for agents, agent player-creation enforces the 8-char player
  password rule, breached-password check, and email/phone uniqueness with
  `force_password_reset=1`; agent support routes are ownership-joined to the
  agent's own players. Nothing money-shaped found there.

## ALREADY-COVERED — VERIFIED STILL HOLDING ON THIS SNAPSHOT

- **Webhook fail-closed (U-21):** POST `/webhooks/cards` with no configured
  secret → `401 {"ok":false,"error":"no webhook signing secret configured"}`;
  unknown rail → 404. No credit path reached.
- **Threshold-0 draw trap (deep-scan B-11/C-09):** the engine alone would wait
  forever in `threshold` mode with threshold 0 (demonstrated by writing the
  settings directly via DB and calling `settleDueDraws` twice: draw stayed
  `scheduled`, `close_at` extended +1h per pass) — BUT the only operator entry
  point refuses the combination: routes/admin.js:604-609 rejects saving
  threshold mode with threshold 0 ("with 0 the draw could never settle.
  Nothing was saved."). Not a finding; the guard holds.
- **R-022 fee cap:** charge is indeed capped at the amount in both
  `createDeposit` and `createWithdrawal` (lib/money.js:125, :200) — no
  negative-net state exists. Its residual zero-net edge is D1-C1.

## D-FIX-B results

All items re-verified on the current tree before fixing (the finder's repros were re-run; line numbers had shifted after U-20/U-22/U-04). New regression tests: `test/v20-discovery-money.test.js` (6, lib-level) + `test/v20-discovery-fixes.test.js` (HTTP, port 4138). Migration **v21** created (see end).

- **C1 — FIXED.** (a) Percent-charge save validation: both admin method create (`pctNew`) and edit (`pctEdit`) in routes/admin.js now reject `>= 100` with "Percent charge must be less than 100% — at 100% or more, a deposit would credit the player nothing and could never be approved cleanly." Test: saving 100% is refused with that flash and the stored value is unchanged. (b) Defence in depth in `lib/money.js decideDeposit`: a pre-existing net-0 deposit now approves cleanly — status transitions to approved, the zero ledger post is skipped (postLedger rightly refuses 0), the charge stays recorded on the deposit row, and an `deposit.approve_zero_net` audit row is written in the same transaction; revoke of a net-0 deposit likewise skips its zero post. Test: net-0 deposit → approved, wallet unchanged, no zero ledger row, audit row present.
- **C2 — FIXED.** (a) The agent-commission insert at lottery buy (routes/player.js) gained the same `amt > 0` guard the referral accrual above it has. Test (HTTP): a $0.05 ticket at 5% creates NO commission row; a $1 ticket creates exactly one row of 5. (b) `settleAgentCommissions` (lib/money.js): per-currency totals that are not > 0 are a no-op success (rows still marked settled), and the row SELECT/settle UPDATE exclude voided rows (with a no-`voided`-column fallback for pre-v21 hand-built fixtures). Test: planted zero row + real 250 row settle → agent wallet +250, both rows consumed.
- **C3 — FIXED.** `buyTicket` (lib/scratch.js) checks `ends_at` before the sale check AND inside the purchase transaction (lottery close_at discipline); refusal is "This series has ended.", and the scratch buy route's true-reason passthrough regex gained `has ended` so the player sees it verbatim. Tests: past ends_at → refused, no charge; future ends_at → sells.
- **C4 — FIXED.** One shared fragment `NET_WAGERED_SQL` + `netWagered()` in lib/money.js: purchases (`ticket_purchase`/`scratch_purchase` ABS) minus `draw_refund` ABS, floored at 0. All three consumers use it: the withdrawal turnover gate in `checkWithdrawalRules` and both wagering checks in `releaseReferralCredits` (currency-blind pre-check and per-currency check). Test: deposit → buy → refund leaves the gate reading "wagered $0.00 of $10.00". **Lead L3 adjudication: STAND** — `combinedDailyNetLoss` (lib/scratch.js) deliberately does NOT net draw_refund; that is the conservative direction for a loss LIMIT (refunds don't restore loss-limit headroom), code left untouched.
- **C5 — FIXED.** **Mechanism finding:** bonus wagering progress is NOT computed from ledger sums — it is a stored counter, `bonus_grants.wagered`, incremented by `accrueWagering` at buy time with no per-ticket link, so C4's ledger netting could never fix the bonus half. (a) Commissions: `cancelDraw` (lib/draws.js) now VOIDs all unsettled commission rows for the cancelled draw's tickets — `settled=1, voided=1, voided_at` set (rows kept, never DELETEd), count recorded in the `draw.cancel` audit detail. **Honest boundary: already-settled commissions are NOT clawed back automatically** (proven untouched in test). (b) Bonus: new `bonus.reverseWagering` decrements grants oldest-first (same order accrue fills), floored at 0 per grant; cancelDraw calls it per refunded user+currency bucket. It is aggregate-exact for `unmetWagering` (the only gate consumer), not ticket-exact after interleaved buys. Test: full cancel → unsettled commission voided and no longer settleable, bonus unmet wagering restored in full.
- **C6 — FIXED.** All bare `toMinor()` sites now pass currency decimals: agent transfer (routes/agent.js, `decimalsFor(currency, getCurrencies(settings))`), admin agent float funding and admin manual balance adjustment (routes/admin.js; adjustment uses the base currency). Test: JPY "500" moves exactly 500 minor end-to-end (float −500, player +500); USD "10" still moves 1000.
- **C7 — FIXED (design: server-side one-time submission token).** GET /agent/transfer issues a fresh token stored server-side in the session and rendered as a hidden field; POST requires a match; inside the transfer transaction the `agent_transfers` row is INSERTed FIRST with `idempotency_key = token` (UNIQUE index, migration v21), so two parallel identical POSTs collide on the unique key and the loser's whole transaction (float debit included) rolls back → "This transfer was already submitted — check the transfer history." Tokenless/stale forms get "This transfer form has expired — reload the transfer page and try again." A failed transfer (e.g. insufficient float) rolls the claim back too, so the form can be corrected and resubmitted; success consumes the session token. Test: two PARALLEL identical POSTs → exactly 1 transfer row, 1 money movement; replay refused with the true reason; a fresh token transfers fine.
- **Migration v21** ('v20 discovery fixes: commission void marks, notification attempts, agent transfer idempotency', all 3 drivers, dirty-DB safe): `commissions` + `voided`/`voided_at`; `notifications_log` + `attempts`; `agent_transfers` + `idempotency_key` + UNIQUE index `idx_agent_transfers_idem` (NULL keys exempt).
