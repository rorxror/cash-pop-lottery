# U-27 WORKER — ADJUDICATION (v20 owner-fix round): register copy/layout + internal-language sweep

Worker files: `views/register.ejs`, `public/style.css` (register-scoped,
documented rules only), `lib/admin-ui.js` (swept — no hits, no edits),
any other UNOWNED view with a sweep hit (`views/index.ejs`,
`views/scratch_lobby.ejs`), `test/v20-u27.test.js` (new).
B-owned / finished files were swept READ-ONLY; their hits are logged
below as PENDING-APPLICATION with exact after-text for the coordinator.
LEDGER.md not touched.

Method: phrase greps over `views/**`, `lib/admin-ui.js`, `public/app.js`,
`routes/*.js`, `lib/migrations.js` (seeded customer copy), `server.js`
(forced, configur*, enabl* explanations, "admin" on player surfaces,
backend/frontend/server-side, placeholder, demo, sample, TODO, FIXME,
internal finding codes R-/BP-/DS-) + a full read of every view's visible
text + a rendered crawl on a fresh boot (port 4141, fresh SQLite) in
anonymous / player / admin roles before fixing.

The class (per brief): (a) internal RULE explanations stated to the
wrong audience; (b) build/developer vocabulary on customer surfaces;
(c) config-state language leaking operator state to customers.
Audience rule applied throughout: text explaining a setting TO THE
OPERATOR is legitimate; developer jargon / raw keys / internal project
codes as visible labels are hits on ANY surface.

---

## ITEM 1 — U-27.1: the register phone helper (OWNER'S COMPLAINT)

**VERDICT: CONFIRMED.** `views/register.ejs:39`:
`Choose your country code, then your number — no country is pre-forced.`
"Pre-forced" states an internal build rule (the dial-code dropdown must
not pre-select a country) as customer copy. The customer neither needs
it nor can parse it. U-24-class defect on the live register page.

