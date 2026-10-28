'use strict';
/* Scratch-card engine: exact inventory, outcome lock at purchase, shared wallet,
   idempotent reveal credit, responsible-play limits and auditable lifecycle. */
const crypto = require('node:crypto');
const { now, randHex, sha256 } = require('./util');
const { postLedger } = require('./money');
const { getS, getBool, getSettings } = require('./settings');

async function ensureScratchSchema(db, driver) {
  const sqlite = `
CREATE TABLE IF NOT EXISTS scratch_series (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
 game_type TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', price INTEGER NOT NULL,
 total_tickets INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'draft', enabled INTEGER NOT NULL DEFAULT 0,
 rules TEXT DEFAULT '', server_seed TEXT NOT NULL, seed_hash TEXT NOT NULL,
 created_by INTEGER, created_at INTEGER NOT NULL, launched_at INTEGER, stopped_at INTEGER, launch_at INTEGER, ends_at INTEGER);
CREATE TABLE IF NOT EXISTS scratch_prize_tiers (
 id INTEGER PRIMARY KEY AUTOINCREMENT, series_id INTEGER NOT NULL, amount INTEGER NOT NULL,
 quantity INTEGER NOT NULL, label TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS scratch_outcomes (
 id INTEGER PRIMARY KEY AUTOINCREMENT, series_id INTEGER NOT NULL, ordinal INTEGER NOT NULL,
 prize INTEGER NOT NULL DEFAULT 0, nonce TEXT NOT NULL, commitment TEXT NOT NULL,
 ticket_id INTEGER, UNIQUE(series_id, ordinal));
CREATE TABLE IF NOT EXISTS scratch_tickets (
 id INTEGER PRIMARY KEY AUTOINCREMENT, public_id TEXT UNIQUE NOT NULL, user_id INTEGER NOT NULL,
 series_id INTEGER NOT NULL, outcome_id INTEGER NOT NULL UNIQUE, currency TEXT NOT NULL,
 price INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'purchased', prize INTEGER,
 outcome_commitment TEXT NOT NULL, purchased_at INTEGER NOT NULL, revealed_at INTEGER, credited_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_scratch_ticket_user ON scratch_tickets(user_id, purchased_at);
CREATE TABLE IF NOT EXISTS scratch_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id INTEGER, event_type TEXT NOT NULL,
 entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, detail TEXT DEFAULT '{}', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS responsible_play (
 user_id INTEGER PRIMARY KEY, daily_loss_limit INTEGER DEFAULT 0, daily_deposit_limit INTEGER DEFAULT 0, session_limit_minutes INTEGER DEFAULT 0,
 cooling_off_until INTEGER DEFAULT 0, self_excluded_until INTEGER DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS responsible_play_pending (
 user_id INTEGER PRIMARY KEY, pending_daily_loss_limit INTEGER, pending_session_limit_minutes INTEGER, effective_at INTEGER NOT NULL);
`;
  const mysql = `
CREATE TABLE IF NOT EXISTS scratch_series (
 id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, title VARCHAR(255) NOT NULL, slug VARCHAR(191) UNIQUE NOT NULL,
 game_type VARCHAR(32) NOT NULL, currency VARCHAR(8) NOT NULL DEFAULT 'USD', price BIGINT NOT NULL,
 total_tickets INT NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'draft', enabled TINYINT NOT NULL DEFAULT 0,
 rules TEXT, server_seed VARCHAR(128) NOT NULL, seed_hash VARCHAR(128) NOT NULL,
 created_by BIGINT, created_at BIGINT NOT NULL, launched_at BIGINT, stopped_at BIGINT, launch_at BIGINT, ends_at BIGINT);
CREATE TABLE IF NOT EXISTS scratch_prize_tiers (
 id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, series_id BIGINT NOT NULL, amount BIGINT NOT NULL,
 quantity INT NOT NULL, label VARCHAR(255) DEFAULT '');
CREATE TABLE IF NOT EXISTS scratch_outcomes (
 id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, series_id BIGINT NOT NULL, ordinal INT NOT NULL,
 prize BIGINT NOT NULL DEFAULT 0, nonce VARCHAR(128) NOT NULL, commitment VARCHAR(128) NOT NULL,
 ticket_id BIGINT, UNIQUE KEY uq_scratch_ordinal(series_id, ordinal));
CREATE TABLE IF NOT EXISTS scratch_tickets (
 id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, public_id VARCHAR(64) UNIQUE NOT NULL, user_id BIGINT NOT NULL,
 series_id BIGINT NOT NULL, outcome_id BIGINT NOT NULL UNIQUE, currency VARCHAR(8) NOT NULL,
 price BIGINT NOT NULL, status VARCHAR(24) NOT NULL DEFAULT 'purchased', prize BIGINT,
 outcome_commitment VARCHAR(128) NOT NULL, purchased_at BIGINT NOT NULL, revealed_at BIGINT, credited_at BIGINT,
 INDEX idx_scratch_ticket_user(user_id, purchased_at));
CREATE TABLE IF NOT EXISTS scratch_events (
 id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY, actor_id BIGINT, event_type VARCHAR(64) NOT NULL,
 entity_type VARCHAR(32) NOT NULL, entity_id VARCHAR(128) NOT NULL, detail TEXT, created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS responsible_play (
 user_id BIGINT PRIMARY KEY, daily_loss_limit BIGINT DEFAULT 0, daily_deposit_limit BIGINT DEFAULT 0, session_limit_minutes INT DEFAULT 0,
 cooling_off_until BIGINT DEFAULT 0, self_excluded_until BIGINT DEFAULT 0, updated_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS responsible_play_pending (
 user_id BIGINT PRIMARY KEY, pending_daily_loss_limit BIGINT, pending_session_limit_minutes INT, effective_at BIGINT NOT NULL);
`;
  const postgres = `
CREATE TABLE IF NOT EXISTS scratch_series (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, title TEXT NOT NULL, slug TEXT UNIQUE NOT NULL,
 game_type TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', price BIGINT NOT NULL,
 total_tickets BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', enabled BIGINT NOT NULL DEFAULT 0,
 rules TEXT DEFAULT '', server_seed TEXT NOT NULL, seed_hash TEXT NOT NULL,
 created_by BIGINT, created_at BIGINT NOT NULL, launched_at BIGINT, stopped_at BIGINT, launch_at BIGINT, ends_at BIGINT);
CREATE TABLE IF NOT EXISTS scratch_prize_tiers (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, series_id BIGINT NOT NULL, amount BIGINT NOT NULL,
 quantity BIGINT NOT NULL, label TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS scratch_outcomes (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, series_id BIGINT NOT NULL, ordinal BIGINT NOT NULL,
 prize BIGINT NOT NULL DEFAULT 0, nonce TEXT NOT NULL, commitment TEXT NOT NULL,
 ticket_id BIGINT, UNIQUE(series_id, ordinal));
CREATE TABLE IF NOT EXISTS scratch_tickets (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, public_id TEXT UNIQUE NOT NULL, user_id BIGINT NOT NULL,
 series_id BIGINT NOT NULL, outcome_id BIGINT NOT NULL UNIQUE, currency TEXT NOT NULL,
 price BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'purchased', prize BIGINT,
 outcome_commitment TEXT NOT NULL, purchased_at BIGINT NOT NULL, revealed_at BIGINT, credited_at BIGINT);
CREATE INDEX IF NOT EXISTS idx_scratch_ticket_user ON scratch_tickets(user_id, purchased_at);
CREATE TABLE IF NOT EXISTS scratch_events (
 id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, actor_id BIGINT, event_type TEXT NOT NULL,
 entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, detail TEXT DEFAULT '{}', created_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS responsible_play (
 user_id BIGINT PRIMARY KEY, daily_loss_limit BIGINT DEFAULT 0, daily_deposit_limit BIGINT DEFAULT 0, session_limit_minutes BIGINT DEFAULT 0,
 cooling_off_until BIGINT DEFAULT 0, self_excluded_until BIGINT DEFAULT 0, updated_at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS responsible_play_pending (
 user_id BIGINT PRIMARY KEY, pending_daily_loss_limit BIGINT, pending_session_limit_minutes BIGINT, effective_at BIGINT NOT NULL);
`;
  await db.execScript(driver === 'mysql' ? mysql : driver === 'postgres' ? postgres : sqlite);

  const count = await db.get('SELECT COUNT(*) AS n FROM scratch_series');
  if (!count || Number(count.n) === 0) {
    const types = [
      ['Single Reveal', 'single-reveal', 'single', 'Reveal one window to see the locked prize.'],
      ['Match Three', 'match-three', 'match3', 'Reveal nine symbols. Match three identical prize symbols to win.'],
      ['Six Windows', 'six-windows', 'six', 'Reveal six windows. Any WIN window awards the locked prize.'],
      ['Bonus Gate', 'bonus-gate', 'bonus', 'A winning first reveal unlocks the bonus window.'],
    ];
    for (const [title, slug, gameType, rules] of types) {
      const seed = randHex(32);
      const r = await db.run(
        `INSERT INTO scratch_series (title,slug,game_type,currency,price,total_tickets,status,enabled,rules,server_seed,seed_hash,created_at)
         VALUES (?,?,?,?,?,?,'draft',0,?,?,?,?)`,
        [title, slug, gameType, 'USD', 100, 100, rules, seed, sha256(seed), now()]);
      await db.run('INSERT INTO scratch_prize_tiers (series_id,amount,quantity,label) VALUES (?,?,?,?)', [r.id, 100, 50, '$1 prize']);
    }
  }
  // DS-018: add the deposit-limit column to pre-existing DBs (CREATEs above
  // cover fresh DBs). Errors for already-present columns are swallowed.
  // SMART-ADMIN scratch lifecycle columns on pre-existing DBs.
  for (const col of ['launch_at', 'ends_at']) {
    try {
      await db.run(driver === 'postgres'
        ? 'ALTER TABLE scratch_series ADD COLUMN IF NOT EXISTS ' + col + ' BIGINT'
        : 'ALTER TABLE scratch_series ADD COLUMN ' + col + ' ' + (driver === 'sqlite' ? 'INTEGER' : 'BIGINT'));
    } catch {}
  }
  try {
    const colSql = driver === 'postgres'
      ? 'ALTER TABLE responsible_play ADD COLUMN IF NOT EXISTS daily_deposit_limit BIGINT DEFAULT 0'
      : 'ALTER TABLE responsible_play ADD COLUMN daily_deposit_limit INTEGER DEFAULT 0';
    await db.run(colSql);
  } catch {}
}

