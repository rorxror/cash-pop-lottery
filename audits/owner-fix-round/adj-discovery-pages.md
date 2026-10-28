# DISCOVERY D4 — Public + player "boring old pages" sweep (v20 owner-fix round)

Worker: DISCOVERY FINDER D4. Frozen snapshot `/tmp/hunt-snapshot/` only; no app
code edited. Boot: port 4134, fresh SQLite `/tmp/d4.sqlite`, standard env
(SQLITE_PATH/PORT/BASE_URL/TICKET_HMAC_SECRET/ADMIN_SEED_EMAIL/PASSWORD).
Players registered through the real form, `email_verified=1` set via DB where
the flow required it, activity seeded through real flows (scratch buys,
lottery buys, deposit submit) plus clearly-marked DB seeds (settled draws,
transactions) where a real flow would take days. Boot killed after the sweep.

Dedupe note: U-01..U-19 / U-20..U-26 scopes were read first (LEDGER +
adj-backend/chrome/identity/payments). Nothing below duplicates a U-item;
where a candidate belongs to a U *class* on a NEW surface it says so.

---

## Candidates (proven on the boot)

### D4-C1 — A REJECTED deposit vanishes from the player's world: no in-app history anywhere, sole notification is an email that can silently fail
- **Surface:** Wallet / deposit history display (`routes/player.js` GET /wallet,
  GET /transactions; `views/wallet.ejs`, `views/transactions.ejs`).
- **Repro (real flows end to end):** admin created an enabled manual bank
  method (id 15) → player `valid2@d4.test` (verified contact) submitted a
  $20.00 deposit with the rail's required fields → wallet showed it under
  "Pending requests" (`DMVSL9N0Y241457`, $20.00, pending) → admin rejected it
  from the admin deposits queue (302, DB status `rejected`).
- **Expected:** the player can somewhere in-app see that this deposit exists
  and was rejected (a deposit/withdrawal history), the way a rejected
  withdrawal at least leaves hold+refund ledger rows.
- **Observed:** wallet reverts to "No pending requests"; /transactions has
  **no row of any kind** for the rejected deposit (a deposit only ever
  reaches the ledger if approved); no other player page mentions it. The
  only notification is the R-053 email — and on this boot its
  `notifications_log` row is `status='failed', error='SMTP not configured'`,
  i.e. on any install without working SMTP the player is told **nothing at
  all** after sending payment proof (sender name + reference were collected).
  An approved deposit does appear in /transactions as a `deposit` credit, so
  history exists for exactly one of the three outcomes.
- **Why it matters:** money-trust surface. A player who paid and is rejected
  sees the request silently disappear — indistinguishable from "the site
  took my proof and ignored it" (owner's BP-25 genuineness bar).

### D4-C2 — Out-of-range pagination renders FALSE empty states ("No results yet" / "No transactions yet" / "No tickets in this view") and impossible page counters
- **Surfaces:** `/results` (`routes/site.js:97-108`), `/transactions`
  (`routes/player.js` GET /transactions), `/scratch/my-tickets`
  (`routes/scratch.js` playerRouter GET /scratch/my-tickets); same
  unclamped-`page` pattern in `/tickets` (`routes/player.js`).
- **Repro (with real data present):** 30 settled draws seeded →
  `GET /results?page=3` and `?page=999` render "No results yet. Check back
  after the next draw." **and** "Page 999 of 2" with a Previous link.
  `GET /results?type=EVE&page=2` (15 EVE results = 1 page) renders the same
  "No results yet" with no pager at all. Player with 6 scratch tickets
  (page header counts on the same page read Unscratched 5 · Scratched 1 ·
  History 6) → `GET /scratch/my-tickets?page=2` renders "No tickets in this
  view". Player with transactions → `GET /transactions?page=99` renders
  "No transactions yet."
- **Expected:** clamp to the last page (or a truthful "you're past the last
  page" state); the empty-state copy must only appear when the list is
  actually empty.
- **Observed:** `page = Math.max(1, parseInt(...) || 1)` with no upper clamp
  in all four handlers; OFFSET beyond the end returns zero rows and the
  views' zero-row branch is the first-run empty state. A player paging (or
  landing on a stale/bookmarked page-2 link after data shrinks) is told
  results/transactions/tickets do not exist when they do.

