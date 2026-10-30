# FIX-LOG — AUTO PAY INTEGRATION round (v22 build, NOT deployed)

**Date:** 2026-10-29 · **Workdir:** `~/workspace/cash-pop-fix/` · **Status:**
build + test + zip only. Nothing was pushed or deployed in this round;
the live site still runs v21 until the owner separately says deploy.

**Why this round exists (owner's words, 2026-10-29 17:58 CDT):** "koi
bhi method ho, uski detail dalun aur chalne lage — key waghera jo bhi
hoti hai." The v21 round shipped the Manual/Auto selector with Auto
honestly LOCKED for PayPal and Skrill because no provider verification
client existed in code. The owner rejected locked-Auto as the end
state for rails whose provider HAS a real API. This round builds the
missing clients. Where a rail's provider has NO verification API for a
plain receiving detail, §6 proves it in writing instead of faking it.

---

## Feature-status matrix (whole round)

| Area | Status | Evidence |
|---|---|---|
| PayPal verification client (OAuth2, mode-true base URL) | ✅ built | lib/paypal.js; test A1/A4 |
| PayPal verify-on-submit (capture lookup) | ✅ built + E2E | routes/player.js; test B2–B5 |
| PayPal webhook (verify-webhook-signature API) | ✅ built + E2E | routes/webhooks.js `/webhooks/paypal`; test B6/B7 |
| PayPal Auto unlock (Client ID + Secret + Webhook ID) | ✅ wired | lib/rails.autoCapability; test B1 |
| Skrill status-report verification (md5sig, Secret Word) | ✅ built + E2E | lib/skrill.js; test A2, B8–B10 |
| Skrill Auto unlock (Merchant ID + Secret Word) | ✅ wired | test B8 |
| Skrill report-before-deposit applied on submit | ✅ built + E2E | routes/player.js; test B10 |
| Generic verifier: Coinbase + NOWPayments schemes | ✅ extended | lib/rails.verifyWebhookSignature; test A5 |
| Rail-by-rail auto audit (remaining 12 rails) | ✅ documented | §6 (official sources) |
| Auto withdrawals | ⚠️ unchanged BY DESIGN | §7 (BP-22 semantics kept; PayPal Payouts NOT wired, reason stated) |
| Full suite | ✅ 329 / 326 pass / 0 fail / 3 skipped | §8 (v21 baseline 314/311/0/3 + 15 new) |

---

## 1. PAYPAL — the verification client (worked example)

**New file `lib/paypal.js`** — a real PayPal REST client using the
method's own saved Client ID / Secret:

- **OAuth2:** `POST /v1/oauth2/token`, HTTP Basic (client_id:secret),
  `grant_type=client_credentials`; tokens cached per (host, client_id)
  until shortly before expiry.
- **Mode is REAL:** base URL derives from the method's Mode field —
  `sandbox` → `https://api-m.sandbox.paypal.com`, `live` →
  `https://api-m.paypal.com` — so the owner's first test with Sandbox
  keys genuinely talks to PayPal's sandbox, not to a flag. Test A1
  asserts both hosts through a stubbed fetch. (`PAYPAL_API_BASE_URL`
  env may override the host — a test/support hook at the same trust
  level as the other server env secrets; the E2E suite uses it to run
  a local provider double.)
- **Capture lookup:** `GET /v2/payments/captures/{capture_id}`.
- **Webhook verification:** `POST /v1/notifications/verify-webhook-signature`
  with the delivery's `paypal-transmission-id / -time / -sig`,
  `paypal-cert-url`, `paypal-auth-algo`, the configured **Webhook ID**
  and the event JSON; only `verification_status === "SUCCESS"` counts.
  PayPal's webhooks are NOT HMAC — this is precisely the client whose
  absence kept Auto locked in v21.
- **Fail-closed:** 10s timeouts; any network error, non-200 or
  malformed body returns `{ ok:false, reason }` — never a "probably".

**New credential field:** `webhook_id` ("Webhook ID") on the PayPal
rail, with where-found help (developer.paypal.com → Apps &
Credentials → app → Webhooks). It is NOT a save-required field (manual
PayPal keeps working with only the receiving email, exactly as the
owner proved on live v20/v21); it is required only by the Auto gate.

**The real player flows (exactly what a player experiences):**
1. **Verify-on-submit (primary).** Player sends money to the account
   email in their own PayPal, pastes the Transaction ID, submits the
   deposit. On an Auto method the server immediately asks PayPal for
   that capture and credits ONLY when PayPal confirms ALL of:
   status `COMPLETED`; amount exactly equals the deposit amount;
   currency exactly equals; and the payee email PayPal reports is the
   configured receiving account. The capture ID is consumed
   (`provider_txn_id`) — the same capture can never credit a second
   deposit (test B4). Anything else — wrong amount (B3), wrong
   currency (B3), wrong payee (B3), capture still PENDING (B3),
   capture unknown to PayPal (B3), **provider down (B5)** — leaves the
   deposit pending with a truthful message ("PayPal has not confirmed
   this payment yet — if PayPal confirms it, your balance is credited
   automatically; otherwise our team will review it").
2. **Webhook (catch-all).** PayPal POSTs to `/webhooks/paypal`
   (dedicated route registered BEFORE the generic HMAC route). The
   delivery is verified with PayPal's own API against EVERY configured
   PayPal method's Webhook ID; unverifiable → 401 + audit, no credit
   (B6 forged case). `PAYMENT.CAPTURE.COMPLETED` matching a pending
   deposit (by consumed capture ID or by the pasted proof) passes the
   same amount/currency/payee gate, then credits once via
   `decideDeposit`'s guarded transition; a replayed event is deduped
   by `webhook_events` UNIQUE (B6). `CHECKOUT.ORDER.APPROVED` credits
   ONLY if the order is already COMPLETED and carries a completed
   capture (we never create PayPal orders — players pay the account
   directly — so an approved-but-uncaptured order is recorded, never
   credited). `PAYMENT.CAPTURE.REFUNDED` / `REVERSED` revoke an
   approved deposit ONLY on a full-amount + currency match; partial
   refunds are recorded for manual review.
3. **Manual mode is untouched:** a verified webhook on a Manual Pay
   method is recorded but never credits (B7) — METHOD-MODE-01's rule
   stands.

**Auto gate:** `processing_mode=auto` now saves for PayPal exactly
when account email + Client ID + Secret + Webhook ID are present
(`lib/rails.autoCapability`, test B1: the refusal names "Webhook ID").
The v20-era comment claiming no client exists is gone; `webhook:true`
on the rail now means what it means everywhere else in this codebase —
a real provider-confirmation path exists — and the generic HMAC
verifier is never PayPal's gate (the dedicated route shadows it).

## 2. SKRILL (e-wallet rail) — status-report verification

**New file `lib/skrill.js`** — Skrill has no Client ID/Secret and no
HMAC webhook secret; it signs its **status report** (the POST Skrill
sends to the merchant's `status_url`) with the merchant's Secret Word:

```
md5sig = MD5( merchant_id + transaction_id
              + UPPERCASE(MD5(secret_word))
              + mb_amount + mb_currency + status )   (lowercase hex)
```

Verification additionally requires the report's `merchant_id` to be
the configured one and `pay_to_email` to be the configured receiving
account; comparison is timing-safe. Status codes: `2` processed,
`0` pending, `-1` cancelled, `-2` failed, `-3` chargeback (a verified
`-3` revokes an approved deposit through the same full-match gate).

**New credential fields** (Skrill only, both optional for manual):
`merchant_id` — "Merchant ID (Customer ID)"; `secret_word` —
"Secret Word" (secret-flagged). One validator correction rides along:
the generic "secrets are ≥8 chars" floor no longer applies to
`secret_word`, because Skrill lets merchants set a word of up to 10
characters with no 8-char minimum — a shorter word is a real
credential, not a truncated paste.

**Endpoint:** `POST /webhooks/skrill` (form-encoded; registered
before the generic route). The URL the owner gives Skrill as
`status_url` is `https://cash-pop-lottery.onrender.com/webhooks/skrill`
(checklist updated). Forged signature → 401 (B9); amount mismatch →
acknowledged + recorded, never credited (B9); replay → the recorded
event already carries the deposit, nothing re-applies (B9).

**Scope limit, stated precisely (Skrill's own docs):** the status
report fires ONLY for payments created through a Skrill merchant
payment request (Quick Checkout / payment link) that carries the
`status_url` — a plain wallet-to-wallet "send money" to the account
email creates NO report, so no system on earth could auto-verify it
from Skrill's side. Skrill Auto therefore covers payments made
through the operator's Skrill payment link/session configured with
our status_url; a wallet-to-wallet send stays in the manual queue
where the admin checks it in the Skrill account, exactly like v21.
(docs.paysafe.com — Quick Checkout introduction.) The sha2sig variant
exists but is NOT enabled by default (Skrill enables it on request),
so md5sig — the default signature — is what is verified.

**Ordering handled honestly:** Skrill's report fires when Skrill
processes the payment — possibly BEFORE the player submits the
deposit. A verified report with no matching deposit is recorded in
`webhook_events`; when the player later submits that Skrill
transaction ID on the Auto method, the recorded verified event is
applied at submit under the same amount/currency gate (B10). A report
matching an existing pending deposit applies immediately.

**Deliberately NOT wired:** Skrill's MQI status query
(`https://www.skrill.com/app/query.pl`) — it requires a SEPARATE
API/MQI password (sent as its MD5) plus a server-IP whitelist, both
enabled under Settings → Developer Settings, and API/MQI is off by
default (docs.paysafe.com — API/MQI security). The signed status
report already provides verified server-to-server confirmation for
checkout-created payments, so the query adds a credential and an
enablement without adding truth for this flow. Recorded here rather
than faked. (One doc conflict worth knowing: Skrill's Quick Checkout
appendix caps the Secret Word at 10 lowercase chars while its
API/MQI security page demands ≥8 mixed chars — different products;
§2's validator exemption follows the Quick Checkout product, which
is the one integrated here.)

## 3. Shared crediting path — `lib/auto-credit.js`

One application path for every provider-verified outcome (PayPal
webhook, PayPal capture lookup, Skrill report): `decideDeposit`
approve/revoke (its guarded status transition is the double-credit
proof), `provider_txn_id` recorded, the SAME `deposit_approved` /
`deposit_revoked` player notification an admin decision sends
(AUTO-VISIBILITY-01 parity), referral release, and an audit row under
the provider's name. Nothing in it trusts a client claim — callers
must have verified with the provider first.

## 4. Unlock plumbing — one honest gate for every rail

`lib/rails.autoCapability(rail, creds)` replaces the v21 rule
("webhook_secret or nothing") in the admin mode gate:

| Rail | Auto requires (beyond its own required receiving fields) |
|---|---|
| PayPal | Client ID + Secret + Webhook ID |
| E-wallet, provider = Skrill | Merchant ID + Secret Word (webhook_secret NOT required — Skrill has none) |
| E-wallet, other providers | Webhook signing secret (generic HMAC path, unchanged) |
| All other `webhook:true` rails | Webhook signing secret (unchanged) |
| `webhook:false` rails | Auto impossible — `blocked`, selector stays locked with the plain reason |

Refusals keep naming the exact missing fields by their provider
labels. Admin UI copy for PayPal's mode card now describes the real
verification ("PayPal khud payment ki tasdeeq karega…") — no admin
text anywhere claims Auto works when its fields are missing.

## 5. Generic HMAC verifier — two more REAL schemes

`verifyWebhookSignature` additionally accepts, against the same
configured `webhook_secret`:
- **Coinbase Commerce:** HMAC-SHA256 of the raw body in the
  `x-cc-webhook-signature` header (previously a genuine Coinbase
  delivery would have failed — its header was never read).
- **NOWPayments IPN:** HMAC-SHA512 in `x-nowpayments-sig`, over the
  raw body or over the recursively key-sorted JSON payload (their
  documented canonicalization).

Accepting extra candidates cannot weaken the gate: every candidate is
still a keyed HMAC with the operator's own secret, compared
timing-safe. Test A5 covers both + a tamper failure.

## 6. Rail-by-rail auto audit (the other 12 rails)

Researched against official provider documentation only (2026-10-29
research pack; UNVERIFIED items are labelled, never built on).
Verdicts: **COVERED** = a real verification path exists and our code
verifies it · **PSP-DEPENDENT** = verification exists only inside a
named PSP/gateway integration, not for the plain receiving detail ·
**MANUAL-BY-NATURE** = no public verification API exists for a plain
receiving detail; "Manual only" is a property of the method itself.

| Rail | Verdict | What the provider actually offers (official source) |
|---|---|---|
| Crypto | ✅ COVERED (extended this round, §5) | NOWPayments IPN: `x-nowpayments-sig`, HMAC-SHA512 over the key-sorted JSON body, IPN secret from the dashboard (nowpayments.zendesk.com/hc/en-us/articles/21395546303389). Coinbase Commerce: `X-CC-Webhook-Signature`, HMAC-SHA256 of the raw body with the Webhook Shared Secret (coinbase-migration.mintlify.app — Commerce webhook security). Direct-wallet receiving (no processor) has no one to confirm with — that stays manual, and the rail's fields already say the processor fields are "only if a processor handles this asset". |
| Cards | ✅ COVERED for Stripe; ⚠️ Checkout.com partial | Stripe: `Stripe-Signature` `t=…,v1=…`, HMAC-SHA256 over `timestamp + "." + raw body` with the endpoint signing secret — the generic verifier has spoken this since v14 (docs.stripe.com/webhooks). Checkout.com: `Cko-Signature` HMAC of the payload (hex) — Checkout.com's fetched official pages do NOT name the hash algorithm (UNVERIFIED), so we claim nothing beyond: if it is HMAC-SHA256 the generic verifier accepts it; unproven either way, no fake claim made. |
| Pix | PSP-DEPENDENT | Banco Central's API Pix spec does standardise a webhook (`/webhook/{chave}`), but it is registered with and delivered by the receiving PSP under OAuth + mTLS — there is no webhook for a plain Pix key or a static QR. PSPs that HMAC-sign their callbacks can use the generic path (the rail carries the PSP's api_token + webhook_secret fields); a plain chave Pix stays manual. No code change. (bacen/pix-api spec, BCB.) |
| Mobile money | ⚠️ Daraja/MoMo NOT signature-verifiable; aggregator-dependent | Safaricom Daraja offers ConfirmationURL/ValidationURL + Transaction Status / Pull Transactions APIs, but NO documented callback signature scheme was found in official Safaricom docs — an unsigned callback can be forged by anyone who knows the URL, so it can never be a crediting gate here; real Daraja verification means a full Daraja integration (OAuth, shortcode, status cross-checks), which is an initiation-side product, not a receiving detail. MTN MoMo: callbacks are likewise unsigned per official docs; its status GET needs the MoMo API user/key/subscription stack (momoapi.mtn.com). Practical consequence, already enforced by the gate: a Daraja method can never save Auto (Daraja issues no webhook_secret, and Auto requires one — the field help already says exactly this). Aggregators that DO HMAC-sign (the generic path) remain covered. No client faked. |
| E-wallet / NETELLER | PSP-DEPENDENT (no dedicated client) | NETELLER confirmation runs through the Paysafe Payments API payment-handle flow (`on_completed` URL, handle → PAYABLE → status via API) — a checkout integration, not a verification for a plain receiving email; no NETELLER md5/IPN formula exists in Paysafe's docs (the Skrill formula must NOT be reused for it). Wallet-side MQI uses the API/MQI password (not the login password). Our rail keeps the generic webhook_secret path for wallet providers that issue one; a Paysafe-handle NETELLER checkout is a separate future integration, not claimed here. (developer.paysafe.com — NETELLER payment method pages.) |
| Apple Pay | PSP-DEPENDENT by design | Apple issues no merchant confirmation webhook and no API key; the wallet returns an encrypted token and the PROCESSOR confirms (developers.google.com / developer.apple.com model; our rail already stores the processor + its webhook secret on the generic path). No change. |
| Google Pay | PSP-DEPENDENT by design | Same model: tokenisation type PAYMENT_GATEWAY — confirmation comes from the named gateway's webhooks (our generic path with the gateway's signing secret — the field help already says Google itself has none). No change. |
| Samsung Pay | PSP-DEPENDENT by design | Same token-to-processor model (Samsung-specific doc page not fetched in this pass — flagged, and nothing was built on it). Processor webhooks ride the generic path. No change. |
| UPI | ✅ MANUAL-BY-NATURE (proven) | NPCI/UPI offers NO merchant webhook or status API for a plain VPA — a payment to a bare UPI ID gives the payee nothing to verify against. Auto exists only inside a PSP integration (e.g. Razorpay: `X-Razorpay-Signature`, HMAC-SHA256 of the raw body — razorpay.com/docs — the same scheme family our generic verifier speaks, so a PSP-backed UPI method is a feasible FUTURE build; it would be a different, order-based method, not this plain-VPA rail). The plain UPI ID rail stays Manual, and that is now a documented property of UPI itself. |
| Bank transfer | ✅ MANUAL-BY-NATURE (proven) | A plain receiving bank account has no public verification API or callback; confirmation is the bank statement/app, unless the operator holds a bank-specific API agreement (that bank's API, not the rail's). Nothing to build. |
| QR Pay | ✅ MANUAL-BY-NATURE (proven) | A static QR (PromptPay etc.) to a plain account produces no webhook/status API for the receiver; auto-verification would require a bank/PSP API agreement (that institution's API, not the QR scheme's). Nothing to build. |
| Voucher | ✅ MANUAL-BY-NATURE (proven) | No server-to-server confirmation exists for voucher PINs outside an issuer's own merchant programme (if one exists at all); PINs are checked against stock by hand. Nothing to build — v21 already removed this rail's fictional api_key field. |
| Cash agent | ✅ MANUAL-BY-NATURE (proven) | Agent networks confirm through their own receipts/back-office; no public verification API exists for a plain receiving arrangement. Nothing to build. |

**PayPal refund-linkage caveat (honesty):** the COMPLETED-event
resource shape (capture object, `payee`, `supplementary_data`) is
verified from PayPal's official webhook docs
(developer.paypal.com/api/rest/webhooks/rest); the REFUNDED event's
field-level link back to its capture (the refund resource's `links`,
rel `up`) could not be fully verified from a fetched official page in
this pass. The implementation therefore treats a refund event WITHOUT
a resolvable capture link as record-only — the fail-closed side — so
the unverified detail can never cause a wrong revocation.

## 7. Auto withdrawals — BP-22 semantics kept, on purpose

Unchanged: Auto on a method still means BP-22 auto-APPROVE at/under
the limit after all gates; 'paid' still happens only when a human
marks it paid with the provider reference. **PayPal Payouts was NOT
wired:** PayPal's own prerequisites require a business account with
confirmed identity/email/bank AND access to PayPal Payouts granted on
application ("Request access to PayPal Payouts… After you apply,
PayPal will email you the decision" —
developer.paypal.com/limited-release/payouts/integrate/prerequisites)
— it is not something a Client ID alone switches on. And an automated
money-out path is the highest-risk surface in the system: wiring it
blind, untestable against the owner's real account from here, would
risk exactly the fake-'paid' failure this codebase refuses. If the
owner gets Payouts enabled on his PayPal business account and asks,
it is a follow-up round with the same discipline (provider-confirmed
status before any 'paid' state). Skrill mass payments are in the same
position (separate Automated Payments Interface enablement + the
API/MQI password).

## 8. Test evidence

New file `test/auto-integration.test.js` (15 tests): Part A — mode→
host mapping incl. sandbox host assertion through a stubbed fetch;
Skrill md5sig against a HARDCODED independently-computed vector +
fail-closed mutations; the autoCapability matrix (incl. bank/UPI/
voucher/cash-agent/QR = blocked forever); capture lookup against a
local double + the amount/currency/payee/status gate; Coinbase +
NOWPayments verifier schemes. Part B — spawned server + a real HTTP
PayPal double: B1 unlock refusal naming Webhook ID, then save; B2
exact-capture credit (double's token endpoint hit — the server really
called out); B3 five negative captures stay pending; B4 replayed
capture ID; B5 provider-down; B6 webhook credit + replay dedup + 401
on PayPal-refused verification; B7 manual-mode record-only; B8 Skrill
unlock without webhook_secret; B9 Skrill credit/replay/forged/
wrong-amount; B10 report-before-deposit applied on submit.

**Full suite (gate), read from the runner's own summary lines in the
run log:** `node --test test/*.test.js` → **329 tests / 326 pass /
0 fail / 3 skipped** — the v21 baseline (314/311/0/3) plus this
round's 15, zero regressions. The 3 skips are the Postgres-only tests
(no Postgres in the sandbox) — the standing test gap, not failures.

**Existing tests changed, honestly listed:**
- `test/v20-payments.test.js` — two U-21 assertions updated: the
  "paypal.webhook === false" invariant encoded the pre-client world;
  it now asserts the rail claims a confirmation path AND carries the
  Webhook ID its real verifier reads; the "every webhook rail has
  webhook_secret" invariant now exempts PayPal by name (its verifier
  reads webhook_id) and keeps the rule for all other rails.
- `test/credentials-roundtrip.test.js` — fixture gained distinct
  values for the three new fields (paypal webhook_id, ewallet
  merchant_id/secret_word); without them the generic fallback value
  collided between a text field (legitimately redisplayed) and the
  secret_word field. No assertion was weakened.
- `test/manual-payments.test.js` needed NO change: its B1 case (Auto
  refused for PayPal saved with ONLY the receiving email) still
  refuses — now for the named reason "Webhook ID missing" instead of
  "no integration exists".

## 9. What the owner must enter, and what then works (no live-proof promised)

This round is proven against provider DOUBLES. Real verification
against PayPal's / Skrill's real servers needs the owner's real (or
sandbox) credentials, entered by him in the admin panel after deploy —
they exist nowhere in this codebase or chat. After deploy, per the
updated OWNER-DETAILS-CHECKLIST:

