# OPERATIONS — running Cash Pop in production

## Deploy (Render)

- One **web service** running `node server.js` (Node 20+). Build command:
  `npm ci` (or `npm install`). Health check path: **`/healthz`** — it pings
  the database and returns `{"ok":true}` (200) or `{"ok":false}` (503).
- SQLite (default) needs persistence: attach a **persistent disk** and set
  `SQLITE_PATH=/var/data/cashpop.sqlite` (mount the disk at `/var/data`).
  Without a disk, every redeploy wipes the database. KYC document uploads
  default to a folder **next to the SQLite file**, so the same disk holds
  them; set `KYC_UPLOAD_DIR` to override.
- Postgres instead: set `DB_DRIVER=postgres` + `DATABASE_URL` (or `PG*`).
  Schema migrates automatically at boot. A one-way transfer script exists:
  `scripts/migrate-sqlite-to-postgres.js` (guarded by
  `TRANSFER_WIPE_TARGET` + `TARGET_DATABASE_URL` + a target fingerprint —
  read its header before use).
- **Rollback**: there are no automatic deploy hooks in the reference repo —
  redeploy the previous known-good commit (Render: Manual Deploy → pick
  the commit). Database schema is forward-migrated; rolling code back
  across a migration boundary is safe for additive migrations (new
  tables/columns are ignored by older code).

## Environment variables

Required: `TICKET_HMAC_SECRET` (long random string — boot fails without
it), `ADMIN_SEED_EMAIL` + `ADMIN_SEED_PASSWORD` (first-boot admin; the
public setup page is disabled unless `ALLOW_SETUP=1`), `BASE_URL`.

Platform: `PORT`, `ADMIN_PATH` (console path; change it from the default
and keep it secret), `FORCE_SSL`, `DB_DRIVER`, `SQLITE_PATH`,
`DATABASE_URL`, `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGSSLMODE`,
`MYSQL_HOST/MYSQL_PORT/MYSQL_USER/MYSQL_PASSWORD/MYSQL_DB`,
`KYC_UPLOAD_DIR`, `CREDENTIAL_ENCRYPTION_KEY` (64 hex chars — required to
save provider credentials and to encrypt payout details at rest).

Providers (all optional; the app runs fully without them and the
corresponding feature simply stays off): `SMTP_HOST/SMTP_PORT/SMTP_USER/
SMTP_PASS/SMTP_FROM`, `SMS_PROVIDER`, `TWILIO_SID/TWILIO_TOKEN/
TWILIO_FROM`, `TEXTBELT_KEY`, `GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET`,
`FACEBOOK_APP_ID/FACEBOOK_APP_SECRET`, `RECAPTCHA_SITE_KEY`,
`DRAND_API` (randomness beacon endpoint), `HIBP_CHECK`.

See `.env.example` for the same list with placeholders.

## Backup & restore

- A built-in `backup_db` cron job runs daily: it writes a consistent
  SQLite snapshot (`VACUUM INTO`) into a `backups/` folder next to the
  database file and keeps the last 7. On Postgres/MySQL use the
  provider's backup tooling instead (the job is SQLite-only).
- **Restore (SQLite)**: stop the service → replace the file at
  `SQLITE_PATH` with the snapshot → start the service. Migrations re-run
  at boot and are no-ops on an up-to-date snapshot. KYC uploads are files,
  not DB rows: back up the uploads directory alongside the database.
- Test your restore before you need it.

## Monitoring

- `GET /healthz` for uptime checks (200/503 with a DB ping, no internals
  exposed).
- The admin console Automation page shows scheduler state: every cron
  job's last/next run and last result, plus a system-health block.
  Background jobs (draw settlement, notification processing, ledger
  reconciliation, backups) report failures there instead of dying
  silently — check it daily.
- `audit_log` is hash-chained; verify the chain from the console audit
  page if tampering is ever suspected.

## Day-one configuration checklist

1. Set the env vars above; boot; sign in at `/login` with the seeded
   admin (you are redirected to the console).
2. Change `ADMIN_PATH` and the admin password; create staff accounts
   with least-privilege roles; enable TOTP for staff.
3. Settings: site name, currencies + real FX rates, timezone, payment
   methods (enable + configure receiving details per rail), withdrawal
   caps/locks, KYC module (off by default — enable deliberately),
   auto-withdrawal limit (0 = off; read the help text before setting).
4. Connect email (SMTP) and test a withdrawal OTP end-to-end; connect
   SMS/OAuth only if you use them.
5. Do a full money rehearsal with small amounts: register → deposit →
   approve → play → draw settles → withdraw → mark paid.
