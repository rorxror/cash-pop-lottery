'use strict';
/* Draw-time load simulation (read-only by default).
   Usage: BASE=http://localhost:3000 node scripts/load-test.js [concurrency] [requests]
   Hits the hot read paths concurrently (home, stats API, results, fairness)
   and reports p50/p95 latency + error rate. No money moves: buys are skipped
   unless LOADTEST_COOKIE (a logged-in session cookie value) is set, in which
   case one buy per worker is attempted against the demo only.
   Results: see docs/LOAD-TEST.md (recorded runs). */
const BASE = process.env.BASE || 'http://localhost:3000';
const CONC = parseInt(process.argv[2], 10) || 20;
const TOTAL = parseInt(process.argv[3], 10) || 200;
const PATHS = ['/', '/api/stats', '/results', '/fairness', '/scratch', '/wallet'];

async function hit(path, cookie) {
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + path, { headers: cookie ? { Cookie: cookie } : {} });
    await r.text();
    return { ms: Date.now() - t0, ok: r.status < 500, status: r.status };
  } catch (e) {
    return { ms: Date.now() - t0, ok: false, status: 0, err: e.message };
  }
}

(async () => {
  const lat = [];
  let errors = 0;
  const byStatus = {};
  let idx = 0;
  async function worker() {
    while (idx < TOTAL) {
      const i = idx++;
      const p = PATHS[i % PATHS.length];
      const r = await hit(p, process.env.LOADTEST_COOKIE || '');
      lat.push(r.ms);
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      if (!r.ok) errors++;
    }
  }
  const t0 = Date.now();
  await Promise.all(Array.from({ length: CONC }, worker));
  const wall = Date.now() - t0;
  lat.sort((a, b) => a - b);
  const pct = (q) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))];
  console.log(JSON.stringify({
    base: BASE, concurrency: CONC, requests: TOTAL,
    wall_ms: wall, rps: +(TOTAL / (wall / 1000)).toFixed(1),
    p50_ms: pct(0.5), p95_ms: pct(0.95), p99_ms: pct(0.99),
    errors, error_rate: +(errors / TOTAL).toFixed(4),
    by_status: byStatus,
  }, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