- **PayPal:** Apps & Credentials → (Sandbox tab for the test) → app →
  Client ID + Secret → same app → Webhooks → add
  `https://cash-pop-lottery.onrender.com/webhooks/paypal` (events:
  Payment captures completed + refunded) → copy its Webhook ID. Save
  all three + Mode in Payment Methods → PayPal → Credentials, then
  Processing mode → Auto Pay. From that moment, deposits on that
  method verify against PayPal itself.
- **Skrill:** merchant account → Merchant ID (Customer ID) + Settings →
  Developer Settings → Secret Word; give Skrill
  `https://cash-pop-lottery.onrender.com/webhooks/skrill` as the
  status_url wherever his Skrill payment link/session is created.
  Save + Auto Pay as above.

## 10. Honest open items

1. **Not deployed.** Zip only; live still runs v21. Deploy on the
   owner's separate haan (free-tier DB wipe warning unchanged).
2. **No live PayPal/Skrill proof exists yet** — by construction: it
   needs the owner's credentials in the deployed admin (§9). Sandbox
   mode is genuinely wired (real sandbox host + sandbox creds), so his
   first test can be with test money end-to-end.
3. **PayPal Payouts / Skrill mass-pay:** not wired (§7, reasons
   stated). Withdrawal 'paid' remains a human-confirmed state.
