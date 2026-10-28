# AUDIT P — Player buy flow / site / responsible play / timezone

- **Area:** P (routes/player.js buy flow deep, routes/site.js remaining,
  lib/scratch.js responsible-play enforcement as used by player routes,
  timezone/DST, player-route error handling and logging). Agent pages
  (routes/agent.js) skimmed for the same money/session issues.
- **Baseline:** fix copy at ~/workspace/cash-pop-fix (contains round-1 fixes).
  No code file was modified by this audit. No push, deploy, or zip.
- **Files read fully:** routes/player.js (553 lines), routes/site.js,
  lib/scratch.js, lib/draws.js, lib/cron.js, lib/money.js, routes/scratch.js
  (player router + scratch admin stop handler), server.js (maintenance /
  error-handler / boot blocks), lib/auth.js, routes/auth.js (login, logout,
  reset sections), routes/agent.js, public/app.js (countdown + stats),
  views/error.ejs, views/verify.ejs, views/results.ejs, views/play.ejs
  (wager/balance lines), lib/util.js (toMinor / signTicket / randHex).
- **Cross-checked, not re-reported:** ~/workspace/cash-pop-fix/NEW-BUGS-217.md
  §2, ~/workspace/cash-pop-fix/FIX-LOG.md (round-1 fixes),
  ~/workspace/your_files/cash-pop-lottery/cash-pop-bug-audit-235.md
  (B-001..B-235). Every §2 P-headline was re-checked against current code;
  fixed ones are listed under "Checked and clear", merged ones get one line
  each below. No finding below duplicates a FIX-LOG or B-item.
- **Tally (confirmed only): 19 findings = 1 High, 5 Medium, 13 Low.**

## Findings

### P-01 — Medium — Lottery buys debit ONLY the base-currency wallet; a non-base depositor cannot play lottery at all (§2 P-6, re-confirmed live in code)
- **Where:** routes/player.js:70 `const currency = baseCurrency(req);`,
  routes/player.js:23 (`/play` balance is the base-currency wallet only),
  routes/player.js:95 `postLedger(tx, { …, currency, type: 'ticket_purchase', amount: -total, … })`.
  Supporting: `convertMinor` has zero callers — only its export at
  lib/util.js:107 — so no conversion path exists anywhere.
- **What goes wrong:** A player who deposited EUR (or any non-base currency)
  holds a EUR wallet with funds, but `/play` shows the USD wallet ($0.00)
  and every lottery buy debits USD via `postLedger`, whose guarded update
  throws `Insufficient balance`. There is no currency picker on the buy
  path and no conversion. Scratch is slightly better (it debits the series
  currency, lib/scratch.js:242), but lottery has no equivalent choice.
- **Consequence:** Non-base-currency players are hard-blocked from the
  flagship game despite funded wallets; support load + lost sales, and a
  confusing "$0.00 balance" for a funded account.
- **Fix pointer:** Let the playslip select among the player's funded
  wallets (or implement `convertMinor` at a validated rate) and debit the
  chosen currency; show that wallet's balance on `/play`.

### P-02 — Medium — Lottery buy re-checks draw status inside the txn but NOT close_at: buys succeed after a draw has closed
- **Where:** routes/player.js:86-88 — inside the buy transaction the
  re-check is only
  `const d = await tx.get("SELECT status FROM draws WHERE id = ?", [did]);`
  `if (!d || d.status !== 'scheduled') throw …`.
  The outer selection (routes/player.js:57-61) requires
  `close_at > ?`, but nothing re-checks `close_at` inside the transaction.
  Settlement runs on the `ensure_draws` cron job, seeded `active` with
  interval **60 minutes** (lib/migrations.js:125, seeded at :816-818), so a
  closed draw stays `status='scheduled'` until the next hourly run.
- **What goes wrong:** Between `close_at` and the next hourly settle tick
  (up to ~60 minutes after every draw close, plus any buy request that
  starts before close and commits after it), a buy for the closed draw
  passes both checks, takes money, and creates `pending` entries that then
  settle normally. Sales-after-close is systematic, not a millisecond race.
- **Consequence:** The published close time is not enforced; late buyers
  enter a draw after betting was supposed to stop (they cannot know the
  winning number in advance — the seed is still unrevealed — so this is a
  close-discipline violation, not a guaranteed-win exploit).
