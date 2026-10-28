# DEEP SCAN — AREA D: TRUST (BP-25) / DESIGN / CLIENT AUTHORITY (BP-26.2)
Codebase `~/workspace/cash-pop-fix/` — read-only, no files edited.

## 1. TRUST / GENUINENESS

**[D-01] GALTI — Footer support address is on a domain the operator does not own, and it is not a mailto**
- Seed (only production source): `lib/migrations.js:112` — `footer_contact: ['Footer contact', '<p>Support: support@cashpop.live</p>']`
- Migrations actively *install* it over the old placeholder, in both tables, all 3 dialects: `lib/migrations.js:655,658,661` (`settings`) and `:667,670,673` (`content_blocks`).
- Rendered verbatim in every footer: `views/layout.ejs:120` — `<div class="foot-col"><%- content('footer_contact') %></div>`, where `content()` reads `content_blocks` (`server.js:229` — `content: (k) => blockMap[k] || ''`).
- **Not setting-driven for display:** it is a CMS content block, editable only via Admin → Pages & Content (`routes/admin.js:2439-2450`, content-block update), not via Settings. There is no separate support-email setting used for it (`support_notify_email: ''`, `lib/migrations.js:18`, is only an internal notification address).
- **What breaks:** the address is plain text, not `mailto:` — a user must copy it into their mail client. Mail to an unowned domain will bounce, or — worse — be deliverable to whoever controls/registers `cashpop.live`, leaking account/payment details a distressed user sends there. Every other in-app channel is login-gated (`routes/player.js:810` `router.get('/support', requireLogin…)`), so a logged-out user who cannot sign in is funnelled to exactly this dead address. The working alternative (`/contact` form → `contact_messages` DB inbox, `routes/site.js:133-149`) is not mentioned in the footer block.

**[D-02] GALTI — "Licensed" claimed on the login page; no licence exists anywhere in the repo**
- `views/login.ejs:122` — `<div class="login-trust">🔒 Secure &amp; Licensed · 18+ only · Play responsibly</div>`
- A repo-wide grep for `Licensed|licensed|license` returns only this line and `lib/migrations.js:1086` — the heal marker `footer_about: 'Licensed lottery operator'`, i.e. the codebase itself treats a licensed-operator claim as a *false claim to be healed* (R-102 heal, `lib/migrations.js:1079-1092`). The heal covers CMS blocks only; the hardcoded login claim survived, with no licence number, issuer or jurisdiction anywhere in views/routes/lib.

**[D-03] GALTI — Unqualified "instant / paid instantly" for lottery winnings conflates wallet credit with payout**
- `views/index.ejs:25` "winnings credited instantly"; `:68` "Instant Win Credits — Winnings land in your wallet at once"; `:141` "Real players, real payouts — paid instantly."; `lib/migrations.js:108` (how_it_works) "you win that pop's prize instantly".
- Code reality: a win is credited only inside draw settlement, which runs only at/after close or on threshold (`lib/draws.js:125,152,168` `settleDueDraws/settleDraw`; credit at `:350-355`). Getting money *out* is a separate, by-default manual process (`withdrawal_mode: 'manual'`, `lib/migrations.js` DEFAULT_SETTINGS; deposits likewise — `routes/player.js:328-331` comment + flash "Deposit request submitted. It will be credited after review.").
- The accurate formulation already exists and proves the homepage versions are overclaims: `lib/migrations.js:114` (FAQ) "Winnings are credited to your wallet instantly **after the draw settles**."

**[D-04] GALTI — Every winner is labelled "✓ Verified" with no verification step or artefact**
- `views/index.ejs:74-78` — ticker headed "Recent verified winners", each row `<span class="verified-badge">✓ Verified</span>`; rebuilt identically in `public/app.js:195`.
- Source is just real transaction rows (`routes/site.js:17-33`, `/api/stats`: `WHERE t.type IN ('win','scratch_prize')`) — no verification status, draw/ticket link or proof is selected or shown, and only a first name is displayed, so a visitor cannot verify anything. Unlike draws (which link to `/fairness`), "Verified" here is a hard-coded badge on every row.

