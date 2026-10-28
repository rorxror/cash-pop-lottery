# HOME WORKER — ADJUDICATION (v20 owner-fix round, wave B)

Worker files (exclusive): `views/index.ejs`, `routes/site.js`,
`test/v20-home.test.js`. One sanctioned exception: a minimal,
loudly-commented edit to the countdown format line in `public/app.js`
(the CHROME worker's file) — see U-03. Evidence: full file reads plus a
baseline boot on port 4124 (fresh SQLite `/tmp/home-v20.sqlite`,
seeded admin, Gold Rush auto-seeded) BEFORE any fix.

Baseline boot, logged-out `GET /` (2026-10-28 ~20:5x UTC):

- Draw labels in order: `Evening Draw, Day Draw, Evening Draw, Day Draw`
  (4 cards), all countdown placeholders `--:--:--`.
- `trust-badge` ×4 / `trust-row` ×1; `hstat` ×3; live-count data `0,0,0`.
- `v20-draw-card / v20-feature-card / v20-stat-card / v20-step-card /
  v20-scratch-card` counts: **all 0** — the delivered CSS primitives are
  unused by the homepage.
- "Gold Rush" **absent** from the homepage although the boot log proves
  a live Gold Rush series was seeded (`[boot] no live scratch series —
  seeded default live series Gold Rush`). The only "scratch" strings on
  the page are the header/footer nav links.

---

## U-03 — Draws list set + countdown format

**VERDICT: CONFIRMED (both halves).**

Draw-set evidence:

- `routes/site.js:36-39` (pre-fix): one global query —
  `... WHERE status='scheduled' AND draw_type IN ('DAY','EVE')
  ORDER BY close_at ASC LIMIT 4`. Nothing in it knows about pairs.
- Generation (`lib/draws.js` `ensureUpcomingDraws`): for each of the
  next `upcoming_draw_days` dates it ensures **one DAY (default 14:00)
  and one EVE (default 21:00)** row, `UNIQUE(draw_type, draw_date)`,
  skipping a draw whose close has already passed and skipping a type
  whose per-type AUTO switch is off. So at generation time the pairs
  are complete per date — the pairing exists in the data.
- The pairing is destroyed AFTER generation, per draw, individually:
  `settleDueDraws` — threshold mode extends a single due draw by
  **+1h** (`close_at = t + 3600000`), and 'both' mode with
  `draw_unmet_<type> = 'roll'` extends a single draw by **+24h**
  (`close_at + 86400000`, `rolls` incremented) while its same-date pair
  mate settles normally. A rolled DAY therefore lands among the NEXT
  date's draws, and the flat `ORDER BY close_at LIMIT 4` can surface
  `Day, Evening, Day` (the owner's photo), `Evening, Day, Day`, or cut
  a pair in half at the LIMIT boundary (the 5th row is the 4th row's
  pair mate and is simply never fetched).
- Converse constraint: generation CAN leave a type missing (per-type
  AUTO switch off, or today's DAY already closed and skipped). The UI
  must render only real rows — never invent a card to fill a pair.

**FIX (construction, provable):** fetch the next 2 scheduled draws of
EACH type separately (`WHERE draw_type = ? ORDER BY close_at ASC
LIMIT 2` for DAY and for EVE), merge the ≤4 real rows by
`close_at` (tie-break `draw_date`, then type). Result: at most 2 DAY +
2 EVE, always whole next-pairs when both types exist (a rolled draw
keeps its own slot; its pair mate is still the next of its own type),
no invented cards when a type is absent, and `nextDraw` (the merged
list's first row) is unchanged because the merged minimum equals the
old global minimum.

Countdown-format evidence:

- Server render produces ONLY a placeholder: `views/index.ejs` renders
  `--:--:--` for the next-draw banner and for every draw card —
  identical on all cards, so the server is not the divergence, but the
  placeholder also does not share the ticked format's structure.
- Client tick is ONE producer: `public/app.js` §(b) `tick()` selects
  `.countdown[data-close-at]` and writes
  `(d > 0 ? d + 'd ' : '') + pad(h) + ':' + pad(m) + ':' + pad(s)`.
  Inside that one function there are TWO structures: `< 24h` renders
  `HH:MM:SS` with **no day part**, `> 24h` renders `Nd HH:MM:SS`.
  On a single homepage the near cards and the next-day cards therefore
  show structurally different countdowns side by side — confirmed in
  code; the baseline boot's pairs (EVE today / DAY tomorrow / …) are
  exactly the mixed case once the tick runs.

**COUNTDOWN DECISION:** one format for every card and every range —
**always `Dd HH:MM:SS`** (day count always present, unpadded; time
zero-padded), e.g. `0d 04:12:09` and `1d 02:03:04`. Implemented as the
minimal sanctioned `app.js` edit (the conditional day-prefix becomes
unconditional, with a loud U-03 comment at the site of the change) and
the server placeholder becomes `-d --:--:--` (same structure, dashes
for unknown digits, shown only pre-tick / without JS).

## U-09 — Feature cards markup + honest copy

**VERDICT: CONFIRMED (markup); copy MOSTLY HONEST with one weak card.**

- Pre-fix markup (`views/index.ejs` trust row): four `.trust-badge`
  flex rows — icon chip (40px) on the LEFT, title + body squeezed into
  the remaining narrow column beside it. Not the delivered
  `.v20-feature-*` system (baseline count 0); body text does not get
  the card's full width and the four blocks are badges, not
  equal-height cards.
- Copy adjudication against behaviour (U-24):
  - *Provably Fair / "Every draw verifiable"* — TRUE: seed hash is
    committed before close, seed revealed at settlement, `/fairness`
    recomputes (`lib/draws.js fairnessForDraw`).
  - *Fast Win Credits / "Winnings land in your wallet as soon as the
    draw settles"* — TRUE as written, and the qualifier is the point:
    `settleDraw` posts the win through the ledger INSIDE the
    settlement transaction. It does NOT promise instant payment
    before settlement, so the body copy is kept verbatim; no
    "instant" claim is added anywhere.
  - *Secure Platform / "Provably fair, transparent draws"* — WEAK:
    the body merely duplicates the Provably Fair card and backs the
    "Secure" title with nothing. Adjusted to a claim the code backs:
    passwords are scrypt-hashed and sessions are server-side
    (`lib/util.js hashPassword`, `lib/auth.js`), and balances/results
    are decided on the server.
  - *Daily Draws / "Two chances every day"* — TRUE under the default
    generation above (one DAY + one EVE per date). Reworded to name
    the two draws ("A Day draw and an Evening draw") instead of a
    bare count.

**FIX:** rebuild the section as `.v20-feature-grid` with four
`.v20-feature-card`s: `.v20-feature-icon` on top at the CSS size,
`.v20-feature-title`, `.v20-feature-body` at full card width; grid
stretch gives equal heights.

## U-10 — Stats strip

**VERDICT: CONFIRMED (unequal boxes); queries CORRECT — untouched.**

- Pre-fix markup: `.hero-stats` is a flex row of `.hstat` boxes with
  only `min-width: 120px` — width follows content, so the Paid Out
  box (a formatted money string) renders wider than Players; the
  CHROME adjudication also measured the row's min-content at ~376px
  (overflow at 360px). Not an equal 3-up.
- Query semantics (read, NOT changed): players =
  `COUNT(*) FROM users WHERE role='player'`; tickets =
  `COUNT(*) FROM tickets WHERE created_at > now-86400000` — a rolling
  24h window, which matches the label "Tickets in the last 24 hours"
  exactly (the internal name `tickets_today` is the only loose end
  and it is not user-visible); paid out =
  `SUM(amount) FROM transactions WHERE type IN ('win','scratch_prize')
  AND currency = base_currency` — base-currency only per R-118, no
  cross-currency sum. All three are real DB aggregates; no finding
  against any of them.
- Contract to preserve: `public/app.js` refresh/count-up reads
  `.live-count` elements in DOM order (players, tickets, paid out)
  with `data-count` / `data-money` / `data-symbol` / `data-decimals`.
  The rebuild keeps element order and every data attribute byte-equal
  in meaning.

**FIX:** hero stats become `.v20-stats-row` with three
`.v20-stat-card`s (`.v20-stat-value` carries the existing
`.live-count` span, `.v20-stat-label` the label), each with an
aria-hidden `.v20-stat-deco` ball in the CSS-reserved corner — the
deco is pointer-events-none and no button lives inside a stat card,
so it can never cover a Play control.

## U-11 — Draw cards markup

**VERDICT: CONFIRMED (no v20 hooks, no ball at all).**

- Pre-fix cards are plain `.draw-card` + `.countdown` + a plain
  `.btn`; there is NO ball element in the card (baseline
  `v20-draw-card` count 0) — the gloss/sheens in the delivered CSS
  have nothing to attach to.
- Ticker contract (must not break): `app.js tick()` finds elements by
  `.countdown[data-close-at]`, where `data-close-at` is the draw's
  epoch-ms `close_at` from `publicDrawInfo`. The rebuild KEEPS the
  `countdown` class and the attribute verbatim and ADDS the v20
  classes alongside.

**FIX:** each card becomes `.v20-draw-card` containing a decorative
`.v20-draw-ball` (sun/moon glyph by draw type — no invented number),
the existing label + the draw's real `draw_date`, a
`countdown v20-draw-countdown` element with the same
`data-close-at`, the existing seed-hash line, and the Enter link with
`.v20-draw-enter` added. The next-draw banner keeps its existing
classes (it is not a draw card) and only its placeholder text follows
the U-03 format decision.

## U-12 — Homepage scratch section

**VERDICT: CONFIRMED ABSENT (proven live, see baseline above).**

- `views/index.ejs` contains no scratch section and `routes/site.js`
  `GET /` queries no scratch table — a live, sellable series is
  invisible from the homepage.
- Data source to mirror (read-only read of `routes/scratch.js`): the
  lobby query is `FROM scratch_series s WHERE s.status='live' AND
  s.enabled=1 ORDER BY s.launched_at DESC` with `remaining` =
  unclaimed outcomes (`scratch_outcomes.ticket_id IS NULL` count),
  `top_prize` = `MAX(scratch_prize_tiers.amount)`, `total_prizes` =
  `SUM(amount*quantity)`. The homepage query mirrors the status /
  enabled conditions and the remaining / top-prize expressions
  exactly — same truth, second surface.
- Seed behaviour verified in `server.js`: on a fresh DB with no live
  series (and no prior Gold Rush row) the boot inserts Gold Rush
  ($1.00, 100 tickets, tiers $10×1 / $5×5 / $2×20 = 75% RTP) and
  launches it via `launchSeries` (status live, enabled 1) — so the
  present-state is the default fresh boot, as the baseline log shows.
- No-balance rule: price / top prize / tickets remaining are PUBLIC
  series data (the lobby shows them logged out too), not per-user
  data — showing them logged out leaks nothing. No wallet figure of
  any kind is added.

**FIX:** `GET /` also fetches the mirrored series list and passes it
as `scratchSeries`; the template renders the `.v20-scratch-section`
ONLY when the list is non-empty (no placeholder branch exists — if
no live series exists the section renders nothing at all). Cards
reuse the lobby's card composition (`.scratch-card` type tint,
`.scratch-metrics`, `.status-dot`) inside `.v20-scratch-grid` /
`.v20-scratch-card`, showing title, price, top prize and tickets
remaining from the DB. CTAs: logged out → Register / Sign in (no
balances anywhere); logged in → straight to `/scratch`.

## U-13 — How It Works

**VERDICT: CONFIRMED (numerals not card-controlled; scratch missing).**

- Pre-fix homepage markup is `<div class="steps"><%- content(
  'how_it_works') %></div>` — a raw CMS string. The seeded block
  (`lib/migrations.js CONTENT_BLOCKS.how_it_works`) is an `<ol>` of
  four `<li>`s: `.steps > *` happens to card the `<li>`s, but the
  numerals are list markers whose geometry belongs to the `<ol>`,
  not to the card — they are not the delivered `.v20-step-num`
  inside-card chips, and no per-step hooks exist. No scratch step
  exists anywhere in the block.
- Trade-off recorded: structured step cards cannot be built from an
  opaque CMS HTML string, so the HOMEPAGE steps become explicit
  template markup (copy carried over from the seeded block,
  unchanged in substance). The CMS block itself is untouched and
  still drives `/page/how-it-works`.
- Scratch "instantly" check (`lib/scratch.js revealTicket`): in ONE
  transaction it verifies the outcome commitment, marks the ticket
  revealed, and — for a winning card — posts the prize through the
  ledger and stamps `credited_at`. The prize therefore credits AT
  reveal, and the outcome was locked at purchase (`buyTicket` claims
  a predetermined outcome row). Truthful wording is "prize credited
  to your wallet when you reveal it" — NOT "instant prize" before
  the reveal, and no wording here claims otherwise.

**FIX:** two equally-prominent groups in the same `.v20-steps`
style — "How Cash Pop works" (4 cards, the seeded copy) and "How
Scratch Cards work" (3 cards: buy a card → scratch to reveal →
prize credited at reveal) — every card a `.v20-step-card` with its
`.v20-step-num` chip inside the card.

---

## RESULTS (home worker, post-fix)

- Manual E2E (port 4124, fresh `/tmp/home-v20.sqlite`, curl/python
  cookie jars): logged-out draws `Evening, Day, Evening, Day`
  (= DB construction for that hour), stats `0/0/0`, cards
  feature/step/stat/draw = 4/7/3/4, scratch section present with
  register CTA and no balance; after one registration Players = 1
  and the logged-in scratch CTA is `/scratch` with no register link
  in the section; stopping Gold Rush in the DB removed the section
  AND the name entirely, restoring it brought both back; served
  `app.js` carries the unified format and not the old conditional.
- `node --test test/v20-home.test.js` — **9/9 PASS** (pair
  construction vs DB, +24h-roll simulation, countdown unification +
  ticker contract, features, stats real-value proof, scratch
  present logged-out/in, scratch absent/restore, steps).
- Full suite `node --test test/*.test.js` — 144 tests: **142 pass /
  1 fail / 1 skipped (PG)**. The single failure is the known
  v19 BP-14 UA-verbatim test (`test/v19-features.test.js:260`,
  superseded by U-04, handled at integration) — not a home-owned
  file; reported, not fixed.
