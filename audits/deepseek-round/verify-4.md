# Verify-4 — Independent fix verification (admin + design + public)

Agent: independent verification subagent. Date: 2026-10-28. Method: booted the FIXED
copy myself — `SQLITE_PATH=/tmp/verify4.sqlite PORT=3344 BASE_URL=http://localhost:3344
TICKET_HMAC_SECRET=verify-four-hmac-secret-012345678 ADMIN_SEED_EMAIL=admin@cashpop.live
ADMIN_SEED_PASSWORD='E2eAdmin!2345' node server.js` (fresh DB, admin seeded, Gold Rush
seeded, healthz 200). Admin path `/ops-7f3a9c-console`, login via `/login`, CSRF scraped
from GET forms with a per-user curl cookie jar. Staff users (finance/risk/support) inserted
via DB with `password_hash` copied from the seeded admin row. No code in the fix copy was edited.

## Tally

- Items assigned: 29 DS items + (a) admin-URL audit + (b) unit suite = **31 verdicts**
- **VERIFIED: 31 · FAILED: 0 · CODE-ONLY: 0** (every item got live or recomputed evidence;
  two items carry caveats, noted inline — neither breaks the stated criterion)
- Unit suite: **55 tests — 54 pass, 0 fail, 1 skipped** (exact, see (b))

## Contrast arithmetic (shared for DS-003 / DS-030–033 / DS-062–065)

WCAG relative luminance: linearise each sRGB channel
(`c/12.92` if c≤0.03928 else `((c+0.055)/1.055)^2.4`), `L = 0.2126R + 0.7152G + 0.0722B`,
ratio `= (Llight+0.05)/(Ldark+0.05)`. Recomputed in Python from the **final cascaded**
values in `public/style.css` (later rules / the appended repair block at line ~1673 win):

| Pair (final cascaded) | L(fg) | L(bg) | Ratio |
|---|---|---|---|
| #0057b8 on #ffffff (DS-003 table links, DS-064 fg) | 0.1028 | 1.0000 | (1.05)/(0.1528) = **6.87:1** |
| #34405c on #eef1f6 (DS-030 inactive tab, style.css:1491) | 0.0517 | 0.8774 | 0.9274/0.1017 = **9.12:1** |
| #ffffff on #17203a (DS-030 active tab, :1493) | 1.0000 | 0.0152 | 1.05/0.0652 = **16.10:1** |
| #1b2340 on #f7c948 (DS-030 active count, :1494) | 0.0181 | 0.6202 | 0.6702/0.0681 = **9.85:1** |
| #ffffff on #d92d20 (DS-032 .btn-d/.b-err, :153/:171; DS-033 .neg on white is the inverse pair) | 1.0000 | 0.1673 | 1.05/0.2173 = **4.83:1** |
| #12805c on #ffffff (DS-033 .pos, appended override :1680) | 0.1634 | 1.0000 | 1.05/0.2134 = **4.92:1** |
| #f7c948 on #17203a (DS-062 .b-info :173 and .ball-sm :1496) | 0.6202 | 0.0152 | 0.6702/0.0652 = **10.28:1** |
| #5f6368 on #ffffff (DS-063 .adm th :1014, .kpi .l :1025) | 0.1236 | 1.0000 | 1.05/0.1736 = **6.05:1** |
| #0057b8 on #e0eefc (DS-064 sidebar active :993 — bg is rgba(0,113,227,0.12) composited over white = #e0eefc) | 0.1028 | 0.8405* | 0.8905/0.1528 = **5.83:1** |
| #1b2340 (--navy-ink, :1099; .btn-p color :1110) on #cf8a00 (DS-065 gradient dark stop, :1159) | 0.0181 | 0.3146* | 0.3646/0.0681 = **5.36:1** (mid stop #d9940d: 6.02:1; light stop #f7c948: 9.85:1) |

*derived the same way. DS-031 is an affordance fix, not a pair: final cascaded `.btn`
(appended block, last in file) is `border:1px solid rgba(23,32,58,.25); background:rgba(23,32,58,.06)`
— composite bg over white #f1f2f3, inherited ink text #17203a on it = 14.37:1, and the
border/fill now exist where both were transparent.

## Per-item verdicts

- **DS-003 — VERIFIED.** `public/style.css:578` `.adm .tbl a { color: #0057b8; font-weight: 600; }`
  (comment cites the old `var(--navy-800)=#fff` 1.00:1). Recomputed 6.87:1 on white (table above).
  Appended `.adm a { color:#0057b8 }` (:1683) extends it to non-table admin links.
