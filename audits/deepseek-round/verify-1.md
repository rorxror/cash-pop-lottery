# Verify-1 — Independent fix verification (auth items)

Verifier: independent subagent, re-tested from scratch. Fixed app booted by the
verifier: `PORT=3341`, fresh SQLite `/tmp/verify1.sqlite`, SMTP sink on 4341
(`/tmp/smtp-out1.txt`), admin seeded from env. A second throwaway instance
(port 3347, own DB, dummy `GOOGLE_CLIENT_ID`/`FACEBOOK_APP_ID` env) was used
only for the social-button render checks, since `googleOn`/`facebookOn` also
require those env vars (DS-081 config gate). No code was edited.
Date: 2026-10-28.

## Tally

- **VERIFIED (live): 9** — DS-004, DS-037, DS-040, DS-044, DS-045, DS-046, DS-047, DS-049, DS-072
- **CODE-ONLY: 1** — DS-015
- **Red-team VERIFIED: 2** — RT-01, RT-05
- **FAILED: 0**

One residual observation (not a failure of any item as scoped) is listed at the end.

---

## DS-004 — 2FA backup codes usable — VERIFIED (live)

Flow (user `vfy1@test.local`, password login):
- `POST /security/totp/start` → 200, page shows "enter this secret manually:
  VE3TERRB7DIY7PUKL3ZJ44V2535LEZJY"; confirm with computed TOTP → 200, 8 backup
  codes shown in `XXXX-XXXX` format (e.g. `5BF9-B801`); DB: `totp_secret` stored,
  `backup_codes` is a JSON array of 8 hashes.
- Wrong code: password login → TOTP challenge; `totp_code=000000` → HTTP 200
  re-render "Invalid authenticator code.", **not** logged in (no user name on `/`).
- Valid TOTP: code POST → **302 to `/`**, logged in; `users.totp_last_step` advanced.
- Backup code in displayed format: `5BF9-B801` → **302, logged in**; DB backup
  count 8 → 7.
- Backup single-use: same `5BF9-B801` again → 200 "Invalid authenticator code.",
  not logged in, count stays 7.
- Bonus: unhyphenated form `2E6AEE66` of the second code also logs in (302),
  count 7 → 6 — normalisation works in both directions.
- Code: `views/login.ejs:41` `maxlength="16"`, placeholder "123456 or XXXX-XXXX";
  `lib/auth.js useBackupCode` strips spaces/hyphens, re-hyphenates an 8-hex-char
  input to the issued form before hashing.

**Competing-solution note (required):** The main alternative to the implemented
approach (normalising at verify time in `useBackupCode`) is storing the codes
pre-normalised (hashing the raw 8 characters at issuance and accepting only that
raw form), or equivalently normalising at issuance and rejecting hyphenated input.
Verify-time normalisation wins on the evidence: the codes are *displayed* to users
as `XXXX-XXXX`, so the hyphenated spelling is the one users will actually type —
an issuance-side-only scheme breaks exactly that input unless the display format
also changes, and it would orphan codes already issued in hyphenated-hash form.
The implemented version accepted both spellings live (hyphenated 302, raw 302,
each single-use), with no migration needed.

## DS-015 — OAuth fetch timeouts — CODE-ONLY

All 4 provider fetches in `routes/auth.js` carry `signal: AbortSignal.timeout(8000)`:
Facebook token (line 617), Facebook profile (620), Google token (681),
Google userinfo (686). No other provider fetch in the file lacks a signal
(the only other `fetch`, line 65, is captcha verification and has
`AbortSignal.timeout(5000)`). Not live-testable without a hanging provider;
code evidence is complete.

## DS-037 — Neutral OAuth 503 — VERIFIED (live)

- `GET /auth/google` → **503**, body text: "Google sign-in is unavailable right
  now. Please try again later."
- `GET /auth/facebook` → **503**, body text: "Facebook sign-in is unavailable
  right now. Please try again later."
