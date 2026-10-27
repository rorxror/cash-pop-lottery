#!/usr/bin/env node
'use strict';
/* One-way transfer: SQLite (source) -> Postgres (target). DANGER: it DELETES
   every app row in the target first (all tables except migrations_applied)
   and inserts the source rows with their ORIGINAL ids, inside ONE transaction
   — any failure rolls everything back, so the target is either an exact copy
   of the source or untouched. That is why TRANSFER_WIPE_TARGET=1 is required:
   without it the script refuses to run.

   PROCEDURE (read before running):
   1. Boot the app against the TARGET Postgres DB once and confirm it serves
      (this creates the schema + boot seeds). 2. STOP that app — maintenance
      mode is NOT enough: the in-process cron keeps creating draws and
      reconciliation rows while HTTP is gated, and those rows would collide
      with the transfer's ids. 3. Run this script. 4. Boot the app against
      the target again and verify counts + log in + register a new user
      (proves the identity sequences were reset past the transferred max).

   Env: SQLITE_PATH (default ./data/cashpop.sqlite), TARGET_DATABASE_URL
   (required), TRANSFER_WIPE_TARGET=1 (required). */
const { DatabaseSync } = require('node:sqlite');
const { Client } = require('pg');

const TABLES = ['users', 'otp_codes', 'login_otps', 'sessions', 'wallets',
  'transactions', 'payment_methods', 'gateway_credentials', 'deposits',
  'withdrawals', 'draws', 'tickets', 'ticket_entries', 'prize_table',
  'commissions', 'agent_floats', 'agent_transfers', 'support_tickets',
  'support_messages', 'pages', 'content_blocks', 'notif_templates',
  'notifications_log', 'extensions', 'cron_jobs', 'audit_log', 'login_history',
  'password_resets', 'referral_credits', 'account_flags', 'webhook_events',
  'reconciliation_reports', 'pending_approvals', 'email_verifications',
  'scratch_series', 'scratch_prize_tiers', 'scratch_outcomes',
  'scratch_tickets', 'scratch_events', 'responsible_play', 'settings'];
// Tables whose `id` is a TEXT key (sessions) or a composite/natural key
// (wallets, agent_floats, responsible_play, settings, content_blocks,
// extensions, prize_table) must NOT get setval: setval over a text column
// fails, and keyed tables have no sequence at all.
const INT_ID_TABLES = new Set(['users', 'otp_codes', 'login_otps',
  'transactions', 'payment_methods', 'gateway_credentials', 'deposits',
  'withdrawals', 'draws', 'tickets', 'ticket_entries', 'commissions',
  'agent_transfers', 'support_tickets', 'support_messages', 'pages',
  'notif_templates', 'notifications_log', 'cron_jobs', 'audit_log',
  'login_history', 'password_resets', 'referral_credits', 'account_flags',
  'webhook_events', 'reconciliation_reports', 'pending_approvals',
  'email_verifications', 'scratch_series', 'scratch_prize_tiers',
  'scratch_outcomes', 'scratch_tickets', 'scratch_events']);

async function main() {
  if (process.env.TRANSFER_WIPE_TARGET !== '1') {
    console.error('REFUSED: set TRANSFER_WIPE_TARGET=1 to confirm the target will be wiped first.');
    process.exit(2);
  }
  const targetUrl = process.env.TARGET_DATABASE_URL;
  if (!targetUrl) { console.error('REFUSED: set TARGET_DATABASE_URL.'); process.exit(2); }
  const src = new DatabaseSync(process.env.SQLITE_PATH || './data/cashpop.sqlite', { readOnly: true });
  const client = new Client({ connectionString: targetUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const counts = {};
  try {
    await client.query('BEGIN');
    for (const t of TABLES) {
      await client.query(`DELETE FROM "${t}"`);
      let rows = [];
      try { rows = src.prepare(`SELECT * FROM "${t}"`).all(); }
      catch (e) { if (!/no such table/.test(e.message)) throw e; }
      if (!rows.length) { counts[t] = 0; continue; }
      const cols = Object.keys(rows[0]);
      const ph = cols.map((_, i) => '$' + (i + 1)).join(', ');
      const colList = cols.map(c => `"${c}"`).join(', ');
      for (const r of rows) {
        await client.query(`INSERT INTO "${t}" (${colList}) VALUES (${ph})`, cols.map(c => r[c]));
      }
      counts[t] = rows.length;
    }
    for (const t of INT_ID_TABLES) {
      await client.query(`SELECT setval(pg_get_serial_sequence('"${t}"', 'id'), COALESCE((SELECT MAX(id) FROM "${t}"), 1))`);
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    throw e;
  } finally {
    await client.end();
  }
  let total = 0;
  for (const [t, n] of Object.entries(counts)) { total += n; if (n) console.log(`  ${t}: ${n}`); }
  console.log(`TRANSFER COMPLETE: ${total} rows, ${Object.keys(counts).length} tables, 0 failed.`);
}

main().catch((e) => { console.error('TRANSFER FAILED:', e.message); process.exit(1); });
