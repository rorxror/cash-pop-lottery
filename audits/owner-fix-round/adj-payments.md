# U-21 — Payment method config audit (adj-payments.md)

Worker: PAYMENTS (U-21). Files owned: `lib/rails.js`, `routes/webhooks.js`,
`lib/credentials.js`, `lib/money.js`, `test/v20-payments.test.js`.
Read-only evidence from: `routes/admin.js`, `lib/admin-ui.js`,
`routes/player.js`, `views/deposit_new.ejs`, `lib/migrations.js`.
Written BEFORE fixes; line numbers below are the pre-fix baseline.

## 0. Where config actually lives (proven)

- Per-method config is **NOT** in `settings`. It is in table
  `gateway_credentials (method_id, field_key, field_value, field_enc,
  updated_at)`, UNIQUE(method_id, field_key) — `lib/migrations.js:217-220`
  (sqlite; pg :349, mysql :475).
- The field list per method is **not** coded in `routes/admin.js`. The admin
  form is generated from `rail.credentialFields` in `lib/rails.js`:
  GET `routes/admin.js:1762` maps `rail.credentialFields` to form fields,
  POST `routes/admin.js:1787` loops the same list and upserts each key into
  `gateway_credentials`, encrypting **every** field (not only secrets) when
  `CREDENTIAL_ENCRYPTION_KEY` is configured, and refusing the whole save
  when it is not (`routes/admin.js:1777-1785`). Blank password = keep saved
  (`routes/admin.js:1789` approx. in POST loop).
  Consequence: changing `credentialFields` in `lib/rails.js` changes the
  admin form automatically. The remaining form-side defects are in the
  admin route's field-mapping (see §5 spec) — later wave.
- Method-level (non-credential) config lives on `payment_methods`:
  name/kind/rail/currency/min/max/charges/`instruction`/`custom_fields`
  (`routes/admin.js` METHOD_FIELDS, ~:1620). `instruction` overrides
  `rail.defaultInstruction` on the player page.

## 1. (a) RUNTIME READS — every config key actually consumed

Exhaustive grep over `lib/ routes/ views/ server.js` for
`gateway_credentials` and every credential key. Only **three** consumers
exist:

| Consumer | Keys read | Evidence |
|---|---|---|
| Player deposit page receiving details | Only the keys in `RECEIVING_FIELDS[rail]` (map at pre-fix `lib/rails.js:179-188`), via `getReceivingDetails` (`lib/rails.js:189-206`), called from `routes/player.js:283`, rendered in `views/deposit_new.ejs` ("Send your payment to:") | rails.js:179-206; player.js:282-284 |
| Webhook verification | **Only `webhook_secret`** of each enabled method on the rail. `routes/webhooks.js:66-75` decrypts all rows but assigns only `creds.webhook_secret`; `verifyWebhookSignature` (`lib/rails.js:140-172`, esp. :144-146) HMAC-SHA256s with `webhook_secret` only (R-084: no fallback to api_token/secret_key) | webhooks.js:60-76; rails.js:144-146 |
| Admin credentials page display | All `credentialFields` (display/re-save only — not a payment runtime) | admin.js:1755-1769 |

**Nothing else reads any credential key.** No code calls Stripe, Checkout,
a Pix PSP, M-Pesa, Apple/Google/Samsung Pay, a voucher issuer, or any
crypto processor. There is no provider API client and no gateway payout
executor in the codebase (auto-withdrawal is approve-only for the same
reason, `lib/money.js` BP-22 note). Withdrawals read **no** operator
credentials at all: the player supplies payout details through
`methodCustomFields` (`routes/player.js:262-268`, same field set as
deposits — itself a defect, see §4-W).

Therefore, pre-fix, per rail the ONLY functionally consumed keys are:
crypto `wallet_address,network`; cards `webhook_secret`; upi
`upi_id,merchant_name`; pix `pix_key`; mobile_money
`provider,account_number`; ewallet `provider,account_email`;
bank_transfer `bank_name,account_name,account_number,swift`;
qr_pay `qr_image_url,account_label`; cash_agent
`agent_network,instructions`. Every other collected key is **stored-only**
(DEAD at runtime), and every `webhook:true` rail except `cards` cannot
supply the one key the webhook verifier needs.

