# Audit W — auth / webhooks / identity (Cash Pop v17 recovery re-audit)

- Area: W — routes/auth.js, routes/webhooks.js, lib/otp.js, lib/auth.js,
  lib/breached.js, lib/credentials.js, lib/phone-countries.js, lib/validate.js
  (plus the directly adjacent code those files depend on: server.js CSRF
  middleware, lib/rails.js webhook verification, lib/util.js phone/email
  normalisation, public/app.js OTP/login frontend, views/login.ejs).
- Baseline: fix copy in ~/workspace/cash-pop-fix, which already contains
  round-1 fixes. No code file was modified by this audit (audit only).
- Exclusions honoured: every item in FIX-LOG.md (OAuth gate
  `oauthAccountCheck`, OTP template seeds, the 19 old Critical/High items)
  and every B-001..B-235 item was NOT re-reported. §2 headlines from
  NEW-BUGS-217.md that re-verified are marked "(§2 re-confirmed)"; W-17 is
  noted, not double-counted (G covers it — see note under W-31).
- Method: each finding below was verified by reading the cited code (and,
  for W-13, by executing the shipped `isBlockedPhone`/`countryForDialNumber`
  functions). Line numbers are from the fix copy as read. No line number
  was guessed.
- Tally (confirmed only): **32 findings = 1 Critical, 5 High, 16 Medium,
  10 Low.**

## Findings

### W-01 — Critical — Pre-auth TOTP session is already a fully authenticated session (2FA bypass when no prior session exists)
- routes/auth.js:175: on password success with `totp_secret` and no existing
  session, `createSession(req.db, u.id, { …, extra: { pending_user_id: u.id,
  pre_auth: true } })` — the session's `user_id` is the real user id, and the
  `sid` cookie is set (15 min).
- lib/auth.js:160-166 (`loadSession`): a session resolves `req.user` for any
  `user_id != 0` whose account is not `banned`; nothing checks `pre_auth` or
  `pending_user_id`. server.js forced-action/profile gates likewise never
  check `pre_auth` (verified by grep: `pre_auth` appears only in
  routes/auth.js).
- Consequence: with no prior session (the normal case when custom captcha is
  OFF, since login GET only creates an anon session when custom captcha is
  on — routes/auth.js:94-96), an attacker who passes only the password can
  ignore the rendered TOTP page, reuse the `sid` cookie, and browse as the
  user — TOTP is bypassed entirely. The anon-session path (existing session
  with `user_id = 0`, routes/auth.js:182) is safe; only the no-session path
  is broken.
- Fix pointer: create the pending session with `user_id = 0` (like the anon
  path) and have `loadSession`/gates treat `pre_auth` sessions as
  unauthenticated until the TOTP step completes.

### W-02 — High — TOTP second step has no UI input and is blocked by the captcha re-check
- views/login.ejs: the template never branches on `totpRequired` (grep:
  `totpRequired` appears in routes/auth.js renders only); the TOTP renders
  at routes/auth.js:178-187 pass `totpRequired: true` but the page still
  shows only the password form — there is no input named `totp_code`.
- routes/auth.js:122: `verifyCaptcha(req)` runs before the TOTP branch
  (routes/auth.js:125). The TOTP renders pass `captchaHtml: ''`, so a
  second-step POST carries no captcha answer and no provider token; with
  any captcha enabled, `verifyCaptcha` (routes/auth.js:74-83) fails and the
  user is bounced to the password form with "Captcha verification failed."
- Consequence: a TOTP-enrolled user cannot complete sign-in through the
  shipped UI at all when any captcha is enabled, and has no visible TOTP
  field even when captcha is off (must hand-craft a POST).
- Fix pointer: render a real TOTP form (input `totp_code` + session CSRF)
  and skip `verifyCaptcha` for the pending-TOTP step (the password step
  already passed it).

### W-03 — High — Phone OTP is dead: frontend sends `type`, server reads `id_type`
- public/app.js:437,449,458: OTP request/verify/resend fetch bodies use
  `{ type: type, identifier, code }`.
- routes/auth.js:382,409: `const idType = req.body.id_type === 'phone'
  ? 'phone' : 'email'` — `type` is never read, so `idType` is always
  `'email'`.
- Consequence: phone OTP via the shipped UI is always routed to the email
  branch; a `+1555…` identifier fails `validEmail` and returns 400 "Enter a
  valid email." Email OTP works; phone OTP never sends or verifies.
