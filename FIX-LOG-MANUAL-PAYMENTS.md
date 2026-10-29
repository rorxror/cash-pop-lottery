# FIX-LOG — MANUAL PAYMENTS round (v21 build, NOT deployed)

**Date:** 2026-10-29 · **Workdir:** `~/workspace/cash-pop-fix/` · **Status:**
build + test + zip only. Nothing was pushed or deployed in this round;
the live site still runs v20 (commit 88aff2c) until the owner separately
says deploy.

**Live proof already on record (owner, 2026-10-29 ~01:48 CDT):** after
the Render CREDENTIAL_ENCRYPTION_KEY fix, the owner saved his PayPal
details in the live admin and the player deposit page showed the pay-to
detail — the credential-save → receiving-details-display path is proven
end-to-end on live v20 by the owner himself.

**Basis note (ADMIN-DEEP-MAP-01):** the admin-structure work in this
round rests on (a) the October 2026 top-level ViserLab/RaffleLab outline
— shallow by the owner's own correction, used only as an IA outline —
and (b) the owner's own lived findings from 2026-10-28/29. The
exhaustive folder-tree map of the reference admin is access-gated (the
demo stops at its login; no password was guessed or submitted) and is
the reference for the NEXT structure round. No ViserLab detail is
claimed anywhere below that was not actually observed; the one direct
observation used is the demo LOGIN page (2026-10-29 02:51 CDT).

---

## Feature-status matrix (whole round)

| Area | Status | Evidence |
|---|---|---|
| Manual deposit + withdrawal, all 14 rails | ✅ built + E2E-proven | test/manual-payments.test.js (13 tests) |
| Per-rail field audit (exactly the real fields) | ✅ done; 1 fix (voucher issuer) + CREDENTIALS-REAL-01 corrections | §2, §6 |
| Per-method Manual / Auto selector | ✅ wired, honest locks | §4 |
| Auto-deposit webhook path (signature-verified) | ✅ proven incl. forged/replay/wrong-amount refusals | §4 |
| Auto withdrawal = BP-22 limit auto-APPROVE only | ✅ proven; 'paid' never faked | §4 |
| Player visibility of auto money movement | ✅ proven (pending → credited; hold → approved → paid) | §7 |
| Agent → player transfer currency display | ✅ fixed + proven | §3 |
| Player/admin session isolation (one browser) | ✅ dual-scope sessions, proven with one cookie jar | §3 |
| Admin direct password set + admin My Account | ✅ built + proven | §8 |
| Wagering gate findability (two doors + Settings index) | ✅ done + proven | §9 |
| Admin table ID stacking (MESH-ID-01) | ✅ fixed + audited all admin tables | §10 |
| Audit Trail readability (AUDIT-DETAIL-01) | ✅ lossless humanized rendering | §10 |
| Dedicated admin login at the secret root | ✅ built (owner order supersedes root-404) | §11 |
| Limits & Controls hub + global deposit caps | ✅ built; caps enforced at deposit creation | §12 |
| Admin page purpose subtitles + Common tasks | ✅ all sidebar pages | §12 |
| User detail page rebuild (summary-first) | ✅ done; one regression found+fixed (§13) | §13 |
| Player currency system + wallet Exchange | ✅ built + proven | §14 |
| Email/SMS/Google/Facebook delivery truth | ✅ audited, violations fixed, provider-double E2E | §15 |
| Admin login & verification health card + test sends | ✅ on Security page | §15 |
| Maintenance-mode form-post download bug | ✅ fixed (response shape only) | §16 |
| TOTP 2FA | ✅ owner-verified live 2026-10-29 (no re-proof needed) | §15 |
| Postgres smoke test | ⚠️ still a test gap (no PG in sandbox) — not a code bug | §18 |
| RaffleLab deep tree map → nav regrouping | ⏳ gated on access; deliberately NOT done this round | §17 |
| PayPal / Skrill true API auto-verify clients | ❌ do not exist in code; Auto honestly locked for those rails | §6 |

---

## 1. MANUAL PAYMENTS — core brief

