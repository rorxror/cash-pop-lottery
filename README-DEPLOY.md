# Cash Pop Lottery — Deploy Guide

Standalone real-money lottery platform. **Node.js 22+**, pure-JavaScript
dependencies only (no native modules), SQLite built in, MySQL optional.

## Option A — cPanel shared hosting ("Setup Node.js App")

1. In cPanel open **Setup Node.js App** → **Create Application**.
   - Node.js version: **22** (or newer)
   - Application mode: production
   - Application root: e.g. `cashpop`
   - Application URL: your domain (must be HTTPS in production)
   - Application startup file: `server.js`
2. Upload this zip's contents into the application root (File Manager →
   Upload → Extract), **excluding** `node_modules`.
3. In the Node.js app panel open **Run NPM Install** (installs
   `express`, `ejs`, `qrcode`, `nodemailer` — all pure JS).
4. Add environment variables (see `.env.example`):
   - `SESSION_SECRET` — long random string (required)
   - `TICKET_HMAC_SECRET` — another long random string (required)
   - `ADMIN_PATH` — e.g. `/ops-9f2c1a-console` (your hidden admin URL;
     default is `/ops-7f3a9c-console` — change it)
   - `BASE_URL` — `https://yourdomain.com`
   - `FORCE_SSL=1` (you are on HTTPS)
   - Optional: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`,
     `RECAPTCHA_SITE_KEY`, `SMTP_*`, `TWILIO_*`
5. Make sure the `data/` directory is writable by the app (SQLite file
   lives at `data/cashpop.sqlite`; created automatically on first boot).
6. **Start** the app. Visit `https://yourdomain.com/setup` once to create
   the admin account. The setup page disables itself permanently after.
7. Log in and open your hidden admin path. Enable a payment method
   (Admin → Payment Methods), review Settings → Game economy, and configure
   Scratch Series at `<ADMIN_PATH>/scratch` before going live.

## Scratch module (included in v3)

- Player lobby: `/scratch`; tickets: `/scratch/my-tickets`; personal limits:
  `/scratch/responsible-play`.
- Admin series control: `<ADMIN_PATH>/scratch`.
- Four draft game formats are installed on first boot: single reveal,
  match-three, six-window and bonus gate. They remain disabled until an admin
  reviews price, inventory and prize tiers and launches a series.
- Launch creates the exact prize inventory, securely shuffles it and locks each
  outcome behind a SHA-256 commitment. Purchase debits the shared wallet in the
  same transaction that reserves an outcome. Reveal credits a win once only.
- Before launch, confirm the displayed RTP: total prize pool divided by total
  ticket sales. Never launch a draft whose economics or local legal approval
  have not been reviewed.
- Cooling-off, self-exclusion and daily loss limits are enforced before every
  scratch purchase. The audit stream records series and ticket lifecycle events.

The in-app cron scheduler runs inside the Node process (draw
creation/settlement, session cleanup). Keep the Node app running —
Passenger restarts it automatically.

## Option B — VPS (Ubuntu)

```bash
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs nginx
unzip cash-pop-fullstack-v3-scratch.zip -d /var/www/cashpop && cd /var/www/cashpop
npm install --omit=dev
cp .env.example .env   # then edit secrets + BASE_URL
node server.js         # or run under pm2 / systemd
```

Put nginx in front with HTTPS (Let's Encrypt) and proxy to `127.0.0.1:3000`.

## Switching to MySQL (optional)

SQLite needs zero configuration and is the default. For MySQL:

```env
DB_DRIVER=mysql
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=cashpop
MYSQL_PASSWORD=secret
MYSQL_DB=cashpop
```

Create the empty database first; tables migrate automatically on boot.
(`mysql2` is an optional pure-JS dependency and installs with npm.)

## First-run checklist (in the admin panel)

- Settings → Game economy: wager options, prize multipliers, draw times,
  commission rate, deposit/withdrawal modes and limits.
- Settings → Currencies: supported currencies + conversion rates.
- Payment Methods: enable the rails you'll use; open each method's
  **Credentials** page and paste provider keys.
- Extensions: enable/configure reCAPTCHA, Google Analytics, Tawk.to,
  Facebook Comments, custom captcha as needed. Everything works with
  all extensions OFF.
- Notifications → Templates: edit email/SMS/push texts; Providers tab
  shows what's configured.
- Pages & Content: edit pages, homepage blocks, FAQ, footer.
- Cron Jobs: verify the scheduler ran (last run timestamps).

## What needs YOUR provider accounts (config-only, honest list)

The platform is fully functional in manual/sandbox mode without any of
these. Live automation needs:

- **Google sign-in**: `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
  (Google Cloud Console → OAuth client), then enable in Settings.
- **Automatic SMS / email**: Twilio (`TWILIO_SID`, `TWILIO_TOKEN`,
  `TWILIO_FROM`) for SMS; SMTP (`SMTP_HOST/PORT/USER/PASS/FROM`) for email.
  Without them, OTP codes are operator-issued in Admin → OTP Codes and
  notifications sit in the outbox log.
- **Payment rails**: each method's Credentials page (Admin → Payment
  Methods → Credentials) takes the provider keys; webhooks verify
  signatures before acting. Manual mode (player submits proof, staff
  approves in one click) works with zero configuration.
- **reCAPTCHA / Analytics / Tawk.to / FB comments**: paste keys in
  Admin → Extensions.

## Security notes

- Never run the admin panel over plain HTTP in production (`FORCE_SSL=1`).
- Change `ADMIN_PATH` to something unguessable; never link it publicly.
- Back up `data/cashpop.sqlite` (or your MySQL database) regularly.
- Production draws are always server-random; number override exists
  only on TEST draws and is audit-logged (Admin → Audit Trail).
