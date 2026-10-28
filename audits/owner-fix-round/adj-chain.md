# U-21 §5 POLISH + U-23 IMPORT/EXPORT — adjudication ledger (adj-chain.md)

Worker: CHAIN (U-21 §5 polish + U-23). Files owned: `routes/admin.js`,
`lib/admin-ui.js`, `routes/player.js` (§5.3 only), `test/v20-chain.test.js`.
Spec source: `adj-payments.md` §5 (authoritative). State source:
`adj-admin.md` (U-20 pass). Written as work proceeds; verdicts below were
checked against the CURRENT tree (post U-20 / U-21-core / D-FIX waves),
not the pre-fix line numbers in the spec.

---

## WORKSTREAM 1 — U-21 §5

### §5.1 Save-time credential validation — CONFIRMED GAP (pre-fix)
Current POST `/methods/:id/credentials` (routes/admin.js) looped
`rail.credentialFields`, skipped blank password fields BEFORE the required
check (`if (f.type === 'password' && !v) continue;` ran first), and its only
validation was `f.required && !v`. Consequences, both named in the spec:
(a) a required password field with no saved value passed silently on a
blank first save; (b) format garbage (bad UPI VPA, http:// QR URL, Stripe
test key under live mode) was stored silently. `validateRailCredentials`
already exists in lib/rails.js (U-21 core) and enforces required on a
merged map — it was simply never called by the route.
FIX: (below, results section).

### §5.2 Credentials GET drops help/secret — CONFIRMED (pre-fix)
The GET handler rebuilt every field as `{key,label,type,options|value}`:
non-password fields got `help: ''` (all rails.js help text lost), password
fields got only the fixed keep-saved note, and the `secret` marker was
dropped. lib/admin-ui.js `fieldHtml` already renders `f.help` and select
options, so the fix is the spec's pass-through map in the route only.
One deliberate deviation from a naive reading: password field VALUES are
rendered empty (value '') — a stored secret is never echoed into the page,
which the task's proof requires ("secret values never appear in any
rendered page"); rails.js help + the keep-saved sentence are appended for
password fields exactly as the spec's snippet does.

### §5.3 Player side — CONFIRMED GAP (pre-fix)
- `routes/player.js methodCustomFields(method)` ignored kind entirely:
  withdrawals were served the DEPOSIT `rail.userFields` (a bank_transfer
  withdrawer was asked for a "Transfer reference" instead of their own
  account details — adj-payments §4-W). Call sites: deposit GET+POST,
  withdraw GET+POST. The /withdraw/verify paths take `pending.userData`
  from the session stash written by POST /withdraw/new, so fixing the
  POST fixes verify with no separate edit (verified by reading the
  verify handlers: they never call methodCustomFields).