**[D-05] GALTI — Legal/about/testimonial seed content is stub or placeholder text, served publicly**
- Terms (the page the register checkbox links to): `lib/migrations.js:121` — body is literally `'<p>Terms of service. 18+ only. Play responsibly.</p>'` — one sentence; no operator identity, eligibility, prize, withdrawal, complaints or responsible-play terms. (Privacy, by contrast, was expanded and its placeholder healed, DS-039.)
- About page: `lib/migrations.js:113` — `about: ['About us', '<p>We run transparent, provably-fair lottery draws...</p>']` — the entire About Us page (via the `{{content:about}}` CMS page) ends in an ellipsis.
- Homepage testimonials: `lib/migrations.js:110` — `'<p>Player testimonials will appear here as players share them.</p>'`, rendered unconditionally if the block exists by `views/index.ejs` (final section, `content('testimonials')`). A "will appear here" placeholder on the live homepage reads as an unfinished/fake site.

**[D-06] GALTI — Outgoing mail falls back to a `no-reply@example.com` sender**
- `lib/notify.js:57` — `from: process.env.SMTP_FROM || 'no-reply@example.com'`, and `.env.example:58` ships `SMTP_FROM=` blank. If an operator configures SMTP host/credentials but not `SMTP_FROM`, every OTP, password-reset and win email is sent from an `example.com` address the operator does not own — reply-impossible and a classic scam-mail signal (also an SPF/DKIM mismatch risk).

**[D-07] GALTI — No page-level 18+/responsible-play signal on money pages; main register path has no 18+ attestation; lottery limits are hidden under Scratch**
- Grep for `18|responsib` in `views/play.ejs`, `wallet.ejs`, `deposit_new.ejs`, `withdraw_new.ejs`, `scratch_detail.ejs`, `scratch_ticket.ejs`: **NONE**. The only signals are global: `views/layout.ejs:125` footer "18+ only · Play responsibly" and the footer_about block.
- Register: `views/register.ejs:58` checkbox is only "I agree to the Terms and Privacy Policy" (and those Terms are the D-05 one-sentence stub), with no DOB field anywhere in `views/register.ejs`/`routes/auth.js`. The OTP-completion path *does* attest age — `views/login.ejs:112` "I confirm I am 18 or older" — so the main form is the inconsistent, weaker path.
- The working limits tool (loss/deposit/session/cooling-off/self-exclusion, `views/scratch_responsible.ejs`) is linked only from `views/scratch_lobby.ejs:4` ("Play Limits" under Scratch). No link from `/play`, `/wallet`, deposit or withdraw, although the limits enforce on lottery buys too (`routes/player.js:71-82`).

**[D-08] KAMZORI — Brand name drifts; renaming the site in Settings only half-renames it**
- Canonical setting: `lib/migrations.js:17` `site_name: 'Cash Pop Lottery'`; fallbacks disagree: `server.js:233` and `lib/notify.js:20` both `getS(…, 'site_name', 'Cash Pop')`. Hardcoded old name survives a rename in `routes/site.js:57` "Play Cash Pop lottery…", `:86` "Latest Cash Pop draw results", `:134` "Cash Pop team", `views/layout.ejs:74` "My Cash Pop Tickets", `views/maintenance.ejs:5` "Cash Pop is under scheduled maintenance", `views/setup.ejs:7` default value "Cash Pop Lottery".

**[D-09] KAMZORI — "Today's lucky number" is a calendar formula presented as a luck signal**
- `views/index.ejs:39-43` — `const lucky = (new Date().getDate() * 7 + new Date().getMonth() * 3) % 15 + 1;` … that ball is pre-highlighted `sel` and captioned "Today's lucky number is **<%= lucky %>** — pick your pops." No basis or "just for fun" disclaimer; it implies a predictive/hot-number signal that does not exist.

## 2. DESIGN CONSISTENCY (vs the project's Apple model)

**[D-10] KAMZORI — `--fs-md` is used but never defined; those font-sizes silently drop**
- Uses: `public/style.css:322` (`.pstep-banner`), `:331` (`.pstep-num`), `:356` (`.circle-ball`), `:452` (`.cr-name` wallet currency name). No `--fs-md` exists in any `:root` (definitions at `:36-42`, `:642-669`, `:859-869`, `:1099-1104` define `--fs-xs/sm/base/lg/xl` only), so each declaration is invalid at computed-value time and the element inherits an unrelated size.

