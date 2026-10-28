# Cash Pop — Lottery & Scratch Platform

A complete real-money lottery platform: Cash Pop–style number draws with
provably fair settlement, scratch cards with predetermined committed
outcomes, multi-currency wallets, deposits/withdrawals with a full
control matrix, agents, bonuses, an optional KYC module, and a stealth
admin console with an automation engine. Node.js + Express, SQLite by
default (Postgres/MySQL supported), no build step.

**Start here if you just unzipped this package.** Deeper reading:
`docs/ARCHITECTURE.md`, `docs/API.md`, `docs/DATABASE.md`,
`docs/SECURITY.md`, `docs/OPERATIONS.md`, `docs/LEGAL-CHECKLIST.md`,
and `README-DEPLOY.md` for hosting detail.

## 1. Install

Requires **Node.js 20+** (22 recommended).

```bash
npm ci          # or: npm install
```

## 2. Configure

```bash
cp .env.example .env
```

Edit `.env` and set at least:

- `TICKET_HMAC_SECRET` — any long random string (the app refuses to boot
  without it).
- `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` — your first admin account,
  seeded on first boot.
- `CREDENTIAL_ENCRYPTION_KEY` — 64 hex chars
  (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
  Without it the app runs, but saving payment-provider credentials is
  refused.
- `BASE_URL` — the public URL you will serve on (e.g.
  `http://localhost:3000` for a first local run).

Everything else has a working default (SQLite database at
`./data/cashpop.sqlite`, port 3000).

## 3. Boot

```bash
node server.js
```

You should see `listening on :3000`. Check:

```bash
curl http://localhost:3000/healthz     # {"ok":true,...}
```

## 4. Admin login

1. Open `http://localhost:3000/` — the public site.
2. Go to `/login` and sign in with the `ADMIN_SEED_*` credentials.
   Because the account is an admin, you are redirected to the console
   (default path `/ops-7f3a9c-console` — change it via `ADMIN_PATH` and
   keep it secret; the public site contains no link to it, and
   non-admins who guess it get a plain 404).
3. Change the admin password, add staff accounts with least-privilege
   roles, and enable TOTP for staff.

## 5. Configure a payment method

In the console: **Payments → Payment methods**. The 13 seeded rails ship
disabled. Pick one (e.g. **Bank Transfer**), enable it, set its
min/max amounts, and fill its **receiving details** (where players send
money — e.g. your bank account for Bank Transfer, or a wallet address
for Cryptocurrency). Those receiving details are what players see on the
deposit page; provider secrets belong in the rail's credential fields
and are stored encrypted.

Then rehearse the full money loop with small amounts before going live:
register a player → deposit → approve it in **Payments → Deposits** →
buy a ticket or scratch card → let a draw settle → withdraw → mark paid
in **Payments → Withdrawals**.

Operational notes (backups, monitoring, Postgres, rollback) are in
`docs/OPERATIONS.md`. Licensing and compliance are the operator's
responsibility — read `docs/LEGAL-CHECKLIST.md` before taking real
money.