- Fix pointer: accept `req.body.type` as an alias for `id_type` in both
  OTP handlers (and add a contract test).

### W-04 — High — (§2 re-confirmed W-32) Webhook amount check ignores currency
- routes/webhooks.js:36-37: `parseEvent` extracts `currency` from the
  payload, but routes/webhooks.js:87-91 computes `amountOk` from amounts
  only: `(Math.round(ev.amount) === depAmt) ||
  (Math.round(ev.amount * 100) === depAmt)`. `dep.currency` is never
  compared to `ev.currency` (the parsed currency appears only in the
  mismatch log string).
- Consequence: a €10 (or any-currency 10) provider payment auto-approves a
  $10 deposit, and vice versa — real money credited in the wrong currency
  at the wrong value.
- Fix pointer: require `ev.currency` (when present) to equal
  `dep.currency`, and fail closed (manual review) when it is absent or
  mismatched.

### W-05 — High — Webhook amount check accepts BOTH minor and major units, so a 100x smaller payment matches
- routes/webhooks.js:87-91 (same check as W-04): the `||` accepts the
  payload as minor units OR as major units ×100, with no per-rail unit
  knowledge.
- Consequence: a real 10-minor-unit payment ($0.10 on a minor-unit rail)
  satisfies `Math.round(10 * 100) === 1000` and auto-approves a $10 deposit
  when the reference matches (the exact reference-echo attack the v16
  amount check was meant to stop, at 1% of the amount). Symmetrically a
  major-unit 10 matches a 10-minor deposit.
- Fix pointer: decide the unit per rail (Stripe-style rails: minor only;
  PayPal-style: major only) and check exactly one interpretation.

### W-06 — High — (§2 re-confirmed W-33) Webhook status classification uses substring regexes
- routes/webhooks.js:28-30:
  `if (/(paid|success|completed|approved|captured)/.test(typeRaw))
  action = 'payment_success'; else if
  (/(refund|chargeback|reversed|failed)/.test(typeRaw)) action = 'refund';`
  where `typeRaw` is the lowercased `event`/`type`/`status` field.
- Consequence, verified against real provider vocab: `unpaid` contains
  `paid` → approved as payment_success; `payment_failed` → refund/revoke
  (an approved deposit gets revoked on a failed payment); Stripe
  `payment_intent.succeeded` / `charge.succeeded` match NEITHER regex
  (`succeeded` ≠ `success`) → `unknown`, so genuine Stripe successes
  never auto-approve (fail-closed, but the rail is functionally dead).
- Fix pointer: classify on an exact per-provider event/status allowlist,
  never substring regexes.

### W-07 — Medium — Password login fully enumerates accounts and their status
- routes/auth.js:161,165,167,168 return four distinct messages for the
  same endpoint: "No account found with this …", "Invalid credentials.",
  "This account has been blocked.", "Your account is pending review."
- Consequence: anyone can probe email/phone lists to learn which
  identifiers exist and whether each account is banned or pending review.
  (OTP login does not enumerate; password login does.)
- Fix pointer: return one generic "Invalid credentials." for
  not-found/wrong-password/banned/pending on the password path (status
  detail only after successful authentication, if at all).

### W-08 — Medium — No per-account password lockout; only the TOTP step checks failure history
- routes/auth.js:131-137: the TOTP branch counts `login_history` failures
  (≥10 in 15 min refuses verification). The password branch
  (routes/auth.js:157-165) never reads that count — `recordLogin` writes
  failures but nothing gates on them before the password check.
- Consequence: a distributed password-guessing attack against one account
  is limited only by the per-IP limiter (30/15 min, lib/auth.js:59-71);
  rotating IPs guesses without bound. The TOTP-branch `try {}` also
  swallows DB errors and proceeds to verify (fail-open on DB error).
- Fix pointer: apply the same per-account failure count (or a progressive
  delay) to the password branch, and fail closed if the count query errors.

### W-09 — Medium — OTP request has no captcha and accepts arbitrary identifiers
- routes/auth.js:381-408: `/login/otp/request` calls `otpLib.createOtp`
  and `sendOtp` with no `verifyCaptcha` call (unlike POST /login and
  POST /register). It creates an OTP row for any syntactically valid
  identifier, whether or not an account exists.
