# AREA C — Admin Console Inside-Pages + Dead-Switch Hunt (READ-ONLY, no files edited)

Abbreviations for "saved at": **TOG** = form `routes/admin.js:2553-2576`, POST `routes/admin.js:2645-2662` (loop `setSetting(k, req.body[k]?'1':'0')`). **ECO** = form `2593-2606`, POST `2667-2710`. **RISK** = form `2612-2619`, POST `2713-2757`. **AUTO-D** = `583-599`, **AUTO-S** = `601-629`, both in `routes/admin.js`.

## DEAD-SWITCH TABLE

| Setting key | Saved at | Read at |
|---|---|---|
| registration_enabled | TOG | `routes/auth.js:272,309,473,511,634,700` |
| force_ssl | TOG | `routes/auth.js:19,227,256,544`; `routes/admin.js:1106` |
| policy_agreement | TOG | `routes/auth.js:339` |
| secure_password | TOG | `routes/auth.js:332,409`; `routes/player.js:688,733`; `routes/agent.js:93`; `routes/admin.js:1183,3075` |
| notifications_enabled | TOG | `lib/notify.js:22,81,99` |
| otp_registration | TOG | `routes/auth.js:281,304,350` |
| google_oauth_enabled | TOG | `routes/auth.js:108,131,283,306,668`; `server.js:239` |
| deposits_enabled | TOG | `lib/money.js:83` |
| withdrawals_enabled | TOG | `lib/money.js:91,482` |
| cookie_consent_enabled | TOG | `views/layout.ejs:130` (`S('cookie_consent_enabled')==='1'`) |
| phone_otp_enabled | TOG | `routes/auth.js:113,133,466` |
| email_otp_enabled | TOG | `routes/auth.js:114,134,468` |
| withdrawal_otp_enabled | TOG | `routes/player.js:403` |
| maintenance_mode | TOG | `server.js:354` (`req.settings.maintenance_mode==='1'`) |
| referral_enabled | TOG | `routes/player.js:160`; `lib/scratch.js:288` |
| facebook_oauth_enabled | TOG | `routes/auth.js:109,132,284,307,602` |
| password_login_enabled | TOG | `routes/auth.js:115-117,135-137,197` |
| verified_contact_required | TOG | `lib/money.js:73` |
| admin_totp_required | TOG | `routes/admin.js:3080,3103,3140` |
| beacon_enabled | TOG | `lib/draws.js:261,297`; display `routes/admin.js:482` |
| beacon_required | TOG | `lib/draws.js:298` |
| withdrawal_same_method | TOG | `lib/money.js:332`; `routes/player.js:348` |
| breached_password_check | TOG | `routes/auth.js:334,412`; `routes/player.js:692,735`; `routes/admin.js:1185,3077`; `routes/agent.js:97` |
| csp_enabled | TOG | `server.js:315` |
| wager_options | ECO; **also AUTO-D** | `server.js:185` (`parseAmountList(getS(...'wager_options'...))`) |
| max_pops | ECO | `routes/player.js:56` |
| max_draws | ECO | `routes/player.js:49,57` |
| day_draw_time / eve_draw_time | ECO | `lib/draws.js:67,68` |
| commission_rate | ECO | `routes/player.js:174` |
| referral_rate | ECO | `routes/player.js:161`; `lib/scratch.js:289` |
| deposit_bonus_percent | ECO | `lib/money.js:161` |
| multi_draw_discounts | ECO | `routes/player.js:99` |
| upcoming_draw_days | ECO | `lib/draws.js:62` |
| deposit_mode / withdrawal_mode | ECO (forced `'manual'`); per-user at `routes/admin.js:1069-1085` | `lib/money.js:86,94` — read into `policy.mode`, but **no caller ever reads `.mode`** → see [C-07] |
| withdrawal_turnover_required | RISK | `lib/money.js:283` |
| withdrawal_daily_cap / withdrawal_monthly_cap | RISK | `lib/money.js:298,303` |
| payout_lock_hours | RISK | `lib/money.js:308` |
| maker_checker_threshold | RISK | `routes/admin.js:1374` (`maybeMakerChecker`) |
| referral_cap_per_referee | RISK | `lib/money.js:414` |
| auto_withdrawal_limit (BP-22) | RISK; per-user `routes/admin.js:903-945` | `lib/money.js:465-467` (`autoWithdrawalLimitMinor`) |
| kyc_enabled (BP-21) | `routes/admin.js:2759-2774` | `lib/kyc.js:35` |
| kyc_gate (BP-21) | `routes/admin.js:2759-2774` | `lib/kyc.js:25` |
| blocked_phone_countries | `routes/admin.js:2776-2785` | `lib/phone-countries.js:79` |
| currencies / base_currency | `routes/admin.js:2852-2886` | `lib/settings.js:46` (`getCurrencies`); base used throughout, e.g. `routes/admin.js:180-184` |
| site_name | `routes/admin.js:2888-2903` | `server.js:233`; `lib/notify.js:20` |
| cookie_text | `routes/admin.js:2888-2903` | `views/layout.ejs:132` |
| custom_css | `routes/admin.js:2888-2903` | `views/layout.ejs:11` |
| **language** | `routes/admin.js:2888-2903` (form `2638`, only option `['en']`) | **NEVER READ** → [C-01] |
| site_timezone | `routes/admin.js:2888-2903` | `lib/draws.js:72`; `routes/admin.js:321` |
| support_notify_email | `routes/admin.js:2888-2903` | `routes/player.js:827,850` |
| sms_provider | `routes/admin.js:2888-2903` | `lib/otp.js:60` — OTP path only; notification SMS ignores it → [C-10] |
| automation_master_enabled | `routes/admin.js:575-581` | `lib/cron.js:140`; `lib/draws.js:65,126,181`; `lib/scratch.js:349`; `lib/bonus.js:61` |
| auto_draw_day / auto_draw_eve | AUTO-D | `lib/draws.js:66` |
| draw_trigger_mode_day/eve | AUTO-D | `lib/draws.js:146,186` (dynamic `'draw_trigger_mode_'+k`) |
| draw_threshold_day/eve | AUTO-D | `lib/draws.js:147,188` (dynamic) |
| draw_unmet_day/eve | AUTO-D | `lib/draws.js:160` (dynamic) |
| scratch_auto_next_enabled | AUTO-S | `lib/scratch.js:423` (also written by guardrail `lib/scratch.js:417`) |
| scratch_template_series_id | AUTO-S | `lib/scratch.js:424` |
| scratch_planner_target_rtp (BP-23) | AUTO-S | `lib/scratch.js:451`; default in planner form `routes/scratch.js:231` |
| scratch_smart_pool_enabled (BP-23) | AUTO-S | `lib/scratch.js:443` |
| scratch_guardrail_enabled (BP-23) | AUTO-S | `lib/scratch.js:397`; `lib/prize-engine.js:104` |
| scratch_liability_cap_pct (BP-23) | AUTO-S | `lib/prize-engine.js:105` |
| scratch_alert_threshold_pct (BP-23) | AUTO-S | `lib/scratch.js:398`; display `routes/admin.js` automation alerts block |
| scratch_guardrail_action (BP-23) | AUTO-S | `lib/scratch.js:399` |
| draw_liability_alert (BP-23) | AUTO-S | `lib/cron.js:22`; display `routes/admin.js:269` + automation alerts block |
| bonus_enabled | `routes/admin.js:693-698` | `lib/bonus.js:60` |
| Extension toggles + config (recaptcha/hcaptcha/turnstile/custom_captcha/GA/tawkto/fb_comments) | `routes/admin.js:2095-2123` | `routes/auth.js:39-53,77-84`; `server.js:213` (`extOn/extCfg`); `views/layout.ejs:12,23,138`; `views/cms.ejs:5` — all wired |
| Cron job status/interval (`cron_jobs` rows) | `routes/admin.js:2473-2500`, `631-646` | `lib/cron.js:140-165` (`tick`) |
| Notif template `enabled` | `routes/admin.js:2343-2354` | `lib/notify.js:25` (`enabled && t && t.enabled`) |
| Announcement `active` | `routes/admin.js:2281-2301` | player `/announcements` path via `active` flag (create/delete audited; toggle is not → [C-05]) |