- **Fix pointer:** Inside the buy transaction, reject any draw with
  `close_at <= now()` alongside the status check (same loop, one condition).

### P-03 — Medium — No per-draw / per-user stake cap and no rate limit on lottery buy (scratch buy has both patterns)
- **Where:** routes/player.js:30 `router.post('/play/buy', requireLogin, …)`
  carries no `rateLimit` middleware, unlike scratch buy
  (routes/scratch.js:107-109, 10/min per user) and scratch reveal
  (routes/scratch.js:97, 12/min). No setting, query, or check caps a
  user's total stake on one draw; the only bounds are per-ticket
  arithmetic (`pops ≤ 15`, wager options, draws per type).
- **What goes wrong:** One account can buy unlimited tickets for the same
  draw. At default settings a single ticket can already be
  15 pops × $10 × 14 draws (BOTH × 7) = $2,100, and there is no limit on
  how many such tickets one user buys for one draw, nor any throttle on
  rapid-fire buy submissions.
- **Consequence:** Unbounded exposure concentration on a single draw
  number-set, and a bot can hammer the buy endpoint at full speed
  (each buy is transaction-safe, but nothing slows abuse or bounds
  single-draw liability).
- **Fix pointer:** Add `rateLimit` to `/play/buy` (mirroring scratch buy)
  and a per-user-per-draw stake cap setting enforced inside the buy txn.

### P-04 — Medium — `session_limit_minutes` is collected, stored, and displayed, but NEVER enforced anywhere
- **Where:** Collected at routes/scratch.js:42
  (`Math.max(0, Math.min(1440, …))`), stored by routes/scratch.js:60-67,
  returned by `responsibleStatus` (lib/scratch.js:157-174, including the
  24h-pending path). A grep over routes/, lib/, and server.js finds no
  enforcement: no buy path, login path, or middleware ever reads the
  value to block, warn, or log out a player.
- **What goes wrong:** A player who sets "stop me after N minutes" gets a
  saved setting and a UI that implies protection, but play continues
  indefinitely. Only the loss limit, cooling-off, and self-exclusion are
  actually enforced (`enforceAccountPlayable`, lib/scratch.js:186-190).
- **Consequence:** A responsible-play promise is silently broken; a
  player relying on the session limit has no protection at all.
- **Fix pointer:** Enforce it (e.g. session-age check in the buy paths
  and/or a middleware that forces a break + notice once the limit passes),
  or remove the setting from the UI until it is real.

### P-05 — Medium — Payment-method charge can exceed the amount, producing a negative net: deposit approval then debits the player, or the deposit can never be approved
- **Where:** lib/money.js:86-94 (`createDeposit`: `net = amountMinor - charge`)
  and lib/money.js:139-148 (`createWithdrawal`: same formula); `chargeFor`
  (lib/money.js:68-73) is clamped at ≥ 0 but has no cap relative to the
  amount. Admin method validation checks only `rate > 0` and
  `percent_charge >= 0` (routes/admin.js:965-970 create, :994-998 edit) —
  no upper bound on percent (150% is accepted) and no fixed-charge vs
  min-amount check. The player deposit route checks only min/max
  (routes/player.js:212-213), never amount-vs-charge.
- **What goes wrong:** A method with fixed charge $5 and min amount $1, or
  percent charge > 100%, yields `net < 0`. On deposit approval
  (`decideDeposit` posts `d.net` via `postLedger`) a negative net is a
  **debit**: if the player has balance ≥ |net| the approval takes money
  out of their wallet for a deposit they paid for off-platform; if not,
  `postLedger` throws `Insufficient balance`, the approval transaction
  rolls back, and the deposit is stuck `pending` forever (reject is the
  only way out). A withdrawal with negative net is likewise recorded as a
  negative payout amount on approval.
- **Consequence:** Operator misconfiguration directly harms players
  (wallet debit on "approval") or bricks deposits; the failure mode is
  silent until an admin tries to approve.
- **Fix pointer:** Reject `charge >= amount` in `createDeposit` /
  `createWithdrawal` (fail the request with a clear message) and validate
  at method save: percent ≤ 100 and fixed charge < min amount.