### D4-C3 — Fairness page prints raw HTML as text for TEST draws (escaped-HTML leak, U-01/U-24 class on a new surface)
- **Surface:** `views/verify.ejs:23` — `<%= result.draw.is_test ? ' <span
  class="badge b-warn">TEST</span>' : '' %>` (escaped `<%= %>` around an HTML
  string).
- **Repro:** settled TEST draw id 200 seeded → `GET /fairness?draw_id=200`
  returns the literal text `&lt;span class=&#34;badge b-warn&#34;&gt;TEST&lt;/span&gt;`
  in the page (confirmed in raw HTML, not a text-extraction artefact). The
  "TEST draw — operator-set number" badge further down the same page renders
  correctly (it uses `<%- %>`), so the page shows one proper badge and one
  blob of printed markup.
- **Expected:** a rendered TEST badge like everywhere else.
- **Note:** the identical pattern sits in `views/results.ejs:11` and
  `views/index.ejs:129`, but those queries filter `is_test = 0`, so it is
  unreachable there today; /fairness takes any draw id, so it is live there.
  Not a regression of a numbered old item — prior DS-021/DS-057 verification
  checked the verdict badges on this page, not this draw-line badge.

### D4-C4 — Oversized form body gets a 500 "Something went wrong" instead of a clean 413 / true reason
- **Surface:** global body parsing (`server.js:159-160`, urlencoded/json
  limit `2mb`) + global error handler.
