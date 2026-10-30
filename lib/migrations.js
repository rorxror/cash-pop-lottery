'use strict';
/* Schema migrations — every change ships both SQLite and MySQL DDL so that
   switching DB_DRIVER remains config-only. Seeds default settings, prize
   table, pages, content blocks, notification templates, extensions,
   cron jobs and the 13 payment rails (disabled by default). */
const { sha256, randHex, hashPassword, now } = require('./util');

const DEFAULT_PRIZES = [
  [1, 13], [2, 13], [3, 12], [4, 11], [5, 10], [6, 9], [7, 9],
  [8, 8], [9, 8], [10, 7], [11, 7], [12, 6], [13, 6], [14, 6], [15, 5],
];
// NOTE: RTP per row = multiplier / 15 (wager is per pop, one number drawn).
// The table above keeps every row at or below 86.7% RTP (avg ~57.8%).
// The original table ([1,250]...[15,5]) paid up to 1667% RTP — fixed by migration v2.

const DEFAULT_SETTINGS = {
  site_name: 'Cash Pop Lottery',
  support_notify_email: '',
  deposit_bonus_percent: '0',
  site_timezone: 'UTC',
  base_currency: 'USD',
  // R-099: seeded FX rates are PLACEHOLDERS, not live rates — the operator must
  // update them in Admin → Settings → Currencies. There is no FX updater.
  currencies: JSON.stringify([{ code: 'USD', symbol: '$', rate: 1 }, { code: 'EUR', symbol: '€', rate: 0.92 }, { code: 'INR', symbol: '₹', rate: 83.5 }]),
  wager_options: '1,2,5,10',
  // SMART-ADMIN automation defaults (operator-editable).
  automation_master_enabled: '1',
  auto_draw_day: '1', auto_draw_eve: '1',
  draw_trigger_mode_day: 'time', draw_trigger_mode_eve: 'time',
  draw_threshold_day: '100', draw_threshold_eve: '100',
  draw_unmet_day: 'settle', draw_unmet_eve: 'settle',
  bonus_enabled: '1',
  scratch_auto_next_enabled: '0', scratch_template_series_id: '',
  multi_draw_discounts: '5:12,8:14,12:20',
  max_pops: '15',
  max_draws: '7',
  day_draw_time: '14:00',
  eve_draw_time: '21:00',
  upcoming_draw_days: '7',
  commission_rate: '5',
  // system configuration toggles (item 32)
  registration_enabled: '1',
  force_ssl: '0',
  policy_agreement: '1',
  secure_password: '1',
  /* H4-20 (v23): kyc_required / email_verification / mobile_verification
     used to be seeded here but were read by NOTHING — removed (and the
     stored rows deleted by migration v28). The live controls are
     kyc_enabled + kyc_gate and verified_contact_required. */
  notifications_enabled: '1',
  /* (the old 'language' seed was removed in the v23 settings census:
     no code ever read it — a vestigial row, deleted by migration v28.) */
  // OTP-gated registration
  otp_registration: '0',
  google_oauth_enabled: '0',
  facebook_oauth_enabled: '0',
  sms_provider: 'textbelt',
  phone_otp_enabled: '0',  // OFF by default: password login first; admin can enable OTP later
  email_otp_enabled: '0',  // OFF by default: password login first; admin can enable OTP later
  password_login_enabled: '1',
  withdrawal_otp_enabled: '1',  // OTP on withdrawal ONLY (toggleable from admin)
  // deposit / withdrawal control matrix (item 24)
  deposits_enabled: '1',
  withdrawals_enabled: '1',
  deposit_mode: 'manual',     // auto | manual
  withdrawal_mode: 'manual',  // auto | manual
  /* auto_approve_deposit_limit: legacy row, read by nothing — removed
     from the seeds in v23 (H4-20); migration v28 deletes stored rows. */
  // BP-21 (v19): KYC module — ships DORMANT. kyc_enabled is the master
  // switch; kyc_gate picks which money actions require an approved KYC.
  kyc_enabled: '0',
  kyc_gate: 'withdrawals', // withdrawals | deposits_and_withdrawals
  // BP-22 (v19): auto-withdrawal ceiling in MAJOR units as typed by the
  // operator, compared in the withdrawal's own currency. '0' = OFF
  // (everything manual, the shipped default). Fully wired — see
  // lib/money.js maybeAutoApproveWithdrawal.
  auto_withdrawal_limit: '0',
  // BP-23 (v19): Smart Prize & Profit Engine — aggregate level only
  // (lib/prize-engine.js). Guardrails ship OFF; planner default target.
  scratch_planner_target_rtp: '75',
  scratch_smart_pool_enabled: '0',
  scratch_guardrail_enabled: '0',
  scratch_liability_cap_pct: '100',
  scratch_alert_threshold_pct: '90',
  scratch_guardrail_action: 'alert', // alert | close_sales | stop_auto_next
  draw_liability_alert: '0', // major units; 0 = off
  // GDPR + appearance (item 26)
  cookie_consent_enabled: '1',
  cookie_text: 'We use cookies to keep your game fair, your wallet safe and your experience smooth. By continuing you accept our cookie policy.',
  custom_css: '',
  // EBT is blocked by policy on every rail
  blocked_rails: 'ebt',
  // ---- v14 (Phase A) risk + fairness controls ----
  beacon_enabled: '1',        // combine committed seed with drand public beacon at settle
  beacon_required: '0',        // 1 = settle FAILS if beacon unreachable (strict); 0 = fallback to server seed + audit
  withdrawal_turnover_required: '1', // 1x wagering of approved deposits before withdrawal
  withdrawal_daily_cap: '0',   // typed amount x100 (the Limits hub's per-currency amount); 0 = unlimited — see capMinorForCurrency in lib/money.js
  withdrawal_monthly_cap: '0', // typed amount x100 (per-currency); 0 = unlimited
  per_draw_stake_cap: '0',     // H4-04: max stake per draw per player, MINOR units of the ticket currency; 0 = off. Enforced in the buy transaction; set on Limits & Controls.
  payout_lock_hours: '48',     // lock after payout-detail change (24-72h range)
  withdrawal_same_method: '0', // 1 = withdraw only via a method previously deposited with
  maker_checker_threshold: '0',// minor units; 0 = disabled; >= threshold needs a second approver
  referral_cap_per_referee: '0', // minor units; 0 = unlimited lifetime commission per referee
  verified_contact_required: '1', // email OR phone must be verified before deposit/withdraw
  admin_totp_required: '0',    // 1 = admins must have TOTP (enable only after enrollment exists)
  breached_password_check: '1',// HIBP k-anonymity check on password set (fails open offline)
  csp_enabled: '1',            // Content-Security-Policy header (nonce-based, see server.js)
};

const CONTENT_BLOCKS = {
  home_banner: ['Homepage banner', '<h2>Win up to 13X on every pop!</h2><p>Pick your numbers, choose Day or Evening draw, and watch the wins roll in. Provably fair — verify every draw yourself.</p>'],
  how_it_works: ['How it works', '<ol><li><strong>Pick 1–15 pops</strong> — your lucky numbers from 1 to 15.</li><li><strong>Set your wager</strong> per pop and choose Day, Evening or Both draws.</li><li><strong>Buy your ticket</strong> — securely signed and locked to the next draws.</li><li><strong>Win</strong> — if the drawn number matches one of your pops, you win that pop\'s prize, credited to your wallet as soon as the draw settles.</li></ol>'],
  winners: ['Winners', '<p>Our latest winners will appear here. Could you be next?</p>'],
  testimonials: ['Testimonials', ''], // SCAN fix (D-05): no placeholder text on the live homepage — the section renders only when the operator adds real testimonials here.
  footer_about: ['Footer about', '<p><strong>Cash Pop Lottery</strong><br>Play responsibly. 18+ only.</p>'],
  footer_contact: ['Footer contact', '<p>Support: message us any time via the <a href="/contact">Contact page</a> — or open a support ticket from your account after signing in.</p>'], // SCAN fix (D-01): was an email on a domain the operator does not own
  about: ['About us', '<p>We run transparent, provably-fair lottery draws. Every draw publishes its seed hash before entries close and reveals the seed afterwards, so anyone can verify the result on the Fairness page. Winnings are credited to player wallets at settlement, and withdrawals are reviewed before payout for everyone\'s protection.</p><p>Questions? Reach us through the Contact page, or open a support ticket from your account after signing in.</p>'],
  faq: ['FAQ', '<h4>Is it fair?</h4><p>Every draw publishes a seed hash before the draw and reveals the seed after. Verify on our Fairness page.</p><h4>How do I get paid?</h4><p>Winnings are credited to your wallet instantly after the draw settles.</p>'],
};

const PAGES = [
  ['About Us', 'about', 'About Us', 'Learn about our lottery operation', '{{content:about}}'],
  ['How It Works', 'how-it-works', 'How It Works', 'How to play Cash Pop', '{{content:how_it_works}}'],
  ['FAQ', 'faq', 'FAQ', 'Frequently asked questions', '{{content:faq}}'],
  ['Terms of Service', 'terms', 'Terms of Service', 'Terms of service', '<h4>Eligibility</h4><p>You must be 18 or older and legally allowed to play in your jurisdiction. One account per person; accounts are personal and may not be sold or shared.</p><h4>How play works</h4><p>You pick 1–15 pops (numbers 1–15), a wager per pop, and one or more draws. A purchase is final once confirmed and is recorded on your account. Draws are provably fair: a seed hash is published before entries close and the seed is revealed after the draw, so every result can be verified on the Fairness page.</p><h4>Prizes and settlement</h4><p>If the drawn number matches one of your pops, the prize for that pop count is credited to your wallet when the draw settles. Prize multipliers are shown on the Play page before you buy.</p><h4>Deposits and withdrawals</h4><p>Deposits and withdrawals are reviewed before they are credited or paid. We may ask for identity verification before a withdrawal, and withdrawals go only to payment details in your own name. Limits shown on the deposit and withdrawal pages apply.</p><h4>Responsible play</h4><p>Play should be entertainment, never a way to make money. Deposit, loss and session limits and self-exclusion tools are available — contact support or see the Play Limits page. 18+ only. Play responsibly.</p><h4>Accounts</h4><p>We may suspend an account that breaks these terms, attempts fraud, or abuses bonuses or referrals. Suspended accounts are reviewed by a human and you can appeal through support.</p><h4>Complaints</h4><p>Contact us through the Contact page or a support ticket from your account. We aim to answer every complaint and keep a record of it.</p>'],
  ['Privacy Policy', 'privacy', 'Privacy Policy', 'Privacy policy', '<p>We respect your privacy. We collect only the account details you give us (name, email, phone), your play and transaction history, and technical logs needed to run the site securely.</p><p>We use this data to operate your account, process payments, prevent fraud, and meet legal obligations. We do not sell your personal data. Payment details you submit for withdrawals are stored encrypted and shown only to staff who process your request.</p><p>You may ask support at any time what data we hold about you, and to correct or delete it where the law allows. Continued use of the site after an update to this policy means you accept the updated policy.</p>'],
];

const NOTIF_TEMPLATES = [
  ['email', 'welcome', 'Welcome to {{site}}', 'Hi {{name}}, your account is ready. Good luck!', 1],
  ['email', 'deposit_approved', 'Deposit approved', 'Hi {{name}}, your deposit of {{amount}} has been approved and credited.', 1],
  ['email', 'deposit_rejected', 'Deposit rejected', 'Hi {{name}}, your deposit of {{amount}} was rejected. The amount was not credited.', 1],
  ['email', 'deposit_revoked', 'Deposit reversed', 'Hi {{name}}, your deposit of {{amount}} was reversed by the payment provider (refund or chargeback), so the credited amount has been removed from your balance.', 1],
  ['email', 'approval_rejected', 'Approval request rejected', 'Hi {{name}}, your approval request for {{action}} ({{amount}}) was rejected by a second approver.', 1],
  ['email', 'draw_cancelled', 'Draw cancelled — stake refunded', 'Hi {{name}}, a draw you entered was cancelled and your stake for that draw was refunded to your wallet.', 1],
  ['email', 'withdrawal_decided', 'Withdrawal {{status}}', 'Hi {{name}}, your withdrawal of {{amount}} was {{status}}.', 1],
  ['email', 'win', 'You won {{amount}}!', 'Congratulations {{name}}! You won {{amount}} on ticket {{ticket}}.', 1],
  ['email', 'otp', 'Your signup code', 'Your signup code is {{code}}. It expires in {{minutes}} minutes.', 1],
  // Login OTP emails were broken out of the box: lib/otp.js sends slug
  // 'otp_login', but no such template was ever seeded, so every email login
  // code was silently 'skipped' and never delivered.
  ['email', 'otp_login', 'Your login code', 'Your login code is {{code}}. It expires in 10 minutes.', 1],
  // H1-07 (v23): purpose-specific OTP templates — a withdrawal code must
  // never call itself a login/signup code (lib/otp.js picks the slug by
  // purpose: otp_login / otp_withdrawal / otp_verify).
  ['email', 'otp_withdrawal', 'Your withdrawal code', 'Your withdrawal code is {{code}}. It expires in 10 minutes.', 1],
  ['email', 'otp_verify', 'Your verification code', 'Your verification code is {{code}}. It expires in 10 minutes.', 1],
  ['sms', 'otp_login', '', 'Your login code is {{code}}. Expires in {{minutes}} min.', 1],
  ['sms', 'otp_withdrawal', '', 'Your withdrawal code is {{code}}. Expires in {{minutes}} min.', 1],
  ['sms', 'otp_verify', '', 'Your verification code is {{code}}. Expires in {{minutes}} min.', 1],
  // Support replies were likewise template-less: admin.js sends
  // 'support_reply' on every staff reply, which was silently skipped.
  ['email', 'support_reply', 'Reply to your support ticket', 'Hi {{name}}, support replied to your ticket "{{subject}}". Please sign in to read the reply.', 1],
  ['email', 'password_reset', 'Reset your password', 'Hi {{name}}, reset your password here: {{link}}. This link expires in 1 hour.', 1],
  ['email', 'email_verification', 'Verify your email', 'Hi {{name}}, verify your email for {{site}} here: {{link}}. This link expires in 24 hours.', 1],
  ['sms', 'otp', '', 'Your signup code is {{code}}. Expires in {{minutes}} min.', 1],
  ['sms', 'win', '', 'Congrats {{name}}! You won {{amount}} on {{site}}.', 1],
  ['push', 'win', 'You won {{amount}}!', 'Ticket {{ticket}} just won {{amount}}.', 1],
];

