# OWNER-FIX ROUND (v20) — BACKEND ADJUDICATION

Worker scope: routes/player.js, routes/scratch.js, lib/auth.js, lib/settings.js
(+ new tests test/v20-money-errors.test.js, test/v20-support.test.js).
NOT touched: lib/money.js / lib/rails.js / routes/webhooks.js /
lib/credentials.js (PAYMENTS worker, per coordinator update) — any need
there is specified, not edited. Verdicts were recorded BEFORE fixes.
Repro boot: port 4122, fresh SQLite /tmp/backend-v20.sqlite,
BASE_URL=http://localhost:4122 (recipe env), 2026-10-28.

## U-02 — True-reason errors, inline (money flows)

VERDICT: CONFIRMED (owner's screenshot reproduced exactly).

Evidence:
- routes/player.js:64 — every pre-transaction lottery rejection goes
  through `fail()` → `res.status(400).render('error', …)`, a bare
  full-page error, losing the playslip and the player's selections.
- routes/player.js:199 — the transaction catch discards the real error:
  `res.status(400).render('error', { message: 'Purchase failed. Please
  try again or contact support.' })`. The real reasons thrown inside the
  transaction (lib/money.js:54 `Insufficient balance` from postLedger;
  draw-just-closed, per-draw stake cap, daily loss limit from
  lib/scratch.js enforcers) never reach the player.
- Live repro (adjudication boot, $0-balance player, 2 pops × $1, DAY×1):
  `POST /play/buy` → 400, body contains "Purchase failed. Please try
  again", body does NOT name any balance reason.
- routes/scratch.js:151 — same pattern: every buyTicket failure becomes
  'Scratch purchase failed. Please try again.' Live repro (Gold Rush,
  $0 balance) → 400 generic.
- routes/player.js:333 / :439 / :525 — deposit and both withdrawal
  creation catches use the same generic sentence. Their pre-check
  branches already carry TRUE reasons (policy.reason, KYC message,
  min/max, required field, ruleCheck.reason) but still render the bare
  error page instead of returning to the form.

Reason map (each traced to its check; nothing invented):
- Lottery, pre-txn (routes/player.js buy handler): pops count
  (`Pick between 1 and ${maxPops} pops.` — kept), invalid wager,
  invalid draw type, responsible-play throws from
  lib/scratch.js enforceAccountPlayable (self-exclusion / cooling-off
  messages — passed through verbatim), session-limit message (kept),
  `Not enough upcoming ${t} draws available. Try fewer draws.` (kept —
  this is the draw-closed/not-found class).
- Lottery, in-txn: 'A selected draw just closed — please buy again for
  the next draws.' (kept), 'This purchase would exceed your per-draw
  stake cap.' (kept), 'This purchase would exceed your daily loss
  limit.' (kept), postLedger 'Insufficient balance' → ENRICHED with
  amounts: ticket total vs wallet balance vs shortfall for the buy
  currency (all three values are known server-side: `total`, and the
  wallet row via getBalances). TICKET_HMAC_SECRET missing → a
  configuration message (the true class; never a fake player reason).
  Anything else → logged, and the flash states the one true fact left:
  the purchase was rolled back and no money was taken (the buy is a
  single DB transaction, so a throw = full rollback).
- NOT in the buy path (checked, not invented): there is NO
  verified-contact gate and NO KYC gate on ticket purchase today.
  verifiedContactOk (lib/money.js:72) gates deposit/withdrawal
  policies only; lib/kyc.js kycGateCovers covers 'withdraw'/'deposit'
  actions only. So no such messages were added to the buy path.
- Scratch (lib/scratch.js buyTicket throws): 'This scratch series is
  not on sale.', 'This scratch series is sold out.', self-exclusion /
  cooling-off, daily-loss-limit — passed through verbatim;
  'Insufficient balance' → enriched with series price vs wallet
  balance vs shortfall; 'This outcome was just claimed by another
  purchase — please try again.' (kept — a true concurrency reason).
  Session-limit pre-check in routes/scratch.js gets the same treatment.

Mechanism (chosen per flow, with reasons):
- Lottery buy → DIRECT RE-RENDER of `play` with status 400, the reason
  in the `flash` render local (layout.ejs renders `flash.error` on
  every page, so the reason shows at the playslip TODAY, before the
  view worker wires anything) plus a `slip` local carrying the posted
  selections for the view worker to re-check/re-select. Why not
  redirect+stash: (a) the BP-26 tamper suite (test/tamper.test.js:172)
  asserts HTTP 400 for a rejected buy — a redirect would silently
  break that standing contract; (b) a failed buy creates nothing, so
  the usual PRG duplicate-submit argument does not apply (refresh
  re-POSTs a still-failing, non-debiting request; the buy rate limit
  also applies); (c) direct render keeps the reason ON the slip
  response itself — the owner's "right where the buy happens" rule.
  The re-render supplies EVERY local GET /play supplies (wagerOptions,
  prizeTable, maxDraws, balance, wallets, playCurrency) — see helper
  renderPlayError in routes/player.js.
- Scratch buy → DIRECT RE-RENDER of `scratch_detail` (or
  `scratch_lobby` when the series itself is gone) with status 400 +
  flash local, same reasoning (player stays on the card they tried to
  buy; no standing status contract exists here, consistency with the
  lottery pattern decides).
- Deposit / withdraw submissions → flash + redirect back to the form
  (the app's established pattern for form posts: profile, support,
  KYC all do setFlash+redirect). Validation branches keep their exact
  true-reason texts; only the generic catches and the bare
  insufficient-balance wording change (amounts named). The
  /withdraw/verify "no pending withdrawal" branch KEEPS its 400 true
  reason (test/tamper.test.js:249 asserts 400 there).

`slip` local contract (for the play view worker):
`slip = { pops: number[], wager: number (minor units),
drawType: 'DAY'|'EVE'|'BOTH', numDraws: number, currency: string }`
on a failed-buy re-render; `slip = null` on a normal GET /play.
The view should render those pops checked and the matching
wager/draw/num-draws radios selected.

## U-04(a) — Sessions page shows the raw user-agent

VERDICT: CONFIRMED.
- routes/player.js:728 securityViewModel selects `user_agent` raw and
  passes session rows untouched; views/security.ejs prints
  `s.user_agent` verbatim. Live repro: /security for an iPhone CriOS
  session contains the full raw string `Mozilla/5.0 (iPhone; …
  CriOS/120.0.6099.119 …`.
- lib/auth.js:157 parseUA(ua) → {browser, os} already exists but only
  knows Edg/Chrome/Safari/Firefox/OPR and misses CriOS (iOS Chrome),
  FxiOS (iOS Firefox), SamsungBrowser, EdgA/EdgiOS — an iOS Chrome UA
  currently parses as Safari.
FIX (lib/auth.js): parseUA gains a `device` field and the missing
browser tokens; {browser, os} names/values are NOT renamed or
re-valued (routes/auth.js:91 recordLogin keeps storing the same
vocabulary). Device vocabulary (closed set, per brief):
iPhone / iPad / Android / Windows / Mac / Linux / Unknown device.
FIX (routes/player.js): securityViewModel maps each session row to
human fields only — the `user_agent` key is REMOVED from the objects
handed to the view.
Locals contract (security view worker): `sessions[]` items are now
`{ id, ip, created_at, expires_at, device, browser, os, deviceLabel }`
where deviceLabel = `${device} · ${browser}` with fallbacks
'Unknown device' / 'Unknown browser' (so an unknown UA renders
exactly "Unknown device · Unknown browser"). No raw UA reaches the
view. NOTE: test/v19-features.test.js BP-14 asserts the OLD verbatim
UA display (/V19PlayerBrowser/, /V19SecondBrowser/) — that assertion
encodes the pre-U-04 behaviour the owner has now rejected and will
fail until the coordinator updates it; flagged in the final report,
not silently worked around.

## U-04(b) — Sessions store an internal proxy IP (10.26.x.x)

VERDICT: CONFIRMED, mechanism identified by experiment.
- server.js:122 `app.set('trust proxy', 1)`. All session creation
  passes `ip: req.ip` (routes/auth.js:18/226/248 and siblings).
- Standalone experiment with THIS app's express/proxy-addr versions
  (direct socket 127.0.0.1): with trust proxy = 1 —
  XFF `203.0.113.7` → req.ip = 203.0.113.7 (correct);
  XFF `203.0.113.7, 10.26.103.5` → req.ip = **10.26.103.5** (the bug);
  longer chains also collapse to the rightmost entry.
- Live-boot confirmation: login with XFF `203.0.113.7, 10.26.103.5`
  stored sessions.ip = `10.26.103.5`; login with single XFF
  `203.0.113.7` stored `203.0.113.7`.
- Mechanism: Render's proxy chain appends the platform's internal
  hop LAST in X-Forwarded-For. `trust proxy = 1` trusts only the
  socket peer, so Express takes the rightmost XFF entry — the
  internal proxy — as req.ip.
- Candidate fixes measured in the same experiment:
  trust = 2 fixes the 2-entry chain but hard-codes a hop count;
  trust = ['loopback','linklocal','uniquelocal'] yields
  203.0.113.7 for the Render chain, AND for a spoof attempt
  (`1.2.3.4, 203.0.113.7, 10.26.103.5` — client pre-seeds XFF, the
  platform appends the real client) it still yields 203.0.113.7:
  private/loopback hops are walked past, the first public address
  from the server side wins, and anything further left (spoofable)
  is ignored. It also never trusts XFF from a direct public peer.
FIX OWNERSHIP: the one place this can be fixed for ALL session
creators (auth/admin/site/setup routes) is server.js, which is NOT
this worker's file. Exact one-line change specified for the
coordinator (do NOT apply here):
  server.js:122  `app.set('trust proxy', 1);`
             →   `app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);`
No sound fix exists inside lib/auth.js/routes alone: createSession
receives an already-computed `ip` string from callers in files this
worker does not own; re-parsing XFF in one route would leave the
others wrong and would duplicate proxy policy. Honest note for the
report: existing stored sessions keep their old (internal) IP —
only new sign-ins store the true client IP; rows expire within the
7-day session TTL.

## U-15 — Profile verified badge local

VERDICT: CONFIRMED MISSING. routes/player.js:601 GET /profile renders
only { verifyPhone, refSummary, kycCard } — no verified boolean; the
view falls back to the account-status badge.
Rule verified against the deposit gate as required: lib/money.js:72
verifiedContactOk → `!!(user.email_verified || user.mobile_verified)`
(the field is mobile_verified, not phone_verified), used by
depositPolicy (lib/money.js:85) and withdrawalPolicy (:93).
FIX: GET /profile passes `profileVerified` (boolean, exactly that
rule, independent of the verified_contact_required toggle — the
badge states a fact about the contacts, the toggle only decides
whether the fact gates money movement).

## U-16 — Referral link is relative

VERDICT: CONFIRMED. Live repro: profile HTML contains
`/register?ref=CP2` (owner's screenshot item 12, reproduced
byte-for-byte). views/profile.ejs builds it from a `baseUrl` local
that no route ever passes (typeof-guarded, so it silently degrades
to '').
Absolute-link pattern in this app (cited): routes/player.js:665
(email verification) and routes/auth.js:417 (password reset) both use
`(process.env.BASE_URL || (req.protocol + '://' + req.get('host')))`.
FIX: GET /profile passes `baseUrl` (that pattern, trailing slash
stripped) — which repairs the existing view expression unchanged —
plus `referralUrl` (the complete absolute URL, '' when the user has
no referral code) as the clean contract for the view worker.

## U-18 — Support turn-taking

VERDICT: CONFIRMED ABSENT. Live repro: a player created a ticket and
immediately posted a second message; support_messages count = 2.
Schema adjudication: migrations define support_messages
(ticket_id, author_id, author_role TEXT, body, created_at) in all
three dialects (lib/migrations.js:264-271 sqlite). Author roles in
the wild: player inserts use req.user.role = 'player'
(routes/player.js reply/new); agents insert 'agent'
(routes/agent.js:210); admins insert normalizeRole(admin) — 'super'
for a super admin, else the admin_role ('support'/'finance'/'risk')
(routes/admin.js:2101 via lib/rbac.js:43). So the alternation key is:
latest message (highest id = true insertion order) has
author_role !== 'player' ⇒ staff/agent spoke last ⇒ player may
reply. Any non-'player' role counts as staff — future staff roles
unlock correctly without a list to maintain.
FIX (routes/player.js only; staff routes untouched, so their replies
unlock the player naturally):
- GET /support/:publicId passes `canReply` (boolean) and
  `lockReason` (string, '' when canReply) — contract for the view
  worker. canReply = ticket not closed AND latest message is staff.
- POST /support/:publicId/reply enforces the same rule server-side:
  closed → flash 'This ticket is closed. Reopen it if you need more
  help.'; staff hasn't replied yet → flash 'You can reply again as
  soon as our support team has responded to your last message.';
  empty body → flash with that true reason. All rejections are
  redirects back to the ticket with the flash — never a bare
  400/500. A reopened ticket whose latest message is the player's
  stays locked until staff reply (the rule keys off messages, not
  status).
Locals contract (support_view worker): `canReply: boolean`,
`lockReason: string` ('' when canReply is true; otherwise the exact
player-facing reason — view may show it in place of the form).

## U-19 — Support limits (settings-driven)

VERDICT: CONFIRMED ABSENT — POST /support/new (routes/player.js:837)
validates only subject/message presence. No limit code exists.
Staff/agent ticket creation: NONE — `INSERT INTO support_tickets`
exists exactly once in the codebase (routes/player.js, the player
route); admin/agent routes only reply/close/reopen. So enforcing at
the player route covers every creation path.
FIX: before insert, read via lib/settings getS (the settings store
is a generic key/value table; unknown keys need no migration):
- `support_max_open_tickets` (default 2): count of the player's
  tickets with status != 'closed' AND deleted_at IS NULL (see U-25
  interplay). 'answered' counts — the ticket is still live/unresolved
  (interpretation of the U-25 wording "status open": the open family
  vs closed; flagged for the coordinator).
- `support_max_new_tickets_24h` (default 3): count of tickets with
  created_at >= now − 24h, INCLUDING soft-deleted ones (U-25 exact).
- 0 = unlimited for either key (documented choice per brief);
  unparseable/negative stored values fall back to the defaults
  (fail-safe toward the operator's stated limits, never toward a
  lockout at 0 by typo).
Rejections are flash redirects to /support naming the live count and
the limit (true reasons). lib/settings.js itself needs no change:
getS(settings, key, fallback) already implements defaulted reads —
recorded here so the admin worker wires the Settings form to these
exact key names.

## U-25 — Support ticket soft delete (player side)

VERDICT: migration EXISTS as briefed — lib/migrations.js:1066
version 19 adds support_tickets.deleted_at / deleted_by (all three
dialects). No player delete route or deleted_at filter exists yet:
every player ticket query (routes/player.js:834 list, :856 detail,
:865 reply, :880 close, :889 reopen) selects without a deleted_at
condition.
FIX (routes/player.js):
- New endpoint POST /support/:publicId/delete (same POST+CSRF+
  flash/redirect pattern as the neighbouring close/reopen actions;
  no new confirm pattern invented). Own live ticket → sets
  deleted_at = now(), deleted_by = req.user.id, audit.log action
  'support.delete' (actor = the player, entity support_ticket).
  Foreign / missing / already-deleted → identical flash
  'Ticket not found.' + redirect to /support (no existence leak,
  matching the file's foreign-ticket handling). No notification
  email is sent (the handler simply never calls notify).
- List, detail, close, reopen queries gain `deleted_at IS NULL`;
  a deleted ticket's detail URL returns the same 404 as a missing
  one and leaks no content.
- Reply gate (U-18) also refuses deleted tickets with a true reason:
  the reply handler looks the ticket up WITHOUT the deleted filter
  scoped to the owner, so an own deleted ticket gets 'This ticket
  has been deleted and can no longer be replied to.' while foreign
  tickets keep the indistinguishable silent redirect.
- U-19 interplay implemented exactly as specified: the 24h creation
  count has NO deleted_at filter (deleting never refunds quota);
  the open-ticket count HAS deleted_at IS NULL (deleting an open
  ticket frees the slot).

## RESULTS ADDENDUM (post-fix, same day)

All fixes above are implemented in routes/player.js, routes/scratch.js
and lib/auth.js only. lib/settings.js needed no change (getS already
implements defaulted reads — see U-19). lib/money.js untouched per the
coordinator's ownership update; nothing in this round needed a
money.js change (the enriched messages read balances through the
existing exported getBalances).

New tests: test/v20-money-errors.test.js (10 tests: parseUA units,
lottery/scratch/deposit/withdraw true-reason E2E, raw-UA absence,
single-hop XFF, absolute referral) and test/v20-support.test.js
(5 tests: turn-taking incl. a real admin-route reply, both U-19 caps,
the settings flip to 0, U-25 delete + audit + no-leak, IDOR delete).
Both files pass solo and inside the full suite.

Full suite (final run): 135 tests = 133 pass / 1 fail / 1 skipped
(PG adapter). The single failure is v19-features BP-14, whose
assertions demand the verbatim user-agent display that U-04 orders
removed — it cannot pass until the coordinator updates those two
assertions (/V19PlayerBrowser/, /V19SecondBrowser/) to the human
labels. An earlier subset run also flaked tamper BP-26's
probabilistic scratch win-hunt (no winner in its first ~14 shuffled
outcomes under the 10/min buy cap); it passes solo and passed in the
final full run — pre-existing test luck, unrelated to this round.

OUTSTANDING (coordinator action): the U-04(b) one-line server.js
change specified above (trust proxy list) is NOT applied — server.js
is outside this worker's ownership. Until it lands, new production
sessions behind Render's multi-entry XFF still store the internal
proxy IP; stored rows are unaffected either way.