### P-06 — Low — Scratch buy does not re-check series status/enabled inside its transaction (lottery buy does re-check draws; scratch does not)
- **Where:** lib/scratch.js:224-228 — the series is read OUTSIDE the
  transaction (`SELECT … WHERE id=? AND status='live' AND enabled=1`),
  then the transaction only claims an outcome
  (`SELECT … FROM scratch_outcomes WHERE series_id=? AND ticket_id IS NULL`,
  :228) and debits the outer-read price/currency (:234, :242). No
  in-transaction re-read of the series row.
- **What goes wrong:** If an admin stops or disables a series between the
  outer check and the commit, the buy still succeeds — the opposite of
  the lottery-buy pattern (routes/player.js:86-88) that was added
  precisely to close this class of gap.
- **Consequence:** Sales of a stopped/disabled series in the stop window;
  small window (milliseconds per buy) but the inconsistency with the
  lottery path means the stop button is not a reliable kill switch.
- **Fix pointer:** Re-read the series row inside the transaction and abort
  unless it is still `live` + enabled; use the re-read price/currency.

### P-07 — Low — Withdrawal OTP-verify step does not re-check the global / per-user withdrawal policy
- **Where:** routes/player.js:320-342 (`POST /withdraw/verify`) re-checks
  only that the method is still enabled (:328) and the v14 rules
  (`checkWithdrawalRules`, :332). It never re-calls `withdrawalPolicy`
  (lib/money.js:60-66: `withdrawals_enabled`, `withdrawal_blocked`,
  verified-contact gate), although `POST /withdraw/new`
  (routes/player.js:259-260) checks it before the OTP step.
- **What goes wrong:** If an admin disables withdrawals globally, blocks a
  user's withdrawals, or the user's verified-contact status lapses between
  OTP request and OTP verify, the verify step still creates the
  withdrawal.
- **Consequence:** Limited — the created withdrawal is only a `pending`
  request that still needs admin approval — but the kill switch /
  per-user block is bypassed for in-flight OTP verifications.
- **Fix pointer:** Call `withdrawalPolicy` at the top of `/withdraw/verify`
  and refuse (clearing `pending_withdrawal`) when it is no longer allowed.

### P-08 — Low — No balance check before the withdrawal OTP step: insufficient-balance failures surface only after the code is verified
- **Where:** routes/player.js:259 (`POST /withdraw/new`) checks policy,
  method, min/max, and `checkWithdrawalRules` (lib/money.js:213-262:
  turnover, daily/monthly caps, payout lock, same-method — no balance
  check). The balance is first touched at `createWithdrawal` via the
  guarded `postLedger` hold (lib/money.js:139-155), which runs only after
  OTP verification (routes/player.js:342).
- **What goes wrong:** A player with insufficient balance is sent a
  one-time code, verifies it, and only then gets `Withdrawal failed:
  Insufficient balance`. The OTP send/verify cycle is wasted, and a
  low-balance account can trigger OTP sends for withdrawals that can
  never succeed.
- **Consequence:** Confusing UX + wasted OTP deliveries; minor OTP-abuse
  surface (OTP rate limiting itself is W-area, not re-audited here).
- **Fix pointer:** Check `balance >= amount` for the method currency
  before creating/sending the OTP (same balance lookup the GET page
  already does, routes/player.js:251-252).

### P-09 — Low — Withdrawal / deposit payout details (bank details, wallet addresses) are stored as plaintext JSON
- **Where:** lib/money.js:94 (`createDeposit`: `JSON.stringify(userData)`)
  and :148 (`createWithdrawal`: same) into `deposits.user_data` /
  `withdrawals.user_data`, with no encryption. Contrast provider
  credentials, which are AES-256-GCM encrypted when a key is configured
  (routes/admin.js:1032 note).
- **What goes wrong:** Every custom payout field the player types — bank
  account numbers, wallet addresses, transfer references — sits in
  plaintext in the database, readable by anyone with DB access, and is
  rendered on the admin deposit/withdrawal detail pages (staff-visible by
  design for manual payout, but unencrypted at rest).
- **Consequence:** Financial PII exposed in backups/DB dumps; a DB leak
  leaks payout details alongside everything else, with no encryption
  layer to slow it down.
