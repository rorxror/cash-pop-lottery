# U-22 — One identity = one account — adjudication (worker: identity, v20)

Rule: ONE identity = ONE account. No creation path may produce a second
account when the email OR phone already belongs to an existing account.
Scope of this file: every `INSERT INTO users` in the codebase, proven
against the code BEFORE the fix, then the fix + test proof per path.

## Normalization helpers (the codebase's canonical forms)

- `normalizeEmail` — lib/util.js:105: `trim().toLowerCase()`.
- `normalizePhone` — lib/util.js:106-133: strips all non-digits; `00…`
  → `+…`; NANP `011…` → `+…`; a leading `+` is kept and a trunk `0`
  after a known dial code is stripped (e.g. `+44 07700…` →
  `+447700…`). PROVEN by running the helper:
  `+1 555-111-2222`, `0015551112222`, `01115551112222` all →
  `+15551112222`; `+44 07700 900123` → `+447700900123`.
- **Normalization does NOT by itself make every country-code variant
  collide:** a bare digit string with no `+`/`00`/`011` prefix is
  returned WITHOUT `+` (`15551112222` → `15551112222`, proven above).
  So `normalizePhone(a) === normalizePhone(b)` is true for
  `+`/`00`/`011` spellings of the same international number, but a bare
  `1555…` and `+1555…` are DIFFERENT stored strings. Any path that
  (a) stores the bare form or (b) duplicate-checks with exact equality
  only is exposed to a phone twin. The OTP-verify path already knew
  this — its lookup is variant-aware (routes/auth.js:527-528, see
  below) — the creation paths did not all follow it.
- Storage vs lookup per path is in the table; the general pattern
  before this round: email was stored normalized everywhere and is
  UNIQUE at the DB level (so email twins fail or are refused), phone
  was stored normalized-but-maybe-bare, checked by exact equality in
  most paths, and had NO DB uniqueness at all.

## Existing DB constraints (pre-fix)

- v1 schema, all three drivers: `email … UNIQUE NOT NULL`
  (lib/migrations.js:178 sqlite, :310 postgres, :442 mysql) —
  an email backstop EXISTS (case-sensitive on sqlite/postgres, so
  case-variant twins `A@x`/`a@x` are possible at the raw-column level
  if a path ever stored un-normalized case; no live path does).
- `phone` is a plain column with NO unique constraint in v1 or any
  later migration (v2-v19 add no phone index) — phone had NO DB
  backstop at all.
- `facebook_id` / `google_id` columns exist since v1
  (lib/migrations.js:188, :320; mysql added in v11, :847-848), also
  with NO unique constraint.
- Migration error behaviour (adjudicated): `migrate()`
  (lib/migrations.js:1183-1198) has NO per-migration try/catch — a
  failing `execScript` propagates and `boot().catch` in server.js:490
  exits the process. So a naive `CREATE UNIQUE INDEX` in v20 would
  CRASH THE BOOT on any production DB that already holds duplicate
  phones. v20 therefore needs a check-first preflight (see §Migration
  v20 below) — static DDL alone cannot conditionally skip.

## Per-path inventory (pre-fix verdicts)

### 1. Form register — POST /register (routes/auth.js:344,363-383)
- Checks today: email `normalizeEmail` + exact `WHERE email = ?`
  (auth.js:363-365); phone `normalizePhone` (auth.js:344) + exact
  `WHERE phone = ?` (auth.js:366-369), both BEFORE the OTP-code
  consume and the INSERT (auth.js:382).
- GAP (phone variant): exact-equality check misses a stored bare
  `1555…` row (created by the OTP path, path 3) — form registration
  with `+1555…` then INSERTs a second account with the same number.