Legacy seeded keys with **no admin form and no reader** (not counted as dead switches — no UI promises them): `kyc_required`, `email_verification`, `mobile_verification`, `auto_approve_deposit_limit` in `lib/migrations.js:44-72` (the last is self-documented: *"legacy row, read by nothing (R-044…)"*). `blocked_rails` has no UI but **is** read: `routes/admin.js:1627,1661`.

**No other settings-page or automation key is saved-but-unread.** Every BP-21/BP-22/BP-23 v19 key is wired.

## FINDINGS

**[C-01] GALTI — `language` is a dead switch.** Form: `routes/admin.js:2638` `{ key: 'language', … type: 'select', options: ['en'], help: 'More languages can be added on request.' }`; saved by the appearance handler (`2888-2903`). Full-tree grep for `'language'` outside `routes/admin.js`/`lib/migrations.js` returns nothing — no view, no `server.js` locals, `views/layout.ejs` hardcodes `<html lang="en">` (via `lib/admin-ui.js` player layout equivalent). Selecting/saving it changes nothing, and with a single option it cannot even be changed.

**[C-02] GALTI — Dashboard "RTP (settled draws only)" and Draw-detail "Sold amount" understate stake by the pops count.** `routes/admin.js:205`: `SELECT COALESCE(SUM(t.wager),0) AS staked, COALESCE(SUM(te.win_amount),0) AS paid FROM ticket_entries te JOIN tickets t …` and `routes/admin.js:333` (draw detail): `SELECT COALESCE(SUM(t.wager),0) AS s … WHERE te.draw_id = ?`, rendered as "Sold amount" at `343`. `wager` is per-pop (ticket form label "Wager per pop", `routes/admin.js:418ff` ticket detail); true stake per entry is `wager × pops.length` — which the dashboard's own exposure table does correctly at `routes/admin.js:165-176` (`staked += pops.length * e.wager`). So a 5-pop ticket counts 1/5 of its stake: draw-detail profit is overstated and settled RTP is inflated ~×(avg pops). Internal contradiction between two blocks on the same dashboard.

