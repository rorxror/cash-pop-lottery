# Disprove Round — Area F (Public site + post-login + info leaks)

Adversarial re-check of every F-sourced DS item against the **pre-fix baseline**
at `~/workspace/cash-pop-push/` (production v17.1, read-only). Method: read the
COMPILED.md entry, then hunt the baseline code for a mechanism that makes it a
false alarm (a sanitiser, an alias/mapping, a settings key actually read, a
route that actually serves the asset, etc.). Live checks were run on a throwaway
boot of the baseline (port 3356, `SQLITE_PATH=/tmp/disprove-f.sqlite`, seeded
admin `admin@cashpop.live`); server killed and throwaway DB deleted afterwards.

**Exact F set confirmed from COMPILED.md:** DS-013 (F-01), DS-014 (B-05/F-02,
merged — F half checked here), DS-035…DS-043 (F-03…F-11), DS-072…DS-080
(F-12…F-20). That is 20 items. (The task brief listed only 9 of them; the other
11 are the "missed" F items and are covered below.)

**Tally: SURVIVES 20 · DISPROVEN 0.** Two items carry mitigating nuances
(DS-043, DS-078) and two carry precondition nuances (DS-040, DS-080) — none of
the nuances kills the finding.

---

## DS-013 (F-01) — Policy reasons leak operator switches to players — **SURVIVES**
Disproof attempt: look for a neutral-wording mapping between `depositPolicy`/
`withdrawalPolicy` and the error page.
Counter-evidence search failed: `lib/money.js:78-79` returns `'Deposits are
currently disabled.'` / `'Deposits are disabled for your account.'` and
`:85-86` the withdrawal equivalents, and `routes/player.js:223,235,267,292,376`
render `policy.reason` **verbatim** (`res.render('error', { message:
policy.reason })`). No remapping, no audit-log-only path anywhere. The
verify-contact reason at `lib/money.js:80,87` is likewise passed through.

## DS-014 (B-05/F-02) — "Min $NaN · Max $NaN" / wallet "No limits" — **SURVIVES**
Disproof attempt: look for a route-side alias `min_amount → min` before render.
None exists. `routes/player.js` GET /deposit/new does `SELECT * FROM
payment_methods` and renders `method: { ...method, custom_fields: … }` — the
spread adds only `custom_fields`, no `min`/`max`. Schema is
`min_amount`/`max_amount` (`lib/migrations.js:179`). Views read the wrong keys:
`views/deposit_new.ejs:24,26` and `views/withdraw_new.ejs:25,27` use
`method.min`/`method.max` (→ `fmt(undefined)` = `$NaN`, empty `min="" max=""`
attributes); `views/wallet.ejs:24,38` test `m.min == null && m.max == null`
while the wallet route (`routes/player.js`, GET /wallet) selects
`min_amount, max_amount` — so both are always null in the view and every method
prints "No limits". Server-side enforcement at `routes/player.js:242,299` uses
`min_amount` correctly, confirming display-only — as the finding states.

## DS-035 (F-03) — Maintenance page announces operator/admin-panel sign-in — **SURVIVES**
`views/maintenance.ejs:6`: *"If you are an operator, sign in to access the
admin panel."* (link to `/login`). Disproof attempt: is the line admin-only /
is maintenance gated so players never see it? No — `server.js` maintenance
middleware renders it for every non-admin GET. **Live-proven** on the baseline
boot: set `maintenance_mode=1` in the throwaway DB → logged-out GET / returned
503 with the operator sentence verbatim; restored to 200 after unset.

## DS-036 (F-04) — "The operator has not enabled any deposit method yet" — **SURVIVES**
Verbatim at `views/deposit_new.ejs:38` and as the default branch of
`views/withdraw_new.ejs:39`. Disproof attempt: does a route always supply a
neutral `noMethodsReason`? Only one case does — `routes/player.js:277`
(withdrawals restricted to previously-deposited methods). The plain
no-methods-enabled case falls through to the operator wording on both pages.
The neutral wallet wording the finding contrasts with also exists
(`views/wallet.ejs`: "No deposit methods available."), confirming the
inconsistency rather than refuting it.

## DS-037 (F-05) — OAuth 503 pages reveal missing provider credentials — **SURVIVES**
`routes/auth.js:636`: *"Google sign-in is not configured yet. The operator
needs to add the Google OAuth credentials."*; `:570`: *"Facebook sign-in is
not configured yet."* **Live-proven**: GET /auth/google and /auth/facebook on
the baseline boot both returned those sentences verbatim. Nuance (does not
kill): the Facebook sentence is shorter — it reveals "not configured" state
but does not name credentials/operator; the Google sentence carries the full
leak the title describes.

## DS-038 (F-06) — Verify-contact flash reveals "(no email provider configured)" + staff manual-attest — **SURVIVES**
`routes/player.js:454`: *"Could not send the verification email (no email
provider configured). Ask support to mark your contact verified."* — fired on
any non-`'sent'` notify status, with the provider wording hard-coded rather
than derived from the actual failure. Same manual-attest wording inside the
policy reasons at `lib/money.js:80,87`, rendered verbatim (see DS-013). No
neutral fallback exists in either place.