- Consequence: SMS/email bombing and provider-cost abuse against any
  phone/email at the IP limiter's rate (30/15 min shared with login), even
  when the operator enabled captcha precisely to stop abuse. This is the
  OTP-request-abuse half of §2 W-4.
- Fix pointer: require the same captcha (or at least the session CSRF +
  captcha) on OTP request, and consider not sending to identifiers with
  no account unless OTP auto-registration is explicitly intended.

### W-10 — Medium — Password-reset tokens are never invalidated except the one used
- routes/auth.js:328-330: each `/forgot` POST inserts a new
  `password_resets` row (1 h expiry). routes/auth.js:355 marks only the
  presented row `used = 1`; no code deletes or marks used the user's other
  outstanding tokens, on new request or on successful reset.
- Consequence: after a victim resets via one link, every other outstanding
  link (requested earlier, e.g. phished or leaked) stays valid for its full
  hour and can reset the password again — including after the victim has
  "recovered" the account. `destroyUserSessions` on reset does not help,
  because the stale token itself survives.
- Fix pointer: on any successful reset, mark all other unused tokens for
  that user used; also invalidate outstanding tokens when a new one is
  issued (or keep only the latest).

### W-11 — Medium — Webhook deposit matching ignores the deposit's method/rail, and pending beats exact match
- routes/webhooks.js:73-75: `SELECT * FROM deposits WHERE provider_txn_id
  = ? OR LOWER(user_data) LIKE LOWER(?) … ORDER BY CASE WHEN status =
  'pending' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`. No condition on
  `deposits.method_id`, `deposits.currency`, or the webhook rail.
- Consequence: a webhook on one rail can approve/revoke a deposit created
  for a different payment method if the reference matches (e.g. via the
  user_data LIKE arm); and a pending LIKE-match outranks an exact
  `provider_txn_id` match that is already approved, so the wrong deposit
  is acted on first.
- Fix pointer: prefer exact `provider_txn_id` matches, then require the
  matched deposit's method rail to equal the webhook rail (and currency
  to match, with W-04).

### W-12 — Medium — Phone normalisation does not handle 00/011 prefixes or trunk 0, splitting one number into several identities
- lib/util.js:77-83 (`normalizePhone`): strips non-digits but keeps a
  leading `+` only if the original string started with `+`. Verified:
  `'00315551234567'` → `'00315551234567'`, `'01115551234567'` →
  `'01115551234567'`, `'+44 07700 900123'` → `'+4407700900123'` (trunk 0
  kept, vs the canonical `+447700900123`).
- Consequence: the same real number can register as distinct accounts
  (`+1555…`, `0031555…`, `+4407700…` vs `+447700…`), defeating the
  duplicate-phone check (routes/auth.js:295-298) and the OTP-login `+/-`
  alternate lookup (routes/auth.js:419-421, which only handles the `+`
  variant). 00-prefixed numbers are additionally rejected at registration
  because `isBlockedPhone` finds no dial match for `00…` and fails closed
  (verified: `+001…` → blocked, and `+82…`/`+852…`/`+853…` → blocked for
  the same reason, see W-13).
- Fix pointer: in `normalizePhone`, convert leading `00` (and NANP `011`)
  to `+`, and strip the trunk `0` after a known country dial code.

### W-13 — Medium — (§2 re-confirmed W-42) COUNTRIES table missing ~50 territories plus KR/HK/MO
- lib/phone-countries.js:5-59: `COUNTRIES` has 190 entries. Verified
  absent by direct check: KR (dial 82), HK (852), MO (853) and territories
  PR, GU, VI, AS, MP, BM, KY, TC, VG, AI, MS, SH, FK, GI, JE, GG, IM, FO,
  GL, AX, SJ, AQ, BV, HM, CC, CX, NF, NU, TK, WF, PN, CK, GS, IO, TF, UM,
  EH, XK, NC, PF, YT, RE, MQ, GP, BL, MF, PM, CW, SX, BQ, AW.
- Consequence, verified by executing the shipped functions with an empty
  blocklist: `+821012345678`, `+85291234567`, `+85366123456` all return
  `isBlockedPhone = true` and `countryForDialNumber = null` — users in
  South Korea, Hong Kong and Macau cannot register at all (fail-closed
  on unknown dial). Territory users (e.g. PR +1787) can only pick a wrong
  country (US +1), so per-territory blocking via `blocked_phone_countries`
  is impossible for them.