- **DS-011 — VERIFIED (live).** Finance staff login 302 → panel; `GET /ops-7f3a9c-console/methods/10/credentials`
  = **403** with "Only the super admin can view gateway credentials." Super admin same URL = **200**.
  Code: `routes/admin.js:1347` route self-gates on `normalizeRole(req.user) !== 'super'`
  (RBAC alone allows all staff GETs, so the handler guard is the real control).
- **DS-012 — VERIFIED (live, both directions).** With finance deleted (1 approver-capable account:
  super only; risk/support present but not counted), POST `/settings/risk` with
  `maker_checker_threshold=10.00` → 302, flash **"Maker-checker needs at least TWO staff accounts
  that can approve money actions (super or finance role). You currently have 1 — add another
  approver under Staff first. Nothing was saved."**, DB value stayed **0**. After re-inserting the
  finance row, the identical POST saved (DB value **1000** minor); reset to 0 afterwards.
  Code: `routes/admin.js:2236-2238` count query `role='admin' AND (admin_role IS NULL OR admin_role IN ('super','finance'))`.
- **DS-030 — VERIFIED.** Tab pairs recomputed: inactive 9.12:1, active (white on navy) 16.10:1,
  active count 9.85:1, inactive count (#1b2340 on #dbe2ec) 11.83:1 — all ≥4.5 (style.css:1491-1494).
- **DS-031 — VERIFIED.** Plain `.btn` final cascade has a visible fill + border (appended block);
  see arithmetic note above. Live admin list pages render Review/Filter buttons with that style.
- **DS-032 — VERIFIED.** `.btn-d` and `.b-err` are now `#ffffff` on `#d92d20` = 4.83:1 (was 4.28:1).
- **DS-033 — VERIFIED.** Appended overrides win over the earlier `var(--success)/var(--danger)`
  rules at :1510-1511 and :416-417: `.pos #12805c` = 4.92:1, `.neg #d92d20` = 4.83:1, both on white.
- **DS-062 — VERIFIED (caveat).** `.b-info` and `.ball-sm` are now `#f7c948` on `#17203a` = 10.28:1.
  Caveat: the global public `a { color: var(--gold-2) }` (#b87a00, 3.61:1 on white, style.css:95)
  is unchanged outside `.adm` (admin links are covered by the `.adm a` override). The FIX-LOG-DEEP
  claim for DS-062 names only .b-info/.ball-sm, so the claim as made holds; the public-link pair
  from audit-E E-08 remains below 4.5 and should be recorded as a residual, not as fixed.
- **DS-063 — VERIFIED.** `.adm table th` (:1014) and `.adm .kpi .l` (:1025) are `#5f6368` = 6.05:1 (was #86868b, 3.62:1).
- **DS-064 — VERIFIED.** `.adm-side nav a.active` (:993) is `#0057b8` on rgba(0,113,227,0.12);
  composited over the white sidebar = #e0eefc → 5.83:1 (was 3.78:1).
- **DS-065 — VERIFIED.** `.btn-p` text is `--navy-ink` #1b2340 (override :1110 wins over the
  earlier `var(--navy-900)`); gradient (:1159) `#f7c948 → #d9940d → #cf8a00`. Worst case is the
  dark stop: 5.36:1 ≥4.5 (was #a86e00 at 3.60:1).
- **DS-034 — VERIFIED (live).** `GET <admin>/draws` (200) contains
  `href="/ops-7f3a9c-console/draws/1"` … `/draws/5` etc. Code: all three draw tables in
  `routes/admin.js:259,267,280` render `` `<a href="${R(req,'/draws/'+dr.id)}">#${dr.id}</a>` ``.
- **DS-035 — VERIFIED (live).** Set `maintenance_mode=1` in DB → `GET /` = **503** maintenance page
  ("We'll be right back / Cash Pop is under scheduled maintenance. Please check back soon — your
  balance and tickets are safe."). Grep of the rendered page for `operator|admin panel|sign in`:
  **no match**. `views/maintenance.ejs` contains no operator/admin-panel invitation. Restored to 0 → home 200.
- **DS-039 — VERIFIED (live).** `GET /page/privacy` = 200, 5,045 bytes, body begins "We respect your
  privacy. We collect only the account details you give us (name, email, phone)…" — real policy text,
  no "placeholder" string. Seed `lib/migrations.js:96` + placeholder-heal block at :931-940.
- **DS-041 — VERIFIED (code + live).** `views/index.ejs:33` renders the paid-out counter with
  `data-symbol` taken from the currencies list entry matching `cur` (server-side), and
  `public/app.js` uses `el.getAttribute('data-symbol')` in both the count-up and the 30 s refresh
  ("DS-041: server currency, never a hard-coded $" — the `|| '$'` is only a fallback if the
  attribute is absent). Live homepage (base USD) correctly showed `data-symbol="$"`.
  Server totals are also base-currency-only (`routes/site.js:47`).
- **DS-042 — VERIFIED (code + render).** `routes/site.js` winners query:
  `SELECT t.amount, t.currency, t.created_at, u.name FROM transactions t JOIN users u … WHERE t.type='win'`
  — `t.currency` is selected, and `views/index.ejs:151` renders `fmt(w.amount, w.currency || 'USD')`
  in both the ticker and the winners grid.
- **DS-043 — VERIFIED for the homepage as specified (caveat).** Rendered `GET /` and
  `views/index.ejs`: **0 occurrences** of "Instant Payouts" and **0** of "Secure & Licensed";
  replacements present live: "Instant Win Credits — Winnings land in your wallet at once" and
  "Secure Platform — Provably fair, transparent draws". Caveat (outside the stated criterion):
  `views/login.ejs:121` still contains the string "Instant Payouts" in its branding strip
  ("Daily Draws · Provably Fair · Instant Payouts") — the homepage claim is fixed, the login
  page was not swept.
- **DS-048 — VERIFIED.** `FIX-LOG.md:794-795` names `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` and
  `FACEBOOK_APP_ID`/`FACEBOOK_APP_SECRET`; grep for the wrong bare names (`GOOGLE_SECRET`,
  `FACEBOOK_SECRET`) in FIX-LOG.md / FIX-LOG-DEEP.md: none.
- **DS-059 — VERIFIED (code + live validation).** `lib/draws.js`: `drawDateStr()` uses
  `Intl.DateTimeFormat('en-CA',{timeZone:tz,…}).formatToParts`, `closeAtForTz()` converts wall
  time in the configured tz via Intl, `ensureUpcomingDraws()` reads `site_timezone` and passes
  it to both; admin test-draw also passes it (`routes/admin.js:306`). Admin field exists
  (`routes/admin.js:2139`, "Site timezone (IANA)") and validates live: POST
  `/settings/appearance` with `site_timezone=Not/AZone` → flash "Site timezone is not a valid
  IANA timezone name. Nothing was saved." and DB unchanged; with `America/Chicago` → saved.
- **DS-066 — VERIFIED (live).** Inserted two pending deposits (player1@vfy.local/method 1,
  player2@vfy.local/method 2). Unfiltered list shows both; `?q=player1@vfy.local` shows player1
  only (player2 count 0); `?method=2` shows player2 only; `?from=2099-01-01` shows neither.
  Filter forms with q/method/from/to exist for both deposits (`routes/admin.js:952-956`) and
  withdrawals (:1100-1104), rendered live (`class="filter-form"` present).
- **DS-067 — VERIFIED.** `lib/extensions.js:35` `custom_captcha: []` with the DS-067 comment;
  grep for "difficulty" in lib/routes/views: none. Live: admin extensions list and the
  custom_captcha configure page (200) contain 0 occurrences of "difficulty".
- **DS-068 — VERIFIED.** The settings `TOGGLES` array (`routes/admin.js:2071ff`) contains no
  `kyc_required`, `email_verification`, or `mobile_verification` entries; rendered settings page
  contains 0 of those names. (Remaining grep hits are unrelated: the `email_verifications` table
  and seeded setting defaults in `lib/migrations.js:38-40`, which are not UI toggles.)
- **DS-069 — VERIFIED (live, both directions).** Inserted two open approvals requested by super:
  #1 `draw.settle`, #2 `deposit.approve` (money). As **risk** staff: POST `/approvals/2/reject` →
  flash "Your staff role cannot decide this type of approval.", row stayed **open**; POST
  `/approvals/1/reject` → succeeded, row became **rejected, decided_by=3 (risk)**. Code matches:
  `lib/rbac.js` approval route widened to `['super','finance','risk']`, and both approve/reject
  handlers (`routes/admin.js:2358,2415`) enforce the domain split — draw.* → super/risk,
  everything else → super/finance — plus the self-approval bar.
- **DS-070 — VERIFIED (live).** Settings page renders `sms_provider` as a select
  (`routes/admin.js:2141`, options '', twilio, textbelt) in the Appearance form, and it is in the
  POST `/settings/appearance` allow-list (:2326). Live: saving `sms_provider=twilio` via that form
  persisted `twilio` in the settings table (restored to textbelt after). Precedence env > setting
  is documented in the field help and in `lib/otp.js:60`.
- **DS-071 — VERIFIED (live + code).** Rendered admin queue pages contain **0** `btn-p`:
  deposits list, withdrawals list, approvals list all 0. Per-row list actions are demoted —
  deposits/withdrawals rows use `<a class="btn btn-sm">Review</a>` (detail page holds the single
  primary), approvals rows use `btn btn-sm btn-g` Approve. Remaining `btn-p` in admin.js are
  single-primary-per-view spots (detail-page Approve, form submits, "+ New …").
- **DS-074 — VERIFIED (live).** Grep of all views for "(operator setting)" / "(when enabled by
  the operator)": none. Logged in as a player, `GET /profile` = 200 with 0 occurrences of either string.
- **DS-077 — VERIFIED (live).** `views/layout.ejs:35-39` compares against the `currentPath` local
  (`server.js:235` sets `currentPath: req.path`). Live: on `/play` (logged in) the Play link is
  `class="active"` and Home is `class=""`; on `/results` the Results link is active; on `/` Home is active.
- **DS-078 — VERIFIED.** `views/layout.ejs`: `</head>` at line 21, `<body>` at line 22,
  `<div id="fb-root">` at line 24 — inside body (and only rendered when fb_comments is on;
  it was absent from the live homepage HTML with the extension off, which is consistent).
- **DS-079 — VERIFIED (live).** `GET /favicon.ico` = **200, content-type image/x-icon, 232 bytes**
  (a real MS Windows icon, 32×32 PNG). `GET /favicon.svg` = 200, image/svg+xml, 291 bytes, and
  `public/favicon.svg` exists on disk alongside `public/favicon.ico`.

## (a) Admin URL audit — VERIFIED

Grepped the entire fix copy (`views/`, `routes/`, `lib/`, `public/`, `server.js`) for the
literal `/admin`. **No real `/admin` URL/path exists anywhere.** Every occurrence found,
classified:

| Occurrence | Classification |
|---|---|
| `routes/admin.js:19` `require('../lib/admin-ui')`; `routes/scratch.js:7` same | Module filename (`lib/admin-ui.js`), not a URL |
| `routes/scratch.js:165` comment "STEALTH (same rule as routes/admin.js)" | Code comment naming a source file |
| `routes/admin.js:2` comment "mounted at the hidden ADMIN_PATH" | Code comment; contains no `/admin` path |
| `server.js:433` `app.use(ADMIN_PATH, …require('./routes/admin'))` | Module require; mount point is the `ADMIN_PATH` variable, not a literal |
| `server.js:165,174,236,432,445`, `routes/admin.js:2094,2139-area` `ADMIN_PATH` | Env var name / variable — value defaults to `/ops-7f3a9c-console`, settable via `ADMIN_PATH` env; the settings page explicitly says the prefix is NOT editable in admin |

Live stealth check: `GET /admin` = 404, `GET /admin/` = 404, `GET /administrator` = 404
(plain 404, logged out). The panel is reachable only under `/ops-7f3a9c-console`
(dashboard 200 for staff, credentials/methods/settings all served under that prefix).

## (b) Unit suite — VERIFIED

`node --test test/*.test.js` in `~/workspace/cash-pop-fix`:
**tests 55 · pass 54 · fail 0 · skipped 1 · cancelled 0 · todo 0** (duration ~3.3 s).
Matches the FIX-LOG-DEEP claim exactly (the 1 skip is the Postgres adapter, no PG in this env).

## Competing solution — CSS batch

The main alternative was renaming the inverted CSS variables to semantic names
(`--navy-800` currently means white, `--white` means dark ink, `--navy-900` means near-white —
the root cause of the whole contrast batch) and updating every usage site. The implemented
approach instead kept the token names and applied targeted value overrides at the broken
selectors plus an appended, last-in-file repair block (style.css ~1673) so the fixes win the
cascade deterministically. **The implemented approach wins for this fix round**: the stylesheet
is 1,688 lines with the inverted tokens referenced pervasively (including in inline styles
generated by `routes/admin.js`/`lib/admin-ui.js` and in EJS), so a rename would have touched
hundreds of sites with a high regression risk and no runtime proof short of re-rendering every
page, whereas the overrides are few, auditable, carry per-DS comments with the old failing
ratios, and every recomputed pair now passes ≥4.5:1. The cost is real and should stay on the
record: the misleading token names remain a trap for the next editor (and the one un-renamed
residual is visible in DS-062's caveat — the global public link colour still rides on
`--gold-2`), so a semantic rename is the right *future* refactor, done as its own pass with a
full page sweep — not as part of a contrast hotfix.

## Notes / residuals (not failures of the stated criteria)

1. DS-043 caveat: "Instant Payouts" survives on the login page (`views/login.ejs:121`).
2. DS-062 caveat: public (non-admin) inline links remain #b87a00 on white = 3.61:1.
3. Test server on port 3344 was killed after verification; all test data lives only in
   `/tmp/verify4.sqlite`.