**[C-03] GALTI (UI text) — Withdrawal button "Approve & pay" does not pay.** `routes/admin.js:1480`: `<button class="btn btn-p">Approve & pay</button>`. The handler chain (`decideWd`, `1524ff`) calls `decideWithdrawal`, whose approve branch only does `UPDATE withdrawals SET status='approved'…` (`lib/money.js:231-241`, comment: *"the user is paid only the net outside the app. NOTHING is posted back here"*). Payment requires the separate Mark-as-paid step with provider ID (shown only in `approved` state, `routes/admin.js:1483`). The label contradicts the BP-22 help text on the same console: *"Auto-approval NEVER pays out by itself"* (`routes/admin.js:2617`).

**[C-04] GALTI — "Settle now" is offered on every upcoming draw, but the engine refuses all not-yet-closed draws.** List renders the button unconditionally: `routes/admin.js:284-285` (`/draws/:id/settle` + `/cancel` for every `upcoming` row). Engine: `lib/draws.js:282` `if (!draw.is_test && !threshold && draw.close_at > now()) throw new Error('Draw has not closed yet')`. For any future DAY/EVE draw the button is a guaranteed "Settle failed: Draw has not closed yet" flash. Only the separate overdue card (`routes/admin.js:264`, "Draw Now") is honest. (Cancel & refund on the same row does work.)

**[C-05] GALTI/KAMZORI — Audit-log gaps on state-changing POSTs.**
- GALTI (money): `POST /cron/:id/run` (`routes/admin.js:2485-2491`) and `POST /automation/job/:id/run` (`639-646`) contain no `audit.log` call — they just call `runNow`. Run via either button, the `settle_agent_commissions` job (`lib/cron.js` handlers) credits agent wallets through `settleAgentCommissions` (`lib/money.js:379-399`), which itself writes **no** audit row (only ledger meta `admin_id: adminId`, null from cron). The equivalent admin button path *does* audit: `routes/admin.js:1233` `action: 'agent.commissions_settled'`. So the same money movement is auditable from Agents but invisible in Audit Trail from Cron/Automation "Run now". (Draw settles and bonus grants reached the same way are audited inside `lib/draws.js:377` / `lib/bonus.js:99` — commissions are the hole.)
- KAMZORI: `POST /notifications/announcements/:id/toggle` (`routes/admin.js:2290-2295`) flips public announcement visibility with no `audit.log`, while create (`2281`) and delete (`2296`) both log. `POST /contact-messages/:id/handled` (`2311-2315`) likewise logs nothing.

