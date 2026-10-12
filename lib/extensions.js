'use strict';
/* Extensions: each has Configure (fields) + Enable (on/off). When OFF or
   unconfigured, the site works fully — injections are simply skipped. */
const { now } = require('./util');

async function getExtensions(db) {
  const rows = await db.query('SELECT * FROM extensions');
  const out = {};
  for (const r of rows) {
    let config = {};
    try { config = JSON.parse(r.config || '{}'); } catch {}
    out[r.key] = { ...r, config };
  }
  return out;
}
async function getExtension(db, key) {
  const exts = await getExtensions(db);
  return exts[key] || null;
}
function extEnabled(ext) { return !!(ext && ext.enabled); }
async function setExtension(db, key, { enabled, config }) {
  const cur = await db.get('SELECT config FROM extensions WHERE `key` = ?', [key]);
  let merged = {};
  try { merged = JSON.parse((cur && cur.config) || '{}'); } catch {}
  if (config) merged = { ...merged, ...config };
  await db.run('UPDATE extensions SET enabled = ?, config = ?, updated_at = ? WHERE `key` = ?',
    [enabled ? 1 : 0, JSON.stringify(merged), now(), key]);
}

/* Field schemas for the Configure forms */
const EXTENSION_FIELDS = {
  custom_captcha: [
    { key: 'difficulty', label: 'Difficulty', type: 'select', options: ['easy', 'medium'] },
  ],
  recaptcha: [
    { key: 'site_key', label: 'Site key', type: 'text', required: true },
    { key: 'secret_key', label: 'Secret key', type: 'password', required: true },
  ],
  google_analytics: [
    { key: 'tracking_id', label: 'Measurement ID (G-...)', type: 'text', required: true },
  ],
  tawkto: [
    { key: 'embed_code', label: 'Tawk.to embed code (paste the full script)', type: 'textarea', required: true },
  ],
  fb_comments: [
    { key: 'app_id', label: 'Facebook App ID', type: 'text' },
  ],
};

module.exports = { getExtensions, getExtension, extEnabled, setExtension, EXTENSION_FIELDS };
