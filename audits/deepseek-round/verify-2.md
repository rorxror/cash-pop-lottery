# Verify-2 — Independent FIX Verification (money items + RT-20)

Agent: independent fix-verification (no code edited; writes = this file + /tmp scratch only).
App booted fresh by me: `SQLITE_PATH=/tmp/verify2.sqlite PORT=3342 … node server.js`
(admin at /ops-7f3a9c-console, seeded admin@cashpop.live). Method id=10 (Bank Transfer)
enabled via DB, test players' email_verified=1 via DB, per setup instructions.

⚠️ INFRASTRUCTURE INCIDENT during the run: a second process/agent collided on the
exact same port 3342 + DB path /tmp/verify2.sqlite (see /tmp/verify2-server.log:
a second boot at ~07:38 seeded a fresh admin DB and died EADDRINUSE; my DB was
wiped mid-RT-20 and my player sessions died). All DS items below were completed
and evidence-captured BEFORE the wipe. RT-20 steps 1–2 were proven pre-wipe on
3342, and the FULL RT-20 sequence (steps 1–4) was then re-run cleanly end-to-end
on an isolated instance I booted on port 3391 with DB /tmp/vfy2z.sqlite
(3391 server killed when done; the 3342 listener was left running because the
sibling agent appears to be using it — parent to coordinate its shutdown).

Verdicts: **VERIFIED 15 · CODE-ONLY 0 · FAILED 0** (DS-005/DS-016/DS-055 include
live evidence beyond the minimum required; see notes).

---

## DS-005 — Gateway receiving details on deposit page — VERIFIED (live, not just code)
- Code path: `lib/rails.js` `RECEIVING_FIELDS` + `getReceivingDetails()` decrypts
  only whitelisted receiving keys per rail; `routes/player.js` GET /deposit/new
  passes `receiving`; `views/deposit_new.ejs` renders a "Send your payment to:"
  block (QR key rendered as an `<img>`).
- Password-type fields can never be selected: RECEIVING_FIELDS contains no
  password-type key for any rail (checked against every rail's credentialFields:
  pix `api_token`, mobile_money `api_key`, ewallet `api_credentials`, cards
  `secret_key`/`webhook_secret`, voucher `api_key`, etc. are all absent from the map).
- Live proof (plaintext legacy credential rows inserted, field_enc=0): Pix page
  showed `verify-pix-key-12345` and did NOT show the planted `api_token` value
  `SUPERSECRETTOKEN999` (grep count 0); Bank page showed `Verify Bank` +
  `IBAN-VERIFY-98765`.
- Encryption-key dependency (as claimed): credentials saved through admin are
  stored as AES-256-GCM envelopes (`lib/credentials.js`); `decryptField` throws
  without `CREDENTIAL_ENCRYPTION_KEY`, `getReceivingDetails` catches per-row and
  yields nothing — so with encrypted credentials and no key set, the receiving
  block silently shows nothing (fail-closed, no leak). This boot had no key set,
  which is why the live proof above used legacy plaintext rows (a supported read path).

## DS-006 — Gateway rail instructions are honest manual text — VERIFIED
Seeded DB values (this fresh boot) and `lib/rails.js` defaults agree, e.g.:
- cards: "Card deposits are reviewed manually: submit your request below and our
  team will contact you with a secure payment link. Your balance is credited
  once payment is confirmed."
- apple_pay / google_pay / samsung_pay: "…deposits are reviewed manually: submit
  your request below and our team will confirm your payment…"
No "you will be redirected" (or any redirect promise) anywhere in rails.js or
the deposit view — grep for "redirect" = no hits.

## DS-007 — Withdrawal OTP must not go to @phone.local — VERIFIED (live)
Created a phone-only user (email rewritten in DB to `phone15551234567@phone.local`,
phone `+15551234567`, mobile_verified=1), funded $20 via approved deposit,
turnover rule off, OTP on. POST /withdraw/new $10:
- `login_otps` row created with **identifier=`+15551234567`, id_type=`phone`** —
  no row addressed to the @phone.local address.
- Response was 503 "Could not send the verification code…" — solely because no
  SMS provider is configured in this env (fail-closed delivery), not a dead address.
- Code: real-email check (`!email.endsWith('@phone.local')` → channel phone) is
  present identically in /withdraw/new, /withdraw/verify and /withdraw/verify/resend.

