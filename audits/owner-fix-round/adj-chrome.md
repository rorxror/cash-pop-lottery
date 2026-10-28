# CHROME WORKER — ADJUDICATION (v20 owner-fix round)

Worker files (exclusive): `views/layout.ejs`, `public/app.js`,
`public/style.css`, `views/play.ejs`. Evidence gathered on a local boot
(port 4121, fresh SQLite, register/login via curl) plus full file reads.
Headless-Chromium probing of the local server was attempted but this
sandbox's Chromium 152 blocks localhost navigations outright
(`ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`, even for typed/startup
navigations with the checks disabled by flag), so DOM-behaviour claims
below rest on served-HTML repro (curl) + code execution tracing, and are
worded accordingly.

---

## U-05 — Header double pill

**VERDICT: CONFIRMED (real defect).**

Evidence (live repro, logged-in homepage header, port 4121):

- Header contains TWO visible balance controls for the same wallet:
  - `views/layout.ejs:51-55` — currency pill: `<span class="cur-code">USD</span>`
    + `<span class="cur-bal">$0.00</span>` inside `.cur-pill`.
  - `views/layout.ejs:74-78` — user-menu pill: `<span class="ubal">$0.00</span>`
    + user name inside `.balance-pill`.
- Served HTML counts (logged in): `class="cur-bal"` ×1, `class="ubal"` ×1,
  `.cur-pill` ×1, `.balance-pill` ×1 — exactly the owner's photo
  ("USD $0.00 ▾" and "$0.00 ▾").
- Logged out: `cur-bal` ×0, `ubal` ×0 — the no-balance-for-visitors rule
  already holds and is preserved.

Multi-currency is GENUINE, so the currency switch must survive the merge:

- `lib/money.js:26-38` `getWallet(tx, userId, currency)` — one wallet row
  per (user, currency); `lib/money.js` ledger posts are per-currency.
- `lib/migrations.js:201-203` — `wallets` table `PRIMARY KEY (user_id, currency)`.
- `lib/settings.js:44-57` `getCurrencies()` — operator-configured list;
  live boot serves USD + EUR + INR in the picker menu, each with its own
  balance (`walletBal(code)` per row in `layout.ejs`).

**FIX:** the currency pill becomes the ONE header balance/currency
control (currency code + that currency's balance + caret; its existing
menu still switches display currency and lists per-currency balances).
The user-menu trigger keeps name + caret only — the duplicated balance
span is removed and the trigger class is renamed `balance-pill` →
`user-pill` (CSS keeps a `.balance-pill` alias so nothing else breaks).
Logged-out rendering is byte-identical in behaviour: code + caret, no
balance anywhere in the header.

## U-06 — Cover All state coherence (playslip)

**VERDICT: CONFIRMED in its visible half; selection logic itself works.**

Evidence:

- `views/play.ejs:38` — the button is hard-coded
  `<button … id="coverAll">&#10003; Cover All</button>`: the ✓ is a
  STATIC glyph, rendered identically at 0, 7 or 15 selected. Served
  `/play` HTML confirms `id="coverAll">&#10003; Cover All` next to
  `<span id="popCount">0</span> pops selected` — exactly the owner's
  photo (✓ looking "active" while nothing is selected).
- The click path itself is sound: `public/app.js` cover-all handler sets
  every `.ball-input` `checked = true` and calls `recalc()`, which sets
  `#popCount` and disables/enables Buy; ball `change` events and Clear
  also flow through `recalc()` (selected styling is
  `.ball-input:checked + .ball`, `public/style.css`, so checking the
  inputs IS the selected styling). What is missing: the button never
  reflects state (no pressed/active state at 15), and its static ✓
  claims a state that may not exist.

**FIX (play.ejs + app.js):** remove the static ✓ glyph from the button;
in `recalc()` sync the button to reality — `aria-pressed="true"` +
`.is-active` class only when all 15 are selected, removed again as soon
as any ball is unselected (and after Clear / Quick Pick). CSS for
`#coverAll.is-active` added in the v20 section of style.css.

