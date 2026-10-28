# AUDIT M — money / draws / DB engine (v17 recovery, fresh re-audit)

- Area: M = `lib/money.js`, `lib/draws.js`, `lib/db.js`, `lib/scratch.js`, `lib/rails.js`, `lib/util.js`
- Base: fix copy `~/workspace/cash-pop-fix` (already contains round-1 fixes). AUDIT ONLY — no code file was modified.
- Inputs read first: `NEW-BUGS-217.md` §2, `FIX-LOG.md`, `cash-pop-bug-audit-235.md` (B-001..B-235).
- Exclusions honoured: every B-item, every FIX-LOG round-1 fix (FOR UPDATE lockSuffix,
  settle guards, referral cap, OTP seeds, OAuth gate, loss limit in the lottery buy,
  19 old Critical/High), and B-179 (drand BLS signature never verified — already in the 235 report).
  Where a §2 headline is already fixed, it is listed under "Checked and clear", not counted.
- Line numbers below were verified by reading the code and by `grep -n` on the fix copy.
  Where a finding spans a block, the anchor line quoted is the verified one.
- Tally (confirmed only): **28 findings = 2 High, 11 Medium, 15 Low.**

## §2 headline disposition (re-confirmed, not copied blindly)

- M-16 win-notify swallowed → STILL OPEN, counted as M-04.
- M-25 DB_DRIVER fallthrough → STILL OPEN, counted as M-02.
- M-27 PG SSL rejectUnauthorized → STILL OPEN, counted as M-03.
- M-32 loss check outside buy txn → SPLIT: lottery buy FIXED (inside txn, routes/player.js:93),
  scratch buy STILL OPEN, counted as M-05.
- M-35 daily window local vs UTC → STILL OPEN, counted as M-06.
- M-42 convertMinor dead/unvalidated → STILL OPEN, counted as M-17. The "hardcoded rate"
  part of the old headline is NOT confirmed: current code uses the settings currency rates
  (`t.rate / f.rate`); the live defects are dead code + fail-open on missing/zero rate.
- M-43 no draw-cancel/refund path → STILL OPEN, counted as M-18.
- P-14 ORDER BY tiebreaker (merged into M-11) → STILL OPEN and worse than a missing
  tiebreaker: `settleDueDraws` has NO ORDER BY at all, counted as M-12. (The M-11
  per-draw try/catch itself IS fixed and is not re-reported.)

## Findings

### M-01 — High — Beacon HTTP fetch runs INSIDE the settle transaction; on SQLite it holds the whole-DB write lock and interleaves unrelated writes
- Files: `lib/draws.js:94` (`const out = await db.transaction(async (tx) => {`), `lib/draws.js:122`
  (`const b = await fetchBeacon();` inside that callback); `lib/db.js:26-32` (SqliteDB
  `transaction()` does `BEGIN IMMEDIATE` on the single shared `DatabaseSync` connection, then
  `await fn(tx)`); `lib/beacon.js` fetch timeout 4000 ms.
- What goes wrong: `settleDraw` awaits a network call (up to 4 s, per draw, sequentially in
  the `settleDueDraws` batch) while the transaction is open. On SQLite every other request
  shares the same connection: a concurrent request that starts its own transaction gets
  "cannot start a transaction within a transaction" (writes fail for the whole beacon wait),
  and a concurrent request that uses plain `db.run`/`db.query` executes *inside* the open
  settle transaction — if settle then rolls back (e.g. HMAC mismatch, missing prize row),
  those unrelated writes are rolled back with it; if it commits, they commit early. On
  Postgres/MySQL the same code holds a pooled connection (pool max 8, `lib/db.js:134`) and
  row locks across a network round-trip, inviting pool exhaustion under a multi-draw batch.
- Consequence: lost or failed unrelated user writes on the default SQLite deployment, and
  lock/pool pressure on Postgres/MySQL, triggered by routine cron settlement.
- Fix: fetch the beacon (and decide beacon_status/final seed) BEFORE opening the transaction,
  then settle purely from DB state inside the txn.

### M-02 — High — Unknown DB_DRIVER silently falls through to SQLite (M-25 confirmed)
- File: `lib/db.js:195` (`const driver = envDriver || (process.env.DATABASE_URL ? 'postgres' : 'sqlite');`)
  followed by `if (driver === 'mysql') … if (driver === 'postgres') …` and the fallthrough
  `lib/db.js:226` (`return { driver, db: new SqliteDB(process.env.SQLITE_PATH || './data/cashpop.sqlite') };`).