**Field audit (per rail):** every rail's `credentialFields`,
`userFields` (deposit proof) and `withdrawUserFields` (payout
destination) were checked against what a real operator needs for manual
handling. **One field-set fix:** `voucher` had **no receiving fields at
all**, so players were never told which issuer's voucher to buy —
`issuer` added as a receiving (public pay-to) field. Everything else
matched after the label work in §6. A guard that would have refused
withdrawals on destination-less rails was **reverted honestly**: those
rails (cards, Apple/Google/Samsung Pay, cash_agent, voucher) are
withdrawable by design — the team arranges the payout off-platform and
marks it paid; the withdrawal how-to text says exactly that.

**Manual E2E (test/manual-payments.test.js, 13 tests, DB evidence):**
for every rail — admin configures test receiving details → enables →
player deposit page shows the pay-to details + instructions and **no
secret fields** (dedicated secret-leak assertions with planted secret
values per rail) → player submits the rail's proof fields → request
lands in the admin queue with proof + receiving details on ONE detail
screen → approve credits the exact net exactly once (double-approve
impossible) → reject credits nothing and the player sees the true
reason. Withdrawals (rails with destination fields): destination
submitted → gates apply → hold placed exactly once → admin sees the
full destination on the detail screen → mark-paid only after sending
outside the site → reject/cancel refunds the hold exactly once.

**Ease pass:** deposit/withdrawal detail pages now show, in one place:
pay-to details used, player proof, destination, amount/charge/net —
no hunting through the method's credentials page. Rails honestly
awkward in manual mode: cards and the three wallet pays have no
natural receiving detail — deposits run via a team-sent secure payment
link (instructions say so), withdrawals are arranged by the team. No
fake integration was built for them.

## 2. AGENT-CURRENCY-01 (owner-reported)

**Before:** `views/agent/transfer.ejs` rendered the Currency select
ONLY from the agent's `agent_floats` rows — an unfunded agent saw an
empty select with no explanation and could not transfer at all; the
Amount label was hardcoded "(USD)".
**After:** the dropdown always lists the site's enabled currencies,
each annotated with the agent's float balance in it (0 where unfunded);
a zero-float agent gets a plain empty-state ("admin must fund the
float first"); the Amount label follows the selected currency. Proven:
unfunded agent sees options + empty state; admin funds a non-USD
float → agent transfers in that currency → player's wallet credited in
the same currency with the exact amount (DB); insufficient float still
refused with the true reason and no ledger entry.

## 3. SESSION-TAB-01 (owner-reported)

**Before:** one session cookie (`sid`) for player AND admin — logging
in on any tab overwrote the session for the whole browser (the swap
the owner saw).
**After:** dual-scope sessions — `sessions.scope` (migration v24),
admin-scope cookie `sid_admin`; admin routers authenticate ONLY from
the admin scope, site routes ONLY from the site scope; neither login
touches the other scope's cookie; panel logout clears only the admin
session; the Sessions admin UI shows scope truthfully. Proven with ONE
shared cookie jar (test/session-scope.test.js, 5 tests): player login
→ admin login in "tab 2" → player tab still the player, admin tab
still the panel → admin logout leaves the player session alive →
stealth 404 regression intact. Permanent end-state (noted for the
owner): admin on its own subdomain after the domain purchase.

## 4. METHOD-MODE-01 — per-method Manual / Auto Pay

Per-method `processing_mode` (migration v25, default `manual`) with
the selector at the TOP of each method's Credentials page ("Please
select: Manual Pay / Auto Pay") + a plain line per rail explaining
what each means there.

- **Auto deposits** are savable ONLY where the rail can truly confirm:
  `webhook: true` rails + `webhook_secret` present (+ any required
  provider field). Saving Auto without them REFUSES, listing the exact
  missing fields. Webhook handler now checks the matched method's
  mode: a signed webhook on a MANUAL-mode method is recorded but does
  NOT credit (deposit stays in the admin queue).
- **Rails that cannot auto** (selector visible, Auto locked with the
  honest reason): upi, bank_transfer, voucher, cash_agent, paypal.
  PayPal's reason is specific: PayPal payment verification is not
  HMAC — it needs PayPal's verify-webhook-signature API (Webhook ID +
  access token) and **no such client exists in this codebase**, so
  Auto stays locked rather than pretending.
- **Auto-capable rails today:** crypto, cards, pix, mobile_money,
  ewallet, apple_pay, google_pay, samsung_pay (all via the generic
  signature-verified webhook path).