- **Repro:** `POST /contact` with a ~3 MB urlencoded body (valid CSRF,
  valid fields) → **500** rendering "Something went wrong. The team has
  been notified." Server log confirms `PayloadTooLargeError: request entity
  too large` being funnelled into the 500 path.
- **Expected:** 413 with a plain "your submission is too large" reason
  (U-02's true-reason rule), at least for player form endpoints.
- **Observed:** generic 500 page; no size guidance. Same for any form on the
  site (shared parser), contact is just the proven instance.

### D4-C5 (small) — Scratch buy-error re-render presents a DRAFT series' detail page labelled "Live"
- **Surface:** `routes/scratch.js` `renderScratchBuyError` (rebuilds the
  detail model for ANY series id, no status filter) + `views/scratch_detail.ejs`
  (status dot is a hardcoded `Live`).
- **Repro:** logged-in `POST /scratch/1/buy` (series 1 = draft "Single
  Reveal") → 400 with the true reason "This scratch series is not on sale."
  — but the page behind it is the full detail page headed `single · Live ·
  Single Reveal`, Remaining 0, prize tiers shown.
- **Expected:** the error re-render shouldn't dress a never-launched series
  up as a live product page (the direct GET /scratch/:slug correctly 404s
  for drafts).
- **Observed:** correct 400 + reason, wrong status dressing. Cosmetic, but
  it is a false "Live" claim on a money page.

---

## Per-surface sweep table

| Surface | Driven how | Result |
|---|---|---|
| Referral landing `/register?ref=CODE` | Real registrations: valid code (query + hidden field), body-only, lowercase code, bogus code `ZZZZNOPE`, duplicate-email error re-render | Valid/lowercase codes record `referred_by` correctly (DB-checked); bogus code silently ignored, account created with `referred_by=NULL` (lead L1); error re-render preserves the code via the hidden field in a real browser flow. Otherwise CLEAN |
| Results `/results` + filters + pagination | Empty DB, then 30 seeded settled draws; page 0/-5/abc/2/3/999, type DAY/EVE/bogus/lowercase | Data, filters, ordering and page 1–2 correct; **D4-C2** beyond-range. No filter UI exists in the view (lead L4) |
| Fairness `/fairness` | Real seeded draws: settled legacy (MATCH/MATCH), TEST override, cancelled, scheduled, unknown 999999, -1, abc, 1.5, array | Verdicts all correct; seed NOT revealed pre-settle; **D4-C3** TEST badge; abc silently blank (lead L2) |
| Draw detail | Results rows link only to /fairness (no separate detail page exists); ticket detail lists per-draw entries | By-design; entries rendered correctly on a real bought ticket. CLEAN |
| Transactions `/transactions` | Empty account; seeded large win $1,234,567.89 (formats `+$1,234,567.89` correctly), zero-amount row, unknown type, real scratch/lottery ledger rows; filters credit/debit/bogus; page 99 | Formatting and real rows correct; **D4-C2**; zero-amount row shows `+$0.00` and is in NEITHER credit nor debit filter (lead L3); bogus type falls back to all rows with no tab highlighted (lead L3) |
| Announcements `/announcements` | Seeded active + inactive announcements; logged-out access | Only active shown, inactive hidden, login required (redirect). No detail page exists (list-only by design). CLEAN |
| Contact `/contact` | Empty/bad input, valid, oversized fields, no-CSRF, 3 MB body, rate hammering; DB + admin inbox check | Validation flash true-reason; CSRF-less POST 403; fields truncated at caps and stored; message lands in `contact_messages` AND is visible to the operator at admin `/contact-messages`; rate limit 429 after 5/min/IP. **D4-C4** for the 3 MB body |
| CMS `/page/:slug` | Published about/faq/how-it-works/terms/privacy, draft page, missing slug, traversal slug | Published render; draft/missing/traversal all plain 404. CLEAN |
| Maintenance mode | Setting flipped in DB; anon/player/admin × GET/POST across home, results, fairness, CMS, scratch, contact, api/stats, sitemap, robots, healthz, login, register, wallet, buy | Anon+player GETs 503 maintenance page, POST buy blocked, admin fully bypasses, /healthz 200, /login allowed. Notes as lead L5. Core CLEAN |
| Scratch verify `/scratch/ticket/:id/verify` | Real bought ticket: pre-reveal, post-reveal, other-user access, DB tamper of ticket prize, DB tamper of outcome prize | Pre-reveal hides prize/nonce; post-reveal recomputed commitment matches ("Verified"); other user 404 on ticket + verify; tampering `scratch_tickets.prize` → "Verification failed — contact support." Tool genuinely verifies. CLEAN |
| Responsible play `/scratch/responsible-play` + buy-path enforcement | Clean funded user: loss limit $3 (3×$1 scratch buys pass, 4th blocked with true reason; lottery buy also blocked — combined), decrease $3→$1 (goes 24 h pending, note shown), session limit 1 min with backdated session (both scratch AND lottery blocked with session message), negative/oversized/type-confused inputs | All enforced as designed; oversized values clamped (session 1440, cooling 720 h, exclusion 3650 d); type-confused arrays didn't 500. CLEAN |
| Scratch lobby / detail edge states | No-series state (pre-seed boot), sold-out tiny series (2 tickets, real buys), draft slug, bogus slug | Empty state correct; sold-out: detail Buy button disabled, direct POST 400 "This scratch series is sold out."; lobby still lists it as Live/Remaining 0 (lead L6); **D4-C5** on the draft buy-error page |
| Scratch buy error paths | ids abc / 999999 / -1 / 5.9 / draft / sold-out | All clean 400 true-reason re-renders (5.9 parses to series 5 and buys — parseInt truncation, harmless); no 500s |
| Deposit / withdraw history displays | Full E2E: method creation → unverified-user deposit gate (403 true reason w/ CTA) → verified submit → pending in wallet → admin approve-path exists, reject path driven | **D4-C1** (rejected deposit invisible). Withdrawals leave ledger traces (hold/refund labels exist); pending card correct |
| Agent area as player | GET /agent, /agent/, /agent/dashboard as a player | 403 on all. No agent info leaks onto player pages (profile grep: no agent block). CLEAN |
| Currency switch POST /currency | EUR (applies, header shows €), XXX (ignored), lowercase usd (applies) | CLEAN |
| Homepage / api/stats | Logged-out + logged-in loads during other probes | Real DB values only (player count, paid-out base-currency); no demo data seen. (Visual items are U-03/U-09..U-13 scope.) CLEAN for D4 |
| Empty-account rendering | Brand-new player across transactions/tickets/scratch tickets/announcements/wallet | All true empty states with correct copy. CLEAN (contrast D4-C2, which is the with-data case) |

---

## Unproven leads

- **L1 — Bogus referral code is silently swallowed.** `/register?ref=ZZZZNOPE`
  registers fine, `referred_by=NULL`, and neither landing nor post-register
  says the code was invalid. May be deliberate (don't leak which codes
  exist / don't block signup), but a referred friend who typo'd the code
  silently earns nobody anything and is never told. `routes/auth.js:410-416`.
- **L2 — `/fairness?draw_id=abc` shows a silent blank form** (no "Draw not
  found"), while `draw_id=-1` and `999999` do show it: `parseInt` → NaN →
  the `if (drawId)` branch is skipped entirely (`routes/site.js:111-118`).
  `draw_id=1.5` truncates to draw 1. Inconsistent feedback only.
- **L3 — Transactions filter cosmetics:** a zero-amount ledger row renders
  `+$0.00` under All but belongs to neither Credits nor Debits filter;
  `?type=bogus` silently shows all rows with no filter tab highlighted
  (`routes/player.js` GET /transactions passes the raw type through;
  `views/transactions.ejs`).
- **L4 — Results type filter is URL-only.** The route honours `?type=DAY|EVE`
  but `views/results.ejs` renders no filter controls, so players can never
  discover it. (Pagination links do preserve the filter when it is set.)
- **L5 — Maintenance-mode nits (likely by design, flagging not claiming):**
  `/register` is NOT on the allowlist while `/login` is, so during
  maintenance a logged-out visitor can sign in but lands on the 503 page;
  `/sitemap.xml`, `/robots.txt` and `/api/stats` also get the HTML 503
  (an API consumer receives an HTML page). Matches the allowlist comment in
  `server.js` — operator may want sitemap/robots exempt.
- **L6 — Sold-out series stays in the lobby** labelled Live with Remaining 0
  (detail page disables Buy, direct POST refuses with true reason, so no
  money risk — display only).

## Swept clean (evidence in table above)

Referral recording (valid/lowercase/body+query), contact form end-to-end
(validation, CSRF, rate limit, DB landing, operator inbox), fairness
verdicts for settled/test/cancelled/scheduled/unknown draws, scratch
provably-fair verify incl. tamper detection and cross-user 404s, combined
daily loss limit + session limit enforced on BOTH buy paths, limit-decrease
24 h pending rule, responsible-play input clamping, maintenance core
behaviour, announcements active-only, CMS published/draft/404 handling,
currency switch, deposit verified-contact gate, agent-area 403 for players,
true empty states on genuinely empty accounts.

## D-FIX-B results

Re-verified on the current tree; regression tests in `test/v20-discovery-fixes.test.js` (HTTP, port 4138).

- **C1 — FIXED.** GET /wallet (routes/player.js) now also loads the player's latest deposits and withdrawals (all statuses, with `admin_note`) and passes a merged `requests` list; views/wallet.ejs gained a "Request history" card with human status labels (Pending/Approved/Rejected/Revoked/Expired/Paid — no raw enums) and the admin's reason when one is stored. Test: submit deposit → admin sets note → admin rejects → the player sees the request as **Rejected** with the reason text on /wallet.
- **C2 — FIXED.** Page clamps into [1, totalPages] on all three surfaces: /results (routes/site.js), /transactions (routes/player.js — its PER is 50), /scratch/my-tickets (routes/scratch.js). Tests: page=999 on all three renders the LAST page with a truthful "Page 2 of 2"; empty datasets keep their true empty state (the clamp is `Math.max(1, …)`-safe).
- **C3 — FIXED.** views/verify.ejs: the TEST marker is now real markup (`<% if (result.draw.is_test) { %> <span class="badge b-warn">TEST</span><% } %>`) instead of an escaped string inside `<%= %>`. Same-pattern sites re-checked on the current tree: views/results.ejs and views/index.ejs carried the identical escaped ternary — both are UNREACHABLE today (their queries filter `is_test = 0`), but both were fixed the same way so the leak can never appear if a filter changes. Test: a settled TEST draw's fairness page contains `<span class="badge b-warn">TEST</span>` and no `&lt;span` text.
- **C5 — FIXED.** views/scratch_detail.ejs: the status indicator now renders the series' REAL status (live → the Live dot; draft/stopped/ended → a plain label with the true status word) instead of a hardcoded "Live". Test: draft series buy attempt → error re-render (400) shows "Draft" and no Live dot; a live series' error re-render (insufficient balance) still shows Live.