- **Fix pointer:** Encrypt `user_data` at rest with the same credential
  key mechanism, or at minimum encrypt fields flagged sensitive in the
  method's custom-field definition.

### P-10 — Low — Deposit/withdrawal custom-field ("proof") values have no per-field length cap; there is no file upload to allowlist at all
- **Where:** routes/player.js:216-218 (deposit) and :272-274 (withdrawal):
  `const v = String(req.body['custom_' + f.key] || '').trim();`
  `userData[f.key] = v;` — required-ness is checked, length is not. The
  only bound is the 2 MB global body limit (server.js urlencoded/json
  parsers). A repo-wide grep finds no upload handling (`multer` absent;
  "upload" appears only in a rail instruction string, lib/rails.js:90) —
  "proof" is a free-text field (transaction hash / reference), not a file.
- **What goes wrong:** A player can submit a multi-hundred-KB "proof"
  string per field; it is stored verbatim in `user_data` JSON and rendered
  in full on the admin detail page (escaped — see Checked section — but
  unbounded in size).
- **Consequence:** DB bloat and bloated admin pages from junk input; no
  security hole (values are escaped on render), but no sane bound exists.
- **Fix pointer:** Cap each custom-field value (e.g. 255 chars for
  references, 500 for notes) at the deposit/withdrawal POST handlers.

### P-11 — Low — Player-route error paths echo raw error messages, which can include DB driver text
- **Where:** routes/player.js:133 (`'Purchase failed: ' + e.message`),
  :230 (`'Deposit failed: ' + e.message`), :315 and :348
  (`'Withdrawal failed: ' + e.message`), routes/scratch.js:114
  (`'Scratch purchase failed: ' + e.message`). The unhandled-error
  handler itself is generic (server.js:425, "Something went wrong…"),
  but these route-level catches are not.
- **What goes wrong:** Most thrown messages are benign (`Insufficient
  balance`, limit messages), but any unexpected throw — a constraint
  violation, a driver syntax error, a downstream failure — is rendered
  verbatim into the player's error page, leaking schema/driver internals.
- **Consequence:** Low-grade information disclosure + confusing errors
  for players; the generic 500 page shows the team already chose the
  safe pattern elsewhere.
- **Fix pointer:** Map known user-facing errors to fixed messages and
  render a generic "Purchase failed, please try again" fallback for
  anything else (log the raw error server-side).

### P-12 — Low — Homepage / API stats mix currencies into one number, and recent-win formatting hardcodes USD
- **Where:** routes/site.js:21 (`SELECT COALESCE(SUM(amount),0) … WHERE
  type = 'win'` — no currency filter) formatted at :27 / homepage :54 via
  `req.fmt` in the visitor's display currency; :28 hardcodes
  `req.fmt(w.amount, 'USD')` for every recent win regardless of the win's
  actual currency. Same pattern on the agent dashboard:
  routes/agent.js:22-29 sums all commission currencies and labels the
  total with the base currency.
- **What goes wrong:** On a multi-currency site the public "Total paid
  out" figure is a meaningless cross-currency sum, and a EUR win is
  displayed with a USD format. These are the site's public marketing
  figures (the fake-stats mode was removed precisely so these numbers
  would be honest — FIX-LOG B-053).
- **Consequence:** Misleading public totals once more than one currency
  is in use; single-currency deployments are unaffected.
- **Fix pointer:** Sum and display paid-out / commissions per currency
  (or restrict the headline figure to the base currency with a filter).

### P-13 — Low — Results page has no pagination or filter, and result rows do not link to their fairness proof
- **Where:** routes/site.js:70-72 (`/results`: settled draws,
  `ORDER BY close_at DESC LIMIT 60`, no page/offset/type/date filter).
  views/results.ejs renders plain rows with no link to
  `/fairness?draw_id=<id>` (the page only links to `/fairness` in prose);
  verifying a specific result requires hand-typing its numeric draw ID
  into the fairness form (views/verify.ejs).
- **What goes wrong:** Draws older than the latest 60 are unreachable from
  the UI, there is no way to filter by draw type or date, and the
  results→proof path — the core provably-fair UX — is a manual step
  most players will not take.