- Neither body names credentials, env vars, toggles, or the operator
  (`routes/auth.js:598,664`).

## DS-040 — OTP-verify generic refusal — VERIFIED (code + live)

Code: `routes/auth.js:527-531` — one `otpRefusal` string returned for role ≠
player, banned, pending_review, and `totp_secret` cases.
Live (real OTP codes delivered via the SMTP sink, `POST /login/otp/verify`):
three different underlying reasons all returned **HTTP 403 with the byte-identical
body** `{"ok":false,"error":"Sign-in could not be completed with a code. Please sign in with your password, or contact support if you need help."}`:
(1) TOTP-enrolled player `vfy1@test.local`, (2) staff account
`admin@cashpop.live`, (3) player temporarily set `status='banned'` in DB
(restored to `active` afterwards). No enumeration of which reason applied.

## DS-044 — OAuth-only account can set a password — VERIFIED (live)

Simulated per instructions: registered `vfy2@test.local`, kept its live session,
then `UPDATE users SET password_hash=''` (DB length 171 → 0).
- `GET /security` → 200, shows "**Set a password**", text "…your account has no
  password yet…", and **no** "Current password" field (grep count 0).
- `POST /security/password` with only `password`/`password2` (no
  `current_password`) → **302 to /security**, flash "Password set. You can now
  also sign in with your password.", DB hash length 0 → 171, page now shows
  "Change password".
- Logged out and signed in with the newly set password → 302 to `/`, user name
  in header. Code: `routes/player.js` `/security/password` treats empty
  `password_hash` as a set (`isSet`), skipping the current-password check.

## DS-045 — Login re-render keeps social buttons / toggles — VERIFIED (live + code)

Code: the POST `/login` re-render (`routes/auth.js:126-137`) now passes the same
locals as GET: `googleOn`, `facebookOn`, `phoneOtpOn`, `emailOtpOn`,
`phoneCountries`.
Live, main instance (OTP toggles set to 1 in DB): failed password login → 200
"Invalid credentials" re-render still contains the OTP method UI
(`id="loginOtp"`, phone and email segments, "One-time code" tab).
Live, dummy-OAuth instance (toggles on + env present): failed login re-render
still contains "Continue with Google" (×1) and "Continue with Facebook" (×1)
and the OTP tab.

## DS-046 — Register shows social buttons when toggles on — VERIFIED (live + code)

Code: GET `/register` passes `googleOn` + `facebookOn` (`routes/auth.js:283-284`)
and `views/register.ejs:4-10` renders both buttons behind those flags.
Live, dummy-OAuth instance: `GET /register` → 200 with "Continue with Google"
(×1) and "Continue with Facebook" (×1). On the main instance (toggles off / no
env) neither button renders, as expected.
Residual on the *error* re-render only — see observation below.

## DS-047 — Password field hidden on TOTP step — VERIFIED (live)

In every TOTP-challenge response observed (wrong-code, valid, backup, replay
runs), the markup was `<div id="loginPw" hidden>` alongside `<div id="loginTotp">`
— the password form is present in the DOM but hidden; template condition at
`views/login.ejs:50` adds `hidden` when `totpRequired`.

## DS-049 — Complete-profile sign-out is a POST form — VERIFIED (live)

Created a genuine profile-pending session (new-user OTP signup for
`newcp@test.local` → `{"ok":true,"needsProfile":true}`), then
`GET /login/complete-profile` → 200 containing
`<form method="POST" action="/logout">` with a `_csrf` hidden field and a
"Sign out" submit button; **zero** `href="/logout"` links on the page.
`GET /logout` → 404 (POST-only route). Submitting the form → 302 to `/`, and a
following `GET /login/complete-profile` → 302 to `/login` (session destroyed).

## DS-072 — Neutral sign-in / registration-closed strings — VERIFIED (live + code)

Old strings ("Phone login is disabled." / "Email login is disabled." /
"Registration is disabled.") are absent from `routes/`, `lib/`, `views/`.
Live:
- Phone OTP request with `phone_otp_enabled=0` → **400**
  `{"ok":false,"error":"Phone sign-in is unavailable right now."}`
  (`routes/auth.js:462`; email twin at :464).
