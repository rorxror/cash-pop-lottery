'use strict';
/* Public beacon for draw fairness (v14): the committed server seed is combined
   with a drand mainnet beacon round published AFTER the draw closes, so no
   single party — not even a DB insider who can read the stored seed — can
   predict or steer the winning number before close. Commit-reveal stays:
   seed_hash is published at creation; the seed itself is revealed at settle.
   Beacon fetch is best-effort with a short timeout: when beacon_required=0
   (default) a failed fetch falls back to the server seed and is recorded as
   beacon_status='fallback'; when beacon_required=1 the settle throws and the
   draw stays scheduled (fail closed). */
const crypto = require('node:crypto');
const { sha256 } = require('./util');

const DRAND_API = process.env.DRAND_API || 'https://api.drand.sh';
const TIMEOUT_MS = 4000;

async function fetchBeacon() {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(DRAND_API + '/public/latest', { signal: ctrl.signal });
    if (!r.ok) throw new Error('beacon HTTP ' + r.status);
    const j = await r.json();
    if (!j || typeof j.randomness !== 'string' || !j.randomness) throw new Error('beacon bad payload');
    return { round: Number(j.round) || null, randomness: j.randomness, signature: String(j.signature || '') };
  } finally { clearTimeout(t); }
}

function combineSeed(serverSeed, beaconRandomness) {
  if (!beaconRandomness) return String(serverSeed);
  return sha256(String(serverSeed) + '|' + String(beaconRandomness));
}

/* Rejection sampling: map a hash stream to 1..15 with zero modulo bias.
   Takes 32-bit words from successive counter-suffixed hashes; a word is
   accepted only below floor(2^32/15)*15, otherwise the next word is used.
   Plain "% 15" on a 32-bit word has bias ~1.2e-9 — tiny but unnecessary. */
const LIMIT = Math.floor(4294967296 / 15) * 15;
function deriveWinningNumberFair(finalSeedHex, drawId) {
  for (let counter = 0; counter < 1000; counter++) {
    const h = crypto.createHash('sha256').update(String(finalSeedHex) + ':' + String(drawId) + ':' + counter).digest();
    const word = h.readUInt32BE(0);
    if (word < LIMIT) return (word % 15) + 1;
  }
  throw new Error('rejection sampling failed to converge');
}

/* Legacy derivation (pre-v14 draws): plain %15 over the HMAC. Kept ONLY so
   the fairness verifier reproduces old draws exactly. */
function deriveWinningNumberLegacy(seedHex, drawId) {
  const { hmac } = require('./util');
  const h = hmac(seedHex, 'cashpop-draw:' + drawId);
  return (parseInt(h.slice(0, 8), 16) % 15) + 1;
}

module.exports = { fetchBeacon, combineSeed, deriveWinningNumberFair, deriveWinningNumberLegacy };