- **Consequence:** Reduced verifiability in practice and an incomplete
  results archive; no money impact.
- **Fix pointer:** Add pagination (and type/date filter) to `/results` and
  a per-row "Verify" link to `/fairness?draw_id=<id>`.

### P-14 — Low — Countdown sticks at "Closing…" forever with no resync; a stale playslip can still submit
- **Where:** public/app.js:198-213 — `tick()` recomputes from
  `Date.now()` each second (so no accumulated drift, and client clock
  skew is the only drift source), but on `ms <= 0` it sets
  `el.textContent = 'Closing...'` and never refetches draws, reloads, or
  disables the buy form. Server-side close enforcement is also missing
  (P-02), so the stale page is not just cosmetic.
- **What goes wrong:** A player who leaves the playslip open past close
  sees a frozen "Closing…" label and can still submit a buy that the
  server will accept until the hourly settle runs (P-02).
- **Consequence:** UX dead-end + the visible half of the post-close-buy
  hole; fixing P-02 closes the money side, this closes the display side.
- **Fix pointer:** On reaching zero, refetch the draw list (or reload)
  and disable the buy form until fresh draws arrive.

### P-15 — Low — Session cookie maxAge and DB session TTL disagree (units are correct; the lifetimes are not aligned)
- **Where:** Cookie lifetimes — anon captcha session 1 h
  (routes/auth.js:19, `maxAge: 3600000`), pre-auth TOTP session 15 min
  (routes/auth.js:176, `maxAge: 15 * 60 * 1000`), login session 7 days
  (routes/auth.js:203 and :454, `maxAge: 7 * 24 * 3600 * 1000`), currency
  cookie 1 year (routes/site.js:97). DB lifetime — lib/auth.js:8
  `SESSION_TTL = 7 days`, and `touchSession` (:35-37) extends the DB
  `expires_at` by a fresh 7 days on every touch, but no middleware
  re-issues the browser cookie.
- **What goes wrong:** All `maxAge` values are correctly in milliseconds
  (no units bug). The mismatch is behavioral: an active user's DB session
  keeps sliding forward via touches while the browser cookie still
  expires 7 days after login, so active users are logged out at day 7
  despite activity; conversely, abandoned pre-auth/anon DB rows linger
  up to 7 days after their 1 h / 15 min cookies are long dead.
- **Consequence:** Annoying forced logouts for active users; orphaned
  session rows (unusable without the cookie — IDs are 64-hex random,
  lib/util.js:7 — so not a hijack vector).
- **Fix pointer:** Re-issue the `sid` cookie with a fresh maxAge whenever
  `touchSession` extends a session, or stop sliding DB expiry and align
  both lifetimes to a single idle timeout.

### P-16 — Low — No logged-in password-change route; the only password changes are logged-out reset and forced reset
- **Where:** The player security section offers only TOTP setup/confirm/
  disable/backup and session revocation (routes/player.js:451-512). No
  `/security/password` or equivalent route exists; password change is
  possible only via the logged-out forgot/reset flow (routes/auth.js:322+,
  which does revoke all sessions and does breached-checking) or the
  forced-reset gate (routes/player.js:429+, same protections).
- **What goes wrong:** A signed-in player who suspects their password is
  compromised must log out and go through email reset — there is no
  in-session "change password" that also revokes other sessions, which
  is the standard response to a suspected compromise.
- **Consequence:** Friction at exactly the moment a user wants to lock
  an account down; the existing flows are safe, just unreachable while
  signed in.
- **Fix pointer:** Add an in-session password-change route reusing the
  existing breached check + `destroyUserSessions(except current)`
  pattern from the force-reset handler.

### P-17 — Low — TOTP disable and backup-code regeneration do not revoke other sessions
- **Where:** routes/player.js:481-493 (disable) and :495-508 (backup
  regen) — both correctly require password + current TOTP/backup code
  (round-1 fix) and audit-log, but neither calls `destroyUserSessions`.
  Contrast force-reset (routes/player.js:445: revokes all other
  sessions) and the explicit revoke button (:510-511).
- **What goes wrong:** After a user disables 2FA (or rotates recovery
  codes) from one device, sessions on other devices — including one on a
  lost/stolen device — remain fully valid. Disabling 2FA lowers the
  account's defenses while leaving every existing session untouched.