const EXTENSIONS = [
  ['custom_captcha', 'Custom Captcha', 0, {}],
  ['recaptcha', 'Google reCAPTCHA', 0, { site_key: '', secret_key: '' }],
  ['google_analytics', 'Google Analytics', 0, { tracking_id: '' }],
  ['tawkto', 'Tawk.to Live Chat', 0, { embed_code: '' }],
  ['fb_comments', 'Facebook Comments', 0, { app_id: '' }],
  ['hcaptcha', 'hCaptcha', 0, { site_key: '', secret_key: '' }],
  ['turnstile', 'Cloudflare Turnstile', 0, { site_key: '', secret_key: '' }],
];

const CRON_JOBS = [
  ['Draw scheduler', 'ensure_draws', 5, 'Creates upcoming Day/Evening draws and settles closed ones.'],
  ['Session cleanup', 'clean_sessions', 60, 'Removes expired sessions.'],
  ['Deposit expiry', 'expire_deposits', 60, 'Expires stale pending deposits.'],
  ['Notification batches', 'process_notifications', 5, 'Sends queued notification batches (cooling-period spaced).'],
  ['Ledger reconciliation', 'reconcile_ledger', 1440, 'Nightly: wallets == ledger per user/currency, plus PSP-confirmation gaps. Mismatches raise an audit row + report.'],
  ['Token cleanup', 'clean_tokens', 60, 'Removes expired login OTPs, password-reset tokens and signup codes.'],
  ['Agent commission settlement', 'settle_agent_commissions', 1440, 'Daily: settles accrued agent commissions to agent wallets through the ledger (CAS-guarded; the admin button remains as manual backup).'],
  ['Scratch lifecycle', 'scratch_lifecycle', 5, 'Activates scheduled series, stops series past their end date, closes sold-out series, and (when enabled) auto-creates the next series from the operator template.'],
  ['Bonus campaign drops', 'run_bonus_campaigns', 5, 'Fires scheduled bonus campaign drops whose validity window has opened.'],
  ['Database backup', 'backup_db', 1440, 'Daily SQLite snapshot (VACUUM INTO) into the backups folder next to the database, keeping the last 7. On Postgres/MySQL the platform manages backups.'],
];

