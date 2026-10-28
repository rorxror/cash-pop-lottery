# SECURITY — summary

The full threat model lives in `docs/THREAT-MODEL.md`; this page is the
short version. Security posture, in one paragraph: all game and money
logic is server-side; the admin console is stealth (non-staff requests to
console paths get a plain 404 and the probe is audit-logged); sessions are
DB-backed and revocable; every money/KYC/staff decision is written to a
hash-chained audit log; provider credentials are encrypted at rest when
`CREDENTIAL_ENCRYPTION_KEY` is configured and the app refuses to save them
without it.

## Key controls

- **Authentication** — password hashing (scrypt), optional TOTP 2FA with
  one-time backup codes, TOTP replay protection, breached-password checks,
  rate limits on auth/OTP/ticket endpoints, per-account lockout signals in
  `login_history` + `account_flags`.
- **Authorization** — role-based access: player / agent / staff
  (admin_role: super, finance, support, risk). `lib/rbac.js` maps every
  console POST to the roles allowed to perform it; unmatched console POSTs
  default to super-only (fail closed).
- **Money safety** — see DATABASE.md ledger rules; maker-checker queue
  for large money actions; payout-detail change lock with a cool-off
  window; withdrawal OTP (the only OTP in the product besides optional
  admin-enabled flows).
- **Draw integrity** — POP draws settle from a public randomness beacon
  (drand) committed before entries close; results are verifiable and
  cannot be influenced per-player. There is deliberately **no** control
  anywhere that changes an individual outcome.
- **KYC uploads (v19)** — the app's only upload surface. Files are
  size-capped, extension- AND magic-byte-validated (jpg/png/pdf only),
  stored under generated random names in a private directory (never
  `public/`, never the client filename — path traversal impossible),
  and served only through owner/staff-authorized routes with audit
  logging on staff views.
- **Auto-withdrawal approval (v19)** — a deliberate operator
  pre-authorization for small amounts: the system may flip a withdrawal
  to `approved` (recorded as decided_by 0 + an audit row) only after
  re-checking every gate at decision time (global freeze, per-user
  block, KYC requirement, payout lock, wagering rules). It never marks
  anything `paid`; payout still requires the normal mark-paid step.
- **Webhooks** — per-rail signature verification where the rail supports
  it; unconfigured rails fail closed (reject), and amounts are settled
  from the verified payload only.
- **Headers/transport** — CSP with per-request nonces, security headers,
  optional `FORCE_SSL`, HttpOnly session cookies, CSRF synchronizer
  tokens on every state-changing form (including the multipart KYC form).

## Known limits (honest)

- Notification log rows store email bodies; one-time codes themselves are
  stored hashed in `login_otps`, but a delivered code is visible in the
  log row for that send. Treat console access to the notification log as
  sensitive.
- Payout details (`withdrawals.user_data`, payout fingerprints) are
  encrypted at rest only when `CREDENTIAL_ENCRYPTION_KEY` is set;
  without it they are stored as plaintext JSON (documented behaviour —
  set the key before real operation).
- A live Postgres/MySQL deployment should be smoke-tested before launch;
  SQLite is the default and most-exercised path.

## Server authority & tamper evidence (v19)

The client is display-only: prices, wagers, totals, prizes and
balances are always recomputed or read server-side at the moment of
action. `test/tamper.test.js` proves this with a devtools-style
battery (forged buy fields, replayed reveals, IDOR probes, profile
smuggling) — every case asserts the **persisted database state
afterwards**, because a browser-side change that dies on refresh is
harmless; only a manipulation that crosses to the server and persists
counts as a failure.

Two structural guarantees back this up:

- **Append-only ledger and audit log.** No code path UPDATEs or
  DELETEs `transactions` or `audit_log` rows; reversals are new rows.
  A suite test re-asserts this from source.
- **Hash-chained audit log.** Each audit row stores the hash of its
  predecessor; the admin Audit page verifies the chain on every
  render and names the first broken row. History edits after the
  fact are therefore **detectable** — not preventable; no application
  code can prevent tampering by someone who already holds the
  server's own credentials. Protecting those (strong unique
  passwords, 2FA on the host and repo, secret rotation, backups) is
  operator hygiene, and this product does not claim to be
  "unhackable".