- `GET /register` with `registration_enabled=0` → **403** "Registration is
  currently closed." (`routes/auth.js:273`). First probe returned 200 because
  of the 5-second settings cache (`lib/settings.js` TTL); after >5 s the 403
  appeared — cache behaviour, not a fix defect. Setting restored to 1.
Minor wording inconsistency (not a leak): the POST `/register` guard at
`routes/auth.js:307` still says "Registration is currently disabled." while the
GET guard says "…currently closed." Both are neutral; flagged for tidiness only.

---

## RT-01 — TOTP replay must be rejected — VERIFIED (live)

User `vfy1@test.local`, secret above.
- Enrol-confirm itself claims its step: DB `totp_last_step=59772433` after
  confirm, and re-using that same enrol code at login in the same window was
  rejected ("Invalid authenticator code.", no login) — replay protection covers
  the enrol step too.
- First login with the next step's code `599106` (step 59772434) → **302,
  logged in**; `totp_last_step` 59772433 → 59772434.
- Logout, log in again with the **same** code `599106` inside its window →
  **HTTP 200 "Invalid authenticator code.", LOGGED_IN=NO**; sessions table shows
  only `user_id=0, pre_auth=1` rows from that attempt — no full session created.
- Next step's code (offset +1, step 59772435) → **302, logged in**;
  `totp_last_step` → 59772435.
Mechanism matches the code: `verifyTotpStep` returns the matched step and the
login handler claims it with a guarded
`UPDATE … WHERE COALESCE(totp_last_step,-1) < step` (`routes/auth.js:160-165`).

## RT-05 — Parallel password-reset race — VERIFIED (live)

Token captured from the SMTP sink (quoted-printable soft break rejoined;
48-hex token, DB `password_resets.token_hash` matched
`sha256('reset:'+token)`, `used=0`).
Clean run (after a server restart — see note): two parallel
`POST /reset/<token>` with different new passwords:
- Request D (`Vfy!Race-Ddd-…`) → **302 to /login** (the claim winner).
- Request C (`Vfy!Race-Ccc-…`) → **400 "This reset link is invalid or expired."**
- DB: the token row `used=1`, exactly one row, no second burn.
- Afterwards: D's password logs in (302 to `/`); C's password →
  "Invalid credentials"; the pre-reset password → "Invalid credentials".
- A third sequential POST with the same token → 400 invalid/expired.
Winner = the 302 claimant, not a last-writer overwrite.
Code: claim-first guarded update `UPDATE password_resets SET used=1 WHERE id=?
AND used=0`, `changes!==1` → invalid/expired, before the password write
(`routes/auth.js:415-416`).
Note on the first attempt: it was contaminated by the verifier's own earlier
traffic — the shared per-IP `loginLimiter` (30/15 min, in-memory) was exhausted,
so the loser received a 429 "Too many requests" page instead of the 400. Even
then, exactly one request (302) succeeded, `used=1`, and only the winner's
password logged in. The clean re-run above (fresh token, limiter reset by
restart) produced the required 400 for the loser.

---

## Observation (not scored against any item)

Register **POST error re-render** drops the social buttons: `routes/auth.js`
(~line 305) hardcodes `googleOn: false` and does not pass `facebookOn`. Proven
live on the dummy-OAuth instance: a failed `POST /register` re-render contained
0 Google / 0 Facebook buttons while the GET page had both. This is the same
defect class as DS-045 but on the register POST path; DS-046 as scoped (the
register page itself) is fixed. Recommend passing the same locals there too.

## Cleanup

Verifier's servers stopped (ports 3341, 3347, SMTP sink 4341 killed). Other
agents' instances on 3342/3343 were not touched. All DB changes were confined
to the throwaway `/tmp/verify1.sqlite` / `/tmp/verify1b.sqlite`.