- **Withdrawals:** per-method Auto interacts with BP-22 only — at/under
  the effective auto-withdrawal limit the request auto-APPROVES after
  all gates; above → manual queue; 'paid' is never faked (admin sends
  outside the site and marks paid with the provider reference). NOTE
  (deliberate, disclosed): BP-22 auto-approval is NOT gated on the
  per-method mode — the limit system predates the selector and the
  owner set it up as its own control.
- **Precedence (documented per spec):** blocks (global/per-user
  deposit/withdrawal off, blocked users) > per-method mode >
  webhook/limit rules.
- **Proven** (in test/manual-payments.test.js): manual-mode + valid
  webhook → recorded, not credited; auto cards/crypto + signed webhook
  → credited exactly once, replay deduped, forged signature 401,
  wrong amount no credit; Auto save refused on paypal/bank_transfer
  (locked reason) and on cards without webhook_secret (missing field
  named, mode stays manual); auto withdrawal under limit auto-approved
  but NOT paid, over limit queued; **PayPal saves and works manually
  with ONLY the receiving email** (owner's direct question).

## 5. INSTR-APPLE-01 — written how-tos + Apple design

Every rail's `defaultInstruction` was rewritten from one-liners into
numbered 3–5 step how-tos (where to pay → exact amount/must-match
warnings → what proof and where the player finds it — UTR in the UPI
app, TxID in PayPal Activity, hash in the wallet → submit → honest
"manual review, credit after approval", no fake durations).
Withdrawals got their OWN per-rail text (new per-method
`withdraw_instruction`, migration v26) instead of reusing deposit
text: destination entry, double-check warning, gates/review/send/mark-
paid flow. Auto-mode methods show the automatic-credit text instead —
manual and auto text never mix. Seed heal upgrades methods still
carrying the known pre-round one-liners; **admin-customized text is
never overwritten** (exact-match heal only). New/changed UI follows
the Apple design rules (persistent labels, 48px targets, press state,
one primary button, light/cream + gold). Render proof for PayPal,
Crypto, Bank Transfer, UPI: how-to steps + pay-to details present,
secrets absent, auto text replaces manual text on an auto method.

## 6. FIELD-LABELS-01 + CREDENTIALS-REAL-01

Live anchor: the owner confirmed on live v20 that saving PayPal
details made the pay-to detail appear on the player deposit page.

Every credential field now carries (a) the provider's own name as its
label, (b) a help line naming exactly WHERE the value is found, and
(c) a **mode note** rendered on the credentials page — "Needed for:
Manual…", "Needed for: Auto/API mode only…", etc. — so API fields are
never filled unknowingly for a manual setup. Field verification was
done against official provider sources (research pass, 2026-10-29):

| Rail | Correction / confirmation | Provider's own name & where | Source |
|---|---|---|---|
| PayPal | Labels corrected: `client_id` → **Client ID**, `client_secret` → **Secret**; mode mirrors the Sandbox/Live tabs | developer.paypal.com → Apps & Credentials → Live tab → app page (Client ID + Secret). Classic API Username/Password/Signature is a different, older credential — explicitly warned against in help + checklist | developer.paypal.com/api/rest/, /apps-scopes-and-credentials |
| Crypto | **Added missing `api_key`** (the primary gateway credential); webhook secret named per processor | NOWPayments: API Key (Settings → Payments → API keys), IPN Secret Key; Coinbase Commerce: API Key, Webhook Shared Secret | nowpayments.io, docs.cdp.coinbase.com |
| Cards | ✅ already exact (Stripe) | Publishable key / Secret key / Signing secret — dashboard.stripe.com → Developers → API keys / Webhooks | docs.stripe.com/keys, /webhooks |
| UPI | `merchant_name` relabeled — it is the **bank-verified name** on the VPA, not a free display name | UPI ID / VPA (NPCI); holder sees it in BHIM/GPay/PhonePe → Profile | npci.org.in |
| Pix | **`mode` field removed** (not a Banco Central concept); provider relabeled to the account-holding institution (PSP); API fields attributed to the named gateway | chave Pix; types CPF/CNPJ/telefone/e-mail/chave aleatória (DICT) | bcb.gov.br (Resolução BCB nº 1/2020, DICT manual) |
| Mobile money | **`account_type` added** (paybill/till/mobile); number relabeled Business Number / Till Number / mobile number; the payer's "Account Number" is NOT a merchant credential (was the rail's biggest error) | Lipa na M-PESA: Paybill Business Number / Till Number; Daraja: Consumer Key (developer.safaricom.co.ke → My Apps); Daraja has NO webhook secret | Safaricom Daraja portal |
| E-wallet | Labels corrected to NETELLER's exact **Client ID / Client Secret**; receiving field = merchant processing email / Account ID; Skrill truth in help (no Client ID/Secret — Merchant ID + Secret Word) | NETELLER portal → Settings → Developer Settings → API Keys | developer.paysafe.com, skrill.com guides |
| Apple Pay | ✅ merchant_id exact; api fields already processor-attributed — help now states Apple issues no API key | Merchant ID — developer.apple.com → Merchant IDs | developer.apple.com |
| Google Pay | ✅ fields exact per Google (merchantId, merchantName, gateway, gatewayMerchantId, environment TEST/PRODUCTION); webhook secret clarified as the GATEWAY's (Google has none) | Google Pay & Wallet Console | developers.google.com/pay |
| Samsung Pay | **Duplicate `merchant_id` field REMOVED** — Samsung's docs: serviceId IS the merchant ID; processor field added; API fields processor-attributed | Service ID — Samsung Pay Developers portal | developer.samsung.com/pay |
| Bank transfer | **IBAN split into its own field** (was merged into account number); **local routing code added** (sort code/IFSC/BSB); save now requires account number OR IBAN | IBAN = ISO 13616; BIC = ISO 9362; ABA RTN | ISO standards (no single official page exists — by design) |
| QR Pay | **`payee_id` added** — the receiving detail is the ID inside the QR (PromptPay ID), not the picture; provider relabeled Network/scheme; label = recipient name on confirmation | PromptPay ID (mobile/citizen ID/account) — Bank of Thailand; Thai QR = EMVCo Tag 29 | bot.or.th |
| Voucher | **Fictional `api_key` REMOVED** — no issuer console exists in the manual reality; PINs are checked by hand | operator-defined (issuer = the stock brand) | — (no provider console exists) |
| Cash agent | ✅ operator-defined, no changes needed | — | — |

