# Audit A — Auth & Account (AUDIT-ONLY, no code edited)
Date: 2026-10-28
Scope: register, login, logout, TOTP 2FA (enroll + login second step + recovery codes), OAuth Google/Facebook (routes, state, callback, error paths, toggle-off), forgot/reset password, complete-profile, sessions, change password, account settings/security page.
Method: full code read of routes/auth.js, lib/auth.js, lib/otp.js, server.js (auth parts), routes/player.js security section, all in-scope views; PLUS live repro on port 3311 with a fresh DB (`/tmp/auditA.sqlite`, seeded admin `admin@test.local`, fake OAuth env vars set). Cross-checked against audits/COMPILED-LIST.md and FIX-LOG.md — already-fixed R-items are NOT re-reported as open; regressions flagged explicitly.
Labels: CODE-BUG / CONFIG-NEEDED / WORKS

## Verdict on the two user reports

### Report 1: "2FA kaam nahi kar raha" — MOSTLY DISPROVED for the main flow, PROVED for recovery codes
The TOTP core is correct and the whole happy path works live (see A-10): RFC 6238 test vectors pass, player + admin enrollment, QR/secret display, confirm, login challenge, wrong-code rejection, valid-code acceptance, disable — all verified end-to-end. What IS broken, and plausibly what a user hits and calls "2FA not working":
- **A-01 (High): backup/recovery codes cannot be typed into the login form at all** (maxlength truncation).
- **A-07 (Low): the TOTP challenge screen also shows the full password form again**, which loops the user back to the challenge if they use it — reads as "2FA is broken".

### Report 2: "Google/Facebook se seedha login nahi ho raha" — CONFIG-NEEDED, not a code failure of the main flow
By default the feature is OFF in two independent places and no provider credentials exist, so no buttons appear and the routes 503 (A-02). With toggles ON + env vars present, the start redirect, state handling and callback error paths all behaved correctly live. A successful real-provider login could not be tested (needs real Google/Facebook apps) — see A-02 for the exact operator checklist. Three code defects around OAuth do exist: A-03 (no fetch timeout), A-05 (Facebook button vanishes after a failed password login), A-06 (no social buttons on the Register page), plus doc trap A-08.

---

## Findings

### A-01 [High] CODE-BUG — Recovery/backup codes cannot be entered on the login page (maxlength=8 vs 9-char codes)
- Evidence: `views/login.ejs:41` — TOTP input is `<input ... name="totp_code" inputmode="numeric" maxlength="8" ...>`. Backup codes are generated as 9 characters including a hyphen: `lib/auth.js` `newBackupCodes` → `randHex(4).toUpperCase().match(/.{4}/g).join('-')` (e.g. `30C0-4F3B`, live-issued in repro). Also `useBackupCode` (`lib/auth.js`) normalises only whitespace (`replace(/\s/g,'')`), not hyphens, and `hashBackupCodes` hashes the hyphenated form — so even the 8-char unhyphenated spelling `30C04F3B` does not match.
- Live repro: enrolled TOTP, received backup code `30C0-4F3B`. Posting the FULL code server-side logged in (302 → `/`, /security 200, code single-use — reuse correctly rejected). Posting the browser-truncated `30C0-4F3` (what `maxlength=8` leaves in the field) → "Invalid authenticator code." Posting unhyphenated `30C04F3B` → also invalid. In a real browser the field physically cannot hold the code.
- Impact: any player or admin who loses their authenticator is permanently locked out at login despite having valid recovery codes — the recovery path the UI itself promises ("or a backup code", login.ejs:36) does not work in a browser. Note the security-page disable/regen inputs (`views/security.ejs`) have NO maxlength, so the bug is specific to the login challenge.
- This is NOT in COMPILED-LIST/FIX-LOG (R-002 fixed the missing TOTP input + captcha exemption; the input it added carries this maxlength defect).

### A-02 [Blocker for the feature] CONFIG-NEEDED — OAuth is off by default in settings AND needs provider credentials that do not exist yet
- Evidence: `lib/migrations.js:42-43` seeds `google_oauth_enabled: '0'`, `facebook_oauth_enabled: '0'`. `routes/auth.js:108-109` shows buttons only if setting ON **and** `process.env.GOOGLE_CLIENT_ID` / `FACEBOOK_APP_ID` present. Start routes (`routes/auth.js:567-577`, `:633-643`) 503 otherwise.
- Live repro (env vars set to fake values, toggles still OFF): login page contained **0** social buttons; `GET /auth/google` → 503 "not configured yet". After setting both toggles to `1` in DB (and waiting out the 5 s settings cache): both buttons appeared; `GET /auth/google` → 302 to `accounts.google.com/o/oauth2/v2/auth?client_id=…&redirect_uri=<BASE_URL>/auth/google/callback&…&state=<random>`; Facebook equivalent → 302 to `facebook.com/v18.0/dialog/oauth` with state. Callbacks: bad state → 400 generic "sign-in failed" (no leak), no-session → 400, correct state + fake Google code → provider `invalid_grant` handled → 400 generic.
- Exactly what the operator must supply for real logins (nothing in code can substitute): (1) admin toggles ON for google/facebook_oauth_enabled; (2) env `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`, `FACEBOOK_APP_ID` + `FACEBOOK_APP_SECRET` from real provider apps; (3) `BASE_URL` set to the public https origin — the redirect_uri is built as `(process.env.BASE_URL || '') + '/auth/google/callback'` (`routes/auth.js:636,649`; Facebook `:570,585`), so without BASE_URL it is a relative path providers reject; (4) that exact redirect URI registered in the Google Cloud / Meta app consoles.
- Minor code-side wart: the 503 message says "The operator needs to add the Google OAuth credentials" even when credentials ARE set and only the toggle is off (message conflates the two gates).

