# Adjudication — ACCOUNT worker (v20 owner-fix, wave B)

Scope: views/profile.ejs, security.ejs, wallet.ejs, deposit_new.ejs,
withdraw_new.ejs, support.ejs, support_view.ejs, tickets.ejs +
test/v20-account.test.js (+ one documented app.js addition, U-16).
Contracts consumed as delivered by BACKEND + CHROME workers; not re-derived.

## U-01 — HTML/entities printed as visible text — CONFIRMED (2 sites) + sweep

- profile.ejs:31 — `<%= user.email_verified ? '<span class="badge b-ok">…verified</span>' : '<span class="badge b-warn">not verified</span>' %>`:
  `<%=` escapes the string, so the player literally reads the span markup.
  Same construction profile.ejs:33 for phone. FIX: real conditional markup.
- wallet.ejs:26 — ternary fallback is the STRING `'&nbsp;'` rendered through
  `<%=`, so "Balances" prints the literal text `&nbsp;`. FIX: empty fallback.
- Sweep of every owned view for the same class (`<%=`/`<%-` with markup or
  entity strings, entity-as-text):
  - tickets.ejs:20 — `<%- t.won_count > 0 ? '<span class="badge b-ok">WON</span>' : … %>`
    renders CORRECTLY today (raw output) — not a visible-text bug — but it is
    the same fragile string-markup pattern; converted to real conditional
    markup while here, behaviour identical.
  - profile/security/wallet/deposit_new/withdraw_new/support/support_view:
    no other instance found. Entities written directly in template HTML
    (`&mdash;`, `&middot;`, `&larr;` etc.) are markup, not `<%=` strings,
    and render as intended — not bugs.

## U-14 — Profile accordion — CONFIRMED (sections are always-open cards)

- profile.ejs:27-38 Contact verification is a `.card`; :48-62 Email
  notifications is a `.card`; :64-78 referral is a `.login-branding` block.
  All render fully expanded, always.
- Delivered CSS verified in public/style.css:1880-1892: `.v20-accordion` is
  `<details>`-based (`.v20-accordion-item[open ] .v20-accordion-chevron`,
  summary marker suppressed) — works with NO JS. FIX: convert those three
  sections to `.v20-accordion` items, collapsed by default.
- Truthful summaries: notifications count computed in-view from the same
  expressions that set the checkboxes' `checked` state today (profile.ejs:55,58);
  contact summary from `user.email_verified` / `user.mobile_verified`;
  referral summary shows the referral code. Nothing invented.
- Auto-collapse after save: every profile POST handler redirects back to
  /profile (routes/player.js POST /profile, /profile/notifications,
  /profile/verify-*) — a fresh render is collapsed by default and carries
  the U-08 auto-dismiss success flash from layout.ejs:93-96. That IS the
  required behaviour; no extra mechanism needed.

## U-15 — Profile verified badge — CONFIRMED missing

- profile.ejs:4-6 header shows only the account-status badge.
- Backend local verified in routes/player.js:711-713: `profileVerified`
  (email OR phone verified, the money.js gate rule) is passed to the view.
  FIX: header badge purely off that local — `b-ok` "Profile verified" /
  `b-warn` "Profile not verified". Colour choice: **b-warn** (the design
  system's existing warning badge: gold background, navy text — the same
  family the unverified contact badges use), owner left colour to us.

## U-16 — Referral full URL + Copy — CONFIRMED (span, relative-capable, no copy)

