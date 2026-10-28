'use strict';
/* Settings access with a small in-memory cache (invalidated on write). */
const { now } = require('./util');

let cache = null;
let cacheAt = 0;
const TTL = 5000;

function keyCol(driver) { return driver === 'mysql' ? '`key`' : 'key'; }

async function loadAll(db, driver) {
  const k = keyCol(driver);
  const rows = await db.query(`SELECT ${k} AS k, value FROM settings`);
  const out = {};
  for (const r of rows) out[r.k] = r.value;
  return out;
}
let lastGood = null;
async function getSettings(db, driver, force = false) {
  // R-098: return a COPY per caller — a caller mutating the returned object
  // used to corrupt the shared cache for every later request.
  if (!force && cache && (Date.now() - cacheAt) < TTL) return { ...cache };
  cache = await loadAll(db, driver);
  lastGood = { ...cache };
  cacheAt = Date.now();
  return { ...cache };
}
function getS(settings, key, fallback = '') {
  const v = settings[key];
  return v === undefined || v === null ? fallback : v;
}
function getBool(settings, key, fallback = false) {
  const v = getS(settings, key, '');
  if (v === '') return fallback;
  return v === '1' || v === 'true' || v === 'on';
}
async function setSetting(db, driver, key, value) {
  const k = keyCol(driver);
  const ex = await db.get(`SELECT ${k} FROM settings WHERE ${k} = ?`, [key]);
  if (ex) await db.run(`UPDATE settings SET value = ?, updated_at = ? WHERE ${k} = ?`, [String(value), now(), key]);
  else await db.run(`INSERT INTO settings (${k}, value, updated_at) VALUES (?, ?, ?)`, [key, String(value), now()]);
  cache = null;
}
function getCurrencies(settings) {
  try {
    const list = JSON.parse(getS(settings, 'currencies', '[]'));
    if (Array.isArray(list) && list.length) return list;
    // R-048: a bad stored value must not silently re-denominate the site.
    console.error('[settings] currencies setting is empty/not an array — keeping last good list');
    if (lastGood && lastGood.currencies) { try { const lg = JSON.parse(lastGood.currencies); if (Array.isArray(lg) && lg.length) return lg; } catch {} }
  } catch (e) {
    console.error('[settings] currencies JSON is corrupt, falling back to last good/USD-only:', e.message);
    if (lastGood && lastGood.currencies) { try { const lg = JSON.parse(lastGood.currencies); if (Array.isArray(lg) && lg.length) return lg; } catch {} }
  }
  return [{ code: 'USD', symbol: '$', rate: 1 }];
}

module.exports = { getSettings, getS, getBool, setSetting, getCurrencies, keyCol, invalidate: () => { cache = null; } };
