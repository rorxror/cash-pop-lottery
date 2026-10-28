# Disprove B — Player Money (Adversarial Audit, DISPROVE protocol)

Date: 2026-10-28 | Agent role: DISPROVE (try to kill findings, not confirm them)
Baseline examined: `~/workspace/cash-pop-push/` (production v17.1, pre-fix, READ-ONLY — nothing edited)
Findings source: `COMPILED.md` + `audit-B.md` (+ `audit-F.md` for the three F-sourced items in scope)

**Scope set (confirmed from COMPILED.md):** DS-005 (B-01), DS-006 (B-02), DS-007 (B-03), DS-008 (B-04),
DS-013 (F-01), DS-014 (B-05/F-02), DS-016 (B-06), DS-017 (B-07), DS-018 (B-08), DS-019 (B-12),
DS-036 (F-04), DS-038 (F-06), DS-050 (B-09), DS-051 (B-10), DS-052 (B-11), DS-053 (B-13),
DS-054 (B-14), DS-055 (B-15) — 18 items.

**Method:** for each item, searched the baseline for a guard / second code path / aliasing /
middleware / setting that would make the finding a false alarm (content-verified by
function/route names, not line numbers alone). Additionally booted the untouched baseline on
port 3352 with a throwaway DB (`/tmp/disprove-b.sqlite`), registered a test player, planted a
gateway credential, enabled methods, set self-exclusion, and attempted live repros. Server
killed afterwards (`fuser -k 3352/tcp`, verified dead).

## TALLY: SURVIVES 18 · DISPROVEN 0

No item could be killed. Every attempted counter-argument is recorded per item below.

---

## DS-005 (B-01) — Manual-rail receiving details never shown to players
**Verdict: SURVIVES**

Attempted disproof: looked for any player route/view that loads `gateway_credentials`, any
aliasing of `credentialFields` into the deposit view, and any CMS/content path that renders them.
- Baseline `routes/player.js` GET `/deposit/new` renders only `methods` + `method` (with
  `custom_fields` from `methodCustomFields()` = admin custom fields + rail **userFields**, i.e.
  the fields the *player fills in*, never the receiving credentials).
- Baseline `views/deposit_new.ejs:18` renders only `content('deposit_instruction_' + method.id)`
  + `method.instruction`.
- `gateway_credentials` is read in exactly two places: `routes/webhooks.js` (only
  `webhook_secret` for signature checks) and `routes/admin.js:1285-1333` (admin credentials
  page), whose own text at `routes/admin.js:1298` states: *"Credentials are stored server-side
  and never shown to players."* Receiving fields exist in `lib/rails.js:13` (`wallet_address`),
  `:30` (`upi_id`), `:38` (`pix_key`), `:87-90` (bank account), `:102` (`qr_image_url`) — none
  reaches a player surface.
- The only workaround is the one the audit already conceded (admin hand-pasting the address
  into the free-text `instruction`/CMS block); that does not revive the dedicated fields.
- **Live (port 3352):** planted `gateway_credentials` wallet_address
  `bc1qDISPROVEtestaddress123` for the enabled Cryptocurrency method → GET `/deposit/new?m=1`
  contained **0 occurrences** of the address, while showing *"Send the exact amount to the
  wallet address below…"*.

## DS-006 (B-02) — Gateway rails collect nothing, promise a redirect, create a manual deposit
**Verdict: SURVIVES**

Attempted disproof: searched the whole baseline for a checkout-session creation, provider SDK
call, redirect branch, or rail branch in the deposit POST (`stripe`, checkout session,
Apple/Google Pay session, etc.).
- `lib/rails.js:27,66,74,82`: `cards`, `apple_pay`, `google_pay`, `samsung_pay` all have
  `userFields: []`; their `defaultInstruction` promises *"You will be redirected to our secure
  card processor…"* / *"Confirm with Apple Pay on your device."*
- `routes/player.js` POST `/deposit/new` (line 233) has **no rail branch at all** — every method
  goes to `createDeposit()` → `pending` manual request. The only Stripe-related code in the
  codebase is webhook *signature* parsing in `lib/rails.js`/`routes/webhooks.js`, which can only
  confirm a payment made outside a flow the player is never sent to (as the audit stated).