**Data note:** removed fields (pix `mode`, voucher `api_key`, samsung
`merchant_id`) — any previously saved values for those keys simply
stop being read/shown; no other data is touched, and nothing needs
re-saving for manual operation. PayPal Auto would additionally need a
Webhook ID **and** a verify client that does not exist — recorded as
an honest gap, not papered over.
**Round-trip proof** (test/credentials-roundtrip.test.js): for all 14
rails, saving the documented field set succeeds, secrets are encrypted
at rest (field_enc = 1, stored ≠ plaintext), secrets are never echoed
on redisplay, and every field shows its mode note.

## 7. AUTO-VISIBILITY-01

Auto deposit: the moment a player submits, the deposit sits in their
own history as pending ("Waiting for payment confirmation") — never
invisible, never pre-credited. On the verified webhook credit, the
SAME entry flips to approved with the exact net, the balance increases
by exactly that net, and the standard deposit notification fires. A
later failure/refund goes through the existing revocation path and
shows truthfully. Auto withdrawal: the hold drops the available
balance at request time; statuses track Pending → Approved → Paid
visibly; reject refunds visibly as its own ledger movement. Player
amounts were asserted EQUAL to admin/ledger amounts for one auto
deposit and one auto withdrawal. One real defect was found and fixed
here: the webhook credit path originally sent no player notification —
it now uses the standard notify path. No status label may claim a
state the DB does not hold (asserted at each step).

## 8. USER-PASS-SET-01 + ADMIN-SELF-01

- **Set new password (admin → any non-admin user):** form on the user
  page next to the reset-link button; same password rules as self-set
  for that role + breached-password screening; sets
  `force_password_reset` per the checkbox (default ON); destroys ALL
  the user's sessions; invalidates unused reset tokens; audit
  `user.password_set_admin` (forced flag only — never the password).
  Admin-role targets stay excluded (404) on the generic handlers.
- **My Account (admin self page):** display name; login email (requires
  current password; valid + unique case-insensitively; verification to
  the new address when email is configured, otherwise completes after
  the password proof and says so plainly); own password (current +
  new + confirm; other sessions killed, current kept). All audit-
  logged without secret material; wrong current password refuses and
  is audit-logged. The page carries the honest free-Render note: a DB
  wipe re-seeds the admin from Render seed env, so panel changes
  revert on wipe unless the seed env is updated or the paid disk is
  in place. Proven end-to-end (test/account-admin.test.js, 4 tests):
  forced set → old password dead → forced-reset screen → clean login;
  unforced set → direct login; email change; duplicate refusal.

