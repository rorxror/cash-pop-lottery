# Verify-3 — Independent fix verification (games + support + comms)

Agent: independent FIX-VERIFICATION (no code edited in `~/workspace/cash-pop-fix/`).
App booted from scratch by this agent: `SQLITE_PATH=/tmp/verify3.sqlite PORT=3343
BASE_URL=http://localhost:3343 TICKET_HMAC_SECRET=verify-three-hmac-secret-0123456
ADMIN_SEED_EMAIL=admin@cashpop.live ADMIN_SEED_PASSWORD='E2eAdmin!2345' node server.js`.
Admin panel `/ops-7f3a9c-console`. Setup shortcuts via DB as authorised:
`beacon_enabled=0`, payment method id 10 (Bank Transfer) enabled,
`referral_enabled=1`, `email_verified=1` per test player, wallets funded directly,
agent assignment via `users.agent_id`. All HTTP flows used real cookie jars +
CSRF scraped from GET forms (`name="_csrf"`). Server killed after testing.

## Verdicts

| Item | Verdict | Evidence |
|---|---|---|
| DS-001 player support reply 404 | **VERIFIED** | Player reply POST `/support/SMVRSY44MF99B4B/reply` → **302** (not 404) to `/support/<id>`; DB `support_messages` then contains `('player','player reply DS001 persists')` as 3rd message. |
| DS-002 BOTH cancel refunds 2× | **VERIFIED** | BOTH ticket, 2 pops × $1 wager, `num_draws=1`: total **400** (DB), entries DAY+EVE pending, balance 20000→19600. Admin cancels DAY draw only (single POST → 302): refund transaction `draw_refund` **exactly 200** (= 400 / 2 entries), balance 19800; DAY entry `refunded`, EVE entry still `pending`, ticket status still `active`. |
| DS-009 reply form on answered ticket | **VERIFIED** | After admin reply ticket status = `answered`; player GET `/support/<id>` = 200, contains `action="/support/<id>/reply"` form + "Send Reply", and does **not** contain a false "ticket is closed" message. Code: `views/support_view.ejs` renders the form when `ticket.status !== 'closed'`. |
| DS-010 agent support | **VERIFIED** | Player assigned to Agent Alpha: Alpha GET `/agent/support` 200 lists the ticket, detail 200, reply POST → 302, DB message `author_role='agent'`. Agent Beta: detail GET → **404**, list 200 does **not** contain the ticket. Scoping is the `users.agent_id` join in `routes/agent.js`. |
| DS-020 settled ticket badge | **VERIFIED** | Deterministic losing ticket (pop 5 vs predicted/actual winning 11, beacon off): entry `lost`, ticket `settled`. `/tickets` and `/ticket/<id>` render a real badge `<span class="badge b-muted">LOST</span>`; no escaped `&lt;span class="badge` text in the page. Code uses `<%-` (unescaped) for the WON/LOST badge in `views/tickets.ejs` / `views/ticket.ejs`, branched on `ticket.status==='settled'` + won entries. |
| DS-021 fairness states | **VERIFIED** | Settled real draw #3: `/fairness?draw_id=3` shows MATCH ×2, no MISMATCH (winning 11, `beacon_status='disabled'`). TEST draw #15 (override 7, settled): fairness shows "TEST draw — operator-set number", **no false MISMATCH**. Unknown id: `/fairness?draw_id=999999` → 200 with "Draw not found" card (`result={notFound:true}` branch in `routes/site.js` + `views/verify.ejs`). |
| DS-022 play currency not hardcoded USD | **VERIFIED** | EUR-funded player, GET `/play?currency=EUR`: `data-cur="EUR"`, wager circles `€1.00/€2.00/€5.00/€10.00`, prize header "Win per €1.00 wager", slip/balance `€99.00`. Buy with `currency=EUR` → EUR wallet −100, USD wallet Δ0, ticket row `currency='EUR', total=100`. The only `$` strings on the page are the player's (empty) USD wallet in the header currency picker and a literal "$" step icon — not play pricing. Code: `routes/player.js` GET /play selects `playCurrency` from funded wallets/`?currency=`; `views/play.ejs` formats everything with `fmt(…, playCurrency)`. |
| DS-023 bundle discount | **VERIFIED** | Rendered /play carries `data-discounts="5:12,8:14,12:20"` and the banner "5 draws → 12% off". Buy `num_draws=5`, 1 pop × $1 DAY: charged **440** not 500 (balance Δ −440, ticket `total=440`, ledger meta `bundle_discount:12`). Slip discount line is JS-computed in `public/app.js` recalc(): total `Math.round(total*(100-discPct)/100)` keyed on selected draws, and `slDraws` text appends "− 12% bundle discount applied" — same keying as the server (`routes/player.js`: bundle found by `numDraws`, not entry count, so BOTH is no longer silently excluded). |
| DS-024 per-draw stake cap | **VERIFIED** (live + code) | Code (`routes/player.js` buy txn): `candShare = total / drawIds.length`; existing stake per draw = `SUM(t.total / (entry count of t))` per draw; refuses when `staked + candShare > stakeCap`. Old math summed each overlapping ticket's **full** total once per draw, so a $4.40 five-draw ticket counted $4.40 against a single draw's cap. Live (cap inserted = 250, after waiting out the 5 s settings cache): five-draw $4.40 ticket (share $0.88/draw) buy1 → 302, buy2 → 302 (cumulative $1.76/draw), buy3 → **400** (cumulative $2.64 > $2.50), balance unchanged. Under the old math buy1 alone ($4.40 > $2.50) would have been refused. Note: my first attempt appeared to let buy3 through because the setting was changed by direct DB write inside the app's 5 s settings-cache TTL; retested clean above — a test artefact, not a code defect (admin-UI writes invalidate the cache via `setSetting`). |
| DS-025 ticket creation audit | **VERIFIED** | Creating a ticket wrote `audit_log` row `action='support.create', actor_role='player', entity='support_ticket'` (plus the optional `support_notify_email` send path in `routes/player.js` POST /support/new). |
| DS-026 reply audit + real staff role | **VERIFIED** | Super-admin reply stored `author_role='admin'`; a staff user promoted to `admin_role='support'` replied and the message was stored `author_role='support'` (not hardcoded 'admin') — code: `staffRole = normalizeRole(req.user)==='super' ? 'admin' : normalizeRole(req.user)` in `routes/admin.js`. Agent reply stored `'agent'`. Player reply wrote `audit_log` `support.reply` with `actor_role='player'`; admin/agent replies also audit `support.reply`. |
| DS-027 dead templates wired | **VERIFIED** | Code: `lib/otp.js` `sendOtp` phone branch loads `notify.getTemplate(db,'sms','otp')` and `renderVars(tpl.body,{code,minutes:10})` when enabled (hardcoded text only as fallback). Live draw-settle win ($13.00): `notifications_log` gained all three win attempts — email `win` ("You won $13.00!"), **sms `win`** ("Congrats Fair Winner! You won $13.00 on Cash Pop Lottery." — the seeded sms/win template), **push `win`** ("Ticket … just won $13.00.") — all logged `failed` (no provider configured), i.e. attempted and honestly logged, not silently dropped. Scratch-reveal win path attempts the same three channels in `routes/scratch.js` (my one scratch reveal was a $0 prize, so no rows — expected). Remaining spare per FIX-LOG: email/otp signup template has no send path by design (signup codes are operator-issued). |
| DS-028 announcements | **VERIFIED** | Admin POST `/ops-7f3a9c-console/notifications/announcements` (title/body/is_active) → DB row `active=1`; player GET `/announcements` 200 shows "Verify Announcement DS028". |
| DS-029 contact flow | **VERIFIED** | Public POST `/contact` → 302, DB `contact_messages` row (handled=0); admin GET `/contact-messages` lists it; admin POST `/contact-messages/<id>/handled` → 302 and DB `handled=1`. |
| DS-052 scratch referral credit | **VERIFIED** | Referee (referred_by set) bought Gold Rush scratch ($1): `referral_credits` gained `(referrer=12, referee=13, amount=5, status='pending', USD)` = 5% of 100. Referrer GET `/profile` shows "Your referral earnings — USD: pending $0.05 · released $0.00". |
| DS-053 combined daily loss limit | **VERIFIED** | Player with `daily_loss_limit=300` ($3): lottery buy $2 → 302 (net 200); scratch buy $1 → 302 (combined 300, at limit, allowed); next scratch $1 → **400**, balance and scratch-ticket count unchanged; next lottery $1 → **400**, balance unchanged. Combined enforcement in `lib/scratch.js` `combinedDailyNetLoss` (lottery transactions + scratch_tickets, per currency, UTC day), used by both enforcers. |
| DS-056 phantom draws after close | **CODE-ONLY** | `lib/draws.js` `ensureUpcomingDraws`: computes `closeAt = closeAtForTz(ds, timeStr, tz)` and `if (closeAt <= t) continue;` before inserting — a draw whose close time has already passed is never created, so it cannot instantly settle empty as a phantom result. Not exercised live (would require manipulating the scheduler's "today"). |
| DS-057 cancelled/unknown fairness | **VERIFIED** | Live: cancelled draw #1 fairness page shows "Cancelled" / "Cancelled — stakes refunded", and does **not** say "Not settled yet". Unknown draw id shows the not-found card (see DS-021). Code: `fairnessForDraw` returns `state: d.status` for non-settled draws; `views/verify.ejs` branches on `state==='cancelled'`. |
| DS-058 /tickets pagination | **VERIFIED** | Seeded 26 tickets (DB) for one player: GET `/tickets` → "Page 1 of 2" with 25 tickets; GET `/tickets?page=2` → "Page 2 of 2" with the 1 remaining ticket. Code: `routes/player.js` GET /tickets paginates 25/page (was LIMIT 100); `/scratch/my-tickets` paginates the same way in `routes/scratch.js`. Seeding was via DB inserts, not buys (buy rate limit is 10/min/user). |
| DS-061 player close/reopen own ticket | **VERIFIED** | Player POST `/support/<id>/close` → 302, DB status `closed`; POST `/support/<id>/reopen` → 302, DB status `open`. |
| DS-073 scratch lobby empty state | **VERIFIED** | With the only live series temporarily set draft/disabled: GET `/scratch` 200 shows "No scratch cards are on sale right now. Please check back soon." and no "operator has not launched…" wording (`views/scratch_lobby.ejs`). Series restored live/enabled afterwards (lobby shows Gold Rush again). |
| DS-075 TEST draws excluded from /results | **VERIFIED** | After settling both real draw #3 and TEST draw #15: GET `/results` contains the real draw's date (2026-10-29) and **no "TEST" label anywhere**. Code: `routes/site.js` /results and homepage recent-results both filter `is_test = 0`; the results type filter no longer offers TEST. |
| DS-076 scratch reveal generic error | **VERIFIED** | Live: bought a scratch ticket, corrupted its `outcome_commitment` in DB, POST reveal → **400** with generic "This ticket could not be revealed. Please contact support."; the raw "Outcome commitment mismatch" text does **not** appear; ticket stays `purchased` (no prize credited). Code: `routes/scratch.js` reveal catch logs the real error server-side and maps it to the generic message (only "not found" is distinguished). |

## Directive spot-checks

- **(a) NO-CONFIRM — VERIFIED for the specified pages.** Admin draws page HTML
  (`GET /ops-7f3a9c-console/draws`) contains **no** `data-confirm` attributes;
  deposit detail page HTML (`GET /ops-7f3a9c-console/deposits/1`) contains **no**
  `data-confirm` attributes and shows the direct Approve/Reject forms. Draw
  settle and draw cancel each completed in a **single POST → 302** with the
  effect already in the DB (settled draw #3 with winning number; DAY draw
  cancelled with the $2.00 refund posted) — no second confirmation request.
  Observation (outside the two specified pages, flagged for completeness):
  `data-confirm` still exists in `public/app.js`'s generic handler and on a few
  non-specified surfaces — agent transfer button, player security page (2FA
  disable / backup-code regenerate), and scratch-admin Launch/Stop buttons in
  `routes/scratch.js`. Those were not part of this spot-check's pass/fail scope.
- **(b) EVERYTHING-REAL — VERIFIED.** At check time: `/api/stats` returned
  `players=11, tickets_today=32, paid_out=1300 ('$13.00')`; sqlite counts were
  identically `players=11` (role='player'), `tickets created in last 24h=32`,
  `SUM(win transactions, USD)=1300`. Homepage hero `data-count` attributes were
  exactly `11 / 32 / 1300`. The winners ticker contained only the single real
  win row in `transactions` (Fair Winner, $13.00, type='win') — the template
  repeats that same real row twice for the marquee loop (`recentWins.concat(recentWins)`);
  no invented names/amounts anywhere.

## Competing solutions (required)

**DS-002.** Alternatives: (i) refund `ticket.total / num_draws` — the old code;
`num_draws` is the per-type count, so a BOTH ticket (2× entries) refunds double
per draw; (ii) refund `wager × pops` — the per-pop stake, which ignores bundle
discounts actually paid (a discounted 5-draw ticket's real per-draw share is
below `wager × pops`, so this over-refunds discounted tickets and under-refunds
nothing else by luck); (iii) the implemented `total / actual entry count` with
cumulative rounding (`round(total·k/n) − round(total·(k−1)/n)`), which also
guarantees cancelling every draw returns exactly `total`. The entry-count
approach wins on the observed evidence: on a $4.00 BOTH ticket, cancelling one
draw refunded exactly $2.00 and left the other entry pending — approach (i)
would have created $2.00 out of thin air in that single cancel.

**DS-053.** Alternatives: (i) per-game limits (the old code — lottery enforcer
summed only lottery rows, scratch enforcer only scratch rows), which lets a
player lose 2× the stated limit by splitting games; (ii) a transactions-only
combined sum, which mis-counts scratch because scratch spend/prizes live
authoritatively in `scratch_tickets` (prize is NULL until reveal) and scratch
prizes credit under a different ledger type than lottery `win`; (iii) the
implemented `combinedDailyNetLoss`, summing lottery net from `transactions`
plus scratch net from `scratch_tickets` per currency/UTC day, called by both
enforcers. (iii) wins on the observed evidence: $2 lottery + $1 scratch hit a
$3 limit exactly, and the crossing $1 purchase was then blocked in **both**
games (400, no debit) — under (i) the scratch purchase would still have had
$2 of scratch-only headroom and gone through.

## Tally

- **VERIFIED: 22** — DS-001, DS-002, DS-009, DS-010, DS-020, DS-021, DS-022,
  DS-023, DS-024, DS-025, DS-026, DS-027, DS-028, DS-029, DS-052, DS-053,
  DS-057, DS-058, DS-061, DS-073, DS-075, DS-076.
- **CODE-ONLY: 1** — DS-056.
- **FAILED: 0.**
- Spot-checks: (a) NO-CONFIRM **VERIFIED** (with the out-of-scope
  `data-confirm` observation above); (b) EVERYTHING-REAL **VERIFIED**.

Total: 23 assigned DS items — 22 VERIFIED, 1 CODE-ONLY, 0 FAILED.