## U-07 — Zoom lock + horizontal fit

**VERDICT: PARTLY ALREADY-DONE (viewport), PARTLY CONFIRMED (overflow risk points).**

Evidence:

- Viewport: `views/layout.ejs:5` already serves
  `width=device-width, initial-scale=1, maximum-scale=1.0, user-scalable=no, viewport-fit=cover`
  (confirmed in live-served HTML). The DS-080 "zoom-lock" skip was
  therefore already closed by an earlier round — NO change needed or
  made to the meta; a regression test pins it.
- Base guards already exist: `html, body { overflow-x: hidden/clip }`,
  `.tbl-wrap { overflow-x: auto }`, grid blowout fix
  (`.play-grid > * { min-width: 0 }`) in style.css.
- Real remaining overflow sources at 360/390px, by inspection of the
  cascade (element min-content vs viewport):
  - `.tbl { min-width: 560px }` is only safe while EVERY table sits in a
    `.tbl-wrap`; a bare table (or a `.tbl-wrap` whose negative gutter
    margins meet a padded ancestor) pushes the page. Guard: cap
    `.tbl-wrap` at `max-width: 100%` and allow any `.tbl` outside a
    scroll container to shrink (`min-width: 0` at ≤640px is NOT applied
    to prize tables, which are already `.tbl-sm`; instead the guard
    keeps the scroll container authoritative).
  - `.draw-cards { minmax(240px, 1fr) }` and `.steps { minmax(220px, 1fr) }`
    are fine at 360px but their card padding + the fixed
    `.countdown { font-size: var(--fs-xl) }` mono string can crowd a
    240px card; v20 primitives use `minmax(0, 1fr)` single-column at
    ≤480px.
  - Flex rows that can outgrow 360px: `.draw-banner-timer` (countdown +
    button), `.head-right` (two pills + toggle), `.hero-stats`
    (`.hstat { min-width: 120px }` ×3 + gaps = 376px > 360px viewport
    once gutters are added — a genuine 360px overflow), `.trust-row`
    2-col badges with 40-50px icons + text.
  - Long unbreakable strings: `.cr-bal { white-space: nowrap }` wallet
    amounts and `.countdown` inside narrow cards.
- Headless layout measurement was blocked (see header note), so the
  fix is CSS-guard based and conservative: global `min-width: 0` on
  flex/grid children of the named rows, wrap allowances, a ≤480px
  single-column collapse for hero stats / trust row, `overflow-wrap`
  on countdown/balance figures, and `max-width: 100%` on all media /
  tables / scroll containers. No page-specific hacks — the guards live
  in one v20 block applied site-wide via layout.ejs's single stylesheet.

## U-08 — Flash auto-dismiss

**VERDICT: CONFIRMED.**

Evidence:

- Live repro: after a profile save the served page contains
  `<div class="flash f-ok" role="alert">Profile updated.` — and nothing
  else: no close control, no dismiss hooks.
- `views/layout.ejs:94-99` renders error/success flashes as bare divs.
- `grep flash public/app.js` = 0 hits: no JS ever dismisses them; they
  persist until the next navigation/refresh — the owner's complaint.

**FIX:** layout flash markup gains hooks while keeping semantics
(`role="alert"` unchanged): success =
`class="flash f-ok" data-flash="success" data-auto-dismiss="4000"`,
error = `data-flash="error"` (no auto-dismiss); BOTH get a visible
`<button class="flash-close" data-flash-close aria-label="Dismiss message">×</button>`
(error required it; giving success the same button is consistent and
harmless). app.js: success auto-dismisses at 4s (adds `.is-fading`,
removes the node after the 300ms fade; if it is the only flash, the
`.flash-wrap` is removed too so no empty gap remains); close buttons
dismiss either kind immediately. CSS: fade transition (opacity /
transform only), close-button positioning + 48px touch target,
`prefers-reduced-motion` disables the fade.

## U-09 — Post-login motion loss (app.js root cause)

