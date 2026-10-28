# Disprove-A — Adversarial Audit of Area A (Auth & Account) Findings

Date: 2026-10-28
Role: DISPROVE agent — attempt to kill each finding by finding a guard / second code path
in the **pre-fix baseline** at `~/workspace/cash-pop-push/` (production v17.1, read-only).
Method: full code read of the cited baseline files (by content, not line numbers alone),
plus a live repro against a throwaway copy of the baseline booted on port 3351
(`SQLITE_PATH=/tmp/disprove-a.sqlite`, seeded admin `admin@cashpop.live`, server killed
afterwards with `fuser -k 3351/tcp`). No baseline or fix-tree code was edited.

**Set note:** COMPILED.md sources DS-004, DS-015, DS-044, DS-045, DS-046, DS-047, DS-048,
DS-049 and DS-081 to audit-A. DS-037, DS-040 and DS-072 are sourced to audit-F in
COMPILED.md (F-05 / F-08 / F-12) but were assigned to Area A by the parent task; all 12
assigned items are audited below.

**Tally: SURVIVES 12 / DISPROVEN 0.** Every assigned finding held up — in most cases the
baseline evidence is verbatim, and 8 of 12 were additionally reproduced live/unit-tested
against the baseline in this round.

---

## DS-004 (A-01, High) — TOTP backup codes can't be typed at login — **SURVIVES**

Attempted kills: look for (a) a larger maxlength / second backup-code field, (b) JS that
strips the hyphen or expands the field, (c) server normalisation that accepts the
truncated or unhyphenated form. None exist.

