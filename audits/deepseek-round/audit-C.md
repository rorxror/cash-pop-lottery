# Audit C — Games (DeepSeek round)

Scope: lottery buy flow (playslip, pops/wager/draw selection, multi-currency), draw scheduling + settlement, results pages, my tickets, scratch cards (buy, reveal, commitment/verify, winnings credit), winners pages, fairness/verify pages.
Method: code read of lib/draws.js, lib/scratch.js, lib/beacon.js, routes/player.js, routes/scratch.js, routes/site.js, server.js, public/app.js + listed views; cross-checked against audits/COMPILED-LIST.md (R-001..R-124) and FIX-LOG.md — already-fixed items are not re-reported unless proven still broken live (marked REGRESSION). Live repro on port 3313 with a fresh SQLite DB, beacon disabled for determinism.
Hard exclusions honoured: no per-ticket/per-user outcome override/rigging suggestion anywhere below; known-correct economics (win = wager × multiplier once per entry, RTP = multiplier/15) not re-litigated.

Findings are appended as verified.

## C-01 — BOTH tickets are refunded TWICE on draw cancel (money creation)
- **Severity:** Critical · **Class:** CODE-BUG
- **Evidence:** `routes/player.js` buy stores `num_draws` = the per-type count requested (e.g. 1) while inserting one entry per draw id — for `draw_type=BOTH` the draw-id list is `numDraws` DAY **plus** `numDraws` EVE draws (`drawIds.length = 2 × numDraws`), and `total = pops × wager × drawIds.length`. `lib/draws.js` `cancelDraw` refunds each entry on the basis `ticket.total / num_draws` with the v17.1 cumulative-rounding counter `k` running over **all** refunded entries of the ticket — so for a BOTH ticket the denominator is half the real entry count and cumulative refunds reach `2 × total`. Same wrong basis in `routes/admin.js` `drawEntrySums` (maker-checker threshold share = `total / num_draws`).
- **Live repro (port 3313, fresh DB):** player credited 10000 minor. Bought pops=[7], wager=100, `draw_type=BOTH`, `num_draws=1` → ticket `TMVRRMTOR034B233A`, `draw_ids=[1,2]`, entries=2, total=200, wallet 9800. Admin cancelled draw 1 → refund **200** (the full ticket price, while the EVE entry was still pending), wallet back to 10000. Admin cancelled draw 2 → second refund **200**, wallet **10200**. Net: player paid 200, received 400 in refunds — $2.00 created from nothing per $2 BOTH ticket, scaling linearly with wager/pops (a 15-pop $10 BOTH ticket: pay $150, cancel-refund $300).
- **Impact:** Any BOTH ticket whose draws are cancelled (a normal operator remedy for a stuck/broken draw, R-025 path) pays out double. Repeatable value extraction whenever an operator cancels both legs; also corrupts the "refunded" accounting the admin exposure card relies on.
- **Note:** DAY/EVE-only multi-draw tickets are unaffected (entries == num_draws). Fix direction (not applied, audit-only): the refund basis must be the ticket's actual entry count, not the stored per-type `num_draws`.

## C-02 — Settled tickets display as "ACTIVE" forever on My Tickets and ticket detail
- **Severity:** Medium · **Class:** CODE-BUG
- **Evidence:** `views/tickets.ejs` and `views/ticket.ejs` badge logic branches on `ticket.status === 'won' | 'lost' | 'cancelled'`, else renders ACTIVE. The engine never writes `won`/`lost` to `tickets.status`: `lib/draws.js` settle writes `'settled'` (when no entries remain pending) and `cancelDraw` writes `'cancelled'`; purchase writes `'active'`. So every fully-settled ticket falls through to the ACTIVE badge for the rest of its life.
- **Live repro:** bought DAY ticket `TMVRRNA4SAE612CD5` (draw 3), settled draw 3 (winning 5, entry `lost`, ticket row status = `settled` in DB). `GET /tickets` row renders “… 0/1 **ACTIVE**”; `GET /ticket/TMVRRNA4SAE612CD5` header Status also renders **ACTIVE** while its own per-draw table correctly shows LOST.
- **Impact:** Players cannot tell finished tickets from live ones in the list; a settled winning ticket also shows ACTIVE (only the inner per-draw rows show WON), inviting support disputes ("my ticket is still active — where is my prize?"). The won/lost badge branches are dead code.

