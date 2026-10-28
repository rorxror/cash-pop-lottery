# DISPROVE Pass — Area E (Admin panel + design/contrast)

Date: 2026-10-28 · Role: adversarial DISPROVE agent — goal was to KILL each finding, not confirm it.
Baseline examined (read-only): `~/workspace/cash-pop-push/` (production v17.1, pre-fix).
Method per item: re-read the audit-E evidence, then hunted in the baseline for (a) a later
CSS cascade rule overriding the cited one, (b) an RBAC rule already restricting the route,
or (c) the control already existing elsewhere. Contrast ratios were recomputed from the
FINAL cascaded values (WCAG relative-luminance formula), including composite
(rgba-over-background) colours. Verified by content, not line numbers alone — all
line numbers below are baseline (`cash-pop-push`) lines.

**Tally: 19 items examined — 18 SURVIVES, 1 PARTIALLY DISPROVEN (DS-063: its table-header
half is killed by a specificity override; its KPI-label half survives). No item fully disproven.**

Scope note: the task set lists DS-059 as "admin-UI part". In COMPILED.md DS-059's source is
C-10 (not audit-E); only its admin-UI facet (no site-timezone setting in Settings) is judged here.

---

## DS-003 (E-01) — Admin table links white-on-white — **SURVIVES**

Kill attempt: searched for any later override of the cited rule. `grep` over the whole
stylesheet finds exactly ONE `.adm .tbl a` rule: `public/style.css:578`
`.adm .tbl a { color: var(--navy-800); font-weight: 600; }`, and `--navy-800: #ffffff`
(`style.css:9`). No `.adm a`, `.adm table a`, or rich-layer rule touches it; the global
`a { color: var(--gold-2) }` (`style.css:95`, specificity 0,0,1) loses to `.adm .tbl a`
(0,2,1). Backgrounds: admin cards are pinned white in the Apple layer
(`.adm .card { background:#fff }`, `style.css:1005-1006`); even rows use
`--row-alt-light` = rgba(26,33,64,0.03) over white ≈ #f8f8f9.
Recomputed: #ffffff on #ffffff = **1.00:1**; #ffffff on the alt-row composite = **1.06:1**.
Both far below 4.5:1. Plain (non-button) anchors inside `ui.table()` output exist and are
hit, e.g. the ticket public-ID link (`routes/admin.js:381`, `<a href="…/tickets/<id>">`)
and the fraud-flag user link (`routes/admin.js:2335`). Could not disprove.

## DS-011 (E-02) — Gateway credentials page readable by every staff role — **SURVIVES**

Kill attempt: looked for an RBAC carve-out for the credentials route. None exists.
`lib/rbac.js:48` — `if (method === 'GET') return true; // views are read-only for all staff`,
and `routes/admin.js:47` applies only that middleware. The handler
`routes/admin.js:1285` GET /methods/:id/credentials decrypts every stored row via
`decryptField` (`routes/admin.js:1292-1295`).
Partial mitigation found (does NOT kill the item): in the form mapping
(`routes/admin.js:1299-1302`), fields with `type === 'password'` are rendered with an
empty value, so `secret_key` / `webhook_secret` / `api_key`-type secrets do not leak.
But every `text`/`textarea` field is rendered with its decrypted saved value, and
`lib/rails.js` defines many sensitive ones as text: `wallet_address` (:13),
`publishable_key` (:22), `upi_id` (:30), `pix_key` (:37), `account_number`
("Account number / IBAN", :87), `merchant_id` (:61, :69, :77). A support/risk staffer
can read all of those. Finding survives as written (audit itself scoped it to
text/textarea fields).

## DS-012 (E-03) — Maker-checker deadlocks a solo operator, no warning — **SURVIVES**

