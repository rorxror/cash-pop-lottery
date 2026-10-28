'use strict';
/* Gateway credential encryption (v14): AES-256-GCM envelope.
   Key: CREDENTIAL_ENCRYPTION_KEY env — 64 hex chars (32 bytes) or base64.
   Envelope: "v1:<iv hex>:<ciphertext hex>:<auth tag hex>".
   Reads understand envelopes AND legacy plaintext (field_enc=0). A stored
   value that parses as an envelope is treated as one even if the flag is 0
   (defense in depth for rows written before the flag existed).
   If the key is missing, encrypting REFUSES (fail closed) rather than
   silently storing plaintext as "encrypted"; decrypting an envelope without
   a key throws loudly so a missing key is visible, never silent garbage.
   Migration is safe by design: existing plaintext rows stay plaintext until
   an admin re-saves them, so a bad key can never lock all payment methods. */
const crypto = require('node:crypto');

function getKey() {
  const raw = (process.env.CREDENTIAL_ENCRYPTION_KEY || '').trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    const b = Buffer.from(raw, 'hex');
    // R-084/W-29: all-zero keys are not keys.
    if (b.every(x => x === 0)) return null;
    return b;
  }
  // Strict base64: Buffer.from silently ignores invalid characters, so a
  // malformed string that happens to decode to 32 bytes was accepted.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  try {
    const b = Buffer.from(raw, 'base64');
    if (b.length === 32 && !b.every(x => x === 0) && Buffer.from(b.toString('base64')) .equals(b)) return b;
  } catch {}
  return null;
}
function keyConfigured() { return !!getKey(); }

function looksLikeEnvelope(s) {
  const parts = String(s || '').split(':');
  return parts.length === 4 && parts[0] === 'v1' &&
    /^[0-9a-fA-F]{24}$/.test(parts[1]) && /^[0-9a-fA-F]+$/.test(parts[2]) && /^[0-9a-fA-F]{32}$/.test(parts[3]);
}

function encryptField(plaintext) {
  const key = getKey();
  if (!key) throw new Error('CREDENTIAL_ENCRYPTION_KEY is not configured');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('hex'), ct.toString('hex'), cipher.getAuthTag().toString('hex')].join(':');
}

function decryptField(stored, enc) {
  if (!stored) return '';
  if (!enc && !looksLikeEnvelope(stored)) return stored; // legacy plaintext
  const parts = String(stored).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('unknown credential envelope');
  const key = getKey();
  if (!key) throw new Error('CREDENTIAL_ENCRYPTION_KEY is not configured — cannot decrypt stored credentials');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(parts[1], 'hex'));
  decipher.setAuthTag(Buffer.from(parts[3], 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(parts[2], 'hex')), decipher.final()]).toString('utf8');
}

module.exports = { getKey, keyConfigured, encryptField, decryptField, looksLikeEnvelope };