- **Consequence:** A user who disables 2FA expecting to re-secure the
  account does not actually evict other sessions; they must remember to
  press "sign out all other sessions" separately.
- **Fix pointer:** Call `destroyUserSessions(db, userId, currentSessionId)`
  on TOTP disable and on backup-code regeneration.

### P-18 — Low — Referral and agent commissions accrue with no referrer/agent status check (banned referrers/agents still earn)
- **Where:** routes/player.js:108-121 — the buy transaction inserts a
  pending referral credit for `buyer.referred_by` and an agent commission
  for `req.user.agent_id` with no status lookup on either account; and
  `releaseReferralCredits` (lib/money.js) credits the referrer without
  checking the referrer's status. (Banned players cannot buy — session
  load destroys banned sessions, lib/auth.js — but the *recipient* side
  is unchecked.)
- **What goes wrong:** If a referrer or agent is banned after referring,
  their pending credits still release into their wallet on the referee's
  next qualifying buy/deposit, and new agent commissions keep accruing
  on their players' purchases.
- **Consequence:** Banned accounts keep earning from the platform;
  finance must claw back manually (no automatic path exists).
- **Fix pointer:** Skip commission/credit creation and release when the
  referrer/agent account status is `banned` (or route it to a held state
  for admin review).

### P-19 — High — Production HMAC guard fires only when NODE_ENV=production, but the start script never sets it (§2 P-26, re-confirmed)
- **Where:** server.js:50-52 — the boot guard is
  `if (process.env.NODE_ENV === 'production' && (!process.env.TICKET_HMAC_SECRET || … === 'dev-secret-change-me')) throw …`.
  The fallback secret is used unconditionally in both signing and
  verification: routes/player.js:74
  (`process.env.TICKET_HMAC_SECRET || 'dev-secret-change-me'`) and
  lib/draws.js:151 (same). package.json `start` is plain
  `node server.js` with no NODE_ENV assignment.
- **What goes wrong:** If the production host runs without
  `NODE_ENV=production` (the live value is not verifiable from this
  audit — see Needs-check), the server boots happily with the
  repo-public fallback secret. Anyone who knows the fallback (it is in
  the repo) can forge ticket HMACs: a tampered ticket's pops/wager/total
  can be re-signed to pass the settle-time verification
  (lib/draws.js:151-157) that exists precisely to catch tampering.
- **Consequence:** The v16 ticket-tamper protection is silently void in
  any deployment where NODE_ENV is unset or non-production — forged
  tickets could settle and pay on altered data.
- **Fix pointer:** Fail boot whenever `TICKET_HMAC_SECRET` is unset or
  equal to the fallback, regardless of NODE_ENV (or set
  `NODE_ENV=production` in the start script / host env and keep the
  guard as defense in depth).

## Merged items — one line each (owned by another area, NOT counted above)
- **P-17→M-5:** Fixed — driver-conditional locking (`lockSuffix`) is in
  place; no `FOR UPDATE` on SQLite paths (FIX-LOG (a)).
- **P-14→M-11 (ORDER BY note):** Still missing — `settleDueDraws`
  (lib/draws.js:77) selects due draws with no `ORDER BY` at all, so
  settlement order (and any close_at/id tiebreak) is unspecified.
- **P-10→M-35:** Still local-time — both loss windows use server-local
  midnight (lib/scratch.js:198 scratch, :214 lottery, `setHours`),
  while withdrawal caps use UTC midnight (lib/money.js:225-226); on a
  UTC host they coincide, on any other TZ the day boundaries differ.
- **P-42→G-44:** Still live — series stop logs the full server seed in
  plaintext (routes/scratch.js:296 `{ seedReveal: s.server_seed }`); no
  verification flow consumes the series seed (scratch verify uses the
  per-ticket nonce).
- **P-9→M-32:** Lottery loss check now inside the buy txn
  (routes/player.js:92-93, round-1 fix); the scratch path still checks
  OUTSIDE its transaction (`enforceResponsiblePlay` at
  lib/scratch.js:226 before the txn at :227), so concurrent scratch buys
  can both pass the limit before either debits.
