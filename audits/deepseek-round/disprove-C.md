# DISPROVE Pass — Area C (Games) — adversarial audit

Agent role: DISPROVE. Every item below was attacked against the **pre-fix baseline**
at `~/workspace/cash-pop-push/` (production v17.1 code, read-only): looking for a
guard, a correct second code path, or a conversion/mapping layer that would make
the finding a false alarm. Verdicts are by content trace, plus a live repro run
on the baseline itself (port 3353, throwaway DB `/tmp/disprove-c.sqlite`,
seeded admin `admin@cashpop.live`; server killed afterwards).

**Assigned set (per task):** DS-002, DS-020, DS-021, DS-022, DS-023, DS-024,
DS-042, DS-056, DS-057, DS-058, DS-059, DS-073, DS-075, DS-076.
Note on sourcing: in COMPILED.md, DS-002/020/021/022/023/024/056/057/058/059 are
sourced to audit-C (C-01…C-10); DS-042/073/075/076 are sourced there to audit-F
(F-10/F-13/F-15/F-16) but are games-surface items assigned to this area by the
task. All 14 were audited here.

**Tally: SURVIVES 14 · DISPROVEN 0.**

---

## DS-002 (C-01) — BOTH-ticket draw-cancel refunds 2× purchase — **SURVIVES**

Disprove attempt: traced `cancelDraw`'s refund basis line by line, hunting for an
entry-count correction (e.g. use of `draw_ids.length`, entries count, or a cap at
`ticket.total`) anywhere in `lib/draws.js`, `routes/admin.js`, or `postLedger`.

Why it fails — the basis really is the per-type count, not the entry count:

- Buy: `routes/player.js:63-74` — for `draw_type=BOTH`, `types=['DAY','EVE']` and
  each type pushes `numDraws` ids, so `drawIds.length = 2 × numDraws`;
  `total = pops.length * wager * drawIds.length` (full, correct price).
- Buy insert: `routes/player.js:121-123` stores `num_draws = numDraws` (the
  per-type count, e.g. 1) — **not** `drawIds.length`.
- Cancel: `lib/draws.js:139-145` — `nDraws = Number(e.num_draws)`, and the
  cumulative-rounding refund is `round(total*k/nDraws) − round(total*(k−1)/nDraws)`
  with `k` = already-refunded entries + 1 (`lib/draws.js:142`). With `total=200,
  nDraws=1`: entry 1 refunds `round(200·1/1)=200`; entry 2 (k=2) refunds
  `round(200·2/1) − round(200·1/1) = 200`. Cumulative refunds reach **400 on a
  200 ticket**. No entry-count basis, no cumulative cap, and `postLedger` has no
  ceiling. The same wrong basis is in `routes/admin.js:88-99` (`drawEntrySums`,
  `share = total / num_draws`).
- **Live repro on the baseline (this pass, port 3353):** player funded 10000
  minor; bought pops=[7], wager=100, `BOTH`, `num_draws=1` → ticket
  `TMVRSX3DZ14317387`, `draw_ids=[1,2]`, 2 entries, `total=200`, wallet 9800.
  Admin cancelled draw 1 → `draw_refund +200`, wallet **10000** (full price back
  while the EVE entry was still pending). Admin cancelled draw 2 → second
  `draw_refund +200`, wallet **10200**. Paid 200, refunded 400 — money creation
  reproduced exactly as audited.

## DS-020 (C-02) — Settled tickets show "ACTIVE" forever — **SURVIVES**

Disprove attempt: looked for a status-mapping layer (route or template) that
translates the engine's `'settled'` into the templates' `won`/`lost` branches.

Why it fails: there is none. `lib/draws.js:277` writes ticket status `'settled'`
when no entries remain pending (and `:148-157` writes `'cancelled'` on cancel);
nothing ever writes `'won'`/`'lost'` to `tickets.status`. `views/tickets.ejs:19-22`
and `views/ticket.ejs:11-14` branch only on `won`/`lost`/`cancelled`, else render
ACTIVE — so `'settled'` falls through forever.
**Live:** ticket `TMVRSXK01A84A2BF3` settled (DB: ticket `settled`, entry `lost`);
`GET /tickets` rendered that row "0/1 **ACTIVE**". Control: the BOTH ticket above
correctly rendered CANCELLED, proving the fall-through is specific to `settled`.