- What goes wrong: any typo or unsupported value (`DB_DRIVER=postgress`, `DB_DRIVER=oracle`)
  is silently treated as SQLite — including when `DATABASE_URL` points at a real Postgres
  database, which is then ignored entirely. No warning, no throw.
- Consequence: production traffic writes wallets/deposits to a local throwaway SQLite file
  while operators believe Postgres is live; data diverges and is wiped on redeploy/restart.
- Fix: throw on an unrecognised explicit `DB_DRIVER` value instead of falling through.

### M-03 — Medium — Postgres SSL always disables certificate verification for non-localhost hosts (M-27 confirmed)
- Files: `lib/db.js:130-131`
  (`const ssl = cfg.sslMode === 'disable' ? false : (cfg.sslMode === 'require' || cfg.sslRequired) ? { rejectUnauthorized: false } : false;`)
  and `lib/db.js:210-217` (`openDB` sets `sslRequired = true` for any non-localhost `DATABASE_URL` host).
- What goes wrong: every remote Postgres connection uses `rejectUnauthorized: false`, and
  there is no `PGSSLMODE` value that restores verification — even `PGSSLMODE=verify-full`
  matches neither `disable` nor `require`, so with a non-localhost host it still lands on
  `{ rejectUnauthorized: false }`. The migration script's unconditional TLS-off (noted as
  out-of-scope in FIX-LOG) is a separate instance of the same posture.
- Consequence: a network-position attacker can MITM the app↔database connection (all wallet,
  ticket and credential data in transit) with a self-signed certificate.
- Fix: honour `PGSSLMODE=verify-full`/`verify-ca` with `rejectUnauthorized: true` (+ `ca`
  when supplied), and keep `rejectUnauthorized: false` only behind an explicit opt-in env flag.

### M-04 — Medium — Win-notification failure inside settle is swallowed with no outbox/audit trace (M-16 confirmed)
- File: `lib/draws.js:210-211` — post-commit loop
  (`if (u && u.email) await notify.send(db, settings, 'email', 'win', u.email, …)` wrapped in
  `} catch {}` with an empty body).
- What goes wrong: the money itself is already committed, but if `notify.send` throws
  (missing template, DB error, provider failure) the failure vanishes: no outbox row, no
  audit row, no log line, and the loop silently moves to the next winner. The comment above
  it correctly says notifications must happen after commit — but "after commit" is not the
  same as "recorded somewhere".
- Consequence: winners are never told they won, support has no record of the missing
  notification, and there is nothing to retry from.
- Fix: on notify failure, write a failed/outbox row (or an audit row) and log the error;
  never use a bare `catch {}` on the notification path.

### M-05 — Medium — Scratch loss-limit check still runs OUTSIDE the buy transaction (M-32, scratch variant; lottery variant is fixed)
- File: `lib/scratch.js:224-227` — `buyTicket` does
  `const s = await db.get("SELECT * FROM scratch_series WHERE id=? AND status='live' AND enabled=1", …);`
  then `await enforceResponsiblePlay(db, userId, Number(s.price));` and only then
  `return db.transaction(async (tx) => { … })`.
- What goes wrong: check and debit are not atomic for scratch (contrast lottery, where
  `enforceLotteryLossLimit(tx, …)` runs inside the buy txn). Two concurrent scratch buys
  (two tabs, double-submit despite the 10/min rate limit) can both pass the limit and both
  debit, landing above the player's own daily loss limit. The same outside-txn placement
  also means the series row is never re-checked inside the txn (see M-16, series-stop race).
- Consequence: a player's self-set daily loss limit can be exceeded by concurrent scratch
  purchases — the exact failure the lottery fix closed.
- Fix: move `enforceResponsiblePlay` (or at least its limit query) inside the buy transaction
  on the `tx` handle, mirroring the lottery buy.

### M-06 — Medium — Daily-loss window is server-local midnight, while withdrawal caps are UTC (M-35 confirmed)
- Files: `lib/scratch.js:198` and `lib/scratch.js:214`
  (`const start = new Date(); start.setHours(0, 0, 0, 0);` — local time, in both
  `enforceResponsiblePlay` and `enforceLotteryLossLimit`), vs `lib/money.js:225-226`
  (`dayStart.setUTCHours(0, 0, 0, 0); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);`).
- What goes wrong: "daily" means two different days depending on which feature enforces it,
  and the loss-limit day moves with the server's local timezone (host move, DST transition
  giving a 23/25-hour day) with no documented timezone. A player in a different timezone
  gets a window anchored to the server's midnight, not their own or UTC.
