'use strict';
/* Draw engine: scheduling, provably-fair seed commit/reveal, settlement.
   Production draws are ALWAYS server-random. A winning-number override is
   possible ONLY on draws explicitly created as TEST draws, and is audit-logged. */
const { now, randHex, sha256, hmac } = require('./util');
const { getS, getBool } = require('./settings');
const { postLedger } = require('./money');
const audit = require('./audit');
const { fetchBeacon, combineSeed, deriveWinningNumberFair, deriveWinningNumberLegacy } = require('./beacon');

/* Deterministic winning number from the revealed seed: 1..15 */
function deriveWinningNumber(seedHex, drawId) {
  const h = hmac(seedHex, 'cashpop-draw:' + drawId);
  const n = parseInt(h.slice(0, 8), 16);
  return (n % 15) + 1;
}

function drawDateStr(d = new Date()) {
  return d.toISOString().slice(0, 10);
}
function closeAtFor(dateStr, timeStr) {
  // UTC-consistent: drawDateStr is UTC (toISOString), so the close time must
  // also be UTC. The old code built a LOCAL midnight then set local hours,
  // mixing a UTC date with server-local time — draws shifted with the
  // server timezone and could be created already past close near midnight.
  const [hh, mm] = String(timeStr || '14:00').split(':').map(Number);
  const [y, mo, da] = String(dateStr).split('-').map(Number);
  return Date.UTC(y, (mo || 1) - 1, (da || 1), hh || 0, mm || 0, 0, 0);
}

/* Create upcoming Day/Eve draws for the next N days (idempotent). */
async function ensureUpcomingDraws(db, settings) {
  const days = parseInt(getS(settings, 'upcoming_draw_days', '7'), 10) || 7;
  const dayTime = getS(settings, 'day_draw_time', '14:00');
  const eveTime = getS(settings, 'eve_draw_time', '21:00');
  const t = now();
  for (let i = 0; i < days; i++) {
    const d = new Date(t + i * 86400000);
    const ds = drawDateStr(d);
    for (const [type, timeStr] of [['DAY', dayTime], ['EVE', eveTime]]) {
      const ex = await db.get('SELECT id FROM draws WHERE draw_type = ? AND draw_date = ?', [type, ds]);
      if (ex) continue;
      const seed = randHex(32);
      await db.run(
        'INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, is_test, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
        [type, ds, closeAtFor(ds, timeStr), 'scheduled', sha256(seed), seed, t]
      );
    }
  }
}

/* Admin creates a TEST draw with optional fixed winning number (audit-logged). */
async function createTestDraw(db, { dateStr, timeStr, overrideNumber = null, adminId, ip }) {
  const seed = randHex(32);
  const r = await db.run(
    'INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, is_test, override_by, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
    ['TEST', dateStr, closeAtFor(dateStr, timeStr || '12:00'), 'scheduled', sha256(seed), seed, adminId, now()]
  );
  const drawId = r.id;
  let winning = null;
  if (overrideNumber !== null && overrideNumber !== undefined && overrideNumber !== '') {
    winning = Math.max(1, Math.min(15, parseInt(overrideNumber, 10)));
    await db.run('UPDATE draws SET winning_number = ? WHERE id = ?', [winning, drawId]);
  }
  await audit.log(db, {
    actorId: adminId, actorRole: 'admin', action: 'draw.test.create',
    entity: 'draw', entityId: drawId,
    detail: { date: dateStr, overrideNumber: winning }, ip,
  });
  return drawId;
}

/* Close due draws, determine winning numbers, settle entries, reveal seeds. */
async function settleDueDraws(db, settings) {
  const t = now();
  const due = await db.query("SELECT * FROM draws WHERE status = 'scheduled' AND close_at <= ?", [t]);
  const results = [];
  for (const draw of due) {
    const res = await settleDraw(db, draw.id, settings, { byCron: true });
    results.push(res);
  }
  return results;
}