## DS-021 (C-03) — Fairness ✗ MISMATCH for settled TEST draws with fixed number — **SURVIVES**

Disprove attempt: looked for a TEST/override branch in `fairnessForDraw` or in
`settleDraw` that records a beacon status (or a recomputable derivation) for
override draws.

Why it fails: `lib/draws.js:198-200` — for `is_test && winning`, the derivation
block is skipped and `beaconStatus` stays `draw.beacon_status || ''`, written back
unchanged at `:268`. `lib/draws.js:336` — `fairnessForDraw` treats `!d.beacon_status`
as pre-v14 legacy and recomputes `deriveWinningNumberLegacy(seed, id)`, which
cannot reproduce an operator-chosen override (except 1-in-15 by chance).
Second half also holds: `views/results.ejs:26` claims TEST draws "are excluded
from payouts", but the settle entry loop (`lib/draws.js` settleDraw, pending-entry
query + pay loop) has no `is_test` exclusion — it pays entries on a test draw
exactly as on a production draw.
**Live:** admin created TEST draw 15 (2026-11-05, override 9; DB
`beacon_status=''`) and settled it. `GET /fairness?draw_id=15`: Published **9**,
Recomputed **14**, Number match **✗ MISMATCH**, Hash match ✓ MATCH, explained as
"Pre-v14 draw — legacy derivation" — all as audited. Positive control: production
draw 3 on the same run showed MATCH / MATCH, so the verifier is sound only for
the production path.

## DS-022 (C-04) — Playslip prices/balance in display currency, debit in wallet currency — **SURVIVES**

Disprove attempt: looked for a conversion call (`convertMinor`) or a
`playCurrency`-based format in the play flow.

Why it fails: `lib/util.js:77-84` `fmtMoney` only swaps symbol/decimals — no rate
is applied; `convertMinor` (`lib/util.js:85-96`) states in its own comment "there
are still zero callers in the shipped code". `views/play.ejs` formats with `cur`
(display currency from `server.js:179-183`: user pref → session → cookie → base)
at `:47` (wager circles), `:81` (prize table), `:95-101` (slip + balance), and the
form carries `data-cur="<%= cur %>"` (`:5`) which `public/app.js` uses for the
live total. The route correctly computes the balance in the wallet currency
(`routes/player.js` GET /play, `playCurrency`) but the template never uses
`playCurrency` for formatting; the POST debits the submitted wallet currency at
face value.
**Live:** player held only a USD wallet ($101.00, later $101 after flows);
display currency set to EUR. `GET /play`: wallet picker correctly USD, but wager
circles rendered **€1.00/€2.00/€5.00/€10.00**, `data-cur="EUR"`, and the balance
line read "**Wallet balance: €101.00**" — the EUR rate (0.92 in settings) was
never applied (€92.92 would be the converted figure).

## DS-023 (C-05) — Slip total/Buy button ignore bundle discount; "5 × Both" gets none — **SURVIVES**

Disprove attempt: searched `public/app.js`, `views/play.ejs`, and
`views/ticket.ejs` for any discount/bundle logic mirroring the server.

Why it fails: zero hits outside the generic banner. Client total is only
`public/app.js:50` `total = pops * wager * draws * mult` (mult 2 for BOTH).
Server (`routes/player.js:77-80`) exact-matches the bundle key against
`drawIds.length` (entry count) in `multi_draw_discounts` (seeded `5:12,8:14,12:20`).
The receipt shows only the final total — no discount line.
**Live:** (a) DAY, 1 pop, $1, 5 draws → server charged **440** (ticket
`TMVRSY4JZ390A74B3`), while the app.js formula displays **500**. (b) BOTH,
`num_draws=5` → 10 entries, bundle lookup on key 10 finds nothing, charged the
full **1000** (ticket `TMVRSY7M1E0ECD45B`). Both halves reproduced.

## DS-024 (C-06) — R-073 per-draw stake cap sums full multi-draw totals — **SURVIVES**

