# Audit B — Player Money (DeepSeek Round)
Date: 2026-10-28 | Auditor: audit-only subagent | Codebase: ~/workspace/cash-pop-fix/
Scope: wallet, deposit (all methods/rails), withdrawal (OTP/policy/fees/statuses), transactions, balance display, spending/loss limits + responsible play, bonuses/referrals.
Method: code trace + live repro on port 3312 (fresh DB) where noted. No code edited.

## Findings (in progress)

## B-01 — Manual-rail receiving details are NEVER shown to the player; deposits are unpayable as designed
- Severity: **High** | Class: CODE-BUG
- Evidence: `views/deposit_new.ejs:18` renders only `content('deposit_instruction_'+id)` + `method.instruction`. The rail receiving credentials collected in admin (`lib/rails.js` credentialFields: crypto `wallet_address`, UPI `upi_id`, Pix `pix_key`, bank `account_number`/IBAN, QR `qr_image_url`, mobile-money `account_number`, e-wallet `account_email`) live in `gateway_credentials` and are read ONLY by `routes/webhooks.js` (signature secrets) and the admin credentials page. No player route/view ever loads or displays them (grep of `routes/player.js` + money views: zero hits).
- Live repro (port 3312): enabled the seeded Cryptocurrency method; `/deposit/new?m=1` shows the default instruction *"Send the exact amount to the wallet address below, then paste your transaction hash as proof."* — there is **no address anywhere on the page**. Same pattern for UPI ("Pay to the UPI ID below" — no ID), bank transfer, Pix, QR (no QR image).
- Impact: a player literally cannot pay a manual deposit correctly; they must guess/ask support, or submit a hash for a payment sent nowhere. Workaround exists only if the admin hand-pastes receiving details into the free-text `instruction` field — the dedicated credential fields are dead for display.

## B-02 — Gateway rails (Cards, Apple Pay, Google Pay, Samsung Pay) accept "deposits" without collecting any payment
- Severity: **High** | Class: CODE-BUG (missing integration presented as working)
- Evidence: `lib/rails.js` — `cards.userFields=[]`, `apple_pay.userFields=[]`, `google_pay.userFields=[]`, `samsung_pay.userFields=[]`; their `defaultInstruction` promises *"You will be redirected to our secure card processor"* / *"Confirm with Apple Pay on your device."* `routes/player.js` POST `/deposit/new` has no rail branch at all: every method goes straight to `createDeposit()` → pending manual request. There is no checkout-session creation, redirect, or provider SDK call anywhere in the codebase.
- Live repro: `/deposit/new?m=2` (Credit / Debit Cards) shows the redirect promise plus a bare amount form and "Submit Deposit" — no card fields, no redirect.
- Impact: if an admin enables these methods (they are presented in admin as real rails with credential fields + webhooks), players either (a) believe they paid when nothing was charged, or (b) submit unpaid requests that staff must reject one by one. Fails the standing rule "every method listed must actually work or fail honestly" — the honest state would be manual-proof wording or hiding gateway rails until a checkout integration exists. Webhook auto-approval (see WORKS) only helps a payment made *outside* this flow, which the player is never sent to.

## B-03 — Phone-only (OTP-registered) users can NEVER complete a withdrawal: OTP is addressed to their synthetic `@phone.local` email
- Severity: **High** | Class: CODE-BUG
- Evidence: `routes/auth.js:489` creates phone-only accounts with `email = 'phone' + digits + '@phone.local'` (truthy). `routes/player.js` POST `/withdraw/new`: `const channel = req.user.email ? 'email' : 'phone'; const identifier = channel === 'email' ? req.user.email : req.user.phone;` — always picks the fake email. `lib/otp.js sendOtp` email path → `notify.send` to an unroutable address → `sent:false` → route returns 503 "Could not send the verification code" **forever**; the user's real, verified phone is never tried. POST `/withdraw/verify` repeats the same channel logic. Contrast `routes/player.js:447` (profile verify-email) which explicitly guards `@phone.local` — the withdrawal path does not.
- Impact: an entire registration cohort (anyone who signed up by phone OTP) is permanently locked out of withdrawing while `withdrawal_otp_enabled` is ON (the default). No error tells them why.