- Fix pointer: add the missing ISO entries with correct dial codes
  (82, 852, 853, 1787, 1671, 1340, etc.).

### W-14 — Medium — (§2 re-confirmed W-30) Twilio sendOtp returns sent:true without checking the response
- lib/otp.js:62-71: the Twilio branch `await fetch(…Messages.json…)` and
  then unconditionally `return { sent: true, via: 'sms' }` — no `res.ok`,
  no status, no body check. (Contrast lib/notify.js `sendSms`, which
  throws on `!res.ok`.)
- Consequence: a rejected Twilio send (bad credentials, invalid number,
  insufficient balance) is reported to the user as "code sent" (and audit
  logged `sent: true`, routes/auth.js:398), while no code ever arrives —
  the user is locked out of OTP login with a misleading success. The
  audit log's `sent` field is untrustworthy for SMS.
- Fix pointer: parse the Twilio response and return `sent: true` only on
  2xx with a message SID; otherwise `sent: false`.

### W-15 — Medium — (§2 re-confirmed W-31) TextBelt without a key falls back to the public shared key
- lib/otp.js:55: `key: process.env.TEXTBELT_KEY || 'textbelt'`.
- Consequence: with `SMS_PROVIDER=textbelt` and no key, every login code
  is sent through TextBelt's public shared quota (1 SMS/day, shared with
  the whole internet) — quota exhaustion denies OTP login to all users,
  and code-bearing SMS content transits a public test key. The code
  checks `j.success` (lib/otp.js:58), so a quota-exhausted response does
  fall through, but the shared-key path itself is the exposure.
- Fix pointer: require an explicit `TEXTBELT_KEY` (fail closed with
  `sent: false` when unset) and warn in admin UI when the shared key
  would be used.

### W-16 — Medium — (§2 re-confirmed W-4, session-less half) Global CSRF skips session-less POSTs, so login/forgot/logout CSRF works
- server.js:257-265: CSRF middleware returns `next()` when `!req.sess`
  ("nothing to forge against"). With `SameSite=lax` cookies
  (routes/auth.js:19,176,203), a cross-site POST does NOT carry the
  victim's `sid` cookie, so `req.sess` is null on exactly the forged
  requests the middleware is meant to stop.
- Consequence: login CSRF (victim forged into the attacker's account,
  then deposits into it thinking it is theirs), forgot-password CSRF
  (reset-email spam to an arbitrary address, burning the victim-IP
  quota), and logout CSRF all bypass the check. Session-less state
  changes that genuinely need no session (`/forgot` for a logged-out
  user) need a different defence (captcha/rate limit), not a skip.
- Fix pointer: require an anon-session CSRF token for logged-out
  state-changing forms (create the anon session on GET for login,
  register AND forgot, not only when custom captcha is on), or exempt
  only named safe endpoints.

### W-17 — Medium — (§2 W-4/W-5, OTP half) OTP JSON endpoints 403 when a session exists, because the frontend sends no CSRF token
- server.js:257-265: with a session, every POST must pass `checkCsrf`
  (body `_csrf` or `x-csrf-token` header, lib/auth.js:45-55).
- public/app.js:437,449,458: OTP request/verify/resend send neither; only
  complete-profile (public/app.js:469) sends `x-csrf-token`.
- Consequence: any visitor who has a session — e.g. an anon session from
  login GET when custom captcha is on (routes/auth.js:94-96), or any
  logged-in user — gets HTML 403 "Security token mismatch" on OTP
  request/verify, which the JSON client cannot parse (falls back to a
  generic error). OTP login works only in the no-session case, i.e. the
  CSRF rule and the OTP client disagree about which state is normal.
- Fix pointer: have the OTP client send the session CSRF token (or give
  the OTP endpoints a dedicated, documented exemption with their own
  captcha + rate limits — not a silent skip).

### W-18 — Medium — (§2 re-confirmed W-24) Shared rate limiter renders HTML 429 even for JSON endpoints
- lib/auth.js:59-71 (`rateLimit`): on excess it always does
  `res.status(429).render('error', …)` — HTML, regardless of
  `Accept`/`Content-Type`.
