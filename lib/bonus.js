'use strict';
/* SMART-ADMIN BONUS ENGINE.
   Promotional credit ONLY: grants are operator-funded marketing money posted
   to the ledger as type 'bonus' (the same label the deposit-bonus uses) and
   recorded in bonus_grants for audit. This module NEVER touches game
   outcomes, draws, tickets or scratch results - it cannot make anyone win;
   it can only credit a promotional balance under the campaign's rules
   (audience, validity window, per-user cap, total budget with auto-stop). */
const { randomInt } = require('node:crypto');
const { now } = require('./util');
const { getBool } = require('./settings');
const { postLedger } = require('./money');
const audit = require('./audit');

function inWindow(c, t) {
  if (!c.active) return false;
  if (c.starts_at && c.starts_at > t) return false;
  if (c.ends_at && c.ends_at < t) return false;
  return true;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* Resolve a campaign's audience to player ids. ctx.userId narrows the
   event-bound audiences (signup / first deposit act on the triggering user). */
async function resolveAudience(db, campaign, ctx = {}) {
  if (ctx.userId && (campaign.trigger_type === 'signup' || campaign.trigger_type === 'first_deposit')) {
    if (campaign.audience === 'first_n') {
      const r = await db.get("SELECT COUNT(*) AS c FROM users WHERE role = 'player' AND id <= ?", [ctx.userId]);
      return Number(r.c) <= (campaign.audience_n || 0) ? [ctx.userId] : [];
    }
    return [ctx.userId]; // 'all' / 'new' / 'random_n' on an event = the triggering player
  }
  const rows = await db.query("SELECT id FROM users WHERE role = 'player' AND status != 'blocked' ORDER BY id ASC");
  const ids = rows.map((r) => r.id);
  if (campaign.audience === 'first_n') return ids.slice(0, campaign.audience_n || 0);
  if (campaign.audience === 'random_n') return shuffle(ids.slice()).slice(0, campaign.audience_n || 0);
  return ids; // 'all' (and 'new' for a scheduled/manual run = everyone currently registered)
}

function amountFor(campaign, baseAmount) {
  if (campaign.amount_type === 'percent') {
    if (!baseAmount) return 0; // a % campaign needs its base event (a deposit)
    return Math.floor((baseAmount * Number(campaign.amount)) / 100);
  }
  return Number(campaign.amount) || 0;
}

/* Execute one campaign run. Returns a summary; every grant is a 'bonus'
   ledger credit + a bonus_grants row, inside ONE transaction so the budget
   accounting can never overshoot. Auto-stop: hitting the budget cap flips
   the campaign inactive and is audit-logged. */
async function runCampaign(db, campaignId, triggerType, settings, ctx = {}) {
  if (!getBool(settings, 'bonus_enabled', true)) return { skipped: 'bonus engine off' };
  if (!ctx.manual && !getBool(settings, 'automation_master_enabled', true)) return { skipped: 'automation master off' };
  const t = now();
  return db.transaction(async (tx) => {
    const c = await tx.get('SELECT * FROM bonus_campaigns WHERE id = ?', [campaignId]);
    if (!c) return { skipped: 'campaign not found' };
    if (!c.active) return { skipped: 'campaign inactive' };
    if (!ctx.manual && !inWindow(c, t)) return { skipped: 'outside validity window' };
    const ids = await resolveAudience(tx, c, ctx);
    let granted = 0, total = 0, stopped = false;
    for (const userId of ids) {
      let amount = amountFor(c, ctx.baseAmount);
      if (amount <= 0) continue;
      if (c.per_user_cap > 0) {
        const prior = await tx.get('SELECT COALESCE(SUM(amount),0) AS s FROM bonus_grants WHERE campaign_id = ? AND user_id = ?', [c.id, userId]);
        amount = Math.min(amount, Number(c.per_user_cap) - Number(prior.s));
        if (amount <= 0) continue;
      }
      if (c.budget_cap > 0) {
        const fresh = await tx.get('SELECT granted_total FROM bonus_campaigns WHERE id = ?', [c.id]);
        amount = Math.min(amount, Number(c.budget_cap) - Number(fresh.granted_total));
        if (amount <= 0) { stopped = true; break; }
      }
      const bal = await postLedger(tx, {
        userId, currency: c.currency, type: 'bonus', amount,
        refType: 'bonus_campaign', refId: c.id, note: 'Bonus: ' + c.name,
      });
      if (bal === null) continue;
      await tx.run(
        'INSERT INTO bonus_grants (campaign_id, user_id, amount, currency, trigger_type, wagering_required, wagered, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
        [c.id, userId, amount, c.currency, triggerType, Math.round(amount * (Number(c.wagering_x) || 0)), t]);
      await tx.run('UPDATE bonus_campaigns SET granted_total = granted_total + ? WHERE id = ?', [amount, c.id]);
      granted += 1; total += amount;
      if (c.budget_cap > 0) {
        const fresh = await tx.get('SELECT granted_total FROM bonus_campaigns WHERE id = ?', [c.id]);
        if (Number(fresh.granted_total) >= Number(c.budget_cap)) { stopped = true; break; }
      }
    }
    if (stopped) await tx.run('UPDATE bonus_campaigns SET active = 0 WHERE id = ?', [c.id]);
    await audit.log(tx, {
      actorId: ctx.actorId || null, actorRole: ctx.actorId ? 'admin' : 'system',
      action: 'bonus.run', entity: 'bonus_campaign', entityId: c.id,
      detail: c.name + ' [' + triggerType + ']: ' + granted + ' grants, total ' + total + ' minor ' + c.currency + (stopped ? ' - budget exhausted, campaign auto-stopped' : ''),
    });
    return { granted, total, stopped };
  });
}

/* Event hooks (called from register / deposit-decision flows). */
async function onSignup(db, settings, userId) {
  const camps = await db.query("SELECT id FROM bonus_campaigns WHERE trigger_type = 'signup' AND active = 1");
  for (const c of camps) {
    try { await runCampaign(db, c.id, 'signup', settings, { userId }); } catch {}
  }
}

async function onFirstDeposit(db, settings, userId, depositAmount, currency) {
  // "First" = this approval is the user's first approved deposit overall.
  const r = await db.get("SELECT COUNT(*) AS c FROM transactions WHERE user_id = ? AND type = 'deposit'", [userId]);
  if (!r || Number(r.c) !== 1) return;
  const camps = await db.query("SELECT id FROM bonus_campaigns WHERE trigger_type = 'first_deposit' AND active = 1 AND currency = ?", [currency]);
  for (const c of camps) {
    try { await runCampaign(db, c.id, 'first_deposit', settings, { userId, baseAmount: depositAmount }); } catch {}
  }
}

/* Scheduler path: 'scheduled' campaigns fire ONE drop when their window
   opens; re-arming is done by moving starts_at forward (last_drop_at then
   predates starts_at again). */
async function runScheduledDrops(db, settings) {
  const t = now();
  const camps = await db.query(
    "SELECT id FROM bonus_campaigns WHERE trigger_type = 'scheduled' AND active = 1 AND starts_at > 0 AND starts_at <= ? AND (last_drop_at = 0 OR last_drop_at < starts_at)", [t]);
  const out = [];
  for (const c of camps) {
    const res = await runCampaign(db, c.id, 'scheduled', settings, {});
    /* D3-C3 (v20): stamp last_drop_at ONLY when the campaign actually
       ran. A skipped run (bonus engine off, automation master off,
       inactive, outside window) used to be stamped anyway — the drop
       was silently destroyed (the scheduler query requires
       last_drop_at < starts_at) while the console reported it as
       fired. Skipped campaigns stay due and fire when the blocker
       clears. */
    if (!res.skipped) await db.run('UPDATE bonus_campaigns SET last_drop_at = ? WHERE id = ?', [t, c.id]);
    out.push({ campaignId: c.id, ...res });
  }
  return out;
}

/* Wagering progress: every real-money game purchase counts toward the
   player's oldest unmet bonus wagering requirement (per currency). */
async function accrueWagering(db, userId, currency, amount) {
  try {
    let remaining = amount;
    while (remaining > 0) {
      const g = await db.get(
        'SELECT id, wagering_required, wagered FROM bonus_grants WHERE user_id = ? AND currency = ? AND wagering_required > wagered ORDER BY id ASC', [userId, currency]);
      if (!g) break;
      const add = Math.min(remaining, Number(g.wagering_required) - Number(g.wagered));
      await db.run('UPDATE bonus_grants SET wagered = wagered + ? WHERE id = ?', [add, g.id]);
      remaining -= add;
    }
  } catch {} // table absent in legacy unit fixtures: wagering simply untracked
}

/* D1-C5b (v20): REVERSE wagering progress when a stake is refunded.
   FINDING (mechanism): bonus wagering progress is NOT computed from
   ledger sums — it is a stored counter (bonus_grants.wagered) that
   accrueWagering increments at buy time, with no per-ticket link. So
   the D1-C4 ledger netting cannot fix this half; the reversal must
   decrement the stored counter. cancelDraw calls this with the total
   refunded per user+currency. Grants are decremented in the SAME
   oldest-first order accrueWagering filled them, each floored at 0, so
   the AGGREGATE unmet requirement (what unmetWagering sums, and the
   only thing the withdrawal gate reads) returns exactly to its
   pre-purchase value. Per-grant attribution after interleaved buys is
   aggregate-exact, not ticket-exact — the counter never recorded
   which ticket filled which grant. */
async function reverseWagering(db, userId, currency, amount) {
  try {
    let remaining = Number(amount) || 0;
    while (remaining > 0) {
      const g = await db.get(
        'SELECT id, wagered FROM bonus_grants WHERE user_id = ? AND currency = ? AND wagered > 0 ORDER BY id ASC', [userId, currency]);
      if (!g) break;
      const sub = Math.min(remaining, Number(g.wagered));
      await db.run('UPDATE bonus_grants SET wagered = wagered - ? WHERE id = ?', [sub, g.id]);
      remaining -= sub;
    }
  } catch {} // table absent in legacy unit fixtures: wagering simply untracked
}

async function unmetWagering(db, userId, currency) {
  try {
    const r = await db.get(
      'SELECT COALESCE(SUM(wagering_required - wagered),0) AS s FROM bonus_grants WHERE user_id = ? AND currency = ? AND wagering_required > wagered', [userId, currency]);
    return r ? Number(r.s) : 0;
  } catch { return 0; }
}

module.exports = { runCampaign, onSignup, onFirstDeposit, runScheduledDrops, accrueWagering, reverseWagering, unmetWagering, resolveAudience, inWindow };
