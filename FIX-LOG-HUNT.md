# FIX-LOG — TEAM HUNT ROUND (v23 candidate)

Round: 2026-10-29 → 2026-10-30. Scope: build + test + zip only (no push, no
deploy — deploy awaits the owner's separate haan). Live v22+hotfix untouched.
Method: five hunter domains + OTP workstream, every finding cross-examined by
a non-author, every fix regression-tested, full-suite gate read from the test
runner's own ℹ summary lines (never a wrapper exit code).

Baseline before this round: 338 tests / 335 pass / 0 fail / 3 skipped
(Postgres-only).
Final gate: 362 tests / 359 pass / 0 fail / 0 cancelled / 3 skipped (Postgres-only), runner exit 0 — read from the runner's ℹ lines in the final gate log.

---

## 1. VERDICT LEDGER (the split, with evidence)

### FALSE ALARM — killed with disk/test evidence
- H3-05 — captcha `secret_key` IS envelope-encrypted at rest (lib/credentials).
- H3-08 — no `document_number` column exists anywhere in the KYC schema.
- H1-13 — player-side deleted-ticket state is already a plain not-found; the
  agent-side text is internal and truthful.
- H1-18 — the flash already reads "Email verified. You can now deposit and
  withdraw."
- H1-19 — deposit/withdrawal refusal texts are already neutral + actionable.
- H5-11 — the legacy support@example.com heal is complete (migrations REPLACE
  chain); no other example addresses exist in seeds.
- XA3-NEW-1 — Facebook login with an unverified email is ALREADY refused a
  merge by the U-22 identity resolution (the examiner read stale lines).
- OUT-01 / OUT-02 — no monthly-winners feature or cron publish exists;
  homepage winners are first-name-only from real transactions.
- OUT-04 — both FX exchange routes already try/catch to a flash.
- OUT-H01 — no KYC threshold settings exist; KYC is an enabled+gate model.
- OUT-H05 — `encodeUserData` serves BOTH createDeposit and createWithdrawal.
- OUT-N3 — login/register OAuth buttons are already gated (toggle && env).
- OUT-B1 — the currencies table and JSON forms are two doors into ONE
  validation path; the JSON form is labelled "saving here replaces the table".
- OUT-B2 — POST /settings/risk already validated the payout lock 24–72.
- OUT-B3 — `payout_lock_hours` seed '48' equals the engine default '48'.
- OUT-N1 — the GA /cdn-cgi 404 is a Cloudflare live artifact, not codebase.
- Walkthrough P-1 — "/play is a logged-out dead end": /play is login-gated;
  a logged-out GET returns 302 → /login (proven by booting the build). The
  cited "buyBlock" mechanism exists nowhere in routes/views.
- Walkthrough P-2 (register half) — during maintenance, /register returns
  the 503 maintenance page and a register POST creates NO user (proven by
  booting the build with maintenance_mode=1).
- Walkthrough seed claims — `support_notify_email` seeds as '' (migrations);
  the "Your agent application was declined" string exists nowhere in the
  codebase; "No winners yet" appears only as the homepage zero-wins empty
  state; password validator messages are plain sentences (lib/util).

### DOUBLE-COUNT — one defect, two labels
- H3-06 ≡ OTP-D4 (admin self email-change on delivery failure) — one fix.
- H5-03 subsumed by H4-02 (withdrawal-OTP warning banners).
- OTP-D2 is the umbrella over H4-10(b) (channel health told the truth in one
  place, lied by omission in others) — one resolver fix.
- H4-20 ∩ OTP-D5 share the email_verification / mobile_verification rows —
  counted once, resolved by migration v28.

### REAL-BUT-SMALL / REAL-BUT-SMALLER — fixed or dispositioned
- H3-01 — anonymous-session scope transplant: no privilege was obtainable,
  but the scope check now covers anonymous sessions too (lib/auth).
- H3-03 — login-as sessions cut from 7 days to 30 minutes + a server-level
  block on money POSTs under impersonation (audit-logged). Residual
  lib-internal audit stamping: see REAL-AND-PENDING.
- H3-04 — TOTP secrets were stored plaintext; now envelope-encrypted on
  write (legacy plaintext rows still verify). The new regression test also
  caught verifyTotp THROWING on a corrupt stored secret (a 500 path) —
  now fails closed.
- XA3-NEW-2 — TOTP attempt counting: the login path is already capped
  (10 fails / 15 min via login_history); enrolment confirms sit behind
  password + rate limiters. Mitigations documented; no extra code.
- H4-12 — KYC override / auto-withdrawal limit discoverability: the fields
  exist in the user edit form; the Controls card now states the player's
  current values and points to the form.
- OUT-B — admin date filters passed NaN to queries on impossible dates
  (SQLite tolerated it, Postgres would error): guards added.
- OUT-03 — push 'queued' is a transient batch state; send() fails honestly
  and the channel-health Push row discloses NOT INTEGRATED. No change.
- OUT-05 — auto streak nudge is seeded OFF; whether it should exist at all
  is the owner's product call (see pending).
- Settings census — `language` setting: seeded, never read by any code,
  UI already removed in an earlier round. Vestigial: seed removed, row
  deleted by migration v28.
- U-24 crawl flagged the Settings page for a "stack trace": a false
  positive on the ordinary phrase "at all (policy block…" in the new
  blocked_rails help text. Help reworded so the guard's signal stays clean.

### REAL — confirmed and FIXED this round (details in §2–§5)
Money: H2-01 (FX decimal-scale mint), H2-02 (duplicate payment proof),
H2-03 (webhook refund could not reach manually-approved deposits),
H2-04 (PayPal/Skrill decimal conversion), H2-05 (global caps meant
different amounts per currency), H2-06 (deposit bonuses invisible to the
wagering gate), H2-07 + H1-01 (approval claim race).
Security: H3-01, H3-02 (emailed links built from the request Host),
H3-03, H3-04, H3-07 (webhook timestamp tolerance), H3-09 (HSTS),
H3-10 (signup codes weakly hashed), H5-06 (FORCE_SSL ignored by the
session-cookie writer), H5-09 (error handler flattened deliberate 4xx).
Surfaces: H1-03 … H1-21 (labels, dead ends, leaks of operator language),
H5-10, H5-12, H5-13 (countdown rendered as "-d --:--:--" placeholder).
Admin: H4-01 … H4-24 (dead switches wired or removed, Limits hub
completed, queue counts made true, findability doors), H5-01 (method
enable gate — see the gate-fallout note: the gate initially covered only
the toggle; the full gate caught create/edit bypassing it, and all three
doors now share one check), H5-02 (Launch readiness card), H5-07.
OTP workstream: OTP-D1, D2, D3, D6, D7, D8 + the panel-configurable
delivery build (§2).

### REAL-AND-PENDING — not forced, with reasons
- H4-06 — daily/monthly cap windows run on server time (UTC) while draw
  dates follow site_timezone. The Settings help now states the truth.
  Rewriting the windows is a money-semantics change that needs the
  owner's timezone intent, not a midnight patch.
- OUT-06 — partial refunds: the webhook vocabulary has no partial-refund
  token; adding one naively would FULL-revoke on a partial refund
  (worse). Current record-only behaviour is fail-safe. A partial-amount
  reversal is a design task.
- H3-03 residual — stamping the impersonator inside every lib-level
  audit call (beyond the money-POST block now in place) is a structural
  change to the audit API.
- OUT-05 — the seeded-OFF streak nudge: keep, surface, or delete is a
  product decision for the owner.
- SG-1 — playslip double-submit buys two tickets (see §6): duplicate
  slips are a legitimate lottery purchase and player-side confirm
  behaviour is the owner's reserved decision (2026-10-28).
- OUT-A1/A3/A4 — LOW outsider code-reading claims whose substance could
  not be recovered from the round notes; the areas (scratch purchase,
  play-page draw inclusion) were covered behaviourally by the test
  suites instead. Logged unverified-in-round rather than padded into
  a verdict.

---

## 2. OTP DELIVERY WORKSTREAM (owner order 2026-10-29 21:27 CDT)

### Per-flow diagnosis (proven against the code as shipped in v22)
| Flow | Carrier | Fresh-boot behaviour (nothing configured) | Verdict |
|---|---|---|---|
| Login OTP (email) | SMTP | Toggle OFF by default; if enabled, send failed honestly | OK by default |
| Login OTP (phone) | Twilio/TextBelt | Toggle OFF by default; same honest failure | OK by default |
| Withdrawal OTP | email (or phone) | Toggle ON by default + NO channel = every withdrawal refused at the code step. Money could NOT be trapped (the hold is created only after verification — proven again first-hand this round: wallet untouched, zero withdrawal rows), but the withdrawal FUNCTION was 100% dead with no panel warning and nowhere in the panel to configure a channel | REAL — fixed operator-side |
| Email verification | SMTP link | Link undeliverable; account unverifiable → verified_contact_required gate also blocks | REAL — same root |
| Phone verification | SMS | Undeliverable; attempts were not even logged (OTP-D1) | REAL — fixed |
| Password reset | SMTP link | Token minted, delivery failed, page showed the generic text; token stayed live pre-fix | REAL — token now burns on failure |
| TOTP | none (control) | Works — which is why the owner saw 2FA work while "no OTP arrives" | Control case, as diagnosed |

The Oct-2026 claim "the otp_login template slug was never seeded, so email
OTP could never send" is KILLED: the template IS seeded in current code.
The true root cause was simpler and worse: no provider configured AND no
panel surface to configure one (SMTP/SMS were env-only), plus withdrawal
OTP defaulting ON against that empty configuration.

### What was built
- `global_credentials` table (migration v27) + encrypted panel storage for
  SMTP and SMS credentials (AES-GCM via the existing credentials machinery;
  write-only in the UI, blank = keep, saves refused without the encryption
  key, audit log records FIELD NAMES ONLY).
- lib/delivery.js resolver: panel value > env value > none, per field; the
  SMS provider falls back to whichever channel is actually configured.
- Admin → Security → "Delivery (SMTP & SMS)" section + test-send buttons
  that exercise the panel-configured values; channel health, the dashboard
  and the Notifications → Providers page all read the same resolver (one
  truth).
- Withdrawal-OTP warning banner on Settings and Withdrawals whenever
  withdrawal OTP is ON but its channel is not configured (operator-only).
- Every OTP attempt logged with the code masked; OTP wording matches its
  purpose (login / withdrawal / verify templates seeded).
- Tests: provider-double E2E for panel email OTP + SMS OTP + withdrawal
  OTP, unconfigured-boot behaviour per flow, panel-over-env precedence,
  envelope hygiene (test/delivery-otp*.test.js, 11 tests).

### One-time owner inputs that remain (panel only — never chat)
1. Email: a Gmail App Password (2-Step Verification → App Passwords) with
   smtp.gmail.com:587 in Admin → Security → Delivery — a normal Gmail
   password will NOT work — or any SMTP relay's host/user/pass (e.g.
   Brevo/Resend SMTP values; the code speaks SMTP, not their HTTP APIs).