const MIGRATIONS = [
  {
    version: 1, name: 'core schema',
    sqlite: `
CREATE TABLE IF NOT EXISTS migrations_applied (version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, phone TEXT DEFAULT '',
  name TEXT NOT NULL, password_hash TEXT, role TEXT NOT NULL DEFAULT 'player',
  status TEXT NOT NULL DEFAULT 'active', email_verified INTEGER DEFAULT 0,
  mobile_verified INTEGER DEFAULT 0, kyc_status TEXT DEFAULT 'none',
  deposit_blocked INTEGER DEFAULT 0, withdrawal_blocked INTEGER DEFAULT 0,
  deposit_mode TEXT DEFAULT '', withdrawal_mode TEXT DEFAULT '',
  totp_secret TEXT DEFAULT '', backup_codes TEXT DEFAULT '[]',
  display_currency TEXT DEFAULT '', agent_id INTEGER, country TEXT DEFAULT '',
  notes TEXT DEFAULT '', last_login_at INTEGER, last_login_ip TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  facebook_id TEXT DEFAULT '', google_id TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code_hash TEXT NOT NULL, label TEXT DEFAULT '',
  max_uses INTEGER DEFAULT 1, uses INTEGER DEFAULT 0, expires_at INTEGER,
  created_by INTEGER, revoked INTEGER DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_otps (
  id INTEGER PRIMARY KEY AUTOINCREMENT, identifier TEXT NOT NULL, id_type TEXT NOT NULL,
  code_hash TEXT NOT NULL, attempts INTEGER DEFAULT 0, verified INTEGER DEFAULT 0,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_login_otps_ident ON login_otps (identifier, id_type);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, data TEXT DEFAULT '{}',
  ip TEXT DEFAULT '', user_agent TEXT DEFAULT '', expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS wallets (
  user_id INTEGER NOT NULL, currency TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, currency));
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, currency TEXT NOT NULL,
  type TEXT NOT NULL, amount INTEGER NOT NULL, balance_after INTEGER NOT NULL,
  ref_type TEXT DEFAULT '', ref_id TEXT DEFAULT '', meta TEXT DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions (user_id, created_at);
CREATE TABLE IF NOT EXISTS payment_methods (
  id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL DEFAULT 'both',
  name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, rail TEXT NOT NULL DEFAULT 'manual',
  logo_url TEXT DEFAULT '', currency TEXT NOT NULL DEFAULT 'USD', rate REAL DEFAULT 1,
  min_amount INTEGER DEFAULT 0, max_amount INTEGER DEFAULT 0,
  fixed_charge INTEGER DEFAULT 0, percent_charge REAL DEFAULT 0,
  instruction TEXT DEFAULT '', custom_fields TEXT DEFAULT '[]',
  enabled INTEGER DEFAULT 0, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS gateway_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT, method_id INTEGER NOT NULL,
  field_key TEXT NOT NULL, field_value TEXT DEFAULT '', updated_at INTEGER,
  UNIQUE (method_id, field_key));
CREATE TABLE IF NOT EXISTS global_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
  field_key TEXT NOT NULL, field_value TEXT DEFAULT '', field_enc INTEGER DEFAULT 0, updated_at INTEGER,
  UNIQUE (scope, field_key));
CREATE TABLE IF NOT EXISTS deposits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, public_id TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL, method_id INTEGER, currency TEXT NOT NULL,
  amount INTEGER NOT NULL, charge INTEGER DEFAULT 0, net INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', user_data TEXT DEFAULT '{}',
  admin_note TEXT DEFAULT '', idempotency_key TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL, decided_at INTEGER, decided_by INTEGER);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, public_id TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL, method_id INTEGER, currency TEXT NOT NULL,
  amount INTEGER NOT NULL, charge INTEGER DEFAULT 0, net INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', user_data TEXT DEFAULT '{}',
  admin_note TEXT DEFAULT '', idempotency_key TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL, decided_at INTEGER, decided_by INTEGER);
CREATE TABLE IF NOT EXISTS draws (
  id INTEGER PRIMARY KEY AUTOINCREMENT, draw_type TEXT NOT NULL,
  draw_date TEXT NOT NULL, close_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled',
  seed_hash TEXT NOT NULL, seed TEXT DEFAULT '', winning_number INTEGER,
  is_test INTEGER DEFAULT 0, override_by INTEGER, created_at INTEGER NOT NULL,
  UNIQUE (draw_type, draw_date));
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, public_id TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL, currency TEXT NOT NULL, pops TEXT NOT NULL,
  wager INTEGER NOT NULL, num_draws INTEGER NOT NULL, draw_type TEXT NOT NULL,
  draw_ids TEXT NOT NULL DEFAULT '[]', total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', hmac TEXT NOT NULL,
  ip TEXT DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ticket_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL, draw_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', win_amount INTEGER DEFAULT 0, settled_at INTEGER,
  UNIQUE (ticket_id, draw_id));
CREATE TABLE IF NOT EXISTS prize_table (pops_count INTEGER PRIMARY KEY, multiplier INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  ticket_id INTEGER, currency TEXT NOT NULL, amount INTEGER NOT NULL, rate REAL NOT NULL,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS agent_floats (
  agent_id INTEGER NOT NULL, currency TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, currency));
CREATE TABLE IF NOT EXISTS agent_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT, from_agent INTEGER NOT NULL, to_user INTEGER NOT NULL,
  currency TEXT NOT NULL, amount INTEGER NOT NULL, note TEXT DEFAULT '',
  created_at INTEGER NOT NULL, created_by INTEGER);
CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, public_id TEXT UNIQUE NOT NULL,
  user_id INTEGER NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS support_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL,
  author_id INTEGER NOT NULL, author_role TEXT NOT NULL DEFAULT 'player',
  body TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL, meta_title TEXT DEFAULT '', meta_desc TEXT DEFAULT '',
  body TEXT DEFAULT '', status TEXT DEFAULT 'published', sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS content_blocks (key TEXT PRIMARY KEY, title TEXT, body TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS notif_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, slug TEXT NOT NULL,
  subject TEXT DEFAULT '', body TEXT NOT NULL, enabled INTEGER DEFAULT 1,
  UNIQUE (channel, slug));
CREATE TABLE IF NOT EXISTS notifications_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, to_addr TEXT DEFAULT '',
  subject TEXT DEFAULT '', body TEXT DEFAULT '', status TEXT DEFAULT 'queued',
  error TEXT DEFAULT '', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS extensions (
  key TEXT PRIMARY KEY, name TEXT NOT NULL, enabled INTEGER DEFAULT 0,
  config TEXT DEFAULT '{}', updated_at INTEGER);
CREATE TABLE IF NOT EXISTS cron_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, handler_key TEXT UNIQUE NOT NULL,
  interval_minutes INTEGER DEFAULT 60, last_run_at INTEGER, next_run_at INTEGER,
  last_status TEXT DEFAULT '', last_message TEXT DEFAULT '', status TEXT DEFAULT 'active',
  description TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, actor_role TEXT DEFAULT '',
  action TEXT NOT NULL, entity TEXT DEFAULT '', entity_id TEXT DEFAULT '',
  detail TEXT DEFAULT '{}', ip TEXT DEFAULT '', created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log (created_at);
CREATE TABLE IF NOT EXISTS login_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, email TEXT DEFAULT '',
  ip TEXT DEFAULT '', country TEXT DEFAULT '', browser TEXT DEFAULT '',
  os TEXT DEFAULT '', success INTEGER DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, token_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL, used INTEGER DEFAULT 0, created_at INTEGER NOT NULL);
`,
    postgres: `
CREATE TABLE IF NOT EXISTS migrations_applied (version BIGINT PRIMARY KEY, name TEXT, applied_at BIGINT);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at BIGINT);
CREATE TABLE IF NOT EXISTS users (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, email TEXT UNIQUE NOT NULL, phone TEXT DEFAULT '',
  name TEXT NOT NULL, password_hash TEXT, role TEXT NOT NULL DEFAULT 'player',
  status TEXT NOT NULL DEFAULT 'active', email_verified BIGINT DEFAULT 0,
  mobile_verified BIGINT DEFAULT 0, kyc_status TEXT DEFAULT 'none',
  deposit_blocked BIGINT DEFAULT 0, withdrawal_blocked BIGINT DEFAULT 0,
  deposit_mode TEXT DEFAULT '', withdrawal_mode TEXT DEFAULT '',
  totp_secret TEXT DEFAULT '', backup_codes TEXT DEFAULT '[]',
  display_currency TEXT DEFAULT '', agent_id BIGINT, country TEXT DEFAULT '',
  notes TEXT DEFAULT '', last_login_at BIGINT, last_login_ip TEXT DEFAULT '',
  created_at BIGINT NOT NULL,
  facebook_id TEXT DEFAULT '', google_id TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS otp_codes (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, code_hash TEXT NOT NULL, label TEXT DEFAULT '',
  max_uses BIGINT DEFAULT 1, uses BIGINT DEFAULT 0, expires_at BIGINT,
  created_by BIGINT, revoked BIGINT DEFAULT 0, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS login_otps (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, identifier TEXT NOT NULL, id_type TEXT NOT NULL,
  code_hash TEXT NOT NULL, attempts BIGINT DEFAULT 0, verified BIGINT DEFAULT 0,
  expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_login_otps_ident ON login_otps (identifier, id_type);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id BIGINT NOT NULL, data TEXT DEFAULT '{}',
  ip TEXT DEFAULT '', user_agent TEXT DEFAULT '', expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS wallets (
  user_id BIGINT NOT NULL, currency TEXT NOT NULL, balance BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, currency));
CREATE TABLE IF NOT EXISTS transactions (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL, currency TEXT NOT NULL,
  type TEXT NOT NULL, amount BIGINT NOT NULL, balance_after BIGINT NOT NULL,
  ref_type TEXT DEFAULT '', ref_id TEXT DEFAULT '', meta TEXT DEFAULT '{}', created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions (user_id, created_at);
CREATE TABLE IF NOT EXISTS payment_methods (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'both',
  name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, rail TEXT NOT NULL DEFAULT 'manual',
  logo_url TEXT DEFAULT '', currency TEXT NOT NULL DEFAULT 'USD', rate DOUBLE PRECISION DEFAULT 1,
  min_amount BIGINT DEFAULT 0, max_amount BIGINT DEFAULT 0,
  fixed_charge BIGINT DEFAULT 0, percent_charge DOUBLE PRECISION DEFAULT 0,
  instruction TEXT DEFAULT '', custom_fields TEXT DEFAULT '[]',
  enabled BIGINT DEFAULT 0, sort BIGINT DEFAULT 0);
CREATE TABLE IF NOT EXISTS gateway_credentials (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, method_id BIGINT NOT NULL,
  field_key TEXT NOT NULL, field_value TEXT DEFAULT '', updated_at BIGINT,
  UNIQUE (method_id, field_key));
CREATE TABLE IF NOT EXISTS global_credentials (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, scope TEXT NOT NULL,
  field_key TEXT NOT NULL, field_value TEXT DEFAULT '', field_enc BIGINT DEFAULT 0, updated_at BIGINT,
  UNIQUE (scope, field_key));
CREATE TABLE IF NOT EXISTS deposits (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, public_id TEXT UNIQUE NOT NULL,
  user_id BIGINT NOT NULL, method_id BIGINT, currency TEXT NOT NULL,
  amount BIGINT NOT NULL, charge BIGINT DEFAULT 0, net BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', user_data TEXT DEFAULT '{}',
  admin_note TEXT DEFAULT '', idempotency_key TEXT UNIQUE NOT NULL,
  created_at BIGINT NOT NULL, decided_at BIGINT, decided_by BIGINT);
CREATE TABLE IF NOT EXISTS withdrawals (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, public_id TEXT UNIQUE NOT NULL,
  user_id BIGINT NOT NULL, method_id BIGINT, currency TEXT NOT NULL,
  amount BIGINT NOT NULL, charge BIGINT DEFAULT 0, net BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', user_data TEXT DEFAULT '{}',
  admin_note TEXT DEFAULT '', idempotency_key TEXT UNIQUE NOT NULL,
  created_at BIGINT NOT NULL, decided_at BIGINT, decided_by BIGINT);
CREATE TABLE IF NOT EXISTS draws (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, draw_type TEXT NOT NULL,
  draw_date TEXT NOT NULL, close_at BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled',
  seed_hash TEXT NOT NULL, seed TEXT DEFAULT '', winning_number BIGINT,
  is_test BIGINT DEFAULT 0, override_by BIGINT, created_at BIGINT NOT NULL,
  UNIQUE (draw_type, draw_date));
CREATE TABLE IF NOT EXISTS tickets (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, public_id TEXT UNIQUE NOT NULL,
  user_id BIGINT NOT NULL, currency TEXT NOT NULL, pops TEXT NOT NULL,
  wager BIGINT NOT NULL, num_draws BIGINT NOT NULL, draw_type TEXT NOT NULL,
  draw_ids TEXT NOT NULL DEFAULT '[]', total BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', hmac TEXT NOT NULL,
  ip TEXT DEFAULT '', created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS ticket_entries (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, ticket_id BIGINT NOT NULL, draw_id BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', win_amount BIGINT DEFAULT 0, settled_at BIGINT,
  UNIQUE (ticket_id, draw_id));
CREATE TABLE IF NOT EXISTS prize_table (pops_count BIGINT PRIMARY KEY, multiplier BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS commissions (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, agent_id BIGINT NOT NULL, user_id BIGINT NOT NULL,
  ticket_id BIGINT, currency TEXT NOT NULL, amount BIGINT NOT NULL, rate DOUBLE PRECISION NOT NULL,
  created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_floats (
  agent_id BIGINT NOT NULL, currency TEXT NOT NULL, balance BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, currency));
CREATE TABLE IF NOT EXISTS agent_transfers (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, from_agent BIGINT NOT NULL, to_user BIGINT NOT NULL,
  currency TEXT NOT NULL, amount BIGINT NOT NULL, note TEXT DEFAULT '',
  created_at BIGINT NOT NULL, created_by BIGINT);
CREATE TABLE IF NOT EXISTS support_tickets (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, public_id TEXT UNIQUE NOT NULL,
  user_id BIGINT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS support_messages (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, ticket_id BIGINT NOT NULL,
  author_id BIGINT NOT NULL, author_role TEXT NOT NULL DEFAULT 'player',
  body TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS pages (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL, meta_title TEXT DEFAULT '', meta_desc TEXT DEFAULT '',
  body TEXT DEFAULT '', status TEXT DEFAULT 'published', sort BIGINT DEFAULT 0);
CREATE TABLE IF NOT EXISTS content_blocks (key TEXT PRIMARY KEY, title TEXT, body TEXT, updated_at BIGINT);
CREATE TABLE IF NOT EXISTS notif_templates (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, channel TEXT NOT NULL, slug TEXT NOT NULL,
  subject TEXT DEFAULT '', body TEXT NOT NULL, enabled BIGINT DEFAULT 1,
  UNIQUE (channel, slug));
CREATE TABLE IF NOT EXISTS notifications_log (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, channel TEXT NOT NULL, to_addr TEXT DEFAULT '',
  subject TEXT DEFAULT '', body TEXT DEFAULT '', status TEXT DEFAULT 'queued',
  error TEXT DEFAULT '', created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS extensions (
  key TEXT PRIMARY KEY, name TEXT NOT NULL, enabled BIGINT DEFAULT 0,
  config TEXT DEFAULT '{}', updated_at BIGINT);
CREATE TABLE IF NOT EXISTS cron_jobs (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name TEXT NOT NULL, handler_key TEXT UNIQUE NOT NULL,
  interval_minutes BIGINT DEFAULT 60, last_run_at BIGINT, next_run_at BIGINT,
  last_status TEXT DEFAULT '', last_message TEXT DEFAULT '', status TEXT DEFAULT 'active',
  description TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, actor_id BIGINT, actor_role TEXT DEFAULT '',
  action TEXT NOT NULL, entity TEXT DEFAULT '', entity_id TEXT DEFAULT '',
  detail TEXT DEFAULT '{}', ip TEXT DEFAULT '', created_at BIGINT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log (created_at);
CREATE TABLE IF NOT EXISTS login_history (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, user_id BIGINT, email TEXT DEFAULT '',
  ip TEXT DEFAULT '', country TEXT DEFAULT '', browser TEXT DEFAULT '',
  os TEXT DEFAULT '', success BIGINT DEFAULT 0, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS password_resets (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL, token_hash TEXT NOT NULL,
  expires_at BIGINT NOT NULL, used BIGINT DEFAULT 0, created_at BIGINT NOT NULL);
`,
    mysql: `
CREATE TABLE IF NOT EXISTS migrations_applied (version INT PRIMARY KEY, name VARCHAR(255), applied_at BIGINT);
CREATE TABLE IF NOT EXISTS settings (\`key\` VARCHAR(191) PRIMARY KEY, value TEXT NOT NULL, updated_at BIGINT);
CREATE TABLE IF NOT EXISTS users (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL, phone VARCHAR(64) DEFAULT '',
  name VARCHAR(255) NOT NULL, password_hash TEXT, role VARCHAR(32) NOT NULL DEFAULT 'player',
  status VARCHAR(32) NOT NULL DEFAULT 'active', email_verified TINYINT DEFAULT 0,
  mobile_verified TINYINT DEFAULT 0, kyc_status VARCHAR(32) DEFAULT 'none',
  deposit_blocked TINYINT DEFAULT 0, withdrawal_blocked TINYINT DEFAULT 0,
  deposit_mode VARCHAR(16) DEFAULT '', withdrawal_mode VARCHAR(16) DEFAULT '',
  totp_secret VARCHAR(128) DEFAULT '', backup_codes TEXT,
  display_currency VARCHAR(8) DEFAULT '', agent_id BIGINT, country VARCHAR(64) DEFAULT '',
  notes TEXT, last_login_at BIGINT, last_login_ip VARCHAR(64) DEFAULT '',
  created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS otp_codes (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, code_hash VARCHAR(255) NOT NULL, label VARCHAR(255) DEFAULT '',
  max_uses INT DEFAULT 1, uses INT DEFAULT 0, expires_at BIGINT,
  created_by BIGINT, revoked TINYINT DEFAULT 0, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id VARCHAR(128) PRIMARY KEY, user_id BIGINT NOT NULL, data TEXT,
  ip VARCHAR(64) DEFAULT '', user_agent VARCHAR(255) DEFAULT '', expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS wallets (
  user_id BIGINT NOT NULL, currency VARCHAR(8) NOT NULL, balance BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, currency));
CREATE TABLE IF NOT EXISTS transactions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id BIGINT NOT NULL, currency VARCHAR(8) NOT NULL,
  type VARCHAR(64) NOT NULL, amount BIGINT NOT NULL, balance_after BIGINT NOT NULL,
  ref_type VARCHAR(64) DEFAULT '', ref_id VARCHAR(128) DEFAULT '', meta TEXT, created_at BIGINT NOT NULL,
  INDEX idx_tx_user (user_id, created_at));
CREATE TABLE IF NOT EXISTS payment_methods (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, kind VARCHAR(16) NOT NULL DEFAULT 'both',
  name VARCHAR(255) NOT NULL, slug VARCHAR(191) UNIQUE NOT NULL, rail VARCHAR(64) NOT NULL DEFAULT 'manual',
  logo_url VARCHAR(512) DEFAULT '', currency VARCHAR(8) NOT NULL DEFAULT 'USD', rate DOUBLE DEFAULT 1,
  min_amount BIGINT DEFAULT 0, max_amount BIGINT DEFAULT 0,
  fixed_charge BIGINT DEFAULT 0, percent_charge DOUBLE DEFAULT 0,
  instruction TEXT, custom_fields TEXT,
  enabled TINYINT DEFAULT 0, sort INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS gateway_credentials (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, method_id BIGINT NOT NULL,
  field_key VARCHAR(128) NOT NULL, field_value TEXT, updated_at BIGINT,
  UNIQUE KEY uq_method_field (method_id, field_key));
CREATE TABLE IF NOT EXISTS global_credentials (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, scope VARCHAR(64) NOT NULL,
  field_key VARCHAR(128) NOT NULL, field_value TEXT, field_enc TINYINT DEFAULT 0, updated_at BIGINT,
  UNIQUE KEY uq_scope_field (scope, field_key));
CREATE TABLE IF NOT EXISTS deposits (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, public_id VARCHAR(64) UNIQUE NOT NULL,
  user_id BIGINT NOT NULL, method_id BIGINT, currency VARCHAR(8) NOT NULL,
  amount BIGINT NOT NULL, charge BIGINT DEFAULT 0, net BIGINT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending', user_data TEXT,
  admin_note TEXT, idempotency_key VARCHAR(128) UNIQUE NOT NULL,
  created_at BIGINT NOT NULL, decided_at BIGINT, decided_by BIGINT);
CREATE TABLE IF NOT EXISTS withdrawals (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, public_id VARCHAR(64) UNIQUE NOT NULL,
  user_id BIGINT NOT NULL, method_id BIGINT, currency VARCHAR(8) NOT NULL,
  amount BIGINT NOT NULL, charge BIGINT DEFAULT 0, net BIGINT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending', user_data TEXT,
  admin_note TEXT, idempotency_key VARCHAR(128) UNIQUE NOT NULL,
  created_at BIGINT NOT NULL, decided_at BIGINT, decided_by BIGINT);
CREATE TABLE IF NOT EXISTS draws (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, draw_type VARCHAR(16) NOT NULL,
  draw_date VARCHAR(16) NOT NULL, close_at BIGINT NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'scheduled',
  seed_hash VARCHAR(128) NOT NULL, seed VARCHAR(128) DEFAULT '', winning_number INT,
  is_test TINYINT DEFAULT 0, override_by BIGINT, created_at BIGINT NOT NULL,
  UNIQUE KEY uq_draw (draw_type, draw_date));
CREATE TABLE IF NOT EXISTS tickets (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, public_id VARCHAR(64) UNIQUE NOT NULL,
  user_id BIGINT NOT NULL, currency VARCHAR(8) NOT NULL, pops TEXT NOT NULL,
  wager BIGINT NOT NULL, num_draws INTEGER NOT NULL, draw_type VARCHAR(8) NOT NULL,
  draw_ids TEXT, total BIGINT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active', hmac VARCHAR(128) NOT NULL,
  ip VARCHAR(64) DEFAULT '', created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS ticket_entries (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, ticket_id BIGINT NOT NULL, draw_id BIGINT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending', win_amount BIGINT DEFAULT 0, settled_at BIGINT,
  UNIQUE KEY uq_ticket_draw (ticket_id, draw_id));
CREATE TABLE IF NOT EXISTS prize_table (pops_count INT PRIMARY KEY, multiplier INT NOT NULL);
CREATE TABLE IF NOT EXISTS commissions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, agent_id BIGINT NOT NULL, user_id BIGINT NOT NULL,
  ticket_id BIGINT, currency VARCHAR(8) NOT NULL, amount BIGINT NOT NULL, rate DOUBLE NOT NULL,
  created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_floats (
  agent_id BIGINT NOT NULL, currency VARCHAR(8) NOT NULL, balance BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, currency));
CREATE TABLE IF NOT EXISTS agent_transfers (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, from_agent BIGINT NOT NULL, to_user BIGINT NOT NULL,
  currency VARCHAR(8) NOT NULL, amount BIGINT NOT NULL, note TEXT,
  created_at BIGINT NOT NULL, created_by BIGINT);
CREATE TABLE IF NOT EXISTS support_tickets (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, public_id VARCHAR(64) UNIQUE NOT NULL,
  user_id BIGINT NOT NULL, subject VARCHAR(255) NOT NULL, status VARCHAR(32) NOT NULL DEFAULT 'open',
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS support_messages (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, ticket_id BIGINT NOT NULL,
  author_id BIGINT NOT NULL, author_role VARCHAR(32) NOT NULL DEFAULT 'player',
  body TEXT NOT NULL, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS pages (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL, slug VARCHAR(191) UNIQUE NOT NULL,
  title VARCHAR(255) NOT NULL, meta_title VARCHAR(255) DEFAULT '', meta_desc VARCHAR(512) DEFAULT '',
  body MEDIUMTEXT, status VARCHAR(32) DEFAULT 'published', sort INT DEFAULT 0);
CREATE TABLE IF NOT EXISTS content_blocks (\`key\` VARCHAR(191) PRIMARY KEY, title VARCHAR(255), body MEDIUMTEXT, updated_at BIGINT);
CREATE TABLE IF NOT EXISTS notif_templates (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, channel VARCHAR(16) NOT NULL, slug VARCHAR(191) NOT NULL,
  subject VARCHAR(255) DEFAULT '', body TEXT NOT NULL, enabled TINYINT DEFAULT 1,
  UNIQUE KEY uq_channel_slug (channel, slug));
CREATE TABLE IF NOT EXISTS notifications_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, channel VARCHAR(16) NOT NULL, to_addr VARCHAR(255) DEFAULT '',
  subject VARCHAR(255) DEFAULT '', body TEXT, status VARCHAR(32) DEFAULT 'queued',
  error TEXT, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS extensions (
  \`key\` VARCHAR(64) PRIMARY KEY, name VARCHAR(255) NOT NULL, enabled TINYINT DEFAULT 0,
  config TEXT, updated_at BIGINT);
CREATE TABLE IF NOT EXISTS cron_jobs (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL, handler_key VARCHAR(64) UNIQUE NOT NULL,
  interval_minutes INT DEFAULT 60, last_run_at BIGINT, next_run_at BIGINT,
  last_status VARCHAR(32) DEFAULT '', last_message TEXT, status VARCHAR(32) DEFAULT 'active',
  description TEXT);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, actor_id BIGINT, actor_role VARCHAR(32) DEFAULT '',
  action VARCHAR(128) NOT NULL, entity VARCHAR(64) DEFAULT '', entity_id VARCHAR(128) DEFAULT '',
  detail TEXT, ip VARCHAR(64) DEFAULT '', created_at BIGINT NOT NULL,
  INDEX idx_audit_time (created_at));
CREATE TABLE IF NOT EXISTS login_history (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id BIGINT, email VARCHAR(255) DEFAULT '',
  ip VARCHAR(64) DEFAULT '', country VARCHAR(64) DEFAULT '', browser VARCHAR(64) DEFAULT '',
  os VARCHAR(64) DEFAULT '', success TINYINT DEFAULT 0, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS password_resets (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id BIGINT NOT NULL, token_hash VARCHAR(255) NOT NULL,
  expires_at BIGINT NOT NULL, used TINYINT DEFAULT 0, created_at BIGINT NOT NULL);
`,
  },
  {
    version: 2, name: 'fix prize table economics',
    sqlite: `
UPDATE prize_table SET multiplier = CASE pops_count
  WHEN 1 THEN 13 WHEN 2 THEN 13 WHEN 3 THEN 12 WHEN 4 THEN 11 WHEN 5 THEN 10
  WHEN 6 THEN 9 WHEN 7 THEN 9 WHEN 8 THEN 8 WHEN 9 THEN 8 WHEN 10 THEN 7
  WHEN 11 THEN 7 WHEN 12 THEN 6 WHEN 13 THEN 6 WHEN 14 THEN 6 WHEN 15 THEN 5
  ELSE multiplier END
WHERE (pops_count, multiplier) IN (
  (1,250),(2,100),(3,60),(4,40),(5,30),(6,25),(7,20),
  (8,15),(9,12),(10,10),(11,9),(12,8),(13,7),(14,6),(15,5));
`,
    postgres: `
UPDATE prize_table SET multiplier = CASE pops_count
  WHEN 1 THEN 13 WHEN 2 THEN 13 WHEN 3 THEN 12 WHEN 4 THEN 11 WHEN 5 THEN 10
  WHEN 6 THEN 9 WHEN 7 THEN 9 WHEN 8 THEN 8 WHEN 9 THEN 8 WHEN 10 THEN 7
  WHEN 11 THEN 7 WHEN 12 THEN 6 WHEN 13 THEN 6 WHEN 14 THEN 6 WHEN 15 THEN 5
  ELSE multiplier END
WHERE (pops_count, multiplier) IN (
  (1,250),(2,100),(3,60),(4,40),(5,30),(6,25),(7,20),
  (8,15),(9,12),(10,10),(11,9),(12,8),(13,7),(14,6),(15,5));
`,
    mysql: `
UPDATE prize_table SET multiplier = CASE pops_count
  WHEN 1 THEN 13 WHEN 2 THEN 13 WHEN 3 THEN 12 WHEN 4 THEN 11 WHEN 5 THEN 10
  WHEN 6 THEN 9 WHEN 7 THEN 9 WHEN 8 THEN 8 WHEN 9 THEN 8 WHEN 10 THEN 7
  WHEN 11 THEN 7 WHEN 12 THEN 6 WHEN 13 THEN 6 WHEN 14 THEN 6 WHEN 15 THEN 5
  ELSE multiplier END
WHERE (pops_count, multiplier) IN (
  (1,250),(2,100),(3,60),(4,40),(5,30),(6,25),(7,20),
  (8,15),(9,12),(10,10),(11,9),(12,8),(13,7),(14,6),(15,5));
`,
  },
  {
    version: 3, name: 'viserlab-gap features: referrals, ticket priority, maintenance, referral settings',
    sqlite: `
      ALTER TABLE users ADD COLUMN referred_by INTEGER DEFAULT NULL;
      ALTER TABLE users ADD COLUMN referral_code TEXT DEFAULT '';
      ALTER TABLE support_tickets ADD COLUMN priority TEXT DEFAULT 'medium';
      INSERT OR IGNORE INTO settings (key, value) VALUES ('maintenance_mode', '0');
      INSERT OR IGNORE INTO settings (key, value) VALUES ('referral_enabled', '0');
      INSERT OR IGNORE INTO settings (key, value) VALUES ('referral_rate', '5');
    `,
    postgres: `
      ALTER TABLE users ADD COLUMN referred_by BIGINT DEFAULT NULL;
      ALTER TABLE users ADD COLUMN referral_code TEXT DEFAULT '';
      ALTER TABLE support_tickets ADD COLUMN priority TEXT DEFAULT 'medium';
      INSERT INTO settings (key, value) VALUES ('maintenance_mode', '0') ON CONFLICT (key) DO NOTHING;
      INSERT INTO settings (key, value) VALUES ('referral_enabled', '0') ON CONFLICT (key) DO NOTHING;
      INSERT INTO settings (key, value) VALUES ('referral_rate', '5') ON CONFLICT (key) DO NOTHING;
    `,
    mysql: `
      ALTER TABLE users ADD COLUMN referred_by BIGINT DEFAULT NULL;
      ALTER TABLE users ADD COLUMN referral_code VARCHAR(32) DEFAULT '';
      ALTER TABLE support_tickets ADD COLUMN priority VARCHAR(16) DEFAULT 'medium';
      INSERT IGNORE INTO settings (\`key\`, value) VALUES ('maintenance_mode', '0');
      INSERT IGNORE INTO settings (\`key\`, value) VALUES ('referral_enabled', '0');
      INSERT IGNORE INTO settings (\`key\`, value) VALUES ('referral_rate', '5');
    `,
  },
  {
    version: 4, name: 'admin rebuild: user address fields + notification batch queue',
    sqlite: `
      ALTER TABLE users ADD COLUMN address TEXT DEFAULT '';
      ALTER TABLE users ADD COLUMN city TEXT DEFAULT '';
      ALTER TABLE users ADD COLUMN state TEXT DEFAULT '';
      ALTER TABLE users ADD COLUMN zip TEXT DEFAULT '';
      ALTER TABLE notifications_log ADD COLUMN batch_no INTEGER DEFAULT 0;
      ALTER TABLE notifications_log ADD COLUMN scheduled_at INTEGER DEFAULT 0;
    `,
    postgres: `
      ALTER TABLE users ADD COLUMN address TEXT DEFAULT '';
      ALTER TABLE users ADD COLUMN city TEXT DEFAULT '';
      ALTER TABLE users ADD COLUMN state TEXT DEFAULT '';
      ALTER TABLE users ADD COLUMN zip TEXT DEFAULT '';
      ALTER TABLE notifications_log ADD COLUMN batch_no BIGINT DEFAULT 0;
      ALTER TABLE notifications_log ADD COLUMN scheduled_at BIGINT DEFAULT 0;
    `,
    mysql: `
      ALTER TABLE users ADD COLUMN address TEXT DEFAULT '';
      ALTER TABLE users ADD COLUMN city VARCHAR(128) DEFAULT '';
      ALTER TABLE users ADD COLUMN state VARCHAR(128) DEFAULT '';
      ALTER TABLE users ADD COLUMN zip VARCHAR(32) DEFAULT '';
      ALTER TABLE notifications_log ADD COLUMN batch_no INT DEFAULT 0;
      ALTER TABLE notifications_log ADD COLUMN scheduled_at BIGINT DEFAULT 0;
    `,
  },
  {
    version: 5, name: 'footer contact email correction attempt (wrong table — no-op, superseded by v6)',
    sqlite: `
      UPDATE settings SET value = REPLACE(value, 'support@example.com', 'support@cashpop.live') WHERE \`key\` = 'footer_contact';
    `,
    postgres: `
      UPDATE settings SET value = REPLACE(value, 'support@example.com', 'support@cashpop.live') WHERE key = 'footer_contact';
    `,
    mysql: `
      UPDATE settings SET value = REPLACE(value, 'support@example.com', 'support@cashpop.live') WHERE \`key\` = 'footer_contact';
    `,
  },
  {
    version: 6, name: 'footer contact email correction in content_blocks (the real footer source)',
    sqlite: `
      UPDATE content_blocks SET body = REPLACE(body, 'support@example.com', 'support@cashpop.live') WHERE \`key\` = 'footer_contact';
    `,
    postgres: `
      UPDATE content_blocks SET body = REPLACE(body, 'support@example.com', 'support@cashpop.live') WHERE key = 'footer_contact';
    `,
    mysql: `
      UPDATE content_blocks SET body = REPLACE(body, 'support@example.com', 'support@cashpop.live') WHERE \`key\` = 'footer_contact';
    `,
  },
  {
    version: 7, name: 'v14 risk controls: beacon, RBAC, payout lock, maker-checker, reconciliation, flags, referral credits',
    sqlite: `
      ALTER TABLE draws ADD COLUMN beacon_round INTEGER DEFAULT NULL;
      ALTER TABLE draws ADD COLUMN beacon_randomness TEXT DEFAULT '';
      ALTER TABLE draws ADD COLUMN beacon_signature TEXT DEFAULT '';
      ALTER TABLE draws ADD COLUMN beacon_status TEXT DEFAULT '';
      ALTER TABLE users ADD COLUMN admin_role TEXT DEFAULT 'super';
      ALTER TABLE users ADD COLUMN payout_updated_at INTEGER DEFAULT 0;
      ALTER TABLE users ADD COLUMN payout_fingerprint TEXT DEFAULT '';
      ALTER TABLE users ADD COLUMN force_password_reset INTEGER DEFAULT 0;
      ALTER TABLE users ADD COLUMN force_totp_enroll INTEGER DEFAULT 0;
      ALTER TABLE deposits ADD COLUMN provider_txn_id TEXT DEFAULT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_provider_txn ON deposits (provider_txn_id);
      ALTER TABLE withdrawals ADD COLUMN provider_payout_id TEXT DEFAULT '';
      ALTER TABLE withdrawals ADD COLUMN payout_at INTEGER DEFAULT NULL;
      ALTER TABLE commissions ADD COLUMN settled INTEGER DEFAULT 0;
      ALTER TABLE commissions ADD COLUMN settled_at INTEGER DEFAULT NULL;
      ALTER TABLE gateway_credentials ADD COLUMN field_enc INTEGER DEFAULT 0;
      ALTER TABLE audit_log ADD COLUMN prev_hash TEXT DEFAULT '';
      ALTER TABLE audit_log ADD COLUMN hash TEXT DEFAULT '';
      CREATE TABLE IF NOT EXISTS referral_credits (
        id INTEGER PRIMARY KEY AUTOINCREMENT, referrer_id INTEGER NOT NULL, referee_id INTEGER NOT NULL,
        ticket_id INTEGER, currency TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL, released_at INTEGER);
      CREATE TABLE IF NOT EXISTS account_flags (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, flag_type TEXT NOT NULL,
        detail TEXT DEFAULT '{}', created_at INTEGER NOT NULL, reviewed_by INTEGER, reviewed_at INTEGER);
      CREATE TABLE IF NOT EXISTS webhook_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE,
        deposit_id INTEGER, action TEXT DEFAULT '', payload TEXT DEFAULT '', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reconciliation_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT, checked_at INTEGER NOT NULL, wallets_checked INTEGER DEFAULT 0,
        mismatch_count INTEGER DEFAULT 0, details TEXT DEFAULT '{}', created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id INTEGER NOT NULL,
        amount INTEGER NOT NULL, currency TEXT NOT NULL, requested_by INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        decided_by INTEGER, decided_at INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS email_verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, new_email TEXT NOT NULL,
        token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER DEFAULT 0, created_at INTEGER NOT NULL);
    `,
    postgres: `
      ALTER TABLE draws ADD COLUMN beacon_round BIGINT DEFAULT NULL;
      ALTER TABLE draws ADD COLUMN beacon_randomness TEXT DEFAULT '';
      ALTER TABLE draws ADD COLUMN beacon_signature TEXT DEFAULT '';
      ALTER TABLE draws ADD COLUMN beacon_status TEXT DEFAULT '';
      ALTER TABLE users ADD COLUMN admin_role TEXT DEFAULT 'super';
      ALTER TABLE users ADD COLUMN payout_updated_at BIGINT DEFAULT 0;
      ALTER TABLE users ADD COLUMN payout_fingerprint TEXT DEFAULT '';
      ALTER TABLE users ADD COLUMN force_password_reset BIGINT DEFAULT 0;
      ALTER TABLE users ADD COLUMN force_totp_enroll BIGINT DEFAULT 0;
      ALTER TABLE deposits ADD COLUMN provider_txn_id TEXT DEFAULT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deposits_provider_txn ON deposits (provider_txn_id);
      ALTER TABLE withdrawals ADD COLUMN provider_payout_id TEXT DEFAULT '';
      ALTER TABLE withdrawals ADD COLUMN payout_at BIGINT DEFAULT NULL;
      ALTER TABLE commissions ADD COLUMN settled BIGINT DEFAULT 0;
      ALTER TABLE commissions ADD COLUMN settled_at BIGINT DEFAULT NULL;
      ALTER TABLE gateway_credentials ADD COLUMN field_enc BIGINT DEFAULT 0;
      ALTER TABLE audit_log ADD COLUMN prev_hash TEXT DEFAULT '';
      ALTER TABLE audit_log ADD COLUMN hash TEXT DEFAULT '';
      CREATE TABLE IF NOT EXISTS referral_credits (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, referrer_id BIGINT NOT NULL, referee_id BIGINT NOT NULL,
        ticket_id BIGINT, currency TEXT NOT NULL, amount BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        created_at BIGINT NOT NULL, released_at BIGINT);
      CREATE TABLE IF NOT EXISTS account_flags (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL, flag_type TEXT NOT NULL,
        detail TEXT DEFAULT '{}', created_at BIGINT NOT NULL, reviewed_by BIGINT, reviewed_at BIGINT);
      CREATE TABLE IF NOT EXISTS webhook_events (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, provider TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE,
        deposit_id BIGINT, action TEXT DEFAULT '', payload TEXT DEFAULT '', created_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS reconciliation_reports (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, checked_at BIGINT NOT NULL, wallets_checked BIGINT DEFAULT 0,
        mismatch_count BIGINT DEFAULT 0, details TEXT DEFAULT '{}', created_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, action TEXT NOT NULL, entity TEXT NOT NULL, entity_id BIGINT NOT NULL,
        amount BIGINT NOT NULL, currency TEXT NOT NULL, requested_by BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
        decided_by BIGINT, decided_at BIGINT, created_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS email_verifications (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, user_id BIGINT NOT NULL, new_email TEXT NOT NULL,
        token_hash TEXT NOT NULL, expires_at BIGINT NOT NULL, used BIGINT DEFAULT 0, created_at BIGINT NOT NULL);
    `,
    mysql: `
      ALTER TABLE draws ADD COLUMN beacon_round BIGINT DEFAULT NULL;
      ALTER TABLE draws ADD COLUMN beacon_randomness VARCHAR(128) DEFAULT '';
      ALTER TABLE draws ADD COLUMN beacon_signature VARCHAR(256) DEFAULT '';
      ALTER TABLE draws ADD COLUMN beacon_status VARCHAR(32) DEFAULT '';
      ALTER TABLE users ADD COLUMN admin_role VARCHAR(16) DEFAULT 'super';
      ALTER TABLE users ADD COLUMN payout_updated_at BIGINT DEFAULT 0;
      ALTER TABLE users ADD COLUMN payout_fingerprint VARCHAR(128) DEFAULT '';
      ALTER TABLE users ADD COLUMN force_password_reset TINYINT DEFAULT 0;
      ALTER TABLE users ADD COLUMN force_totp_enroll TINYINT DEFAULT 0;
      ALTER TABLE deposits ADD COLUMN provider_txn_id VARCHAR(128) DEFAULT NULL;
      CREATE UNIQUE INDEX idx_deposits_provider_txn ON deposits (provider_txn_id);
      ALTER TABLE withdrawals ADD COLUMN provider_payout_id VARCHAR(128) DEFAULT '';
      ALTER TABLE withdrawals ADD COLUMN payout_at BIGINT DEFAULT NULL;
      ALTER TABLE commissions ADD COLUMN settled TINYINT DEFAULT 0;
      ALTER TABLE commissions ADD COLUMN settled_at BIGINT DEFAULT NULL;
      ALTER TABLE gateway_credentials ADD COLUMN field_enc TINYINT DEFAULT 0;
      ALTER TABLE audit_log ADD COLUMN prev_hash VARCHAR(128) DEFAULT '';
      ALTER TABLE audit_log ADD COLUMN hash VARCHAR(128) DEFAULT '';
      CREATE TABLE IF NOT EXISTS referral_credits (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, referrer_id BIGINT NOT NULL, referee_id BIGINT NOT NULL,
        ticket_id BIGINT, currency VARCHAR(8) NOT NULL, amount BIGINT NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'pending',
        created_at BIGINT NOT NULL, released_at BIGINT);
      CREATE TABLE IF NOT EXISTS account_flags (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id BIGINT NOT NULL, flag_type VARCHAR(32) NOT NULL,
        detail TEXT, created_at BIGINT NOT NULL, reviewed_by BIGINT, reviewed_at BIGINT);
      CREATE TABLE IF NOT EXISTS webhook_events (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, provider VARCHAR(64) NOT NULL, event_id VARCHAR(191) NOT NULL UNIQUE,
        deposit_id BIGINT, action VARCHAR(64) DEFAULT '', payload TEXT, created_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS reconciliation_reports (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, checked_at BIGINT NOT NULL, wallets_checked INT DEFAULT 0,
        mismatch_count INT DEFAULT 0, details TEXT, created_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, action VARCHAR(32) NOT NULL, entity VARCHAR(32) NOT NULL, entity_id BIGINT NOT NULL,
        amount BIGINT NOT NULL, currency VARCHAR(8) NOT NULL, requested_by BIGINT NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'open',
        decided_by BIGINT, decided_at BIGINT, created_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS email_verifications (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id BIGINT NOT NULL, new_email VARCHAR(255) NOT NULL,
        token_hash VARCHAR(255) NOT NULL, expires_at BIGINT NOT NULL, used TINYINT DEFAULT 0, created_at BIGINT NOT NULL);
    `,
  },
  {
    version: 8, name: 'v16 profile completion flag: OTP signups must collect name + terms',
    sqlite: `
      ALTER TABLE users ADD COLUMN profile_completed INTEGER DEFAULT 1;
    `,
    mysql: `
      ALTER TABLE users ADD COLUMN profile_completed TINYINT DEFAULT 1;
    `,
    postgres: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_completed BIGINT DEFAULT 1;
    `,
  },
  {
    // NOTE (R-097): there is no v9 — an unreleased v9 draft was removed before
    // release, so numbering jumps 8 → 10. Do NOT renumber: applied versions are
    // recorded in migrations_applied and renumbering would re-run old DDL.
    version: 10, name: 'v16 wager repair: an unreleased v9 draft briefly rewrote the wager_options default from major dollars (1,2,5,10) to minor units (100,200,500,1000) — but server.js parses the setting through toMinor at request time, so the minor form would have priced wagers at $100+. Restore the major-dollar default on any DB the draft touched; all other values untouched.',
    sqlite: `
      UPDATE settings SET value = '1,2,5,10' WHERE key = 'wager_options' AND value IN ('100,200,500,1000', '100, 200, 500, 1000');
    `,
    mysql: `
      UPDATE settings SET value = '1,2,5,10' WHERE \`key\` = 'wager_options' AND value IN ('100,200,500,1000', '100, 200, 500, 1000');
    `,
    postgres: `
      UPDATE settings SET value = '1,2,5,10' WHERE key = 'wager_options' AND value IN ('100,200,500,1000', '100, 200, 500, 1000');
    `,
  },
  {
    // v17b (R-009, R-023, R-050, R-088, R-013): terms acceptance timestamp,
    // pre-ban status restore, beacon round pin column (settle already writes
    // it — without this column settle fails on a migrated DB), maker-checker
    // execution detail, and the MySQL OAuth/OTP schema gap (facebook_id,
    // google_id, login_otps) that SQLite/Postgres already had in v1.
    // R-043: Postgres uses IF NOT EXISTS. SQLite/MySQL ALTER has no such
    // guard, so these run exactly once per migrations_applied (same as v8);
    // MySQL cannot wrap DDL in a transaction, so there is no atomicity
    // guarantee there — a failed v11 leaves the version unrecorded and the
    // next boot retries it.
    version: 11, name: 'v17b: terms + pre-ban + beacon pin + approval detail + MySQL OAuth/OTP gap',
    sqlite: `
      ALTER TABLE users ADD COLUMN terms_accepted_at INTEGER DEFAULT 0;
      ALTER TABLE users ADD COLUMN pre_ban_status TEXT DEFAULT '';
      ALTER TABLE draws ADD COLUMN beacon_round_pinned INTEGER;
      ALTER TABLE pending_approvals ADD COLUMN detail TEXT DEFAULT '{}';
    `,
    mysql: `
      ALTER TABLE users ADD COLUMN terms_accepted_at BIGINT DEFAULT 0;
      ALTER TABLE users ADD COLUMN pre_ban_status VARCHAR(32) DEFAULT '';
      ALTER TABLE users ADD COLUMN facebook_id VARCHAR(255) DEFAULT '';
      ALTER TABLE users ADD COLUMN google_id VARCHAR(255) DEFAULT '';
      CREATE TABLE IF NOT EXISTS login_otps (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, identifier VARCHAR(255) NOT NULL, id_type VARCHAR(32) NOT NULL,
        code_hash VARCHAR(255) NOT NULL, attempts INT DEFAULT 0, verified TINYINT DEFAULT 0,
        expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL,
        INDEX idx_login_otps_ident (identifier, id_type));
      ALTER TABLE draws ADD COLUMN beacon_round_pinned BIGINT;
      ALTER TABLE pending_approvals ADD COLUMN detail TEXT;
    `,
    postgres: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at BIGINT DEFAULT 0;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS pre_ban_status TEXT DEFAULT '';
      ALTER TABLE draws ADD COLUMN IF NOT EXISTS beacon_round_pinned BIGINT;
      ALTER TABLE pending_approvals ADD COLUMN IF NOT EXISTS detail TEXT DEFAULT '{}';
    `,
  },
  {
    version: 12, name: 'v18 deepseek round: announcements + contact messages (DS-028/DS-029), gateway instruction honesty heal (DS-006)',
    sqlite: `
      CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL,
        active INTEGER DEFAULT 1, created_by INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS contact_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL,
        subject TEXT DEFAULT '', message TEXT NOT NULL, handled INTEGER DEFAULT 0, created_at INTEGER NOT NULL);

      UPDATE payment_methods SET instruction = 'Card deposits are reviewed manually: submit your request below and our team will contact you with a secure payment link. Your balance is credited once payment is confirmed.' WHERE rail = 'cards' AND instruction = 'You will be redirected to our secure card processor to complete payment.';
      UPDATE payment_methods SET instruction = 'Apple Pay deposits are reviewed manually: submit your request below and our team will confirm your payment. Your balance is credited once payment is confirmed.' WHERE rail = 'apple_pay' AND instruction = 'Confirm with Apple Pay on your device.';
      UPDATE payment_methods SET instruction = 'Google Pay deposits are reviewed manually: submit your request below and our team will confirm your payment. Your balance is credited once payment is confirmed.' WHERE rail = 'google_pay' AND instruction = 'Confirm with Google Pay on your device.';
      UPDATE payment_methods SET instruction = 'Samsung Pay deposits are reviewed manually: submit your request below and our team will confirm your payment. Your balance is credited once payment is confirmed.' WHERE rail = 'samsung_pay' AND instruction = 'Confirm with Samsung Pay on your device.';
    `,
    mysql: `
      CREATE TABLE IF NOT EXISTS announcements (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, title VARCHAR(255) NOT NULL, body TEXT NOT NULL,
        active TINYINT DEFAULT 1, created_by BIGINT, created_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS contact_messages (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(255) NOT NULL, email VARCHAR(255) NOT NULL,
        subject VARCHAR(255) DEFAULT '', message TEXT NOT NULL, handled TINYINT DEFAULT 0, created_at BIGINT NOT NULL);

      UPDATE payment_methods SET instruction = 'Card deposits are reviewed manually: submit your request below and our team will contact you with a secure payment link. Your balance is credited once payment is confirmed.' WHERE rail = 'cards' AND instruction = 'You will be redirected to our secure card processor to complete payment.';
      UPDATE payment_methods SET instruction = 'Apple Pay deposits are reviewed manually: submit your request below and our team will confirm your payment. Your balance is credited once payment is confirmed.' WHERE rail = 'apple_pay' AND instruction = 'Confirm with Apple Pay on your device.';
      UPDATE payment_methods SET instruction = 'Google Pay deposits are reviewed manually: submit your request below and our team will confirm your payment. Your balance is credited once payment is confirmed.' WHERE rail = 'google_pay' AND instruction = 'Confirm with Google Pay on your device.';
      UPDATE payment_methods SET instruction = 'Samsung Pay deposits are reviewed manually: submit your request below and our team will confirm your payment. Your balance is credited once payment is confirmed.' WHERE rail = 'samsung_pay' AND instruction = 'Confirm with Samsung Pay on your device.';
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS announcements (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL,
        active INTEGER DEFAULT 1, created_by BIGINT, created_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS contact_messages (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL,
        subject TEXT DEFAULT '', message TEXT NOT NULL, handled INTEGER DEFAULT 0, created_at BIGINT NOT NULL);

      UPDATE payment_methods SET instruction = 'Card deposits are reviewed manually: submit your request below and our team will contact you with a secure payment link. Your balance is credited once payment is confirmed.' WHERE rail = 'cards' AND instruction = 'You will be redirected to our secure card processor to complete payment.';
      UPDATE payment_methods SET instruction = 'Apple Pay deposits are reviewed manually: submit your request below and our team will confirm your payment. Your balance is credited once payment is confirmed.' WHERE rail = 'apple_pay' AND instruction = 'Confirm with Apple Pay on your device.';
      UPDATE payment_methods SET instruction = 'Google Pay deposits are reviewed manually: submit your request below and our team will confirm your payment. Your balance is credited once payment is confirmed.' WHERE rail = 'google_pay' AND instruction = 'Confirm with Google Pay on your device.';
      UPDATE payment_methods SET instruction = 'Samsung Pay deposits are reviewed manually: submit your request below and our team will confirm your payment. Your balance is credited once payment is confirmed.' WHERE rail = 'samsung_pay' AND instruction = 'Confirm with Samsung Pay on your device.';
    `,
  },
  {
    version: 13, name: 'red team round: TOTP replay guard (RT-01) + payout pending-change (RT-20)',
    sqlite: `
      ALTER TABLE users ADD COLUMN totp_last_step INTEGER DEFAULT -1;
      ALTER TABLE users ADD COLUMN payout_pending_fingerprint TEXT DEFAULT '';
      ALTER TABLE users ADD COLUMN payout_change_at INTEGER DEFAULT 0;
    `,
    mysql: `
      ALTER TABLE users ADD COLUMN totp_last_step BIGINT DEFAULT -1;
      ALTER TABLE users ADD COLUMN payout_pending_fingerprint VARCHAR(128) DEFAULT '';
      ALTER TABLE users ADD COLUMN payout_change_at BIGINT DEFAULT 0;
    `,
    postgres: `
      ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT DEFAULT -1;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_pending_fingerprint TEXT DEFAULT '';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS payout_change_at BIGINT DEFAULT 0;
    `,
  },
  {
    version: 14, name: 'automation audit: draw scheduler interval 60 -> 5 minutes',
    sqlite: `UPDATE cron_jobs SET interval_minutes = 5 WHERE handler_key = 'ensure_draws' AND interval_minutes = 60;`,
    mysql: `UPDATE cron_jobs SET interval_minutes = 5 WHERE handler_key = 'ensure_draws' AND interval_minutes = 60;`,
    postgres: `UPDATE cron_jobs SET interval_minutes = 5 WHERE handler_key = 'ensure_draws' AND interval_minutes = 60;`,
  },
  {
    version: 15, name: 'smart admin: draw rolls counter + bonus engine tables',
    sqlite: `
      ALTER TABLE draws ADD COLUMN rolls INTEGER DEFAULT 0;
      CREATE TABLE IF NOT EXISTS bonus_campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL, audience TEXT NOT NULL DEFAULT 'all',
        audience_n INTEGER DEFAULT 0, amount_type TEXT NOT NULL DEFAULT 'fixed',
        amount INTEGER DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
        trigger_type TEXT NOT NULL DEFAULT 'manual', starts_at INTEGER DEFAULT 0,
        ends_at INTEGER DEFAULT 0, wagering_x REAL DEFAULT 0,
        per_user_cap INTEGER DEFAULT 0, budget_cap INTEGER DEFAULT 0,
        granted_total INTEGER DEFAULT 0, active INTEGER DEFAULT 1,
        last_drop_at INTEGER DEFAULT 0, created_by INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS bonus_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
        amount INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
        trigger_type TEXT DEFAULT '', wagering_required INTEGER DEFAULT 0,
        wagered INTEGER DEFAULT 0, created_at INTEGER NOT NULL);
    `,
    mysql: `
      ALTER TABLE draws ADD COLUMN rolls INT DEFAULT 0;
      CREATE TABLE IF NOT EXISTS bonus_campaigns (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(191) NOT NULL, audience VARCHAR(32) NOT NULL DEFAULT 'all',
        audience_n INT DEFAULT 0, amount_type VARCHAR(16) NOT NULL DEFAULT 'fixed',
        amount BIGINT DEFAULT 0, currency VARCHAR(8) NOT NULL DEFAULT 'USD',
        trigger_type VARCHAR(16) NOT NULL DEFAULT 'manual', starts_at BIGINT DEFAULT 0,
        ends_at BIGINT DEFAULT 0, wagering_x DOUBLE DEFAULT 0,
        per_user_cap BIGINT DEFAULT 0, budget_cap BIGINT DEFAULT 0,
        granted_total BIGINT DEFAULT 0, active TINYINT DEFAULT 1,
        last_drop_at BIGINT DEFAULT 0, created_by BIGINT, created_at BIGINT NOT NULL) ENGINE=InnoDB;
      CREATE TABLE IF NOT EXISTS bonus_grants (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        campaign_id BIGINT NOT NULL, user_id BIGINT NOT NULL,
        amount BIGINT NOT NULL, currency VARCHAR(8) NOT NULL DEFAULT 'USD',
        trigger_type VARCHAR(16) DEFAULT '', wagering_required BIGINT DEFAULT 0,
        wagered BIGINT DEFAULT 0, created_at BIGINT NOT NULL) ENGINE=InnoDB;
    `,
    postgres: `
      ALTER TABLE draws ADD COLUMN IF NOT EXISTS rolls BIGINT DEFAULT 0;
      CREATE TABLE IF NOT EXISTS bonus_campaigns (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL, audience TEXT NOT NULL DEFAULT 'all',
        audience_n BIGINT DEFAULT 0, amount_type TEXT NOT NULL DEFAULT 'fixed',
        amount BIGINT DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
        trigger_type TEXT NOT NULL DEFAULT 'manual', starts_at BIGINT DEFAULT 0,
        ends_at BIGINT DEFAULT 0, wagering_x DOUBLE PRECISION DEFAULT 0,
        per_user_cap BIGINT DEFAULT 0, budget_cap BIGINT DEFAULT 0,
        granted_total BIGINT DEFAULT 0, active INTEGER DEFAULT 1,
        last_drop_at BIGINT DEFAULT 0, created_by BIGINT, created_at BIGINT NOT NULL);
      CREATE TABLE IF NOT EXISTS bonus_grants (
        id BIGSERIAL PRIMARY KEY,
        campaign_id BIGINT NOT NULL, user_id BIGINT NOT NULL,
        amount BIGINT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD',
        trigger_type TEXT DEFAULT '', wagering_required BIGINT DEFAULT 0,
        wagered BIGINT DEFAULT 0, created_at BIGINT NOT NULL);
    `,
  },
  {
    version: 16, name: 'v19 blueprint round: support canned replies (BP-15) + player email notification preferences (BP-13)',
    sqlite: `
      CREATE TABLE IF NOT EXISTS canned_replies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL, body TEXT NOT NULL,
        created_by INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      ALTER TABLE users ADD COLUMN notify_win_email INTEGER DEFAULT 1;
      ALTER TABLE users ADD COLUMN notify_support_email INTEGER DEFAULT 1;
    `,
    mysql: `
      CREATE TABLE IF NOT EXISTS canned_replies (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(191) NOT NULL, body TEXT NOT NULL,
        created_by BIGINT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL) ENGINE=InnoDB;
      ALTER TABLE users ADD COLUMN notify_win_email TINYINT DEFAULT 1;
      ALTER TABLE users ADD COLUMN notify_support_email TINYINT DEFAULT 1;
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS canned_replies (
        id BIGSERIAL PRIMARY KEY,
        title TEXT NOT NULL, body TEXT NOT NULL,
        created_by BIGINT, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_win_email INTEGER DEFAULT 1;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_support_email INTEGER DEFAULT 1;
    `,
  },
  {
    version: 17, name: 'v19 BP-21: KYC documents + per-user override/note (system ships dormant, kyc_enabled default off)',
    sqlite: `
      CREATE TABLE IF NOT EXISTS kyc_documents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL, doc_type TEXT NOT NULL,
        stored_name TEXT NOT NULL, original_name TEXT DEFAULT '',
        content_type TEXT DEFAULT '', size_bytes INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending', review_note TEXT DEFAULT '',
        reviewed_by INTEGER, created_at INTEGER NOT NULL, reviewed_at INTEGER DEFAULT 0);
      CREATE INDEX IF NOT EXISTS idx_kyc_docs_user ON kyc_documents (user_id, id);
      ALTER TABLE users ADD COLUMN kyc_override TEXT DEFAULT 'default';
      ALTER TABLE users ADD COLUMN kyc_note TEXT DEFAULT '';
    `,
    mysql: `
      CREATE TABLE IF NOT EXISTS kyc_documents (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id BIGINT NOT NULL, doc_type VARCHAR(32) NOT NULL,
        stored_name VARCHAR(128) NOT NULL, original_name VARCHAR(255) DEFAULT '',
        content_type VARCHAR(64) DEFAULT '', size_bytes BIGINT DEFAULT 0,
        status VARCHAR(16) NOT NULL DEFAULT 'pending', review_note TEXT,
        reviewed_by BIGINT, created_at BIGINT NOT NULL, reviewed_at BIGINT DEFAULT 0,
        INDEX idx_kyc_docs_user (user_id, id)) ENGINE=InnoDB;
      ALTER TABLE users ADD COLUMN kyc_override VARCHAR(16) DEFAULT 'default';
      ALTER TABLE users ADD COLUMN kyc_note TEXT;
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS kyc_documents (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL, doc_type TEXT NOT NULL,
        stored_name TEXT NOT NULL, original_name TEXT DEFAULT '',
        content_type TEXT DEFAULT '', size_bytes BIGINT DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending', review_note TEXT DEFAULT '',
        reviewed_by BIGINT, created_at BIGINT NOT NULL, reviewed_at BIGINT DEFAULT 0);
      CREATE INDEX IF NOT EXISTS idx_kyc_docs_user ON kyc_documents (user_id, id);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_override TEXT DEFAULT 'default';
      ALTER TABLE users ADD COLUMN IF NOT EXISTS kyc_note TEXT DEFAULT '';
    `,
  },
  {
    version: 18, name: 'v19 BP-22: per-user auto-withdrawal limit override (major units as typed; NULL = follow global)',
    sqlite: `ALTER TABLE users ADD COLUMN auto_withdrawal_limit TEXT DEFAULT NULL;`,
    mysql: `ALTER TABLE users ADD COLUMN auto_withdrawal_limit VARCHAR(32) DEFAULT NULL;`,
    postgres: `ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_withdrawal_limit TEXT DEFAULT NULL;`,
  },
  {
    // v20 U-25 (coordinator-added so all ticket workers code against real
    // columns): support ticket SOFT delete. deleted_at = epoch ms of the
    // delete (NULL = live), deleted_by = users.id of the actor.
    version: 19, name: 'v20 U-25: support ticket soft delete (deleted_at/deleted_by)',
    sqlite: `
      ALTER TABLE support_tickets ADD COLUMN deleted_at INTEGER DEFAULT NULL;
      ALTER TABLE support_tickets ADD COLUMN deleted_by INTEGER DEFAULT NULL;
    `,
    mysql: `
      ALTER TABLE support_tickets ADD COLUMN deleted_at BIGINT DEFAULT NULL;
      ALTER TABLE support_tickets ADD COLUMN deleted_by BIGINT DEFAULT NULL;
    `,
    postgres: `
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS deleted_at BIGINT DEFAULT NULL;
      ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS deleted_by BIGINT DEFAULT NULL;
    `,
  },
  {
    // v20 U-22: ONE identity = ONE account — DB backstop. Email already
    // has a raw UNIQUE since v1, but on sqlite/postgres that is
    // case-SENSITIVE, phone has no constraint at all, and neither do the
    // provider ids. This migration adds: a unique index on LOWER(email)
    // (sqlite/postgres; mysql's v1 email UNIQUE already covers it), a
    // UNIQUE index on phone for non-empty values only (the many
    // legitimate '' phones from OAuth/staff accounts must stay legal —
    // sqlite/postgres use a partial index; mysql, which has no partial
    // indexes, uses UNIQUE over generated NULLIF(col,'') columns, whose
    // NULLs MySQL exempts from uniqueness), and the same for
    // google_id/facebook_id.
    // DIRTY-DB HONESTY: creating any of these indexes FAILS if the DB
    // already holds duplicates, and migrate() has no per-migration
    // catch (a throw = failed boot). So migrate() runs
    // v20IdentityBlocked() BEFORE this DDL: on duplicates it records
    // the groups in identity_migration_reports, logs loudly, and SKIPS
    // v20 for that boot (unrecorded, retried next boot) instead of
    // crashing. See audits/owner-fix-round/adj-identity.md.
    version: 20, name: 'v20 U-22: unique identity backstop (normalized email, phone, provider ids)',
    sqlite: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower_uq ON users (LOWER(email));
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_uq ON users (phone) WHERE phone IS NOT NULL AND phone <> '';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_uq ON users (google_id) WHERE google_id IS NOT NULL AND google_id <> '';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_facebook_uq ON users (facebook_id) WHERE facebook_id IS NOT NULL AND facebook_id <> '';
    `,
    postgres: `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower_uq ON users (LOWER(email));
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_uq ON users (phone) WHERE phone IS NOT NULL AND phone <> '';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_uq ON users (google_id) WHERE google_id IS NOT NULL AND google_id <> '';
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_facebook_uq ON users (facebook_id) WHERE facebook_id IS NOT NULL AND facebook_id <> '';
    `,
    mysql: `
      ALTER TABLE users ADD COLUMN phone_uq VARCHAR(64) GENERATED ALWAYS AS (NULLIF(phone, '')) STORED;
      ALTER TABLE users ADD COLUMN google_uq VARCHAR(255) GENERATED ALWAYS AS (NULLIF(google_id, '')) STORED;
      ALTER TABLE users ADD COLUMN facebook_uq VARCHAR(255) GENERATED ALWAYS AS (NULLIF(facebook_id, '')) STORED;
      CREATE UNIQUE INDEX idx_users_phone_uq ON users (phone_uq);
      CREATE UNIQUE INDEX idx_users_google_uq ON users (google_uq);
      CREATE UNIQUE INDEX idx_users_facebook_uq ON users (facebook_uq);
    `,
  },
  {
    // v20 D-FIX-B: (1) commission VOID marking for draw-cancel reversals
    // (D1-C5a: voided rows are settled-by-cancel, never payable again,
    // never deleted); (2) queued-notification retry attempts (D3-C4:
    // bounded retries need a persistent attempt counter); (3) agent
    // transfer one-time submission keys (D1-C7: UNIQUE idempotency_key
    // on agent_transfers — the DB claim that makes two parallel identical
    // POSTs apply exactly once). All additive; existing rows take the
    // defaults (NULL transfer keys are exempt from the unique index on
    // every driver), so a dirty DB cannot fail this migration.
    version: 21, name: 'v20 discovery fixes: commission void marks, notification attempts, agent transfer idempotency',
    sqlite: `
      ALTER TABLE commissions ADD COLUMN voided INTEGER DEFAULT 0;
      ALTER TABLE commissions ADD COLUMN voided_at INTEGER DEFAULT NULL;
      ALTER TABLE notifications_log ADD COLUMN attempts INTEGER DEFAULT 0;
      ALTER TABLE agent_transfers ADD COLUMN idempotency_key TEXT DEFAULT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_transfers_idem ON agent_transfers (idempotency_key);
    `,
    postgres: `
      ALTER TABLE commissions ADD COLUMN voided BIGINT DEFAULT 0;
      ALTER TABLE commissions ADD COLUMN voided_at BIGINT DEFAULT NULL;
      ALTER TABLE notifications_log ADD COLUMN attempts BIGINT DEFAULT 0;
      ALTER TABLE agent_transfers ADD COLUMN idempotency_key TEXT DEFAULT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_transfers_idem ON agent_transfers (idempotency_key);
    `,
    mysql: `
      ALTER TABLE commissions ADD COLUMN voided TINYINT DEFAULT 0;
      ALTER TABLE commissions ADD COLUMN voided_at BIGINT DEFAULT NULL;
      ALTER TABLE notifications_log ADD COLUMN attempts INT DEFAULT 0;
      ALTER TABLE agent_transfers ADD COLUMN idempotency_key VARCHAR(128) DEFAULT NULL;
      CREATE UNIQUE INDEX idx_agent_transfers_idem ON agent_transfers (idempotency_key);
    `,
  },
  {
    // v20 U-27.7 heal: the ORIGINAL Terms seed (pre-U-28.5) opened with a
    // "Template notice" paragraph — an instruction TO THE OPERATOR —
    // published verbatim on the customer-facing /page/terms. The seed
    // itself is fixed, but pages are seeded once, so existing DBs keep
    // serving it. Marker-guarded exactly like the DS-039 privacy heal:
    // the UPDATE only fires on the terms row while the known marker is
    // still present, and REPLACE only removes the EXACT original
    // paragraph — an operator who edited the page (marker gone, or the
    // paragraph reworded) is never touched. Fresh DBs never contain the
    // paragraph, so for them this is a no-op. REPLACE/LIKE exist with
    // identical semantics on all three drivers.
    version: 22, name: 'v20 U-27.7 heal: remove the operator Template notice from existing terms pages',
    sqlite: `
      UPDATE pages SET body = REPLACE(body, '<p><strong>Template notice:</strong> the operator must replace this page with terms reviewed for their own licence and jurisdiction before offering real-money play.</p>', '')
      WHERE slug = 'terms' AND body LIKE '%Template notice%';
    `,
    mysql: `
      UPDATE pages SET body = REPLACE(body, '<p><strong>Template notice:</strong> the operator must replace this page with terms reviewed for their own licence and jurisdiction before offering real-money play.</p>', '')
      WHERE slug = 'terms' AND body LIKE '%Template notice%';
    `,
    postgres: `
      UPDATE pages SET body = REPLACE(body, '<p><strong>Template notice:</strong> the operator must replace this page with terms reviewed for their own licence and jurisdiction before offering real-money play.</p>', '')
      WHERE slug = 'terms' AND body LIKE '%Template notice%';
    `,
  },
  {
    // v20 U-28.1: FIELD SEPARATION. deposits/withdrawals.admin_note is
    // INTERNAL (written only via the admin "Admin note" form) but the
    // wallet Request-history mapped it to the player's "Reason" — an
    // internal fraud-watch remark reached the player verbatim. The new
    // decision_reason column is the dedicated PLAYER-FACING reason,
    // captured on the decision forms at decision time (the KYC reject
    // pattern). The wallet now reads ONLY decision_reason; admin_note
    // stays internal. Additive columns with defaults — dirty-safe on
    // every driver (existing rows read as '' = no player reason shown).
    version: 23, name: 'v20 U-28.1: player-facing decision_reason on deposits + withdrawals (separate from internal admin_note)',
    sqlite: `
      ALTER TABLE deposits ADD COLUMN decision_reason TEXT DEFAULT '';
      ALTER TABLE withdrawals ADD COLUMN decision_reason TEXT DEFAULT '';
    `,
    mysql: `
      ALTER TABLE deposits ADD COLUMN decision_reason TEXT;
      ALTER TABLE withdrawals ADD COLUMN decision_reason TEXT;
    `,
    postgres: `
      ALTER TABLE deposits ADD COLUMN IF NOT EXISTS decision_reason TEXT DEFAULT '';
      ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS decision_reason TEXT DEFAULT '';
    `,
  },
  {
    // SESSION-TAB-01 (manual-payments round): dual session scope. Player/
    // agent ("site") sessions and admin-panel sessions are separate rows
    // with separate cookies (sid / sid_admin), so signing in on one side
    // of the site can never overwrite the other side's session in the
    // same browser. Existing rows read as 'site' — pre-fix admin logins
    // simply sign in once more and get a proper admin-scope row.
    version: 24, name: 'SESSION-TAB-01: session scope (site vs admin) for dual-cookie sessions',
    sqlite: `
      ALTER TABLE sessions ADD COLUMN scope TEXT DEFAULT 'site';
    `,
    mysql: `
      ALTER TABLE sessions ADD COLUMN scope VARCHAR(16) DEFAULT 'site';
    `,
    postgres: `
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'site';
    `,
  },
  {
    // METHOD-MODE-01 (manual-payments round): per-method processing
    // mode. 'manual' (the default everywhere) = today's flow exactly.
    // 'auto' is gated at save time in the admin (rail must have a real
    // provider-confirmation path + the required credentials) and at
    // runtime in the webhook handler — the value alone never credits
    // anything (R-044: no decorative switches).
    version: 25, name: 'METHOD-MODE-01: per-method processing mode (manual | auto)',
    sqlite: `
      ALTER TABLE payment_methods ADD COLUMN processing_mode TEXT DEFAULT 'manual';
    `,
    mysql: `
      ALTER TABLE payment_methods ADD COLUMN processing_mode VARCHAR(16) DEFAULT 'manual';
    `,
    postgres: `
      ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS processing_mode TEXT DEFAULT 'manual';
    `,
  },
  {
    // INSTR-APPLE-01 (manual-payments round): separate withdrawal
    // how-to per method. Deposit instructions keep living in
    // `instruction`; the withdraw page prefers withdraw_instruction
    // and falls back to `instruction` when blank. Seeded from the
    // rail defaults below; admin edits are never overwritten.
    version: 26, name: 'INSTR-APPLE-01: per-method withdrawal instruction',
    sqlite: `
      ALTER TABLE payment_methods ADD COLUMN withdraw_instruction TEXT DEFAULT '';
    `,
    mysql: `
      ALTER TABLE payment_methods ADD COLUMN withdraw_instruction TEXT;
    `,
    postgres: `
      ALTER TABLE payment_methods ADD COLUMN IF NOT EXISTS withdraw_instruction TEXT DEFAULT '';
    `,
  },
  {
    // v23 delivery: GLOBAL credentials for panel-configured delivery
    // secrets (SMTP password, Twilio token, TextBelt key — scope
    // 'delivery'). Scope-keyed, NOT method-keyed: gateway_credentials
    // stays payment-method-only. CREATE IF NOT EXISTS in every dialect
    // (fresh DBs already get the table from the v1 core schema).
    version: 27, name: 'v23 delivery: global_credentials (panel-configured delivery secrets)',
    sqlite: `
      CREATE TABLE IF NOT EXISTS global_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL,
        field_key TEXT NOT NULL, field_value TEXT DEFAULT '', field_enc INTEGER DEFAULT 0, updated_at INTEGER,
        UNIQUE (scope, field_key));
    `,
    mysql: `
      CREATE TABLE IF NOT EXISTS global_credentials (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, scope VARCHAR(64) NOT NULL,
        field_key VARCHAR(128) NOT NULL, field_value TEXT, field_enc TINYINT DEFAULT 0, updated_at BIGINT,
        UNIQUE KEY uq_scope_field (scope, field_key));
    `,
    postgres: `
      CREATE TABLE IF NOT EXISTS global_credentials (
        id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, scope TEXT NOT NULL,
        field_key TEXT NOT NULL, field_value TEXT DEFAULT '', field_enc BIGINT DEFAULT 0, updated_at BIGINT,
        UNIQUE (scope, field_key));
    `,
  },
  {
    version: 28, name: 'v23 hunt: remove orphan settings + seed per-draw stake cap',
    /* H4-20/OTP-D5 (v23): kyc_required, email_verification,
       mobile_verification and auto_approve_deposit_limit were seeded
       for years but read by NOTHING (the R-044 dead-switch class) —
       the real controls are kyc_enabled/kyc_gate, the verified-contact
       gate and BP-22. The rows are deleted so no future surface can
       mistake them for live switches; they are also out of
       DEFAULT_SETTINGS, so they never come back. */
    sqlite: `DELETE FROM settings WHERE key IN ('kyc_required','email_verification','mobile_verification','auto_approve_deposit_limit','language');`,
    mysql: "DELETE FROM settings WHERE `key` IN ('kyc_required','email_verification','mobile_verification','auto_approve_deposit_limit','language');",
    postgres: `DELETE FROM settings WHERE key IN ('kyc_required','email_verification','mobile_verification','auto_approve_deposit_limit','language');`,
  },
];