## C-03 — Fairness page reports "✗ MISMATCH" for every settled TEST draw with a fixed number
- **Severity:** Medium · **Class:** CODE-BUG
- **Evidence:** `lib/draws.js` `settleDraw`: for a test draw with an override, the derivation block is skipped and `beacon_status` is written back as the draw's pre-existing value (`''`). `fairnessForDraw` treats `!d.beacon_status` as a pre-v14 legacy draw and recomputes with `deriveWinningNumberLegacy(seed, id)` — which can never reproduce an operator-chosen override number. `views/verify.ejs` then renders the number-match cell as MISMATCH (hash still MATCHes).
- **Live repro:** admin created TEST draw id 15 (2026-11-05, override 9, audit-logged as designed) and settled it. Public `GET /fairness?draw_id=15` shows Published winning number **9**, Recomputed winning number **1**, Number match **✗ MISMATCH** (Hash match ✓ MATCH).
- **Impact:** The provably-fair page — the page whose entire job is trust — publicly declares a (labelled TEST) draw unfair, and explains it with the "Pre-v14 draw — legacy derivation" text, which is also wrong for these draws. Anyone verifying from the Results page (every settled TEST draw links there) hits this. Related presentation inconsistency, same area: `views/results.ejs` states TEST draws "are excluded from payouts", but `settleDraw` settles/pays entries on test draws exactly like production draws (no player entries can exist today only because the buy flow filters `draw_type IN (DAY, EVE)`).
- **Positive control:** the same verifier on a normal settled production draw (draw 3, beacon disabled) correctly shows MATCH / MATCH — the verifier itself is sound for production paths (see WORKS notes).

## C-04 — Playslip prices and balance are formatted in the display currency while the debit is in the wallet currency (no conversion)
- **Severity:** Medium · **Class:** CODE-BUG
- **Evidence:** `routes/player.js` GET `/play` correctly selects the wallet currency (`playCurrency`, R-071) and computes `balance` from that wallet, but `views/play.ejs` formats wagers, the prize table, slip totals and the balance line with `cur` — the res.locals **display** currency (`server.js`: user pref → session → cookie → base) — and `public/app.js` formats the live slip total with `data-cur="<%= cur %>"`. `fmtMoney` only swaps symbol/decimals; no rate conversion exists in the play flow. The buy POST debits the wallet matching the submitted `currency` field at face value.
- **Live repro:** player holds only a USD wallet ($101.00); `display_currency='EUR'`. `GET /play`: wallet picker correctly shows USD selected, but wager circles render **€1.00 / €2.00 / €5.00 / €10.00** and the slip says "Wallet balance: **€101.00**". Submitting buys a USD ticket debited at $ face value — the player was shown euros throughout. (Prize table header is also hard-coded "Win per $1" regardless of currency.)
- **Impact:** Any player who switches display currency (a header feature) sees wrong-currency prices and balance on the one page where they commit money; the amount they believe they are staking/paying differs in currency from the amount actually debited.

## C-05 — Playslip total / Buy button never reflect the multi-draw bundle discount the server charges; BOTH selections silently get no discount
- **Severity:** Medium · **Class:** CODE-BUG
- **Evidence:** Server buy (`routes/player.js`) applies `multi_draw_discounts` (seeded default `5:12,8:14,12:20`) by exact-matching the bundle key against `drawIds.length` (entry count). The client total in `public/app.js` `recalc()` is only `pops × wager × draws × (BOTH?2:1)` — no discount logic exists client-side, and `views/play.ejs` shows the discount only as a generic banner line. The ticket receipt (`views/ticket.ejs`) likewise shows only the final total with no discount line.
- **Live repro:** (a) DAY, 1 pop, $1 wager, 5 draws → slip/Buy button display **$5.00** (per app.js formula); server charged **440** (ticket `TMVRRO7SWC75773FC` total=440, wallet debited 440). (b) Selecting "5 × Both" → 10 entries; bundle lookup keys on 10, finds nothing, server charged the full **1000** (ticket `TMVRROCZWCADB3B5B`) — so the advertised "5 draws → 12% off" applies to a 5-draw DAY slip but not to the 5-draw BOTH slip the UI presents identically.
- **Impact:** The price a player confirms (slip total + button label) is not the price charged whenever a bundle applies — a displayed-price/charged-price mismatch on a real-money purchase, and an inconsistent discount rule between DAY and BOTH that neither the banner nor the slip explains.