- profile.ejs:68 renders the link as a `<span class="code" id="refLink">`
  built from `baseUrl` in-view; routes/player.js:712-713 now passes
  `referralUrl` (absolute) + `baseUrl`. FIX: read-only `<input>` whose value
  is `referralUrl` verbatim + a Copy button; block stays hidden when there
  is no referral code (today's guard, profile.ejs:64).
- Copy pattern search: `grep -rn "clipboard|Copied|data-copy|execCommand"`
  over views/ + public/app.js returned NOTHING — no existing pattern to
  reuse. Views carry no inline `<script>` by policy (app.js (g) header:
  "v14 CSP: no inline <script> in views"). Therefore the ONE allowed app.js
  addition is used: a small `[data-copy-target]` handler in public/app.js
  (clipboard API + select fallback, button label flips to "Copied" briefly).

## U-17 — Notification checkboxes → v20 controls — CONFIRMED (plain checkboxes)

- profile.ejs:54-59: two bare `<input type="checkbox">` inside labels.
  Delivered CSS public/style.css:1912-1942 provides `.v20-switch` (51×31
  track, 48px row) / `.v20-checkbox`. FIX: `.v20-switch` controls.
  POST contract preserved EXACTLY: form action /profile/notifications,
  names `notify_win_email` / `notify_support_email`, value `1`, same
  checked-state expressions (backend BP-13 reads presence only).

## U-04c — Security sessions rebuild — CONFIRMED (wide table + raw UA)

- security.ejs:95-116: sessions are a `.tbl` table rendering
  `s.user_agent` VERBATIM (line 106 area: `<td><%= s.user_agent || '—' %></td>`).
- Backend model verified in routes/player.js securityViewModel (~827-852):
  sessions[] = { id, ip, created_at, expires_at, device, browser, os,
  deviceLabel } — NO user_agent key reaches the view anymore, so the old
  cell would print "—" for everyone AND the table layout is the clipping
  problem.
- **Current-session marking source (found):** the model ALSO returns
  `currentSessionId: req.sess ? req.sess.id : ''` (routes/player.js ~850),
  and the old view compared `s.id === currentSessionId` (security.ejs:106).
  The rebuild preserves exactly that comparison, rendered as
  `.v20-session-card--current` + `.v20-session-badge` "This session".
- FIX: `.v20-session-list` / `.v20-session-card` stacked cards, deviceLabel
  headline, IP / signed-in / expiry as `.v20-session-meta` lines, revoke
  form preserved verbatim (`POST /security/sessions/revoke`, shown when
  sessions.length > 1). Raw UA appears nowhere (the local no longer exists).
- Header clipping: the sessions card sits in normal flow inside
  `<section class="wrap section narrow">` (.section padding-top is
  var(--sp-8), style.css:108; html scroll-padding-top:96px, style.css:78).
  No negative margin / overflow rule touches it; the rebuild keeps it in
  the same flow position with the card's own spacing, so nothing is cut
  by the sticky `.site-head` (style.css:183).

## U-18 / U-25 — Support views — CONFIRMED (form always shown; no Delete)

- support_view.ejs:20-29: the reply form shows for every non-closed ticket;
  no use of the delivered locals. Backend verified routes/player.js
  (~970-975, 1027-1035): `canReply` boolean + `lockReason` ('' when
  canReply) ARE passed. FIX: canReply false → form replaced by a note
  showing lockReason (fallback waiting-for-support text if '');
  canReply true → form as today. Closed-ticket wording comes from
  lockReason itself ('This ticket is closed. Reopen it if you need more
  help.'), superseding the old hard-coded closed note.
- Delete endpoint verified routes/player.js:1067 `POST /support/:publicId/delete`
  (publicId = ticket.public_id, the id all player ticket routes use).
- **Confirm pattern (found):** the existing player-side close/reopen forms
  (support_view.ejs:32-42) POST DIRECTLY — no `data-confirm`, no dialog
  (data-confirm exists in app.js (f) but the support actions do not use
  it; backend adj-backend.md U-25 likewise: "Same POST + flash/redirect
  pattern as close/reopen — no new confirm pattern"). FIX follows it:
  Delete is a plain POST form, no confirm.
- **Naming correction (evidence):** the assignment pairs Delete with
  "tickets.ejs", but views/tickets.ejs is the LOTTERY ticket list
  (GET /tickets; rows carry pops/wager/draw fields, tickets.ejs:8-21) —
  a /support/…/delete form there could only ever answer "Ticket not
  found." The player's SUPPORT ticket list is views/support.ejs
  (`stickets`, support.ejs:7-18). Delete is therefore added to
  support.ejs (the own-ticket list) + support_view.ejs (detail), and
  tickets.ejs is left functionally untouched (U-01 sweep conversion only).

## U-02 (display side) — NOT PRESENT in the owned money views

- routes/player.js:362 (deposit) and :443 (withdraw): rejections now
  `setFlash('error', …)` + redirect back to the form (`backToForm`);
  layout.ejs:93-96 renders that flash above the form.
- deposit_new.ejs / withdraw_new.ejs / wallet.ejs contain NO local error
  block, no `formError` reference and nothing that assumed the old bare
  error page (grep: no matches). Nothing to remove — adjudicated, not assumed.
