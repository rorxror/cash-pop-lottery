'use strict';
/* Breached-password check via Have I Been Pwned k-anonymity (v14).
   Only the first 5 chars of the SHA-1 ever leave the server; the suffix
   match happens locally. Best-effort by design: any network error, timeout,
   or a disabled setting fails OPEN (returns false) so registration and
   password resets never break offline. Results are cached by prefix. */
const crypto = require('node:crypto');

const cache = new Map();
let lastFailureAt = 0;
function breachedCheckFailedRecently() { return lastFailureAt > 0 && Date.now() - lastFailureAt < 3600000; }

async function isBreached(password, { enabled = true } = {}) {
  if (!enabled || process.env.HIBP_CHECK === '0') return false;
  if (!password) return false;
  const sha1 = crypto.createHash('sha1').update(String(password)).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5), suffix = sha1.slice(5);
  if (!cache.has(prefix)) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      const r = await fetch('https://api.pwnedpasswords.com/range/' + prefix,
        { signal: ctrl.signal, headers: { 'User-Agent': 'CashPop-Lottery' } });
      clearTimeout(t);
      if (!r.ok) { lastFailureAt = Date.now(); console.error('[hibp] breached-password check failed (HTTP ' + r.status + ') — failing open, admin warning needed'); return false; }
      const text = await r.text();
      cache.set(prefix, new Set(text.split('\n').map(l => l.split(':')[0].trim())));
    } catch (e) { lastFailureAt = Date.now(); console.error('[hibp] breached-password check failed:', e.message, '— failing open, admin warning needed'); return false; }
  }
  return cache.get(prefix).has(suffix);
}

module.exports = { isBreached, breachedCheckFailedRecently };