**[D-11] KAMZORI — Four stacked theme layers redefine the same tokens/buttons; consistency is cascade-accident, not token discipline**
- `:root` blocks at `public/style.css:6`, `:642` (Apple system), `:859` (Apple vars), `:1099` (premium layer); e.g. `--r-sm: 8px` (`:57`) is later redefined to `10px` (`:660`), spacing/shadows are redefined at `:657-669`, `body` font-size is set to `16px` via `--fs-base` (`:84`) then directly to `17px` (typography layer, ~`:698`), and `.btn` is fully defined three times (`:135`, `:762`, ~`:919`). Any new page inherits whichever layer happens to win.

**[D-12] KAMZORI — v19 Security page: two cards escape the page container; password labels unassociated**
- `views/security.ejs:72` closes the `<section class="wrap section narrow">`, then `:75` and `:92` emit bare `<div class="card" style="margin-top:16px">` (password change; sessions) with no `.wrap` — full-viewport-width cards under a narrow form-card, with inline styles. Inside the first, `views/security.ejs:80-81` — `<label>Current password</label><input type="password" name="current_password">` with no `for`/`id` pairing (the 2FA fields above them do pair correctly).

**[D-13] KAMZORI — Admin-wide: labels are visual only, and filter bars use placeholder-as-label**
- `lib/admin-ui.js:35` — `fieldHtml` emits `<div class="field"><label>${esc(f.label)}…</label>${input}</div>` where the generated input has a `name` but never an `id`, and the label never a `for` — this affects every `ui.formHtml` form, including the v19 KYC/planner/simulator forms. Hand-written admin KYC reject field is the same: `routes/admin.js:1934` `<label>Rejection reason…</label><textarea name="reason"…>` (no `id`).
- `lib/admin-ui.js:56-58` — `filtersHtml` renders bare inputs with `placeholder="${esc(f.label)}"` and no label at all, directly violating the project's own stated rule in `public/style.css` (~`:954`) "persistent labels above fields, not just placeholders". Public v19 pages (`views/kyc.ejs`, contact, profile fields) do pair `for`/`id` correctly — the inconsistency is admin-side.

**[D-14] KAMZORI — Sub-48px touch targets outside the `.btn` system**
- `.btn` itself is saved by `public/style.css:762-763` `.btn, button, .button { min-height: 48px; … }` (so `btn-sm` is *not* a finding). Non-`.btn` controls are not: header currency pill `public/style.css:1563-1567` `.cur-pill { height: 40px; … }`; scratch tab links `:1533` `.ticket-tabs a{padding:10px 14px;…}` (~41px); admin tabs `:1491` `.tab { padding: var(--sp-2) var(--sp-4); … }` (8px vertical); pagination `:538` `.pagination a … { padding: var(--sp-2) var(--sp-4); … }`.

**[D-15] KAMZORI — "One prominent primary per view" is routinely violated**
- `views/profile.ejs`: `:26` Save Changes `btn-p btn-lg btn-block`, `:32` "Send verification link" `btn-sm btn-p`, `:34` "Send code" `btn-sm btn-p`, `:39` "Confirm phone" `btn-p`, `:61` "Save notification preferences" `btn-p` — up to five gold primaries on one view (several are primary-*sized* actions inside what reads as one card).
- `views/index.ejs`: `btn-p` at `:27, :44, :60, :96, :162`. Admin KYC decision: `routes/admin.js:1928-1937` "Approve document" `btn-p` + "Reject document" `btn-d` in one card, plus (for PDFs) a third prominent "Open document" `btn-p` at `:1938` in the adjacent card.

**[D-16] KAMZORI — Scratch CSS is a dark-theme leftover on light cards: metric tiles and the unfilled progress track are effectively invisible**
- `public/style.css:1527` — `.scratch-metrics>div{…background:rgba(255,255,255,.055)}` sits inside `.scratch-card` whose background is `var(--card-dark)` = `#ffffff` (`:10`): white-on-white tiles.
- `:1546` — `.progress-track{…background:rgba(255,255,255,.1)}` sits in `.scratch-play` (also white) on `views/scratch_ticket.ejs` — the unfilled 90% of the "scratched %" track is invisible; only the gold fill and the numeric % convey progress. (The dark `.scratch-area`/`.scratch-result` panels themselves are intentional and legible.)

**[D-17] GALTI — /play wallet-currency picker is an inline handler that the site's own CSP blocks**
- `views/play.ejs:15` — `<select name="currency" id="playCurrency" onchange="window.location='/play?currency='+…">` — the only inline event handler in any view. `server.js:307-331` sets `script-src 'self' 'nonce-…'` with no `'unsafe-inline'`, and its own comment (`:307`) says "Inline event handlers were moved into public/app.js" — but `public/app.js` contains no `#playCurrency` handler. In a CSP-enforcing browser, changing the wallet currency on the money page silently does nothing.