- Consequence: inconsistent, host-dependent responsible-play enforcement; a timezone change
  silently shifts every player's loss window.
- Fix: use UTC midnight everywhere (or a single documented timezone setting) for all daily/
  monthly windows.

### M-07 — Medium — Daily loss limits sum across currencies with no currency filter
- Files: `lib/scratch.js:201` (`FROM scratch_tickets WHERE user_id=? AND purchased_at>=?`,
  summing `price`/`prize` across every series currency) and `lib/scratch.js:218`
  (`FROM transactions WHERE user_id = ? AND created_at >= ?`, summing `ticket_purchase`/
  `win` across every wallet currency). Contrast `lib/money.js:219,229,234`, where turnover
  and withdrawal caps correctly filter `AND currency = ?`.
- What goes wrong: minor units of different currencies are added as if they were the same
  money (USD cents + EUR cents + any other configured currency), and the limit itself is a
  bare integer with no currency. A win in one currency offsets losses in another.
- Consequence: the daily loss limit can be bypassed (win €100, keep losing $100) or can
  false-block, depending on the mix — the limit is meaningless for multi-currency players.
- Fix: filter both queries by the purchase currency and store/compare the limit per currency
  (or convert via the settings rates before comparing).

### M-08 — Medium — Withdrawal caps, turnover and payout-lock are checked OUTSIDE the creation transaction (TOCTOU)
- Files: `lib/money.js:213` (`checkWithdrawalRules` — reads only, no transaction) and
  `lib/money.js:139` (`createWithdrawal` opens its own transaction that inserts + holds but
  never re-checks the rules); callers in `routes/player.js` check, then (after an OTP step)
  re-check, then create — every check is still outside the create txn.
- What goes wrong: two concurrent withdrawal requests (two tabs, or two OTP-verified flows)
  can both pass the daily/monthly cap and the payout-lock check, then both create holds,
  pushing the total over the cap. The OTP re-check narrows the window but does not close it,
  because the final create is a separate transaction.
- Consequence: daily/monthly withdrawal caps and the payout-detail lock can be exceeded by
  concurrent requests — caps that only hold under sequential use.