## B-04 — Self-excluded / cooling-off players can still DEPOSIT money
- Severity: **High** | Class: CODE-BUG
- Evidence: `lib/money.js depositPolicy()` checks only global switch, per-user `deposit_blocked`, verified contact. Neither GET/POST `/deposit/new` (`routes/player.js`) nor `createDeposit()` consults `responsible_play`. `enforceAccountPlayable()` (self-exclusion/cooling-off) is called only on play paths (lottery buy, scratch buy).
- Live repro: set `responsible_play.self_excluded_until = 9999999999999` for the test player → POST `/deposit/new` (Bank Transfer, $20.00) returned 302 → /wallet and created pending deposit `DMVRRM9CCED7CD0`. The same user is correctly blocked from buying tickets.
- Impact: defeats the core purpose of self-exclusion — an excluded problem gambler can keep funding the account (and will pressure support to lift exclusion to use the funds). Withdrawal remaining open for excluded users is correct and unaffected.

## B-05 — Min/Max limits render wrong on every player money page ("No limits" / "$NaN")
- Severity: **Medium** | Class: CODE-BUG
- Evidence: DB columns are `min_amount`/`max_amount` (`lib/migrations.js` payment_methods DDL + seed). But `views/wallet.ejs:22,38` reads `m.min`/`m.max`, and `views/deposit_new.ejs:25-27` + `views/withdraw_new.ejs:25-27` read `method.min`/`method.max` — all undefined.
- Live repro (methods seeded min_amount=100, max_amount=100000): wallet lists every method as **"No limits"**; deposit and withdraw pages show **"Min $NaN · Max $NaN"** and the amount `<input>` is rendered with empty `min="" max=""` (no browser-side guard).
- Impact: players cannot see the real limits before submitting; they only learn them from a server error after submitting. Server-side enforcement itself works (verified in code, `routes/player.js` POST handlers).

## B-06 — Deposit/withdraw charge preview computes a wildly wrong fee and net
- Severity: **Medium** | Class: CODE-BUG
- Evidence: `public/app.js:280-297` (block "(d) Deposit / withdraw charge preview"): `var v = Number(amt.value)` — the input holds **major** units (e.g. `50`), while `data-fixed` is **minor** units (e.g. `100` = $1.00) and the result is passed to `fmtMoney()` which expects minor units. Charge = `fixed + Math.round(v*pct/100)`, credited = `Math.max(0, v - charge)` — three unit errors compounding.
- Worked example with the live-tested config (fixed_charge=100, percent_charge=5, deposit $50.00): preview computes charge=103 → *"Charge: $1.03 — you will be credited $0.00"*. Actual server result (verified in DB): charge=350 ($3.50), net credit $46.50.
- Impact: every player using a charged method is told a false fee and, for modest amounts, that they will be credited **$0.00** — either scaring them off or creating support disputes when the real (different) amount lands.

## B-07 — Transaction history: Reference column always blank; negative amounts show literal "&minus;" text
- Severity: **Medium** | Class: CODE-BUG
- Evidence: `views/transactions.ejs:20` renders `t.ref`, but the transactions table/route provides `ref_type`/`ref_id` (`routes/player.js` GET `/transactions` selects `*`; ledger inserts write `ref_type`/`ref_id` in `lib/money.js postLedger`). Line 21: `<%= (t.amount >= 0 ? '+' : '&minus;') + fmt(...) %>` — `<%= %>` HTML-escapes the entity.
- Live repro HTML after a deposit + withdrawal hold:
  `<td><span class="code"></span></td>` for every row, and `<td class="neg">&amp;minus;$10.00</td>` — the browser displays the literal text `&minus;$10.00`.
- Impact: the player's own audit trail shows no reference IDs (cannot quote a deposit/withdrawal ID to support from this page) and garbled negative amounts.

## B-08 — No deposit-side responsible-play limit exists (no per-user or daily deposit cap)
- Severity: **Medium** | Class: CODE-GAP (missing feature)
- Evidence: `responsible_play` schema (`lib/scratch.js:32-36`) has only `daily_loss_limit`, `session_limit_minutes`, `cooling_off_until`, `self_excluded_until`. No setting in `lib/migrations.js` defaults and no check in `depositPolicy`/`createDeposit` caps how much a player can deposit per day/ever. The only deposit ceilings are the per-method `max_amount` (per single transaction — splittable into unlimited transactions).
- Impact: a player who set a daily *loss* limit can still deposit unlimited funds; standard responsible-play tooling (self-set deposit limit) cannot be offered.