### A-03 [Medium] CODE-BUG — OAuth provider calls have no timeout; a slow/unreachable provider hangs the callback indefinitely
- Evidence: `routes/auth.js:589` (FB token), `:592` (FB profile), `:652` (Google token), `:658` (Google userinfo) — plain `fetch(...)` with no `AbortSignal`. Contrast `verifyProvider` at `routes/auth.js:65-68`, which got a 5 s timeout under R-042 precisely "so a hung provider cannot hang login".
- Live repro (corrected after full background output arrived): Google callback with correct state + fake code took tens of seconds to complete its token exchange from the test host (total script duration 120 s) — slow, with no code-level deadline to cut it off — before correctly failing with `invalid_grant` → generic 400. The Facebook token exchange was NOT actually exercised in repro: my test script extracted an empty `state` value, so the callback correctly rejected it as "bad state" (server log confirms) before any provider fetch. The finding therefore rests on the code evidence above (four deadline-less fetches, in deliberate contrast to the R-042 captcha fix) plus the observed unbounded Google exchange time — not on a proven Facebook hang.
- Impact: any provider/network stall can pin the user's sign-in request (and a server connection) for an unbounded time; user sees a dead browser tab during "direct login".

### A-04 [Low] CODE-BUG — OAuth-created accounts have no password and no in-account way to set one; every password-gated security action dead-ends for them
- Evidence: Google insert sets `password_hash: ''` (`routes/auth.js` Google callback INSERT), Facebook insert likewise. `lib/util.js:18-27` `verifyPassword` can never match an empty stored hash. Password-gated actions all require the current password: change password `routes/player.js:519`, TOTP disable `:556`, backup-code regen `:575`.
- Impact: an OAuth-only user who enables 2FA can never disable it or regenerate recovery codes from the security page, and cannot add password sign-in. Mitigation exists and was live-verified: the forgot/reset flow works for them (email link → set password), but nothing in the UI tells them that, and there is no "set password" state in `views/security.ejs`.

### A-05 [Low] CODE-BUG — After one failed password login, the re-rendered login page loses the Facebook button and the OTP method UI
- Evidence: POST /login `render()` closure, `routes/auth.js:124-130`, passes only `googleOn` (no `facebookOn`, `phoneOtpOn`, `emailOtpOn`, `passwordOn`, `phoneCountries`), unlike GET /login (`:104-119`) which passes all.
- Live repro (both OAuth toggles ON): fresh GET /login showed Google **and** Facebook; after one wrong-password POST the re-render showed Google only, Facebook gone (OTP tabs likewise gone when enabled, since `login.ejs` derives them from the now-undefined vars).
- Impact: a user who mistypes once can no longer choose Facebook sign-in (their intended method) without reloading the page manually.

### A-06 [Low] CODE-BUG — Register page has no social sign-up buttons at all
- Evidence: `views/register.ejs` contains no `/auth/google` or `/auth/facebook` link (live GET /register with toggles ON + env set: 0 "Continue with" buttons). GET /register (`routes/auth.js:254-266`) computes `googleOn` and passes it — the template never uses it — and does not pass `facebookOn` at all.
- Impact: new users landing on Register (the page marketed for sign-up) never see social options; social exists only on /login. Inconsistent, and contributes to "Google/Facebook se login nahi ho raha" reports from users who start at Register.

### A-07 [Low] CODE-BUG — TOTP challenge screen renders the password form again underneath the code form
- Evidence: `views/login.ejs:34-69` renders `#loginTotp` when `totpRequired` and unconditionally renders `#loginPw` below it; `public/app.js` has tab logic for `#loginPw`/`#loginOtp` but nothing hides the password pane during the TOTP step. Live: the challenge HTML contained both `id="loginTotp"` and `id="loginPw"`.
- Impact: users at the 2FA step see email/password fields again; submitting them just restarts the password step and re-renders the challenge — easily perceived as "2FA kaam nahi kar raha".

