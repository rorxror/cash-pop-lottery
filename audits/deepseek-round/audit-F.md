# Audit F — Public site + post-login experience + Information Leaks

Scope: layout logged-out vs logged-in, mobile fit, info leaks (operator-internal
strings/states shown to players), homepage no-balance / no-fake-stats rule.
Method: full grep of routes/site.js, routes/player.js, routes/auth.js,
routes/scratch.js (player router), lib/money.js policy strings, all views/*.ejs,
public/style.css + public/app.js; PLUS live boot on port 3316 (fresh SQLite DB,
seeded admin, registered test player `player@test.local`) and logged-out vs
logged-in HTML diffs + live toggling of settings in the test DB to trigger the
actual user-facing messages. Cross-checked against audits/COMPILED-LIST.md and
FIX-LOG.md — R-010 (seeded false claims in content blocks) and R-027 (generic
password-login errors) are FIXED in current code and are NOT re-reported; the
OTP-path enumeration in F-08 is a different code path that still leaks.
Stealth-admin 404 verified live and treated as by-design (not a finding).

Severity counts: Critical 0 · High 2 · Medium 8 · Low 11 · WORKS-checked 6
Classification counts: LEAK 13 · CODE-BUG 5 · DESIGN 3 · WORKS 6

---

## HIGH

### F-01 [High · LEAK] Deposit/withdrawal policy reasons announce the operator's global and per-user on/off switches — the user's exact complaint, live-verified
- Evidence: `lib/money.js:78` `'Deposits are currently disabled.'` (global `deposits_enabled` off), `:79` `'Deposits are disabled for your account.'` (per-user `deposit_blocked`), `:85` `'Withdrawals are currently disabled.'`, `:86` `'Withdrawals are disabled for your account.'`. Rendered verbatim as the 403 error page by `routes/player.js:223,235` (deposit GET/POST), `:267,292` (withdraw GET/POST), `:376` (withdraw OTP-verify re-check).
- Live repro (test DB): set `deposits_enabled=0` → GET /deposit/new shows "Deposits are currently disabled."; set `deposit_blocked=1`/`withdrawal_blocked=1` on the player → "Deposits are disabled for your account." / "Withdrawals are disabled for your account."
- Impact: every player learns the operator's control-matrix state (global toggle exists and is off; a silent per-user block exists and was applied to them). This is precisely the "user gets to know internal things, like that the operator has switched this off" complaint. Fix direction: neutral player wording ("Deposits are unavailable right now. Please try again later or contact support.") with the true reason kept in the audit log only.

### F-02 [High · CODE-BUG] Deposit/Withdraw pages render "Min $NaN · Max $NaN" and Wallet always claims "No limits" — views read `method.min`/`method.max`, DB columns are `min_amount`/`max_amount`
- Evidence: `views/deposit_new.ejs:24,26` and `views/withdraw_new.ejs:25,27` use `method.min` / `method.max`; schema `lib/migrations.js:179` is `min_amount`/`max_amount`; routes pass raw rows (`routes/player.js:238,283` SELECT *; wallet route `:202-203` selects `min_amount, max_amount` but `views/wallet.ejs` method lists also test `m.min == null && m.max == null`).
- Live repro: enabled the seeded "Cryptocurrency" method with min_amount=500, max_amount=10000 in the test DB → Wallet Deposit AND Withdraw cards both display "No limits"; /deposit/new renders `<input ... min="" max="">` and the literal text "Min $NaN · Max $NaN".
- Impact: post-login money pages look broken (the user's "layout broken after login" report), configured limits are invisible to players, and the HTML min/max constraints are empty. Server-side limit checks (`routes/player.js:242-243,299-300`, using `min_amount`) still work, so this is display-only — but it is on the two most sensitive pages.

---

## MEDIUM

### F-03 [Medium · LEAK] Maintenance page advertises the operator/admin-panel sign-in — breaks the stealth-admin rule
- Evidence: `views/maintenance.ejs:6` — `"If you are an operator, sign in to access the admin panel."` (link to /login).
- Live repro: set `maintenance_mode=1` → logged-out AND logged-in visitors both see "…operator, sign in to access the admin panel."
- Impact: the standing stealth rule is that nobody unauthorised should learn an admin area exists; the maintenance page (the one page every visitor sees during maintenance) announces it and points at the entry flow.

### F-04 [Medium · LEAK] "No payment method" pages state the operator has enabled nothing
- Evidence: `views/deposit_new.ejs:38` — `"No payment methods are available right now. The operator has not enabled any deposit method yet — please check back later or contact support."`; `views/withdraw_new.ejs:39` — same sentence for withdrawals (default when `noMethodsReason` unset, set at `routes/player.js:271`).
- Impact: reveals the operator's method-enable state / that the site launched with zero rails configured. Neutral wording ("No payment methods are available right now…") already exists on the Wallet page (`views/wallet.ejs`) and is inconsistent with these pages.

### F-05 [Medium · LEAK] OAuth error pages reveal missing provider credentials/configuration
- Evidence: `routes/auth.js:636` — `"Google sign-in is not configured yet. The operator needs to add the Google OAuth credentials."` (503 error page); `routes/auth.js:570` — `"Facebook sign-in is not configured yet."`
- Live repro: GET /auth/google → 503 with the Google sentence verbatim; GET /auth/facebook → 503 with the Facebook sentence.
- Impact: discloses internal integration state (which providers are wired, that credentials are missing).

### F-06 [Medium · LEAK] Verify-contact flow tells the player no email provider is configured and that staff can manually mark them verified
- Evidence: `routes/player.js:454` flash — `"Could not send the verification email (no email provider configured). Ask support to mark your contact verified."`; same manual-attest wording inside the policy reasons `lib/money.js:80,87` — `"Verify your email or phone before depositing. Use Profile → Verify contact, or ask support to mark your contact verified."` (live-shown on /deposit/new and /withdraw/new for unverified players).
- Live repro: unverified player → POST /profile/verify-email → profile flash shows "(no email provider configured)…" verbatim.
- Impact: reveals provider configuration state and an internal staff attestation capability players can then socially pressure support into using.

### F-07 [Medium · LEAK] Seeded Privacy Policy page publicly serves placeholder/operator-instruction text
- Evidence: `lib/migrations.js:93` page seed body — `"<p>We protect your data. This is a placeholder — the operator should publish a full privacy policy.</p>"`, served at /page/privacy via `routes/site.js:70` + `views/cms.ejs`. (The R-010 heal map at `lib/migrations.js:852-855` heals content_blocks only, not this PAGES seed.)
- Live repro: GET /page/privacy on a fresh DB → "placeholder — the operator should publish a full privacy policy."
- Impact: logged-out visitors see unfinished internal scaffolding text on a legal page; also a trust/compliance problem in its own right.

### F-08 [Medium · LEAK] OTP sign-in path still enumerates account role, status and 2FA enrolment (password path was fixed per R-027 — this path was not)
- Evidence: `routes/auth.js:500` — `"Staff accounts cannot sign in with a code. Use your password."` (confirms the probed email/phone belongs to a staff account); `:501` — `"This account has been blocked. Contact support."`; `:502` — `"Your account is pending review."`; `:503` — `"This account has two-factor authentication enabled. Please sign in with your password."` (confirms 2FA enrolment). All returned from POST /login/otp/verify after a valid code for that identifier.
- Impact: an attacker who can receive/observe a code flow (or SIM-swap/social path) learns whether an identifier is staff, banned, pending, or 2FA-protected — targeting information, and inconsistent with the generic "Invalid credentials." now used on the password path.

### F-09 [Medium · CODE-BUG] Homepage "Paid out" counter is re-rendered by JS with a hard-coded "$", overriding the server's correct currency
- Evidence: `public/app.js:109` and `:141` — `'$' + (v / 100).toLocaleString(...)` in the count-up and the 30s refresh tween; server renders the correct symbol via `req.fmt` (`routes/site.js:62`, `stats.paid_out_fmt`). Initial server text is replaced by the count-up on every load.
- Impact: on any non-USD base/display currency the public paid-out figure is mis-labelled as dollars — a wrong money figure on the homepage. (Figures themselves are real DB totals — see WORKS W-02.)

### F-10 [Medium · CODE-BUG] Homepage recent-winners amounts are formatted as USD regardless of the win's currency
- Evidence: `routes/site.js:56-58` homepage query selects `t.amount, t.created_at, u.name` — no `t.currency`; `views/index.ejs:89` (ticker) and `:143` (winners grid) use `w.currency || 'USD'`, so every non-USD win is displayed with USD formatting/symbol. (The /api/stats version at `routes/site.js:35` does select currency — the SSR path does not.)
- Impact: public winners shown with wrong currency — reads as a fabricated figure.

### F-11 [Medium · DESIGN] Hard-coded homepage trust claims contradict the actual product: "Instant Payouts" and "Secure & Licensed"
- Evidence: `views/index.ejs:75` — `"Instant Payouts / Winnings credited at once"`; `:76` — `"Secure & Licensed / Your funds protected"`; hero sub `:28` — `"instant payouts"`. Withdrawals are in fact manual-review ("It will be processed after review", `routes/player.js:351,394`), and no licence status is verified anywhere in code (MEMORY: licence is the user's word only, unverified).
- Impact: distinct from the fixed R-010 content-block claims — these are baked into the template and cannot be corrected by the operator in the CMS. Misleading-claims risk on a real-money homepage.

---

## LOW

### F-12 [Low · LEAK] OTP channel toggles announced: "Phone login is disabled." / "Email login is disabled." / "Registration is disabled."
- Evidence: `routes/auth.js:439` (`phone_otp
...[truncated 8811 chars]