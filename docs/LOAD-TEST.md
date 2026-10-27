# Load Test — recorded runs

Script: `scripts/load-test.js` (read-only hot paths; fetch follows redirects,
so a logged-out /wallet counts via its /login landing page).

Environment: demo server on localhost (same machine as the test), SQLite,
v14 code, warmed-up process. Numbers are indicative, not production capacity.

## Run 1 — 2026-10-27 (v14 E2E demo)
- Command: `BASE=http://localhost:3000 node scripts/load-test.js 20 200`
- Paths: /, /api/stats, /results, /fairness, /scratch, /wallet (round-robin)
- Result: 200/200 OK, 0 errors, 182 req/s
- Latency: p50 89 ms, p95 255 ms, p99 357 ms

## Run 2 — 2026-10-27 (v14 E2E demo)
- Command: `BASE=http://localhost:3000 node scripts/load-test.js 50 500`
- Result: 500/500 OK, 0 errors, 235 req/s
- Latency: p50 149 ms, p95 532 ms, p99 1093 ms

## Reading
- Zero 5xx at 50-way concurrency on a single small process: the read paths
  (including the per-request settings load) hold up for draw-time traffic at
  this scale. p95 growth between runs is SQLite contention on one file —
  expected; the v15 Postgres migration removes that bottleneck class.
- Not tested here: authenticated buy bursts (would move demo money) and
  webhook floods. Re-run with LOADTEST_COOKIE on a throwaway demo before
  any traffic spike, and re-run after the Postgres migration.

## npm audit note (same day)
- `npm audit` could NOT run in this sandbox: the package registry policy
  denies the audit endpoint (403 policy_denied on POST
  /-/npm/v1/security/audits/quick). Dependencies are minimal (express, ejs,
  nodemailer, qrcode + optional mysql2). The operator MUST run `npm audit`
  on a machine with registry access before real-money launch and fix any
  non-breaking findings; this is an environment limitation, not a clean bill.

## v15 Postgres load test (demo localhost, PostgreSQL 16, same script)
- Run 1: 20 concurrent x 200 requests -> 200/200 OK, 0 errors, 93 req/s,
  p50 184ms, p95 392ms, p99 521ms.
- Run 2: 50 concurrent x 500 requests -> 500/500 OK, 0 errors, 130 req/s,
  p50 333ms, p95 723ms, p99 832ms.
- Slower than the v14 SQLite run (expected: Postgres round-trips), still
  zero errors at both levels. Demo server still 200 afterwards.
- npm audit re-tried for v15 (adds `pg`): STILL blocked by the same sandbox
  policy — honestly unrun, NOT claimed clean; operator must run it with
  registry access.