## 9. SETTINGS-FIND-01

The wagering gate (`withdrawal_turnover_required`) gained a second
door on the admin Withdrawals page (same single key, hidden-field
carry of the other risk values, super-only editing — the U-26
two-doors pattern), and Settings gained a "Jump to:" anchor index.
Proven: unchecking FROM the Withdrawals door flips the DB setting and
a previously blocked player can immediately submit; re-checking from
Settings blocks again; anchors resolve to card ids in the HTML.

## 10. MESH-ID-01 + AUDIT-DETAIL-01 (owner screenshots, live v20)

- **MESH-ID-01:** public IDs (e.g. `WMVT7JW3Y86FBCF` on Withdrawals)
  stacked one letter per line because prose `.code`
  (overflow-wrap:anywhere) sat inside auto-layout tables. Fix:
  `.tbl .code { white-space: nowrap; … }` (+ a `.dt` nowrap span for
  dates) so tables take natural width and `.tbl-wrap` scrolls as
  designed. Every admin list/detail table rendering public_id / token
  / hash / reference cells was audited; prose `.code` outside tables
  is unchanged (long links still wrap).
- **AUDIT-DETAIL-01:** the Audit Trail Detail cell was raw JSON
  `slice(0,120)` — unreadable AND silently lossy. Now: parsed,
  humanized key–value lines (snake/camel → words; arrays as comma
  lists; booleans Yes/No; settings changes as old → new), a CENTS
  allowlist derived from the actual `audit.log` call sites formats
  money (ground truth from the owner's live rows: ticket.buy
  wager 500 / total 7500 renders **$5.00 / $75.00**), long details in
  a `<details>` "View detail (N fields)" with a raw-JSON toggle —
  lossless by construction (every key renders). Entity refs get the
  MESH nowrap treatment. Proven in test/mesh-audit.test.js (4 tests).

## 11. ADMIN-LOGIN-01 + structure basis

At the owner's explicit order (superseding the 2026-10-27 root-404
rule): GET on the EXACT admin root with no admin session serves a
dedicated admin login — one centered Apple-styled card, gold header
band ("Control Room" / sign-in subline), email + password, Forgot
Password? on the password-label row (→ public /forgot), TOTP step on
the same page when enrolled, generic "Invalid credentials.", per-
account lockout + IP rate limit, audit `admin.login` for every
attempt, session created in the ADMIN scope only. Layout reference:
the RaffleLab demo login page observed 2026-10-29 02:51 CDT (login
page ONLY — inner pages were not entered). Everything else stays
stealth: all other admin paths 404 + `admin.probe`; guessed paths
404; the public site contains zero admin references; public /login
remains a working fallback entrance. Proven: test/admin-login.test.js
(6 tests).

## 12. ADMIN-CLARITY-01

- **Limits & Controls hub** (`/limits`, Money nav group): NEW global
  deposit caps `deposit_daily_cap` / `deposit_monthly_cap` (minor
  units per currency, 0 = unlimited) enforced inside
  `createDeposit` in lib/money.js — per-user per-currency sums over
  pending+approved, UTC day/month windows mirroring the withdrawal
  caps, plain player refusal ("Daily deposit limit of … reached…").
  The hub also carries withdrawal daily/monthly caps, payout lock
  hours, the BP-22 auto-withdrawal limit and the wagering toggle —
  all writing the SAME settings keys as Settings (multiple doors, one
  truth, no duplicate storage), plus read-only pointers to per-method
  min/max, per-user overrides, and player self-limits.
- **Purpose subtitles** under the title of every top-level admin page
  (all 33 sidebar destinations), **Common tasks** card on the
  Dashboard with REAL pending counts, and one-line descriptions in
  the Settings jump index.
- Proven: test/admin-clarity.test.js (4 tests) — cap set on the hub
  refuses an over-cap deposit with NO row created; hub↔Settings value
  coherence both directions; 0 restores the flow.

## 13. USER-DETAIL-01 (+ a regression this round's testing caught)