- Consequence: `/login/otp/request` and `/login/otp/verify` (both behind
  `loginLimiter`, routes/auth.js:381,408) return an HTML error page on
  rate limiting; the JSON client (`r.json().catch(() => ({}))`) loses
  the message and shows a generic failure, and API consumers cannot
  distinguish "rate limited" from other failures. Same shape as W-17
  but a distinct code path (limiter vs CSRF middleware).
- Fix pointer: in `rateLimit`, return JSON `{ ok: false, error:
  'Too many requests…' }` when the request is JSON (Content-Type or
  Accept), HTML otherwise.

### W-19 — Medium — Signup-code consume is non-atomic and runs before duplicate checks, so codes are double-spendable and burnable
- routes/auth.js:235-243 (`consumeOtpCode`): SELECTs all unrevoked,
  unexpired rows, checks `r.uses < r.max_uses` in JS, then
  `UPDATE otp_codes SET uses = uses + 1` with no `uses < max_uses` guard
  and no transaction. Two concurrent registrations with the same code
  (default `max_uses = 1`, migrations.js:150) can both pass the check
  and both consume.
- routes/auth.js:285 vs 290-298: the code is consumed BEFORE the
  email/phone duplicate checks, so a registration that then fails as a
  duplicate still burns a single-use operator code.
- Fix pointer: consume with one guarded
  `UPDATE … SET uses = uses + 1 WHERE id = ? AND uses < max_uses` and
  check `changes === 1`; move consumption after all validation that can
  fail (duplicates included), or refund the use on failure.

### W-20 — Medium — OTP verification, TOTP backup codes, and per-code attempt caps are all check-then-act races
- lib/otp.js:100-114 (`verifyOtp`): SELECTs the latest `verified = 0`
  row, increments `attempts`, then `UPDATE … SET verified = 1` with no
  `verified = 0` guard — two parallel verifies of the same code can
  both return `ok: true` (single-use code used twice). The `attempts >=
  5` gate (lib/otp.js:105) is likewise checked before the increment, so
  parallel guesses can exceed the cap.
- routes/auth.js:139-140: backup-code redemption reads `u.backup_codes`,
  splices in JS, and writes back unconditionally — two parallel requests
  with the same backup code both succeed (same pattern as W-19).
- Fix pointer: claim codes/codes atomically (guarded UPDATEs checked via
  `changes`, or a transaction with a row lock on Postgres/MySQL and
  BEGIN IMMEDIATE on SQLite).

### W-21 — Medium — `pending_review` does not terminate existing sessions; only `banned` does
- lib/auth.js:160-166 (`loadSession`): `if (u && u.status !== 'banned')
  req.user = u; else destroySession…`. A user moved to `pending_review`
  keeps every existing session until its 7-day expiry.
- Consequence: an admin's hold/review action does not stop the account
  from playing, depositing or withdrawing through an already-logged-in
  session — the login-time block (routes/auth.js:168) only stops NEW
  logins.
- Fix pointer: destroy sessions (or refuse `req.user`) for
  `pending_review` exactly as for `banned`, or add a session-revocation
  step to the status-change handler.

### W-22 — Medium — Captcha verification silently skips providers with no secret, and provider calls have no timeout
- routes/auth.js:74-83 (`verifyCaptcha`): `if (!extEnabled(ext) ||
  !ext.config.secret_key) continue;` — an operator who enables reCAPTCHA/
  hCaptcha/Turnstile and sets only a site key gets the widget rendered
  (routes/auth.js:45-55 renders on `site_key`) but zero verification.
- routes/auth.js:57-68 (`verifyProvider`): `fetch(…)` with no
  `AbortSignal`/timeout (contrast lib/breached.js:20-24, which aborts at
  2.5 s) — a hung provider hangs the login/register request.
- Also low-weight: custom captcha answers are 4–16 (two dice 2–8,
  routes/auth.js:25-26), i.e. 13 possibilities — trivially guessable
  without the rate limiters.
- Fix pointer: fail closed when a provider is enabled but its secret is
  missing (or refuse to render the widget); add a 3–5 s timeout to
  `verifyProvider`.

### W-23 — Low — Terms acceptance is checked but never recorded
- routes/auth.js:282: registration requires `agree` when
  `policy_agreement` is on, but the INSERT (routes/auth.js:306) stores
  no terms flag/timestamp; complete-profile likewise only sets
  `name`/`profile_completed` (routes/auth.js:496); OAuth creates users
  (routes/auth.js:543,608) with no terms step at all.