- Fix: re-run the cap/lock queries inside `createWithdrawal`'s transaction on the `tx` handle
  (with row locks on the user's withdrawal rows) and fail the create if they now fail.

### M-09 — Medium — Fee can exceed the amount, producing a negative net deposit/withdrawal
- Files: `lib/money.js:68` (`chargeFor` clamps only the charge itself: `Math.max(0, …)`),
  `lib/money.js:94` and `:148` (`net = amountMinor - charge`, with no floor at 0).
- What goes wrong: a fixed charge larger than a small amount (or percent > 100) makes `net`
  negative. On deposit approval, `decideDeposit` then posts a negative `deposit` credit —
  debiting a user with a balance for "depositing", or failing with Insufficient balance for
  a new user so the deposit can never be approved and sits pending forever. On withdrawal,
  the net paid out is negative by construction. Admin method validation (per FIX-LOG/B-176)
  checks rate/percent signs but does not cap charge against amount, and method `min_amount`
  may be below the fee.
- Consequence: real money debited on deposit approval, or deposits permanently stuck, from
  an ordinary small-amount + large-fixed-fee configuration.
- Fix: in `createDeposit`/`createWithdrawal`, reject (or cap) when `charge >= amountMinor`
  so `net` can never go negative.

### M-10 — Medium — Beacon round is not pinned: settle uses whatever drand round is latest at settle time
- Files: `lib/draws.js:122` (`const b = await fetchBeacon();` with no round argument or
  close-time check) and `lib/beacon.js` (`fetchBeacon` calls `/public/latest` only).
- What goes wrong: the winning number is derived from the latest beacon round at the moment
  settlement happens, not from a predetermined round (e.g. the first round after `close_at`).
  A privileged operator who can read the stored seed and the public beacon feed can simulate
  the outcome for the current round before triggering settlement and, by delaying settlement
  (cron pause / manual settle), wait for a round whose outcome they prefer. (This is distinct
  from B-179, which is about the BLS signature never being verified; this is about which
  round is chosen at all.)
- Consequence: the "public beacon makes the draw unpredictable" guarantee holds only against
  outsiders, not against an operator with seed access + settle timing control.
- Fix: pin the beacon round at draw creation/close (first drand round with timestamp >
  `close_at`), fetch that specific round, and reject any round earlier than the pin.

### M-11 — Medium — `session_limit_minutes` is stored and displayed but never enforced anywhere
- Files: `lib/scratch.js:33,62,91` (schema), `lib/scratch.js:157` (`responsibleStatus`
  returns it), `lib/scratch.js:193` (`enforceResponsiblePlay` checks only daily loss +
  account playable — no session-duration logic); repo-wide grep finds no other enforcement
  (no session-start timestamp exists anywhere in the audited files).
- What goes wrong: a player can set a session limit (e.g. 60 minutes) in the UI and it is
  faithfully saved, shown, and carried through pending-decrease logic — but no buy path
  ever compares play duration against it, because the system never records when a session
  started.
- Consequence: a responsible-play promise the UI makes is silently unkept; a player relying
  on a session limit can play indefinitely.
- Fix: either record session start per login/play and enforce it in `enforceResponsiblePlay`,
  or remove the session-limit control from the UI until enforcement exists.

### M-12 — Low — `settleDueDraws` has NO ORDER BY; referral release orders by `created_at` with no id tiebreaker (P-14 confirmed)
- Files: `lib/draws.js:77`
  (`SELECT * FROM draws WHERE status = 'scheduled' AND close_at <= ?` — no `ORDER BY`,
  no `LIMIT`) and `lib/money.js:336`
  (`SELECT * FROM referral_credits WHERE referee_id = ? AND status = 'pending' ORDER BY created_at`).
- What goes wrong: batch settle order is whatever the driver returns (arbitrary on Postgres),
  so a newer due draw can settle before an older one and operators cannot reason about
  settle order. For referrals, rows sharing the same millisecond `created_at` (common: `now()`
  ms resolution, bulk buys) order nondeterministically, so which rows hit the per-referee cap
  vs get marked `capped` can vary run to run when amounts differ.
- Consequence: nondeterministic settlement order and nondeterministic cap-boundary outcomes;
  no money is double-paid (guards hold), but ordering/auditability is unrepeatable.
- Fix: `ORDER BY close_at ASC, id ASC` on the due-draws query and `ORDER BY created_at, id`
  on the referral query.

### M-13 — Low — Settlement audit row is not part of the settlement transaction on Postgres/MySQL, and audit failures are swallowed
- Files: `lib/draws.js:198` (`await audit.log(db, { … action: 'draw.settle' … })` — passes the
  outer `db`, not the `tx` handle, from inside the `db.transaction` callback at `:94`);
  `lib/audit.js` `log()` catches insert errors with only `console.error` and still resolves.
- What goes wrong: on Postgres/MySQL the audit insert runs on a separate pooled connection
  and auto-commits independently of the settle transaction — a settle that later rolls back
  (commit failure) leaves a false "draw settled" audit row, and an audit insert that fails
  leaves a real settlement with no audit row at all, silently. (On SQLite the same code
  happens to be atomic because the shared connection joins the open transaction — a driver
  difference, not a design.)
- Consequence: the audit trail that FIX-LOG cites as proof of settlement can both over- and
  under-report settlements on Postgres/MySQL.
- Fix: pass the `tx` handle into the settle audit insert (or log after commit with a
  durable outbox + retry), and surface audit-write failures instead of swallowing them.

### M-14 — Low — `postLedger` balance_after can be wrong under concurrency; first-post wallet creation races on its PK
- Files: `lib/money.js:22-34` (`postLedger`: guarded `UPDATE wallets SET balance = balance + ? …`,
  then a separate `SELECT balance`, then `INSERT INTO transactions (… balance_after …)`);
  `lib/money.js:8-11` (`getWallet` does SELECT-then-INSERT with no `ON CONFLICT` handling).
- What goes wrong: between the guarded UPDATE and the balance SELECT, a concurrent post on
  Postgres/MySQL can move the balance, so the recorded `balance_after` does not equal
  prior balance + this amount — the wallet balance itself stays correct, but the ledger's
  audit column is wrong for that row. Separately, two concurrent first posts for a new
  (user, currency) both see no wallet row and both INSERT, and the second hits the
  `PRIMARY KEY (user_id, currency)` (migrations DDL) and fails the whole post spuriously.
- Consequence: inaccurate per-transaction statements for concurrent users, and spurious
  post failures for brand-new wallets under concurrency.
- Fix: return the new balance from the UPDATE itself (`RETURNING balance` on Postgres, or
  a locked row re-read inside the same txn) and use `INSERT … ON CONFLICT DO NOTHING` /
  driver-conditional upsert in `getWallet`.

### M-15 — Low — `createDeposit`/`createWithdrawal` have no engine-level amount validation
- Files: `lib/money.js:86` (`createDeposit`) and `lib/money.js:139` (`createWithdrawal`) —
  neither checks `amountMinor` for finite / integer / > 0; `lib/money.js:23` (`postLedger`)
  silently `Math.round`s fractional minor units.
- What goes wrong: today the player routes validate (`amount === null || amount <= 0`
  rejected), so this is not reachable from the player UI — but the engine functions are
  exported and any future/admin/webhook caller that skips validation gets dangerous
  behaviour for free: a negative withdrawal amount makes `postLedger` post
  `-amountMinor`, i.e. a credit (free money), and a fractional amount is silently rounded.
- Consequence: defence-in-depth gap; a single missed validation in a new caller becomes a
  money-creation bug instead of a clean rejection.
- Fix: throw in `createDeposit`/`createWithdrawal` unless `Number.isSafeInteger(amountMinor)
  && amountMinor > 0`, and reject (don't round) non-integer amounts in `postLedger`.

### M-16 — Low — Scratch buy never re-checks series status inside the transaction (stop race)
- File: `lib/scratch.js:224` (`const s = await db.get("SELECT * FROM scratch_series WHERE id=?
  AND status='live' AND enabled=1", [seriesId]);`) — the only status check — followed by
  `lib/scratch.js:227-228`, where the transaction selects an outcome but never re-reads the
  series row.
- What goes wrong: an admin stopping/disabling a series between the check and the transaction
  does not stop the sale; the buy inside the txn succeeds against a stopped series. (Contrast
  the lottery buy, which re-checks draw status inside the txn.)
- Consequence: sales continue briefly after an operator stop — wrong during a fraud/incident
  stop, when the stop is meant to be immediate.
- Fix: re-select the series with `status='live' AND enabled=1` inside the buy transaction
  and throw if it no longer matches.

### M-17 — Low — `convertMinor` is dead code and fails open on missing/zero rates (M-42 confirmed)
- Files: `lib/util.js:61-66` (`function convertMinor(minor, fromCode, toCode, currencies) { …
  if (!f || !t || !f.rate || !t.rate) return Number(minor); return Math.round(Number(minor) * (t.rate / f.rate)); }`);
  Repo-wide grep finds zero callers (only the definition and the export at `lib/util.js:107`).
- What goes wrong: the only conversion helper in the engine is never called (consistent with
  the §2 note that lottery buys debit only the base-currency wallet), and if it ever is wired
  up, an unknown currency or a zero/missing rate silently returns the input unchanged — a
  1:1 conversion that is wrong for every non-par currency. It also passes `NaN` through
  (`Number(NaN)`) instead of failing.
- Consequence: today, dead code only; the day it is used, mis-converted amounts with no error.
- Fix: delete it until a real multi-currency conversion path exists, or make it throw on
  unknown/zero rate and non-finite input.

### M-18 — Medium — No draw-cancel / refund path exists anywhere (M-43 confirmed)
- Files: absence verified — repo-wide grep for draw cancel/refund in `lib/` and `routes/`
  returns nothing; `lib/draws.js` exports only `ensureUpcomingDraws, createTestDraw,
  settleDueDraws, settleDraw, publicDrawInfo, fairnessForDraw, drawDateStr`.
- What goes wrong: a scheduled draw that can never settle (poisoned ticket HMAC, missing
  prize row, permanently unavailable beacon with `beacon_required=1`) has no operator remedy:
  its entries stay `pending` forever, tickets stay `active`, and the staked money has no
  refund route except manual database edits. There is also no cancelled-draw status in the
  draws DDL.
- Consequence: player funds locked indefinitely on any un-settleable draw, with no audited
  operator path to return them.
- Fix: add a guarded `cancelDraw` (scheduled → cancelled, refund each pending entry's wager
  via `postLedger`, audit-logged, changes-checked) and a `cancelled` draw status.

### M-19 — Low — Test-draw override is silently clamped, and garbage input becomes NaN
- File: `lib/draws.js:63` (`winning = Math.max(1, Math.min(15, parseInt(overrideNumber, 10)));`).
- What goes wrong: `parseInt('abc', 10)` is `NaN`, and `Math.max(1, Math.min(15, NaN))` is
  `NaN` — the subsequent `UPDATE draws SET winning_number = ?` stores a non-number (or
  fails, driver-dependent), and at settle time the falsy `winning` falls through to the
  random path, so the "fixed" test draw is silently not fixed. Meanwhile `0` → `1` and
  `99` → `15` are silently clamped instead of rejected.
- Consequence: misleading test draws (operator believes a number is fixed when it is random)
  and driver-dependent storage of NaN.
- Fix: validate the override as an integer 1..15 and throw on anything else.

### M-20 — Low — `ensureUpcomingDraws` silently coerces bad settings and aborts its loop on a duplicate-draw race
- Files: `lib/draws.js:33-46` — `days` via `parseInt(…) || 7` (so `0` silently becomes 7 and
  the feature cannot be disabled), `closeAtFor` mapping `NaN` hours/minutes to `0` via
  `hh || 0, mm || 0` (so an invalid `day_draw_time` silently becomes midnight), and the
  check-then-INSERT with no error handling around the `UNIQUE (draw_type, draw_date)` insert.
- What goes wrong: two concurrent ensures (boot + cron tick) can both pass the existence
  check; the loser hits the UNIQUE violation, throws out of `ensureUpcomingDraws`, and the
  remaining days/types are never created that tick (they recover on a later tick, but the
  failure is unlogged and the loop is abandoned mid-way).
- Consequence: misconfigured draw times silently produce midnight draws; concurrent ensures
  intermittently skip creating upcoming draws.
- Fix: validate `upcoming_draw_days`/`day_draw_time`/`eve_draw_time` at read time (throw on
  garbage, allow 0 to mean disabled) and catch UNIQUE violations per draw and continue.

### M-21 — Low — `launchSeries` accepts negative prize tiers and unbounded inventory with no engine check
- File: `lib/scratch.js:130-137` (`launchSeries` builds `prizes` with
  `for (const tier of tiers) for (let i = 0; i < tier.quantity; i += 1) prizes.push(Number(tier.amount));`,
  checking only `prizes.length > s.total_tickets`).
- What goes wrong: a negative `amount` becomes a negative-prize outcome (clamped to 0 only
  later, at reveal in `revealTicket`), so the series' prize pool and RTP accounting are
  silently distorted; a negative `quantity` is silently ignored; and a huge `total_tickets`
  (e.g. 1,000,000) inserts that many outcome rows in a single transaction with no cap.
- Consequence: admin-only input can still corrupt series economics and stall launch with a
  giant single transaction.
- Fix: reject tiers with `amount < 0` or `quantity < 0` and cap `total_tickets` at a sane
  maximum in `launchSeries`.

### M-22 — Low — `responsibleStatus` swallows pending-limit errors and proceeds with stale limits
- File: `lib/scratch.js:159-178` — the whole pending-row read/apply/delete block sits inside
  `try { … } catch {}` with an empty catch.
- What goes wrong: if the pending SELECT, the main-row UPDATE, or the pending DELETE throws
  (DB error, locked row), the function silently returns the pre-pending limits and every
  enforcement caller proceeds as if nothing happened. The failure is invisible (no log) and
  fail-open in the direction of the older, usually higher, limit.
- Consequence: a transient DB error can silently suspend a player's pending limit decrease.
- Fix: log and rethrow pending-apply errors (or at least log them), never swallow them in a
  responsible-play enforcement path.

### M-23 — Medium — `toMinor` treats a European decimal comma as a thousands separator (100× misparse)
- File: `lib/util.js:30-33` (`const s = String(amountStr).trim().replace(/,/g, '');` then
  `parseInt(w, 10) * 100 + …`).
- What goes wrong: the comma strip is US-style only. A user typing `12,50` meaning €12.50
  becomes `1250`, i.e. 125000 minor = $1,250.00 — a 100× overstatement. (US input `1,000.50`
  still parses correctly, so this is a locale trap, not a total failure.) Player deposit/
  withdrawal routes feed user-typed amounts straight into `toMinor`; the deposit manual-
  approval gate limits the damage there, but a withdrawal hold for 100× the intended amount
  locks real balance until rejected.
- Consequence: locale-format amounts are misread by two orders of magnitude.
- Fix: reject input containing a comma that is not a valid thousands grouping (or accept an
  explicit decimal-comma form and reject ambiguous mixes), never blindly strip commas.

### M-24 — Low — All money math assumes 100 minor units per major unit, for every currency
- Files: `lib/util.js:30` (`toMinor` multiplies by 100), `lib/util.js:51` (`fromMinor`
  divides by 100), `lib/util.js:54` (`fmtMoney` divides by 100). The currency schema
  (`settings` currencies list: `{code, symbol, rate}`) carries no minor-units/decimals field.
- What goes wrong: zero-decimal currencies (JPY, KRW, VND, …) have no representation in the
  engine. If an admin adds one, every amount is parsed, stored and displayed 100× off
  (¥1000 entered as ¥10.00, or stored as 100000 minor). Today the default list is USD-only,
  so this bites only when a zero-decimal currency is configured — but the engine gives no
  warning when that happens.
- Consequence: 100× display/storage errors for any zero-decimal currency added later.
- Fix: add a `decimals` (minor units) field per currency and thread it through
  `toMinor`/`fromMinor`/`fmtMoney`.

### M-25 — Low — Webhook verification falls back to non-signing secrets and silently HMACs an empty body
- Files: `lib/rails.js:131-137` (`verifyWebhookSignature`: secrets picked as
  `m.webhook_secret || m.api_token || m.secret_key`, and
  `const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : '');`).
- What goes wrong: when a method has no `webhook_secret` but does have an `api_token` or
  `secret_key`, the verifier HMACs with a bearer/API credential that is not the provider's
  webhook signing secret — legitimate webhooks then fail closed (availability trap), and
  the misconfiguration is invisible (a generic "signature mismatch"). Separately, if the
  body was already JSON-parsed upstream (not a Buffer/string), `raw` silently becomes
  empty and the HMAC is computed over `''` instead of raising "raw body unavailable".
- Consequence: fail-closed webhook outages that look like provider signature failures, and
  a masked body-parser misconfiguration. (This is fail-closed, not a bypass — no forged
  webhook passes because of it.)
- Fix: only accept `webhook_secret` as a signing secret (reject methods without one with a
  distinct reason), and throw/return a distinct error when the raw body is unavailable.

### M-26 — Low — DB adapter inconsistencies: MySQL pool has no timeouts; SQLite path is CWD-relative; MySQL port is unparsed
- Files: `lib/db.js:49` (MySQL pool: `waitForConnections: true, connectionLimit: 8,
  multipleStatements: false` — no `connectTimeout`/`acquireTimeout`/`queueLimit`, vs the
  Postgres pool at `lib/db.js:134` with `connectionTimeoutMillis: 5000`);
  `lib/db.js:226` (SQLite default `'./data/cashpop.sqlite'`, relative to process CWD, not
  the app directory); `lib/db.js:201` (`port: process.env.MYSQL_PORT` passed as a string,
  while `PGPORT` is `parseInt`ed).
- What goes wrong: under MySQL pool exhaustion, requests queue forever instead of failing
  fast; launching the server from a different working directory silently creates a second,
  empty SQLite database (data appears "lost"); and the MySQL port relies on driver coercion.
- Consequence: hangs under load, and a CWD-dependent split-brain SQLite file.
- Fix: set MySQL `connectTimeout`/`acquireTimeout`, resolve the SQLite path against the app
  root, and `parseInt` the MySQL port.

### M-27 — Low — Commission settlement reuses one ledger `refId` across currencies and same-millisecond settles
- File: `lib/money.js:307` (`refId: 'COM' + now()` inside the per-currency loop of
  `settleAgentCommissions`).
- What goes wrong: every currency credit in one settlement — and any second settlement in
  the same millisecond — shares the same `refType`/`refId` pair. There is no uniqueness
  constraint on ledger refs, so nothing breaks mechanically, but the ref no longer identifies
  a single credit in statements, reconciliation or support investigation.
- Consequence: ambiguous ledger references for multi-currency commission settlements.
- Fix: include currency (and a per-credit sequence/random suffix) in the refId.

### M-28 — Low — Referral release checks deposit/wagering without a currency filter, while credits carry a currency
- Files: `lib/money.js:323` (`SELECT COUNT(*) … FROM deposits WHERE user_id = ? AND status = 'approved'`,
  no currency) and `lib/money.js:325` (wagering SUM over `transactions`, no currency),
  vs the credit row's own `currency` used at `postLedger` time.
- What goes wrong: a referee who deposits and wagers only in USD unlocks pending referral
  credits denominated in EUR or any other currency. The per-referee cap is likewise summed
  per row currency at release time but gated by a currency-blind activity check.
- Consequence: cross-currency referral payouts that the activity requirement was meant to gate.
- Fix: check deposit + wagering per credit currency (or require activity in the credit's
  currency) before releasing each row.

## Checked and clear (verified NOT bugs — do not re-report)

- Round-1 fixes, re-read and confirmed present: `lockSuffix` driver-conditional locking
  (`lib/money.js:296,328` — both current callers pass the outer `db`, whose `driver` is set,
  so the suffix is correct; note only as latent hazard: `lockSuffix(tx)` would be wrong
  because tx handles carry no `driver`, but no caller does that today); settle entry/draw
  guards + changes checks; referral claim-first + cap; `settleDueDraws` per-draw try/catch.
- `decideDeposit`/`decideWithdrawal` guarded transitions (`WHERE status = …` + changes
  check) — concurrent double-decide now fails cleanly instead of double-crediting.
- Withdrawal hold accounting, re-traced end to end: create holds the full amount; approve
  posts nothing back (fee retained, not refunded); reject returns the full amount; revoke
  after approve returns net only. Arithmetic is correct.
- Scratch buy outcome claim (`lib/scratch.js` guarded `UPDATE … WHERE ticket_id IS NULL`
  + changes check) and reveal (`lib/scratch.js` commitment verification against the
  ticket-stored commitment + guarded `purchased → revealed` update + changes check) —
  concurrent double-sell / double-credit are blocked.
- `launchSeries` concurrent-launch safety: the second concurrent launch hits
  `UNIQUE(series_id, ordinal)` and rolls back (error, not silent double inventory).
- Draws `UNIQUE (draw_type, draw_date)` and wallets `PRIMARY KEY (user_id, currency)` in
  migrations DDL — duplicates are structurally blocked (the failure modes this creates
  under races are counted separately as M-14/M-20, not as missing constraints).
- `checkWithdrawalRules` currency filtering (turnover, daily/monthly caps) is correct —
  the cross-currency defect is specific to the loss-limit queries (M-07).
- Lottery buy re-checks draw status inside the transaction and enforces the lottery loss
  limit inside the transaction (round-1 fix, confirmed in the buy flow).
- Prize-table multipliers are clamped 1..15 in the admin settings route, so a negative/
  absurd multiplier cannot reach settle via the UI (only direct DB edits could).
- `convertMinor`'s formula itself (`minor * t.rate / f.rate`) is correct given the settings
  rates — only its dead/fail-open status is counted (M-17).
- `settleAgentCommissions` guarded final UPDATE (`changes === rows.length`, else rollback)
  and `releaseReferralCredits` per-row claim-before-credit are sound.
- Ticket HMAC fallback secret in `lib/draws.js`/`routes/player.js`: production boot refuses
  to start without a real `TICKET_HMAC_SECRET` (server boot guard) — this is the P-26 family
  and is not double-counted here; the non-production fallback remains P-26's scope.
- Beacon BLS signature never verified: B-179 in the 235 report — excluded, not counted here
  (M-10 counts only the distinct round-pinning defect).

## Needs-check (NOT counted)

- NC-1 (from §4, M-29): Postgres config precedence when both `DATABASE_URL` and individual
  `PGHOST`/`PGUSER`/… are set — node-pg's merge behaviour was not verified against a live
  Postgres instance in this audit (no `PG_TEST_URL` available).
- NC-2: Nested `db.transaction` semantics differ by driver (Postgres/MySQL get a fresh pooled
  connection, so an inner transaction commits independently of an outer rollback; SQLite
  throws "cannot start a transaction within a transaction"). No nested caller was found in
  the audited files, so this is a latent API hazard, not a counted bug.
- NC-3: SQLite `busy_timeout` — no `busy_timeout` pragma is set (`lib/db.js:18` sets only
  WAL + foreign_keys). The cron is in-process and `DatabaseSync` calls are synchronous, so
  single-process contention is serialised; whether a multi-process deployment contends on
  the SQLite file was not verified.
- NC-4: `responsibleStatus` pending-apply path when no main `responsible_play` row exists
  (UPDATE skipped, no INSERT, pending row deleted — `lib/scratch.js:169-171`). The current
  POST handler always inserts the main row before writing a pending row, so this path looks
  unreachable via normal flows; it is a defensive gap only, not counted.
- NC-5: Webhook provider-specific signature formats (per-rail HMAC variants, base64 vs hex)
  — the generic HMAC verifier in `lib/rails.js` may reject providers whose format differs;
  provider-by-provider verification was not performed (W-area overlap, D NC-1 family).
- NC-6: `getRail` is case-sensitive while `isBlockedRail` lowercases its input
  (`lib/rails.js`). Admin display code falls back to the raw rail string when `getRail`
  returns undefined, so no bypass was confirmed in the audited files; caller-by-caller
  impact was not fully traced.
- NC-7: `fetchBeacon`'s 4 s timeout vs slow networks, and `deriveWinningNumber`'s legacy
  `% 15` modulo bias (~1.2e-9, documented in `lib/beacon.js` as legacy-only) — neither was
  treated as a finding; the legacy function is used only for pre-v14 fairness reproduction.