## C-06 — Per-draw stake cap (R-073) counts full multi-draw ticket totals, not per-draw stakes — legitimate buys are refused
- **Severity:** Medium · **Class:** CODE-BUG (defect inside the R-073 fix; the cap feature itself works as an on/off gate)
- **Evidence:** `routes/player.js:109-113`: existing stake is `SUM(t.total)` over `ticket_entries` joined to tickets for the selected draw ids — i.e. each existing ticket contributes its **full** total (all draws, all entries) once **per overlapping selected draw**, and the candidate purchase is then compared as `staked + total` using its own full multi-draw total. A per-draw cap should compare per-draw shares (`total / entry count`). Both sides of the comparison are therefore inflated, by up to the ticket's draw count (×10 for a 5×BOTH ticket, whose total is counted against a single one of its draws in full, and ×2 again per overlap in an `IN (...)` sum).
- **Live repro:** set `per_draw_stake_cap = 1000` ($10). The player's only stake on the next EVE draw (id 4) was one entry of the 10-entry BOTH ticket `TMVRROCZWCADB3B5B` (total 1000 → true per-draw share 100). A new $1 EVE ticket (true per-draw stake 100; combined true stake 200, far under the $10 cap) was **refused**: HTTP 400, server log `[play/buy] failed: This purchase would exceed your per-draw stake cap.` — because the check summed the full 1000 and added 100.
- **Impact:** With the cap enabled (an operator risk control), regular multi-draw/BOTH players are blocked from ordinary small buys with a generic "Purchase failed" page; the cap also cannot be reasoned about by the operator since the measured quantity is not the per-draw exposure it claims to limit.

## C-07 — Scheduler creates today's draws after their close time has passed; they instantly settle empty and appear as results
- **Severity:** Low · **Class:** CODE-BUG
- **Evidence:** `lib/draws.js:51` `ensureUpcomingDraws` loops `i = 0..days-1` starting from **today** and inserts DAY/EVE draws for today's UTC date unconditionally — no `close_at > now` guard. The same cron handler (`lib/cron.js` `ensure_draws`, also run at boot) immediately calls `settleDueDraws`, which settles any scheduled draw with `close_at <= now`.
- **Live repro (app's own libs, scratch DB):** with `day_draw_time=00:01`, `eve_draw_time=00:02` (both past at ~07:00 UTC), `ensureUpcomingDraws` created 2026-10-28 DAY/EVE draws with `close_at` in the past, status `scheduled`; `settleDueDraws` in the same run settled both instantly (`winning 8 / 10, winners 0, paid 0`). In production terms: a first boot or a draw-time change after a draw time produces same-day "results" for draws that were never open for sale (players cannot buy them — the buy flow's close_at re-check, R-072, correctly refuses — so they are pure phantom results on /results and the homepage).
- **Impact:** Polluted results history and fairness pages with never-sold draws; confusing for players auditing results and for operator exposure/reporting counts.

## C-08 — Fairness page edge states: cancelled draws say "Not settled yet" forever; unknown draw ids silently show nothing
- **Severity:** Low · **Class:** CODE-BUG
- **Evidence:** `lib/draws.js` `fairnessForDraw` returns nulls for **any** non-`settled` status, and `views/verify.ejs` renders every null verdict as "Not settled yet" — including `cancelled` draws, which will never settle. `routes/site.js:95` sets `result = { notFound: true }` for a missing draw, but `views/verify.ejs` has no `notFound` branch, so the page renders exactly as if no draw id had been entered.
- **Live repro:** `GET /fairness?draw_id=1` (draw 1 was cancelled in the C-01 repro) shows Hash match / Number match = "Not settled yet". `GET /fairness?draw_id=99999` shows the bare verify form with no error or "not found" message.
- **Impact:** Minor trust/UX wart on the fairness surface: a player checking a cancelled (refunded) draw is told to wait for a settlement that can never happen, and a typo'd draw id gives no feedback.

## C-09 — Ticket history lists are hard-capped with no pagination or view-all path
- **Severity:** Low · **Class:** CODE-BUG
- **Evidence:** `routes/player.js:169` My Tickets: `LIMIT 100` with no pagination in `views/tickets.ejs`; `routes/scratch.js:29` My Scratch Tickets: `LIMIT 200` likewise (the R-119 fix paginated the public /results page but not these two account lists).
- **Impact:** A player with >100 lottery tickets (easy: one multi-draw purchase a day) permanently loses in-account access to older tickets and their per-draw results/fairness trail; support must query the DB for them.