- GET /deposit/new never called `getPublicConfig` — the cards
  publishable-key / gateway public-config path built by U-21 core was
  dead on the player side. Fix passes `gatewayPublic` to
  deposit_new.ejs; rendering that local is the views worker's leg
  (adj-payments §5.3 itself assigns it there; views are not this
  worker's files). Operator-defined `method.custom_fields` stay in
  both kinds (they are method-level extras defined by the operator,
  not rail proof fields; the rail field set is what §5.3 swaps).

---

## WORKSTREAM 2 — U-23 IMPORT / EXPORT

### Before-state (adjudicated, grep-proven)
There is NO CSV export anywhere in the app: no `text/csv`, no
Content-Disposition download, no CSV helper in routes/, lib/, server.js
or views/. What exists and must not be duplicated:
- GET /reports — HTML-only business/login/ticket/transaction/payment/
  withdrawal reports with dateRange() filtering (U-20.1-fixed). It is a
  viewing surface, not a download.
- Reconciliation — a stored JSON report (reconciliation_reports) proving
  wallets == ledger; not a data export.
So U-23 is a NEW "Data — Import & Export" area that REUSES the reports
dateRange() helper for its date filters and links back to Reports for
on-screen viewing; it does not re-implement either existing surface.

### Export design (as built)
- Routes: GET `/data` (area home) + GET `/data/export/:dataset`.
  Stealth middleware already 404s non-admins before these run.
- RBAC per dataset, following lib/rbac.js role sets (GETs are otherwise
  readable by all staff, so the handler gates explicitly, like the
  credentials page does): users → SAFETY (super+risk; the export carries
  emails/phones), ledger/deposits/withdrawals/tickets/ticket entries/
  draws/agents → MONEY (super+finance), support tickets → SUPPORT
  (super+support). A staff role outside the set gets a plain 403 with
  the true reason.
- Datasets: users, ledger (transactions), lottery tickets, ticket
  entries, draws/results, deposits, withdrawals, agents, support
  tickets. Human headers only (no snake_case), statuses/types
  humanised ("Ticket purchase", "Pending"), amounts in MAJOR units via
  fromMinor with the currency in its own column, dates as
  `YYYY-MM-DD HH:MM:SS UTC`, booleans as Yes/No.
- Reads are paged (500-row pages) and streamed via res.write — never a
  whole-table load. Honest cap: 10,000 rows per export; the cap is
  printed on the /data page, sent as `X-Export-Cap`/`X-Export-Total`
  headers, and recorded in the audit detail (`capped: true`) when hit.
- Filename: `<dataset>-<YYYY-MM-DD>.csv`. Every export writes an audit
  row `data.export` {dataset, rows, capped, from, to} with the actor.
- Formula-injection guard: text cells starting with = + @ (or a
  non-numeric leading -) are prefixed with a single quote.

### Import adjudication — chosen set (insert-only, natural-key dedupe)
Money data is NEVER importable: no route accepts balances/ledger/
deposits/withdrawals/tickets/draws/users, and the /data page says so in
plain words (exact wording in the results section).

INCLUDED (non-money master data an operator plausibly bulk-moves
between installs; each has a clean natural key and an existing admin
editor whose validation the importer mirrors):
1. **Content pages** (`pages`) — natural key: slug (UNIQUE). Fields:
   slug, name, title, meta_title, meta_desc, body, status, sort.
   Why safe: pure CMS content; slug validated with the same
   validSlug rule as the page editor; status limited to
   published/draft.
2. **Canned support replies** (`canned_replies`) — natural key: title
   (case-insensitive; the table has no unique constraint, so dedupe is
   enforced by the importer lookup, exactly why re-import adds 0).
   Fields: title, body — same 120/5000-char limits as the canned-reply
   editor.
3. **Notification templates** (`notif_templates`) — natural key:
   (channel, slug) (UNIQUE in schema). Fields: channel
   (email/sms/push), slug, subject, body, enabled (yes/no/1/0).
   Why safe: message wording only; sending still goes through the
   existing notification pipeline and its masking.
4. **Content blocks** (`content_blocks`) — natural key: key (PRIMARY
   KEY). Fields: key, title, body. Same trust level as the existing
   content editor (operator HTML).

EXCLUDED, with reasons:
- **Users / agents / staff** — identity data (emails, phones, password
  hashes, roles). Bulk-creating accounts bypasses U-22 one-identity
  checks, verification and password policy. Account creation stays in
  the register/staff/agent flows.
- **Balances, ledger, deposits, withdrawals** — money. Never directly
  importable (owner rule + ledger integrity: balances must derive
  from postLedger, and the audit hash chain/reconciliation assume it).
- **Lottery tickets, entries, draws, scratch tickets/outcomes** —
  game outcomes are server-generated and provably fair (HMAC tickets,
  committed scratch outcomes, beacon draws). Importing rows would
  fabricate play history and break fairness proofs.
- **Scratch series / prize structures and the Pop prize table** —
  prize economics (multipliers, prize tiers) decide real payouts and
  carry server seeds/seed hashes (series) that must never travel in a
  spreadsheet. Changes stay in the Prize Engine / Settings screens,
  which validate ranges and preview RTP before saving.
- **Payment methods + gateway credentials** — charges/limits are money
  config and credentials are encrypted secrets; both stay in the
  Methods screens with §5.1 save-time validation.
- **Blocked countries / settings generally** — a single settings value
  edited in Settings with its own validation; a CSV side-door would
  bypass that validation and could silently block/unblock whole
  countries.
- **Support tickets/messages, KYC documents, audit log** — evidence
  records tied to real users and the hash chain; importing them would
  falsify history.

### Import mechanics (as built)
- Two separate requests: POST `/data/import` (dry run — validates,
  writes NOTHING) → report page (rows ready / duplicates / rejected
  with per-row reasons) → POST `/data/import/execute` (a plain button,
  NOT a JS confirm; the execute request RE-validates the same CSV from
  scratch and inserts only ready rows inside one DB transaction, so a
  bad execute can never half-write). Audit rows: `data.import_dry_run`
  and `data.import` {dataset, filename, inserted, duplicates, rejected}.
- Idempotent: natural-key dedupe in the validator (existing row =
  "Already exists — skipped"), so importing the same file twice adds
  0 rows (proven by test).
- Upload transport, honestly: the app's only multipart parser
  (server.js) is scoped to POST /kyc, and server.js is NOT this
  worker's file, so a browser multipart POST to an admin path would be
  refused by the global CSRF check before reaching the router (the
  token travels in the parsed body, which no parser fills for
  multipart outside /kyc). The import form therefore follows the app's
  standard urlencoded form + CSRF pattern: the operator pastes the
  CSV file's contents into the form (the page says exactly that).
  SPEC FOR INTEGRATION (server.js, one block, mirroring the /kyc
  block): add a scoped multipart parser for POST <ADMIN_PATH>/data/
  import that fills req.body {_csrf, dataset, filename} and
  req.importCsvText from the file part; the handlers already prefer
  req.importCsvText when present, so the file-picker UI can then be
  enabled with no route changes. Until that lands, paste is the
  transport and no fake file upload is presented.
- Limits stated in the UI: max 1,000 rows and ~900 KB per import;
  malformed CSV (bad quoting, missing required columns, wrong column
  count) fails cleanly with reasons and writes nothing.

---

## RESULTS

### §5.1 — DONE
POST `/methods/:id/credentials` now builds the merged `incoming` map
(posted values; blank password fields take the already-saved decrypted
value) and calls `validateRailCredentials` BEFORE any write. A refusal
flashes `Credentials NOT saved: <true reason>` and leaves the stored
config byte-identical. The blank-save bug is closed by construction:
a required field can no longer slip past via the keep-saved `continue`,
because requiredness is judged on the merged map. Non-string (object)
body values coerce to '' instead of "[object Object]".
Proof (test/v20-chain.test.js): UPI save with `not-an-upi` → refused
naming the UPI ID format, ZERO credential rows written; crypto save
missing Network → refused naming Network, zero rows; cards save then a
blank-password re-save carrying a bad publishable key → refused naming
the Publishable key, stored publishable key unchanged AND the saved
webhook secret still decrypts to its original value (blank did not wipe).

### §5.2 — DONE
GET `/methods/:id/credentials` uses the spec's pass-through map:
`{...f, value: password ? '' : saved, help: password ? f.help +
'Leave blank to keep the saved value.' : f.help}` — help text, options,
required and the secret marker all reach lib/admin-ui.js intact (no
admin-ui change was needed, as the spec predicted).
Proof: after a valid cards save, the rendered form contains the
rails.js help ("Only needed for the provider/API (automated) mode…")
and the keep-saved note; the publishable key (non-secret) shows its
saved value; the stored secret key and webhook secret appear NOWHERE
in the HTML; both sit in gateway_credentials as `v1:` AES-GCM
envelopes with field_enc=1 and no plaintext substring.

### §5.3 — DONE
- `methodCustomFields(method, kind)`: kind 'withdrawal' →
  `rail.withdrawUserFields`; deposits unchanged (`rail.userFields`);
  operator custom_fields still apply to both. Withdraw GET+POST call
  sites updated; the /withdraw/verify paths consume the session-stashed
  userData written by the fixed POST, so they inherit the fix.
- GET /deposit/new now also passes `gatewayPublic =
  await getPublicConfig(req.db, method)` to deposit_new.ejs.
  Rendering that local remains the views worker's leg (per
  adj-payments §5.3); getPublicConfig itself is proven at lib level by
  v20-payments.test.js and hard-skips secret/password fields.