Baseline evidence:
- `views/login.ejs:41` — the only login-challenge input:
  `<input … name="totp_code" inputmode="numeric" maxlength="8" …>` (also present verbatim
  in the live-served challenge HTML in this round's repro).
- `lib/auth.js:123-127` `newBackupCodes` — `randHex(4).toUpperCase().match(/.{4}/g).join('-')`
  produces 9-character codes (`XXXX-XXXX`).
- `lib/auth.js:129-130` `useBackupCode` normalises only case + whitespace
  (`replace(/\s/g,'')`), never hyphens; `hashBackupCodes` hashes the hyphenated form.
- `public/app.js` contains no handler for `#totpCode` / the TOTP form at all.
- Contrast confirms locality: the security-page inputs (`views/security.ejs:24,38`) have
  NO maxlength — the defect is specific to the login challenge, exactly as reported.

Live/unit repro (this round, baseline lib): generated code `079D-46B8` (length 9);
full hyphenated code accepted by `useBackupCode`; the browser-truncated 8-char prefix
rejected; the unhyphenated 8-char spelling rejected. Finding stands in full.

## DS-015 (A-03, Medium) — OAuth provider fetches have no timeout — **SURVIVES**

Attempted kills: look for `AbortSignal`/`AbortController` on the four callback fetches,
a global undici dispatcher (`setGlobalDispatcher`), or a server-level request timeout
in `server.js`. None exist.

Baseline evidence:
- `routes/auth.js:589` (FB token) and `:592` (FB profile): bare `fetch(url)` — no options
  object at all.
- `routes/auth.js:652` (Google token): options carry method/headers/body but no `signal`;
  `:658` (Google userinfo): headers only, no `signal`.
- The only `AbortSignal.timeout(5000)` in the file is at `routes/auth.js:68`, inside
  `verifyProvider` (captcha) — the R-042 fix the original audit contrasted against.
  Other timeout users (`lib/beacon.js`, `lib/breached.js`) are unrelated code paths.
- `grep` for `setGlobalDispatcher|headersTimeout|requestTimeout` across the baseline:
  zero hits. No code-level deadline bounds these four fetches. Finding stands.

## DS-037 (F-05, Medium) — OAuth 503 pages reveal missing provider credentials — **SURVIVES**

Attempted kill: look for a generic/sanitised error render for the OAuth start routes.
There is none — both routes render their hard-coded message directly via `res.render('error', …)`.

Baseline evidence:
- `routes/auth.js:636` (Google start): `503 'Google sign-in is not configured yet. The operator needs to add the Google OAuth credentials.'`
- `routes/auth.js:570` (Facebook start): `503 'Facebook sign-in is not configured yet.'`

Live repro (this round, baseline, toggles OFF / no env): `GET /auth/google` → HTTP 503
with the Google sentence verbatim, including "The operator needs to add the Google OAuth
credentials."; `GET /auth/facebook` → HTTP 503 with the Facebook sentence. The Google
half discloses missing credentials to any unauthenticated visitor exactly as reported;
the Facebook half discloses unconfigured state. Finding stands.

## DS-040 (F-08, Medium) — OTP sign-in verify enumerates staff/blocked/pending/2FA status — **SURVIVES**

Attempted kills: look for a generic error on the OTP-verify path, or a guard that makes
the distinct messages unreachable. The only preceding guard is a *valid OTP code*
(`otpLib.verifyOtp` must return ok) — which the original finding explicitly scopes
("after a valid code for that identifier"), so it does not disprove it.

Baseline evidence (`routes/auth.js`, POST `/login/otp/verify`):
- `:500` — `'Staff accounts cannot sign in with a code. Use your password.'` (reveals staff role)
- `:501` — `'This account has been blocked. Contact support.'` (reveals banned)
- `:502` — `'Your account is pending review.'` (reveals pending_review)
- `:503` — `'This account has two-factor authentication enabled. Please sign in with your password.'` (reveals TOTP enrolment)

Four mutually exclusive messages keyed to role/status/2FA, in direct contrast to the
password path in the same file (`routes/auth.js:194-207`), which returns one generic
`'Invalid credentials.'` for no-account / wrong-password / banned / pending (R-027).
Enumeration confirmed in code exactly as reported. Finding stands.

## DS-044 (A-04, Low) — OAuth-created accounts have no password and no in-account way to set one — **SURVIVES**

Attempted kills: look for a "set password" branch in the change-password route or
security view (e.g. skipping the current-password check when `password_hash` is empty),
or any OAuth-account special case. None exist.

Baseline evidence:
- OAuth inserts store an empty password: Facebook `routes/auth.js:603-605`
  (`password_hash` bound to `''`), Google `routes/auth.js:669-671` (same).
- `lib/util.js:18-27` `verifyPassword` splits the stored value and returns `false`
  unless it starts with `scrypt` — an empty hash can never verify, for any input.
- Every password-gated action therefore dead-ends for OAuth-only users:
  change password `routes/player.js:519` (requires current password),
  TOTP disable `routes/player.js:556`, backup-code regen `routes/player.js:575`.
- `views/security.ejs` renders one unconditional "Change password" form with a required
  Current password field — no set-password state for passwordless accounts.
- The forgot/reset flow (`routes/auth.js` POST `/forgot`, `/reset/:token`) does work as
  an out-of-band escape, but the original finding already credits it as a mitigation and
  notes nothing in the UI points OAuth users to it. A mitigation is not a guard.
  Finding stands.

## DS-045 (A-05, Low) — Failed password login re-render drops Facebook button + OTP UI — **SURVIVES**

Baseline evidence:
- GET `/login` render (`routes/auth.js:104-119`) passes `googleOn`, `facebookOn`,
  `phoneOtpOn`, `emailOtpOn`, `passwordOn`, `phonePwOn`, `emailPwOn`, `phoneCountries`.
- POST `/login` `render()` closure (`routes/auth.js:124-130`) passes **only** `googleOn`
  (plus `formError`/captcha). `views/login.ejs` gates the Facebook button on
  `facebookOn` and the whole OTP pane on `otpAny` derived from `phoneOtpOn`/`emailOtpOn`
  — all undefined on re-render, so both vanish.

Live repro (this round, baseline, both OAuth toggles ON + fake env, OTP toggles ON):
fresh `GET /login` contained Google=1, Facebook=1, `#loginOtp`=1; after one
wrong-password POST the re-rendered page contained Google=1, **Facebook=0, `#loginOtp`=0**
("Invalid credentials."). Reproduced exactly as reported. Finding stands.

## DS-046 (A-06, Low) — Register page has no social buttons — **SURVIVES**

Baseline evidence:
- `views/register.ejs` (full read): no `/auth/google` or `/auth/facebook` link anywhere;
  the form is name/email/phone/password only.
- GET `/register` (`routes/auth.js:253-266`) computes and passes `googleOn` — the
  template never references it — and does not pass `facebookOn` at all. The POST
  `/register` error re-render (`routes/auth.js:283-287`) passes `googleOn: false`.

Live repro (this round, baseline, both OAuth toggles ON + env set, state where
`GET /auth/google` correctly 302s to Google): `GET /register` contained 0 "Continue
with" buttons and 0 `/auth/google` / `/auth/facebook` links. Finding stands.

## DS-047 (A-07, Low) — TOTP challenge screen also renders the password form underneath — **SURVIVES**

Attempted kills: look for a template conditional suppressing `#loginPw` when
`totpRequired`, or JS that hides the password pane when `#loginTotp` exists. Neither exists.

Baseline evidence:
- `views/login.ejs:34-48` renders `#loginTotp` when `totpRequired`; `:50-65` then renders
  `#loginPw` **unconditionally** (no `else`, no `hidden` attribute).
- `public/app.js:379-390` tab logic touches `#loginPw`/`#loginOtp` only in response to
  method-tab clicks; nothing references `loginTotp`.

Live repro (this round, baseline): registered a user, set a TOTP secret in the test DB,
submitted the password step → challenge HTML contained both `id="loginTotp"` (count 1)
and `id="loginPw"` (count 1). Finding stands.

## DS-048 (A-08, Low, docs) — FIX-LOG names the wrong OAuth env vars — **SURVIVES**

Attempted kill: look for a fallback in code reading the FIX-LOG names
(`GOOGLE_SECRET` / `FACEBOOK_SECRET`). There is none — the only readers use the
`_CLIENT_SECRET` / `_APP_SECRET` names.

Baseline evidence:
- `FIX-LOG.md:794-795` lists `` `GOOGLE_CLIENT_ID`/`GOOGLE_SECRET` `` and
  `` `FACEBOOK_APP_ID`/`FACEBOOK_SECRET` ``.
- Code reads `process.env.GOOGLE_CLIENT_SECRET` (`routes/auth.js:646`) and
  `process.env.FACEBOOK_APP_SECRET` (`routes/auth.js:582`); a repo-wide grep for
  `GOOGLE_SECRET|FACEBOOK_SECRET` in `*.js` finds no reader.
- `README-DEPLOY.md:59,142` has the correct names — matching the original finding.
- (Corroborating, outside the finding's scope: `.env.example:48,50` carries the same
  wrong names as FIX-LOG.) Finding stands.

## DS-049 (A-09, Low) — Complete-profile "Sign out" link is a dead GET /logout (404) — **SURVIVES**

Attempted kills: look for a GET `/logout` route or alias anywhere (auth router,
`server.js`, admin/agent routers). Logout exists only as POST; the `server.js`
gate allowlists mentioning `/logout` (lines 338, 358, 370, 389) merely let the path
pass through middleware to the router — they register no handler.

Baseline evidence:
- `views/complete_profile.ejs:18` — `<a href="/logout">Sign out</a>` (a GET link).
- `routes/auth.js:243` — `router.post('/logout', …)` is the only logout route.
- The working POST form in `views/layout.ejs:81` mitigates entrapment (as the original
  finding itself notes) but does not make this link work.

Live repro (this round, baseline): `GET /logout` → **HTTP 404** "Page not found."
Finding stands.

## DS-072 (F-12, Low) — Auth toggle announcements ("Phone login is disabled." etc.) — **SURVIVES**

Attempted kill: look for generic wording on these branches. The strings are verbatim
and user-facing, returned to any requester who reaches the handler through the normal
browser flow (session + CSRF).

Baseline evidence (`routes/auth.js`):
- `:439` — `'Phone login is disabled.'` (POST `/login/otp/request`, phone channel off)
- `:441` — `'Email login is disabled.'` (same route, email channel off)
- `:484` — `'Registration is disabled.'` (POST `/login/otp/verify`, new user while
  registration off); plus the rendered variant `'Registration is currently disabled.'`
  at `:255` and `:288`.

Live repro (this round, baseline, valid anon session + CSRF header):
`POST /login/otp/request {type:"phone"}` → `{"ok":false,"error":"Phone login is disabled."}`;
`{type:"email"}` → `{"ok":false,"error":"Email login is disabled."}` — verbatim.
Finding stands.

## DS-081 (A-02, Config) — OAuth operator checklist (toggles + env + BASE_URL + console URIs) — **SURVIVES**

This is a CONFIG item: the claim is that the OAuth code path is gated by operator
configuration that does not exist by default. Attempted kill: look for any default-on
toggle, bundled credentials, or a redirect URI built from the request host instead of
`BASE_URL`. None exist — every element of the checklist checks out in the baseline:

- Toggles seeded OFF: `lib/migrations.js:42-43` — `google_oauth_enabled: '0'`,
  `facebook_oauth_enabled: '0'`.
- Buttons require toggle AND env ID: GET `/login` at `routes/auth.js:108-109`
  (`googleOn` needs `GOOGLE_CLIENT_ID`, `facebookOn` needs `FACEBOOK_APP_ID`).
- Start routes 503 unless toggle ON and ID present: Facebook `routes/auth.js:567-570`,
  Google `routes/auth.js:633-636`. The Google 503 text conflates the two gates
  ("needs to add the Google OAuth credentials" even when only the toggle is off) —
  the minor wart the finding records.
- Redirect URI is `(process.env.BASE_URL || '') + '/auth/<provider>/callback'`:
  start routes at `routes/auth.js:571` (FB) and `:637` (Google); callbacks at `:588`
  and `:651`. With no `BASE_URL` it is a relative path providers reject — so a public
  https `BASE_URL` and console-registered redirect URIs are genuinely required.

Live repro (this round, baseline): default state → login page had 0 social buttons,
both start routes 503. With toggles set to `1` in the test DB + fake env IDs/secrets +
`BASE_URL=http://localhost:3351`, `GET /auth/google` → 302 to
`accounts.google.com/o/oauth2/v2/auth?…&redirect_uri=<BASE_URL>/auth/google/callback&…&state=<random>`
— the start mechanics work exactly as the checklist describes; only the real operator
inputs are missing. Finding stands (as a config checklist, not a code defect).

---

## Summary

| DS | Source | Verdict |
|---|---|---|
| DS-004 | A-01 | SURVIVES (code + unit repro) |
| DS-015 | A-03 | SURVIVES (code; no guard/dispatcher/timeout anywhere) |
| DS-037 | F-05 | SURVIVES (code + live 503 repro) |
| DS-040 | F-08 | SURVIVES (code; verbatim distinct messages :500-503) |
| DS-044 | A-04 | SURVIVES (code; empty hash can never verify, no set-password path) |
| DS-045 | A-05 | SURVIVES (code + live re-render repro) |
| DS-046 | A-06 | SURVIVES (code + live register-page repro) |
| DS-047 | A-07 | SURVIVES (code + live challenge-HTML repro) |
| DS-048 | A-08 | SURVIVES (docs vs code; no fallback reader) |
| DS-049 | A-09 | SURVIVES (code + live GET /logout 404 repro) |
| DS-072 | F-12 | SURVIVES (code + live OTP-request repro) |
| DS-081 | A-02 | SURVIVES (config checklist fully verified, incl. live 302 with config supplied) |

**DISPROVEN: none.**