async function logEvent(db, actorId, eventType, entityType, entityId, detail = {}) {
  await db.run('INSERT INTO scratch_events (actor_id,event_type,entity_type,entity_id,detail,created_at) VALUES (?,?,?,?,?,?)',
    [actorId || null, eventType, entityType, String(entityId), JSON.stringify(detail), now()]);
}

function shuffleSecure(values) {
  for (let i = values.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

async function launchSeries(db, seriesId, actorId) {
  return db.transaction(async (tx) => {
    const s = await tx.get('SELECT * FROM scratch_series WHERE id = ?', [seriesId]);
    if (!s) throw new Error('Series not found');
    if (s.status !== 'draft') throw new Error('Only draft series can be launched');
    const tiers = await tx.query('SELECT * FROM scratch_prize_tiers WHERE series_id = ?', [seriesId]);
    // R-064 (engine): reject negative tiers and cap inventory.
    for (const tier of tiers) {
      if (Number(tier.amount) < 0 || Number(tier.quantity) < 0) throw new Error('Scratch tiers must not be negative');
    }
    if (Number(s.total_tickets) > 1000000) throw new Error('Scratch series inventory exceeds the 1000000 cap');
    const prizes = [];
    for (const tier of tiers) for (let i = 0; i < tier.quantity; i += 1) prizes.push(Number(tier.amount));
    if (prizes.length > s.total_tickets) throw new Error('Prize quantities exceed total ticket inventory');
    while (prizes.length < s.total_tickets) prizes.push(0);
    shuffleSecure(prizes);
    for (let i = 0; i < prizes.length; i += 1) {
      const nonce = randHex(20);
      const prize = prizes[i];
      await tx.run('INSERT INTO scratch_outcomes (series_id,ordinal,prize,nonce,commitment) VALUES (?,?,?,?,?)',
        [seriesId, i + 1, prize, nonce, sha256(`${seriesId}|${i + 1}|${nonce}|${prize}`)]);
    }
    await tx.run("UPDATE scratch_series SET status='live',enabled=1,launched_at=? WHERE id=?", [now(), seriesId]);
    await tx.run('INSERT INTO scratch_events (actor_id,event_type,entity_type,entity_id,detail,created_at) VALUES (?,?,?,?,?,?)',
      [actorId, 'series.launched', 'series', String(seriesId), JSON.stringify({ totalTickets: prizes.length }), now()]);
    return { total: prizes.length };
  });
}

async function responsibleStatus(db, userId) {
  const existing = await db.get('SELECT * FROM responsible_play WHERE user_id = ?', [userId]);
  const row = existing || {
    user_id: userId, daily_loss_limit: 0, daily_deposit_limit: 0, session_limit_minutes: 0, cooling_off_until: 0, self_excluded_until: 0,
  };
  // Pending limit DECREASES (see routes/scratch.js) take effect only after a
  // 24h delay: apply them lazily here once due, so every enforcement point
  // (scratch + lottery) sees the effective limits without a cron job. A
  // pending row that is not yet due is exposed for the template notice.
  try {
    const pend = await db.get('SELECT * FROM responsible_play_pending WHERE user_id = ?', [userId]);
    if (pend) {
      if (Number(pend.effective_at) <= now()) {
        const nd = pend.pending_daily_loss_limit !== null && pend.pending_daily_loss_limit !== undefined ? Number(pend.pending_daily_loss_limit) : Number(row.daily_loss_limit);
        const ns = pend.pending_session_limit_minutes !== null && pend.pending_session_limit_minutes !== undefined ? Number(pend.pending_session_limit_minutes) : Number(row.session_limit_minutes);
        if (existing) await db.run('UPDATE responsible_play SET daily_loss_limit = ?, session_limit_minutes = ?, updated_at = ? WHERE user_id = ?', [nd, ns, now(), userId]);
        await db.run('DELETE FROM responsible_play_pending WHERE user_id = ?', [userId]);
        row.daily_loss_limit = nd; row.session_limit_minutes = ns;
      } else {
        row.pending_daily_loss_limit = pend.pending_daily_loss_limit;
        row.pending_session_limit_minutes = pend.pending_session_limit_minutes;
        row.pending_effective_at = pend.effective_at;
      }
    }
  } catch (e) {
    // R-082: pending-limit apply errors are logged, never silently swallowed
    // in a responsible-play enforcement path.
    console.error('[responsibleStatus] pending-apply failed:', e.message);
  }
  return row;
}

/* Account-level play gate, shared by scratch AND the main lottery: a
   self-excluded or cooling-off user cannot play anything, not just scratch.
   (Previously only scratch checked this, so a self-excluded user could
   still buy lottery tickets.) DS-053: the daily LOSS limit is combined across lottery + scratch (combinedDailyNetLoss) - game-specific accounting let a player double the limit by switching games. */
async function enforceAccountPlayable(db, userId) {
  const rp = await responsibleStatus(db, userId);
  const t = now();
  if (Number(rp.self_excluded_until) > t) throw new Error('Play is unavailable during your self-exclusion period.');
  if (Number(rp.cooling_off_until) > t) throw new Error('Play is unavailable during your cooling-off period.');
}

/* DS-053: the daily loss limit is ONE limit across BOTH games. It used to
   be enforced per game (lottery enforcer summed lottery rows only, scratch
   enforcer summed scratch rows only), so a player could lose 2x the set
   limit in one day. Both enforcers now use the combined UTC-day net loss:
   lottery net (ticket_purchase debits minus win credits) + scratch net
   (scratch_tickets spent minus prizes), per currency when known. */
async function combinedDailyNetLoss(db, userId, start, currency) {
  const params = [userId, start]; let curSql = '';
  if (currency) { curSql = ' AND currency = ?'; params.push(currency); }
  const lot = await db.get(
    `SELECT COALESCE(SUM(CASE WHEN type = 'ticket_purchase' THEN ABS(amount) ELSE 0 END),0) AS spent,
            COALESCE(SUM(CASE WHEN type = 'win' THEN amount ELSE 0 END),0) AS won
     FROM transactions WHERE user_id = ? AND created_at >= ?${curSql}`, params);
  const scr = await db.get(
    `SELECT COALESCE(SUM(price),0) AS spent, COALESCE(SUM(CASE WHEN prize IS NULL THEN 0 ELSE prize END),0) AS won
     FROM scratch_tickets WHERE user_id=? AND purchased_at>=?${curSql}`, params);
  return (Number(lot.spent) - Number(lot.won)) + (Number(scr.spent) - Number(scr.won));
}
async function enforceResponsiblePlay(db, userId, price, currency = null) {
  await enforceAccountPlayable(db, userId);
  const rp = await responsibleStatus(db, userId);
  if (Number(rp.daily_loss_limit) > 0) {
    // R-019: UTC midnight for every limit window; R-020: currency-filtered.
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    if ((await combinedDailyNetLoss(db, userId, start.getTime(), currency) + price) > Number(rp.daily_loss_limit)) throw new Error('This purchase would exceed your daily loss limit.');
  }
}

/* Lottery counterpart: same daily loss limit, now COMBINED across both
   games (DS-053 — see combinedDailyNetLoss above). Called INSIDE the buy
   transaction so the check and the debit are atomic. */
async function enforceLotteryLossLimit(db, userId, total, currency = null) {
  const rp = await responsibleStatus(db, userId);
  if (Number(rp.daily_loss_limit) > 0) {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    if ((await combinedDailyNetLoss(db, userId, start.getTime(), currency) + total) > Number(rp.daily_loss_limit)) throw new Error('This purchase would exceed your daily loss limit.');
  }
}

async function buyTicket(db, userId, seriesId, ip) {
  const s = await db.get("SELECT * FROM scratch_series WHERE id=? AND status='live' AND enabled=1", [seriesId]);
  if (!s) throw new Error('This scratch series is not on sale.');
  return db.transaction(async (tx) => {
    // R-078: re-check series status INSIDE the txn (stop race), and
    // R-018: run the loss-limit check INSIDE the txn on the tx handle,
    // mirroring the lottery buy — check + debit are now atomic.
    const live = await tx.get("SELECT * FROM scratch_series WHERE id=? AND status='live' AND enabled=1", [seriesId]);
    if (!live) throw new Error('This scratch series is not on sale.');
    await enforceResponsiblePlay(tx, userId, Number(live.price), live.currency);
    const outcome = await tx.get('SELECT * FROM scratch_outcomes WHERE series_id=? AND ticket_id IS NULL ORDER BY id LIMIT 1', [seriesId]);
    if (!outcome) throw new Error('This scratch series is sold out.');
    const publicId = 'S' + now().toString(36).toUpperCase() + randHex(4).toUpperCase();
    const r = await tx.run(
      `INSERT INTO scratch_tickets (public_id,user_id,series_id,outcome_id,currency,price,status,prize,outcome_commitment,purchased_at)
       VALUES (?,?,?,?,?,?,'purchased',NULL,?,?)`,
      [publicId, userId, seriesId, outcome.id, live.currency, live.price, outcome.commitment, now()]);
    // v16: check the claim actually landed. Without this, two concurrent buys
    // on Postgres/MySQL could both read the same unsold outcome; the loser's
    // claim silently affected 0 rows while its ticket still pointed at the
    // taken outcome (the UNIQUE(outcome_id) then failed with a confusing
    // error instead of a clean retry).
    const claimed = await tx.run('UPDATE scratch_outcomes SET ticket_id=? WHERE id=? AND ticket_id IS NULL', [r.id, outcome.id]);
    if (claimed.changes === 0) throw new Error('This outcome was just claimed by another purchase — please try again.');
    await postLedger(tx, { userId, currency: live.currency, type: 'scratch_purchase', amount: -Number(live.price), refType: 'scratch_ticket', refId: publicId, meta: { seriesId, ip } });
    try { await require('./bonus').accrueWagering(tx, userId, live.currency, Number(live.price)); } catch {}
    // DS-052: referral accrual parity - scratch buys used to earn the
    // referrer nothing while lottery buys accrued pending credits.
    try {
      const settings = await getSettings(db, db.driver);
      if (getBool(settings, 'referral_enabled', false)) {
        const rate = parseFloat(getS(settings, 'referral_rate', '5')) || 0;
        const buyer = await tx.get('SELECT referred_by FROM users WHERE id = ?', [userId]);
        if (buyer && buyer.referred_by && rate > 0) {
          const ref = await tx.get('SELECT status FROM users WHERE id = ?', [buyer.referred_by]);
          const comm = Math.round(Number(live.price) * rate / 100);
          if (ref && ref.status === 'active' && comm > 0) await tx.run('INSERT INTO referral_credits (referrer_id, referee_id, ticket_id, currency, amount, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [buyer.referred_by, userId, r.id, live.currency, comm, 'pending', now()]);
        }
      }
    } catch (e) { console.error('[scratch] referral accrual failed:', e.message); }
    await tx.run('INSERT INTO scratch_events (actor_id,event_type,entity_type,entity_id,detail,created_at) VALUES (?,?,?,?,?,?)',
      [userId, 'ticket.purchased', 'ticket', publicId, JSON.stringify({ seriesId, price: live.price }), now()]);
    return { publicId };
  });
}

async function revealTicket(db, userId, publicId) {
  return db.transaction(async (tx) => {
    const t = await tx.get(
      `SELECT st.*, so.prize AS locked_prize, so.nonce, so.ordinal FROM scratch_tickets st
       JOIN scratch_outcomes so ON so.id=st.outcome_id WHERE st.public_id=? AND st.user_id=?`, [publicId, userId]);
    if (!t) throw new Error('Scratch ticket not found.');
    if (t.status === 'revealed') return { prize: Number(t.prize || 0), duplicate: true };
    // v16: verify the outcome commitment BEFORE crediting. The prize used to
    // come straight from the DB with no check — a DB insider who altered an
    // outcome's prize after launch could change payouts silently. The check
    // runs against the commitment stored ON THE TICKET at purchase time
    // (st.outcome_commitment), not the outcome row itself, so altering the
    // outcome row cannot pass verification. Any mismatch fails loudly.
    const expectedCommitment = sha256(`${t.series_id}|${t.ordinal}|${t.nonce}|${Number(t.locked_prize || 0)}`);
    if (t.outcome_commitment && expectedCommitment !== t.outcome_commitment) throw new Error('Outcome commitment mismatch — reveal refused. Contact support.');
    // v16: clamp — a negative prize (corrupt/insider row) must never debit.
    const prize = Math.max(0, Number(t.locked_prize || 0));
    const stamp = now();
    // v16: check the reveal actually landed. Without this, two concurrent
    // reveals on Postgres/MySQL could both read 'purchased' and both credit
    // (the UPDATE's WHERE clause makes the second a no-op, but the code used
    // to ignore that and credit anyway — a real double-credit).
    const revealed = await tx.run("UPDATE scratch_tickets SET status='revealed',prize=?,revealed_at=? WHERE id=? AND status='purchased'", [prize, stamp, t.id]);
    if (revealed.changes === 0) return { prize: Number(t.prize || 0), duplicate: true };
    if (prize > 0) {
      await postLedger(tx, { userId, currency: t.currency, type: 'scratch_prize', amount: prize, refType: 'scratch_ticket', refId: publicId, meta: { seriesId: t.series_id } });
      await tx.run('UPDATE scratch_tickets SET credited_at=? WHERE id=?', [stamp, t.id]);
    }
    await tx.run('INSERT INTO scratch_events (actor_id,event_type,entity_type,entity_id,detail,created_at) VALUES (?,?,?,?,?,?)',
      [userId, 'ticket.revealed', 'ticket', publicId, JSON.stringify({ win: prize > 0 }), stamp]);
    return { prize, duplicate: false };
  });
}


/* SMART-ADMIN scratch lifecycle (scheduler-driven):
   - activate drafts whose scheduled launch_at has arrived;
   - stop live series whose ends_at has passed;
   - close live series that sold out (outcomes exist, none unclaimed);
   - optionally auto-create + launch the NEXT series from the operator's
     template when a series ends (toggle + template in settings).
   Outcomes are generated by launchSeries from a fresh server seed - the
   lifecycle never influences WHAT a card pays, only WHEN a series runs. */
async function scratchLifecycle(db, settings) {
  if (!getBool(settings, 'automation_master_enabled', true)) return { skipped: 'master off' };
  const t = now();
  const out = { activated: 0, stopped: 0, soldOut: 0, cloned: 0, guardrailAlerts: 0, launchBlocked: 0 };
  const endedNow = [];
  const engine = require('./prize-engine');
  const audit = require('./audit');
  const due = await db.query("SELECT id FROM scratch_series WHERE status = 'draft' AND launch_at IS NOT NULL AND launch_at > 0 AND launch_at <= ?", [t]);
  for (const r of due) {
    // BP-23 launch cap: a scheduled launch that would breach the
    // liability cap is SKIPPED (the series stays a draft) and alerted —
    // never launched anyway and never silently dropped.
    try {
      const srow = await db.get('SELECT * FROM scratch_series WHERE id = ?', [r.id]);
      const expo = await engine.seriesExposure(db, srow);
      const cap = engine.launchCapCheck(settings, srow, expo.totalLiability);
      if (cap.enforced && !cap.ok) {
        out.launchBlocked += 1;
        await logEvent(db, null, 'series.launch_blocked_cap', 'series', r.id, { liability: cap.liability, cap: cap.cap, capPct: cap.capPct });
        await audit.log(db, { actorId: null, actorRole: 'system', action: 'scratch.guardrail_launch_blocked', entity: 'series', entityId: String(r.id), detail: { liability: cap.liability, cap: cap.cap, capPct: cap.capPct } });
        continue;
      }
    } catch (e) {
      /* SCAN fix (B-04): the cap check fails CLOSED. An internal error
         while computing exposure must never launch the series
         unguarded — skip, leave a trace, retry next tick. */
      out.launchBlocked += 1;
      await logEvent(db, null, 'series.launch_check_failed', 'series', r.id, { error: String(e && e.message || e) });
      await audit.log(db, { actorId: null, actorRole: 'system', action: 'scratch.guardrail_check_failed', entity: 'series', entityId: String(r.id), detail: { error: String(e && e.message || e) } });
      continue;
    }
    try { await launchSeries(db, r.id, null); out.activated += 1; await logEvent(db, null, 'series.auto_launched', 'series', r.id, {}); }
    catch (e) {
      /* SCAN fix (B-04): a failed scheduled launch is traced, not
         swallowed — the Automation Console and audit log can see it. */
      await logEvent(db, null, 'series.launch_failed', 'series', r.id, { error: String(e && e.message || e) });
      await audit.log(db, { actorId: null, actorRole: 'system', action: 'scratch.launch_failed', entity: 'series', entityId: String(r.id), detail: { error: String(e && e.message || e) } });
    }
  }
  const expiring = await db.query("SELECT id FROM scratch_series WHERE status = 'live' AND ends_at IS NOT NULL AND ends_at > 0 AND ends_at <= ?", [t]);
  for (const r of expiring) {
    await db.run("UPDATE scratch_series SET status = 'stopped', enabled = 0, stopped_at = ? WHERE id = ?", [t, r.id]);
    await logEvent(db, null, 'series.auto_stopped_enddate', 'series', r.id, {});
    out.stopped += 1; endedNow.push(r.id);
  }
  const live = await db.query("SELECT id FROM scratch_series WHERE status = 'live'");
  for (const r of live) {
    const total = await db.get('SELECT COUNT(*) AS c FROM scratch_outcomes WHERE series_id = ?', [r.id]);
    if (!total || Number(total.c) === 0) continue;
    const left = await db.get("SELECT COUNT(*) AS c FROM scratch_outcomes WHERE series_id = ? AND ticket_id IS NULL", [r.id]);
    if (left && Number(left.c) === 0) {
      await db.run("UPDATE scratch_series SET status = 'ended', enabled = 0, stopped_at = ? WHERE id = ?", [t, r.id]);
      await logEvent(db, null, 'series.auto_closed_soldout', 'series', r.id, {});
      out.soldOut += 1; endedNow.push(r.id);
    }
  }
  /* BP-23 guardrails on LIVE series: watch the unsold tail. When the
     remaining tickets' implied RTP (remaining liability / remaining
     sales value) crosses the admin's threshold, alert — and, if the
     admin chose an action, close sales or stop auto-next. Alerts are
     rate-limited to one per series per 24h via scratch_events. This
     never changes a sold ticket or an unsold outcome — only whether
     MORE tickets may be sold. */
  if (getBool(settings, 'scratch_guardrail_enabled')) {
    const threshold = Number(getS(settings, 'scratch_alert_threshold_pct', '90')) || 90;
    const action = getS(settings, 'scratch_guardrail_action', 'alert');
    const liveRows = await db.query("SELECT * FROM scratch_series WHERE status = 'live'");
    for (const srow of liveRows) {
      try {
        const expo = await engine.seriesExposure(db, srow);
        if (expo.remainingTickets <= 0 || expo.tailRtpPct <= threshold) continue;
        const last = await db.get("SELECT created_at FROM scratch_events WHERE event_type = 'series.guardrail_alert' AND entity_type = 'series' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(srow.id)]);
        if (last && t - Number(last.created_at) < 24 * 3600 * 1000) continue;
        out.guardrailAlerts += 1;
        const detail = { tailRtpPct: Math.round(expo.tailRtpPct * 10) / 10, threshold, remainingLiability: expo.remainingLiability, remainingTickets: expo.remainingTickets, action };
        await logEvent(db, null, 'series.guardrail_alert', 'series', srow.id, detail);
        await audit.log(db, { actorId: null, actorRole: 'system', action: 'scratch.guardrail_alert', entity: 'series', entityId: String(srow.id), detail });
        if (action === 'close_sales') {
          await db.run('UPDATE scratch_series SET enabled = 0 WHERE id = ?', [srow.id]);
          await logEvent(db, null, 'series.guardrail_closed_sales', 'series', srow.id, detail);
          await audit.log(db, { actorId: null, actorRole: 'system', action: 'scratch.guardrail_close_sales', entity: 'series', entityId: String(srow.id), detail });
        } else if (action === 'stop_auto_next') {
          const { setSetting } = require('./settings');
          await setSetting(db, db.driver, 'scratch_auto_next_enabled', '0');
          await audit.log(db, { actorId: null, actorRole: 'system', action: 'scratch.guardrail_stop_auto_next', entity: 'settings', entityId: '', detail });
        }
      } catch {}
    }
  }
  if (endedNow.length && getBool(settings, 'scratch_auto_next_enabled', false)) {
    const tplId = parseInt(getS(settings, 'scratch_template_series_id', ''), 10) || 0;
    const tpl = tplId ? await db.get('SELECT * FROM scratch_series WHERE id = ?', [tplId]) : null;
    if (tpl) {
      const liveTpl = await db.get("SELECT id FROM scratch_series WHERE status = 'live' AND slug LIKE ?", [tpl.slug + '-%']);
      const tplLive = tpl.status === 'live';
      if (!liveTpl && !tplLive) {
        const seed = randHex(32);
        const slug = tpl.slug + '-' + t.toString(36);
        /* BP-23(c) SMART AUTO-NEXT POOL: when enabled, the next pool is
           REGENERATED by the planner instead of cloned: the inventory
           follows the just-ended series' actual sell-through and the
           liability is re-planned at the admin's target RTP.
           Formula (documented): sellThrough = sold/total of the ended
           series; nextTotal = template total when sellThrough ≥ 99.9%,
           else max(50, round(template total × sellThrough)); tiers =
           planPrizePool(price, nextTotal, targetRtp). Any planner
           failure falls back to the legacy verbatim clone. Only the
           NEW series' pool is designed — a live series never changes. */
        let smart = null;
        if (getBool(settings, 'scratch_smart_pool_enabled')) {
          try {
            const ended = await db.get('SELECT * FROM scratch_series WHERE id = ?', [endedNow[0]]);
            if (ended) {
              const agg = await db.get('SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ticket_id IS NOT NULL THEN 1 ELSE 0 END),0) AS sold FROM scratch_outcomes WHERE series_id = ?', [ended.id]);
              const totalO = Number(agg.total) || Number(ended.total_tickets);
              const sellThrough = totalO > 0 ? Number(agg.sold) / totalO : 0;
              const nextTotal = sellThrough >= 0.999 ? Number(tpl.total_tickets) : Math.max(50, Math.round(Number(tpl.total_tickets) * sellThrough));
              const plan = engine.planPrizePool({ price: Number(tpl.price), totalTickets: nextTotal, targetRtpPct: Number(getS(settings, 'scratch_planner_target_rtp', '75')) });
              if (plan.ok) smart = { plan, sellThrough, nextTotal };
            }
          } catch {}
        }
        const r = await db.run(
          `INSERT INTO scratch_series (title,slug,game_type,currency,price,total_tickets,status,enabled,rules,server_seed,seed_hash,created_at)
           VALUES (?,?,?, ?,?,?,'draft',0,?,?,?,?)`,
          [tpl.title, slug, tpl.game_type, tpl.currency, tpl.price, smart ? smart.nextTotal : tpl.total_tickets, tpl.rules || '', seed, sha256(seed), t]);
        try {
          if (smart) {
            for (const tier of smart.plan.tiers) await db.run('INSERT INTO scratch_prize_tiers (series_id,amount,quantity,label) VALUES (?,?,?,?)', [r.id, tier.amount, tier.quantity, 'Planner prize']);
          } else {
            const tiers = await db.query('SELECT * FROM scratch_prize_tiers WHERE series_id = ?', [tpl.id]);
            for (const tier of tiers) await db.run('INSERT INTO scratch_prize_tiers (series_id,amount,quantity,label) VALUES (?,?,?,?)', [r.id, tier.amount, tier.quantity, tier.label]);
          }
          /* SCAN fix (B-05): the auto-next launch obeys the same BP-23
             liability cap as every other launch path. Over cap → the
             clone stays a DUE draft and the normal scheduled-launch
             path (with its own cap check + trace) owns it from here. */
          const cloneRow = await db.get('SELECT * FROM scratch_series WHERE id = ?', [r.id]);
          const cloneExpo = await engine.seriesExposure(db, cloneRow);
          const cloneCap = engine.launchCapCheck(settings, cloneRow, cloneExpo.totalLiability);
          if (cloneCap.enforced && !cloneCap.ok) {
            await db.run('UPDATE scratch_series SET launch_at = ? WHERE id = ?', [t, r.id]);
            await logEvent(db, null, 'series.auto_next_created', 'series', r.id, { template: tpl.id, after: endedNow.join(','), smartPool: !!smart, capBlocked: true, liability: cloneCap.liability, cap: cloneCap.cap });
            await audit.log(db, { actorId: null, actorRole: 'system', action: 'scratch.guardrail_launch_blocked', entity: 'series', entityId: String(r.id), detail: { liability: cloneCap.liability, cap: cloneCap.cap, capPct: cloneCap.capPct, via: 'auto_next' } });
            out.cloned += 1;
          } else {
            await launchSeries(db, r.id, null);
            await logEvent(db, null, 'series.auto_next_created', 'series', r.id, { template: tpl.id, after: endedNow.join(','), smartPool: !!smart, sellThrough: smart ? Math.round(smart.sellThrough * 1000) / 1000 : undefined, nextTotal: smart ? smart.nextTotal : undefined, liability: smart ? smart.plan.liability : undefined });
            out.cloned += 1;
          }
        } catch (e) {
          /* SCAN fix (B-05): never leave an orphan half-built clone —
             remove the draft and its tiers, and trace the failure. */
          await db.run('DELETE FROM scratch_prize_tiers WHERE series_id = ?', [r.id]).catch(() => {});
          await db.run('DELETE FROM scratch_series WHERE id = ?', [r.id]).catch(() => {});
          await logEvent(db, null, 'series.auto_next_failed', 'series', tpl.id, { error: String(e && e.message || e) });
          await audit.log(db, { actorId: null, actorRole: 'system', action: 'scratch.auto_next_failed', entity: 'series', entityId: String(tpl.id), detail: { error: String(e && e.message || e) } });
        }
      }
    }
  }
  return out;
}

module.exports = {
  scratchLifecycle, ensureScratchSchema, logEvent, launchSeries, responsibleStatus, enforceAccountPlayable, enforceLotteryLossLimit, buyTicket, revealTicket };