- Withdraw POST additionally runs `validateUserProof` on the collected
  payout data before the rules/OTP steps.
Proof: bank deposit page shows the saved account number/bank name and
asks for "Transfer reference"; the withdrawal page for the SAME method
asks "Your account holder name / Your account number / IBAN / Your
bank name" and contains neither deposit field; a withdrawal missing
the account number redirects back with `Field "Your account number /
IBAN" is required.` and writes no row; a valid withdrawal stores
exactly the payout fields in user_data (decoded and asserted), with
no deposit proof keys present.

### U-23 export — DONE
As designed above: GET /data + GET /data/export/:dataset for users,
ledger, tickets, ticket entries, draws, deposits, withdrawals, agents,
support tickets. Deep links added on the Users list ("Export users
(CSV) →", preselects the dataset) and the Deposits list.
Proof: users CSV first line is exactly the human header list and the
seeded player's row is humanised (Player / Yes); ledger CSV carries
the player with major-unit amounts (10.00); deposits CSV decodes the
submitted proof (REF-CHAIN-1 present); withdrawals CSV carries the
payout IBAN; support CSV carries the seeded ticket subject; a
2999 date range returns the header only; every export wrote a
`data.export` audit row with dataset + row count; a logged-in PLAYER
gets 404 on /data and on the export route, with an admin.probe audit
row; a FINANCE staff account can export the ledger (200) but gets 403
on users, and cannot import (no row written).

### U-23 import — DONE (chosen set only)
Money-never-importable UI wording (verbatim, on /data):
"Money can never be imported. Balances, the ledger (transaction
history), deposits and withdrawals are not accepted here in any form —
money records are only ever created by the payment and game flows
themselves, so an imported spreadsheet can never create, change or
delete money. If you need to correct a balance, use the balance
adjustment on the player's page, where the change is checked and
recorded."
Proof: dry-run of a 3-row pages file (1 valid, 1 bad slug, 1 in-file
duplicate) reports ready/duplicate/rejected with per-row reasons and
writes NOTHING (slug absent from DB, `data.import_dry_run` audit row
present); execute imports exactly the 1 ready row (`data.import`
audit: inserted=1); executing the SAME file again adds 0 rows (flash
"0 new row(s) added", page count stays 1); a file missing the title
column fails cleanly naming the column; dataset=ledger is refused
("Choose what you are importing first.") — no money import route
exists; canned replies import through the same flow with quoted
commas intact. Audit hash chain verifies {ok:true} at the end.

