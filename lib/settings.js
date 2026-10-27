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
async function getSettings(db, driver, force = false) {
  if (!force && cache && (Date.now() - cacheAt) < TTL) return cache;
  cache = await loadAll(db, driver);
  cacheAt = Date.now();
  return cache;
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
  } catch {}
  return [{ code: 'USD', symbol: '$', rate: 1 }];
}

module.exports = { getSettings, getS, getBool, setSetting, getCurrencies, invalidate: () => { cache = null; } };