4. **Skrill MQI status query:** not wired (§2, reason stated).
5. Postgres smoke test remains unrun (standing gap, not a code bug).

---

## ADDENDUM — HOTFIX 2026-10-29 (owner-reported on live v21, fixed same day, ships with this build)

**Defect (REAL, owner screenshot/report):** the player PayPal deposit page displayed "Payment gateway details: Client ID: <value>". Root cause: v20-era U-21 design whitelisted `paypal: ['client_id']` in PUBLIC_CONFIG_FIELDS ("public by design" — reasoning that fits JS-SDK checkout pages, which this product does not have; nothing client-side consumed the value) and deposit_new.ejs rendered getPublicConfig output. The Client SECRET was **never** exposed (secret:true + password type, hard-skipped in pickDetails — verified). v21/v22 leak tests missed it because they asserted only secret-flagged values; client_id is type text.

**Fix (owner rule: player pages show pay-to details + instructions ONLY):**
1. The entire "Payment gateway details" block removed from views/deposit_new.ejs; routes/player.js no longer fetches or passes gatewayPublic.
2. `paypal` removed from PUBLIC_CONFIG_FIELDS in lib/rails.js (with a do-not-re-add note); getPublicConfig remains for a future real client-side checkout.
3. test/v20-u24.test.js U-28.9 updated to the superseding contract (its old assertions encoded the removed behavior).
4. NEW test/player-credential-leak.test.js: plants a distinctive value in EVERY credential field of EVERY rail — lib projections (receiving = pay-to keys only; public config never carries credential-pair values) + spawned-server HTTP check that the rendered deposit page shows the pay-to email, no planted value, and no gateway block. 3/3 pass.