**FIX CHOICE: REMOVE the helper line entirely.** Reason: the field
already carries a label ("Phone"), a select whose closed text reads
"Select country code", and an input placeholder "Phone number". The
only non-internal clause the line could keep ("Select your country code
and enter your phone number") would repeat the label + both control
texts word-for-word and add zero information. Removal is the cleaner
fix; no internal rule is stated as UI copy anywhere in the replacement
(there is none). Field names/values/conditionals untouched.

## ITEM 3 — U-27.2: country-select clipping at 360px

**VERDICT: CONFIRMED by construction.** `.phone-row` is a flex row;
the shared rules (`style.css` ~1626) give the select `flex: 0 0 190px`,
shrunk to `flex-basis: 140px` at ≤520px. At a 360px viewport the form
card's inner width is ~264px (360 − 2×16 gutter − 2×32 card padding):
a 140px select must show "Select country code" (~150px of text at 15px
+ padding + native chevron) — the closed text clips exactly as the
owner photographed ("Select country ("). The chosen state
"United States (+1)" (~130px text + padding + chevron ≈ 170px) clips
worse. A basis/min-width split alone cannot fix 360px honestly: giving
the select the ~176px it needs leaves the number input ~80px, which
clips its own placeholder and typed context.

**FIX (register-scoped, `#registerForm`):** deliberate split above
400px (select `flex: 0 0 176px; min-width: 176px` — fits
"United States (+1)" fully; input `flex: 1 1 auto; min-width: 0` takes
the rest, ≥200px at ≥481px viewport) and STACKING at ≤400px
(`flex-direction: column`, both controls `width: 100%`) so at 360px
the select is the full ~264px inner width — every country's
"Name (+dial)" fits with the dial code visible, no ellipsis anywhere.
Proof is at the CSS-rule level (headless Chromium here blocks
localhost; no pixel screenshots claimed).

## ITEM 4 — U-27.3: agreement line garbled wrap

**VERDICT: CONFIRMED by construction.** `views/register.ejs:57-59`
(pre-fix): the `<label>` is `display:flex`
(`.form-card .field.check label`), and its children are the checkbox,
bare text nodes and two `<a>` elements. In a flex container each bare
text run and each link becomes its OWN flex item, so the sentence lays
out as separate columns/items instead of flowing prose — the owner's
garbled two-column look. The sentence also lacks the owner's final
period.

**FIX:** wrap all prose + links in ONE `<span class="agree-text">`
(single flex item → wraps as normal prose, links inline in reading
order), checkbox stays the first flex item with
`align-items: flex-start` so it aligns to the FIRST line. Rendered
text with links stripped reads exactly the owner's sentence:
"I confirm I am 18 or older and I agree to the Terms and Privacy Policy."
(links on "Terms" → /page/terms and "Privacy Policy" → /page/privacy).
48px touch target preserved: register-scoped rule gives the label
`min-height: 48px` (the label IS the checkbox's tap target — clicking
anywhere on it toggles); the checkbox keeps its existing 20px box,
2px first-line offset and the global checkbox min-height guard is not
regressed. The block still renders ONLY under the identical
`S('policy_agreement')==='1'` conditional (default '1' in settings).

---

## ITEM 2 — THE SWEEP: APPLIED HITS (my files)

### U-27.4 — homepage "Secure Platform" card: server/hashing jargon
- File: `views/index.ejs` (feature cards). Audience: all visitors.
- Before: "Passwords are stored hashed and sessions are kept on the
  server — balances and results are decided on the server, never in
  your browser."
- After: "Your password is protected, your sign-in stays secure, and
  your balance and results are held on our secure servers — never in
  your browser, so they can't be changed there."
- Class (b): the defect is the dev-register STACK — "stored hashed",
  "sessions are kept on", "decided on" read as a system-design note.
  The bare word "servers" is NOT charged: it is ordinary customer
  vocabulary, and the claim it carries (results are held server-side,
  never in the browser — the owner's BP-26 tamper-proofing point) is
  the card's backed trust claim, which U-09 deliberately states and
  its regression test asserts (`v20-home.test.js` matches /server/ on
  this card). The after-text keeps that one plain claim and the other
  backed facts (scrypt-hashed passwords, server-side sessions) in
  plain words, and drops the mechanism register. (First-pass
  after-text removed "server" entirely and broke the U-09 test;
  reconciled to this wording — claim kept, register fixed.)

### U-27.5 — "Reveal is visual only" (×2)
- Files: `views/index.ejs` (scratch section intro),
  `views/scratch_lobby.ejs` (page header). Audience: all visitors.
- Before: "…every outcome is locked before you scratch. Reveal is
  visual only."
- After: "…every outcome is locked before you scratch. Scratching
  only reveals it — it never changes it."
- Class (b): "visual only" is internal mechanic register (it describes
  the client/render split). The after-text says the same true thing —
  scratching cannot change the outcome — in words a player uses.

### Swept-clean in my editable scope
- `lib/admin-ui.js` — SWEPT CLEAN: the only visible string is
  "No records."; builders emit no copy of their own. No edits.
- `views/register.ejs` beyond U-27.1/.3 — clean ("Signup code /
  Enter the signup code you received." is plain and audience-correct).
- All other unowned views read in full (announcements, cms,
  complete_profile, contact, deposit_new, error, force_reset, kyc,
  layout, maintenance, play, profile, results, scratch_responsible,
  scratch_ticket, scratch_tickets, scratch_verify, setup, support,
  support_view, ticket, tickets, transactions, withdraw_new,
  withdraw_verify, agent/*): no further hits — see NOT-HITS below for
  the borderline calls.

---

## ITEM 2 — PENDING-APPLICATION HITS (owned / off-limits files)

Exact after-text supplied for each; coordinator applies/routes when
D-FIX-B lands.

### U-27.6 — ticket-buy error confesses server config to the player
- File: `routes/player.js:265` (B-owned). Audience: player, at buy.
- Before: `Ticket purchases are temporarily unavailable because ticket
  signing is not configured. Please contact support.`
- After: `Ticket purchases are temporarily unavailable. Please contact support.`
- Class (c): "ticket signing is not configured" confesses an internal
  credential/config state (TICKET_HMAC_SECRET) the player cannot act
  on. The truthful state ("temporarily unavailable") is retained.

### U-27.7 — Terms page seed carries an operator instruction (STRONG)
- File: `lib/migrations.js:121` (B-owned), PAGES seed for slug
  `terms`, status published — served verbatim at `/page/terms` and
  linked from the register agreement line.
- Before (first paragraph of the seeded body):
  `<p><strong>Template notice:</strong> the operator must replace this
  page with terms reviewed for their own licence and jurisdiction
  before offering real-money play.</p>`
- After: delete that paragraph entirely; the body starts at
  `<h4>Eligibility</h4>`. (For existing DBs, apply the same
  marker-guarded heal pattern DS-039 used for privacy, marker
  "Template notice" — the seed fix alone only reaches fresh DBs.)
- Class (b/c): a build/launch instruction addressed to the operator,
  published on a customer legal page. Proven live on the fresh boot:
  rendered `/page/terms` contains "Template notice".

### U-27.8 — raw setting key as visible admin copy
- File: `routes/admin.js:3289` (B-owned), admin Security page.
  Audience: admin — but a raw key is not a label on any surface.
- Before: `TOTP is REQUIRED for admins on this site
  (admin_totp_required is ON).` / `TOTP enforcement is OFF
  (admin_totp_required). Enroll first, then an admin can enable
  enforcement in Settings → Toggles.`
- After (enforced): `TOTP is REQUIRED for admins on this site.`
  After (off): `TOTP is not required for admins yet. Enroll first,
  then turn on "Admin TOTP required" in Settings → Toggles.`
- Same defect, `routes/admin.js:3340` flash — Before: `Cannot disable:
  admin TOTP is required on this site. Turn off admin_totp_required
  in Settings first.` After: `Cannot disable: two-factor
  authentication is required for admins on this site. Turn off
  "Admin TOTP required" in Settings first.`
  (The Settings toggle's human label already exists — TOGGLES list,
  "Admin TOTP required" — so the after-text names a real label.)

### U-27.9 — internal project codes (BP-21/22/23, R-044) in admin copy (SYSTEMATIC)
One defect, many sites: blueprint/finding codes from the build process
used as visible suffixes/labels in the operator UI. The operator has
no key for them; they are this project's internal numbering. Fix is
mechanical — strip the code, keep the words. All B-owned.
- `routes/admin.js:289` table header `Exposure (BP-23)` → `Exposure`
- `routes/admin.js:536` heading `Smart Prize & Profit Engine (BP-23)`
  → `Smart Prize & Profit Engine`
- `routes/admin.js:582` card `Exposure alerts (BP-23)` → `Exposure alerts`
- `routes/admin.js:647` flash `Invalid BP-23 value: …` →
  `Invalid prize-engine value: …`
- `routes/admin.js:882` label `KYC requirement for this user (BP-21)`
  → `KYC requirement for this user`
- `routes/admin.js:883` label `Auto-withdrawal limit (BP-22)` →
  `Auto-withdrawal limit`
- `routes/admin.js:929` card `KYC documents (BP-21)` → `KYC documents`
- `routes/admin.js:2756` help `…so it was removed (R-044).` →
  `…so it was removed.`
- `routes/admin.js:2767` button `Simulate first (BP-23 — no save)` →
  `Simulate first (no save)`
- `routes/admin.js:2774` help `BP-22 operator pre-authorization: …` →
  `Operator pre-authorization: …`
- `routes/admin.js:2777` card `KYC — identity verification (BP-21)` →
  `KYC — identity verification`
- `routes/admin.js:2989` card `Multiplier simulator (BP-23) — nothing
  was saved` → `Multiplier simulator — nothing was saved`
- `routes/scratch.js:274` card `Prize Pool Planner (BP-23)` →
  `Prize Pool Planner`
- `routes/scratch.js:473` flash `Launch refused by the BP-23
  guardrail: …` → `Launch refused by the prize guardrail: …`
(Proven rendered: the fresh-boot admin crawl shows "(BP-23)" on the
Automation page and "(BP-21)" on Settings.)

### U-27.10 — Push card tells the operator to edit a source file (LOW)
- File: `routes/admin.js:2333` (B-owned), Notifications → Providers.
- Before: `not configured — plug an FCM/APNs provider into
  lib/notify.js.`
- After: `not configured — push notifications are not set up yet.`
- Class (b): a developer task (edit source) presented as the operator
  instruction in operator UI. (The neighbouring SMTP/Twilio env-var
  lines are NOT hits — see NOT-HITS: env vars are operator-settable
  controls; a source-file edit is not.)

### U-27.11 — scratch fairness steps written in build register
- File: `views/scratch_detail.ejs` (B-owned), "How fairness works".
- Before: (1) "Your ticket receives an unused pre-shuffled outcome at
  purchase." (2) "The outcome commitment is saved on the ticket
  before reveal." (4) "After reveal, use Verify to recompute the
  commitment."
- After: (1) "Your card's prize is decided when you buy it, before
  you scratch." (2) "That result is locked to your ticket before you
  scratch." (4) "After you reveal it, you can check the result
  yourself on the Verify page." (Step 3 — "Scratching never changes
  the prize; it only reveals it." — is already plain; keep.)
- Class (b): "pre-shuffled", "commitment … recompute" are build/crypto
  register on a general customer page. The artifact LABELS on the
  dedicated verify surfaces stay (see NOT-HITS) — only these
  explanatory sentences change.

### U-27.12 — POST /register says "disabled", the app's own voice says "closed"
- File: `routes/auth.js:379` (off-limits, finished domain).
- Before: `Registration is currently disabled.`
- After: `Registration is currently closed.`
- Evidence: the same condition at GET /register (`routes/auth.js:329`)
  and the OTP path (`routes/auth.js:612`) already render "Registration
  is currently closed." — "disabled" is the toggle-vocabulary outlier
  (class c, mild) and inconsistent with the app's own customer voice.

---

## ADJUDICATED NOT-HITS (false-positive discipline)

- **HTML/EJS/code comments** — `views/login.ejs:9`
  (`<!-- Social (only when admin enabled + configured) -->`),
  `public/app.js:477`, EJS comments in `index.ejs` mentioning
  "placeholder": comments are not visible copy. (The login comment
  ships in page source but is never displayed; class is VISIBLE copy.)
- **`placeholder=` attributes** ("Phone number", "000000",
  "you@example.com…") — grep hits are the attribute NAME; the values
  are plain customer text. The word "placeholder" never renders.
- **Fairness artifact vocabulary** — "seed hash", "SHA-256", "drand
  beacon", "nonce", "commitment" as LABELS on `views/verify.ejs`,
  `views/scratch_verify.ejs`, `views/scratch_ticket.ejs`
  ("Pre-reveal commitment"), draw cards ("Seed hash:"): these name the
  actual artifacts a verifier must compare; plain-ing them away would
  break independent verification, which is the page's whole job.
  Sentence-level explanations written in build register WERE charged
  (U-27.5, U-27.11) — the line is artifacts vs prose.
- **"Securely signed and locked to the next draws"** (homepage step 3
  + seeded how_it_works) — reads as a plain assurance ("sealed"),
  names no system, confesses no mechanism. Borderline; left.
- **Truthful empty states** — "No payment methods are available right
  now. Please check back later or contact support." (deposit_new),
  "No deposit/withdrawal methods available." (wallet), "No scratch
  cards are on sale right now…" (scratch lobby), maintenance page
  ("under scheduled maintenance"): the brief's explicitly-FINE class —
  true state, no toggle/config confession, an action offered.
- **The customer's own state** — `views/security.ejs:51` "Two-factor
  authentication is not enabled yet. Enable it to protect your
  funds." (the user enables their OWN 2FA — audience-correct
  instruction, not operator state) and flash "Two-factor
  authentication disabled." (`routes/player.js:960`, a past-tense
  result of the user's own action).
- **Privacy Policy "We do not sell your personal data."**
  (`lib/migrations.js:122`) — a policy commitment inside the one
  document whose job is stating policy TO customers; class (a) targets
  build rules on functional surfaces, not a privacy policy's register.
- **Operator-audience technical explanations** — "Caps enforced
  server-side…" (`routes/admin.js:2784`), "rejected server-side"
  (:2783), "Credentials are stored server-side…" (:1799), the
  Currencies "Seeded rates are PLACEHOLDERS…" warning (:2789), and
  env-var names an operator must actually set (SMTP_HOST… :2331-32,
  ADMIN_PATH note :2744): the audience IS the operator and the terms
  name real operator controls. Legitimate per the audience rule.
- **Bonus label "Audience N (for first_n / random_n)"**
  (`routes/admin.js:718`) — raw ENUM values in a label: that is
  U-24's scope; referred there, not double-counted as U-27.
- **Setup surface** — `views/setup.ejs`, `routes/setup.js` "Setup is
  disabled.": operator-only first-run tooling, never a customer flow.
- **Agent views** — "Ask the operator to fund your float", the
  soft-delete explainer: staff audience; the operator is the agent's
  counterparty. (The PLAYER support view carries no such line —
  verified by full read.)
- **TEST badges** on test draws (index/results) — an honest label in
  plain English; whether test draws should be publicly visible at all
  is a product/trust question, not a language one.
- `lib/admin-ui.js` "No records." and the settings TOGGLES labels
  ("Registration open", "Admin TOTP required", …) — human labels with
  operator help text; exactly what admin copy should look like.

## RENDERED CRAWL (pre-fix evidence, fresh boot 4141)
- Anonymous: `/`, `/login`, `/register`, `/results`, `/contact`,
  `/page/terms`, `/scratch` — "pre-forced" on /register; "decided on
  the server" + "visual only" on /; "Template notice" on /page/terms.
- Player (registered on the boot): `/`, `/scratch`, `/wallet`,
  `/profile`, `/security` — same homepage/scratch hits; wallet /
  profile / security clean per NOT-HITS above.
- Admin (seeded): Automation + Settings pages render "(BP-23)" /
  "(BP-21)" (U-27.9); Security page renders the raw key (U-27.8).
Post-fix crawl + counts are in the worker's final report; the
committed regression test (`test/v20-u27.test.js`) covers the register
page + the five main public pages.
