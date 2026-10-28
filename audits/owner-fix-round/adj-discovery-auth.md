# DISCOVERY D2 — Auth, Sessions, Account Lifecycle (Cash Pop v20 owner-fix round)

Worker: DISCOVERY FINDER D2. **Nothing was fixed.** All work on the frozen
snapshot `/tmp/hunt-snapshot/` only; no app code edited anywhere.
Boot: snapshot on port 4132, fresh SQLite `/tmp/d2.sqlite`, env
`SQLITE_PATH/PORT/BASE_URL/TICKET_HMAC_SECRET/ADMIN_SEED_EMAIL/ADMIN_SEED_PASSWORD`
(plus a second boot without `BASE_URL` and with dummy Google/Facebook env
for the OAuth/admin-link tests). Boot killed with `fuser -k 4132/tcp` at
the end (port verified free).

Dedupe: checked `audits/COMPILED-LIST.md` (R-ids),
`audits/deepseek-round/COMPILED.md` + `REDTEAM.md` (DS-/RT-ids),
`audits/deep-scan-round/COMPILED.md` (SCAN-ids), and the owner-fix
`LEDGER.md` U-scopes before reporting. Items inside U-22 (identity
dedupe) and U-04 (sessions page) are marked IN-FLIGHT and not
re-adjudicated. No candidate below duplicates a known R/DS/RT/SCAN item;
where an old item's fix was re-tested and held, it is listed under
Swept Clean as a regression check, not as a new candidate.

---

## CANDIDATES (proven live on the snapshot boot)

### D2-C1 — Pending-TOTP (pre-auth) session keeps the 1-hour ANON TTL, not the 15-minute PREAUTH_TTL — in the normal browser flow

- **Surface:** password login → TOTP challenge (and both OAuth → TOTP
  stashes), for any user who arrives with an existing session — which is
  every real browser, because `GET /login` always creates an anon session
  first (R-036).
- **Code:** `routes/auth.js:269` — when a session already exists, the
  handler only does `touchSession(..., { pending_user_id, pre_auth: true })`.
  `touchSession` (`lib/auth.js`, R-121) deliberately never changes
  `expires_at`, so the row keeps the anon session's 1-hour expiry. The
  15-minute `PREAUTH_TTL` branch (`routes/auth.js:260`) runs only when
  there was **no** prior session. Same pattern at `routes/auth.js:766`
  (Facebook TOTP stash) and `routes/auth.js:872` (Google TOTP stash).
- **Repro:** registered a player, enrolled TOTP, logged out,
  `GET /login` (anon session), `POST /login` with correct password.
- **Expected:** pre-auth session row TTL = 900,000 ms (PREAUTH_TTL).
- **Observed:** session row `user_id=0`,
  `data={"pending_user_id":2,"pre_auth":true}`, **`expires_at-created_at =
  3,600,000 ms` (1 hour)** — a 4× longer window in which a captured
  pre-auth cookie + a TOTP/backup code (or continued guessing, subject to
  the per-account fail counter) can complete the login.

### D2-C2 — Password reset (and every session-revocation path) does NOT kill pre-auth sessions; a pre-auth session started before the reset completes the login afterwards, without the new password

- **Surface:** `destroyUserSessions` and all its callers.
- **Code:** `lib/auth.js:32` deletes only `WHERE user_id = ?`. Pre-auth
  sessions are stored with `user_id = 0` and the target in
  `data.pending_user_id`, so they are invisible to every revocation:
  password reset (`routes/auth.js:499`), password change
  (`routes/player.js:873`), TOTP disable/backup (`player.js:914/931`),
  sessions-revoke (`player.js:937`), force-reset (`player.js:816`),
  admin block / reset / revoke-sessions (`routes/admin.js:1046/1065/1082`),
  admin TOTP disable (`admin.js:3231`).
- **Repro:** (1) full login for the TOTP user; (2) second password-only
  login → pre-auth session P; (3) consumed a valid reset token (inserted
  row, known token) with a new password.