async function seed(db, driver) {
  const t = now();
  const K = driver === 'mysql' ? '`key`' : 'key'; // KEY is reserved in MySQL
  async function ensureSetting(k, v) {
    const ex = await db.get(`SELECT ${K} FROM settings WHERE ${K} = ?`, [k]);
    if (!ex) await db.run(`INSERT INTO settings (${K}, value, updated_at) VALUES (?, ?, ?)`, [k, v, t]);
  }
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) await ensureSetting(k, v);
  for (const [pops, mult] of DEFAULT_PRIZES) {
    const ex = await db.get('SELECT pops_count FROM prize_table WHERE pops_count = ?', [pops]);
    if (!ex) await db.run('INSERT INTO prize_table (pops_count, multiplier) VALUES (?, ?)', [pops, mult]);
  }
  for (const [key, [title, body]] of Object.entries(CONTENT_BLOCKS)) {
    const ex = await db.get(`SELECT ${K} FROM content_blocks WHERE ${K} = ?`, [key]);
    if (!ex) await db.run(`INSERT INTO content_blocks (${K}, title, body, updated_at) VALUES (?, ?, ?, ?)`, [key, title, body, t]);
  }
  // R-102: heal the false CMS claims (R-010) in EXISTING DBs, not just fresh
  // seeds. A row is healed only while it still contains the known false
  // marker — an operator who already rewrote the block is never overwritten.
  const HEAL_MARKERS = {
    home_banner: '250X',
    testimonials: 'A. Player',
    footer_about: 'Licensed lottery operator',
    footer_contact: 'Live chat available 24/7',
  };
  for (const [key, marker] of Object.entries(HEAL_MARKERS)) {
    const row = await db.get(`SELECT body FROM content_blocks WHERE ${K} = ?`, [key]);
    if (row && String(row.body || '').includes(marker)) {
      await db.run(`UPDATE content_blocks SET body = ?, updated_at = ? WHERE ${K} = ?`, [CONTENT_BLOCKS[key][1], t, key]);
    }
  }
  /* SCAN fix (D-01): heal the exact old footer_contact default — an
     email address on a domain the operator does not own (mail sent
     there bounces or reaches a stranger). Only the untouched default
     is replaced; an operator-customised block is never overwritten. */
  {
    const row = await db.get(`SELECT body FROM content_blocks WHERE ${K} = ?`, ['footer_contact']);
    if (row && String(row.body || '').trim() === '<p>Support: support@cashpop.live</p>') {
      await db.run(`UPDATE content_blocks SET body = ?, updated_at = ? WHERE ${K} = ?`, [CONTENT_BLOCKS.footer_contact[1], t, 'footer_contact']);
    }
    const srow = await db.get(`SELECT value FROM settings WHERE ${K} = ?`, ['footer_contact']);
    if (srow && String(srow.value || '').trim() === '<p>Support: support@cashpop.live</p>') {
      await db.run(`UPDATE settings SET value = ? WHERE ${K} = ?`, [CONTENT_BLOCKS.footer_contact[1], 'footer_contact']);
    }
  }
  for (const [name, slug, title, meta, body] of PAGES) {
    const ex = await db.get('SELECT id FROM pages WHERE slug = ?', [slug]);
    if (!ex) await db.run('INSERT INTO pages (name, slug, title, meta_title, meta_desc, body, status, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [name, slug, title, title, meta, body, 'published', 0]);
  }
  // DS-039: heal the seeded privacy placeholder in EXISTING DBs (the seed
  // above only writes fresh rows; live visitors were served the internal
  // placeholder text on a legal page). Heals only while the known
  // placeholder marker is still present - operator edits are kept.
  {
    const prow = await db.get('SELECT id, body FROM pages WHERE slug = ?', ['privacy']);
    if (prow && String(prow.body || '').includes('This is a placeholder')) {
      const fresh = PAGES.find(p => p[1] === 'privacy');
      if (fresh) await db.run('UPDATE pages SET body = ? WHERE id = ?', [fresh[4], prow.id]);
    }
  }
  for (const [channel, slug, subject, body, enabled] of NOTIF_TEMPLATES) {
    const ex = await db.get('SELECT id FROM notif_templates WHERE slug = ? AND channel = ?', [slug, channel]);
    if (!ex) await db.run('INSERT INTO notif_templates (channel, slug, subject, body, enabled) VALUES (?, ?, ?, ?, ?)', [channel, slug, subject, body, enabled]);
  }
  for (const [key, name, enabled, config] of EXTENSIONS) {
    const ex = await db.get(`SELECT ${K} FROM extensions WHERE ${K} = ?`, [key]);
    if (!ex) await db.run(`INSERT INTO extensions (${K}, name, enabled, config, updated_at) VALUES (?, ?, ?, ?, ?)`, [key, name, enabled, JSON.stringify(config), t]);
  }
  for (const [name, handler_key, interval_minutes, description] of CRON_JOBS) {
    const ex = await db.get('SELECT id FROM cron_jobs WHERE handler_key = ?', [handler_key]);
    if (!ex) await db.run('INSERT INTO cron_jobs (name, handler_key, interval_minutes, next_run_at, status, description) VALUES (?, ?, ?, ?, ?, ?)',
      [name, handler_key, interval_minutes, t, 'active', description]);
  }
  // 13 payment rails as disabled method templates (admin enables + configures)
  const { RAILS } = require('./rails');
  let sort = 0;
  for (const rail of RAILS) {
    sort += 1;
    const slug = 'rail-' + rail.key;
    const ex = await db.get('SELECT id, instruction, withdraw_instruction FROM payment_methods WHERE slug = ?', [slug]);
    if (!ex) {
      await db.run(`INSERT INTO payment_methods (kind, name, slug, rail, logo_url, currency, rate, min_amount, max_amount, fixed_charge, percent_charge, instruction, withdraw_instruction, custom_fields, enabled, sort)
        VALUES ('both', ?, ?, ?, '', 'USD', 1, 100, 100000, 0, 0, ?, ?, '[]', 0, ?)`,
        [rail.name, slug, rail.key, rail.defaultInstruction || '', rail.withdrawInstruction || '', sort]);
    } else {
      // INSTR-APPLE-01 heal: methods still carrying the EXACT pre-round
      // one-liner (i.e. never customized by an admin) get the new
      // step-by-step how-to; a blank withdraw_instruction is filled
      // from the rail default. Anything else is admin text — untouched.
      const prev = (rail.prevDefaultInstructions || []).includes(ex.instruction);
      if (prev) await db.run('UPDATE payment_methods SET instruction = ? WHERE id = ?', [rail.defaultInstruction, ex.id]);
      if (!ex.withdraw_instruction) await db.run('UPDATE payment_methods SET withdraw_instruction = ? WHERE id = ?', [rail.withdrawInstruction || '', ex.id]);
    }
  }
}