**VERDICT: the suspected login GATE is DISPROVEN; a real structural
cause in app.js init order is CONFIRMED and fixed.**

Evidence:

- Full read of `public/app.js`: there is NO login/session branch
  anywhere. Hero count-up (`.live-count`, ~line 125) runs
  unconditionally; the floating balls / ticker / banner motion is pure
  CSS (`public/style.css` `.fball { animation: floaty … infinite }`,
  unconditional). Logged-in and logged-out homepage HTML contain the
  same hero, the same `.live-count` elements and the same script —
  served-HTML diff (curl, both states) shows the only logged-in delta
  is the welcome bar + header pills. Nothing in app.js keys off them.
- The structural weakness that CAN kill the motion, login or not:
  app.js is ONE IIFE (failure domain) for all player inits, and the
  playslip block runs FIRST (~lines 25-123) with UNGUARDED element
  lookups — `document.getElementById('quickPick').addEventListener(…)`,
  `…'coverAll'…`, `…'clearBalls'…`. Any throw there (a page variant
  missing one control, a malformed `#prizeData` island is guarded but
  the listeners are not) aborts the whole IIFE: the hero counters,
  countdowns, ticker refresh and nav inits BELOW it never run, and the
  page looks "dead" — cards static, numbers never count up — while CSS
  balls keep floating, matching a partial-motion-loss report.
- Contributing CSS fact for the phone report: hero-float was
  `display: none` below 1024px (style.css ~line 1237); a later appended
  override (~line 1608) re-enables it scaled-down, so on current code
  the balls do render on phones — fragile cascade luck, not design.
  (Wave-B markup worker owns index.ejs; the v20 stats/feature
  primitives below keep motion on `transform/opacity` only.)

**FIX (app.js):**
1. The three playslip action listeners are null-guarded (same pattern
   the file already uses elsewhere), so a missing control can no
   longer abort the init chain.
2. The primary count-up marks each element `data-counted="1"`.
3. A NEW, independent fallback in the second IIFE (a separate failure
   domain that already exists for moved-inline scripts): on
   DOMContentLoaded + 600ms, any `.live-count` NOT marked
   `data-counted` is animated by the fallback — so even if the first
   IIFE ever dies early on a logged-in page variant, the hero numbers
   still count up instead of sitting static.

## CSS primitives delivered for Wave B (style.css, "V20 WAVE-B PRIMITIVES" block)

Exact class names (all new, `v20-` prefixed, no collisions with
existing classes):

1. **U-11 draw-card shine**
   - `.v20-draw-card` — premium draw card: gloss gradient surface,
     position relative + overflow hidden for the sheen sweep.
   - `.v20-draw-card::after` — slow sheen sweep (transform/opacity
     only, 5.5s), disabled under `prefers-reduced-motion`.
   - `.v20-draw-ball` — glossy ball (radial highlight via ::before).
   - `.v20-draw-countdown` — countdown emphasis (tabular nums, gold,
     larger, letter-spaced).
   - `.v20-draw-enter` — Enter button with sheen on hover/press
     (::after sweep on hover, scale press state).
2. **U-09 feature-card grid**
   - `.v20-feature-grid` — equal-height grid; 3-col desktop, **2-col
     mobile that never squeezes** (collapses to 1 col ≤380px).
   - `.v20-feature-card` — card (icon top, then title, then body).
   - `.v20-feature-icon`, `.v20-feature-title`, `.v20-feature-body`
     (body is full-width, normal wrapping — no narrow columns).
3. **U-10 stats row**
   - `.v20-stats-row` — equal 3-up grid, stacks to 1 col ≤560px.
   - `.v20-stat-card` (position relative, overflow hidden),
     `.v20-stat-value`, `.v20-stat-label`.
   - `.v20-stat-deco` — decorative ball, absolutely positioned in the
     card's top corner with `pointer-events: none`, padding reserved
     on the card so it never overlaps buttons/text.