The user page was rebuilt summary-first: summary band (avatar initial,
name, email·phone, role/status/verified/KYC badges, joined + last
login, per-currency wallet chips) → Account facts → Money snapshot
(wallets + recent deposits/withdrawals/tickets) → Controls grouped
under Access / Password / Money controls → KYC → Fraud flags →
history → the biodata EDIT form LAST. Every pre-existing field,
action and route kept (action-presence asserted).
**Regression found by adversarial re-verification (GALTI-class, fixed):**
the rebuild left `agentOf` referencing `agents` one line before its
declaration — any user WITH an agent_id got a 500 on this page
(ReferenceError, TDZ). Bare-player fixtures passed, which is how it
survived the first pass; the U-24 crawl's agent-assigned user caught
it. Fix: declaration order corrected; the user-detail test fixture
now includes an agent-assigned player permanently.

## 14. CURRENCY-SYSTEM-01

- **Player currency is real:** deposit/withdrawal pages list the
  player's currency methods first (withdrawals keep used-first order
  inside groups); other currencies sit under an "Other currencies"
  heading with the currency named on every method. Foreign amounts
  carry a marked equivalent in the player's currency ("$10.00
  (≈ ₹905.00)"); when his currency differs from base, key totals show
  the USD reference alongside. Equivalents are display-only (admin
  rates, always ≈, never booked); a missing/zero rate shows NO
  equivalent rather than a wrong one. Wallet page shows a converted
  "Total (approx)" line. Play page verified already correct
  (buys in the wallet currency actually used) — no change.