Disprove attempt: looked for a per-draw share (`total / entry count`) or an
entry-status filter in the cap query.

Why it fails: `routes/player.js:111-112` — existing stake is
`SUM(t.total)` over `ticket_entries` joined to tickets for the selected draw ids,
with **no division by entry count and no entry-status filter** (even refunded
entries count), and the candidate is compared as `staked + total` using its own
full multi-draw total. Both sides are inflated exactly as audited.
**Live:** set `per_draw_stake_cap=1000` ($10). The player's true per-draw stake
on the next EVE draw was 100 (one entry of the 10-entry BOTH ticket, total 1000).
A new $1 EVE ticket (true combined per-draw stake 200) was **refused**: HTTP 400,
server log `[play/buy] failed: This purchase would exceed your per-draw stake cap.`

## DS-042 (F-10) — Homepage recent-winners query omits `t.currency` — **SURVIVES**

Disprove attempt: checked whether the homepage path gets currency from another
join/local, or whether the JS refresh corrects the server render.

Why it fails: `routes/site.js:51-52` (homepage `GET /`) selects
`t.amount, t.created_at, u.name` — no `t.currency`. `views/index.ejs:78` and
`:151` then render `fmt(w.amount, w.currency || 'USD')`, i.e. every non-USD win
is formatted as USD. The contrast inside the same file proves it is an omission,
not a design: `/api/stats` at `routes/site.js:26-27` **does** select `t.currency`
and formats correctly, and the client ticker rebuild in `public/app.js` only
fires when the winner list *changes* after load (first refresh just seeds
`lastWinsKey`), and never touches the winners grid.
**Live:** inserted a €50.00 EUR `win` transaction (5000 minor) for the test
player. Homepage ticker and Latest Winners grid both rendered "**$50.00**",
while `GET /api/stats` for the same row returned `amount_fmt: "€50.00",
currency: "EUR"`.

## DS-056 (C-07) — Scheduler creates today's draws after close → instantly settle empty — **SURVIVES**

Disprove attempt: looked for a `close_at > now` guard in `ensureUpcomingDraws`
or a separation between the ensure and settle steps in the cron handler.

Why it fails: `lib/draws.js:51-62` loops `i = 0..days-1` starting **today** and
inserts today's DAY/EVE draws unconditionally (existence check only, no close-time
guard), and `lib/cron.js:10-13` runs `ensureUpcomingDraws` and then
`settleDueDraws` in the same handler (also at boot via `cron.start`).
**Live (baseline libs on the throwaway DB):** with `day_draw_time=00:01`,
`eve_draw_time=00:02` (both past at ~07:38 UTC), `ensureUpcomingDraws` created
2026-10-28 draws 16 (DAY) and 17 (EVE) with `close_at` ≈7.6 h in the past, and
`settleDueDraws` in the same run settled both instantly: winning 3 / 13,
winners 0, paid 0 — phantom results, exactly as audited.

## DS-057 (C-08) — Fairness: cancelled draws "Not settled yet" forever; unknown id silently blank — **SURVIVES**

Disprove attempt: looked for a `cancelled` branch or a `notFound` branch in
`views/verify.ejs`.

Why it fails: `lib/draws.js:323` — `fairnessForDraw` returns null verdicts for
**any** non-`settled` status, including `cancelled`; `views/verify.ejs:22,26`
render every null verdict as "Not settled yet" with no status distinction.
`routes/site.js:95` sets `result = { notFound: true }` for a missing draw, but
`verify.ejs` only checks `result.draw` — a `notFound` result renders exactly like
no draw id was entered.
**Live:** `GET /fairness?draw_id=1` (cancelled in the DS-002 repro) showed
"Not settled yet" ×2. `GET /fairness?draw_id=99999` showed the bare verify form
with zero occurrences of "not found".

## DS-058 (C-09) — My Tickets LIMIT 100 / My Scratch LIMIT 200, no pagination — **SURVIVES**

Disprove attempt: looked for pagination, an offset parameter, or a view-all
route for either account list.

