# Incident Response Plan — Cash Pop

## Severity
- **SEV-1 (money movement wrong):** wrong credits/debits, double payout, draw
  integrity doubt, admin compromise, credential leak. Act immediately.
- **SEV-2 (feature down / abuse pattern):** webhook flood, fraud-flag spike,
  reconciliation mismatch, maintenance needed. Act same day.
- **SEV-3 (minor):** single-user issue, display bug. Normal queue.

## Immediate actions (SEV-1)
1. **Stop the bleeding:** enable `maintenance_mode` (Admin → Settings →
   Toggles). This gates ALL player methods; admins still work. Do NOT shut
   the process down first — you need the panel and the audit trail.
2. **Preserve evidence:** export `audit_log` (Admin → Audit Trail) and the
   latest `reconciliation_reports` row. Do not edit or delete rows — the
   hash chain is the evidence.
3. **Freeze money:** if a specific account is involved, block it
   (Admin → Users → Block) and revoke its sessions. If a method is involved,
   disable that payment method (Admin → Payment Methods → toggle off).
4. **Find the scope:** Admin → Reconciliation → Run now. Any mismatch names
   the affected users/currencies. Check Admin → Fraud Flags and the
   webhook audit rows (`webhook.received` / `webhook.deposit_approved`).
5. **Fix with ledger entries only:** correct balances with Admin →
   Users → Adjust (remark required, audited). Never edit `wallets` or
   `transactions` rows directly — direct edits break the reconciliation
   proof and the audit chain.
6. **Draw integrity doubt:** check Admin → Draws → the draw, and
   /fairness?draw_id=N (hash + number must both MATCH, beacon fields must
   be present for v14 draws). If a draw cannot be proven fair, do not pay
   it — escalate to the operator and keep the site in maintenance.
7. **Credential leak:** rotate the provider secret at the provider, then
   re-save it in Admin → Payment Methods → Credentials (re-encrypts at
   rest). Rotate `CREDENTIAL_ENCRYPTION_KEY` only with a planned migration
   (old envelope rows become unreadable — re-save every method after).
8. **Admin compromise:** revoke the admin's sessions, force a password
   reset (Admin → Users → Reset password sends a one-time link), require
   TOTP (Admin → Security → enroll, then Settings → enable
   `admin_totp_required`), review Audit Trail for that admin's actions.

## Recovery
- Turn `maintenance_mode` OFF only after reconciliation shows 0 mismatches
  and the audit chain verifies (Admin → Audit Trail banner).
- Write a short postmortem: what happened, scope (users/amounts), root
  cause, fix, and what check would have caught it earlier. Keep it with
  this file's folder (docs/) — do not put player PII in it.

## Contacts & access
- Operator (site owner): holds Render dashboard + domain + provider
  accounts. No credentials live in chat or in the repo.
- This document assumes one operator + trusted staff. If staff grows,
  assign incident roles (commander, money, comms) before you need them.

## Backups (operator duty)
- Before any deploy or setting change: snapshot the database.
  On Render free-tier SQLite this means copying `data/cashpop.sqlite`
  (the file wipes on redeploy — see v15 Postgres migration for the durable
  fix). Without a backup, a bad deploy is unrecoverable by code alone.
