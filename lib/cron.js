'use strict';
/* In-process cron scheduler. Jobs are defined in code, scheduled/paused/
   resumed from the admin Cron Jobs UI, and also runnable on demand. */
const { now } = require('./util');
const { getSettings, getBool } = require('./settings');

const handlers = {
  ensure_draws: async (ctx) => {
    const draws = require('./draws');
    const settings = await getSettings(ctx.db, ctx.driver, true);
    await draws.ensureUpcomingDraws(ctx.db, settings);
    const fired = await draws.checkThresholdDraws(ctx.db, settings);
    const settled = await draws.settleDueDraws(ctx.db, settings);
    /* D3-C2 (v20): honest counts. settleDueDraws / checkThresholdDraws
       return one entry per ATTEMPT, mixing real settlements with
       threshold waits ({waiting}), +24h rolls ({rolled}), already-done
       skips ({skipped}) and failures ({error}). The old message printed
       the array LENGTH as "settled", so a dead beacon showed green
       "settled 1" while nothing settled. Now: settled counts only real
       settlements; waiting/rolled/skipped are DEFERRED (never settled);
       and ANY failure throws, so tick() marks the run 'error' and
       writes the cron.failed audit row the Automation Console reads. */
    const tally = (arr) => {
      let ok = 0, deferred = 0, failed = 0; const errs = [];
      for (const r of arr || []) {
        if (!r) continue;
        if (r.error) { failed++; errs.push('draw ' + r.drawId + ': ' + r.error); }
        else if (r.waiting || r.rolled || r.skipped) deferred++;
        else ok++;
      }
      return { ok, deferred, failed, errs };
    };
    const tf = tally(fired), st = tally(settled);
    const settledOk = tf.ok + st.ok, deferredN = tf.deferred + st.deferred, failedN = tf.failed + st.failed;
    const failErrs = [...tf.errs, ...st.errs];
    // BP-23(e): draw exposure alerting — when a scheduled draw's worst-
    // case liability crosses the operator's threshold, write ONE audit
    // row per draw per 24h (the Automation Console also shows these
    // live). Detection only: settlement math never changes.
    let exposureAlerts = 0;
    try {
      const { toMinor, decimalsFor } = require('./util');
      const { getS } = require('./settings');
      /* SCAN fix (B-10): the threshold is typed in major units; compare
         it per currency in THAT currency's minor units (a 0-decimal
         currency was previously compared against a 100× inflated
         threshold, a 3-decimal one against a 10× deflated one). */
      const thresholdMajor = getS(settings, 'draw_liability_alert', '0');
      if (parseFloat(thresholdMajor) > 0) {
        const engine = require('./prize-engine');
        const audit = require('./audit');
        const pm = await engine.prizeMap(ctx.db);
        const open = await ctx.db.query("SELECT * FROM draws WHERE status = 'scheduled' AND is_test = 0 ORDER BY close_at LIMIT 50");
        for (const dr of open) {
          const exps = await engine.drawExposure(ctx.db, dr.id, pm);
          for (const ex of exps) {
            const threshold = toMinor(thresholdMajor, decimalsFor(ex.currency, 'USD')) || 0;
            if (threshold <= 0 || ex.maxLiability <= threshold) continue;
            const recent = await ctx.db.get("SELECT id FROM audit_log WHERE action = 'draw.exposure_alert' AND entity_id = ? AND created_at > ?", [String(dr.id), Date.now() - 24 * 3600 * 1000]);
            if (recent) continue;
            exposureAlerts += 1;
            await audit.log(ctx.db, { actorId: null, actorRole: 'system', action: 'draw.exposure_alert', entity: 'draw', entityId: String(dr.id), detail: { currency: ex.currency, entries: ex.entries, max_liability: ex.maxLiability, expected_liability: ex.expectedLiability, threshold } });
          }
        }
      }
    } catch {}
    if (failedN > 0) throw new Error(`draw settlement failed for ${failedN} draw(s): ${failErrs.join('; ')} (settled ${settledOk}; deferred ${deferredN})`);
    return `ensured upcoming draws; threshold-fired ${tf.ok}; settled ${settledOk}; deferred ${deferredN}; failed 0; exposure alerts ${exposureAlerts}`;
  },
  clean_sessions: async (ctx) => {
    const r = await ctx.db.run('DELETE FROM sessions WHERE expires_at < ?', [now()]);
    return `removed ${r.changes} expired sessions`;
  },
  expire_deposits: async (ctx) => {
    // Expire ONLY pending deposits older than 48h with NO proof attached
    // (empty user_data). The old version expired every pending deposit,
    // including ones the user had already paid for while approval was slow
    // — wiping a real, paid claim, since only pending deposits can be
    // approved. Deposits carrying any reference stay pending for admin review.
    const cutoff = now() - 48 * 3600 * 1000;
    /* D3-C9 (v20): a provider transaction id IS a reference — the old
       SQL spared only non-empty user_data and expired gateway-paid
       deposits that carried provider_txn_id, destroying a payable
       claim (only pending deposits can be approved). Referenced
       deposits now NEVER expire here; they stay for admin review. */
    const r = await ctx.db.run(
      "UPDATE deposits SET status = 'expired' WHERE status = 'pending' AND created_at < ? AND (user_data IS NULL OR user_data = '' OR user_data = '{}') AND (provider_txn_id IS NULL OR provider_txn_id = '')", [cutoff]);
    return `expired ${r.changes} stale deposits`;
  },
  reconcile_ledger: async (ctx) => {
    const { runReconciliation } = require('./reconcile');
    const r = await runReconciliation(ctx.db);
    return `reconciliation: ${r.wallets_checked} wallets, ${r.mismatch_count} mismatch(es), ${r.unconfirmed} unconfirmed provider txn(s), ${r.stale_proof} stale proof deposit(s)`;
  },
  clean_tokens: async (ctx) => {
    // Automation audit: expired one-time codes and reset tokens were never
    // cleaned (only sessions were). Expired rows are dead weight and grow
    // the hottest auth tables forever.
    const t = now();
    const a = await ctx.db.run('DELETE FROM login_otps WHERE expires_at < ?', [t]);
    const b = await ctx.db.run('DELETE FROM password_resets WHERE expires_at < ?', [t]);
    const c = await ctx.db.run('DELETE FROM otp_codes WHERE expires_at IS NOT NULL AND expires_at < ?', [t]);
    return `token cleanup: ${a.changes} login OTP(s), ${b.changes} reset token(s), ${c.changes} signup code(s) removed`;
  },
  settle_agent_commissions: async (ctx) => {
    // Automation audit: commissions accrued automatically but only ever
    // SETTLED when an admin clicked. Settlement is a ledger-internal move
    // (CAS-guarded inside settleAgentCommissions, so a manual settle racing
    // this job cannot double-pay); it now runs on schedule, with the admin
    // button kept as the manual backup.
    const { settleAgentCommissions } = require('./money');
    const agents = await ctx.db.query('SELECT DISTINCT agent_id FROM commissions WHERE settled = 0');
    let rows = 0, total = 0, paid = 0;
    for (const a of agents) {
      try {
        const r = await settleAgentCommissions(ctx.db, a.agent_id, null);
        rows += r.settled; total += r.total; if (r.settled) paid++;
      } catch (e) { console.error('[cron] commission settle failed for agent', a.agent_id, e.message); }
    }
    return `agent commissions: settled ${rows} row(s), total ${total}, across ${paid} agent(s)`;
  },
  scratch_lifecycle: async (ctx) => {
    // SMART-ADMIN: full scratch lifecycle (scheduled activation, end-date
    // stop, sell-out close, optional auto-next series from a template).
    const settings = await getSettings(ctx.db, ctx.driver, true);
    const r = await require('./scratch').scratchLifecycle(ctx.db, settings);
    if (r.skipped) return 'skipped: ' + r.skipped;
    return `activated ${r.activated}; end-date stopped ${r.stopped}; sold-out closed ${r.soldOut}; auto-next created ${r.cloned}`;
  },
  run_bonus_campaigns: async (ctx) => {
    const settings = await getSettings(ctx.db, ctx.driver, true);
    const out = await require('./bonus').runScheduledDrops(ctx.db, settings);
    if (!out.length) return 'no scheduled drops due';
    // D3-C3: a skipped campaign is reported as skipped + why, never as fired.
    return out.map((o) => o.skipped ? ('drop skipped: #' + o.campaignId + ' (' + o.skipped + ')') : ('drops fired: #' + o.campaignId + ' (' + (o.granted || 0) + ' grants)')).join(', ');
  },
  backup_db: async (ctx) => {
    // Automation audit: there was NO backup job at all. SQLite (the
    // production driver) snapshots itself daily via VACUUM INTO; managed
    // databases (Postgres/MySQL) are backed up by the platform instead.
    if (ctx.driver !== 'sqlite') return 'backups are managed by the database platform on ' + ctx.driver;
    const fs = require('fs');
    const path = require('path');
    const src = process.env.SQLITE_PATH || './data/cashpop.sqlite';
    const dir = path.join(path.dirname(path.resolve(src)), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, 'cashpop-' + new Date().toISOString().replace(/[:.]/g, '-') + '.sqlite');
    await ctx.db.run("VACUUM INTO '" + dest.replace(/'/g, "''") + "'");
    const files = fs.readdirSync(dir).filter(f => f.startsWith('cashpop-') && f.endsWith('.sqlite')).sort();
    let pruned = 0;
    while (files.length > 7) { fs.unlinkSync(path.join(dir, files.shift())); pruned++; }
    return `backup written: ${path.basename(dest)} (retention: last 7, pruned ${pruned})`;
  },
  process_notifications: async (ctx) => {
    // Send queued notification batches whose cooling period has elapsed
    const notify = require('./notify');
    const settings = await getSettings(ctx.db, ctx.driver, true);
    const due = await ctx.db.query(
      "SELECT * FROM notifications_log WHERE status = 'queued' AND scheduled_at > 0 AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 200", [now()]);
    let sent = 0, failed = 0, deferred = 0, retrying = 0;
    for (const row of due) {
      const r = await notify.sendQueued(ctx.db, settings, row);
      if (r.status === 'sent') sent++;
      else if (r.status === 'deferred') deferred++;
      else if (r.status === 'queued') retrying++;
      else failed++;
    }
    return `notification batches: ${sent} sent, ${failed} failed, ${retrying} retrying, ${deferred} deferred (notifications off), ${due.length} due`;
  },
};

let timer = null;
/* D3-C1 (v20): per-job in-flight guard. A job that runs longer than
   the 60s tick (slow SMTP x 200 batch rows, a big VACUUM backup) used
   to be started AGAIN by the next tick because next_run_at was only
   written after the handler finished — queued notification batches
   were delivered twice. The guard is claimed BEFORE the handler runs
   and released in finally; tick() skips a claimed job and runNow()
   refuses with the true reason. Keyed by job id. */
const inFlight = new Set();
function claimJob(id) { if (inFlight.has(id)) return false; inFlight.add(id); return true; }
function releaseJob(id) { inFlight.delete(id); }

async function tick(ctx) {
  try {
    // SMART-ADMIN kill switch: master AUTO off freezes the whole scheduler
    // (manual Run-now from the admin console still works as the backup).
    const settings = await getSettings(ctx.db, ctx.driver, true);
    if (!getBool(settings, 'automation_master_enabled', true)) return;
    const due = await ctx.db.query(
      "SELECT * FROM cron_jobs WHERE status = 'active' AND (next_run_at IS NULL OR next_run_at <= ?)", [now()]);
    for (const job of due) {
      if (!claimJob(job.id)) continue; // still running from an earlier tick — never start it twice
      const fn = handlers[job.handler_key];
      const started = now();
      try {
        /* SCAN fix (B-09): a job whose handler_key has no handler in
           code is a MISCONFIGURATION, not a success — record it as an
           error so the console never shows green for a job that does
           nothing (can happen with a stale row after a rename). */
        if (!fn) throw new Error('no handler registered for ' + job.handler_key);
        const msg = await fn(ctx);
        await ctx.db.run(
          'UPDATE cron_jobs SET last_run_at = ?, next_run_at = ?, last_status = ?, last_message = ? WHERE id = ?',
          [started, started + job.interval_minutes * 60000, 'ok', String(msg).slice(0, 500), job.id]);
      } catch (e) {
        await ctx.db.run(
          'UPDATE cron_jobs SET last_run_at = ?, next_run_at = ?, last_status = ?, last_message = ? WHERE id = ?',
          [started, started + job.interval_minutes * 60000, 'error', String(e.message).slice(0, 500), job.id]);
        // No silent auto failures: every failed run lands in the audit log
        // and on the Automation Console's alerts block.
        try { await require('./audit').log(ctx.db, { actorId: null, actorRole: 'system', action: 'cron.failed', entity: 'cron_job', entityId: job.id, detail: job.handler_key + ': ' + String(e.message).slice(0, 300) }); } catch {}
      } finally { releaseJob(job.id); }
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
  if (!claimJob(job.id)) throw new Error('This job is already running — wait for the current run to finish before running it again.');
  const started = now();
  try {
    const msg = await fn(ctx);
    await ctx.db.run('UPDATE cron_jobs SET last_run_at = ?, last_status = ?, last_message = ? WHERE id = ?',
      [started, 'ok', String(msg).slice(0, 500), job.id]);
    return msg;
  } catch (e) {
    await ctx.db.run('UPDATE cron_jobs SET last_run_at = ?, last_status = ?, last_message = ? WHERE id = ?',
      [started, 'error', String(e.message).slice(0, 500), job.id]);
    /* D3-C2 parity: a failed Run-now must also land in cron.failed —
       previously only tick() failures were audited, so a manually-run
       failing job left no alert for the Automation Console. */
    try { await require('./audit').log(ctx.db, { actorId: null, actorRole: 'system', action: 'cron.failed', entity: 'cron_job', entityId: job.id, detail: job.handler_key + ': ' + String(e.message).slice(0, 300) }); } catch {}
    throw e;
  } finally { releaseJob(job.id); }
}

module.exports = { start, runNow, handlers, tick, inFlight };