Kill attempt: searched the risk-settings save and the threshold field for any
approver-count check or warning. `routes/admin.js:2008` — the field's only help text is
"Money actions at or above this amount need a second approver (see Approvals)."
`routes/admin.js:2098-2113` (POST /settings/risk) validates amounts and the payout lock
only; it never counts admins/approvers and never warns. The deadlock mechanism is intact:
`maybeMakerChecker` (`routes/admin.js:982`) queues at/above threshold;
`routes/admin.js:2224` (approve) and `:2276` (reject) both refuse the requester
("You cannot approve your own request…"); deposit/withdrawal detail pages hide their
action buttons while an approval is open (`routes/admin.js:938`, `:1060` pendAppr branch).
No escape hatch (no cancel/withdraw of one's own queued approval) exists anywhere.
Could not disprove.

## DS-030 (E-04) — Admin filter tabs 2.77:1; active tab inverted; count chip fails — **SURVIVES**

Kill attempt: `.tab` rules live at `style.css:1491-1494`, near the end of the sheet;
no later `.tab`/`.adm .tab` override exists in the remaining ~180 lines (scratch layer
only). Final cascaded values: `.tab { background: var(--white); color: var(--ink-soft) }`
= #5b657f on #17203a → recomputed **2.77:1 FAIL** (matches audit).
`.tab.active { background: var(--navy-800); color: var(--white) }` = #17203a on #ffffff
= 16.10:1 — legible, but the ACTIVE tab is the white pill while inactive tabs are dark
navy, i.e. the inverted-emphasis claim also holds.
Count chip in an active tab: `.tab.active .count { background: var(--gold-soft);
color: var(--gold-2) }` — gold-soft rgba(217,148,13,0.12) composited over the active
tab's white background = #faf2e2; #b87a00 on #faf2e2 = **3.24:1 FAIL** (audit said 3.07:1;
my recomputation differs slightly in the composite but the verdict is identical).
Tabs are used exactly as cited (moneyTabs `routes/admin.js:900-903`, users :464,
reports :1343, support :1446, notifications :1565, pages :1748). Could not disprove.

## DS-031 (E-05) — Plain `.btn` has transparent bg + border — **SURVIVES** (with a nuance)

Kill attempt: read every later `.btn` block — `style.css:762` (min-height/radius/font),
`:919` (radius/font/padding), `:1153` (position/overflow/transition). None of them sets
`background` or a visible `border-color`. The base rule stands as final:
`style.css:135-147` `.btn { … border: 1px solid transparent; }` with no background.
Only `.btn-p` (:1158 rich gradient), `.btn-d` (:153) and `.btn-g` (repaired at :1171
with a white gradient) carry fills. Plain-`btn` controls are everywhere
(31× `btn btn-sm` + 5× bare `btn` in `routes/admin.js`, e.g. Manage :472, Edit /
Credentials :1150-1151, Run now / Pause :1856-1857, Filter `lib/admin-ui.js`
filtersHtml button).
Nuance (narrows, does not kill): `<button class="btn">` elements keep the browser's UA
`buttonface` background because the sheet never resets `button` background — so button
elements show a faint native grey pill. But the many `<a class="btn">` controls
(Manage/Edit/Credentials/Review/Open/Detail…) have no fill and no border at all, and
inside `.tbl` they are additionally white-text per DS-003. The CSS claim as written is
exactly correct. Could not disprove.

## DS-032 (E-06) — Danger buttons/badges 4.28:1 — **SURVIVES**

Kill attempt: `grep` finds only two rules — `style.css:153`
`.btn-d { background: var(--danger); color: var(--white); }` and `style.css:171`
`.b-err { …same pair… }`. No later override (the rich-layer "contrast repairs" block,
`style.css:1110-1117`, fixes `.btn-p`/`.b-warn` to `--navy-ink` but never touches
`.btn-d`/`.b-err`). Final pair: `--white` = #17203a on `--danger` = #ef4444 →
recomputed **4.28:1**, below 4.5:1 for the 12px badge / 14-16px button text
(neither reaches WCAG "large" size). Could not disprove.

## DS-033 (E-07) — `.pos` 2.28:1 / `.neg` 3.76:1 — **SURVIVES**