- Consequence: there is no evidence of when (or whether) any user
  accepted the terms — the check is unenforceable after the fact and
  cannot be shown for a dispute or a terms change.
- Fix pointer: add `terms_accepted_at` to users and set it on register,
  complete-profile, and first OAuth login.

### W-24 — Low — Breached-password check fails open by design (documented, but a real hole)
- lib/breached.js:20,24: on non-OK HIBP response or any fetch error
  (including the 2.5 s timeout abort), `isBreached` returns `false`.
  The file header states this is deliberate ("never break offline").
- Consequence: whenever HIBP is unreachable, registration and password
  resets (routes/auth.js:278-279,350-351) accept known-breached
  passwords silently. This is a deliberate trade-off, not a hidden bug —
  recorded here so the choice is explicit.
- Fix pointer: keep fail-open only when the setting is off; otherwise
  fail closed (or warn + require a stronger password) when HIBP cannot
  be reached, at least for admin/agent passwords.

### W-25 — Low — Webhook endpoint has no rate limit, and dedup is check-then-insert with a global event_id scope
- routes/webhooks.js:45-61: no `rateLimit` middleware on
  `POST /:rail`; every request (even signature failures) runs DB queries
  and writes an `audit.log` row (routes/webhooks.js:56) — unauthenticated
  log/DB flooding.
- routes/webhooks.js:61,118: duplicate check (`SELECT … WHERE event_id
  = ?`) then later `INSERT INTO webhook_events` are not atomic; the
  table's `event_id UNIQUE` (migrations.js:665) is the only backstop, and
  a concurrent duplicate's INSERT throws an unhandled 500 AFTER any
  approve/revoke side effect. The dedup SELECT also has no provider
  filter, so the same event id (or the same raw-body hash fallback,
  routes/webhooks.js:60) on a different rail is wrongly dropped.
- Fix pointer: rate-limit the webhook route, insert-then-process (or
  handle the UNIQUE violation as "duplicate"), and scope dedup by
  provider.

### W-26 — Low — Forgot-password has no captcha; reset POST has no rate limit at all
- routes/auth.js:324: `/forgot` has only the IP limiter (10/hour);
  no captcha, so reset emails can be triggered at that rate for any
  address. routes/auth.js:341: POST `/reset/:token` has no limiter
  whatsoever (token guessing is infeasible at 192 bits — randHex(24) —
  so this is defence-in-depth only, not a practical brute-force hole).
- Fix pointer: add captcha to `/forgot` and the shared limiter to
  `/reset/:token`.

### W-27 — Low — Phone password login breaks without JavaScript
- views/login.ejs:39: the identifier input is named `email`.
  public/app.js:381-386 renames it to `phone` only when the value has
  no `@`, via a submit listener. routes/auth.js:157-160 looks up by
  email whenever `body.email` is present, by phone only otherwise.
- Consequence: with JS disabled (or any non-browser client posting the
  form as rendered), a phone sign-in is looked up as an email, fails
  with "No account found", and the user cannot sign in by phone.
- Fix pointer: on the server, route the identifier to the phone lookup
  when it contains no `@` (mirror the JS rule server-side).

### W-28 — Low — OTP and signup codes are stored as unsalted fast hashes
- lib/otp.js:41: login codes hashed as `sha256('otp:' + code + ':' +
  identifier)`; routes/auth.js:239 and routes/admin.js:614-615: signup
  codes as `sha256('otp:' + code)` (admin codes are 8 hex chars,
  routes/admin.js:612).
- Consequence: a DB read lets an attacker brute-force the entire
  6-digit login-code space (or 32-bit signup-code space) offline in
  seconds and use any unexpired code — unlike passwords, which use
  scrypt (lib/util.js: hashPassword). Expiry (10 min / operator hours)
  bounds, but does not remove, this.
- Fix pointer: hash OTP/signup codes with scrypt (or at least a
  server-side pepper via HMAC) like passwords.

### W-29 — Low — Credential-key validation accepts weak keys; webhook decrypt failure silently falls back
- lib/credentials.js:17-24 (`getKey`): any 32-byte base64 string is
  accepted, including all-zero/low-entropy keys; `Buffer.from(raw,
  'base64')` silently ignores invalid characters, so a malformed key
  string that happens to decode to 32 bytes is accepted.