**[C-06] GALTI — Biodata `kyc_status` dropdown bypasses the KYC attestation rule.** User page biodata form includes `{ key: 'kyc_status', label: 'KYC', type: 'select', options: ['none','pending','verified','rejected'] }` (`routes/admin.js:834`), and `POST /users/:id` writes it directly (`930-945`: `UPDATE users SET … kyc_status = ? …`). The dedicated manual-verify path on the same page requires a note and attests in the audit log: `routes/admin.js:977-986` *"A note is required for manual verification… `action: 'kyc.manual_verify'`"*, with form help *"Attestation note (required — recorded in the audit log)"* (`883-889`). An admin can set a player to `verified` via Save biodata with no note and no document — the `user.update` audit row records old/new status but no attestation. The two controls on one page enforce different rules for the same state.

**[C-07] KAMZORI — `deposit_mode`/`withdrawal_mode` remain decorative selects (global + per-user).** Global form offers only `options: ['manual']` (`routes/admin.js:2599-2600`); per-user matrix offers only `['', 'manual']` (`865-866`). They are read — `lib/money.js:86` `const mode = user.deposit_mode || getS(settings, 'deposit_mode', 'manual'); return { allowed: true, mode }` — but every caller uses only `policy.allowed`/`policy.reason` (`routes/player.js:271,291,337,364,487`); `.mode` is never read anywhere. Blank↔manual changes no behaviour. Help text is honest ("always manually reviewed"), so this is a no-op control, not a false promise — but it is exactly the R-044 pattern surviving in reduced form.

**[C-08] KAMZORI — Two writers for `wager_options` with opposite validation.** Economy POST validates and rejects the whole save on a bad list (`routes/admin.js:2683-2684`, `2705`). Automation POST accepts anything: `routes/admin.js:594` `wager_options: String(req.body.wager_options || '1,2,5,10').slice(0, 100)`. At read time `lib/util.js:167-169` `parseAmountList` silently drops non-positive/garbage entries and falls back to `[100,200,500,1000]` when empty — so a typo saved via Automation silently yields a different playslip than the admin typed, with a "Draw automation saved." success flash.

**[C-09] GALTI (edge) — Threshold `0` + trigger mode `threshold` creates a draw that can never settle.** Automation validation allows 0: `routes/admin.js:587` `const num = (v, dflt) => { const n = parseInt(v, 10); return Number.isInteger(n) && n >= 0 ? String(n) : dflt; }`. Engine: `lib/draws.js:147-160` — settle requires `sold >= threshold && threshold > 0`; with 0, mode `threshold` falls into the hourly-extension branch forever, and `checkThresholdDraws` skips `threshold <= 0` (`lib/draws.js:188-189`). No form warning; the draw stays open and buyable indefinitely.

**[C-10] GALTI (help text) / KAMZORI — Automation health claims SMS credentials are "managed in Notifications"; they are not, and `sms_provider` only half-applies.** `routes/admin.js:484`: `['SMS', 'provider: ' + getS(S, 'sms_provider', 'textbelt') + ' (credentials managed in Notifications)']`. The Notifications Providers tab (`routes/admin.js:2194-2196`) is display-only env status ("set TWILIO_SID/… in .env") — no credential form exists there or anywhere in admin. Also the display default `'textbelt'` disagrees with the Settings form default `''` (`routes/admin.js:2642`). And the setting itself is read only by the OTP sender (`lib/otp.js:60`); notification SMS ignores it entirely — `lib/notify.js:66-76` `sendSms` always uses Twilio env vars regardless of the selected provider.

**[C-11] KAMZORI — Reports → Logins "By country" breakdown can never contain data; contradicts the Dashboard.** `routes/admin.js:1813` renders `ui.card('By country', … grp(countries))` grouped on `login_history.country`. But login recording always inserts empty country: `routes/auth.js:91-95` `INSERT INTO login_history (…, country, …) VALUES (…, '', …)` in `recordLogin`. The Dashboard states the opposite, correctly: `routes/admin.js:~216-219` *"Country is NOT recorded (no geo-IP service is configured), so only browser + OS are shown — no invented country donut."* The Reports card (and the Country column in user-detail login history, `routes/admin.js:899`) will forever show a single "—" row.