4. **U-13 How-It-Works steps**
   - `.v20-steps` — grid of step cards.
   - `.v20-step-card` — card with reserved left/top space INSIDE.
   - `.v20-step-num` — numeral chip positioned INSIDE the card
     (top-left, within padding — never outside the card edge).
5. **U-12 scratch homepage section**
   - `.v20-scratch-section` — homepage section shell.
   - `.v20-scratch-grid` — mirrors `.scratch-grid` responsive shape.
   - `.v20-scratch-card` — mirrors `.scratch-card` lobby look
     (border tint, metrics reuse: compose with existing
     `.scratch-metrics` / `.status-dot` / `.eyebrow`).
6. **U-14 accordion (profile)**
   - `.v20-accordion` — group container (Apple-Settings style rows).
   - `.v20-accordion-item` — a `<details>` row (border-separated).
   - `.v20-accordion-summary` — summary line (list-style none,
     48px+ hit area, flex space-between).
   - `.v20-accordion-chevron` — chevron span, rotates 180° when the
     parent details is `[open]`.
   - `.v20-accordion-body` — padded content region.
7. **U-04c session cards**
   - `.v20-session-list` — vertical stack (no table).
   - `.v20-session-card` — one session per card.
   - `.v20-session-card--current` — current-session emphasis.
   - `.v20-session-meta` — device · browser · IP · expiry lines.
   - `.v20-session-badge` — "This session" marker pill.
8. **U-17 custom checkbox / switch** (modelled on the existing admin
   iOS switch, style.css `.adm input[type="checkbox"]` 51×31 track,
   27px thumb, green checked — same geometry, player-side colours)
   - `.v20-switch` — label wrapper, min-height 48px touch target,
     flex row with gap; contains the input + `.v20-switch-ui` + text.
   - `.v20-switch-input` — the native checkbox (appearance none,
     51×31 pill track, thumb via ::after, gold checked state to match
     the player theme; `:focus-visible` ring).
   - `.v20-checkbox` — label wrapper (48px target) for plain
     checkboxes; `.v20-checkbox-input` — 22px custom box, gold check
     via accent + border styling consistent with `.field.check`.

Plus U-07 guards and `#coverAll.is-active` / flash styles in the same
appended v20 block. All v20 animations use transform/opacity only and
are neutralised under `@media (prefers-reduced-motion: reduce)`.

## Tests

`test/v20-chrome.test.js` (spawned server, own temp DB/port, pattern of
`test/v19-features.test.js`): asserts (a) logged-in header contains
exactly ONE visible balance control (one `.cur-bal`, zero `.ubal`,
user trigger carries no balance) and the currency menu still lists
multiple currencies; (b) logged-out header contains NO balance markup;
(c) viewport meta contains `maximum-scale=1` and `user-scalable=no`;
(d) a flashed page (register → home success flash) carries
`data-flash` / `data-auto-dismiss` / `data-flash-close` hooks;
(e) `/play` markup no longer contains the static ✓ Cover All glyph and
the button carries `aria-pressed="false"` initially.


## RESULTS (chrome worker, post-fix)

- Behaviour re-check on a fresh boot (port 4121): logged-in header now
  serves `cur-bal` ×1, `ubal` ×0, `balance-pill` ×0, `user-pill` ×1,
  currency menu ×3 currencies; flash serves
  `data-flash="success" data-auto-dismiss="4000"` + close button;
  Cover All serves without the ✓ glyph, `aria-pressed="false"`.
- `node --test test/v20-chrome.test.js` — 6/6 PASS (hermetic run on
  port 4392; an earlier 4122 run also passed but a sibling process was
  already listening there, so the port was moved and re-run clean).
- Full suite after fixes: 107 tests = 105 pass / 1 fail / 1 skipped
  (PG). The single failure is v19 BP-14 (sessions page expects the raw
  user-agent verbatim; the page now renders "—" for the UA) — that is
  the U-04 worker's in-flight surface (`views/security.ejs` + session
  recording), NOT a chrome-owned file; the failing page's HTML shows
  the U-05/U-08 changes rendering correctly. Flagged for coordinator.