Why it fails: `routes/player.js:169` — `... WHERE user_id = ? ORDER BY
created_at DESC LIMIT 100`, and `views/tickets.ejs` has no pager. 
`routes/scratch.js:29` — `... ORDER BY st.purchased_at DESC LIMIT 200`, and
`views/scratch_tickets.ejs` has tabs only (which share the same capped query),
no pager. The R-119 pagination exists only on the public `/results` page
(`routes/site.js:83`, `LIMIT 25 OFFSET ?`).

## DS-059 (C-10) — Draw schedule UTC-only; no site-timezone setting — **SURVIVES**

Disprove attempt: grepped the whole baseline (`lib/`, `routes/`, `views/`,
`server.js`) for `timezone`, `time_zone`, `site_tz` and any timezone-aware
date construction.

Why it fails: zero timezone hits anywhere. `lib/draws.js:19-21` `drawDateStr`
uses `toISOString()` (UTC date) and `closeAtFor` (`lib/draws.js:22-41`) builds
`Date.UTC(...)` from the `day_draw_time`/`eve_draw_time` settings — so the
"Evening" draw closes at 21:00 **UTC** and the draw's date label rolls over at
UTC midnight, with no setting by which an operator can express local time.
Correctly classified CONFIG/product decision in the original audit; still not
disprovable as a factual claim about the code.

## DS-073 (F-13) — Scratch lobby empty state reveals "operator has not launched a series" — **SURVIVES**

Disprove attempt: looked for alternate player-facing empty-state copy or a
condition that makes this state unreachable.

Why it fails: `views/scratch_lobby.ejs:7` renders verbatim: "The operator has
not launched an active series yet." The state is reachable whenever no
live+enabled series exists — e.g. after an operator stops/disables all series
(the boot seeder in `server.js` deliberately does **not** resurrect a stopped
Gold Rush: "leaving operator choice untouched"), so the operator-internal
wording is served to players. No second copy path exists.

## DS-074 (F-14) — Profile/referral wording reveals operator settings — **SURVIVES**

Disprove attempt: checked `views/profile.ejs` for neutral rewording or
conditional rendering that hides the operator framing.

Why it fails: both strings are unconditional in the baseline template —
`views/profile.ejs:30`: "…required before depositing or withdrawing **(operator
setting)**… staff can attest your contact manually", and
`views/profile.ejs:46`: referral commission "**(when enabled by the operator)**".
No alternate wording exists.

## DS-075 (F-15) — TEST draws publicly labelled/listed on results + homepage — **SURVIVES**

Disprove attempt: looked for an `is_test = 0` filter on the public results /
homepage recent-results queries (the upcoming-draws cards do filter by type).

Why it fails: `routes/site.js:40-41` homepage recent results is
`SELECT * FROM draws WHERE status = 'settled' ... LIMIT 10` — no test exclusion;
`routes/site.js:76-83` `/results` likewise filters only on `status='settled'`,
and even accepts `type=TEST` as an explicit filter. Both templates then label
them publicly: `views/results.ejs:11` and `views/index.ejs:126` render the TEST
badge. (The upcoming-draws query at `routes/site.js:38` does restrict to
DAY/EVE — but that is not the surface the finding is about.)
**Live:** after settling TEST draw 15, `GET /results` contained TEST entries
and `GET /` (homepage Recent Results) contained a TEST row.

## DS-076 (F-16) — Scratch reveal passes raw `e.message` to players — **SURVIVES**

Disprove attempt: looked for the generic-message treatment the scratch **buy**
route already has (R-117 pattern) being applied to the reveal route too.

Why it fails: it is not. `routes/scratch.js:104-106` (reveal POST) renders
`message: e.message` directly, while the buy route directly below
(`routes/scratch.js:120-126`) logs the error and shows a generic message. The
raw strings that can reach a player include the internal integrity error from
`lib/scratch.js:285`: "Outcome commitment mismatch — reveal refused. Contact
support." — plus "Scratch ticket not found." and any driver-level message from
the reveal transaction. No sanitising layer sits between the throw and the
render on this route.

---

## Method note

Live repro was run only against the baseline copy on port 3353 with a throwaway
SQLite DB; no file in `~/workspace/cash-pop-push/` or in the fix tree's code was
modified (this report is the only file written). The baseline server was killed
after the run (`fuser -k 3353/tcp`, health check confirms down).