- **Live:** enabled Credit/Debit Cards → `/deposit/new?m=2` shows the redirect promise, a bare
  amount form and "Submit Deposit"; zero card fields, no redirect.

## DS-007 (B-03) — Phone-only users can never withdraw (OTP to synthetic `@phone.local` email)
**Verdict: SURVIVES**

Attempted disproof: looked for an `@phone.local` guard in the withdrawal paths (the guard that
*does* exist for profile verify-email), and for any phone fallback when the email is synthetic.
- `routes/auth.js:489`: phone-OTP signup creates `email = 'phone' + digits + '@phone.local'`
  (truthy, UNIQUE/NOT NULL placeholder).
- `routes/player.js:327` (POST `/withdraw/new`) and `:363` (POST `/withdraw/verify`):
  `const channel = req.user.email ? 'email' : 'phone';` — always `'email'` for these accounts,
  so `lib/otp.js sendOtp` takes the email path to an unroutable address → `sent:false` → the
  route returns 503 *"Could not send the verification code"* forever; the verified real phone
  is never tried.
- Contrast proving the omission is local to withdrawals: `routes/player.js:447`
  (profile verify-email) explicitly guards `email.endsWith('@phone.local')`. No equivalent
  guard exists at lines 327/363. With `withdrawal_otp_enabled` default ON, the lockout is total.

## DS-008 (B-04) — Self-excluded / cooling-off players can still deposit
**Verdict: SURVIVES**

Attempted disproof: looked for a `responsible_play` check inside `depositPolicy`,
`createDeposit`, or either deposit route, and for any global middleware gate.
- `lib/money.js:77-82` `depositPolicy()` checks only `deposits_enabled`, `user.deposit_blocked`,
  and `verifiedContactOk()` — no responsible-play consultation. `createDeposit()` likewise.
- `enforceAccountPlayable()` (`lib/scratch.js:195-200`) is called only on play paths:
  `routes/player.js:55` (POST `/play/buy`) and scratch buy. Neither GET nor POST `/deposit/new`
  calls it. No server.js middleware gates deposits on exclusion either.
- **Live:** set `responsible_play.self_excluded_until = 9999999999999` for the test player →
  POST `/deposit/new` (Cryptocurrency, $20.00) returned **302 → /wallet** and created pending
  deposit (one of three created in the DS-050 test below, all while excluded).

## DS-013 (F-01) — Policy reasons leak operator switches to players
**Verdict: SURVIVES**

Attempted disproof: looked for neutralisation/mapping of policy reasons before rendering, or a
generic error view that swallows the message.
- `lib/money.js:78-79,85-86`: reasons are literally `'Deposits are currently disabled.'`,
  `'Deposits are disabled for your account.'`, and the withdrawal equivalents.
- `routes/player.js:222,234,266,291,372` pass `policy.reason` verbatim as the error `message`;
  `views/error.ejs` prints `<%= message %>` unmodified. No sanitising layer exists anywhere.
- **Live:** set `deposits_enabled=0` → GET `/deposit/new` returned **403 with the page text
  "Deposits are currently disabled."** (after the 5 s settings-cache TTL in `lib/settings.js`
  expired — first hit within the TTL still served the cached enabled state, which is a cache
  artefact, not a guard).

## DS-014 (B-05/F-02) — Money pages show "Min $NaN · Max $NaN" / "No limits"
**Verdict: SURVIVES**

Attempted disproof: looked for a server-side alias (`min_amount AS min`) in the wallet/deposit
routes, a transformation in `server.js` locals, or a view fallback to `min_amount`.
- Schema is `min_amount`/`max_amount` (`lib/migrations.js:179`). Routes pass raw rows:
  `routes/player.js:202-203` selects `min_amount, max_amount` for the wallet and `:224/:268`
  `SELECT *` for deposit/withdraw — no aliasing anywhere (grep for `.min` assignment: none).
- Views read the wrong names: `views/deposit_new.ejs:24,26` and `views/withdraw_new.ejs:25,27`
  use `method.min`/`method.max`; `views/wallet.ejs:24,38` test `m.min == null && m.max == null`.
  `fmtMoney(undefined)` → `Number(undefined)=NaN` → `"$NaN"` (`lib/util.js:77`).