## B-09 — POST /deposit/new has no rate limit: unlimited pending-deposit spam
- Severity: **Low** | Class: CODE-BUG
- Evidence: `routes/player.js` — `rateLimit` is applied to `/play/buy` only. Deposit creation needs no balance and no payment, so one account can create unbounded `pending` deposits, flooding the admin approvals queue and the wallet pending list. (Withdrawal creation is self-limiting via the balance hold; OTP path is capped by `lib/otp.js` 5 codes/hr.)

## B-10 — Wallet "Pending requests" lists already-decided requests
- Severity: **Low** | Class: CODE-BUG
- Evidence: `routes/player.js` GET `/wallet` selects the last 10 deposits + 10 withdrawals with **no status filter**, then `views/wallet.ejs` heads the table "Pending requests".
- Live repro: after admin approval, deposit `DMVRRLFRJ246D21` (status `approved`) still appears under "Pending requests" with an "approved" badge.
- Impact: misleading labelling; players can't tell what is actually awaiting action.

## B-11 — Referral earnings are invisible to the player; scratch purchases never accrue referral credit
- Severity: **Low** | Class: CODE-BUG (display gap + inconsistent accrual)
- Evidence: `views/profile.ejs:43-47` shows only the referral link. No player page reads `referral_credits` (pending/released/capped) or sums `referral_commission` transactions for the referrer — only admin views do (`routes/admin.js:487,1919`). A referrer cannot see that a credit is pending, why, or when it released. Accrual exists only in the lottery buy (`routes/player.js:130-141`); `lib/scratch.js buyTicket` inserts no referral credit, so referred scratch-only players earn the referrer nothing, with no wording anywhere setting that expectation.

## B-12 — No bonus system exists at all (no deposit bonus / promo credit / bonus display)
- Severity: **Medium** | Class: CODE-GAP (missing feature)
- Evidence: `SELECT key FROM settings WHERE key LIKE '%bonus%'` on a fresh DB → zero rows; grep for bonus logic across `lib/` + `routes/` finds only the scratch "Bonus Gate" *game type* and a prize-tier label. There is no welcome/deposit bonus, no admin bonus toggle/rate, no bonus credit ledger type, and nothing bonus-related on wallet/profile.
- Impact: not a broken toggle — the feature is absent. If the operator markets or expects a deposit bonus (ViserLab-parity), there is nothing to switch on.

## B-13 — Daily loss limit is enforced per-game, so total daily loss can reach 2× the player's set limit
- Severity: **Low** | Class: CODE-BUG (design observation)
- Evidence: `lib/scratch.js enforceLotteryLossLimit` sums only `ticket_purchase`/`win` ledger rows; `enforceResponsiblePlay` (scratch) sums only `scratch_tickets`. Code comments state "per-game accounting (mirrors scratch)" — deliberate, but the player-facing page (`views/scratch_responsible.ejs`) calls it "Daily loss limit" without saying it applies separately per game. A player setting $50 can lose $50 on lottery + $50 on scratch the same day.

## B-14 — New player's wallet page shows an empty Balances section (no $0.00 rows)
- Severity: **Low** | Class: CODE-BUG
- Evidence: `lib/money.js getBalances` returns only existing `wallets` rows; wallet rows are created lazily inside `postLedger`. `views/wallet.ejs` iterates that list, so a registered player who has never transacted sees a "Balances" heading with nothing under it (the header pill handles a missing wallet as 0, the wallet page does not).

## B-15 — Withdrawal-verify page offers no code resend, and "Cancel" does not clear the pending withdrawal
- Severity: **Low** | Class: CODE-BUG
- Evidence: `views/withdraw_verify.ejs` has only the verify form + a plain link to `/withdraw/new`. GET `/withdraw/new` never clears `sessionData.pending_withdrawal`; only a successful verify, a failed rule re-check, or a new OTP request overwrites/clears it (`touchSession … pending_withdrawal: null` exists only in POST `/withdraw/verify`). If the email is delayed past the 10-minute OTP expiry, the player's only path is to abandon and restart the whole flow (new code request counts against the 5/hr OTP cap).

---

