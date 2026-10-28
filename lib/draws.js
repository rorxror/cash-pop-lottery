'use strict';
/* Draw engine: scheduling, provably-fair seed commit/reveal, settlement.
   Production draws are ALWAYS server-random. A winning-number override is
   possible ONLY on draws explicitly created as TEST draws, and is audit-logged. */
const crypto = require('node:crypto');
const { now, randHex, sha256, hmac, fmtMoney, signTicket } = require('./util');
const { getS, getBool, getCurrencies } = require('./settings');
const { postLedger } = require('./money');
const audit = require('./audit');
const { fetchBeacon, fetchBeaconRound, combineSeed, deriveWinningNumberFair, deriveWinningNumberLegacy } = require('./beacon');

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
  // R-080: validate strictly — Date.UTC silently normalises overflow
  // (month 13 -> next year, day 32 -> next month), so a typo'd date used
  // to create a draw on a different date than intended.
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!dm) throw new Error('Invalid draw date (expected YYYY-MM-DD)');
  const y = Number(dm[1]), mo = Number(dm[2]), da = Number(dm[3]);
  const tm = /^(\d{2}):(\d{2})$/.exec(String(timeStr || '14:00'));
  if (!tm) throw new Error('Invalid draw time (expected HH:MM)');
  const hh = Number(tm[1]), mm = Number(tm[2]);
  if (mo < 1 || mo > 12 || hh > 23 || mm > 59) throw new Error('Invalid draw date/time');
  const t = Date.UTC(y, mo - 1, da, hh, mm, 0, 0);
  const chk = new Date(t);
  if (chk.getUTCFullYear() !== y || chk.getUTCMonth() !== mo - 1 || chk.getUTCDate() !== da) throw new Error('Invalid draw date');
  return t;
}