**[D-18] KAMZORI — Multiplier simulator inverts button hierarchy**
- `routes/admin.js:2824` — on the BP-23 simulator results page the sole `btn-p` (prominent) button is "Back to settings"; the actual consequential action is demoted to prose: "To apply the simulated values, enter them in the prize table and use Save prize table." (The planner preview in `routes/scratch.js`, by contrast, is correct: one `btn-p` "Create draft series with this plan" + plain Cancel, and its fields come from `ui.formHtml`.)

**[D-19] KAMZORI — Small grey caption text kept at a contrast the file itself already flagged as failing**
- `public/style.css:646` `--sys-label2: #86868b`, used at `12-13px` by `:713` `.text-footnote` and `:714` `.text-caption` (and the 13px `.share-v`/`.daybar-d` admin stats). The same file records this exact colour as `3.62:1` when fixing admin table headers to `#5f6368` (`:1014`, "DS-063: was #86868b (3.62:1)") — the fix was applied there but not to these caption classes.

## 3. CLIENT AUTHORITY (BP-26.2) — full inventory of `public/app.js` + inline view scripts

No client computation of a money amount or game result is trusted by the server. **Zero GALTI in this section.**

**[D-20] OK — Playslip total & prize preview (display only; server re-derives)**
- Client: `public/app.js:54-80` `recalc()` — `total = pops * wager * draws * (BOTH?2:1)`, bundle discount from `data-discounts`, and `prizePreview = wager * multFor(pops)` from the `#prizeData` JSON island (`views/play.ejs:7`). The form submits only `pops/wager/draw_type/num_draws/currency` — there is no total/prize field to forge.
- Server: `routes/player.js:54,60-67,93-113` `POST /play/buy` re-parses and validates pops (1–15, deduped), wager against server `wagerOptions`, draw type/draws, then recomputes `let total = pops.length * wager * drawIds.length;` plus the bundle discount keyed on `numDraws`, and debits exactly that in the ledger transaction.

**[D-21] OK — Quick Pick is user input, not a result**
- `public/app.js:82-90` `pickRandom()` uses `Math.random()` only to *check boxes* — equivalent to the user tapping numbers. Server re-validates the submitted set as in D-20.

**[D-22] OK — Hero count-ups & live stats (animation of server values only)**
- `public/app.js:126-145` animates 0 → `data-count` over ~1.4s and pins at the exact value; `:169-213` polls `/api/stats` every 30s and tweens only to newly returned values, rebuilding the winners ticker only on real change (with name escaping, `:193-196`). Source is real DB aggregates: `routes/site.js:17-33` and the homepage handler ("ALWAYS real DB counts… 'marketing' mode… is removed"). No action reads these numbers.

**[D-23] OK — Countdowns (client clock affects display only; server enforces close)**
- `public/app.js:216-242` computes `data-close-at − Date.now()`, shows "Closing…", disables the buy form and reloads after 30s. Server re-enforcement: `routes/player.js` buy transaction re-checks each draw's `status` and `close_at` inside the transaction (R-072) and fails the purchase if closed — a skewed/forged client clock buys nothing.

**[D-24] OK — Deposit/withdraw charge preview (server recomputes from the DB method row)**
- Client: `public/app.js:284-308` — `charge = Math.min(v, fixed + Math.round(v * pct / 100))` from `data-fixed/data-percent` attributes (`views/deposit_new.ejs:32-33`, `views/withdraw_new.ejs:25-26`).
- Server: `lib/money.js:98-103` `chargeFor()` is the same formula applied to the method row loaded server-side, invoked in `createDeposit` (`lib/money.js:120`) and `createWithdrawal` (`:194`); the amount itself is re-parsed with `toMinor(..., decimalsFor(...))` in `routes/player.js` deposit/withdraw POST handlers. The preview is never submitted.

