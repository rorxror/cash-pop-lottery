# ARCHITECTURE — Cash Pop Lottery Platform

What the system actually is, as built (v19). This document describes the
running implementation, not an aspiration.

## Shape

A single Node.js service: Express 4 + server-rendered EJS, one process,
one database. There is no separate frontend build, no SPA, and no
microservices. The same process serves the public site, the player area,
the agent area, the admin console, payment webhooks, and an in-process
job scheduler.

- Runtime: Node.js >= 22 (uses the built-in `node:sqlite`).
- Entry point: `server.js` — builds the app, runs migrations, seeds the
  first admin when `ADMIN_SEED_*` is configured, starts the scheduler.
- Start command: `node server.js` (port from `PORT`, default 3000).

## Layers

| Layer | Where | Responsibility |
|---|---|---|
| Routes | `routes/*.js` | HTTP surface only: auth checks, input handling, rendering. No money math. |
| Domain libs | `lib/*.js` | Money (`money.js`), draws (`draws.js`, `beacon.js`), scratch (`scratch.js`), bonus (`bonus.js`), notifications (`notify.js`), auth/sessions/TOTP (`auth.js`), scheduler (`cron.js`). |
| Data | `lib/db.js` | One adapter over SQLite / Postgres / MySQL with a common `get/run/query` interface and per-dialect migrations (`lib/migrations.js`). |
| Views | `views/*.ejs` | Player/public pages. The admin console is rendered from `lib/admin-ui.js` + `routes/admin.js` (server-generated HTML, no separate admin frontend). |
| Static | `public/` | `style.css` (player site), `app.js` (all client-side behaviour; CSP-safe, no inline handlers). |

## Request flow

1. Security headers + per-request CSP nonce (`server.js`).
2. Session load: the `sid` cookie resolves against the `sessions` table
   (server-side sessions; `lib/auth.js`). Pre-auth (pending-2FA) sessions
   carry `user_id = 0` and can never resolve a user.
3. CSRF verification on POSTs (403 on failure), maintenance-mode gate
   (with exemptions for login, webhooks, `/healthz`, static assets).
4. Router dispatch:
   - `routes/site.js` — public pages, `/api/stats`, `/healthz`.
   - `routes/auth.js` — register/login/logout, password reset, email
     verification, OTP login, profile completion, Google/Facebook OAuth.
   - `routes/player.js` — wallet, deposits, withdrawals, tickets,
     transactions, profile, security (2FA, sessions, preferences),
     support tickets.
   - `routes/scratch.js` — scratch lobby/series/tickets/reveal + the
     admin scratch router (mounted under the console path).
   - `routes/agent.js` — mounted at `/agent`: the agent's own players,
     transfers, commissions, and support tickets for those players only.
   - `routes/admin.js` — mounted at the configurable console path
     (default `/ops-7f3a9c-console`): the whole control room.
   - `routes/webhooks.js` — mounted at `/webhooks`: gateway callbacks.

## Admin console (stealth by design)

The console does not live at a guessable standard path and is never
linked from the public site. Any request to a console path by a
non-admin gets a plain 404 byte-identical to a nonexistent page, and the
probe is written to the audit log (`admin.probe`). Admins sign in through
the normal `/login`; an admin-role session is routed to the console.
Staff sub-roles (`super`, `finance`, `support`, `risk`) gate ACTIONS via
`lib/rbac.js` — GET views are readable by all staff, unmatched POSTs
fail closed (super only). Every admin action is audit-logged.

## Money flow (the short version)

All amounts are integer minor units. Every balance change goes through
`postLedger` (`lib/money.js`), which writes one immutable row to
`transactions` (with `balance_after`) and updates the cached `wallets`
balance in the same database transaction. Deposits/withdrawals move
through guarded status transitions; gateway webhooks are
signature-verified AND amount-verified before they can credit anything.
A nightly reconciliation job compares wallets against the ledger. See
`docs/DATABASE.md` for the integrity rules.

## Draws and fairness

Lottery draws settle from the public drand beacon (`lib/beacon.js`);
tickets carry an HMAC (`TICKET_HMAC_SECRET`, required at boot) that is
verified at settlement. Draw creation/settlement, scratch lifecycle,
bonus drops, cleanups and backups are jobs in the in-process scheduler
(`lib/cron.js`, rows in `cron_jobs`), each with an on/off switch, a
master automation switch, and failure alerts in the Automation Console.
Draw triggers (time / ticket-threshold / both) and payout structures are
operator settings; the winning number itself is never operator-chosen.

## Configuration

Two planes, deliberately separate:

- Environment variables — secrets and deployment wiring only
  (database, HMAC secret, provider credentials, SMTP). See
  `docs/OPERATIONS.md` for the full list.
- Database `settings` table — everything the operator tunes from the
  admin console (site behaviour, limits, toggles, templates, the
  console path itself). Nothing secret is ever rendered to a browser.