**Gate with hotfix:** full suite on final code 332 tests / 331 pass-equivalent — the only failure in the full run was U-28.9's superseded assertion, fixed above and re-proven (affected files re-run together: 57/57 pass, incl. manual-payments, auto-integration, v20-payments, v20-u24, player-credential-leak).

## ADDENDUM 2 — HOTFIX 2026-10-29 (owner-reported on live v22): admin wording on player pages

**Defect (owner's own words: "sari baat admin ki likh deta hai tu"):** the player wallet page said "Move money between your own wallets at the admin-set rate (Settings → Currencies — this is not a live market rate)" — operator internals (the admin, a Settings path) printed on a player surface, violating the owner's 2026-10-28 owner-only-information rule. The wording came from CURRENCY-SYSTEM-01's honesty requirement (never call it a "live market rate"); the honesty stays, the admin reference goes.

**Sweep + fix (player/agent surfaces only; admin panel wording unchanged):** views/wallet.ejs ×3 (total line, exchange intro, rate label), routes/player.js ×3 (method rate note, player-currency rate note, exchange success flash), views/agent/transfer.ejs ×1 ("Ask the admin" → "Ask the Cash Pop team"). New player wording: "the set rate — this is Cash Pop's own set rate, not a live market rate." Other grep hits adjudicated as NOT player-visible: code comments, the staff-only impersonation bar, the one-time setup page, server-side provider error strings (log/admin context).

**Guard:** currency-system test now asserts the rendered deposit page carries no admin/settings mention; NEW leak-test A3 sweeps player-facing sources for "admin-set" / Settings-path strings (comments stripped). Affected suites re-run green (currency-system + player-credential-leak: 8/8).
