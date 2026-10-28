'use strict';
/* BP-23 (v19): Smart Prize & Profit Engine — AGGREGATE level only.
   This module designs prize pools, measures exposure and projects
   margins. It NEVER touches an individual outcome: scratch outcomes
   stay server-predetermined at launch with commitment hashes
   (lib/scratch.js launchSeries), and pop results stay beacon-derived
   (lib/draws.js). Everything here works on totals — pool size, RTP,
   liability — exactly the operator-level math a real platform runs. */

/* ---------- (a) Prize pool planner ----------
   Given a ticket price, an inventory size and a target RTP, generate a
   tier table whose TOTAL prize liability equals the target as exactly
   as integer money allows:
     target liability L = round(price × tickets × RTP / 100)
   L is shared across a multiplier ladder with fixed shares:
     100×:5% · 50×:5% · 20×:10% · 10×:15% · 5×:20% · 2×:20% · 1×:25%
   Each tier's quantity = floor(share × L / amount). Whatever the
   flooring leaves unallocated is filled into the 1× tier (amount =
   price) so the achieved liability matches the target exactly,
   unless inventory runs out first (winning tickets can never exceed
   total tickets) — any final remainder smaller than one ticket price
   is reported as `unallocated` and the ACHIEVED RTP is returned
   alongside the target, so nothing is ever silently off-target. */
const LADDER = [
  [100, 0.05], [50, 0.05], [20, 0.10], [10, 0.15], [5, 0.20], [2, 0.20], [1, 0.25],
];
function planPrizePool({ price, totalTickets, targetRtpPct }) {
  price = Math.round(Number(price));
  totalTickets = Math.floor(Number(totalTickets));
  const rtp = Number(targetRtpPct);
  if (!Number.isFinite(price) || price < 1) return { ok: false, error: 'Ticket price must be at least 1 minor unit.' };
  if (!Number.isFinite(totalTickets) || totalTickets < 1 || totalTickets > 1000000) return { ok: false, error: 'Total tickets must be between 1 and 1,000,000.' };
  if (!Number.isFinite(rtp) || rtp <= 0 || rtp > 100) return { ok: false, error: 'Target RTP must be greater than 0 and at most 100%.' };
  const gross = price * totalTickets;
  const targetLiability = Math.round(gross * rtp / 100);
  const tiers = [];
  let allocated = 0;
  let winners = 0;
  for (const [mult, share] of LADDER) {
    const amount = Math.round(price * mult);
    if (amount < 1) continue;
    const qty = Math.floor(targetLiability * share / amount);
    if (qty > 0) { tiers.push({ amount, quantity: qty, mult }); allocated += qty * amount; winners += qty; }
  }
  // Fill the remainder into the 1× tier so the liability is exact.
  let leftover = targetLiability - allocated;
  if (leftover >= price && winners < totalTickets) {
    const add = Math.min(Math.floor(leftover / price), totalTickets - winners);
    if (add > 0) {
      const base = tiers.find(t => t.amount === price);
      if (base) base.quantity += add; else tiers.push({ amount: price, quantity: add, mult: 1 });
      allocated += add * price; winners += add; leftover -= add * price;
    }
  }
  tiers.sort((a, b) => b.amount - a.amount);
  const achievedRtp = gross > 0 ? (allocated / gross) * 100 : 0;
  return {
    ok: true, tiers, gross, targetLiability, liability: allocated,
    unallocated: targetLiability - allocated, winners,
    achievedRtpPct: achievedRtp,
    // Projected operator margin if x% of the inventory sells (random
    // sale order → expected payout scales with sell-through).
    marginAt: (sellPct) => Math.round((gross - allocated) * (sellPct / 100)),
  };
}

/* ---------- (b) Live series exposure ----------
   For a launched series the truth lives in scratch_outcomes (sold =
   ticket_id set). For a draft, the tier plan is the liability. */
async function seriesExposure(db, series) {
  const price = Number(series.price), total = Number(series.total_tickets);
  const grossPotential = price * total;
  if (series.status === 'draft') {
    const t = await db.get('SELECT COALESCE(SUM(amount*quantity),0) AS s FROM scratch_prize_tiers WHERE series_id = ?', [series.id]);
    const liability = Number(t.s);
    return { sold: 0, revenue: 0, paid: 0, totalLiability: liability, remainingLiability: liability, remainingTickets: total, grossPotential, marginNow: 0, tailRtpPct: grossPotential > 0 ? liability / grossPotential * 100 : 0 };
  }
  const agg = await db.get(
    `SELECT COUNT(*) AS outcomes,
       COALESCE(SUM(CASE WHEN ticket_id IS NOT NULL THEN 1 ELSE 0 END),0) AS sold,
       COALESCE(SUM(prize),0) AS total_liability,
       COALESCE(SUM(CASE WHEN ticket_id IS NULL THEN prize ELSE 0 END),0) AS remaining_liability
     FROM scratch_outcomes WHERE series_id = ?`, [series.id]);
  const money = await db.get(
    `SELECT COALESCE(SUM(price),0) AS revenue, COALESCE(SUM(CASE WHEN status='revealed' THEN prize ELSE 0 END),0) AS paid
     FROM scratch_tickets WHERE series_id = ?`, [series.id]);
  const sold = Number(agg.sold), remainingTickets = total - sold;
  const remainingLiability = Number(agg.remaining_liability);
  const tailValue = remainingTickets * price;
  return {
    sold, revenue: Number(money.revenue), paid: Number(money.paid),
    totalLiability: Number(agg.total_liability), remainingLiability, remainingTickets, grossPotential,
    marginNow: Number(money.revenue) - Number(money.paid),
    // RTP of the UNSOLD tail: what the remaining tickets would pay if
    // they all sold and revealed. Rising tail RTP = prize-heavy tail.
    tailRtpPct: tailValue > 0 ? remainingLiability / tailValue * 100 : 0,
  };
}