- routes/webhooks.js:50-52: a `decryptField` failure is caught and the
  credential becomes `''`, then `m.webhook_secret` falls back to
  `api_token`/`secret_key` (routes/webhooks.js:53) — a key rotation or
  corruption failure is masked instead of alerting.
- Consequence: weak-key deployments and silent webhook-secret loss are
  both possible without any operator-visible error (verification then
  fails closed, but the cause is hidden).
- Fix pointer: reject all-zero/known-weak keys at configuration time,
  and log (audit) a decrypt failure instead of silently substituting.

### W-30 — Low — Successful TOTP logins are never written to login_history
- routes/auth.js:195-206 (`finishLogin`) writes no `login_history` row;
  the password branch records success only on the non-TOTP path
  (routes/auth.js:188), and the TOTP branch (routes/auth.js:125-147)
  records failures only (routes/auth.js:142). OTP-verify logins DO
  record success (routes/auth.js:447).
- Consequence: the per-account failure counting in W-08 and any
  login-history review have a hole exactly for 2FA users — their
  successful logins are invisible in that table.
- Fix pointer: call `recordLogin(req, u.id, …, true)` inside
  `finishLogin` (or on TOTP success) for all paths.

### W-31 — Low — Email-verification token is burned before the duplicate check
- routes/auth.js:367-373: `/verify-email/:token` marks the row `used = 1`
  (line 369) BEFORE checking whether another account already owns
  `new_email` (lines 371-372, the round-1 B-174 guard).
- Consequence: if the address was taken between issuance and click, the
  legitimate token is consumed and the user must obtain a fresh link,
  even though no swap happened. (The swap itself is correctly refused.)
- Note (not double-counted): the §2 W-17/G-5 issue — admin email-change
  leaving prior pending verification rows live so an older token can
  swap back — is G's item; it is NOT counted here, only noted because
  this route is where the stale token would be consumed.

### W-32 — Low — Facebook OAuth creates an account with an empty email
- routes/auth.js:543-545: when Facebook returns no email, the INSERT
  uses `''` for the email column (`profile.email ? … : ''`).
- Consequence: the first such user owns the `''` email (UNIQUE column);
  a second no-email Facebook sign-in fails the INSERT with a 400
  ("Facebook sign-in failed"), and the `''` account can later collide
  with email-based lookups and the empty-phone/empty-email ambiguity in
  password login (routes/auth.js:157-160).
- Fix pointer: refuse Facebook sign-in without an email (or assign a
  unique unroutable placeholder like the OTP-phone pattern at
  routes/auth.js:434-436).

## Checked and clear (verified NOT bugs — do not re-report)

- **OAuth banned/pending/TOTP gate (round-1 fix, intact):** `oauthAccountCheck`
  (lib/auth.js:208-214) is called in both callbacks (routes/auth.js:550-558
  Facebook, 616-629 Google), before mutation on the Google path; TOTP
  users get the pending stash. Facebook/Google state checks are strict
  and single-use (routes/auth.js:525-527, 596-598): missing stored state
  fails, state is cleared after check.
- **OTP login strictness:** OTP verify refuses staff roles, banned and
  pending_review accounts, and TOTP-enrolled accounts
  (routes/auth.js:443-446); it does not bypass 2FA via OTP.
- **OTP demo-mode hole (closed):** `sendOtp` never returns the code and
  the request handler returns 503 when `sent` is false
  (routes/auth.js:398-405, lib/otp.js:76,84).
- **OTP caps:** 5 requests/identifier/hour and 15 failed verifies/hour
  plus 5 attempts per code (lib/otp.js:21-22,100-106) — the caps exist;
  W-20 is about their atomicity, not their absence.
- **Password hashing:** scrypt with random salt and timing-safe compare
  (lib/util.js hashPassword/verifyPassword) — sound.
- **TOTP verification window:** ±1 step with timing-safe compare and
  6–8 digit format check (lib/auth.js:95-104) — sound.
- **Session rotation on login:** `finishLogin` creates a new session and
  destroys the old one (routes/auth.js:195-199) — sound, except for the
  pre-auth session itself (W-01).
- **Banned sessions are killed:** `loadSession` destroys the session of
  a banned user on next request (lib/auth.js:165-170) — sound; W-21 is
  about `pending_review` only.
- **CSRF token comparison:** length-checked before `timingSafeEqual`
  (lib/auth.js:45-55, v16 fix) — sound; W-16/W-17 are about coverage, not
  comparison.
