# BP-26 — Integrity map: how every critical record is protected

*Compiled 2026-10-28 (v19 round). Sources: code inspection plus the
tamper battery in `test/tamper.test.js` (all cases pass) and the
client-authority inventory from the deep scan (area D, §3).*

## The pass criterion (user, 2026-10-28)

A change made in the browser that dies on refresh is **harmless and
expected**. A tamper case fails **only** if a browser-originated
manipulation crosses to the server and **persists** — balance, result
or record actually changed, visible from a clean session afterwards.
Every case in the tamper pack therefore asserts against database
state read through a separate connection after the attack, never just
the attack response's status code.

## Per-record protection map

| Record | Protection today | Verified by |
|---|---|---|
| **Tickets** (`tickets`) | Server computes pops/wager/total from the server-side wager list and prize table; the buy form's numbers are never trusted. Ticket carries an HMAC (`TICKET_HMAC_SECRET`) verified at settlement. | Tamper pack: forged `total/price/balance` fields ignored — ticket total and wallet debit are the server-computed values. |
| **Ticket entries** (`ticket_entries`) | Created only inside the buy transaction against open draws (status + close re-checked in-transaction); win amounts computed at settlement from the prize table, never from client input. | Tamper pack: dirty pops `[0,16,99,5,5]` sanitised to `[5]`; non-listed wager rejected 400 with no movement. |
| **Draws + results** (`draws`) | Winning number derives from the drand beacon / committed seed (`seed_hash` published before close, seed revealed after). No admin or client path sets a real draw's number (fixed numbers exist only on `draw_type='TEST'` draws, which can never hold player entries). | Code audit (area B/D); settlement in E2E draws. |
| **Ledger** (`transactions`) | **Append-only.** Zero `UPDATE`/`DELETE` on `transactions` anywhere in `lib/` or `routes/` (grep-verified, and a suite test re-asserts it from source). Reversals are new rows (`*_revoke`, `*_release`, `draw_refund`); wallet balances are a cache over the ledger and are reconciled by the `reconcile_ledger` cron. | Tamper pack Part A source-invariant test. |
| **Wallets** (`wallets`) | Mutated only inside `postLedger` (the cached-balance update is part of the same transaction as the ledger insert). Clients cannot write balances: profile POSTs smuggling `balance/wallet/role` fields change nothing. | Tamper pack: profile smuggling case (balance and role unchanged). |
| **Scratch outcomes** (`scratch_outcomes`) | Predetermined at series launch from a server seed; each ticket stores a SHA-256 commitment `sha256(series|ordinal|nonce|prize)` verified at reveal. The prize is never sent to the browser before reveal (`prize/nonce/ordinal` nulled in the ticket view model). Reveal is a guarded `purchased → revealed` transition; a replay credits zero. | Tamper pack: forged reveal prize ignored, exact committed prize credited once, replay credits nothing, IDOR reveal refused. Deep-scan inventory D-26. |
| **KYC submissions/decisions** (`kyc_documents`, `users.kyc_*`) | Files live outside `public/` under random names; magic-byte + extension + size validation; served only via owner/staff routes (other player → 404). Decisions are guarded transitions (`WHERE status='pending'` + changes check, scan fix B-02); every decision is audit-logged with the actor. | BP-21 E2E + suite; scan regression tests (B-02/B-03 over HTTP). |
| **Bonuses** (`bonus_campaigns`, `bonus_grants`) | Grants are promotional credit posted through the ledger by the rule engine only; budget cap stops exactly; no path from bonus tooling to game outcomes. | v18 E2E (budget-cap exact stop) carried forward; grants re-checked in scan connections. |
| **Settings** (`settings`) | Written only through validated admin handlers (group-save discipline: one bad value refuses the whole save); every change audit-logged with old/new where the handler tracks it. Client has no write path at all. | Connections audit (invalid guardrail value refused, group untouched). |
| **Audit log** (`audit_log`) | **Hash-chained (tamper-evident)** — see below. Append-only by the same grep invariant as the ledger. | Tamper pack Part A. |

## The audit hash chain (BP-26.3b — already present since v14, proven here)

- `lib/audit.js` serialises inserts through a mutex; each row stores
  `prev_hash` and `row_hash = sha256(prev_hash | action | entity |
  entity_id | detail | created_at | actor)`. The first chained row
  descends from the literal anchor `GENESIS`.
- `verifyChain()` walks the chain forward and reports either OK or
  the **first broken row id** with the reason — including the case
  where early rows were deleted to re-anchor the chain (the first
  chained row must descend from GENESIS).
- The admin Audit page runs the verification on **every render** and
  banners the result ("Audit chain verified: N chained row(s)" or
  "Audit chain BROKEN at row #N").
- Tamper pack proof: one edited byte in a middle row's detail →
  verify reports that exact row; a deleted row → verify fails (the
  successor's `prev_hash` dangles); restored chain → verifies again.

## Client = display only (BP-26.2 inventory, summary)

Full inventory in the deep-scan area-D report (§3, items D-20…D-27).
Headlines: playslip totals/prize previews are estimates re-derived
server-side at purchase; Quick Pick is user input; hero counters
animate server values only; countdowns are display (server re-checks
close in the buy transaction); deposit/withdraw charge previews are
recomputed from the DB method row; the scratch reveal client decides
*when* (60% foil threshold, cosmetic — a no-animation button bypasses
it), never *what*; the canned-reply picker only fills a textarea.
**No client-computed value is trusted by the server anywhere.**
One defect found and fixed by the scan: the /play currency switch
used an inline `onchange` the site's own CSP blocks (SCAN-030).

## Honest limits

- Browser-side tampering with results/numbers is **prevented** by
  server authority, and the pack above proves the battery of cases.
- Server-side history tampering (someone with DB write access editing
  ledger/audit rows after the fact) is **detectable** via the audit
  hash chain and the scratch/ticket commitments — it is not, and
  cannot be, *prevented* by application code.
- **No code protects against theft of the server's own secrets or
  accounts** (Render/GitHub credentials, `TICKET_HMAC_SECRET`,
  `CREDENTIAL_ENCRYPTION_KEY`). That side is operator hygiene: strong
  unique passwords + 2FA on Render/GitHub, secret rotation, and the
  daily backups. Nothing in this codebase claims to be "unhackable".
