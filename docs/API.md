# API — HTTP surface of the actual app

The app is server-rendered; most "endpoints" return HTML pages, not
JSON. This document lists the real routes (from `server.js` mounts and
`routes/*.js`), grouped by surface. Anything requiring a session says
so; authorization is always enforced server-side.

## Public (no session)

| Route | Notes |
|---|---|
| `GET /` | Homepage. All statistics are live database values. |
| `GET /results` | Settled draw results (test draws are never shown). |
| `GET /play` | Playslip (redirects guests to `/login`). |
| `GET /scratch`, `GET /scratch/:slug` | Scratch lobby and series pages. |
| `GET /fairness` | How draws and scratch outcomes are derived. |
| `GET /page/:slug` | CMS pages (about, FAQ, how-it-works, terms, privacy…). |
| `GET /announcements` | Published announcements (login required in practice). |
| `GET /contact`, `POST /contact` | Contact form → `contact_messages`. |
| `GET /sitemap.xml`, `GET /robots.txt` | Generated from the live route/CMS set. |
| `GET /api/stats` | JSON, see below. |
| `GET /healthz` | Uptime probe, see below. |
| `POST /currency` | Sets the display-currency preference (form POST). |

### `GET /api/stats`

```json
{
  "players": 1,
  "tickets_today": 5,
  "paid_out": 500,
  "paid_out_fmt": "$5.00",
  "paid_out_by_currency": [{ "currency": "USD", "s": 500 }],
  "recentWins": [
    { "name": "First", "amount": 500, "amount_fmt": "$5.00",
      "currency": "USD", "created_at": 1793188404119 }
  ]
}
```

Every value is a live aggregate over real rows: registered players
(role `player`), tickets created in the last 24h, and prizes paid —
ledger types `win` (lottery) and `scratch_prize` summed per currency;
the headline figure is the base currency only. `recentWins` shows first
names only.

### `GET /healthz`

- Healthy: `200 {"ok": true, "time": <epoch ms>}` — returned only after
  a real database ping (`SELECT 1`) succeeds.
- Database unreachable: `503 {"ok": false}`.
- Nothing else is exposed: no version, no config, no error detail.
- Exempt from maintenance mode so monitors keep working during
  maintenance windows.

## Auth (`routes/auth.js`)

`GET|POST /login` (password; TOTP challenge when enrolled; OTP login via
`POST /login/otp/request` + `POST /login/otp/verify`), `GET|POST
/register`, `POST /logout`, `GET|POST /forgot`, `GET|POST
/reset/:token`, `GET /verify-email/:token`, `GET|POST
/login/complete-profile`, `GET /auth/google` + `/auth/google/callback`,
`GET /auth/facebook` + `/auth/facebook/callback`. OAuth providers fail
closed with an honest "not configured" state until the operator adds
app credentials. Login is rate-limited with an invisible lockout; TOTP
codes are single-use.

## Player (session required, own data only)

Pages: `/wallet`, `/deposit/new`, `/withdraw/new` (+ `/withdraw/verify`
for the withdrawal OTP step), `/tickets`, `/ticket/:publicId`,
`/transactions`, `/profile` (+ `POST /profile/notifications` for the
email preferences: win / support-reply), `/security` (password, TOTP
2FA, own session list, sign-out-other-sessions), `/support` (+
`/support/new`, `/support/:publicId`, reply/close), `/scratch/my-tickets`
and the scratch reveal endpoints, `/announcements`. Balances are never
rendered for logged-out visitors.

## Agent (session, role `agent`, mounted at `/agent`)

Dashboard, own players only (`/agent/players`, transfers, commissions),
and support tickets belonging to those players (`/agent/support`,
`/agent/support/:publicId` + reply). Tickets of other agents' players
return 404 — ownership is enforced in SQL, not by hiding links.

## Admin console (session, role `admin`, custom path)

Mounted at the `admin_path` setting / `ADMIN_PATH` env (default
`/ops-7f3a9c-console`). Non-admins receive a plain 404 for every console
path. Sections: dashboard, draws, tickets, scratch, users, OTP codes,
agents, deposits, withdrawals, approvals (maker-checker), reconciliation,
fraud flags, payment methods + gateway credentials, reports, support
(+ canned replies at `/support/canned-replies`), contact messages,
extensions, notifications (templates, outbox, broadcasts, announcements),
pages & content, cron jobs, automation console, bonuses, login history,
referrals, staff & RBAC, security, settings, audit trail. All actions
are CSRF-protected, RBAC-gated and audit-logged; admin actions execute
directly (no confirmation popups, by operator decision).

## Webhooks (`routes/webhooks.js`)

`POST /webhooks/:rail` — one endpoint per payment rail, raw-body,
per-IP rate-limited. Processing order: resolve the rail's stored
credentials → verify the provider signature → parse the event → verify
the amount and currency against the pending deposit → apply exactly
once (idempotent on the provider event id, recorded in
`webhook_events`). A webhook can never credit more than the recorded
deposit amount, and unconfigured rails reject.