- GAP (message): refusals were `An account with this email already
  exists.` / `…phone number…` — true, but they do not point the user
  to sign in (owner's phrasing: "account pehle se maujood hai — sign
  in karein").
- GAP (race): the INSERT is not guarded — two parallel registrations
  with the same phone both pass the SELECT (no DB constraint) and
  both insert. Email race is caught by the v1 UNIQUE (throws → 500).
- Verdict: email SAFE (check + DB unique), phone GAP, race GAP.

### 2. Google OAuth — GET /auth/google/callback (routes/auth.js:~700-745)
- Flow today: global `fetch` to `https://oauth2.googleapis.com/token`
  then `https://www.googleapis.com/oauth2/v2/userinfo` (the only
  profile seam; there is NO exported profile-processing function).
- Checks today: strict single-use `state` (v16); email presence;
  `verified_email` honoured ONLY if the field is present —
  `if ('verified_email' in profile && !profile.verified_email) throw`
  (auth.js:719). Lookup by email ONLY (auth.js:721,
  `String(profile.email).toLowerCase()`, no trim). On a match:
  `oauthAccountCheck` (lib/auth.js) runs before mutation, then
  `email_verified` is set (v16). On no match: INSERT (auth.js:725).
- GAP (provider link): the INSERT does NOT store `google_id`, and a
  matched existing account NEVER gets `google_id` recorded — the
  `users.google_id` column is written NOWHERE in the codebase
  (grep: only schema + the v11 mysql ALTER mention it). Rule (b)
  "provider link is recorded" FAILS for Google.
- GAP (no google_id lookup): because the link is never stored, a
  later Google sign-in whose email changed at Google cannot be
  matched by provider id — it would create a twin under the new
  email.
- GAP (unverified message): an explicitly unverified email is
  refused (safe — no merge, no twin), BUT the catch-all renders the
  generic `Google sign-in failed. Please try again.` — it does not
  tell the user the true reason or the remedy (sign in with the
  existing method, link from inside the account). Also: if
  `verified_email` is ABSENT from the profile, the current code
  silently trusts the email for a merge into an existing account.
- Verdict: merge-on-verified WORKS via email; link recording GAP;
  unverified handling safe-but-generic + absent-flag GAP.

### 3. Phone/email OTP verify (find-or-create) — POST /login/otp/verify (routes/auth.js:515-560)
- This is a CREATION path: when no user matches, it INSERTs one
  (auth.js:542, `user.register_otp` audit). OTP policy itself is
  untouched by this round (login/register OTP stays OFF by default,
  withdrawal-only per the settled design — this path only runs when
  an admin enabled OTP login).
- Checks today: identifier `normalizePhone`/`normalizeEmail`
  (auth.js:519). Phone lookup is VARIANT-AWARE:
  `WHERE phone = ? OR phone = ?` with the `+`-toggled alternative
  (auth.js:527-528) — so a form-registered `+1555…` account IS found
  by a bare `1555…` OTP login. Email lookup exact on normalized
  email (auth.js:530), backed by the v1 UNIQUE.
- GAP (storage): a NEW phone account stores the identifier AS
  NORMALIZED — i.e. a bare `1555…` when the user typed no `+`
  (auth.js:542 stores `identifier`). That bare row is then invisible
  to the exact-equality phone checks in paths 1, 6 (and to a future
  raw unique index). This is the root of the cross-path phone twin:
  OTP-first (bare) → form register (`+1555…`) = 2 accounts, proven
  by the normalize evidence above.
- GAP (placeholder collisions are safe — disproven suspicion): the
  phone-derived placeholder email `phone<digits>@phone.local` is
  unique by construction once the phone lookup has proven the
  number unused; no second phone account can mint the same one
  after the storage fix because the phone itself is canonicalized.
- Verdict: lookup SAFE, storage GAP (bare form), email SAFE.

### 4. Facebook OAuth — GET /auth/facebook/callback (routes/auth.js:~640-685)
- Flow today: global `fetch` to
  `https://graph.facebook.com/v18.0/oauth/access_token` then
  `https://graph.facebook.com/me?fields=id,name,email`.
- Checks today: strict single-use `state` (v16); lookup by
  `facebook_id` (auth.js:654), then by email
  `String(profile.email).toLowerCase()` (auth.js:655, no trim);
  no-email profiles refused (R-096). On an email match, the account
  is logged in AND `facebook_id` is recorded on it (auth.js:669-670)
  — the provider link storage the Google path lacks.
- GAP (unverified merge — the serious one): the Graph `/me`
  response carries NO email-verification field for the requested
  fields, and the code checks none. An email-only match is therefore
  an UNVERIFIED merge: anyone whose Facebook profile claims an
  email belonging to an existing account is signed into THAT
  account and permanently links their `facebook_id` to it. Rule (c)
  requires fail-safe here: no merge on an unverified provider
  email. Facebook cannot satisfy rule (b)'s "provider-verified
  email" condition with the fields this codebase requests, so for
  Facebook an email-only match must be treated as unverified:
  refuse, no session on the existing account, no twin, clear
  sign-in + link message. A `facebook_id` match (a link recorded
  earlier — via signup, a previous era merge, or the new in-account
  linking flow) remains a trusted sign-in: possession of the
  provider account itself is what the OAuth code flow proves.
- GAP: no-email refusal runs BEFORE the `facebook_id` lookup in
  effect (email presence is checked, then lookups) — a returning
  linked user whose Facebook returns no email is locked out even
  though the id match alone identifies them. Minor, fixed by
  ordering the id lookup first.
- Verdict: id-match SAFE, email-match UNSAFE GAP (unverified merge),
  link recording WORKS (only path that did).

### 5. In-account provider linking — DOES NOT EXIST (pre-fix)
- Grep over routes/lib/server.js for `google_id` writes, `link`
  routes, profile/security provider UI: NOTHING. The only "linking"
  that existed was the implicit OAuth-callback side effect in
  path 4 (Facebook, on login) — there was no way for a signed-in
  user to deliberately link Google/Facebook to their account, and
  no route a refusal message could honestly point to.
- FIX (route side, routes/auth.js — this worker): the OAuth START
  routes now record linking intent when a fully signed-in user
  starts the flow (`oauth_link_user_id` in their session), and the
  callbacks honour it: provider id is recorded on THAT account;
  if the provider id or the provider email already belongs to a
  DIFFERENT account the link is refused with a true-reason message
  (no merge, no session switch). A signed-in user visiting
  `/auth/google` or `/auth/facebook` IS the in-account linking
  route until the views wave adds buttons.
- SPEC for the views wave (views/**, not this worker): on the
  player's Security/Profile page add, when the corresponding
  `googleOn`/`facebookOn` flags are on: a "Google: linked / not
  linked" row from `user.google_id` and a "Facebook: linked / not
  linked" row from `user.facebook_id`, each with a Link button
  pointing at `/auth/google` / `/auth/facebook` when unlinked.
  No new route is needed — the start routes above are the link
  entry points.

### 6. Agent-created player — POST /agent/players/new (routes/agent.js:100-117) — NOT this worker's file
- Checks today: `normalizeEmail` + `normalizePhone` (agent.js:
  106-107), exact duplicate checks for both (agent.js:108-113),
  INSERT at agent.js:115. Same class as path 1: email SAFE; phone
  exact-check misses a bare-stored OTP row (root cause is fixed in
  path 3's storage) and misses nothing else, because the agent
  form's phone is free text — an agent typing bare `1555…` stores
  bare. SPEC for coordinator (routes/agent.js): canonicalize the
  stored phone the same way the fixed OTP path does (leading `+`
  when the normalized form is all digits with a country code), or
  reuse the variant lookup from routes/auth.js. Not edited here
  (file ownership).

### 7. Admin-created agent — POST <admin>/agents (routes/admin.js:1225-1237) — NOT this worker's file
- Checks today: duplicate email `email.trim().toLowerCase()` across
  ALL users (admin.js:1231), INSERT admin.js:1233, no phone field
  exists on this form. Email also DB-UNIQUE. Verdict: SAFE /
  DISPROVEN as a twin path (a staff email cannot twin a player —
  the check is role-agnostic).

### 8. Admin-created staff — POST <admin>/staff (routes/admin.js:3145-3158) — NOT this worker's file
- Same shape as path 7 (admin.js:3151-3154). Verdict: SAFE /
  DISPROVEN as a twin path.

### 9. Setup wizard — POST /setup (routes/setup.js:36-60) — NOT this worker's file
- Gated twice: `ALLOW_SETUP=1` only, and permanently disabled once
  ANY admin exists (setup.js:14-35). Email stored
  `trim().toLowerCase()`; a clash with a pre-existing player email
  would hit the v1 UNIQUE and render `Setup failed: …` (raw DB
  wording — cosmetic, setup-only, operator-facing). It cannot run
  at all on a deployed site with an admin. Verdict: NOT A LIVE
  TWIN PATH (disproven by the double gate); raw-error wording noted
  for the coordinator, not fixed here (file ownership).

### 10. Server admin seed — server.js:69-85 — NOT this worker's file
- Runs only when NO admin exists; email from operator env
  (`trim().toLowerCase()`). If the operator seeded an email that a
  player already owns, the INSERT would throw on the v1 UNIQUE and
  fail the boot loudly — operator-config edge, not a public
  creation path. Verdict: NOT A TWIN PATH (disproven); no change.

### 11. Email change via verification link — GET /verify-email/:token (routes/auth.js:460-473)
- Not a creation path, but it MOVES an email between accounts:
  duplicate-check `email = ? AND id != ?` runs BEFORE the token is
  consumed (auth.js:463, R-095). Verdict: SAFE / DISPROVEN.

## lib/auth.js spec (routed to coordinator — file owned by another worker)

`oauthAccountCheck(u)` (lib/auth.js, exported, used by both OAuth
callbacks) — current behaviour: returns `{ok:false,error}` for
banned / pending_review, else `{ok:true, totpRequired}`. It makes
NO identity decision (who the provider profile belongs to) and
needs NONE for this round: every identity fix (verified-email gate,
provider-id lookup/link, unverified refusal, linking intent) is
implementable in routes/auth.js around the existing check, and the
callbacks already call it before any mutation. **No lib/auth.js
change is required by U-22.** If the coordinator later wants the
unverified-merge rule shared with future providers, the required
behaviour would be: a helper `oauthIdentityDecision({byProviderId,
byEmail, emailVerified})` returning `login|link-only|refuse` — NOT
needed now; recorded so the boundary is explicit.

## Migration v20 (lib/migrations.js — appended, all three drivers)

What is missing: phone uniqueness, provider-id uniqueness, and a
case-insensitive email backstop on sqlite/postgres (raw email UNIQUE
there is case-sensitive). What v20 adds:
- sqlite: partial UNIQUE index on `users(phone) WHERE phone <> ''`,
  partial UNIQUE indexes on `users(google_id)` / `users(facebook_id)`
  WHERE `<> ''`, UNIQUE index on `users(LOWER(email))`.
- postgres: same shapes (`LOWER(email)`, partial indexes).
- mysql: email already UNIQUE (and the v1 column ships under a
  case-insensitive-by-default collation family — no extra email
  index); phone/provider ids get UNIQUE indexes over generated
  `NULLIF(col,'')` columns (`users_phone_uq` etc.), because MySQL
  has no partial indexes and a plain UNIQUE would reject the many
  legitimate `''` phones — MySQL UNIQUE permits multiple NULLs, so
  empty contacts stay legal.
- Dirty-DB behaviour (the honest part): static DDL cannot check
  first, and `migrate()` (lib/migrations.js:1183) would otherwise
  crash the boot on a duplicate (server.js:490). v20 therefore has
  a preflight INSIDE `migrate()` (the only non-append hunk in
  lib/migrations.js, flagged for the coordinator): before v20's DDL
  runs, it groups users by stored phone, by `LOWER(email)`, and by
  each provider id; if ANY duplicate group exists it (1) writes one
  row per group into a new `identity_migration_reports` table
  (created IF NOT EXISTS by the preflight itself), (2) logs a loud
  `[migration v20] SKIPPED …` console.error naming the groups, and
  (3) SKIPS v20 for this boot WITHOUT recording it in
  migrations_applied and WITHOUT throwing — the site boots, the
  route-level checks above still block new twins, and once the
  operator merges the reported duplicates the next boot applies
  v20 cleanly. On a clean DB (fresh or deduped) v20 applies and is
  recorded exactly like every other migration; re-running
  `migrate()` is a no-op via migrations_applied.
- Append-only note: existing migration entries v1-v19 are NOT
  modified; v20 is appended, and the preflight is an additive
  branch in `migrate()` keyed on `version === 20` only.

## Fixes applied (routes/auth.js only) + test proof

All line numbers below are post-fix routes/auth.js unless noted.

1. **Identity helpers** (after `recordLogin`): `phoneVariants()`
   (both `+`/bare spellings), `findUserByPhone()` (variant-aware
   lookup, replaces exact checks), `canonicalPhone()` (`+` storage
   form), `oauthFail()` (an error whose true reason MAY be shown),
   and the two unverified-provider message builders.
2. **Form register**: phone duplicate check is variant-aware;
   email/phone refusals now read "An account with this email/phone
   number already exists. Please sign in instead."; the INSERT is
   wrapped — a UNIQUE/duplicate failure (parallel race or the v20
   index) re-checks email then phone and renders the exact duplicate
   reason instead of a 500.
3. **OTP verify (find-or-create)**: phone lookup uses
   `findUserByPhone`; NEW phone accounts now store
   `canonicalPhone(identifier)` (the `+` form) instead of the bare
   digit form; the INSERT is wrapped — a race/unique failure returns
   409 JSON with the true email/phone reason. The OTP-request
   account gate (registration-disabled branch) uses the same
   variant-aware lookup. OTP policy unchanged.
4. **Google callback**: provider id (`profile.id`/`sub`) captured;
   resolution order = linking intent → `google_id` match →
   provider-VERIFIED email match. `verified_email` must be strictly
   `true` (absent = unverified; v16 trusted an absent flag).
   Unverified + existing account → `oauthFail` with the sign-in +
   link message (rendered by the catch via `exposeMessage`; internal
   errors stay generic). Unverified + no account → refused with the
   verify-or-register message (an unverified address can no longer
   squat someone else's email). `google_id` is now recorded: in the
   signup INSERT and as an UPDATE on any existing account that
   lacked it. `email_verified` is set only when Google verified
   THIS address and it equals the account email.
5. **Facebook callback**: provider id match first (a no-email
   profile can now still sign in a linked account); an email-only
   match throws `oauthFail` with the sign-in + link message — no
   session, no link, no twin (Graph `/me` returns no email
   verification field, so email-only is unverified by construction).
   Signup INSERT stores the normalized email + `facebook_id` as
   before.
6. **In-account linking (route side)**: both OAuth START routes
   record `oauth_link_user_id` when a fully signed-in user starts
   the flow; both callbacks capture it before clearing the
   single-use state and honour it: conflicts (provider id or
   provider email owned by a DIFFERENT account, or a different
   provider already linked) refuse with a true-reason message;
   success records the provider id on the signed-in account, writes
   a `user.oauth_linked` audit row, keeps the session on that user,
   and skips the TOTP re-challenge (the user is already fully
   authenticated — `req.user` is never set for pre-auth sessions).
   Views markup for the Link buttons is spec'd in §5 above for the
   views wave; no new route is needed.
7. **Migration v20** (lib/migrations.js, appended + the v20-only
   preflight branch in `migrate()` described in §Migration v20):
   unique indexes on `LOWER(email)` (sqlite/postgres), non-empty
   `phone`, `google_id`, `facebook_id` (partial indexes on
   sqlite/postgres; generated `NULLIF(col,'')` columns + UNIQUE on
   mysql). Dirty-DB behaviour PROVEN by test A3: duplicates →
   report rows in `identity_migration_reports` + loud
   `[migration v20] SKIPPED …` log, v20 unrecorded and retried next
   boot, `migrate()` resolves, existing rows untouched.

### Test proof — test/v20-identity.test.js (13 tests, all passing)

- A1: normalizePhone collision/asymmetry proof (above).
- A2: fresh migrate — v20 recorded, 4 indexes exist, two `''`-phone
  users legal, DB itself rejects a duplicate phone and a
  case-variant email, second `migrate()` no-op.
- A3: dirty DB — v20 recorded+skipped without throwing (above).
- B1/B2: form register → Google callback with the same VERIFIED
  email (different case): users stays 1, session's user_id = the
  original account, `google_id` recorded, `email_verified` set.
- B3: Google callback with `verified_email:false` AND with the flag
  absent, matching an existing account: 400, true-reason + link
  message, users stays, no `google_id`, no new session for that
  account.
- B4: Google-first signup (google_id recorded at creation) → form
  register with the same email refused ("…already exists. Please
  sign in instead."), users stays.
- B5: Facebook email-only match → same fail-safe as B3.
- B6: Facebook-first signup → repeat Facebook sign-in lands on the
  same account via `facebook_id`, users stays.
- B7: signed-in linking — Google linked onto the signed-in account
  even though the Google email differs from the account email;
  linking a google_id owned by another account refused, nothing
  recorded.
- B8: OTP verify with a bare number creates the account with phone
  stored as `+15553334444`; form register with that number refused
  (users stays); OTP verify with the `+` spelling finds the same
  account (302 finishLogin, users stays).
- C1/C2 (spawned server, port 4126, recipe env): fresh boot applies
  v20; full CSRF form flow — register, duplicate-email refusal,
  duplicate-phone refusal, DB counts stay 1 and the refused
  registration creates no row at all.
- Manual recipe E2E (separate from the test file): server booted on
  port 4126 with `/tmp/identity-v20.sqlite`, curl `-b`/`-c` jars —
  register 302, duplicate-email re-register rendered "An account
  with this email already exists. Please sign in instead.", DB
  count for the email = 1, v20 recorded; server stopped with
  `fuser -k 4126/tcp`.

### OAuth test seam (honest note)

The callbacks fetch profiles through the global `fetch()` to
hardcoded provider URLs; there is NO exported profile-processing
function in the codebase. Part B therefore mounts the real
routes/auth.js in an express harness (real `loadSession`, real
settings) and stubs the global `fetch` AT THOSE EXACT URLs (Google
token + userinfo, Facebook token + /me), delegating all other URLs
to the real fetch. No parallel OAuth implementation was invented;
the handler code under test is the shipped handler.