async function settleDraw(db, drawId, settings, { byCron = false, actorId = null, ip = '' } = {}) {
  return db.transaction(async (tx) => {
    const draw = await tx.get('SELECT * FROM draws WHERE id = ?', [drawId]);
    if (!draw) throw new Error('Draw not found');
    if (draw.status !== 'scheduled') return { drawId, skipped: true };
    // A real draw can only settle at/after its close time. The old code let
    // one admin settle any scheduled draw early (before sales closed).
    // Test draws are exempt: they exist to be settled on demand.
    if (!draw.is_test && draw.close_at > now()) throw new Error('Draw has not closed yet');

    // Determine winning number (v14): the committed server seed is combined
    // with a public drand beacon round (when enabled), then mapped 1..15 by
    // rejection sampling. TEST overrides are untouched.
    let winning = draw.winning_number;
    let beaconRound = draw.beacon_round ?? null;
    let beaconRandomness = draw.beacon_randomness || '';
    let beaconSignature = draw.beacon_signature || '';
    let beaconStatus = draw.beacon_status || '';
    if (draw.is_test && winning) {
      // TEST override — already set at creation, audit-logged there.
    } else {
      if (!draw.seed) throw new Error('Draw seed missing');
      let finalSeed = draw.seed;
      const beaconEnabled = getBool(settings, 'beacon_enabled', true);
      const beaconRequired = getBool(settings, 'beacon_required', false);
      if (!beaconEnabled) {
        beaconStatus = 'disabled';
      } else {
        try {
          const b = await fetchBeacon();
          finalSeed = combineSeed(draw.seed, b.randomness);
          beaconRound = b.round; beaconRandomness = b.randomness; beaconSignature = b.signature;
          beaconStatus = 'ok';
        } catch (e) {
          if (beaconRequired) throw new Error('Beacon unavailable — draw stays scheduled: ' + e.message);
          beaconStatus = 'fallback';
          beaconRound = null; beaconRandomness = ''; beaconSignature = '';
        }
      }
      winning = deriveWinningNumberFair(finalSeed, draw.id); // ALWAYS random in production
    }

    // Settle every pending entry in this draw
    const entries = await tx.query(
      `SELECT te.*, t.pops, t.wager, t.user_id, t.currency, t.public_id
       FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id
       WHERE te.draw_id = ? AND te.status = 'pending'`, [drawId]);
    const prizeRows = await tx.query('SELECT pops_count, multiplier FROM prize_table');
    const mult = Object.fromEntries(prizeRows.map(r => [r.pops_count, r.multiplier]));

    let winners = 0, paid = 0;
    for (const e of entries) {
      const pops = JSON.parse(e.pops || '[]');
      // A missing prize row must fail loudly, never silently pay a default
      // multiplier: a wrong payout is worse than a stuck (visible) draw.
      // The table is seeded for every pops count 1..15 and has no delete UI.
      if (mult[pops.length] === undefined) throw new Error('Missing prize row for ' + pops.length + ' pops');
      const m = mult[pops.length];
      const hit = pops.includes(winning);
      const winAmount = hit ? e.wager * m : 0;
      await tx.run('UPDATE ticket_entries SET status = ?, win_amount = ?, settled_at = ? WHERE id = ?',
        [hit ? 'won' : 'lost', winAmount, now(), e.id]);
      if (hit && winAmount > 0) {
        await postLedger(tx, {
          userId: e.user_id, currency: e.currency, type: 'win',
          amount: winAmount, refType: 'ticket', refId: e.public_id,
          meta: { draw_id: drawId, winning_number: winning },
        });
        // agent commission on the win? No — commission is on ticket purchase (handled at buy time).
        winners += 1; paid += winAmount;
      }
    }
    await tx.run("UPDATE draws SET status = 'settled', winning_number = ?, beacon_round = ?, beacon_randomness = ?, beacon_signature = ?, beacon_status = ? WHERE id = ?",
      [winning, beaconRound, beaconRandomness, beaconSignature, beaconStatus, drawId]);
    if (!byCron) {
      await audit.log(db, { actorId, actorRole: 'admin', action: 'draw.settle', entity: 'draw', entityId: drawId, detail: { winning, winners, paid, beacon_status: beaconStatus, beacon_round: beaconRound }, ip });
    }
    return { drawId, winning, winners, paid };
  });
}

function publicDrawInfo(draw) {
  return {
    id: draw.id, draw_type: draw.draw_type, draw_date: draw.draw_date,
    close_at: draw.close_at, status: draw.status,
    seed_hash: draw.seed_hash,
    seed: draw.status === 'settled' ? draw.seed : null, // reveal only after settle
    winning_number: draw.status === 'settled' ? draw.winning_number : null,
    is_test: !!draw.is_test,
    beacon_status: draw.status === 'settled' ? (draw.beacon_status || null) : null,
    beacon_round: draw.status === 'settled' ? (draw.beacon_round ?? null) : null,
    beacon_randomness: draw.status === 'settled' ? (draw.beacon_randomness || null) : null,
    beacon_signature: draw.status === 'settled' ? (draw.beacon_signature || null) : null,
  };
}

module.exports = {
  deriveWinningNumber, deriveWinningNumberFair, deriveWinningNumberLegacy, combineSeed,
  ensureUpcomingDraws, createTestDraw,
  settleDueDraws, settleDraw, publicDrawInfo, drawDateStr,
};
