# DATABASE — Cash Pop Lottery Platform

The app runs on **SQLite by default** (zero-config, file at `SQLITE_PATH`
or `./data/cashpop.sqlite`) and supports **Postgres** (`DB_DRIVER=postgres`
+ `DATABASE_URL`, or the `PG*` variables) and **MySQL** (`DB_DRIVER=mysql`
+ `MYSQL_*`). One data-access layer serves all three dialects; schema comes
from `lib/migrations.js`, applied in version order at boot
(`migrations_applied` records what ran; v1–v18 at the time of writing).

## Table groups

**Accounts & access** — `users` (players, agents, staff; role + admin_role,
status, verification flags, KYC fields — see below), `sessions` (DB-backed
sessions: id, user_id, data, ip, user_agent, expires_at), `login_history`,
`login_otps`, `otp_codes`, `password_resets`, `email_verifications`,
`account_flags` (fraud signals).

**Money** — `wallets` (one row per user+currency, cached balance),
`transactions` (the append-only ledger — the source of truth),
`deposits`, `withdrawals` (lifecycle rows with holds, charges, decisions),
`payment_methods` (rails + per-method limits and receiving credentials),
`gateway_credentials` (provider credentials, stored encrypted when
`CREDENTIAL_ENCRYPTION_KEY` is set), `webhook_events` (idempotency keys).

**Games** — `draws`, `tickets`, `ticket_entries`, `prize_table`,
`scratch_series`, `scratch_tickets`, `scratch_outcomes`,
`scratch_prize_tiers`, `scratch_events`.

**Operations** — `settings` (key/value; cached in memory for 5s, cache
invalidated on write), `audit_log` (hash-chained staff/player action log),
`cron_jobs` (scheduler registry + last/next run), `notifications_log`
(email/SMS/push delivery log), `notif_templates`, `announcements`,
`pages`, `content_blocks`, `support_tickets`, `support_messages`,
`canned_replies` (v19: support reply templates), `contact_messages`,
`bonus_campaigns`, `bonus_grants`, `pending_approvals` (maker-checker
queue), `reconciliation_reports`, `referral_credits`, `agent_floats`,
`agent_transfers`, `commissions`, `responsible_play`,
`responsible_play_pending`, `extensions`.

**KYC (v19, migration v17)** — `kyc_documents`: one row per submission
(user_id, doc_type, stored_name — a generated random filename; the bytes
live in a private directory outside `public/`, see OPERATIONS —
original_name for display only, content_type, size_bytes,
status pending/approved/rejected, review_note, reviewed_by/at). The
player-level state lives on `users`: `kyc_status`
(none/pending/verified/rejected), `kyc_override`
(default/required/exempt), `kyc_note` (latest decision reason or the
manual-verification attestation note).

**Auto-withdrawal (v19, migration v18)** — `users.auto_withdrawal_limit`
(major units as typed; NULL = follow the global `auto_withdrawal_limit`
setting; both default to OFF).

## Ledger integrity rules (enforced in `lib/money.js`)

- Balances are **derived**: a wallet balance must always equal
  `SUM(transactions.amount)` for that user+currency; a daily
  `reconcile_ledger` cron job verifies this and files a report.
- Every money movement is a ledger row inside the **same DB transaction**
  as its lifecycle change — no path moves money without a row.
- Deposits/withdrawals follow a strict state machine
  (pending → approved/rejected → paid for withdrawals; holds are ledger
  rows: `withdrawal_hold`, released by `withdrawal_release` on reject).
- Decision transitions are **guarded updates**
  (`... WHERE id = ? AND status = 'pending'`) so two deciders can never
  both succeed on the same row (no double-credit, no double-refund).
- Webhook processing is idempotent on `(rail, provider event id)`.
- Ticket purchases are HMAC-signed server-side; scratch outcomes are
  predetermined at series creation — never decided at reveal time.