## DS-039 (F-07) — Seeded Privacy Policy serves placeholder/operator text — **SURVIVES**
`lib/migrations.js:93` PAGES seed: `'<p>We protect your data. This is a
placeholder — the operator should publish a full privacy policy.</p>'`,
inserted as `status='published'` and served by `routes/site.js` GET
/page/:slug via `views/cms.ejs`. Disproof attempt: does the R-010/R-102 heal
map clean this seed? No — the heal map at `lib/migrations.js` (~:852-866)
covers only `content_blocks` keys (`home_banner`, `testimonials`,
`footer_about`, `footer_contact`); the PAGES loop inserts the placeholder
unchanged and never heals it. **Live-proven**: GET /page/privacy on a fresh
baseline DB returned the placeholder sentence verbatim.

## DS-040 (F-08) — OTP sign-in verify enumerates staff/blocked/pending/2FA status — **SURVIVES**
`routes/auth.js:500-503`, four distinct 403 messages: staff ("Staff accounts
cannot sign in with a code…"), banned ("This account has been blocked…"),
pending_review ("Your account is pending review."), TOTP-enrolled ("This
account has two-factor authentication enabled…"). No generic-error collapse
on this path (contrast the password path's generic handling). Precondition
nuance (stated in the original finding, does not kill): the branch is reached
only **after** `verifyOtp` succeeds (`routes/auth.js`, top of
POST /login/otp/verify; `lib/otp.js` `verifyOtp`), i.e. the caller must
possess a valid code for that identifier — it is enumeration by a code
holder / SIM-swap / observed-code attacker, not by an unauthenticated prober.

## DS-041 (F-09) — Homepage Paid-out JS counter hard-codes "$" — **SURVIVES**
`public/app.js:109` (count-up `fmt`) and `:138` (30 s refresh `tweenNum`):
`'$' + (v / 100).toLocaleString(...)` — literal `$` in both formatters.
Disproof attempt: does JS read a currency symbol from the DOM/server? No
symbol is passed; the elements carry only `data-count`/`data-money`. The
server side is correct (`routes/site.js` GET / renders
`stats.paid_out_fmt` via `req.fmt`, and `server.js` sets `req.fmt` from the
display/base currency with seeded EUR € / INR ₹ in `lib/migrations.js`
currencies) — which is exactly the mismatch the finding describes: correct
server text is overwritten by the hard-coded-$ JS on every load.
(COMPILED cited :141 for the second site; baseline has it at :138 — same code.)

## DS-042 (F-10) — Homepage recent-winners query omits t.currency — **SURVIVES**
`routes/site.js:51` (GET /): `SELECT t.amount, t.created_at, u.name FROM
transactions t …` — no `t.currency`. `views/index.ejs:78` (ticker) and `:151`
(winners grid) format with `fmt(w.amount, w.currency || 'USD')`, so every
non-USD win falls back to USD. Disproof attempt: is currency joined/defaulted
elsewhere? No. The contrast the finding cites is real: the /api/stats handler
in the same file *does* select `t.currency` and maps
`amount_fmt: req.fmt(w.amount, w.currency)` — the SSR path does not.
(COMPILED cited routes/site.js:56-58; baseline query is at :51 — same query.)

## DS-043 (F-11) — Hard-coded "Instant Payouts" / "Secure & Licensed" claims — **SURVIVES (with one sub-claim nuance)**
Verbatim and hard-coded in the template: `views/index.ejs:25` hero "instant
payouts", `:68` "Instant Payouts / Winnings credited at once", `:69` "Secure
& Licensed / Your funds protected". **Live-proven** on the baseline homepage.
No licence/licence-status setting or verification exists anywhere in code
(grep of `lib/migrations.js`, `lib/settings.js`, views — nothing backs
"Licensed"), and no CMS block controls these strings, so the operator cannot
correct them. Nuance (weakens one limb, does not kill): win *crediting* to
the wallet is in fact instant at settlement (cf. seeded FAQ/how-it-works
blocks, `lib/migrations.js:79,85`), so "Winnings credited at once" is
defensible in isolation; but withdrawals — what a reader understands by
"payouts" — default to manual review (`withdrawal_mode: 'manual'`,
`lib/migrations.js:53`; player told "It will be processed after review",
`routes/player.js:351,394`), and "Secure & Licensed" is wholly unsupported.
Finding stands.

## DS-072 (F-12) — Auth toggle announcements — **SURVIVES**
Verbatim JSON errors: `routes/auth.js:439` "Phone login is disabled.", `:441`
"Email login is disabled." (both in POST /login/otp/request, gated on
`phone_otp_enabled`/`email_otp_enabled`), `:484` "Registration is disabled."
(in POST /login/otp/verify when creating a new account). No neutral
"unavailable" wording is substituted anywhere on these paths.

## DS-073 (F-13) — Scratch lobby empty state: "operator has not launched a series" — **SURVIVES**
`views/scratch_lobby.ejs:7`: *"The operator has not launched an active series
yet."* Reachability note (does not kill): a fresh boot seeds a default live
"Gold Rush" series, so the empty state appears only once no series is
live/enabled — but the wording is the only empty state the template has and
is shown to every visitor in that state.

## DS-074 (F-14) — Profile/referral wording reveals operator settings — **SURVIVES**
Verbatim: `views/profile.ejs:30` "…required before depositing or withdrawing
(operator setting). If you cannot receive a code, contact support — staff can
attest your contact manually." and `:46` "…you earn referral commission (when
enabled by the operator)". No alternative neutral copy exists in the template;
both strings render unconditionally for logged-in players (the referral block
renders regardless of `referral_enabled`).

## DS-075 (F-15) — TEST draws publicly labelled/listed on results + homepage — **SURVIVES**
Homepage: `routes/site.js` GET / `recentResults` query is
`SELECT * FROM draws WHERE status = 'settled' ORDER BY close_at DESC LIMIT
10` — no `is_test` / `draw_type` filter; `views/index.ejs:126` prints the row
with a TEST badge. Results: `routes/site.js` GET /results defaults to all
settled draws and even accepts `?type=TEST` as a public filter;
`views/results.ejs:11,26` labels them and explains they are "operator test
draws … excluded from payouts". Disproof attempt: is there a public-side
exclusion of `is_test=1` draws (created only via `lib/draws.js:75`, the
admin/test path)? None in either query. Internal test artefacts are listed
and labelled on public surfaces exactly as claimed.

## DS-076 (F-16) — Scratch reveal passes raw e.message to players — **SURVIVES**
Player reveal route `routes/scratch.js:98-107`: `catch (e) { res.status(400)
.render('error', { message: e.message }) }` — unsanitised. The internal
string it can surface is real: `lib/scratch.js:285` throws `'Outcome
commitment mismatch — reveal refused. Contact support.'` from
`revealTicket`. The telling contrast is in the same file: the buy route
(`routes/scratch.js` POST /scratch/:id/buy, ~:124-127) *was* given the
R-117 generic treatment ("Scratch purchase failed. Please try again." +
server-side log) — the reveal route was not.

## DS-077 (F-17) — Nav .active highlighting dead (S('currentPath')) — **SURVIVES**
`views/layout.ejs:34-38`: every nav link tests `S('currentPath')`.
`server.js:220`: `S: (k, fb='') => req.settings[k] !== undefined ?
req.settings[k] : fb` — i.e. `S()` reads the **settings table**, and no
setting named `currentPath` exists (grep of `lib/migrations.js` /
`lib/settings.js`: none; it is never written). So `S('currentPath')` is
always `''` (and `String('').startsWith('/scratch')` is false) — no link can
ever get `active`. The correct value *is* supplied as a separate local,
`currentPath: req.path` (`server.js:235`), but the layout never uses it.
**Live-proven**: baseline GET / rendered `<a href="/" class="">Home` and
GET /results rendered `<a href="/results" class="">Results` — empty class on
the current page in both cases.

## DS-078 (F-18) — `<div id="fb-root">` rendered inside `<head>` — **SURVIVES (gated)**
`views/layout.ejs:20-22`: inside `<head>`, before `</head>`:
`<% if (extOn('fb_comments')) { %><div id="fb-root"></div><script … facebook
sdk …></script><% } %>`. No other fb-root exists anywhere. Gating nuance
(does not kill): it renders only when the `fb_comments` extension is enabled
— live check on the default baseline boot found 0 occurrences of `fb-root`
in the homepage HTML. When the extension is on, the served source places a
`<div>` inside `<head>` exactly as claimed; the defect is conditional, not
absent.

## DS-079 (F-19) — /favicon.ico returns the HTML 404 page — **SURVIVES**
No favicon asset or route exists: `public/` contains only `app.js` and
`style.css`; no `<link rel="icon">` anywhere in views; grep for `favicon`
finds only the two gate-bypass exemptions in `server.js:342,390` (which let
the path *through* maintenance/profile gates — to the 404 handler, not to a
file); `express.static` (`server.js:161`) has nothing to serve; the final
handler `server.js:436` renders the HTML error page for everything
unmatched. **Live-proven**: GET /favicon.ico → `404`, `Content-Type:
text/html`, full HTML error page (4,475 bytes).

## DS-080 (F-20) — Viewport zoom-lock — **SURVIVES as a factual record (not a defect)**
`views/layout.ejs:5`: `<meta name="viewport" content="width=device-width,
initial-scale=1, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">`
— confirmed in the live-served homepage HTML. As the DS entry itself states,
this is **by explicit user demand** (the 2026-10-27 zoom-lock instruction in
MEMORY.md) and is recorded for accessibility awareness only, with no change
requested. It cannot be "disproven" — the string is there — but it should not
be counted as a bug against the codebase.

---

### Method notes / limits
- Live boot used `NODE_PATH` pointing at an existing node_modules tree; the
  baseline directory itself was not modified (throwaway DB in /tmp, deleted).
- DS-013/DS-014/DS-076 were verified by complete code-path reading (policy →
  render, query → view, throw → catch) rather than full click-through; in
  each case the path is a single verbatim pass-through with no intervening
  transform, which is the exact mechanism the findings allege.