/* Create upcoming Day/Eve draws for the next N days (idempotent). */
async function ensureUpcomingDraws(db, settings) {
  // R-081: validate settings loudly (0 = disabled, not silently 7) and
  // survive a duplicate-draw race per draw instead of aborting the loop.
  const rawDays = parseInt(getS(settings, 'upcoming_draw_days', '7'), 10);
  if (!Number.isInteger(rawDays) || rawDays < 0) throw new Error('Invalid upcoming_draw_days setting');
  const days = rawDays;
  const dayTime = getS(settings, 'day_draw_time', '14:00');
  const eveTime = getS(settings, 'eve_draw_time', '21:00');
  // Validate times up front so a bad time fails loudly, not as midnight.
  closeAtFor('2030-01-01', dayTime); closeAtFor('2030-01-01', eveTime);
  const t = now();
  for (let i = 0; i < days; i++) {
    const d = new Date(t + i * 86400000);
    const ds = drawDateStr(d);
    for (const [type, timeStr] of [['DAY', dayTime], ['EVE', eveTime]]) {
      try {
        const ex = await db.get('SELECT id FROM draws WHERE draw_type = ? AND draw_date = ?', [type, ds]);
        if (ex) continue;
        const seed = randHex(32);
        await db.run(
          'INSERT INTO draws (draw_type, draw_date, close_at, status, seed_hash, seed, is_test, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
          [type, ds, closeAtFor(ds, timeStr), 'scheduled', sha256(seed), seed, t]
        );
      } catch (e) {
        if (/UNIQUE|duplicate/i.test(e.message)) continue; // concurrent ensure won this draw
        throw e;
      }
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
    // R-080: reject (never clamp, never store NaN) garbage overrides.
    const n = Number(overrideNumber);
    if (!Number.isInteger(n) || n < 1 || n > 15) throw new Error('Test-draw override must be an integer 1-15');
    winning = n;
    const upd = await db.run('UPDATE draws SET winning_number = ? WHERE id = ?', [winning, drawId]);
    if (upd.changes !== 1) throw new Error('Test-draw override could not be saved');
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
  const due = await db.query("SELECT * FROM draws WHERE status = 'scheduled' AND close_at <= ? ORDER BY close_at ASC, id ASC", [t]);
  const results = [];
  for (const draw of due) {
    // One bad draw must never block the rest of the batch: a single corrupt
    // ticket used to abort the whole cron run, leaving every other due draw
    // unsettled (and the failure visible only as a thrown error).
    try {
      const res = await settleDraw(db, draw.id, settings, { byCron: true });
      results.push(res);
    } catch (e) {
      results.push({ drawId: draw.id, error: e.message });
    }
  }
  return results;
}

async function cancelDraw(db, drawId, settings, { actorId = null, ip = '' } = {}) {
  // R-025: audited draw-cancel / refund path. A scheduled draw that can
  // never settle no longer locks funds forever: stakes return to wallets.
  return db.transaction(async (tx) => {
    const draw = await tx.get('SELECT * FROM draws WHERE id = ?', [drawId]);
    if (!draw) throw new Error('Draw not found');
    if (draw.status !== 'scheduled') throw new Error('Only scheduled draws can be cancelled');
    const upd = await tx.run("UPDATE draws SET status = 'cancelled' WHERE id = ? AND status = 'scheduled'", [drawId]);
    if (upd.changes !== 1) throw new Error('Draw was already settled or cancelled');
    const entries = await tx.query(
      `SELECT te.*, t.user_id, t.currency, t.wager, t.total, t.num_draws, t.pops, t.public_id FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id
       WHERE te.draw_id = ? AND te.status = 'pending'`, [drawId]);
    let refunded = 0;
    for (const e of entries) {
      // R-025: refund the entry's share of what the player actually paid for
      // THIS draw: ticket.total / num_draws (discount-aware). The old code
      // refunded e.wager alone — the per-POP wager — which under-refunded
      // every multi-pop ticket (a 5-pop ticket got 1/5 of its stake back).
      // v17.1: cumulative rounding — the k-th refund of a ticket pays
      // round(total*k/n) - round(total*(k-1)/n), so cancelling every draw
      // returns exactly total (plain per-entry rounding leaked up to ~0.5
      // minor per entry, e.g. 3x333=999 on a 1000-minor ticket). A 1-draw
      // ticket refunds exactly. k counts entries already refunded (this
      // txn's earlier iterations included, since the txn sees its writes).
      const nDraws = Number(e.num_draws) || 0;
      let refund;
      if (nDraws > 0) {
        const done = await tx.get("SELECT COUNT(*) AS c FROM ticket_entries WHERE ticket_id = ? AND status = 'refunded'", [e.ticket_id]);
        const k = Number(done.c) + 1;
        const total = Number(e.total);
        refund = Math.max(0, Math.round(total * k / nDraws) - Math.round(total * (k - 1) / nDraws));
      }
      else { let pops = []; try { pops = JSON.parse(e.pops || '[]'); } catch {} refund = Number(e.wager) * pops.length; }
      const claim = await tx.run("UPDATE ticket_entries SET status = 'refunded', win_amount = 0, settled_at = ? WHERE id = ? AND status = 'pending'", [now(), e.id]);
      if (claim.changes !== 1) continue;
      await postLedger(tx, { userId: e.user_id, currency: e.currency, type: 'draw_refund', amount: refund, refType: 'ticket', refId: e.public_id, meta: { draw_id: drawId } });
      refunded += refund;
    }
    // A ticket whose entries are all resolved is no longer active — same rule
    // settle uses (there it becomes 'settled'; here the money came back).
    await tx.run(
      `UPDATE tickets SET status = 'cancelled' WHERE id IN (SELECT ticket_id FROM ticket_entries WHERE draw_id = ?)
       AND NOT EXISTS (SELECT 1 FROM ticket_entries te2 WHERE te2.ticket_id = tickets.id AND te2.status = 'pending')`, [drawId]);
    await audit.log(tx, { actorId, actorRole: 'admin', action: 'draw.cancel', entity: 'draw', entityId: drawId, detail: { refunded, entries: entries.length }, ip }, { throwOnError: true });
    return { drawId, refunded, entries: entries.length };
  });
}

async function settleDraw(db, drawId, settings, { byCron = false, actorId = null, ip = '' } = {}) {
  // R-007/R-023: beacon fetch happens BEFORE the transaction (never inside
  // it — on SQLite it held the whole-DB write lock across a network call)
  // and the beacon round is PINNED at close: the first settle attempt
  // persists beacon_round_pinned outside the settle txn, so later attempts
  // must fetch that exact round and cannot shop rounds by delaying settle.
  let preBeacon = null, preBeaconError = null;
  try {
    const pre = await db.get('SELECT * FROM draws WHERE id = ?', [drawId]);
    if (pre && !pre.is_test && getBool(settings, 'beacon_enabled', true)) {
      if (pre.beacon_round_pinned) {
        preBeacon = await fetchBeaconRound(pre.beacon_round_pinned);
      } else {
        const b = await fetchBeacon();
        try { await db.run('UPDATE draws SET beacon_round_pinned = ? WHERE id = ? AND beacon_round_pinned IS NULL', [b.round, drawId]); } catch {}
        preBeacon = b;
      }
    }
  } catch (e) { preBeaconError = e; }
  const out = await db.transaction(async (tx) => {
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
      } else if (preBeacon) {
        finalSeed = combineSeed(draw.seed, preBeacon.randomness);
        beaconRound = preBeacon.round; beaconRandomness = preBeacon.randomness; beaconSignature = preBeacon.signature;
        beaconStatus = 'ok';
      } else {
        if (beaconRequired) throw new Error('Beacon unavailable — draw stays scheduled: ' + (preBeaconError ? preBeaconError.message : 'fetch failed'));
        beaconStatus = 'fallback';
        beaconRound = null; beaconRandomness = ''; beaconSignature = '';
      }
      winning = deriveWinningNumberFair(finalSeed, draw.id); // ALWAYS random in production
    }

    // Settle every pending entry in this draw
    const entries = await tx.query(
      `SELECT te.*, t.pops, t.wager, t.user_id, t.currency, t.public_id, t.draw_ids, t.total, t.hmac
       FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id
       WHERE te.draw_id = ? AND te.status = 'pending'`, [drawId]);
    const prizeRows = await tx.query('SELECT pops_count, multiplier FROM prize_table');
    const mult = Object.fromEntries(prizeRows.map(r => [r.pops_count, r.multiplier]));

    let winners = 0, paid = 0;
    const winnerDetails = [];
    for (const e of entries) {
      // v16: verify the ticket HMAC when present (tickets are HMAC-signed at
      // buy time). A ticket whose pops/wager/total were altered after purchase
      // fails the whole settlement loudly instead of paying on tampered data.
      // Tickets without an hmac (pre-HMAC rows) are skipped, not failed.
      if (e.hmac) {
        const secret = process.env.TICKET_HMAC_SECRET;
        if (!secret) throw new Error('TICKET_HMAC_SECRET is not configured');
        const expected = signTicket(secret, { public_id: e.public_id, user_id: e.user_id, pops: e.pops, wager: e.wager, draw_ids: e.draw_ids, total: e.total, currency: e.currency });
        const stored = String(e.hmac);
        if (expected.length !== stored.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(stored)))
          throw new Error('Ticket HMAC mismatch for ' + e.public_id + ' — settlement refused.');
      }
      const pops = JSON.parse(e.pops || '[]');
      // A missing prize row must fail loudly, never silently pay a default
      // multiplier: a wrong payout is worse than a stuck (visible) draw.
      // The table is seeded for every pops count 1..15 and has no delete UI.
      if (mult[pops.length] === undefined) throw new Error('Missing prize row for ' + pops.length + ' pops');
      const m = mult[pops.length];
      const hit = pops.includes(winning);
      const winAmount = hit ? e.wager * m : 0;
      // Guarded claim: only the transaction that actually moves this entry
      // pending -> won/lost may pay on it. Two concurrent settles (Postgres
      // READ COMMITTED) could otherwise both read 'pending' and both credit.
      const claim = await tx.run('UPDATE ticket_entries SET status = ?, win_amount = ?, settled_at = ? WHERE id = ? AND status = \'pending\'',
        [hit ? 'won' : 'lost', winAmount, now(), e.id]);
      if (claim.changes !== 1) continue;
      if (hit && winAmount > 0) {
        await postLedger(tx, {
          userId: e.user_id, currency: e.currency, type: 'win',
          amount: winAmount, refType: 'ticket', refId: e.public_id,
          meta: { draw_id: drawId, winning_number: winning },
        });
        // agent commission on the win? No — commission is on ticket purchase (handled at buy time).
        winners += 1; paid += winAmount;
        winnerDetails.push({ userId: e.user_id, amount: winAmount, currency: e.currency, publicId: e.public_id });
      }
    }
    const drawUpd = await tx.run("UPDATE draws SET status = 'settled', winning_number = ?, beacon_round = ?, beacon_randomness = ?, beacon_signature = ?, beacon_status = ? WHERE id = ? AND status = 'scheduled'",
      [winning, beaconRound, beaconRandomness, beaconSignature, beaconStatus, drawId]);
    // A concurrent settle that already moved this draw must roll this whole
    // settlement back rather than pay twice on the same entries.
    if (drawUpd.changes !== 1) throw new Error('Draw was already settled by another process — settlement rolled back.');
    // v16: a ticket spans several draws — mark it settled only when NONE of
    // its entries are still pending. Previously tickets stayed 'active'
    // forever, so anything filtering on ticket status saw stale state.
    await tx.run(
      `UPDATE tickets SET status = 'settled' WHERE id IN (SELECT ticket_id FROM ticket_entries WHERE draw_id = ?)
       AND NOT EXISTS (SELECT 1 FROM ticket_entries te2 WHERE te2.ticket_id = tickets.id AND te2.status = 'pending')`,
      [drawId]);
    // v16: audit EVERY settlement. Cron settlements used to leave no audit
    // trail at all (only the draw row recorded them) — an operator could not
    // prove from the audit log which draws the cron settled, or whether a
    // beacon fallback happened.
    await audit.log(tx, { actorId: byCron ? null : actorId, actorRole: byCron ? 'system' : 'admin', action: 'draw.settle', entity: 'draw', entityId: drawId, detail: { winning, winners, paid, beacon_status: beaconStatus, beacon_round: beaconRound }, ip: byCron ? '' : ip }, { throwOnError: true });
    return { drawId, winning, winners, paid, winnerDetails };
  });
  // v16: winner notifications AFTER the transaction commits. notify.send writes
  // an outbox row (the cron delivers it); sending inside the txn could leave
  // a 'you won' row behind if the settlement rolled back.
  if (out && !out.skipped && out.winnerDetails && out.winnerDetails.length) {
    const notify = require('./notify');
    const currencies = getCurrencies(settings);
    for (const w of out.winnerDetails) {
      let u = null; // hoisted so the failure row below can name the recipient
      try {
        u = await db.get('SELECT email, name FROM users WHERE id = ?', [w.userId]);
        if (u && u.email) {
          const r = await notify.send(db, settings, 'email', 'win', u.email, { name: u.name, amount: fmtMoney(w.amount, w.currency, currencies), ticket: w.publicId });
          if (r && r.status !== 'sent' && r.status !== 'skipped')
            await audit.log(db, { actorId: null, actorRole: 'system', action: 'win.notify_failed', entity: 'ticket', entityId: w.publicId, detail: { userId: w.userId, amount: w.amount, error: r.error || r.status }, ip: '' });
        }
      } catch (e) {
        // R-017: a failed win notification is never swallowed silently —
        // it lands in the outbox as a failed row + an audit row for retry.
        try {
          await db.run('INSERT INTO notifications_log (channel, to_addr, subject, body, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ['email', (u && u.email) || '', 'You won', 'win notification failed', 'failed', String(e.message).slice(0, 500), now()]);
          await audit.log(db, { actorId: null, actorRole: 'system', action: 'win.notify_failed', entity: 'ticket', entityId: w.publicId, detail: { userId: w.userId, amount: w.amount, error: String(e.message).slice(0, 500) }, ip: '' });
        } catch {}
      }
    }
  }
  return out;
}