## C-10 — Draw schedule is UTC-only: no site timezone exists, so "Day/Evening" draws close at fixed UTC times under a UTC date
- **Severity:** Low · **Class:** CONFIG-NEEDED
- **Evidence:** `lib/draws.js` `drawDateStr` uses `toISOString()` (UTC date) and `closeAtFor` builds `Date.UTC(...)` from `day_draw_time`/`eve_draw_time` (defaults 14:00 / 21:00). A grep of settings/migrations finds no timezone setting anywhere in the codebase. The homepage countdown is epoch-based (correct in absolute terms), but the draw's *date label* and its local close time are UTC: a 21:00 "Evening" draw closes at 21:00 UTC — e.g. mid-afternoon US Central — and late-evening US play rolls onto the next UTC date's draws.
- **Impact:** Operator cannot express "Day draw 2pm local" for their market; players see draw dates that roll over at UTC midnight rather than local midnight. Needs a product decision (a site-timezone setting honoured by scheduling + date labels), not just a code tweak.

## Verified WORKS (checked live or by full trace — not findings)
- **Lottery settlement math + HMAC gate:** draw 3 settled with beacon disabled; losing entry paid 0, ticket/entry states consistent; tamper path is guarded by the settle-time HMAC check in `lib/draws.js` (code-verified). Win economics follow the known-correct rule (wager × multiplier once per entry) in the settle loop.
- **Provably-fair verifier (production draws):** `/fairness?draw_id=3` → Hash MATCH, Number MATCH. `publicDrawInfo`/`fairnessForDraw` withhold seed, winning number and beacon fields until settled — no future-outcome leak found on /fairness, /results (settled-only), homepage upcoming cards (seed hash only), or ticket detail (winning_number is NULL until settle for production draws).
- **Scratch buy/reveal/verify, end-to-end live:** 9 Gold Rush tickets bought at 100 each; outcomes locked at purchase (`scratch_tickets.prize` NULL until reveal); pre-reveal ticket page and verify page contain **no nonce and no prize** (grep-verified against DB values); reveals credited exactly the locked prizes (200 and 1000) once each via `scratch_prize` ledger rows, wallet arithmetic reconciles to the minor (8960 after all flows); duplicate reveal POSTs (including on a winning ticket) credited nothing extra; post-reveal verify page recomputes the commitment and shows "Verified". Lobby/detail RTP display matches series math (75% seeded series).
- **Buy-flow guards (R-072/R-073 halves that do work):** close_at re-checked inside the buy transaction, buy rate limit present, draws selected server-side by type (TEST draws cannot be bought), pops deduped/range-checked, wager restricted to configured options, insufficient-balance buys fail atomically with no ticket row.
- **No balances to logged-out visitors:** layout renders wallet balances only under `if (user)`; logged-out fetches of /, /results, /fairness, /scratch contain no balance markup (grep-verified). Winners surfaces (homepage ticker/grid, /api/stats) show first names only.
- **Draw-cancel for DAY/EVE tickets** refunds exactly the stake (the C-01 defect is specific to BOTH tickets' entry-count basis); cancelled-ticket status and refund ledger rows are written atomically with audit.

## Summary

| Severity | CODE-BUG | CONFIG-NEEDED | WORKS areas verified | Total |
|---|---|---|---|---|
| Critical | 1 (C-01) | 0 | — | 1 |
| High | 0 | 0 | — | 0 |
| Medium | 5 (C-02, C-03, C-04, C-05, C-06) | 0 | — | 5 |
| Low | 3 (C-07, C-08, C-09) | 1 (C-10) | — | 4 |
| **Total findings** | **9** | **1** | 6 areas | **10** |

Headline: C-01 (Critical) — cancelling both legs of a BOTH ticket refunds 2× the purchase price (live-proven money creation: paid 200, refunded 400). No regressions of previously-fixed R-items were found in this area; C-06 is a defect *inside* the R-073 fix's math rather than a revert of it. No per-ticket/per-user outcome-manipulation surface exists or is suggested; all outcome paths remain server-predetermined at purchase/creation and provably fair.