/* Guardrail check used at launch (manual + scheduled + auto-next):
   liability must not exceed capPct% of the series' full sales value. */
function launchCapCheck(settings, series, liability) {
  const { getBool, getS } = require('./settings');
  if (!getBool(settings, 'scratch_guardrail_enabled')) return { enforced: false, ok: true };
  const capPct = Number(getS(settings, 'scratch_liability_cap_pct', '100')) || 100;
  const gross = Number(series.price) * Number(series.total_tickets);
  const cap = Math.floor(gross * capPct / 100);
  return { enforced: true, ok: liability <= cap, liability, cap, capPct, gross };
}

/* ---------- (d) Pop sales mix + simulator math ----------
   Pop RTP for a pops count = multiplier / 15 (see lib/draws.js: a win
   pays wager × multiplier when the drawn number is among the picks —
   probability pops/15, and each entry stakes wager × pops, so the
   per-count return ratio is exactly multiplier/15). */
function popRtpPct(multiplier) { return Number(multiplier) / 15 * 100; }
async function popSalesMix(db) {
  const rows = await db.query(
    `SELECT t.pops AS pops, t.wager AS wager, COUNT(*) AS entries
     FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id
     JOIN draws dr ON dr.id = te.draw_id AND dr.is_test = 0
     GROUP BY t.pops, t.wager`);
  const byPops = new Map();
  for (const r of rows) {
    let len = 0;
    try { len = JSON.parse(r.pops || '[]').length; } catch {}
    if (!len) continue;
    const cur = byPops.get(len) || { pops: len, entries: 0, stake: 0 };
    cur.entries += Number(r.entries);
    cur.stake += Number(r.wager) * len * Number(r.entries);
    byPops.set(len, cur);
  }
  return [...byPops.values()].sort((a, b) => a.pops - b.pops);
}
/* Projected margin % at a multiplier table over a sales mix:
   expected payout = Σ wager × entries × mult[pops] × pops/15 — computed
   per grouped row so wagers are weighted exactly. */
async function projectedMargin(db, multByPops) {
  const rows = await db.query(
    `SELECT t.pops AS pops, t.wager AS wager, COUNT(*) AS entries
     FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id
     JOIN draws dr ON dr.id = te.draw_id AND dr.is_test = 0
     GROUP BY t.pops, t.wager`);
  let stake = 0, expectedPayout = 0;
  for (const r of rows) {
    let len = 0;
    try { len = JSON.parse(r.pops || '[]').length; } catch {}
    if (!len) continue;
    const mult = Number(multByPops[len] || 0);
    const n = Number(r.entries), w = Number(r.wager);
    stake += w * len * n;
    expectedPayout += w * n * mult * (len / 15);
  }
  return { stake, expectedPayout: Math.round(expectedPayout), marginPct: stake > 0 ? (1 - expectedPayout / stake) * 100 : null, entries: rows.length };
}

/* ---------- (e) Per-draw exposure ----------
   Worst case = every entry wins (Σ wager × multiplier). Expected =
   Σ wager × multiplier × pops/15. Per currency, since tickets carry
   their own currency while draws do not. */
async function drawExposure(db, drawId, multByPops) {
  const rows = await db.query(
    `SELECT t.pops AS pops, t.wager AS wager, t.currency AS currency, COUNT(*) AS entries
     FROM ticket_entries te JOIN tickets t ON t.id = te.ticket_id
     WHERE te.draw_id = ? GROUP BY t.pops, t.wager, t.currency`, [drawId]);
  const byCur = {};
  for (const r of rows) {
    let len = 0;
    try { len = JSON.parse(r.pops || '[]').length; } catch {}
    if (!len) continue;
    const mult = Number(multByPops[len] || 0);
    const cur = byCur[r.currency] || { currency: r.currency, entries: 0, stake: 0, maxLiability: 0, expectedLiability: 0 };
    const n = Number(r.entries), w = Number(r.wager);
    cur.entries += n;
    cur.stake += w * len * n;
    cur.maxLiability += w * mult * n;
    cur.expectedLiability += w * mult * n * (len / 15);
    byCur[r.currency] = cur;
  }
  for (const c of Object.values(byCur)) c.expectedLiability = Math.round(c.expectedLiability);
  return Object.values(byCur);
}
async function prizeMap(db) {
  const rows = await db.query('SELECT pops_count, multiplier FROM prize_table');
  return Object.fromEntries(rows.map(r => [r.pops_count, r.multiplier]));
}

module.exports = { planPrizePool, seriesExposure, launchCapCheck, popRtpPct, popSalesMix, projectedMargin, drawExposure, prizeMap, LADDER };