**[D-25] KAMZORI — Charge preview and min/max attributes hard-assume 2 decimal places**
- `public/app.js` `fmtMoney()` always divides by 100, and `views/deposit_new.ejs:32` / `views/withdraw_new.ejs:25` render `min/max` as `method.min_amount / 100`, while the server uses the currency's real `decimalsFor()` (`routes/player.js`, `lib/money.js:98`). For a configured 0- or 3-decimal currency the *preview* (not the charge) would misstate amounts. All three seeded currencies (USD/EUR/INR) are 2-decimal, so this is latent, not live.

**[D-26] OK — Scratch reveal: the client decides *when*, never *what* (the specific question asked)**
- Foil: `public/app.js` scratch IIFE — canvas painted with a silver gradient, `destination-out` strokes erase it; `measure()` samples alpha bytes, updates `#scratchPct/#scratchBar`, and at `pct >= 60` calls `form.submit()` on `#revealForm`. That form (`views/scratch_ticket.ejs`) contains **only `_csrf`** — no prize, percentage or outcome is sent. The under-foil layer is server-rendered placeholders only (`?`, `WINDOW`, `YOUR PRIZE`), never the prize; the "Reveal without animation" submit button bypasses the 60% entirely, proving the threshold is purely cosmetic.
- The prize is never even sent to the browser before reveal: `routes/scratch.js:103` — `if (ticket.status !== 'revealed') { ticket.prize = null; ticket.nonce = null; ticket.ordinal = null; }`.
- Server: `POST /scratch/ticket/:publicId/reveal` (`routes/scratch.js`) → `lib/scratch.js:305-335` `revealTicket()` reads `locked_prize` from the `scratch_outcomes` row assigned at purchase, verifies `sha256(series_id|ordinal|nonce|prize)` against the commitment stored on the ticket at purchase (`:318-319`, mismatch = reveal refused), clamps `prize = Math.max(0, …)`, CAS-updates `purchased → revealed`, and credits via `postLedger(..., type:'scratch_prize', ...)`. Outcomes were predetermined and commitment-locked at series launch (`lib/scratch.js:158-167`).

**[D-27] OK — Remaining client logic computes nothing authoritative**
- Register phone assembly (`public/app.js`, §g): concatenates dial code + local number into the hidden `phone` field on submit — the server canonicalises with `normalizePhone` and duplicate-checks it (registration in `routes/auth.js`; same normaliser noted at `routes/player.js:600-615`).
- Login OTP (§g): client only UX-checks `code.length !== 6` and forwards identifier/code to `/login/otp/request` and `/login/otp/verify`; verification is entirely server-side in `routes/auth.js`.
- Canned-reply picker (BP-15, §g): copies a template body into the staff textarea; it sends nothing itself.
- Inline `<script>` in views: none besides nonce'd GA/Facebook/tawk snippets in `views/layout.ejs:13-25,139` and JSON data islands (`prizeData`, `cannedData`) — plus the one inline *handler* flagged as D-17. Server-template arithmetic in `views/scratch_lobby.ejs:10` (RTP) and `views/scratch_responsible.ejs` is executed server-side in EJS, not in the browser.

## Coverage statement
Read in full: `public/app.js`, `public/style.css` (1,693 lines), `lib/admin-ui.js`, `views/layout/index/play/login/register/profile/security/kyc/contact/scratch_*` and all other views via targeted greps, `lib/migrations.js` seeds + heal logic, `routes/site.js`, `routes/player.js` (buy/deposit/withdraw), `routes/scratch.js` (player + planner), `routes/admin.js` (KYC queue/detail, multiplier simulator), `lib/scratch.js` (launch/buy/reveal), `lib/money.js` (`chargeFor`/createDeposit/createWithdrawal), `lib/notify.js`, `server.js` (CSP, content helper, site-name fallback).
Cleared, not findings: `href="#"` occurs only on `#otpResend/#otpBack` (`views/login.ejs:100`), both with real JS handlers; no lorem/TODO/dummy copy in views; no dead social icons (Google/Facebook buttons render only when the setting *and* provider env vars are present, `routes/auth.js:109`); homepage counters are real DB values (fabricated "marketing" mode is removed in code, D-22); "Win up to 13X" (`home_banner`) matches the prize table's true maximum multiplier of 13; a working `/contact` page now exists (DS-029).
Limits: no live browser rendering was performed — contrast/target claims rest on the CSS values and the file's own recorded contrast measurements; domain non-ownership of `cashpop.live` is taken from the task brief (operator does not own it) and was not re-checked via RDAP; whether any given production DB still contains pre-heal CMS text depends on its migration state, which a read-only code audit cannot see.