/* Fairness verification for ONE draw. Settled-only by design: for an
   unsettled draw the seed is still committed-but-unrevealed, so computing a
   "recomputed number" from it would either leak the future winning number
   (beacon disabled: settle derives from the seed alone) or report a false
   MISMATCH (beacon enabled: the real beacon randomness is not known yet).
   Unsettled draws therefore get nulls, never a number or a verdict. */
function fairnessForDraw(d) {
  if (!d || d.status !== 'settled') {
    return {
      draw: d ? publicDrawInfo(d) : null,
      recomputed_hash: null, hash_match: null,
      recomputed_number: null, number_match: null,
    };
  }
  const recomputedHash = d.seed ? sha256(d.seed) : null;
  // v14: pre-v14 draws (no beacon fields) use the legacy %15 derivation;
  // newer draws combine the revealed seed with the recorded beacon
  // randomness and use rejection sampling — exactly as settle did.
  let recomputedNumber = null;
  if (d.seed) {
    if (!d.beacon_status) recomputedNumber = deriveWinningNumberLegacy(d.seed, d.id);
    else recomputedNumber = deriveWinningNumberFair(combineSeed(d.seed, d.beacon_randomness || ''), d.id);
  }
  return {
    draw: publicDrawInfo(d),
    recomputed_hash: recomputedHash,
    hash_match: recomputedHash ? (recomputedHash === d.seed_hash) : null,
    recomputed_number: recomputedNumber,
    number_match: recomputedNumber !== null ? (recomputedNumber === d.winning_number) : null,
  };
}

function publicDrawInfo(draw) {  return {
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
  ensureUpcomingDraws, createTestDraw, cancelDraw,
  settleDueDraws, settleDraw, publicDrawInfo, fairnessForDraw, drawDateStr, closeAtFor,
};