## Verified WORKS (traced and/or live-tested on port 3312, fresh DB)
- **Deposit lifecycle**: create → `pending` with correct charge math (live: $50.00, fixed $1 + 5% → charge 350, net 4650) → admin approve credits exactly the **net** once; no auto-approve path exists; guarded status transitions prevent double-credit; idempotency keys on create.
- **Withdrawal lifecycle**: balance pre-check before OTP (R-114 holds); full-amount hold on create (live: 4650 → 3650 on a $10.00 withdrawal, charge 150, net 850); reject releases the full hold; revoke-after-approve refunds the full amount; approve retains the fee (no leak); `paid` requires a provider payout ID and is terminal.
- **Withdrawal OTP**: seeded/default **ON** (`withdrawal_otp_enabled=1`); policy + v14 rules re-checked at verify (R-113 holds); **fails closed** — live: with no mail provider configured, POST returned HTTP 503 "Could not send the verification code…" and created nothing.
- **Withdrawal rules**: turnover requirement blocked an unwagered withdrawal with HTTP 400 before any OTP (live); daily/monthly caps, 48h payout-detail-change lock, same-method restriction all present in `checkWithdrawalRules` and re-checked inside the creation transaction (R-021).
- **Control matrix**: global `deposits_enabled`/`withdrawals_enabled`, per-user `deposit_blocked`/`withdrawal_blocked`, per-user mode override, and the verified-contact gate are all enforced by `depositPolicy`/`withdrawalPolicy` on GET, POST, and OTP-verify.
- **Balance display rule**: logged-out visitors see no balances — `views/layout.ejs` renders balance markup only inside `if (user)`; live anon check: no balance content, `/wallet` 302 → /login.
- **Webhooks** (`routes/webhooks.js` + `lib/rails.js verifyWebhookSignature`): HMAC-SHA256 verified with timingSafeEqual, fail-closed with no secret, amount **and** currency must match the deposit, per-rail deposit matching, event dedup. (No regression of R-004/R-005/R-031/R-084/R-090.)
- **Ledger integrity**: `postLedger` rejects non-integer/zero amounts, guarded balance UPDATE prevents overdraft/double-spend, `chargeFor` clamps negatives and create-functions cap charge at the amount (net never negative).
- **Blocked rails**: EBT hard-block + admin `blocked_rails` setting enforced on method create/edit (`routes/admin.js:1210,1244`). All 13 seeded rails ship **disabled** (safe default).
- **Referral credit mechanics** (server side): pending → released only after referee's approved deposit + wagering, per-currency gated, per-referee cap with terminal `capped` state, banned-referrer accrual skipped (R-087/R-124 hold). Display side is the gap — see B-11.

## CONFIG-NEEDED (not bugs — operator must supply before go-live)
- **Mail/SMS provider**: with `withdrawal_otp_enabled` ON (default) and no SMTP configured, *all* withdrawals honestly 503 (fail-closed, B-03 aside). Same gap blocks self-service contact verification while `verified_contact_required` is ON (default) — the audited admin "mark verified" fallback exists. Operator must configure SMTP (or Twilio/TextBelt with key) or consciously toggle OTP off in admin.
- **Per-method setup**: all 13 rails seed disabled with placeholder instructions and USD-only limits ($1–$1,000); operator must enable, set real instructions/receiving details, limits and charges per method. Gateway-credential saving additionally requires `CREDENTIAL_ENCRYPTION_KEY` (saving is refused without it — fail-closed by design); without the key, payout `user_data` is stored plaintext (documented in `lib/money.js encodeUserData`).
- No item in COMPILED-LIST.md / FIX-LOG.md claimed fixed was found broken again in this area — **no REGRESSION flags**. (R-044's "auto mode" was resolved by making modes manual-only in admin; deposit/withdraw flows are consistently manual + webhook-confirmed, which is why B-02 is framed as a display/honesty bug on gateway rails, not a missing auto-approve.)

## Summary
| Severity | Count |
|---|---|
| Critical | 0 |
| High | 4 (B-01, B-02, B-03, B-04) |
| Medium | 5 (B-05, B-06, B-07, B-08, B-12) |
| Low | 6 (B-09, B-10, B-11, B-13, B-14, B-15) |
| **Total findings** | **15** |

Classification split: CODE-BUG 13 · CODE-GAP (missing feature) 2 (B-08, B-12) · CONFIG-NEEDED 0 findings (3 operator items listed separately, all fail-closed/honest) · REGRESSION 0.
Core money engine (ledger, holds, charges, decide/mark-paid, webhook verification, control matrix) is sound and live-verified; the failures concentrate in the player-facing layer: receiving details never displayed, gateway rails that collect nothing, the phone-only withdrawal lockout, deposits allowed during self-exclusion, and broken limit/fee/reference display.