Kill attempt: `.pos`/`.neg` are defined twice with identical values —
`style.css:416-417` and again `style.css:1510-1511` (the later one is the final
cascade, same colours): `.pos { color: var(--success) }` #22c55e, `.neg { color:
var(--danger) }` #ef4444, on white admin cards. Recomputed: **2.28:1** and **3.76:1**,
both FAIL. No `.adm .pos`/`.adm .neg` override exists. Used as cited: dashboard profit
(`routes/admin.js:172`) and transaction amounts (`routes/admin.js:551`, `:1407`), at
15px bold — still "normal" text under WCAG. Could not disprove.

## DS-034 (E-12) — Admin draw detail page is an orphan — **SURVIVES**

Kill attempt: grepped all of `routes/`, `lib/`, `views/` for any GET href to a draw
detail. The route exists (`routes/admin.js:304` GET /draws/:id, P&L KPIs + winners
table at :324), but the only `/draws/<id>…` URLs generated anywhere are the POST form
actions `/settle` and `/cancel` (`routes/admin.js:252`, `:260-261`). The draws-list ID
columns are plain text (`routes/admin.js:250`, `:258`, `:270`), the dashboard KPI links
only to `/draws` itself (:216), and no ticket/user page links to a draw detail either.
Zero inbound GET links — the page is reachable only by hand-typing the URL.
Could not disprove.

## DS-059 — admin-UI part (source C-10: draw schedule UTC-only, no site-timezone setting) — **SURVIVES**

Kill attempt: searched the entire baseline for a timezone control the operator could set.
`grep -rn "timezone"` over all `.js`/`.ejs` returns nothing (only the TZ country code in
`lib/phone-countries.js:48`). Settings expose only `day_draw_time` / `eve_draw_time`
(`routes/admin.js:1990-1991`), labelled just "Day draw time (HH:MM)" with no mention of
UTC, and the engine interprets them strictly as UTC: `lib/draws.js:35`
`chk.getUTCFullYear()…` and `closeAtFor` builds the close time with `Date.UTC(...)`
(`lib/draws.js:33`). So from the admin UI's perspective the operator sets what reads
as a local wall-clock time and silently gets UTC — no timezone setting exists anywhere
to change that. Could not disprove (admin-UI facet; the rest of DS-059 belongs to Area C).

## DS-062 (E-08) — `.b-info` / `.ball-sm` / global links gold-2 on white 3.61:1 — **SURVIVES**

Kill attempt: all three rules checked for later overrides — none.
`.b-info` (`style.css:173`): background `var(--navy-800)` = #ffffff, color
`var(--gold-2)` = #b87a00. `.ball-sm` (`style.css:1496`, final definition): same pair.
Global `a` (`style.css:95`): `color: var(--gold-2)`. Recomputed #b87a00 on #ffffff =
**3.61:1 FAIL** for all three (badge 12px bold, ball chip 14px/800, body links — none
is WCAG-large). Real usages confirmed: `b-info` backs the `scheduled`/`answered`
status badges and the `medium` priority badge (`lib/admin-ui.js:14`,
`routes/admin.js:1457`); `.ball-sm` renders winning numbers (`routes/admin.js:169`,
`:272`). Could not disprove.

## DS-063 (E-09) — Table headers + KPI labels #86868b 3.62:1 — **PARTIALLY DISPROVEN**

**Table-header half: DISPROVEN.** The audit cited only the late rule
`style.css:1014` `.adm table th { color: #86868b; … }` (specificity 0,1,2). It missed
the earlier rule `style.css:574` `.adm .tbl th { color: var(--ink-soft); }`
(specificity **0,2,1** — two classes beat one class + one extra element, so the
EARLIER rule wins despite the later one's position). Every admin table is produced by
`ui.table()` (`lib/admin-ui.js:23`), which always emits `<table class="tbl…">` — a
repo-wide grep finds no raw `<table>` in `routes/admin.js` or `routes/scratch.js`.
Effective header colour is therefore `--ink-soft` = #5b657f on the white card =
recomputed **5.81:1 PASS** (5.34:1 even against the #f5f5f7 page background).
Admin table headers do NOT fail.

**KPI-label half: SURVIVES.** `.adm .kpi .l` appears at `style.css:573`
(color: var(--ink-soft)) and again at `style.css:1025` (color: #86868b) with EQUAL
specificity (0,3,0), so the later rule wins: KPI labels really are #86868b on the
white KPI card (#fff, `style.css:1023`) = **3.62:1 FAIL**. The audit's two side
examples also survive: `.share-v` (`style.css:1034`) and `.daybar-d` (`style.css:1037`)
are plain 13px divs/spans with no competing colour rule, both #86868b = 3.62:1 FAIL.

Net: the item's headline claim about table headers is killed; its KPI-label (and
share/daybar) claim stands. The finding should be narrowed, not closed.

## DS-064 (E-10) — Sidebar active item 3.78:1 — **SURVIVES**

Kill attempt: recomputed with the FULL cascade instead of the audit's shortcut.
Final rules: sidebar background is the Apple layer's `rgba(255,255,255,0.8)`
(`style.css:979-984`) over `.adm-body` background `--sys-bg` #f5f5f7 (`style.css:642`,
`:978`) → composite ≈ #fdfdfd. Active item (`style.css:993`, same selector as the
earlier :559 rule so the later one wins): `background: rgba(0,113,227,0.1);
color: #0071e3` → tint composited over #fdfdfd = #e4effa. Recomputed
#0071e3 on #e4effa = **4.03:1** — higher than the audit's 3.78:1 (which tints directly
over #f5f5f7, giving #dce8f5 / 3.78:1), but still **below 4.5:1 FAIL** for 15px/600
text. The correction changes the number, not the verdict. Could not disprove.

## DS-065 (E-11) — `.btn-p` gradient dark end 3.60:1 — **SURVIVES**

Kill attempt: confirmed the rich layer is the final `.btn-p` definition
(`style.css:1158-1162`): `linear-gradient(135deg, #f7c948 0%, var(--gold) 48%,
var(--gold-deep) 100%)`, text colour pinned to `--navy-ink` #1b2340 by the contrast-
repair rule (`style.css:1110`). Recomputed per stop: on #f7c948 = **9.85:1 PASS**;
on `--gold` #d9940d = **6.02:1 PASS**; on `--gold-deep` #a86e00 = **3.60:1 FAIL**.
Button text spans the whole gradient, so the bottom-right portion of every primary
button sits below AA. No later `.btn-p` background exists. Could not disprove.

## DS-066 (E-13) — Deposits/Withdrawals lists lack player/method/date filters — **SURVIVES**

Kill attempt: looked for filter handling elsewhere in the two routes (e.g. a shared
`filtersHtml`). GET /deposits (`routes/admin.js:905`) reads only `req.query.status`
(plus `page`); its WHERE clause is built solely from status (:~923). GET /withdrawals
(`routes/admin.js:1030`) is identical. Neither route calls `ui.filtersHtml` — that
helper is used only by Tickets (:378), Users (:467) and Audit (:2471) — and Reports'
date+q form (:1345) is a different page, not a filter on these lists. No player-email
search, method filter, or date range exists on either money queue. Could not disprove.

## DS-067 (E-14) — Dead control: custom_captcha "Difficulty" field — **SURVIVES**

Kill attempt: repo-wide `grep -rn "difficulty"` returns exactly ONE hit —
the field definition itself, `lib/extensions.js:36`
`{ key: 'difficulty', label: 'Difficulty', type: 'select', options: ['easy','medium'] }`.
Nothing reads `config.difficulty`. Captcha generation (`routes/auth.js:25-30`,
`newCaptcha`) always picks both addends as `2 + Math.floor(Math.random()*7)` regardless
of any setting, and `captchaHtml` (`routes/auth.js:38-41`) checks only `extEnabled`.
Saving easy vs medium changes nothing. Could not disprove.

## DS-068 (E-15) — Three dead Settings toggles remain (kyc_required, email_verification, mobile_verification) — **SURVIVES**

Kill attempt: searched for any consumer of the three setting keys. Hits are only the
toggle definitions (`routes/admin.js:1947-1949`), the seed defaults
(`lib/migrations.js:35-37`), and unrelated `email_verifications`-TABLE code. No route,
policy, or middleware reads `getS(…, 'kyc_required' | 'email_verification' |
'mobile_verification')`. The toggles are indeed honestly labelled in the baseline —
each help text begins "INFORMATIONAL ONLY — enforces nothing…" and points at the real
"Verified contact gate" — exactly as the audit recorded (a disclosed residual, not a
deception). Dead switches remain in System Configuration. Could not disprove.

## DS-069 (E-16) — Approvals RBAC is money-only — **SURVIVES**

Kill attempt: re-read the full rule table. `lib/rbac.js:16` —
`['POST', /^\/approvals\/\d+\/(approve|reject)$/, MONEY]` where
`MONEY = ['super','finance']` (`lib/rbac.js:8`). That single rule gates EVERY approval
type, including `draw.settle` / `draw.cancel` (executed at `routes/admin.js:2248-2252`)
and `balance.adjust`. Draw actions themselves are queued by SAFETY
(`lib/rbac.js:24`, POST /draws/.+ → super+risk), so a risk staffer can create a
draw-settlement approval but can never second-approve one — not even in their own
domain — while finance approves risk-domain settlements. No per-action-type approval
rule exists anywhere else. Could not disprove.

## DS-070 (E-17) — sms_provider: comment vs code precedence; no admin UI — **SURVIVES**

Kill attempt: `lib/otp.js:50-52` — the comment claims "the sms_provider SETTING is the
source of truth; the env var only overrides it", and the code is
`process.env.SMS_PROVIDER || getS(settings || {}, 'sms_provider', '')` — i.e. whenever
`SMS_PROVIDER` is set in the environment, the setting (seeded as `textbelt`,
`lib/migrations.js:44`) is silently ignored; the "source of truth" is whichever source
wins the `||`, which is the env var. And the setting is not operator-editable:
`grep -rn "sms_provider" routes/ views/` returns zero hits — no Settings field exposes
it. Both halves (precedence contradicts the comment's claim; no admin UI) hold in the
baseline. Could not disprove.

## DS-071 (E-18) — Multiple gold `.btn-p` per queue page dilutes "one prominent button" — **SURVIVES**

Kill attempt: counted primary buttons per rendered queue page in the baseline.
Overdue-draws card: one `<button class="btn btn-sm btn-p">Draw Now</button>` PER
overdue row (`routes/admin.js:252`, inside the `overdue.map(...)` table builder) — N
overdue draws = N gold primaries on one screen. Approvals: one
`<button class="btn btn-sm btn-p">Approve</button>` per open approval row
(`routes/admin.js:2214`, inside the `row()` builder used for every open item).
No demotion of row-level actions to `.btn-g`/plain exists. The audit's counter-checks
also re-verify in the baseline: 48px min-height (`.btn, button` `style.css:762`) and
persistent field labels (`lib/admin-ui.js` fieldHtml) are present. Could not disprove.

---

## Recomputed contrast summary (final cascaded values, baseline)

| Pair | Ratio | AA 4.5:1 | Item |
|---|---|---|---|
| #ffffff on #ffffff (alt-row composite: 1.06) | 1.00 | FAIL | DS-003 |
| #5b657f on #17203a (inactive tab) | 2.77 | FAIL | DS-030 |
| #b87a00 on #faf2e2 (active-tab count, composite) | 3.24 | FAIL | DS-030 |
| #17203a on #ef4444 (danger btn/badge) | 4.28 | FAIL | DS-032 |
| #22c55e on #ffffff (.pos) | 2.28 | FAIL | DS-033 |
| #ef4444 on #ffffff (.neg) | 3.76 | FAIL | DS-033 |
| #b87a00 on #ffffff (.b-info/.ball-sm/global a) | 3.61 | FAIL | DS-062 |
| #5b657f on #ffffff (.adm .tbl th — effective) | 5.81 | **PASS** | DS-063 (header half DISPROVEN) |
| #86868b on #ffffff (.adm .kpi .l, .share-v, .daybar-d) | 3.62 | FAIL | DS-063 (KPI half survives) |
| #0071e3 on #e4effa (sidebar active, full composite) | 4.03 | FAIL | DS-064 |
| #1b2340 on #a86e00 (.btn-p gradient deep stop) | 3.60 | FAIL | DS-065 |