- **Wallet Exchange (real, ledger-posted):** from-wallet → to-wallet
  at the ADMIN-SET rate (the UI calls it exactly that — never "live
  market rate"; no FX feed exists). Quote shown before confirming;
  `exchange_fee_percent` (default 0) deducted transparently; executes
  in ONE transaction — converted amount rounded DOWN so rounding
  never mints value; ledger pair `exchange_out`/`exchange_in` sharing
  one ref, meta snapshots the rates + fee; audit `wallet.exchange`.
  Fail-closed: same currency, unknown/zero rate, insufficient funds
  all refuse with NO balance change. Proven: ₹905.00 → exactly $10.00
  at 90.5; fee 2% → 980 of 1000 credited; refusals leave balances
  untouched (test/currency-system.test.js, 4 tests).
- **Admin currencies:** the JSON-only card became a readable TABLE
  (code, symbol, "1 USD = X" rate, enabled checkbox, base marker) on
  the SAME storage format, raw JSON kept under "Advanced (JSON)".
  Semantics note: the storage has no separate enabled flag — being in
  the saved list IS being enabled, so unticking removes the currency
  from the list (disclosed in the checklist). **Coverage warning** on
  the Currencies card AND Payment Methods: every enabled currency
  with no enabled deposit and/or withdrawal method is named.
- **Cross-currency sums audit (completion):** dashboard KPIs were
  already made per-currency; this pass also fixed the three remaining
  offenders found by the ground-truth map — draw-detail KPIs (sold /
  prize / profit now per currency; winner prizes render in the
  ticket's own currency), agents-list commissions (per currency),
  referrals earnings (per currency). Deposits/withdrawals list strips
  were already per-currency.

## 15. AUTH-CHANNELS-01

TOTP 2FA: owner-verified live 2026-10-29 — no re-proof needed.

**Delivery-truth audit — adjudicated claim by claim against the code**
(the audit list was NOT taken at face value):

| Claim | Verdict | Action |
|---|---|---|
| Phone-verify "missing await, code claimed sent when not sent" | **False alarm as stated** — the handler awaits `sendOtp` and shows an honest error | Residual defect (below) fixed |
| Register OTP email fallback marks unverified codes valid | **False alarm** — registration has no OTP step at all (owner's rule); the quoted text is not in the code | None |
| Withdrawal generic catch swallows OTP failures | **False alarm** — the OTP branch is dedicated and fail-closed | None |
| **Undelivered OTP rows stay live and guessable** (login OTP, withdrawal OTP create + resend, phone-verify) | **REAL** — handlers showed honest errors but never invalidated the created code | **Fixed:** new `expireLiveOtps` (lib/otp.js) called at all four failure branches |
| Profile verify-email token stays live after a failed send | **REAL (low risk, 48-hex token)** | **Fixed:** token burned on non-'sent' |
| Password-reset token stays live after a failed send; result discarded | **REAL (token limb)** | **Fixed:** token burned on non-'sent'. The page itself stays the generic anti-enumeration text BY DESIGN — saying "email is down" only for real accounts would leak which emails are registered; recorded trade-off |
| SMS-OTP sends write no outbox row (lib/otp.js direct fetch) | **REAL (visibility gap)** | Noted: the health card's SMS "last delivery" therefore reflects notification/test sends; OTP delivery truth is enforced at the flow level instead |

**Provider-double E2E** (test/auth-channels.test.js, 8 tests — real
SMTP capture server in-process, TextBelt/Google/Facebook answered by
a fetch stub injected into the app process): email OTP login (code
arrives, verify logs in); withdrawal OTP by email completes a real
withdrawal; reset link delivered with a live token; phone-verify by
SMS incl. the failure leg (honest message + code invalidated);
Google OAuth create-once / reuse / verified-email link (one-account
rule); Facebook create/reuse; SMTP-down leg (503 + code invalidated).
**Admin "Login & verification health" card** (Security page):
per channel — toggle state, CONFIGURED / NOT CONFIGURED from env
PRESENCE only (never values), last outbox delivery result; test-send
buttons (rbac super/support, 5/hour, audit-logged, truthful result
including provider errors). Checklist gained plain-language setup
sections (Gmail App Password route, Twilio vs TextBelt, Google/Facebook
console steps with the exact live redirect URIs).

## 16. MAINT-FORM-01 (owner live report + uploaded evidence)

**Before-evidence:** the owner's downloaded file `currency.json` —
its content is the full maintenance-page HTML. Cause (server.js
maintenance middleware): GET → 503 HTML page, but ANY non-GET → 503
`application/json`; the header currency switcher (and every player
form) is a plain form POST, and browsers download a JSON response to
a top-level form navigation, naming it after the path.
**Fix (response shape ONLY, per the owner's necessity restraint):**
requests whose Accept includes text/html get the rendered maintenance
page for EVERY method; JSON 503 remains only for API/fetch-style
callers. The block did not weaken: the currency preference is NOT
saved during maintenance (asserted), play/buy creates zero tickets
and moves no balance, admin bypass and the allowlist are unchanged,
and with maintenance OFF the same POST works normally again
(302 + saved — regression leg).
**Sweep for the same defect class (evidence-only, per the restraint):**
rate limiters — already negotiated correctly (JSON only for JSON/XHR
callers); CSRF failure — renders an HTML error page; forced-action
gate — 302 redirects; global error handler — renders the HTML error
view. **Checked, none proven** — no other spot changed.
Proven: test/maint-form.test.js (3 tests).

## 17. ADMIN-STRUCTURE-01 (bounded pass; deep map pending)

| Pattern element | Before | After |
|---|---|---|
| Branded admin login | none (public /login only) | dedicated login at the secret root (§11) |
| Dashboard money summary + pending queues | present | reinforced + Common tasks with real counts (§12) |
| List pages: subtitle → strip → filters → table → pagination | strip/filters/table existed; no purpose lines | purpose subtitles on all pages (§12); order already the house pattern |
| Detail pages summary-first | user detail opened form-first | user detail rebuilt (§13); deposit + withdrawal details verified fact-table-first — no change needed |
| Settings hub grouping + jump index | one mega-page, no index | jump index with one-line descriptions (§9, §12); wholesale reorder deferred |
| Trust & Verification nav cluster | KYC/OTP/flags/login-history in separate groups | **NOT regrouped this round** — ADMIN-DEEP-MAP-01 gates regrouping on the exhaustive reference map (access pending); conservative per instruction. Recorded as a noted gap for the next structure round, with the grouping principle fixed: one home per function + doors where the work happens |

## 18. PASTED-SPEC-01 adjudication + leftover sweep

The owner pasted a generic "autonomous principal engineer" spec under
his own filter ("jo zaruri nahi, beshak ignore karna"). Taken: (1) this
leftover sweep, (2) the feature-status matrix above. **Rejected as
non-goals (recorded):** stack migration/rewrite (the pasted stack —
Next.js/Prisma/Postgres — does not describe this Node/EJS/SQLite
codebase; touching it WOULD damage the site), the demo/play-money
default flip (conflicts with the owner's own explicit real-money
decision on live v20 — a pasted template does not override the
principal), admin confirmation popups (conflict with the standing
no-popup rule), the 15-file buyer documentation suite (solo-operated
business; existing docs + checklist suffice).

**Leftover sweep (production code):** TODO/FIXME/HACK — none.
example.com — only historical-fix comments, a data-heal migration,
and one input placeholder attribute; none are content. Math.random —
one hit, the arithmetic CAPTCHA question generator (a puzzle, not an
outcome; OTP codes use crypto.randomInt, outcomes are HMAC/beacon
provably-fair). Demo/fake-success code — none found (the only "demo
mode" mention is a comment documenting its removal from OTP).
**Verdict: zero genuine defects; no code changed under this item.**

## 19. Test evidence

Per-file proofs are cited per section above. Full-suite history this
round, honestly: the mid-round full run finished **310 tests / 304
pass / 3 fail / 3 skipped**. The three failures were (1) the U-24
crawl hitting the §13 TDZ bug — a real code bug, fixed and re-proven;
(2) the U-28 stealth test still asserting the OLD root-404 rule —
updated to the owner's superseding ADMIN-LOGIN-01 spec (subpath
stealth assertions unchanged); (3) the USER-PASS-SET test asserting a
heading string that §13's rebuild had rewritten — updated to assert
the form itself. All three files re-run green standalone after the
fixes, as were every round file individually.
**Final full-suite runs (the gate) — full honest ledger, including a
correction:** run 1 finished **314 / 310 pass / 1 fail / 3 skipped** —
U-21's qr_pay fixture, which predated §6's new required `payee_id`
field (the required-field error now correctly precedes the URL-format
error the fixture was exercising); the fixture was updated to supply
`payee_id` so the https validation is what gets tested (the required
rule itself is covered by credentials-roundtrip), and the file
re-passed 11/11. Run 2 finished **314 / 310 pass / 1 fail / 3
skipped** — BP-26 http (test/tamper.test.js), in its SETUP step, not
in any tamper assertion: the winner hunt bought Gold Rush tickets in a
40-try loop, but the buy route is rate-limited to 10 buys/min/user
(routes/scratch.js:161), so only ~10 buys executed, and that boot's
crypto-shuffled deck (26 winners / 74 zeros) held no winner in the
first ~10 outcomes. (Pure chance over a full 40 buys is ruled out —
P ≈ 1 in 10 million; the limiter is the mechanism, and it is a sane
product control, NOT a defect.) The fixture was repaired, product
assertions untouched: the hunt now uses a dedicated fixture series
(5 prizes / 5 zeros in 10 tickets) that guarantees a winner within 6
buys, inside the limiter budget; tamper.test.js then passed 3/3 three
times standalone. **Correction on the record:** an interim version of
this log claimed the gate green after run 2 — that claim rested on a
misread process poll (the shell wrapper's exit code, not the test
result) and was WRONG; it is withdrawn. The definitive run 3, read
from its own log file, finished **314 tests / 311 pass / 0 fail / 3
skipped** — that is the gate number for this round.
The 3 skips are the Postgres-only tests (no Postgres in the sandbox)
— a standing test gap, not failures.

## 20. Honest open items

1. **Not deployed.** This zip is v21-candidate; live still runs v20.
   Deploy only on the owner's separate haan (free-tier DB will wipe
   again unless the paid upgrade lands first).
2. **Postgres smoke test** remains unrun (no PG in sandbox).
3. **PayPal Auto** and **Skrill Auto** need provider verify clients
   that do not exist in code; both rails are honestly Manual-only
   (PayPal) / webhook-generic (e-wallet) today — §6.
4. **ADMIN-DEEP-MAP-01:** nav regrouping (incl. the Trust &
   Verification cluster) waits for the exhaustive reference map;
   access is the blocker (owner to re-send a session-carrying link).
5. **Settings mega-page order** was not re-sorted wholesale (deep-map
   pending); the jump index + second doors mitigate.
6. **BP-22 auto-approval is not gated on per-method mode** (§4) — a
   deliberate, disclosed precedence choice; revisit if the owner
   wants the selector to be the single control.
7. **Currencies "enabled" = presence in the stored list** (§14) —
   disclosed in the checklist; a separate enabled flag would need a
   storage-format change.
8. Owner-side items unchanged: Render paid upgrade, zintola.com
   purchase, real (Live) provider credentials per the checklist,
   temp admin password change.