/* Pick the DDL variant for the driver. Postgres FAILS FAST when a variant is
   missing — silently running SQLite DDL against Postgres would corrupt the
   schema (backticks, AUTOINCREMENT, INSERT OR IGNORE all differ). */
function ddlFor(m, driver) {
  if (driver === 'mysql') return m.mysql;
  if (driver === 'postgres') {
    if (!m.postgres) throw new Error(`Migration v${m.version} has no postgres variant — refusing to run SQLite DDL on Postgres`);
    return m.postgres;
  }
  return m.sqlite;
}

/* U-22 (v20) preflight — the ONLY conditional branch in migrate(), keyed
   on version 20 alone (existing migrations v1-v19 are untouched). Static
   DDL cannot check for duplicates before building a unique index, and a
   failed index build would otherwise crash the boot (migrate has no
   per-migration catch; server boot exits on a throw). Returns true when
   v20 must be SKIPPED for this boot: every duplicate group is recorded
   in identity_migration_reports and logged loudly; v20 stays
   unrecorded, so the next boot retries it — once the operator merges
   the reported duplicate accounts, v20 applies cleanly. Route-level
   identity checks (routes/auth.js) block NEW twins in the meantime. */
async function v20IdentityBlocked(db, driver) {
  await db.execScript(driver === 'mysql'
    ? 'CREATE TABLE IF NOT EXISTS identity_migration_reports (id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, version INT, field VARCHAR(64), dup_value VARCHAR(255), dup_count INT, user_ids TEXT, created_at BIGINT)'
    : driver === 'postgres'
    ? 'CREATE TABLE IF NOT EXISTS identity_migration_reports (id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, version BIGINT, field TEXT, dup_value TEXT, dup_count BIGINT, user_ids TEXT, created_at BIGINT)'
    : 'CREATE TABLE IF NOT EXISTS identity_migration_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER, field TEXT, dup_value TEXT, dup_count INTEGER, user_ids TEXT, created_at INTEGER)');
  const checks = [
    ['email_lower', 'LOWER(email)', "email IS NOT NULL AND email <> ''"],
    ['phone', 'phone', "phone IS NOT NULL AND phone <> ''"],
    ['google_id', 'google_id', "google_id IS NOT NULL AND google_id <> ''"],
    ['facebook_id', 'facebook_id', "facebook_id IS NOT NULL AND facebook_id <> ''"],
  ];
  let blocked = false;
  for (const [field, expr, where] of checks) {
    const idsExpr = driver === 'postgres' ? "string_agg(id::text, ',')" : 'GROUP_CONCAT(id)';
    let groups = [];
    try {
      groups = await db.query(`SELECT ${expr} AS v, COUNT(*) AS c, ${idsExpr} AS ids FROM users WHERE ${where} GROUP BY ${expr} HAVING COUNT(*) > 1`);
    } catch (e) {
      // MySQL has GROUP_CONCAT too; a driver without it must not crash the
      // boot either — fall back to values+counts without the id list.
      groups = await db.query(`SELECT ${expr} AS v, COUNT(*) AS c FROM users WHERE ${where} GROUP BY ${expr} HAVING COUNT(*) > 1`);
    }
    for (const g of groups) {
      blocked = true;
      const msg = `[migration v20] SKIPPED: duplicate ${field} '${g.v}' on ${g.c} accounts${g.ids ? ' (user ids: ' + g.ids + ')' : ''} — the unique identity index cannot be built until these accounts are merged. The site will boot WITHOUT the v20 DB backstop; route-level checks still block new duplicates, and v20 will retry on the next boot.`;
      console.error(msg);
      await db.run('INSERT INTO identity_migration_reports (version, field, dup_value, dup_count, user_ids, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [20, field, String(g.v), Number(g.c), g.ids ? String(g.ids) : '', now()]);
    }
  }
  return blocked;
}

async function migrate(db, driver) {
  await db.execScript(driver === 'mysql'
    ? 'CREATE TABLE IF NOT EXISTS migrations_applied (version INT PRIMARY KEY, name VARCHAR(255), applied_at BIGINT)'
    : driver === 'postgres'
    ? 'CREATE TABLE IF NOT EXISTS migrations_applied (version BIGINT PRIMARY KEY, name TEXT, applied_at BIGINT)'
    : 'CREATE TABLE IF NOT EXISTS migrations_applied (version INTEGER PRIMARY KEY, name TEXT, applied_at INTEGER)');
  const applied = await db.query('SELECT version FROM migrations_applied');
  const done = new Set(applied.map(r => r.version));
  // R-097: apply in version order even if MIGRATIONS is ever edited out of
  // order (v9 is intentionally missing — see the note above v10).
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue;
    // U-22: v20 only — check-first, record + skip loudly on a dirty DB
    // instead of crashing the boot on the unique-index build.
    if (m.version === 20 && await v20IdentityBlocked(db, driver)) continue;
    await db.execScript(ddlFor(m, driver));
    await db.run('INSERT INTO migrations_applied (version, name, applied_at) VALUES (?, ?, ?)', [m.version, m.name, now()]);
  }
  await seed(db, driver);
}

module.exports = { migrate };