- **Webhook signature verification (shape):** HMAC-SHA256 over the raw
  body against every enabled method's secret, fail-closed with no secret
  or no header (lib/rails.js:131-160, routes/webhooks.js:54-57) — sound
  as far as it goes; W-04/W-05/W-06/W-11 are about what happens AFTER a
  signature passes, and per-provider signature formats remain needs-check
  (see below).
- **Webhook LIKE escaping:** `%`, `_`, `\` in refs are escaped
  (routes/webhooks.js:71-72) — sound for those metacharacters; W-11 is
  about method/precedence, and a `"`-containing ref can still span JSON
  fields (not counted separately — folded into W-11's matching weakness).
- **Credential encryption fail-closed on save:** admin credential save
  refuses without `CREDENTIAL_ENCRYPTION_KEY` (routes/admin.js:1044-1052)
  — sound; W-29 is about key strength and the webhook decrypt fallback.
- **Forgot-password response:** always renders `sent: true`
  (routes/auth.js:324-335) regardless of account existence — no
  enumeration there (contrast W-07 on the login path).
- **Reset destroys sessions:** successful reset calls
  `destroyUserSessions` (routes/auth.js:356-357) — sound; W-10 is about
  surviving reset TOKENS, not sessions.
- **Phone dial blocking (round-1 B-177 fix, intact):** longest-prefix
  dial matching, unknown dials fail closed, shared dials (1, 7) block as
  a group, explicit country can only add a block
  (lib/phone-countries.js:64-90) — sound; W-12/W-13 are about
  normalisation and table completeness, not the blocking logic.
- **Validate password minimums:** players 8 / agents 10 / admins 12
  (lib/validate.js:17-27) with composition when `secure_password` is on
  — sound as a policy (reset path uses it, routes/auth.js:347-349).
- **Trust proxy:** server.js:117 sets `trust proxy` 1, so `req.secure`
  and cookie `secure` flags behave behind the Render TLS terminator —
  the cookie-secure concern was checked and is not a finding.
- **Profile-completion persistence (v16, intact):** gate reads the
  persistent `profile_completed` flag (server.js profile gate), not just
  the session flag — sound; W-23 is about terms evidence, not the gate.

## Needs-check (NOT counted)

- **W NC-1 (from §2 §4):** `X-Forwarded-For` / trust-proxy exploitability
  of IP-based rate limits (login/forgot/OTP limiters key on `req.ip`).
  Trust proxy is 1 (server.js:117); whether an attacker can spoof
  `X-Forwarded-For` through the actual Render front-end was not verified
  here.
- **W NC-2 (from §2 §4):** Google `verified_email` absent from the profile
  payload — routes/auth.js:606 only refuses an explicitly `false` value;
  if Google ever omits the field, an unverified address would be trusted
  and marked `email_verified = 1` (routes/auth.js:608,623-626). Provider
  behaviour not verified.
- **W NC-3 (from §2 §4):** 00-prefix SMS delivery — whether Twilio/TextBelt
  accept `00…` numbers. W-12 covers the identity/normalisation side,
  which is verified; delivery itself was not tested live.
- **W NC-4 (from §2 §4):** provider webhook signature vocab — PayPal,
  crypto and other rails may use signature schemes (certificates,
  base64, query-string) that lib/rails.js:138-148 does not implement, so
  those rails' webhooks may always 401. Not counted: the generic HMAC
  path is verified sound, per-rail formats were not tested against live
  provider docs.
- **D NC-1 (adjacent):** per-rail webhook HMAC formats — same as NC-4,
  listed here only because it touches the webhook handler.
- **reCAPTCHA v3 score / hostname / action checks:** `verifyProvider`
  (routes/auth.js:57-68) checks only `j.success`; whether the deployment
  uses v3 (where a score threshold would be expected) was not established
  from code alone, so no finding is counted on it.
- **Facebook email verification:** Facebook's `email` field is trusted
  without a verified flag (routes/auth.js:546-548); Facebook normally
  verifies emails, but no `verified` field is checked in code. Not
  counted — provider guarantee, not a code defect.
- **TOTP step with a logged-in session:** if a user is already logged in
  and an OAuth callback stashes `pending_user_id` onto that live session
  (routes/auth.js:557-558,628-629), the interaction with the live session
  was not fully traced; the no-session bypass (W-01) is the confirmed
  case.