## DS-008 — Self-excluded user cannot deposit — VERIFIED (live)
Set `responsible_play.self_excluded_until` far-future for the player:
- GET /deposit/new → 403 "Deposits are unavailable during your self-exclusion or
  cooling-off period."
- POST /deposit/new ($10) → 403, same message; deposits count for the user stayed 0.
Flag cleared afterwards and deposits worked again.

## DS-013 — Policy refusal messages contain no operator-internal wording — VERIFIED (live)
- `deposits_enabled=0` → GET /deposit/new 403: "Deposits are unavailable right
  now. Please try again later or contact support."
- `withdrawals_enabled=0` → GET /withdraw/new 403: "Withdrawals are unavailable
  right now. Please try again later or contact support."
Neither message (nor the per-user/unverified variants in lib/money.js
depositPolicy/withdrawalPolicy) contains "operator", "disabled for your
account", "disabled by…", staff-attestation hints, etc. Internal reason is kept
server-side as `code` only. (Note: settings are cached ~5s — toggles take a few
seconds to appear; not a defect.)

## DS-014 — Min/max shown in MAJOR units (deposit/withdraw/wallet) — VERIFIED (live)
Method min_amount=100 / max_amount=100000 (minor):
- Deposit page: "Min $1.00 · Max $1,000.00" (no $NaN).
- Withdraw page: $1.00 / $1,000.00.
- Wallet page method rows: "$1.00 – $1,000.00" for both Deposit and Withdraw cards.