- **Live** (seeded method min_amount=100, max_amount=100000, fixed 100, 5%): deposit page
  rendered `Min $NaN · Max $NaN` and `<input … min="" max="">`; wallet listed the method as
  **"No limits"** in both Deposit and Withdraw cards. Server-side enforcement via
  `method.min_amount` (`routes/player.js:242,299`) works — display-only, exactly as audited.

## DS-016 (B-06) — Deposit/withdraw charge preview mixes major/minor units
**Verdict: SURVIVES**

Attempted disproof: checked whether the amount input actually holds minor units, whether a
×100 conversion exists in the preview block, or whether `data-fixed` is in major units.
- `public/app.js:285-297` (block "(d)"): `var v = Number(amt.value)` — the `#depAmount`/
  `#wdAmount` inputs are the major-unit form fields the server converts with `toMinor()`
  (`routes/player.js` POST handlers). The in-code comment even mislabels it `// minor units`.
  `data-fixed` comes from `method.fixed_charge`, stored in minor units. Charge =
  `fixed + Math.round(v*pct/100)`, then both charge and `v - charge` are passed to the client's
  `fmtMoney()` which divides by 100. No ×100 anywhere in the block.
- Worked example (live-tested config fixed=100, pct=5, entry $50): preview computes charge=103
  → *"Charge: $1.03 — you will be credited $0.00"*; true server math is charge 350, net 4650
  ($46.50). Three compounding unit errors, as audited.

## DS-017 (B-07) — Transactions: blank Reference, literal "&minus;", raw type strings
**Verdict: SURVIVES**

Attempted disproof: looked for a route-side mapping of `ref_id`→`ref` or a type-label map
before rendering.
- `routes/player.js` GET `/transactions` does `SELECT *` and renders `txs` untouched — rows
  carry `ref_type`/`ref_id` (`lib/money.js postLedger` inserts those columns); there is no
  `ref` column.
- `views/transactions.ejs:18` renders `t.ref` (always empty); `:19` renders
  `(t.amount >= 0 ? '+' : '&minus;')` inside `<%= %>`, so EJS escapes it to `&amp;minus;`;
  `:17` renders raw `t.type` (e.g. `withdrawal_hold`) with no label mapping anywhere.
- **Live:** inserted a ledger-shaped row (ref_id `DTEST123`, amount −1000) → transactions page
  HTML contained `<span class="code"></span>` (empty reference; the ref_id appears nowhere)
  and `&amp;minus;$10.00`, displayed by browsers as the literal text `&minus;$10.00`.

## DS-018 (B-08) — No deposit-side responsible-play limit (no daily deposit cap)
**Verdict: SURVIVES** (absence confirmed by exhaustive search — a missing feature cannot be
killed by finding a partial analogue)

Attempted disproof: searched for any deposit cap — per-user, daily, lifetime, or a generic
setting consumed by `depositPolicy`/`createDeposit`.
- `responsible_play` schema (`lib/scratch.js:32-36`, all three drivers) has only
  `daily_loss_limit`, `session_limit_minutes`, `cooling_off_until`, `self_excluded_until`.
- Settings contain `withdrawal_daily_cap`/`withdrawal_monthly_cap` (`lib/migrations.js:65-66`,
  enforced in `checkWithdrawalRules`) but **no deposit equivalent**; grep for
  deposit+cap/limit across `lib/`+`routes/` finds only the per-method `max_amount`
  (per single transaction, splittable without limit) and `auto_approve_deposit_limit`
  (an auto-approve threshold, unused since deposits are never auto-approved). Neither caps
  how much a player can deposit per day.

## DS-019 (B-12) — No bonus system at all
**Verdict: SURVIVES** (absence confirmed by exhaustive search)

Attempted disproof: grepped the entire baseline (`lib/`, `routes/`, `views/`, settings seeds)
for bonus/promo/welcome-credit logic, toggles, ledger types and display.
- Zero hits outside the scratch **"Bonus Gate" game type** (`lib/scratch.js` seed,
  `views/scratch_ticket.ejs:14` bonus window) and a prize-tier label — a game mechanic, not a
  deposit/promo bonus. No `%bonus%` setting in a fresh DB, no bonus ledger type, nothing on
  wallet/profile. The feature is absent, as audited.