### A-08 [Low] CODE-BUG (docs) — FIX-LOG names the wrong OAuth secret env vars
- Evidence: `FIX-LOG.md:794-795` lists `GOOGLE_CLIENT_ID`/`GOOGLE_SECRET` and `FACEBOOK_APP_ID`/`FACEBOOK_SECRET`. Code reads `GOOGLE_CLIENT_SECRET` (`routes/auth.js:646`) and `FACEBOOK_APP_SECRET` (`routes/auth.js:582`). (`README-DEPLOY.md:59,142` has the correct names.)
- Impact: an operator configuring from the FIX-LOG sets variables the code never reads → start route may show the button (ID is read) but every callback throws "not configured" → generic "sign-in failed" — exactly the reported symptom, from a paperwork trap.

### A-09 [Low] CODE-BUG — "Sign out" link on the complete-profile gate page is a dead GET /logout (404)
- Evidence: `views/complete_profile.ejs:18` `<a href="/logout">Sign out</a>`; logout exists only as POST (`routes/auth.js:243`). Live: `GET /logout` → 404 "Page not found."
- Impact: profile-incomplete users (a gated population that can reach almost nothing else) hit a 404 from the page's own escape link. A working POST logout form exists in the layout header, so impact is confusion, not entrapment.

---

## A-10 WORKS — verified live (fresh DB, port 3311), do not re-open
- **TOTP cryptography**: `totpCode` matches RFC 6238 vectors (`GEZD…` secret → `287082` @59 s, `081804` @1111111109 s); ±1 step window in `verifyTotp` (`lib/auth.js`).
- **Player 2FA lifecycle**: enroll start → QR + manual secret → confirm with valid code → 8 backup codes shown once → logout → password step renders challenge → wrong code rejected ("Invalid authenticator code") → valid code logs in → disable with wrong password rejected, disable with password + valid code succeeds → next login has no challenge. All PASS.
- **Admin 2FA lifecycle**: enroll via admin `/security`, login challenge, valid code → redirected to admin path. PASS.
- **Backup codes (server contract)**: full hyphenated code logs in; reuse of the same code rejected. (Browser entry is A-01.) PASS server-side.
- **Pre-auth session safety (R-001, no regression)**: after password step, the pending-TOTP session got 404 on the admin path and 302→/login on /security and /profile — no identity granted before the code step.
- **Register**: full form, auto-login, phone dial-code+local recombined and stored normalised (`+15551234567`), duplicate email rejected, breached-password check rejects a known-breached password, phone-identifier password login works. PASS.
- **Change password** (`/security/password`): wrong current rejected with flash, correct change succeeds, other-session revocation path present; `/security/sessions/revoke` keeps current session. PASS.
- **Forgot/reset**: token row created, generic "sent" response, reset link single-use (reuse → 400), reset POST works session-less (form renders empty `_csrf` — acceptable here because the URL token itself is the secret), new password then logs in (and still hits the TOTP challenge when enrolled). PASS.
- **Complete-profile gate**: `profile_completed=0` user is redirected from `/` and `/play` to `/login/complete-profile`; POST (name + agree) sets the flag + `terms_accepted_at` and unlocks the site. PASS (page's own sign-out link is A-09).
- **Force-reset gate**: flagged user redirected to `/force-reset`, POST clears the gate. PASS.
- **OAuth mechanics (config aside)**: strict single-use `state` (bad/missing → 400), banned/pending/TOTP gate via `oauthAccountCheck` in both callbacks, toggle-off → 503 and no buttons, generic non-leaking callback errors. PASS as far as testable without real provider apps.
- **Auth OTP login toggles**: default OFF and `/login/otp/request` returns "Email login is disabled." — by design per standing rules (OTP belongs on withdrawal, default ON there); NOT a bug.
- Server was shut down after testing (`fuser -k 3311/tcp`); test DB was the throwaway `/tmp/auditA.sqlite`.

## Summary table

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 1 | A-01 |
| Medium | 1 (+1 config blocker) | A-03; A-02 (CONFIG) |
| Low | 6 | A-04, A-05, A-06, A-07, A-08, A-09 |
| **Total findings** | **9** | |

| Label | Count |
|---|---|
| CODE-BUG | 8 (A-01, A-03, A-04, A-05, A-06, A-07, A-08, A-09) |
| CONFIG-NEEDED | 1 (A-02 — OAuth operator checklist; main OAuth code path itself verified as far as possible without real provider credentials) |
| WORKS (verified areas) | TOTP core + enroll/login/disable (player & admin), backup-code server contract, register, phone login, change password, sessions revoke, forgot/reset, complete-profile, force-reset, OAuth state/toggle/error handling |

**Bottom line for the user reports:** 2FA's engine works — the real 2FA bug is that recovery codes can't be typed into the login box (A-01), compounded by the confusing double form at the challenge step (A-07). Google/Facebook login is not broken in its main code path — it was never switched on: admin toggles default OFF plus real provider credentials/BASE_URL/console redirect URIs are still missing (A-02), with A-03/A-05/A-06/A-08 as genuine code/doc defects around it.
