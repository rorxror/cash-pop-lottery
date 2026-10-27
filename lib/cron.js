'use strict';
/* In-process cron scheduler. Jobs are defined in code, scheduled/paused/
   resumed from the admin Cron Jobs UI, and also runnable on demand. */
const { now } = require('./util');
const { getSettings } = require('./settings');

const handlers = {
  ensure_draws: async (ctx) => {
    const draws = require('./draws');
    const settings = await getSettings(ctx.db, ctx.driver, true);
    await draws.ensureUpcomingDraws(ctx.db, settings);
    const settled = await draws.settleDueDraws(ctx.db, settings);
    return `ensured upcoming draws; settled ${settled.length}`;
  },
  clean_sessions: async (ctx) => {
    const r = await ctx.db.run('DELETE FROM sessions WHERE expires_at < ?', [now()]);
    return `removed ${r.changes} expired sessions`;
  },
  expire_deposits: async (ctx) => {
    // Expire pending deposits older than 48h with no proof submitted
    const cutoff = now() - 48 * 3600 * 1000;
    const r = await ctx.db.run(
      "UPDATE deposits SET status = 'expired' WHERE status = 'pending' AND created_at < ?", [cutoff]);
    return `expired ${r.changes} stale deposits`;
  },
  process_notifications: async (ctx) => {
    // Send queued notification batches whose cooling period has elapsed
    const notify = require('./notify');
    const settings = await getSettings(ctx.db, ctx.driver, true);
    const due = await ctx.db.query(
      "SELECT * FROM notifications_log WHERE status = 'queued' AND scheduled_at > 0 AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 200", [now()]);
    let sent = 0, failed = 0;
    for (const row of due) {
      const r = await notify.sendQueued(ctx.db, settings, row);
      if (r.status === 'sent') sent++; else failed++;
    }
    return `notification batches: ${sent} sent, ${failed} failed, ${due.length} due`;
  },
};

let timer = null;
async function tick(ctx) {
  try {
    const due = await ctx.db.query(
      "SELECT * FROM cron_jobs WHERE status = 'active' AND (next_run_at IS NULL OR next_run_at <= ?)", [now()]);
    for (const job of due) {
      const fn = handlers[job.handler_key];
      const started = now();
      try {
        const msg = fn ? await fn(ctx) : 'no handler';
        await ctx.db.run(
          'UPDATE cron_jobs SET last_run_at = ?, next_run_at = ?, last_status = ?, last_message = ? WHERE id = ?',
          [started, started + job.interval_minutes * 60000, 'ok', String(msg).slice(0, 500), job.id]);
      } catch (e) {
        await ctx.db.run(
          'UPDATE cron_jobs SET last_run_at = ?, next_run_at = ?, last_status = ?, last_message = ? WHERE id = ?',
          [started, started + job.interval_minutes * 60000, 'error', String(e.message).slice(0, 500), job.id]);
      }
    }
  } catch (e) { console.error('cron tick failed:', e.message); }
}

function start(ctx) {
  if (timer) return;
  tick(ctx); // run once at boot
  timer = setInterval(() => tick(ctx), 60000);
  timer.unref();
}

async function runNow(ctx, id) {
  const job = await ctx.db.query('SELECT * FROM cron_jobs WHERE id = ?', [id]).then(r => r[0]);
  if (!job) throw new Error('Job not found');
  const fn = handlers[job.handler_key];
  if (!fn) throw new Error('No handler for ' + job.handler_key);
  const started = now();
  try {
    const msg = await fn(ctx);
    await ctx.db.run('UPDATE cron_jobs SET last_run_at = ?, last_status = ?, last_message = ? WHERE id = ?',
      [started, 'ok', String(msg).slice(0, 500), job.id]);
    return msg;
  } catch (e) {
    await ctx.db.run('UPDATE cron_jobs SET last_run_at = ?, last_status = ?, last_message = ? WHERE id = ?',
      [started, 'error', String(e.message).slice(0, 500), job.id]);
    throw e;
  }
}

module.exports = { start, runNow, handlers };