## DS-016 — Withdraw charge preview math — VERIFIED (code + executed arithmetic)
Task allowed code evidence; I also executed the exact preview logic from
public/app.js: input (major) ×100 → minor, charge = min(v, fixed + round(v·pct/100)),
views pass data-fixed (minor) / data-percent / data-currency correctly.
- $50, $1 fixed + 5% → "Charge: $3.50 — you will receive $46.50"
- $50, 7% → "Charge: $3.50 — you will be credited $46.50"
(the audit's broken example previously told the depositor "credited $0.00").
Wording is "you will receive" for withdrawals, "you will be credited" for deposits.

## DS-017 — Transactions page: public refs + friendly labels — VERIFIED (live)
After an approved $50 deposit, /transactions showed: Type "Deposit", Reference
`DMVRSX73R02D354` (the deposit public_id, not a numeric id), Amount "+$50.00",
correct balance-after. No literal "&minus;" text; view maps raw types to friendly
labels (incl. bonus → "Deposit bonus") and renders the sign via fmt(Math.abs()).

## DS-018 — Daily deposit limit enforced — VERIFIED (live)
Set via the player responsible-play POST (`/scratch/responsible-play`,
daily_deposit_limit=60 → stored 6000 minor). Deposit $50 → 302 pending.
Second deposit $20 → **400 "That deposit would exceed your daily deposit limit."**;
DB still held exactly 1 deposit totalling 5000.
⚠️ Incidental defect found in this surface (not the DS-018 claim): **GET
/scratch/responsible-play returns 500** — EJS compile error in
views/scratch_responsible.ejs ("Missing catch or finally after try", seen in the
server log and reproduced on the isolated instance). The POST handler works and
enforcement works, but a player cannot open the page to view/change the limit.

## DS-019 — Deposit bonus on approve, clawback on revoke — VERIFIED (live)
With `deposit_bonus_percent=10`: player deposited $50 → admin approve →
wallet **5500** with two ledger rows: `deposit +5000` and separate
**`bonus +500`** (ref = deposit public_id). A second $10 deposit that was
**rejected** credited nothing (balance and ledger count unchanged). Admin
**revoke** of the approved deposit → `deposit_revoke −5000` and
**`bonus_revoke −500`**, wallet back to **0**, deposit status `revoked`.

## DS-036 — No methods → neutral empty text — VERIFIED (live)
Before any method was enabled (verified player): GET /deposit/new showed
"No payment methods are available right now. Please check back later or contact
support." (withdraw page shows the equivalent neutral withdrawal text). No
"operator has not enabled…" wording.

## DS-050 — Deposit POST rate limit — VERIFIED (live; code said 10/min/user)
routes/player.js POST /deposit/new carries `rateLimit({windowMs:60000, max:10,
keyFn: deposit:<userId>})`. Live spam test (fresh player, $1 deposits):
first 10 → 302, 11th and 12th → **429**; DB contained exactly 10 deposits.

## DS-051 — Wallet pending lists show only pending — VERIFIED (live)
Player had deposit #1 approved ($50) and deposit #2 pending ($5): /wallet
"Pending requests" contained only the pending public_id `DMVRSXATM42581D`
(status pending); the approved deposit's public_id appeared **0 times** on the
page. Route filters both queries with `status='pending'`.

## DS-054 — Fresh user sees base-currency zero row — VERIFIED (live)
Brand-new registered player (no wallet rows in DB): /wallet Balances showed a
USD row with **$0.00** instead of an empty section (route pushes
`{currency: baseCurrency, balance: 0}` when getBalances returns none).

## DS-055 — Withdraw verify Resend + Cancel — VERIFIED (live via session injection)
Task allowed code+route evidence; I went further. The verify page itself is
unreachable end-to-end without a mail/SMS provider (withdraw/new fails closed
before parking a pending withdrawal), so I injected `pending_withdrawal` into
the player's real session row in the DB, then:
- POST /withdraw/verify/resend → route live (not 404): created a fresh OTP row
  for the phone identifier and returned 503 only because no SMS provider is
  configured (fail-closed).
- POST /withdraw/verify/cancel → **302 to /wallet**, session DB then showed
  `pending_withdrawal: null`, flash "Withdrawal cancelled. No amount was held."
- POST resend after cancel → 400 "No pending withdrawal. Please start again."
  (proves the cancel really cleared state).
- View (withdraw_verify.ejs) contains both controls as POST forms with CSRF to
  `/withdraw/verify/resend` ("Resend code") and `/withdraw/verify/cancel`
  ("Cancel withdrawal") — no GET-link cancel.
What I could NOT run: the happy-path verify page render + code entry, which
requires a working SMTP/SMS sink (another verifier's instance covers SMTP).

## RT-20 — Payout-detail lock retest — VERIFIED (all 4 steps)
Setup (isolated instance, port 3391): funded player ($50 approved deposit),
`withdrawal_otp_enabled=0`, `withdrawal_turnover_required=0`, method Bank
Transfer, payout detail = the `reference` user field.
Expected hashes (sha256 of sorted JSON): A {reference:"A-REF"} =
`eb6e31b2…2bc17`, B {reference:"B-REF"} = `72b67ae8…71844`.
1. Withdraw $10 with A → 302 success. Wallet 5000→4000.
   DB: payout_fingerprint = **A**, payout_pending_fingerprint = '', change_at = 0.
2. Withdraw $10 with B → **400** "Payout details changed. For your security,
   withdrawals to new payout details are locked for 48 hours. Your previous
   payout details are unaffected." Wallet/count unchanged (4000, 1 withdrawal).
   DB: payout_fingerprint **still A**, payout_pending_fingerprint = **B**,
   payout_change_at = now. ✔ exactly the required pending-only semantics.
3. Withdraw $10 with original A → **302 success — NOT blocked** (the exact
   behaviour the red team found broken). Wallet 4000→3000, 2 withdrawals,
   fingerprint still A.
4. Aged payout_change_at by 49h in DB → withdraw $10 with B → **302 success**.
   Wallet 3000→2000, 3 withdrawals. DB: payout_fingerprint = **B**,
   payout_pending_fingerprint = '' (cleared), payout_change_at = 0 (promoted).

---

## DS-019 competing-solution note (required)
The main alternative is crediting the bonus at deposit **REQUEST** time (when
the player submits, before review) instead of at **APPROVE** time. Approve-time
crediting — the implemented design — wins on the observed evidence: a rejected
deposit in my test credited nothing at all (no bonus row, no cleanup needed),
whereas request-time crediting would hand out spendable bonus on unreviewed,
possibly fake deposit claims and require a clawback on every routine reject.
Approve-time also makes revoke symmetric and provably clean: my revoke test
removed exactly the net (−5000 `deposit_revoke`) and exactly the bonus
(−500 `bonus_revoke`) in one transaction, returning the wallet to 0. The only
cost of approve-time is that the player sees the bonus later (at approval),
which is the honest moment the money actually exists.