- **Expected (per RT-06's recorded contract):** "a successful reset …
  destroys all sessions" for that user.
- **Observed:** `sessions WHERE user_id=2` went 2 → 0, **but P's row
  survived untouched**; submitting a fresh TOTP code on P then returned
  `302 → /` and `GET /wallet → 200` — a full login completed *after* the
  password was reset, by a session that only ever knew the **old**
  password. Combined with D2-C1, that surviving window is up to 1 hour,
  not 15 minutes.

### D2-C3 — TOTP enrolment needs no password and no existing factor — a bare session can enrol an attacker's authenticator (player and admin)

- **Surface:** `POST /security/totp/start` + `/security/totp/confirm`.
- **Code:** `routes/player.js:878` and `:886` check only `requireLogin`;
  neither handler reads a password or an existing code. Admin twins:
  `routes/admin.js:3185` (start) and `:3198` (confirm). Contrast with the
  neighbouring handlers, which all re-authenticate: password change
  (current password), TOTP disable (password + code, `player.js:903`),
  backup regen (password + code, `player.js:919`).
- **Repro:** logged in as a fresh player, harvested CSRF from
  `GET /security`, POSTed totp/start (no password field sent — none
  exists), read the secret from the setup page, POSTed totp/confirm with
  a locally computed code.
- **Expected:** enrolling a second factor requires proving the first
  factor (password), as disable/regen already do.
- **Observed:** enrolment succeeded end-to-end (8 backup codes issued,
  `users.totp_secret` set, `totp_last_step` set) with **no password
  supplied at any step**. Anyone holding a session (hijacked cookie,
  shared-device leftover) can enrol their own TOTP and persist past a
  password reset (the secret survives D2-C2's reset too), while the
  victim cannot disable it without that TOTP/backup code.

### D2-C4 — Custom captcha is single-solve, multi-use: the consumed answer is never persisted as consumed

- **Surface:** every captcha-gated POST (forgot shown; the same
  `checkCaptcha` serves login/register/OTP-request).
- **Code:** `routes/auth.js:32-37` — `checkCaptcha` sets
  `req.sessionData._captcha = null` **in memory only**. Nothing writes
  that null back to the session row (no `touchSession` on the success
  path of e.g. `POST /forgot`), so the DB session keeps the live hash
  until some later render happens to regenerate it. The answer space is
  also tiny by construction: `a,b ∈ 2..8`, i.e. sums 4–16 (13 values)
  (`routes/auth.js:26-31`).
- **Repro:** enabled the `custom_captcha` extension, `GET /forgot`,
  solved the question once (answer 8), POSTed `/forgot` twice from the
  same jar with the **same answer and no new GET**.
- **Expected:** second POST fails captcha (single-use), no second token.
- **Observed:** both POSTs accepted; `password_resets` rows for the user
  grew **1 → 2** — a second live reset token was minted on the replayed
  answer.

### D2-C5 — Blocked-country phone rule is enforced at registration only; the same number is accepted afterwards via profile edit

- **Surface:** `POST /profile` phone change (also, code-only: agent
  create-player `routes/agent.js:88ff` and admin user edit
  `routes/admin.js:946ff` write `phone` with no blocked-country check).
- **Code:** the only `isBlockedPhone` call in the codebase is
  `routes/auth.js:381-382` (register). `routes/player.js:715ff` validates
  format and cross-account duplicates but never calls it.
- **Repro:** set `blocked_phone_countries='IN'` (waited out the 5 s
  settings cache). Register with `+919876500001` → correctly refused
  ("Phone numbers from this country are not accepted…", no user). Then,
  as an existing player, `POST /profile` with `phone=+919876500002`.
- **Expected:** the blocked-country refusal applies to the number
  wherever it is set.
- **Observed:** profile POST returned 302 and
  `users.phone = '+919876500002'` in the DB — the block is fully bypassed
  by registering with an allowed/no number and editing the profile.
  (Note: an earlier apparent register-side bypass in my testing was my
  own out-of-band DB write landing inside the 5-second settings cache
  TTL; admin saves invalidate the cache, so registration itself is
  **not** charged — see Swept Clean.)

### D2-C6 — Player self-service verify-email: no rate limit and no invalidation of earlier tokens (unlike the admin path and password reset)

- **Surface:** `POST /profile/verify-email` (`routes/player.js:758`).
- **Code:** the handler inserts a fresh `email_verifications` row and
  sends mail on every POST — no `rateLimit(...)`, and no
  `UPDATE … SET used=1` for prior rows. The admin-initiated path does
  invalidate priors (R-014, `routes/admin.js` user edit), and password
  reset does too (R-030); the player path was left asymmetric.
- **Repro:** logged-in player, 4× `POST /profile/verify-email` with
  valid CSRF.
- **Expected:** at most one live verification link at a time (the
  R-014/R-030 invariant), and a cap on sends.
- **Observed:** unused verification rows for the user went **0 → 4**
  (four simultaneously live 24-hour links, four emails sent). First
  click still burns the rest, so the impact is mail-spam to the user's
  own address + a weakened one-live-link invariant — Low, but proven.

### D2-C7 — Session-less CSRF exemption list omits the most sensitive auth endpoint: `POST /reset/:token` runs with no session and no CSRF token at all

- **Surface:** global CSRF middleware, `server.js:311-313`.
- **Code:** when `!req.sess`, only the exact-match list
  `['/login','/forgot','/register','/login/otp/request','/login/otp/verify','/contact']`
  is refused; every other path falls through (`req.path` for a reset is
  `/reset/<token>`, which never equals a list entry). R-036's stated
  invariant — session-less POSTs to auth endpoints are refused — does
  not cover reset.
- **Repro:** with a **completely empty cookie jar** (no session, no
  `_csrf` field), `POST /reset/<valid token>` with a new password.
- **Expected:** 403 "Security token mismatch" like the other auth POSTs.
- **Observed:** **302 → /login and the password was changed** (subsequent
  password-step login with the new password reached the TOTP page).
  Token secrecy is the only remaining barrier. Two other fall-throughs
  were checked and fail safe in-handler, listed for completeness:
  `POST /login/complete-profile` without a session → 401 from the
  handler; `POST /logout` without a session is a no-op. One more
  succeeds by design of its handler: `POST /currency` without session →
  302 (display-currency preference only).

### D2-C8 — `trust proxy` = 1 with no chain restriction: a direct client can forge `X-Forwarded-For` to defeat per-IP rate limits and falsify IP evidence (deployment-conditional)

- **Surface:** `server.js:122` `app.set('trust proxy', 1)`; every
  limiter keys on `req.ip` (`lib/auth.js` rateLimit), and `req.ip` is
  written to `login_history`, `sessions`, and audit rows.
- **Repro (snapshot boot, direct connection, no proxy in front):**
  (1) exhausted the real-IP `login:` bucket (429s); the **same client**
  then sent `X-Forwarded-For: 10.9.9.9` and logged in immediately;
  `login_history.ip` and `sessions.ip` recorded **10.9.9.9**.
  (2) a fresh forged bucket (`10.7.7.7`) then allowed exactly 30 more
  bad logins before its own 429 at attempt 31.
- **Expected:** a client that is not itself the trusted proxy cannot
  choose its own `req.ip`.
- **Observed:** it can, on any deployment where this process is directly
  reachable (the standalone/cPanel-style deployment the README targets).
  **Conditional:** behind an edge proxy that appends/strips XFF
  correctly (e.g. Render), the rightmost-hop semantics may neutralise
  the spoof — that topology was **not** testable from the snapshot, so
  the production impact on Render is stated as unverified, the local
  behaviour as proven.

### D2-C9 — Flows that still build links as `(BASE_URL || '') + path`: OAuth is dead and admin-forwarded links are relative when `BASE_URL` is unset

- **Surface:** OAuth start/callback and admin-issued one-time links —
  the same class SCAN A-09 fixed for the user forgot flow (which now
  falls back to `req.protocol + '://' + req.get('host')`), fixed nowhere
  else.
- **Code:** `routes/auth.js:693, 715` (Facebook), `:786, 803` (Google)
  build `redirect_uri` from `(process.env.BASE_URL || '')`;
  `routes/admin.js:1066` (admin reset link) and `:1004` (admin
  email-change link) do the same for links the admin is told to forward.
- **Repro:** second boot with **no `BASE_URL`**, dummy Google/Facebook
  env, OAuth settings on.
- **Observed:** `GET /auth/google` → 302 to Google with
  `redirect_uri=%2Fauth%2Fgoogle%2Fcallback` (a relative URI, which
  Google/Facebook reject — OAuth cannot complete in this
  configuration, with no operator-facing error); Facebook identical.
  Admin `POST /users/:id/reset-password` produced a flash link of the
  bare form `/reset/<token>` — unusable to forward. **Conditional** on
  `BASE_URL` being unset; the standard deploy env sets it, so this is a
  latent foot-gun, not a claim about the current live Render config
  (not verified).

---

## CSRF COVERAGE MAP

Mechanism (`server.js` CSRF middleware): for POST/PUT/PATCH/DELETE with
a session present, **every** route requires `_csrf` (body or
`x-csrf-token` header) matching the session token — except
`/webhooks/*`, which verifies provider HMAC over the raw body instead.
With **no** session, only the exact-match list in D2-C7 is refused;
everything else reaches its handler (which for all login-gated routes
then fails auth — except the D2-C7 items).

Live spot checks (with an authenticated session, token omitted): all
**403** — `POST /profile`, `/security/password`, `/logout`,
`/support/new`, `/play/buy`, `/withdraw/new`, `/profile/verify-email`;
control with token → 302. Session-less: `/contact` → 403,
`/forgot` family → 403 (list), `/setup` → 404 (ALLOW_SETUP off).

Full POST inventory by router (all covered by the global check when a
session exists):

- **auth.js (9):** `/login`, `/logout`, `/register`, `/forgot`,
  `/reset/:token` ⚠ (D2-C7 session-less hole), `/login/otp/request`,
  `/login/otp/verify`, `/login/complete-profile`. State-changing GETs by
  design (secret-token / state-checked): `/verify-email/:token`,
  `/auth/google|facebook/callback` (state proven single-use, below).
- **player.js (21):** `/play/buy`, `/deposit/new`, `/withdraw/new`,
  `/withdraw/verify`, `/withdraw/verify/resend`,
  `/withdraw/verify/cancel`, `/kyc`, `/profile`,
  `/profile/notifications`, `/profile/verify-email`,
  `/profile/verify-phone`, `/profile/verify-phone/confirm`,
  `/force-reset`, `/security/password`, `/security/totp/start`,
  `/security/totp/confirm`, `/security/totp/disable`,
  `/security/totp/backup`, `/security/sessions/revoke`, `/support/new`,
  `/support/:publicId/{reply,delete,close,reopen}`.
- **scratch.js:** player `/scratch/:id/buy`,
  `/scratch/ticket/:publicId/reveal`, `/scratch/responsible-play`;
  admin (under admin path) `/create`, `/planner/{preview,create}`,
  `/:id/{launch,toggle,stop}`.
- **site.js (2):** `/contact` (session-required list), `/currency`
  ⚠ (session-less succeeds, preference-only — D2-C7).
- **setup.js (1):** `/setup` — exempt by design; independently gated by
  `ALLOW_SETUP=1` + no-admin-exists (404 on this boot, proven).
- **agent.js (4):** `/players/claim`, `/players/new`, `/transfer`,
  `/support/:publicId/reply`.
- **admin.js (~70):** all state POSTs under the admin path (users,
  deposits, withdrawals, methods+credentials, settings, automation,
  bonuses, KYC, support, staff, security TOTP, export/import-era
  routes, etc.) — session CSRF applies; unauthenticated probes die
  earlier at the stealth 404.
- **server.js (1):** `POST /impersonate/exit` — covered when a session
  exists (proven: wrong session's token → 403; impersonated session's
  own token → 302 and session destroyed).
- **webhooks.js (1):** `POST /webhooks/:rail` — CSRF-exempt **by
  design**, HMAC-verified instead.

**Net:** no session-bearing state-changing route was found missing the
check. The only gaps are the session-less fall-throughs in D2-C7.

## RATE-LIMIT COVERAGE MAP

Limiter is in-memory per key (`lib/auth.js`); buckets are per
key-string, so endpoints sharing a middleware instance **and** keyFn
share one bucket.

**Covered:**
| Route(s) | Limit | Key |
|---|---|---|
| `POST /login`, `POST /reset/:token`, `POST /login/otp/request`, `POST /login/otp/verify` | 30 / 15 min, **shared bucket** | `login:` + IP |
| `POST /register` | 20 / hour | IP |
| `POST /forgot` | 10 / hour | IP |
| `POST /play/buy` | 10 / min | user id |
| `POST /deposit/new` | 10 / min | user id |
| `POST /kyc` | 10 / min | user id |
| `POST /scratch/:id/buy` | 10 / min | user id |
| `POST /scratch/ticket/:id/reveal` | 12 / min | user id |
| `POST /contact` | 5 / min | IP |
| `POST /webhooks/:rail` | 60 / min | IP |
| admin `POST …/security/totp/confirm`, `…/totp/disable` | 10 / 15 min | admin user id |
| OTP internals (`lib/otp.js`) | 5 code requests/hr, 15 failed verifies/hr, 5 attempts/code | per identifier — covers login OTP, profile phone verify, and withdrawal verify (all call `createOtp`/`verifyOtp`) |

Plus the per-account login lockout (10 failures / 15 min from
`login_history`, shared by password + TOTP steps) — live-proven below.

**Not covered (route-level; auth/money-adjacent first):**
- `POST /withdraw/new`, `/withdraw/verify`, `/withdraw/verify/resend`,
  `/withdraw/verify/cancel` — no route limiter. Verify/resend are
  mitigated by the `lib/otp.js` per-identifier caps above; `/withdraw/new`
  itself (pending-withdrawal creation) has **no** cap of any kind found.
- Player `POST /security/password`, `/security/totp/confirm`,
  `/security/totp/disable`, `/security/totp/backup`,
  `/security/sessions/revoke`, `/force-reset` — no limiter (the admin
  TOTP twins have one; the player twins do not — see Unproven Leads).
- `POST /profile/verify-email` — none (D2-C6). `/profile/verify-phone`
  — none at route level, mitigated by `lib/otp.js` request caps.
- `POST /login/complete-profile`, `POST /logout`, `POST /profile`,
  `/profile/notifications`, `/support/*` (new-ticket creation is
  separately capped by the U-19 settings limits), agent
  `/transfer` + `/players/new` + `/players/claim`, all admin POSTs
  other than TOTP confirm/disable, all scratch-admin POSTs,
  `POST /currency`, `POST /setup` (env-gated). All per-IP limits are
  additionally subject to D2-C8.

## UNPROVEN LEADS

1. **Verify-email consume is not CAS-guarded** (`routes/auth.js`
   GET `/verify-email/:token`: `UPDATE … SET used=1 WHERE id=?`, no
   `used=0` guard, no `changes` check — asymmetric with the reset
   token's RT-05 fix). **Race attempted and NOT reproduced on SQLite:**
   two parallel clicks with two *different* tokens for one user →
   one 302, one 400, exactly one email applied; sequential stale token
   → 400. Recorded as a code-asymmetry lead only (a wider window may
   exist on Postgres/multi-instance; unproven here).
2. **Player TOTP/security POSTs have no rate limiter** while the admin
   twins do (R-054 pattern). Code-proven asymmetry
   (`routes/player.js:859/886/903/919` vs `routes/admin.js:3198/3211`);
   no live brute-force proof attempted — disable/backup also require
   the password, confirm requires holding the victim session, so impact
   is bounded; flagged for a parity decision, not charged as a bug.
3. **Forgot-password has no per-email cap** — only 10/hr per IP, and
   every request burns the previous token (R-030 by design). Proven
   counts: 3 requests → 3 notification rows, only the latest token
   live (`used` split 4 used / 1 unused for the test user). Anyone who
   knows an email can keep invalidating the victim's reset links and
   mail-bomb them; with D2-C8 the IP cap is rotatable in direct
   deployments. Design trade-off — needs an owner decision, not charged.
4. **`POST /register` has no already-authenticated guard** (the GET
   redirects a logged-in user; the POST does not check `req.user`, and
   `finishLogin` would switch the session to the new account).
   Code-clear; not live-tested. Adjacent to U-22's multi-account scope —
   treat as **IN-FLIGHT-adjacent** and let the U-22 worker's verdict
   govern.
5. **Impersonation `login-as` has no explicit status check in the
   handler** (`routes/admin.js:1146`): a session row **is** created for
   banned/pending targets (302 returned), but `loadSession` destroys it
   on the very next request (proven: next GET → 302 /login, no usable
   session). Net effect held; only the wasted row + misleading 302 are
   wrong. Defence-in-depth note, not a candidate.
6. **No remember-me / short-session choice exists:** every full login
   mints a 7-day cookie + 7-day DB session (`finishLogin`), regardless
   of device. Not a defect per any stated requirement — recorded
   because the task asked for the cookie/session posture as-built.

## SWEPT CLEAN (live-proven on this boot; regression checks of old fixes included)

- **Session fixation / rotation (RT-04):** anon sid rotated at login,
  old session row count = 0 afterwards.
- **Pre-auth identity (R-001):** pre-auth jar `GET /wallet` → 302
  /login; pre-auth rows carry `user_id=0`. (Its *lifetime/revocation*
  are D2-C1/C2 — the identity isolation itself held.)
- **TOTP one-use (RT-01):** the enrolment step is consumed — a code
  from the same step as enrolment was refused at login; a code that
  completed one login was refused in a second login ("Invalid
  authenticator code"). Backup codes: one use succeeded (302), hash
  count 8 → 7, sequential reuse refused.
- **Reset token lifecycle (RT-05/RT-06, R-030):** sequential reuse →
  400; **parallel** two-password race → exactly one 302 and one 400
  (CAS claim holds); issuing a new token burns prior unused ones; a
  successful reset destroyed all `user_id` sessions (2 → 0) — the
  pre-auth exception is D2-C2, charged separately.
- **Login throttling:** 32 bad logins on one bucket → first 429 at
  attempt 31; per-account lockout also live-observed — after ≥10
  recorded failures the *correct* password got the same generic
  "Invalid credentials." (no enumeration) until the window passed.
- **Complete-profile gate:** with `profile_completed=0`, `GET /wallet`
  → 302 to the gate, `POST /support/new` → 403, completion POST → flag
  set and `/wallet` → 200.
- **Expired session:** forged expired sid → 302 /login and the row was
  deleted.
- **Logout-everywhere (`/security/sessions/revoke`):** two live
  sessions → revoke from one → other jar 302 /login, current jar 200,
  session count 2 → 1.
- **CSRF with session:** 7/7 representative POSTs without a token →
  403; with token → 302 (see map).
- **OAuth seams (dummy credentials, no real provider round-trip
  possible):** state is stored server-side even for anonymous starts;
  bad state → 400 generic; **state is single-use** (replay → 400);
  bogus code with a good state → 400 generic "sign-in failed", no
  internal detail. Unconfigured/disabled providers → 503. Identity
  dedupe/linking verdicts are **IN-FLIGHT (U-22)** and were not
  re-adjudicated; the sessions-page presentation is **IN-FLIGHT
  (U-04)**.
- **Blocked country at register:** with the setting applied through the
  cache, `+91` registration was refused with the true reason and no
  user created (see D2-C5 note on my initial cache artefact).
- **Breached-password check:** live HIBP k-anonymity check refused a
  known-breached password at registration (form error naming the
  breach, no account created). Fail-open on network error is the
  documented design in `lib/breached.js`; the success path is what was
  proven here.
- **Forgot-password enumeration:** unknown and known addresses both
  render the same "sent" outcome (200).
- **Impersonation basics (RT-32):** login-as produced a session flagged
  `impersonated_by`, the impersonated profile rendered, and
  `/impersonate/exit` with that session's own CSRF destroyed the
  session (302 /login). Banned/pending targets: see Lead 5 (net held).
- **Cookie flags as actually set by this code on this boot** (plain
  HTTP, `force_ssl=0`): full-login cookie =
  `sid=…; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax` — **no
  `Secure`** on an HTTP boot, exactly as coded
  (`secure: req.secure || force_ssl`); anon cookie Max-Age 1 h;
  no-prior-session pre-auth cookie Max-Age 15 min (the DB-side
  exception is D2-C1).
- **GET /logout** → 404 (logout is POST-only, and the complete-profile
  page's sign-out is a POST form — DS-049's dead link is not present
  in this snapshot).

## Method notes / limits

- Real Google/Facebook round-trips are impossible in the sandbox (no
  real provider apps); OAuth verdicts above are start/state/callback
  error-path proofs with dummy credentials, matching RT-11's limit.
- All "inserted token row" tests (reset/verify) used rows built exactly
  as the app builds them (`sha256('reset:'+token)` /
  `sha256('verify:'+token)`, future expiry) because outbound mail is
  not delivered in the sandbox; the HTTP behaviour tested is the app's
  own.
- Test accounts created on the throwaway DB only: admin (seed), Alice
  (TOTP), Bob, Dave; the snapshot tree itself was never modified.

---

## D-FIX-A results

Worker: D-FIX-A (auth/session domain). Method: every candidate was
RE-VERIFIED on the current tree first (spawned servers on ports
4136/4137, fresh SQLite, curl jars + direct DB reads), fixed only if
it still reproduced, and each fix proven with the finder's own repro
inverted — manually first, then as a regression test in
`test/v20-discovery-auth.test.js` (6 active tests pass, 2 skipped =
the SPEC-only items below). Files touched: `lib/auth.js`,
`routes/auth.js`, `server.js`, the new test file, and this addendum.
`routes/player.js`, `routes/admin.js`, `routes/agent.js` were NOT
edited (not D-FIX-A's files) — findings there are SPEC'd below.

### D2-C1 — FIXED (pre-auth TTL)

- Re-verified: password login with an existing anon session stashed
  `pending_user_id` onto a row with `expires_at-created_at =
  3,600,000 ms` — reproduced exactly as the finder reported.
- Fix: `lib/auth.js` `touchSession` gained ONE deliberate exception to
  R-121 — an explicit `opts.ttlMs` sets `expires_at = now + ttlMs` in
  the same UPDATE (ordinary touches still never move expiry). All
  three stash sites in `routes/auth.js` now pass it with
  `PREAUTH_TTL` and re-issue the cookie at the same 15-minute maxAge:
  password flow (`routes/auth.js:285ff`), Facebook callback stash
  (`:794ff`), Google callback stash (`:902ff`). (The no-prior-session
  password branch already created the session with `PREAUTH_TTL` and
  was left as-is.)
- Inverted proof: stashed row lifetime **900,110 ms** and **900,196
  ms** in two runs (was 3,600,000); cookie re-issued `Max-Age=900`;
  a stash artificially aged past expiry (`expires_at` set to the
  past) can no longer complete login — TOTP POST gets the
  session-less refusal, `GET /wallet` → 302, row deleted. Test C1.

### D2-C2 — FIXED (revocation now reaches pre-auth sessions)

- Re-verified: after a successful reset, the target's `user_id` rows
  went to 0 but the pre-auth row survived, and a fresh TOTP code on
  it completed a full login (`302 → /`, `GET /wallet → 200`) — with
  the OLD password's session, after the password had been reset.
- Session-store adjudication: a pre-auth row is `user_id = 0` and
  knows its pending user ONLY via the payload field
  `data.pending_user_id` (written by every stash site). Least
  invasive correct linkage: no schema change — `destroyUserSessions`
  (`lib/auth.js:32ff`) now, after its existing deletes, scans the
  `user_id = 0` rows (few by construction), parses the payload, and
  deletes those whose `pending_user_id` equals the target user,
  honouring `exceptId` identically. Because the fix is in the shared
  helper, EVERY caller inherits it: reset (`routes/auth.js`),
  password change / TOTP disable / backup regen / sessions-revoke /
  force-reset (`routes/player.js`), admin block / reset /
  revoke-sessions / TOTP disable (`routes/admin.js`) — none of those
  files needed edits.
- Inverted proof: user with 2 full sessions + 1 pre-auth session →
  genuine reset → **all** rows for that user gone (full and
  pre-auth), another user's unrelated session row untouched; the
  killed pre-auth jar's TOTP POST → 403 and `/wallet` → 302; a fresh
  full login with the NEW password + TOTP → 302, `/wallet` → 200.
  Test C2.

### D2-C3 — REPRODUCED, SPEC'd (files not owned by D-FIX-A)

Re-verified live on the player side: a fresh player enrolled TOTP
end-to-end (`totp/start` → secret read from the setup page →
`totp/confirm` with a computed code → `totp_secret` set, 8 backup
codes issued) with **no password supplied at any step**. The admin
twins are code-identical in shape (no password read in start or
confirm). Both surfaces belong to other workers' files, so the fix
is specified here for the coordinator, mirroring the EXISTING
re-auth pattern in the same files (disable/backup handlers: field
name **`password`**, check
`verifyPassword(req.body.password || '', u.password_hash || '')`,
failure = flash **`Wrong password.`** + redirect to the security
page):

SPEC D2-C3 (player — `routes/player.js` + `views/security.ejs`):
1. `routes/player.js:878` `POST /security/totp/start`: before
   generating the secret, load the user row and require the current
   password exactly as `:905` (disable) does:
   `const u = await req.db.get('SELECT * FROM users WHERE id = ?', [req.user.id]); if (!u || !verifyPassword(req.body.password || '', u.password_hash || '')) { await req.setFlash('error', 'Wrong password.'); return res.redirect('/security'); }`
   Passwordless accounts (no `password_hash` — OAuth/OTP signups):
   `verifyPassword` against `''` fails, which would lock them out of
   enrolment forever; the security view model already exposes
   `hasPassword` for exactly this. Rule: when the account has NO
   password, enrolment may proceed without one ONLY if the "Set a
   password" step is completed first OR the coordinator accepts
   session-only enrolment for passwordless accounts — recommend:
   refuse with the true reason ("Set a password first, then enable
   two-factor authentication.") via the same flash, since a
   passwordless account + attacker-enrolled TOTP is the same
   persistence hole. Owner decision needed on this one branch.
2. `routes/player.js:886` `POST /security/totp/confirm`: require the
   same `password` field again (the confirm form must carry it —
   see 3), checked the same way before `verifyTotp`. Checking at
   BOTH steps means a session stolen mid-enrolment cannot finish it.
3. `views/security.ejs`: the start form (currently just the "Set up
   2FA" button, ~line 65) gains a required password field
   (`name="password"`, label "Confirm your password", mirroring the
   disable form's field at ~line 19); the confirm form (~line 56)
   gains the same field. The setup re-render on a wrong confirm code
   already returns to the setup view, so the field persists across
   the retry.
4. Regression test for the owning worker: enrolment with NO
   password and with a WRONG password must leave `totp_secret`
   unset and `totp_pending` uncleared-for-use; with the CORRECT
   password it must succeed end-to-end.

SPEC D2-C3 (admin — `routes/admin.js`):
1. `routes/admin.js:3267` `POST /security/totp/start` and `:3280`
   `POST /security/totp/confirm`: same password requirement, same
   field name (`password`), same error style as the admin disable
   handler at `:3301` (flash `Wrong password.`, redirect
   `R(req, '/security')`). Admin accounts always have a password
   (seeded / staff-created with force-reset), so no passwordless
   branch is needed here. Confirm already carries the R-054
   rate limiter — keep it, and add the same limiter to start for
   parity while editing.
2. The enrol forms are inline HTML in `routes/admin.js:3264`
   (start) and `:3276ff` (confirm): add
   `<div class="field"><label>Password (to confirm)</label><input type="password" name="password" required></div>`
   to both, mirroring the disable form at `:3263`.

### D2-C4 — FIXED (captcha consumption persisted)

- Re-verified: custom captcha enabled; one solve on `GET /forgot`,
  two POSTs with the same answer and no new GET → `password_resets`
  rows for the user grew by 2 (a second live token minted on the
  replay).
- Adjudication: the captcha hash lives in the session payload
  (`data._captcha`), written by `newCaptcha` via `touchSession`;
  `checkCaptcha` nulled only the in-memory copy, and `loadSession`
  re-reads the row on every request, so the null never took effect.
- Fix: `verifyCaptcha` (`routes/auth.js:82ff`) now writes the null
  back through the session store — `touchSession(db, sid,
  { _captcha: null })` — on every non-`keepCustom` check, success or
  failure (the failure re-render generates a fresh question via
  `captchaHtml`, so legitimate users are never stuck; the OTP-request
  flow keeps its deliberate `keepCustom: true` exemption).
- Inverted proof: POST #1 mints exactly one token (rows 4 → 5),
  POST #2 with the same answer mints none (5 → 5) and does not
  return the "sent" page. Test C4. (Display note under Observations.)

### D2-C6 — REPRODUCED, SPEC'd (file not owned by D-FIX-A)

Re-verified live: 4× `POST /profile/verify-email` → 4 simultaneously
live (`used=0`) verification rows for the user. The handler is
`routes/player.js:758` — not D-FIX-A's file. SPEC D2-C6 for the
coordinator / player-file owner:
1. Invalidate priors before inserting (mirror R-030 / the admin
   path's R-014): immediately before the INSERT at `:762`, run
   `UPDATE email_verifications SET used = 1 WHERE user_id = ? AND used = 0`
   with `req.user.id`. Consuming any link already burns the rest
   (R-014 consume half in `routes/auth.js`), so post-fix at most one
   live link exists at any moment.
2. Rate limit consistent with sibling token flows: wrap the route
   with the existing limiter at the forgot-password generosity or
   tighter — recommended
   `rateLimit({ windowMs: 3600000, max: 5, keyFn: r => 'verify-email:' + r.user.id })`
   (per-USER, since the route is login-gated; forgot is 10/hr per
   IP, reset shares the 30/15-min login bucket). `rateLimit` is
   already imported in `routes/player.js`'s dependency set via
   `lib/auth` — check its import line when applying. On limit, the
   limiter's standard 429 page applies (no new message needed).
3. Regression test for the owning worker: 4 POSTs → exactly 1 live
   row (the latest); the 6th POST within the hour → 429.

### D2-C7 — FIXED (reset CSRF hole)

- Re-verified both halves pre-fix: (a) empty cookie jar, no `_csrf`
  → `POST /reset/<valid token>` returned **302 and changed the
  password**; (b) `GET /reset/:token` set **no session cookie** and
  rendered the form with an **empty** `_csrf` value — so the genuine
  flow itself was session-less.
- Fix: (1) `server.js:316ff` — the session-less refusal now also
  matches the parameterized path: `req.path.startsWith('/reset/')`
  joins the exact-match auth list. (2) `routes/auth.js:494ff` —
  `GET /reset/:token` now calls `anonSession(req, res)` after the
  token-validity check (the same helper GET /login, /register and
  /forgot use), so the emailed-link visitor arrives at the POST with
  a session cookie and the form's hidden `_csrf` (already present in
  `views/reset.ejs`) carries a real token; the POST then passes
  through the standard session CSRF check unchanged. No exemption
  was added and no message changed.
- Inverted proof: empty-jar tokenless POST → **403** "Security
  token mismatch", the token row stays `used=0`, the attack
  password gets the generic "Invalid credentials." and the real
  password still works. Genuine flow: GET → `Set-Cookie: sid`
  (Max-Age 3600) + non-empty `_csrf` in the form → POST → 302
  `/login`, password changed. Tests C7 + C2 (genuine half).

### D2-C8 — CLOSED as FIXED-BY-U-04b (with one stated caveat)

Re-ran the finder's forgery repro family against the current tree
(`server.js:126` already carries
`app.set('trust proxy', ['loopback','linklocal','uniquelocal'])`):
- Session-IP evidence (anon sessions created with each header):
  `X-Forwarded-For: 203.0.113.7, 10.26.103.5` → recorded IP
  **203.0.113.7** (the old bug recorded the internal hop
  10.26.103.5); `1.2.3.4, 203.0.113.7, 10.26.103.5` → **203.0.113.7**
  (spoofed prefix ignored, not recorded).
- Bucket minting: 31 requests on the chain-resolved bucket
  (`login:203.0.113.7`, via `/login/otp/request`) → 429 at #31; a
  subsequent attempt with a NEW spoofed prefix
  (`6.6.6.6, 203.0.113.7, 10.26.103.5`) → **still 429** — the
  forgery does not mint a fresh bucket.
- Residue check inside D-FIX-A's files: none. Every limiter keys
  off `req.ip` (`lib/auth.js` rateLimit) and every IP write
  (`recordLogin`, session creation, audit) uses `req.ip`; no code
  in `lib/auth.js`, `routes/auth.js` or `server.js` reads
  `X-Forwarded-For` (or any forwarding header) directly.
- Caveat, stated plainly (topology property, not a code residue):
  the finder's single value `10.9.9.9` still resolves as `req.ip`
  when it is the ONLY hop — `10.9.9.9` is itself a uniquelocal
  address and the test peer is loopback, so the whole chain sits
  inside the trusted ranges by definition of the U-04b trust list;
  a chain consisting solely of trusted hops resolves to its
  leftmost entry. In the real deployment the only peers in those
  ranges are the platform/local proxies, and a direct PUBLIC peer
  is untrusted, so its XFF is ignored entirely (proxy-addr
  semantics; a public socket peer cannot be originated from this
  sandbox, so that last clause is library-semantics, not locally
  measured). Test C8 covers the measured chains.

### D2-C9 (auth half) — FIXED; admin half PENDING (other worker)

- Re-verified: boot without `BASE_URL` (port 4137, dummy provider
  env, OAuth settings on) → `GET /auth/google` 302 carried
  `redirect_uri=%2Fauth%2Fgoogle%2Fcallback` (relative); Facebook
  identical.
- Fix: `routes/auth.js` gained the shared helper
  `baseUrl(req) = process.env.BASE_URL || (req.protocol + '://' + req.get('host'))`
  (the SCAN A-09 expression) at `:76ff`, applied to all four OAuth
  sites — Facebook start `:721`, Facebook callback `:743`, Google
  start `:816`, Google callback `:833` — and to the forgot-password
  link (`:489`), which previously inlined the same expression. No
  other `(BASE_URL || '')` remains in `routes/auth.js`.
- Inverted proof: on the no-BASE_URL boot, Google start now carries
  `redirect_uri=http://localhost:4137/auth/google/callback` and
  Facebook `http://localhost:4137/auth/facebook/callback`
  (absolute, built from the request host); with BASE_URL set the
  redirect_uri is BASE_URL + path, unchanged. Test C9.
- ADMIN HALF — PENDING, not D-FIX-A's file: `routes/admin.js:1014`
  (admin email-change link) and `routes/admin.js:1076` (admin
  reset-password link) still build `(process.env.BASE_URL || '') +
  path`, producing a bare `/reset/<token>` / `/verify-email/<token>`
  for the admin to forward when BASE_URL is unset. One-line each:
  replace with the same `BASE_URL || (req.protocol + '://' +
  req.get('host'))` fallback (or a shared helper if the coordinator
  prefers one home for it).

### Observations (outside the candidate list; no code changed)

1. `views/forgot.ejs` never renders `formError`: the handler sets
   `formError: 'Captcha verification failed.'` (and the POST /forgot
   handler's other reasons) but the template has no slot for it, so
   a refused forgot POST silently re-renders the bare form. Related
   to the owner's true-reason rule — coordinator may want the
   one-line template slot (`<% if (typeof formError !== 'undefined'
   && formError) { %><div class="flash f-err"><%= formError %></div><% } %>`,
   the pattern other form views already use). View file — not
   D-FIX-A's.
2. `views/login.ejs` contains no captcha markup at all: with the
   custom-captcha extension ON, `POST /login` demands an answer the
   login page never asks for (the handler passes `captchaHtml`, the
   template drops it). Pre-existing on the frozen snapshot too;
   view file — not D-FIX-A's. (All C1/C2/C7 proofs above were run
   with the extension OFF, its default state, matching the finder.)
3. Noted and left alone per the assignment: the `/withdraw/new`
   rate-cap gap and the player security-POST limiter gaps belong
   to another domain (the finder's Rate-Limit Coverage Map /
   Unproven Lead 2).

### Test summary

`node --test test/v20-discovery-auth.test.js` — 8 tests: C1, C2,
C7-attack, C4, C8, C9 PASS; C3 and C6 present as skipped
placeholders pointing at the SPECs above (their files are not
D-FIX-A's). Manual curl proofs for every item were run before the
automated ones and agree with them.

## D-FIX-B results

Cross-domain items from this file that live in D-FIX-B's files, plus the coordinator addendum (D2-C3, D2-C6, two view observations). Regression tests in `test/v20-discovery-fixes.test.js` (HTTP, port 4138, no BASE_URL).

- **C5 (blocked phone everywhere) — FIXED.** The register-time `isBlockedPhone` check now also runs at: POST /profile phone save (routes/player.js), agent create-player (routes/agent.js), and admin user edit (routes/admin.js, checked BEFORE the UPDATE so nothing is saved on refusal). Same true reason everywhere: "Phone numbers from this country are not accepted on this platform." Test: with IN blocked, a profile change to +91 is refused with that message and the stored phone is untouched.
- **C9 admin half — FIXED.** The two admin-generated links (user email-change verify link and admin-triggered password-reset link, routes/admin.js) now use `(process.env.BASE_URL || (req.protocol + '://' + req.get('host')))` — the A-09 fallback D-FIX-A applied in auth.js. Test: with BASE_URL unset, the admin-triggered reset email carries an absolute `http://localhost:4138/reset/<token>` link. (Note: that handler also destroys the user's sessions by design; the test re-logs the player in afterwards.)
- **Rate gaps — FIXED.** POST /withdraw/new gained the deposit sibling's limiter (10/min per user, key `withdraw:<id>`). Player security POSTs gained one shared limiter mirroring the admin twins (10 per 15 min per user, key `player-security:<id>`) applied to /security/password, /security/totp/start|confirm|disable|backup, /security/sessions/revoke and /force-reset. Tests: the 11th rapid /withdraw/new POST is 429; the 11th rapid security POST is 429; spaced legitimate use works throughout the rest of the suite.
- **C3 (addendum — TOTP enrolment re-auth) — FIXED, including the passwordless branch.** Player totp/start + totp/confirm (routes/player.js) and the admin twins (routes/admin.js; start also gained the admin-totp rate limiter it lacked) require the current password, mirroring the existing disable/backup pattern exactly (field `password`, `verifyPassword`, flash "Wrong password."). Views: password fields added to the player enrol/confirm forms (views/security.ejs) and both admin inline forms. Passwordless accounts (password_hash NULL): a set-password path DOES exist in the account area (/security "Set a password" card → POST /security/password), so per the branch rule the refusal is implemented, not left open: "Set a password on your account before enabling two-factor authentication." Tests: no/wrong password refused with no secret stored (player AND admin), correct password enrols and confirms with a valid code; a NULL-hash account gets the set-a-password refusal.
- **C6 (addendum — verify-email discipline) — FIXED.** POST /profile/verify-email (routes/player.js) invalidates prior unconsumed tokens before issuing (`UPDATE email_verifications SET used = 1 WHERE user_id = ? AND used = 0`, the R-014/R-030 pattern) and gained the per-user limiter in exactly the spec'd shape: `rateLimit({ windowMs: 3600000, max: 5, keyFn: req => 'verify-email:' + req.user.id })` — the codebase's limiter signature matched the spec, no adaptation needed. Tests: after a second issuance exactly one live token remains; the 6th POST within the hour is 429.
- **View observation (a) — FIXED.** views/forgot.ejs never rendered `formError` although the route supplies it; a flash-style slot in the page's existing style was added. Test: with the custom-captcha extension ON, a wrong-answer forgot POST now shows "Captcha verification failed." on the page.
- **View observation (b) — FIXED in the view; no route change needed.** Adjudication: the login route DOES pass `captchaHtml`/`recaptchaHtml` on GET and on POST re-renders (the TOTP step passes '' deliberately and is captcha-exempt server-side per R-002), so the fix was purely views/login.ejs: `<%- captchaHtml %>` / `<%- recaptchaHtml %>` added inside the password form in the same style as forgot/register. Test: with the extension ON, GET /login now contains the captcha field the POST demands.