## 2. (b) FORM TODAY

The form collects exactly `rail.credentialFields` (pre-fix
`lib/rails.js:11-115`), rendered by `routes/admin.js:1763-1769` +
`lib/admin-ui.js` `formHtml/fieldHtml` (`lib/admin-ui.js:22-46`).
Form-rendering defects in the admin route's mapping (admin.js:1765-1768):
it rebuilds each field as `{key,label,type,options|value}` and **drops
`help`** for all non-password fields (password fields get only the fixed
help "Leave blank to keep the saved value."), and drops any `secret`
marker. So even where rails.js defines help text, the operator never
sees it. Spec in §5.

## 3. Per-method three-way table (pre-fix)

Legend: R=runtime reads (§1), F=form collects (credentialFields),
G=genuinely required. Classes: DEAD / MISSING KEY / MISSING REAL /
WRONG.

### crypto — manual wallet (+ optional processor webhooks) — rails.js:11-18
- R: wallet_address, network. F: wallet_address(req), network(opt),
  confirmations(opt). G (manual): asset (BTC/USDT/…), network, address —
  an address is meaningless without asset+network (USDT-TRC20 vs
  USDT-ERC20 are different destinations); confirmations is operator
  review policy the player should see; tx_hash from player ✔ (userField).
- Deltas: `network` optional = **WRONG** (must be required);
  `asset` = **MISSING REAL**; `confirmations` = **DEAD** (never read —
  fix: show it to the player as a receiving detail);
  `webhook:true` but no `webhook_secret` field = **MISSING KEY**
  (webhook can never verify).

### cards — Stripe/Checkout.com/manual link — rails.js:19-27
- R: webhook_secret only. F: provider(req, select Stripe/Checkout.com/
  Other), publishable_key(req), secret_key(req, pw), webhook_secret(pw).
  G: Stripe = publishable key + secret key + webhook signing secret
  (`whsec_…`), keys encode live/test; Checkout.com = secret key +
  webhook signature key. Manual-link mode (the rail's own
  defaultInstruction, rails.js:26) needs **none** of them.
- Deltas: publishable_key + secret_key = **DEAD** today (no provider
  client; publishable key is wired by this round into a public-config
  read path, §6); both marked required = **WRONG** (blocks the manual
  mode the rail advertises); no live/sandbox `mode` = **MISSING REAL**
  (operator cannot tell test keys from live keys; validation now checks
  Stripe key prefix vs mode); publishable_key type text ✔ (it is not a
  secret — correct not to password-mask it).

### upi — manual — rails.js:28-34
- R=F=G: upi_id(req), merchant_name(opt); player UTR ✔.
- Deltas: essentially correct. Only: no format validation on upi_id
  (VPA shape `name@bank`) = **WRONG** (validation missing, §6).