2. SMS: a Twilio account (SID + Auth Token + a number) or a TextBelt key,
   same panel section.
3. BASE_URL must be set on Render (emailed links are built from it and
   are not sent at all while it is unset — deliberate fail-closed).


---

## 3. THE DEBATE — fights that changed outcomes (the "kyun" on both sides)

The protocol: no undefended verdicts. Every "flaw" had to survive a
defender; every "no flaw" had to survive a skeptic. The fights that
actually MOVED the result:

1. **H1-02 vs D4-C3 (fairness page and TEST draws).** Hunter: test draws
   must not appear on the public verifier at all. Defender: a settled test
   draw shown WITH its TEST badge is a deliberate v20 design (the badge
   markup exists in verify.ejs; results listings already exclude test
   draws), and hiding it 404s the operator's own test-draw checks.
   VERDICT: defender wins — H1-02 REVERSED. The true invariant (an
   UNSETTLED draw's seed never renders) is now the pinned test.
2. **H2-02 vs the PayPal B4 contract (duplicate proofs).** The new
   creation-time duplicate-proof refusal broke the pre-existing,
   deliberate AUTO-rail contract: on auto rails a deposit is created
   pending and the provider-side consumed-capture guard refuses credit.
   VERDICT: both stand, scoped — creation refusal for non-AUTO methods
   (where the player's proof is the only evidence), provider guards for
   AUTO, and the approve-time duplicate check inside decideDeposit covers
   every mode as the last line.
3. **H1-06 vs the U-15/U-16 tests (referral section).** Hunter: the
   profile promises referral earnings while referral_enabled defaults
   OFF — a lie. The v20 tests pin the absolute referral URL + Copy
   button on the profile. VERDICT: both honoured — the section always
   renders the player's link; the earnings PROMISE and earnings summary
   render only when the program is ON, replaced by an explicit
   "the referral rewards program is currently off" line when OFF.
4. **Password reset honesty vs anti-enumeration.** Skeptic: with delivery
   unconfigured, the forgot-password page's "sent" state claims a success
   that never happened. Defender: the wording is conditional ("IF that
   email is registered, a reset link is on its way… or contact support if
   nothing arrives") — the industry-standard anti-enumeration response;
   distinguishing states would leak which emails hold accounts, and the
   internal state IS honest (the undelivered token is burned, the failure
   logged, delivery health visible to the operator). VERDICT: defended,
   no change.
5. **Register/Login structure on trial (owner's settled spec).**
   Challenger: OTP-first / phone-first like 1win-class apps; fewer form
   fields. Defender: OTP-first would hard-block registration on any
   deployment whose delivery is unconfigured — the OTP catalogue (§2)
   proved delivery ships unconfigured, so that structure moves the
   withdrawal trap to the front door; the full form + password-first
   matches real-lottery convention and the owner's explicit decision.
   Every defect actually found in the flow was wording/dead-end class
   (login Terms/Privacy were plain text — now links; "cash out fast" —
   corrected) and is fixed. VERDICT: structure stands; NO structural
   proposal is put to the owner, because the debate did not converge on
   one — friction fixes only.
6. **The player walkthrough sweep vs the coordinator.** The sweep
   reported a HIGH-severity logged-out /play dead end and four smaller
   items. The coordinator's disproof boots killed the HIGH finding and
   most small ones (see the ledger) — and the sweep still earned its
   keep: its maintenance claim, mostly wrong, contained one real defect
   (the maintenance allowlist exempted '/forgot' but the route is
   '/forgot-password', so the documented exemption never fired — fixed).
   VERDICT: the sweep's confirmed-good list is accepted (no credential
   display anywhere, no logged-out balances, OAuth buttons correctly
   hidden, honest contact form); its unreproduced claims are logged
   FALSE ALARM with the boot evidence, not silently dropped.
7. **H5-01's blast radius (the gate vs this round's own fix).** The
   enable-gate was built on the toggle door only. The full gate proved
   the create and edit doors wrote `enabled` straight from the form —
   the same forbidden state through two other doors. VERDICT: the fix
   was incomplete, not wrong; all three doors now share one fail-closed
   check (manualEnableBlock), proven end-to-end (create held OFF →
   details saved → toggle enables). Recorded as the round's process
   lesson: every fix is a suspect until the full suite passes.
8. **H4-23 vs the U-26 nav invariant (duplicate sidebar door).** The
   hunt added Automation to the Settings & System sidebar group as a
   second door (findability). The U-26 suite enforces a tested design
   invariant — every destination belongs to exactly ONE group — and
   the gate enforced it. VERDICT: the invariant wins; the duplicate
   entry is reverted. Automation's home stays Games, and the second
   door is the Cron Jobs page's cross-link, which already existed.
   Findability is served; the structure stays unambiguous.

## 4. CONNECTION AUDIT

| Connection | Wired? | Configured by | Proven? | Silent-failure risk |
|---|---|---|---|---|
| 13 manual rails (bank, UPI, Pix, crypto, wallets…) | Yes — one generic engine | Panel: receiving details per method | Yes — test/manual-payments runs all 14 rails end-to-end (14th is PayPal manual) | A method enabled without details was possible pre-round; now blocked at all three enable doors + the deposit POST itself |
| PayPal Auto | Yes — verify-on-submit + webhook | Panel: client id/secret/webhook id | Code-proof via local provider double (auto-integration B1–B7); NOT live-proof — needs the owner's real pair + a real capture | Provider down → deposit stays pending, no fake success (B5) |
| Skrill Auto | Yes — signed status reports | Panel: merchant id + secret word | Code-proof via double (B8–B10); not live-proof | Forged report → 401, no credit (B9) |
| Generic signed webhooks (crypto processors etc.) | Yes — HMAC + timestamp tolerance | Panel per method | Yes — B4a/B4b incl. replay dedupe | Webhook never arrives → deposit stays pending; admin sees it in the queue (nothing auto-credits) |
| Mobile Money Auto | Generic-HMAC contract ONLY | Panel: api key + webhook secret | Contract-level only | ⚠️ Daraja/MTN NATIVE protocols (OAuth2 + provider callbacks) are NOT built — the checklist now says so plainly; M-Pesa must run Manual until they are |
| SMTP email | Yes | Panel (v23) or env fallback | Code-proof via SMTP capture double (delivery-otp A1/A4/B1) | Unconfigured → sends fail honestly, OTP tokens burn, operator warned on dashboard/Settings/Withdrawals |
| SMS (Twilio) | Yes | Panel (v23) or env | Code-proof via HTTP double | Same honest-failure path |
| SMS (TextBelt) | Yes | Panel (v23) or env | Code-proof via double (A3) | Same |
| Google / Facebook OAuth | Yes | Env only (documented design) | Toggle+env gating verified; no live app credentials exist yet | Buttons hide when unconfigured — no dead promises on the login page |
| Incoming webhooks (all) | Yes | Per-rail secrets in panel | Signature + replay tests | A provider retry storm is deduped by event id; unverifiable deliveries get 401 |
| Render service + disk + DB | n/a (hosting) | Owner's Render account | Live v22 probes (parent) | ⚠️ Free plan: sleeps + SQLite wipes on deploy — the Monday paid step (Starter + disk + SQLITE_PATH) is the fix; credentials entered before it will be lost |
| Domain / DNS (zintola.com) | Not yet | Owner at Namecheap + Render | — | Not purchased yet; BASE_URL must change when it lands |
| TOTP 2FA | Yes — no external connection (control) | Per-user enrolment | Owner-verified live on v20; envelope storage added this round | A corrupt stored secret now fails closed instead of 500ing |
| Push notifications | NOT INTEGRATED — disclosed as such in channel health | — | — | The UI says NOT INTEGRATED rather than pretending (OUT-03) |
| drand beacon (draw pinning) | Yes, optional | Env DRAND_API | beacon_required defaults OFF | Beacon down → draws settle without it (documented); no silent stall |

## 5. SETTINGS LEDGER (census 0→100)

Method: all 72 seeded settings keys extracted from DEFAULT_SETTINGS; every
key traced to its read sites; money-critical flips proven by tests, not
inspection. Full per-key table is mechanical and lives in the round notes;
the outcomes that matter:

- **Dead switches found: one.** `language` — seeded, read by nothing, UI
  already removed in an earlier round. Seed removed; row deleted by
  migration v28. (The v28 migration also deletes the four orphans found
  earlier in the round: kyc_required, email_verification,
  mobile_verification, auto_approve_deposit_limit.)
- **Dynamic-key settings** (draw_trigger_mode_*, draw_threshold_*,
  draw_unmet_* for DAY/EVE) are wired via constructed keys in lib/draws.js
  — a static grep calls them dead; they are not.
- **auto_draw_eve** was read with a default-true at every site; it is in
  fact seeded on the same line as auto_draw_day — inventory complete.
- **Defaults debated and KEPT**: withdrawal_otp_enabled=1 (safe for real
  money — the defect was the missing warning/config surface, not the
  default), verified_contact_required=1, withdrawal_turnover_required=1,
  deposit_bonus_percent=0, blocked_rails='ebt', scratch smart-pool and
  guardrail OFF, maker_checker_threshold=0 and admin_totp_required=0
  (single-owner operation; the checklist recommends TOTP enrolment),
  beacon_required=0.
- **Missing controls**: none survived challenge — draw timing, caps,
  fees, thresholds, provider credentials and modes are all panel-owned
  after this round (delivery credentials were the last env-only holdout).

---

## 6. SELF-GENERATED QUESTIONS (raised by the team, not the owner)

1. **SG-1 — "A player double-taps Buy on a slow network: charged twice?"**
   Yes — two tickets, two exact debits; there is no idempotency key on
   the playslip POST and no submit-disable on the button. Debate: an
   accidental duplicate is a real harm, BUT duplicate slips are also a
   legitimate lottery purchase (same numbers twice = double win), state
   stays perfectly consistent (money == tickets), and player-side
   confirm behaviour is the owner's reserved decision. VERDICT:
   REAL-BUT-SMALL, no in-round change; put to the owner as a question.
2. **SG-2 — "DST: a draw time that doesn't exist on spring-forward day?"**
   Draw times are wall-clock in site_timezone, resolved via Intl per
   run; a nonexistent wall time resolves to a shifted instant, the draw
   still creates and settles, close_at ordering is preserved, and no
   money path depends on the wall label. VERDICT: reasoned no-action.
3. **SG-3 — "Two players buy the last scratch outcome at the same
   instant?"** buyTicket re-checks series status and sale end INSIDE the
   purchase transaction and claims the outcome with a changes===0 guard
   (lib/scratch.js) — the loser gets an honest "just claimed" error and
   no debit. VERDICT: defended, no flaw.
4. **SG-4 — "A webhook arrives twice, or before the deposit exists?"**
   Proven by tests (auto-integration B4b/B6/B10): replays dedupe,
   balances do not move twice, early reports apply on submit.
   VERDICT: defended by test evidence.
5. **SG-5 — "Is every admin switch real?"** Became the settings census
   (§5): 72 keys, one vestigial (removed), the rest wired.
6. **SG-6 — "What if a stored TOTP secret is corrupt?"** Found BY the
   new H3-04 regression test: verification THREW (a 500 path). Fixed —
   corrupt secrets now fail closed. VERDICT: real defect, fixed.
7. **SG-7 — "Are this round's own fixes the next round's bugs?"** Proven
   twice by the gate (H4-04's absent-field refusal; H5-01's two bypass
   doors). VERDICT: process rule adopted — no fix is believed until the
   FULL suite passes with it in.

## 7. DESIGN DEBATE (Apple rules + attractiveness ratchet + ease count)

Mechanical Apple checks (CSS-level, verifiable): player buttons and
global inputs are 48px with a press state (scale 0.97); admin
checkboxes render as true iOS switches (51×31); admin tabs and task
links are 48px; labels are persistent (never placeholder-only).

Found and fixed in-round (each names its rule):
- Form fields inside `.field` were held at **44px** by a
  higher-specificity rule — the owner's Apple rule is 48px touch
  targets. Now 48px (public/style.css).
- The login page's method switcher (`.segmented`, a PRIMARY control)
  was **40px**. Now 48px.
- Admin filter inputs were **40px** — the owner works queues from a
  phone at night. Now 44px (the Apple floor for dense data UIs).
Debated no-action: audit-log disclosure summaries at 32px — dense
data text disclosures, pointer-first; inflating them degrades every
audit row. Recorded as a debated exception.

Ratchet outcome: after the touch-target pass, the debaters' remaining
attractiveness items were structural (theme, page structures) — the
settled light/cream + gold theme and settled structures are NOT up for
silent redesign under the round's guardrails, and no structural design
proposal is put forward: the rendered sweep found no meshing,
overflow, or hierarchy defect on the pages it covered (its layout
claims that could be checked, checked out clean).

Ease counts (core jobs, current build): buy a ticket = pick pops +
1 submit; buy a scratch card = 2 taps from the lobby; deposit =
method → amount + proof → submit; withdraw = method → amount → code →
submit; admin clear-a-deposit = dashboard Common tasks (live count) →
pending list → detail → Approve (3 clicks); find-and-flip a setting =
Settings jump index → anchor → save. No job exceeded its obvious
minimum by more than the security step it carries (withdrawal OTP).

## 8. OWNER-WALKTHROUGH RECORD (acceptance pass)

Required honest line: **yes — the rendered/gate passes found things the
code hunts had missed.** Specifically: the maintenance allowlist's
'/forgot' vs '/forgot-password' mismatch (found by the walkthrough,
fixed), and the method create/edit doors bypassing the enable gate
(found by the full gate executing the owner's own flow, fixed). The
walkthrough also produced five claims that did NOT survive verification
— they are in the ledger as FALSE ALARM with the boot evidence, which
is the debate protocol working as intended, not a failure of the pass.

Per-area rendered coverage: every player page rendered and read in
logged-out and logged-in states by the sweep (26 page verdicts);
every admin page is rendered and asserted free of raw output by the
U-24 crawl in the test suite (anon/player/agent/admin roles), plus the
user-detail and settings suites; the money click-paths (deposit →
approve → duplicate-proof refusal; withdrawal under no delivery;
password reset under no delivery) were walked FIRST-HAND by the
coordinator after the click-path agent's report arrived unusable
(it returned its own brief) — P5/P6 verdicts in §3.6/§3.4 stand on
those boots, and the unconfigured-withdrawal result is: **wallet
untouched, zero rows created, truthful message shown**.

Admin sweep caveat, stated plainly: the dedicated admin walkthrough
agent went quiet without delivering a report. Admin coverage therefore
rests on the test-suite crawls and the H4 batch, not on a second pair
of human-style eyes. That is a process gap in this round, recorded
here rather than papered over.

## 9. GATE FALLOUT (why the gate runs last, twice)

Gate 1 (interrupted by session compaction) showed 4 failures; Gate 2
ran to completion at 382/371/6/3/2 and every failure was adjudicated:
two fixture-vs-guard collisions (fixtures repaired honestly — real
receiving details saved through the encrypted path, never the guard
weakened), one stale test contract (migration version v26→v28), one
probe collision with new help text (text reworded), two genuine
collisions between this round's fixes and earlier deliberate designs
(H1-02 reversed; referral section rebuilt to satisfy both), and one
REAL incompleteness in this round's own H5-01 (create/edit doors —
fixed, §3.7). A fixture encryption-key literal mangled by tooling
(62/32-char) was replaced with a constructed value in two files.

The third full run (the definitive gate's first attempt) failed 12 —
ALL in test/v20-u26.test.js, none in product behaviour: (a) the
fixture's bank credentials were silently refused because its SWIFT
value 'U26BANKX' is not a valid BIC — pre-round, the credential-less
toggle hid the fixture's own bad data; the H5-01 gate exposed it.
Fixture corrected to a valid BIC. (b) The frozen route inventory
gained exactly one deliberate v23 route, POST /security/delivery
(the OTP workstream) — inventory amended with the reason recorded.
(c) The sidebar count (33 → 34) was the H4-23 duplication — resolved
per §3.8 by reverting the duplicate, not by editing the invariant.
After those: v20-u26 is 12/12.

Final gate: 362 tests / 359 pass / 0 fail / 0 cancelled / 3 skipped (Postgres-only), runner exit 0 — read from the runner's ℹ lines in the final gate log.
Clean-unzip fresh-boot smoke: PASSED on a clean unzip of the shipped zip (virgin DB): /healthz 200, home 200 with the real seeded Gold Rush product and zero admin-path strings, branded admin login 200 at the secret root, stealth probes (admin subpaths, /admin, guessed prefix) all plain 404, /play logged-out 302 → /login, /register 200.

## 10. SOLID ANSWER — per area, then overall

- **Player UI / surfaces:** GREEN. No credential value renders to a
  player anywhere the team could reach; no operator language survives
  on player pages; balances never show logged-out; the four flaw
  classes the owner caught live were swept as classes, not instances.
  Kyun: rendered sweep + leak tests + U-24 crawl, all green.
- **Money:** GREEN. The two critical defects (FX 100× mint on
  zero-decimal currencies; duplicate-proof double-funding) are fixed
  with engine tests; caps mean the same typed amount in every currency;
  deposit bonuses are wagering-visible; approval races are claim-first.
  Kyun: hunt-money (6) + manual-payments (13) + auto-integration (15)
  + the money cores in the v20 suites, all green. Pending items
  (partial refunds, TZ cap windows) trap nothing and misprice nothing.
- **Auth + OTP + connections:** GREEN with one honest asterisk. Every
  OTP flow now either delivers through a configured channel or fails
  honestly with the operator warned; delivery credentials are
  panel-configurable and encrypted; sessions are scope-safe; emailed
  links can no longer be Host-forged. The asterisk: PayPal/Skrill auto
  flows are proven against provider DOUBLES, not live money — that
  proof is impossible without the owner's real credentials (§2).
- **Admin:** GREEN. Every control the player side enforces is findable
  and wired (census: 72/72, one vestigial removed); queues carry true
  counts; the dashboard shows launch readiness from real state; the
  enable-gate now covers create, edit and toggle. Caveat recorded in
  §8: no independent human-style admin sweep report landed this round.
- **Live-readiness:** GREEN for code; the remaining risks are not code
  (below).

**Unanimity (the owner's stop condition):** reached in every area
EXCEPT the recorded holdouts, which stay REAL-AND-PENDING by design —
H4-06 (TZ cap windows), OUT-06 (partial refunds), the H3-03 audit
residual, OUT-05 (streak product call), SG-1 (double-submit — the
owner's own reserved call). No dissent was voted down or exhausted
into silence; each is listed with its reason.

**Overall: is this perfect for live? NO — and here is exactly what
"no" consists of.** No known code defect remains that traps money,
leaks a secret, lies to a player, or lets an admin enable a broken
payment method. What remains is: (1) five disclosed REAL-AND-PENDING
items above — none of them money-trapping, each with its safest
interim state already in place; (2) EXTERNAL blockers that are not
code flaws at all:
- Render paid step (Starter + persistent disk + SQLITE_PATH) — the
  Monday sitting; until then the free plan sleeps and deploys wipe
  the database, so NO credentials should be re-entered before it.
- The owner's real provider credentials (PayPal pair, SMTP/App
  Password, Twilio/TextBelt) entered in the admin panel only.
- The Postgres smoke gap (3 skipped tests): needs a live Postgres
  that does not exist in the sandbox — a test gap, not a code bug.
- RaffleLab deep map: still awaiting owner-provided demo access.
- zintola.com: locked, not yet purchased; BASE_URL changes when it
  lands.

Subject to those, the code in this zip is the v23 candidate: deploy
it only on the owner's haan, and only in the Monday order (paid plan
+ disk + SQLITE_PATH FIRST, then credentials, then test accounts).