## DS-036 (F-04) — "The operator has not enabled any deposit method yet" wording
**Verdict: SURVIVES**

Attempted disproof: checked whether the routes pass a neutral `noMethodsReason` that overrides
the template wording in the ordinary no-methods case.
- `views/deposit_new.ejs:38` hard-codes *"…The operator has not enabled any deposit method
  yet — please check back later or contact support."*; GET `/deposit/new`
  (`routes/player.js:224-225`) renders `noMethods:true` with no alternative wording.
- `views/withdraw_new.ejs:39` default (when `noMethodsReason` is unset) is the same sentence
  for withdrawals; the only `noMethodsReason` ever set is the same-method restriction message
  (`routes/player.js` GET `/withdraw/new`), a different case.
- **Live:** disabled all methods → GET `/deposit/new` returned the sentence verbatim:
  *"The operator has not enabled any deposit method yet — …"*.

## DS-038 (F-06) — Verify-contact flash reveals "(no email provider configured)" + manual-attest wording
**Verdict: SURVIVES**

Attempted disproof: looked for a generic failure flash or a version of the policy reason
without the manual-attest clause.
- `routes/player.js:454` (POST `/profile/verify-email`): flash is verbatim
  `'Could not send the verification email (no email provider configured). Ask support to mark
  your contact verified.'` — baseline line number identical to the audit's.
- Same wording inside both policy reasons: `lib/money.js:80,87`
  *"…or ask support to mark your contact verified."*, shown on deposit/withdraw policy blocks.
  `views/profile.ejs` additionally tells players *"staff can attest your contact manually."*
  No neutral variant exists.

## DS-050 (B-09) — POST /deposit/new has no rate limit (pending-deposit spam)
**Verdict: SURVIVES**

Attempted disproof: looked for a global rate limiter in `server.js`, an idempotency dedup that
would collapse repeat submissions, or a pending-count cap.
- `server.js` registers no global limiter; `rateLimit` (`lib/auth.js:68`) is applied per-route
  only (login, register, forgot, `/play/buy`, scratch buy/reveal, webhooks, admin TOTP).
  `routes/player.js:233` POST `/deposit/new` has only `requireLogin`.
- The route calls `createDeposit()` **without** an idempotency key, so each POST mints a fresh
  `dep_<randHex>` key (`lib/money.js createDeposit`) — repeat submissions never dedup.
- **Live:** three POSTs in immediate succession (same session/CSRF) → three 302s and three
  distinct pending deposits (`DMVRSXVD2617E0E`, `DMVRSXVDN446041`, `DMVRSXVE301E53D`), no
  throttling, no cap. (Withdrawal creation remains self-limiting via the balance hold, as audited.)

## DS-051 (B-10) — Wallet "Pending requests" includes already-decided items
**Verdict: SURVIVES**

Attempted disproof: looked for a status filter in the view (e.g. skipping non-pending rows)
since the route has none.
- `routes/player.js:204-205`: last-10 deposits and last-10 withdrawals are selected with **no
  status filter**, merged and passed as `pending`. `views/wallet.ejs` heads the table
  "Pending requests" and iterates `pending` unconditionally — the status is only shown as a
  badge, never filtered on.
- **Live:** flipped one deposit to `approved` in the DB → `/wallet` still listed it under
  "Pending requests" with an "approved" badge, exactly as audited.

## DS-052 (B-11) — Referral earnings invisible to players; scratch buys never accrue credit
**Verdict: SURVIVES**

Attempted disproof: looked for any player-facing read of `referral_credits`, a summed
`referral_commission` figure on any player page, and any referral insert in the scratch path.
- `referral_credits` is read for display only in admin (`routes/admin.js:487,1924`).
  `routes/player.js` GET `/profile` passes no referral data; `views/profile.ejs:43-47` shows
  only the referral link. (Nuance checked: a *released* credit does appear as a raw
  `referral_commission` line in the generic `/transactions` ledger — but no page reads
  `referral_credits`, shows pending/released/capped state, or sums earnings for the referrer,
  so the finding as written stands; pending credits are invisible entirely.)