### pix — manual + PSP webhook claimed — rails.js:35-42
- R: pix_key. F: pix_key(req), provider(opt), api_token(pw, opt).
  G (manual): pix_key + its type (CPF/CNPJ/email/phone/random key —
  validation and what the payer's app expects differ by type).
  G (PSP auto): API token + webhook signing secret.
- Deltas: `api_token` = **DEAD** (R-084 removed it as a signing
  fallback; no PSP client reads it — config-only, kept with honest
  label/help); webhook:true, no `webhook_secret` = **MISSING KEY**;
  `pix_key_type` = **MISSING REAL**.

### mobile_money — manual + webhook claimed — rails.js:43-50
- R: provider, account_number. F: provider(req), account_number(req),
  api_key(pw, opt). G (manual): provider, receiving number, and the
  **registered account name** — mobile-money payers verify the name
  shown by USSD before confirming; without it players cannot check
  they are paying the right person. G (auto): API key + webhook secret.
- Deltas: `account_name` = **MISSING REAL**; `api_key` = **DEAD**
  (config-only); webhook:true, no `webhook_secret` = **MISSING KEY**.

### ewallet — Skrill/Neteller/PayPal lumped, manual — rails.js:51-58
- R: provider, account_email. F: provider(req, free text "Skrill,
  Neteller, PayPal..."), account_email(req), api_credentials(pw, opt).
  G (manual): provider + receiving email/ID ✔. G (API, per provider):
  split credentials (client id + client secret), never one blob.
- Deltas: `api_credentials` = **WRONG + DEAD** — no provider on earth
  takes a single free-text "API credentials" blob; replaced by
  `client_id` + `client_secret` + `webhook_secret`. PayPal lumped in as
  a free-text provider string = **MISSING REAL** (see paypal below).

### paypal — DID NOT EXIST as a rail (owner's example)
- Pre-fix there is no PayPal method at all: only the word "PayPal" in
  the ewallet provider label (rails.js:53). Enabling "PayPal" opened
  the generic ewallet form — exactly the owner's complaint.
- G (manual): receiving PayPal email + account name shown to sender;
  player submits PayPal transaction ID + sender email.
  G (API): client_id + client_secret + **webhook_id**, mode
  live/sandbox. PayPal webhook verification is **not** HMAC: PayPal
  requires a `POST /v1/notifications/verify-webhook-signature` API call
  with an access token — no such client exists, so this round sets
  `webhook:false` honestly (the generic HMAC route must not pretend to
  verify PayPal events) and specs the API leg as future work (§7).
- Fix in this round: new dedicated `paypal` rail (14th; migrations seed
  templates from RAILS automatically, `lib/migrations.js:1139-1152`),
  manual mode complete; ewallet provider label no longer claims PayPal.
  The rail is appended LAST in RAILS on purpose: seeded method IDs are
  assigned in RAILS order on fresh installs and existing code/tests
  reference bank_transfer as method 10 — inserting mid-array shifted
  those IDs and broke test/tamper.test.js; appending keeps every
  pre-existing seed ID byte-identical.

### apple_pay — manual via PSP — rails.js:59-66
- R: none. F: merchant_id(req), processor(req), api_key(req, pw).
  G: Apple Pay on the web needs the Apple merchant ID + a PSP; the
  merchant ID is a **public** config value consumed by Apple Pay JS,
  not a pay-to address and not a secret. This app has no Apple Pay JS,
  so deposits are manual via the PSP (per its own instruction).
- Deltas: merchant_id/processor = **DEAD** today (wired into the
  public-config read path this round, §6); api_key required =
  **WRONG** for manual mode; webhook:true, no `webhook_secret` =
  **MISSING KEY**.

### google_pay — manual via gateway — rails.js:67-74
- R: none. F: merchant_id(req), gateway(req), gateway_merchant_id(opt).
  G (Google Pay API): merchantId + merchantName + gateway +
  gatewayMerchantId + environment (TEST/PRODUCTION) — all public
  config for the Google Pay JS button; PSP webhook secret for
  server confirmation.
- Deltas: all = **DEAD** today (public-config wiring this round);
  `merchant_name` + `environment` = **MISSING REAL**; webhook:true, no
  `webhook_secret` = **MISSING KEY**.

### samsung_pay — manual via partner — rails.js:75-82
- R: none. F: merchant_id(req), service_id(opt), api_key(pw, opt).
  G: partner merchant ID + Samsung-issued service ID via a PSP;
  public config + PSP webhook secret.
- Deltas: merchant_id/service_id = **DEAD** (public-config wiring);
  webhook:true, no `webhook_secret` = **MISSING KEY**.

### bank_transfer — manual — rails.js:83-91
- R=F: bank_name, account_name, account_number, swift — all shown ✔.
  G: those + a distinction between SWIFT/BIC (international) and a US
  ABA routing number (domestic) — one field labelled "SWIFT / routing
  code" conflates two different identifiers a player must enter in
  different places in their banking app.
- Deltas: conflated field = **WRONG** (split: `swift` validated as BIC,
  new optional `routing_number`, both receiving details); player's
  sending-account name helps admin match the credit = **MISSING REAL**
  (new optional userField `sender_name`).

### qr_pay — manual — rails.js:92-98
- R=F: qr_image_url(req), account_label(opt). G: QR image + **which
  wallet/network the QR belongs to** (a PromptPay QR cannot be paid
  from a UPI app and vice versa) + label.
- Deltas: `provider` (wallet/network) = **MISSING REAL**;
  qr_image_url unvalidated (any string rendered as `<img src>` on the
  deposit page, deposit_new.ejs) = **WRONG** (validation: https URL).
  Note: `routes/webhooks.js` MINOR_UNIT_RAILS includes qr_pay although
  the rail says webhook:false — the route accepts webhooks for every
  rail; the minor-unit convention is retained deliberately and
  documented in webhooks.js (no behaviour change).

### voucher — manual PIN redemption — rails.js:99-105
- R: none (no receiving detail — correct: the player pays by handing
  over a PIN, userField voucher_pin ✔). F: issuer(req), api_key(opt).
  G: issuer ✔; an issuer API key only matters with a redemption API
  client, which does not exist.
- Deltas: `api_key` = **DEAD** (config-only, honestly labelled).

### cash_agent — manual — rails.js:106-115
- R=F: agent_network(opt), instructions(opt) — both shown ✔.
  G: at least the network name or instructions must exist, otherwise
  the player is told to "visit an agent" with no destination at all.
- Deltas: both optional = **WRONG** (agent_network now required).

## 4. Cross-cutting verdicts

- **W — Withdrawal user-fields are deposit fields.** `routes/player.js`
  `methodCustomFields` returns the same set for /withdraw/new as for
  deposits: a withdrawing bank_transfer player is asked for a "Transfer
  reference" instead of their own account details. rails.js now defines
  per-rail `withdrawUserFields` (player's OWN payout destination);
  wiring `methodCustomFields(method, kind)` is player.js work — spec §5.
- **S — Secrets.** Every field is encrypted at rest when the key is
  configured (admin.js POST loop) — stronger than required. The real
  secret-safety defects were definitional: no `secret` marker existed,
  and nothing prevented a password field from being added to
  RECEIVING_FIELDS. This round: `secret:true` on every password field,
  and `getReceivingDetails`/`getPublicConfig` hard-skip any field that
  is password-typed or secret-flagged (defense in depth, tested).
- **V — Validation.** Pre-fix save validation in admin POST was only
  "required and non-empty" (and required password fields silently
  passed when blank on first save due to the keep-saved `continue`).
  Garbage (bad UPI ID, non-URL QR, test Stripe key on a live method)
  stored silently. rails.js now exports per-key validators with
  true-reason messages; admin POST wiring is spec §5 (the lib-level
  validators are proven by tests now).
- **D — Dead-field discipline (R-044).** Remaining config-only fields
  after this round (cards secret_key, pix api_token, mobile_money
  api_key, ewallet client_secret, apple/samsung api_key, voucher
  api_key) are fields a real provider integration genuinely requires
  (§3-G) but for which **no provider client exists in this codebase**.
  They are kept — deleting Stripe's secret key from config would make
  the method less real, not more — but each now carries help text
  stating it is used only by the provider/API mode and is not needed
  for manual review, none is `required`, and none blocks manual mode.
  The two truly bogus fields (`api_credentials` blob,
  crypto `confirmations` as stored-only) are removed/wired.

## 5. SPEC for the later wave (routes/admin.js + lib/admin-ui.js + routes/player.js) — PRECISE

### 5.1 routes/admin.js — POST /methods/:id/credentials (validation wiring)
Before the upsert loop, for the method's rail:
```js
const { validateRailCredentials } = require('../lib/rails');
// build `incoming` = for each credentialField: password fields take the
// posted value OR the already-saved decrypted value when posted blank
// (keep-saved semantics); other fields take the posted value.
const v = validateRailCredentials(m.rail, incoming);
if (!v.ok) { await req.setFlash('error', v.error); return res.redirect(R(req, '/methods/' + m.id + '/credentials')); }
```
Also fix: a required **password** field with no saved value and a blank
post must fail with `"${f.label}" is required.` (today the keep-saved
`continue` skips the required check). `validateRailCredentials` already
enforces required on the merged map, so wiring it as above closes this.

### 5.2 routes/admin.js — GET /methods/:id/credentials (render help/secret)
Replace the field-rebuilding map (admin.js:1765-1768) with a pass-through
that preserves the rails.js definition:
```js
fields.map(f => ({ ...f,
  type: f.type === 'password' ? 'password' : f.type,
  value: f.type === 'password' ? '' : (saved[f.key] || ''),
  help: f.type === 'password' ? ((f.help ? f.help + ' ' : '') + 'Leave blank to keep the saved value.') : f.help,
}))
```
(`lib/admin-ui.js fieldHtml` already renders `f.help` and select
options — no admin-ui change needed beyond receiving intact fields.)

### 5.3 routes/player.js — public config + withdrawal fields
1. On GET /deposit/new, alongside `receiving`, pass
   `gatewayPublic = await getPublicConfig(req.db, method)` (from
   lib/rails.js) to `deposit_new.ejs`; the view (views worker) renders
   it as non-secret gateway config (e.g. Stripe publishable key /
   Google Pay parameters) when present. Until the view leg lands,
   `getPublicConfig` is exercised by test/v20-payments.test.js.
2. `methodCustomFields(method, kind)`: for `kind === 'withdrawal'` use
   `rail.withdrawUserFields` instead of `rail.userFields`; deposits keep
   `rail.userFields`. Update both call sites in /withdraw/new (GET+POST)
   and the /withdraw/verify re-render paths.

### 5.4 Exact field list per method (target state — this IS the
credentialFields definition shipped in lib/rails.js this round;
key | label | type | required | secret | help/validation summary)

- **crypto**: asset | Asset (e.g. BTC, USDT) | text | yes | no |
  ^[A-Z0-9]{2,10}$ · network | Network | text | yes | no | 2-30 chars ·
  wallet_address | Receiving wallet address | text | yes | no |
  26-120 chars, no spaces · confirmations | Required confirmations |
  number | no | no | integer 0-100, shown to player ·
  webhook_secret | Processor webhook signing secret | password | no |
  yes | only for processor HMAC webhooks.
- **cards**: provider | Card processor | select(Stripe, Checkout.com,
  Other) | yes | no · mode | Mode | select(live, sandbox) | no | no |
  Stripe key prefix must match mode · publishable_key | Publishable
  key | text | no | no | Stripe: ^pk_(live|test)_ · secret_key |
  Secret key | password | no | yes | Stripe: ^(sk|rk)_(live|test)_ ·
  webhook_secret | Webhook signing secret | password | no | yes |
  Stripe: ^whsec_.
- **upi**: upi_id | Receiving UPI ID | text | yes | no |
  ^[\w.\-]{2,}@[A-Za-z]{2,} · merchant_name | Merchant display name |
  text | no | no.
- **pix**: pix_key | Pix key (receiving) | text | yes | no | email /
  phone / CPF-CNPJ digits / UUID / 32-char random key ·
  pix_key_type | Pix key type | select(cpf, cnpj, email, phone,
  random) | no | no · provider | Pix provider (PSP) | text | no | no ·
  mode | Mode | select(live, sandbox) | no | no · api_token |
  Provider API token | password | no | yes · webhook_secret |
  Provider webhook signing secret | password | no | yes.
- **mobile_money**: provider | Provider (M-Pesa, MTN, Airtel...) |
  text | yes | no · account_number | Receiving account / till number |
  text | yes | no | 7-20 digits/+ · account_name | Registered account
  name | text | no | no (receiving detail) · api_key | Provider API
  key | password | no | yes · webhook_secret | Provider webhook
  signing secret | password | no | yes.
- **ewallet**: provider | Wallet | select(Skrill, Neteller, Other) |
  yes | no · account_email | Receiving account email/ID | text | yes |
  no | email shape when it contains @ · client_id | API client ID |
  text | no | no · client_secret | API client secret | password | no
  | yes · webhook_secret | Webhook signing secret | password | no |
  yes. (Replaces the `api_credentials` blob; old blob rows are ignored
  and the operator re-saves split fields.)
- **paypal** (NEW): account_email | PayPal account email (receiving) |
  text | yes | no | email · account_name | Account name shown to
  sender | text | no | no · mode | Mode | select(live, sandbox) | no |
  no · client_id | API client ID | text | no | no · client_secret |
  API client secret | password | no | yes.
  Player userFields: paypal_txid (required), sender_email (optional).
- **apple_pay**: merchant_id | Apple merchant ID | text | yes | no |
  ^merchant\. · processor | Payment processor | text | yes | no ·
  api_key | Processor API key | password | no | yes ·
  webhook_secret | Processor webhook signing secret | password | no |
  yes.
- **google_pay**: merchant_id | Google Pay merchant ID | text | yes |
  no · merchant_name | Merchant name | text | no | no · gateway |
  Gateway name | text | yes | no · gateway_merchant_id | Gateway
  merchant ID | text | no | no · environment | Environment |
  select(TEST, PRODUCTION) | no | no · webhook_secret | Gateway
  webhook signing secret | password | no | yes.
- **samsung_pay**: merchant_id | Samsung Pay merchant ID | text | yes
  | no · service_id | Service ID | text | no | no · api_key | API key
  | password | no | yes · webhook_secret | Webhook signing secret |
  password | no | yes.
- **bank_transfer**: bank_name req · account_name req ·
  account_number req (4-34 alnum/IBAN) · swift | SWIFT/BIC code | no |
  BIC pattern when present · routing_number | US routing number
  (ABA) | no | 9 digits when present. Player userFields: reference
  (req), sender_name (opt).
- **qr_pay**: provider | Wallet / network for this QR | text | yes |
  no · qr_image_url | QR code image URL | text | yes | no | https
  URL · account_label | Account label under QR | text | no | no.
- **voucher**: issuer | Voucher issuer | text | yes | no · api_key |
  Issuer API key | password | no | yes.
- **cash_agent**: agent_network | Agent network name | text | yes |
  no · instructions | Agent instructions | textarea | no | no.

## 6. Fixes landed in this round's files (summary; details in tests)

- lib/rails.js: field lists per §5.4; `secret` markers; RECEIVING_FIELDS
  extended (crypto asset+confirmations, pix_key_type, mobile_money
  account_name, bank routing_number, qr provider, paypal);
  PUBLIC_CONFIG_FIELDS + `getPublicConfig` (non-secret gateway config
  read path); `validateCredentialValue` / `validateRailCredentials`
  (true-reason errors); `validateUserProof` (tx_hash / UTR formats);
  per-rail `withdrawUserFields`; new `paypal` rail, webhook:false with
  the honest reason in a comment.
- lib/credentials.js: `saveCredentialField` (encrypt + upsert, fails
  closed without a key) and `loadCredentials(db, methodId, onError)`
  shared loader.
- routes/webhooks.js: credential loading via `loadCredentials`
  (decrypt-failure audit preserved); comment documenting qr_pay
  minor-unit retention.
- lib/money.js: createDeposit/createWithdrawal reject malformed proof /
  payout values for known keys (tx_hash, utr) with the true reason,
  via `validateUserProof`; absent/empty values untouched (requiredness
  stays the route's job, as today).

## 7. Honestly open

- PayPal API mode (client credentials grant, orders, webhook_id +
  verify-webhook-signature call) — no provider client exists; manual
  PayPal is complete this round, API mode is config-ready only.
- All other PSP API clients (Stripe Checkout sessions, Pix PSP, M-Pesa
  STK, voucher redemption) — same status: config is now correct and
  validated; crediting remains webhook (HMAC rails) or admin review.
- Admin-form legs in §5.1-5.3 (later wave) — until then the current
  admin POST still saves the new field lists (it loops
  credentialFields generically) but without the new validation and
  without rendering help text.