- **P-15→M-16:** Still swallowed — win-notification failures inside
  settle are caught and ignored (lib/draws.js:211 `catch {}` around
  `notify.send`); no outbox/audit row records the failure.
- **P-35→W-24:** Shared limiter renders HTML 429 even for JSON endpoints
  (lib/auth.js `rateLimit` renders the error page unconditionally).
- **P-28→W-4:** Session-less POSTs skip CSRF (server.js CSRF middleware:
  `if (!req.sess) return next()`); login CSRF / OTP-request abuse with
  captcha disabled is the W-owned mechanism.

## Checked and clear (verified NOT bugs — do not re-report)
- **Duplicate pops / wager / draw-type validation:** pops are deduped via
  `Set`, range-filtered 1–15, sorted (routes/player.js:36);
  wager must be in `req.wagerOptions`; draw type restricted to DAY/EVE/
  BOTH; `num_draws` clamped to `max_draws`. Draw IDs are server-selected,
  never trusted from the client.
- **Lottery draw re-check (status half):** in-transaction status re-check
  exists (routes/player.js:86-88) and the debit rolls back with it; the
  gap is only the missing close_at half (P-02).
- **Self-exclusion / cooling-off at lottery buy:** enforced before draw
  selection (routes/player.js:49-50 via `enforceAccountPlayable`,
  lib/scratch.js:186-190) and in scratch buy via `enforceResponsiblePlay`
  (lib/scratch.js:194); the residual TOCTOU (exclusion set mid-flight)
  is a millisecond window with no exploit path and is not counted.
- **Lottery loss limit atomicity (round-1):** `enforceLotteryLossLimit`
  runs inside the buy txn (routes/player.js:92-93) — excluded per FIX-LOG.
- **Maintenance-mode buy block:** the server middleware gates ALL methods
  before the routers (server.js:306-329: GET → 503 page, other methods →
  503 JSON; admin path matched exactly or as a real sub-path), so no
  in-route maintenance re-check is needed on `/play/buy`.
- **Deposit/withdrawal policy gates:** both GET and POST check
  `depositPolicy`/`withdrawalPolicy` (routes/player.js:203-205, :259-260);
  method re-queried with `enabled = 1` at POST (:208, :264 area);
  same-method preference/lock re-checked at OTP verify (:332).
- **Withdrawal fee-vs-balance:** `createWithdrawal` holds the FULL amount
  immediately through the guarded `postLedger` (lib/money.js:139-155),
  so a withdrawal cannot exceed the balance and the fee is retained
  implicitly (full hold, net paid out) — no separate fee-vs-balance hole.
  Withdrawal daily/monthly caps use UTC day/month
  (lib/money.js:225-226) and are internally consistent.
- **Deposit proof XSS:** player-submitted proof is escaped on the admin
  detail page (routes/admin.js:767 area: `esc(k)`, `esc(v)`); no file
  upload exists, so there is no extension allowlist/size-cap surface —
  the residual issue is only the uncapped text length (P-10).
- **Scratch nonce leak (P-40 area):** NOT leaking — the ticket detail
  route nulls `prize`/`nonce`/`ordinal` for unrevealed tickets
  (routes/scratch.js:88-92 area), the verify page shows the nonce only
  in the revealed branch (views/scratch_verify.ejs), and the buy action
  only redirects (routes/scratch.js:107-114) with no outcome data in the
  response. Scratch outcome claim + reveal credit are guarded with
  changes checks (lib/scratch.js:240-241, reveal path).