- Accrual: the only `INSERT INTO referral_credits` is in the lottery buy
  (`routes/player.js:137`). `lib/scratch.js buyTicket` and `routes/scratch.js` contain zero
  referral code (grep: no hits), so scratch-only referees earn the referrer nothing.

## DS-053 (B-13) — Daily loss limit enforced per-game (2× total possible); page doesn't say so
**Verdict: SURVIVES**

Attempted disproof: checked whether either enforcement sums the other game's activity, and
whether any player-facing wording discloses the split.
- `lib/scratch.js enforceResponsiblePlay` sums only `scratch_tickets` (spent − prizes);
  `enforceLotteryLossLimit` sums only ledger `ticket_purchase`/`win` rows. Neither query
  touches the other game's data. The code comments state the design openly:
  `lib/scratch.js:194` *"Daily loss limits stay game-specific"* and `:222` *"per-game
  accounting (mirrors scratch)"* — deliberate, but undisclosed.
- The only limits page, `views/scratch_responsible.ejs`, labels the single shared field
  "Daily loss limit" under "Scratch Play Limits" with the line *"Daily limits apply before
  purchase"* — nowhere does it say the limit applies **separately per game**, so a $50 limit
  permits $50 lottery + $50 scratch loss in one day. The page title was the closest thing to a
  disclosure and it does not state the per-game split.

## DS-054 (B-14) — New player's wallet shows an empty Balances section (no $0.00 row)
**Verdict: SURVIVES**

Attempted disproof: looked for wallet-row creation at registration/OTP signup, a synthesised
zero row in GET `/wallet`, or a view fallback row when `wallets` is empty.
- `lib/money.js:64-66` `getBalances()` returns only existing `wallets` rows; rows are created
  lazily inside `postLedger`→`getWallet` (`lib/money.js:31`). No registration path inserts a
  wallet row (grep for `INSERT INTO wallets`: only `getWallet`).
- GET `/wallet` passes the list straight through; `views/wallet.ejs` iterates it with no
  empty-state/$0.00 fallback.
- **Live:** freshly registered player → GET `/wallet` rendered the "Balances" heading with an
  **empty** `<div class="cur-rows">` (zero rows), before any transaction.

## DS-055 (B-15) — Withdraw-verify page: no OTP resend; Cancel doesn't clear the pending withdrawal
**Verdict: SURVIVES**

Attempted disproof: looked for a resend route/link for the withdrawal OTP, and for session
clearing on GET `/withdraw/new` or on the Cancel link.
- `views/withdraw_verify.ejs` contains only the verify form and a plain link
  `<a href="/withdraw/new">← Cancel and go back</a>`. No resend control exists in the view,
  and no resend route exists in `routes/player.js` (the only re-send path is submitting a
  whole new POST `/withdraw/new`, which counts against the OTP 5-codes/hr cap in
  `lib/otp.js`).
- `pending_withdrawal` is cleared only at `routes/player.js:375,385,389` — all inside
  POST `/withdraw/verify` (success, policy re-check failure, rule re-check failure). It is
  *set* at `:341`; GET `/withdraw/new` never touches the session, so following "Cancel"
  leaves the pending withdrawal parked in the session exactly as audited.

---

## Summary

| Verdict | Count | Items |
|---|---|---|
| SURVIVES | 18 | DS-005, DS-006, DS-007, DS-008, DS-013, DS-014, DS-016, DS-017, DS-018, DS-019, DS-036, DS-038, DS-050, DS-051, DS-052, DS-053, DS-054, DS-055 |
| DISPROVEN | 0 | — |

Live baseline repros (port 3352, throwaway DB, server killed after) independently confirmed
DS-005, DS-006, DS-008, DS-013, DS-014, DS-017, DS-036, DS-050, DS-051 and DS-054; the remaining
items rest on exhaustive baseline code evidence quoted above. Nothing in the baseline —
no guard, alias, middleware, second route, or setting — kills any of the 18 findings.