### Tests
- test/v20-chain.test.js: 18/18 PASS (port 4143, /tmp/chain.sqlite;
  activity seeded through real flows: register, admin-configured bank
  rail, deposit + approval, ticket buy, balance adjustment, support
  thread).
- Full suite (`node --test test/*.test.js`): 221 tests = 215 pass /
  3 fail / 3 skipped. The 3 failures, adjudicated:
  1. v19 BP-14 (sessions page shows UA verbatim) — the KNOWN
     integration-owned failure, superseded by the owner's U-04 order.
     Not chain-caused.
  2. v19 BP-16 (/healthz must return exactly {ok, time}; got {ok}) —
     server.js / v19 territory, not a chain file; the `time` field
     disappeared in another worker's wave. Not chain-caused; flag for
     the coordinator.
  3. v20-admin-pass "auto-withdrawal" — CAUSED BY §5.3, deliberately:
     that test submits its withdrawals with the OLD deposit fields
     (custom_reference / custom_sender_name on a bank_transfer
     withdrawal). After §5.3 those requests are correctly refused for
     the missing payout fields (account name/number/bank), so no
     withdrawal row exists for the test to approve. The test encodes
     the pre-§5.3 bug adj-payments §4-W condemned; it must be updated
     at integration to post custom_account_name /
     custom_account_number / custom_bank_name (the new
     withdrawUserFields). test/v20-admin-pass.test.js is the U-20
     worker's file, not this worker's — flagged, not edited.

### Spec'd / open
1. server.js scoped multipart parser for POST <ADMIN_PATH>/data/import
   (mirrors the /kyc block; fills req.importCsvText) — enables a real
   file-picker; handlers already prefer req.importCsvText. Until then
   the import form uses paste, and says so.
2. deposit_new.ejs rendering of the `gatewayPublic` local — views
   worker's leg (adj-payments §5.3 assigns it there).
3. Observation (pre-existing, not §5 scope): POST credentials is
   RBAC-gated to MONEY (super+finance) while the GET page is
   super-only — a finance staffer can POST credentials they cannot
   view. Left as-is; coordinator/owner may want the POST tightened in
   lib/rbac.js (not this worker's file).
4. U-26 worker: NAV now contains 'Data (Import & Export)' → /data;
   reorganize from there.