**[C-12] KAMZORI — Scratch admin money formatting hardcodes 2 decimals, ignoring currency decimals.** `routes/scratch.js:199` and `331`: `const fmt = (minor, cur) => (Number(minor || 0) / 100).toFixed(2) + ' ' + (cur || 'USD')`. The planner on the same router does it correctly (`routes/scratch.js:258`, `decimalsFor(inp.currency, …)`), and the main admin uses `req.fmt`. For a 0-decimal (e.g. JPY) or 3-decimal currency series, the series list/detail Revenue/Paid/Prize-pool figures are wrong by 100×/10×. No effect for USD/EUR/INR.

**[C-13] KAMZORI — Scratch series list renders Launch/Toggle/Stop for every status; two are guaranteed-error or silent no-ops for most rows.** Buttons are unconditional: `routes/scratch.js:207-209`. Launch throws for non-drafts (`lib/scratch.js:151` *"Only draft series can be launched"*). Stop refuses non-live (`routes/scratch.js:450-453`). Toggle refuses stopped/draft (`435-442`) but happily flips `enabled` on an **ended** series — a silent no-op, since the lobby only sells `status='live' AND enabled=1` (`routes/scratch.js:18,160`).

**[C-14] KAMZORI — Users search silently discards the active filter tab/agent filter.** Tabs and pagination preserve `f`/`agent` (`routes/admin.js:796-807`), but the search form is built as `ui.filtersHtml(R(req, '/users'), [{ key: 'q', … }], { q, f })` (`802`) — `filtersHtml` (`lib/admin-ui.js:57-63`) emits only the listed fields, so submitting a search GETs `/users?q=…` with no `f` and no `agent`, resetting to "All" with no indication.

**[C-15] KAMZORI — User detail fetches an agent list it never uses; agent assignment is a raw numeric text box.** `routes/admin.js:818` `const agents = await req.db.query("SELECT id, name FROM users WHERE role = 'agent' ORDER BY name");` — `agents` is never referenced in the page body. The biodata field is instead `{ key: 'agent_id', label: 'Agent (blank = unassigned)', type: 'text', … }` (`838`), i.e. the admin must know/type the agent's numeric ID (server-side existence is validated at `903ff`, so a typo errors rather than corrupts — hence KAMZORI, not GALTI).

**[C-16] KAMZORI — Dead warning branch in credentials save flash.** `routes/admin.js:1753`: `'Credentials saved.' + (keyConfigured() ? ' Encrypted at rest.' : ' WARNING: stored unencrypted — …')`. The handler returns early when the key is missing (`1736-1741`, fail-closed block), so by line 1753 `keyConfigured()` is always true and the WARNING branch is unreachable dead text suggesting plaintext saving is still possible.

**Checked and clean (no finding):** all other form→handler field names match (draws/test, agents create/fund, methods + credentials, pages/content, cron schedule `interval_<id>`, notifications send/announcements/templates, canned replies, staff, TOTP, KYC approve/reject `reason`, mark-paid `provider_payout_id`, scratch create/planner, agent-router views in `routes/agent.js` + `views/agent/*.ejs`); all other form actions resolve to registered routes; no `confirm(` dialogs exist in admin-rendered pages (the only `data-confirm` uses are player-side `views/security.ejs` and agent `views/agent/transfer.ejs`, outside the admin console); money/KYC/automation POSTs other than [C-05] all carry `audit.log` (settings handlers log diffs; KYC document *views* are also logged, `routes/admin.js:1900-1910`).

## COVERAGE STATEMENT
Read in full: `routes/admin.js` (3,185 lines, every GET/POST handler), `routes/scratch.js` (player + adminRouter), `routes/agent.js`, `lib/admin-ui.js`, `lib/settings.js`, `lib/kyc.js`, `lib/prize-engine.js`, `lib/extensions.js`, `lib/cron.js`. Every settings/automation/bonus/extension/cron key was grepped across `lib/`, `routes/`, `server.js`, and `views/` for read sites (including dynamic keys `'draw_trigger_mode_'+k` in `lib/draws.js`). All admin inner forms were cross-checked field-name-by-field-name against their POST handlers, and every POST handler was scanned for an `audit.log` call (including indirect logging inside `lib/draws.js`/`lib/bonus.js`). Not covered: player-facing routes/views except where a setting's read site lives there; live runtime behaviour (static audit only — no server was run).