- **Gold Rush re-seed on delete (§2 P-39):** FIXED for every UI-available
  action — boot re-seeds Gold Rush only when no live series exists AND
  no `gold-rush` row exists (server.js:94-96: "leaving operator choice
  untouched"); stopping a series is respected across restarts, and the
  scratch admin UI offers no delete button (launch/toggle/stop only).
  Residual DB-direct row deletion is noted under Needs-check, not counted.
- **SESSION_SECRET (§2 P-41):** Dead by design, not a vulnerability —
  the string appears nowhere in code (only in README-DEPLOY.md:28, which
  documents it as NOT required); sessions are opaque random IDs
  (lib/util.js:7 `crypto.randomBytes`) validated by DB lookup, never by
  signature, so there is no signing path for the secret to be dead in.
- **Session lifecycle, core paths:** logout deletes the DB row + clears
  the cookie (routes/auth.js:208-211); login rotates sessions
  (finishLogin destroys the old session, routes/auth.js:196-203);
  forgot-password reset destroys ALL user sessions
  (routes/auth.js:356-357 area) and breached-checks the new password
  (:349-352); force-reset revokes other sessions (:445 in player.js
  flow) and breached-checks; agent-created players must reset at first
  sign-in. Cookie `maxAge` units are all correct milliseconds
  (P-15 is about lifetime alignment, not units).
- **Phone-verified reset, TOTP disable/backup regen second factor,
  responsible-play 24h pending, lottery loss limit:** round-1 fixes per
  FIX-LOG — verified present, not re-reported.
- **Unhandled-error page:** generic message, no stack/internals
  (server.js error handler; views/error.ejs renders only `status` +
  `message`). Route-level echoes are the separate Low P-11.
- **Draw scheduling / DST:** `closeAtFor` builds UTC epoch times from the
  configured HH:MM (lib/draws.js `Date.UTC`), draw dates are UTC
  (`toISOString`), settlement compares epoch ms, and cron jobs are
  interval-based (`next_run_at = started + interval_minutes`, lib/cron.js)
  — no wall-clock or DST sensitivity in scheduling, settlement, or
  countdown math (countdown recomputes from `Date.now()` each tick,
  public/app.js:198-213; its gap is the frozen "Closing…" state, P-14).
- **Results TEST labelling:** settled TEST draws are badge-labelled
  TEST in results (views/results.ejs) and on the fairness page
  (views/verify.ejs), with the "excluded from payouts" note; TEST draws
  cannot be bought (buy selects DAY/EVE only). The known TEST-draw
  number MISMATCH (override not derived from seed) is accepted per
  FIX-LOG and not re-reported.
- **Fairness pre-settle reveal:** settled-only via `fairnessForDraw`
  (lib/draws.js) with "Not settled yet" badges (views/verify.ejs) —
  round-1 B-022 fix, verified present.
- **Ticket HMAC display:** `t.hmac.slice(0, 16)` (routes/player.js:159)
  cannot crash on NULL — `hmac` is NOT NULL in all three DDL variants
  (lib/migrations.js:207, :339, :465).
- **Agent pages (skim):** agent router requires login + agent/admin role
  (routes/agent.js:14); agent scoping is by own id for agents
  (`agentId`), transfers target only own players with a guarded float
  debit (routes/agent.js:111-125 area) and audit; agent-created players
  get `force_password_reset = 1` with breached-checked creation
  (routes/agent.js:69-92 area). Commission-currency mixing is P-12;
  banned-recipient accrual is P-18.
- **Audit logging present on player money paths:** ticket buy, deposit
  create, withdrawal create (both OTP and non-OTP paths), profile update,
  phone verification, TOTP enable/disable/backup-regen, agent transfer.
  (Absence of audit rows for session-revoke, TOTP-start, verify-email
  request, and support-ticket create/reply was noted but is below the
  bar for a counted finding — no money moves on those paths except
  support, which is a messaging feature.)

## Needs-check (NOT counted)
- **Live NODE_ENV value (cf. §4 P NC-3):** P-19 bites only if production
  runs without `NODE_ENV=production`. The code facts (conditional guard,
  repo-public fallback, plain `node server.js` start) are verified; the
  Render host's actual env value was not checked from this audit.
- **Gold Rush after DB-direct row deletion:** if an operator deletes the
  `gold-rush` row directly in the database (no UI delete exists), the
  next boot cannot distinguish that from a fresh wipe and re-seeds it
  (server.js:94-111). Operator intent is unknowable at boot; only a
  persistent "do not reseed" flag would close this, and it is a
  deliberate-boot-heuristic question, not a counted bug.
- **Live draw-close behavior under load:** P-02's window assumes the
  hourly `ensure_draws` job stays `active`; if an operator pauses it,
  the post-close buy window extends until it next runs. Verified from
  the seed (active, 60 min); live job status was not checked.
- **Session-limit UX contract:** whether `session_limit_minutes` was ever
  promised as enforced (vs. aspirational) is a product question; the
  code fact — stored but never read for enforcement — is verified
  (P-04).
