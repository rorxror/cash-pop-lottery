'use strict';
/* v23 — SINGLE delivery-config resolver.
   Before v23, SMTP/SMS credentials were ENV-ONLY (lib/notify.js read
   process.env directly, lib/otp.js had private provider blocks) and
   there was NOWHERE in the admin panel to configure a delivery
   provider, so on a fresh boot every OTP channel failed closed.
   Now the owner configures delivery in Admin → Security → Delivery:
     - SECRETS (smtp_pass, twilio_token, textbelt_key) live ENCRYPTED
       in global_credentials, scope 'delivery' (lib/credentials.js).
     - NON-SECRET panel values live in settings keys delivery_*.
   Precedence per field: PANEL value if set, else ENV value, else ''.
   The SMS provider selection stays the sms_provider setting (the
   SMS_PROVIDER env var overrides it, exactly as before).
   EFFECTIVE PROVIDER RULE (OTP-D3): the effective SMS provider is the
   selected provider if IT is fully configured, else the other
   provider if IT is fully configured, else none — so a stale
   selection can never strand OTPs while a working provider exists.
   Health surfaces display the effective provider + any fallback.
   Resolved config is cached ~5s (keyed by db + a signature of the
   relevant settings/env); invalidate() drops it immediately on an
   admin save. */
const crypto = require('node:crypto');
const { getS } = require('./settings');

const DELIVERY_HOME = 'Admin → Security → Delivery (SMTP & SMS)';
const TTL_MS = 5000;
let cache = null; // { db, at, sig, cfg }

function invalidate() { cache = null; }

function envSig() {
  const keys = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM',
    'SMS_PROVIDER', 'TWILIO_SID', 'TWILIO_TOKEN', 'TWILIO_FROM', 'TEXTBELT_KEY',
    'TEXTBELT_API_URL', 'TWILIO_API_BASE'];
  return crypto.createHash('sha256').update(keys.map(k => k + '=' + (process.env[k] || '')).join('|')).digest('hex');
}
function settingsSig(settings) {
  const s = settings || {};
  const keys = ['delivery_smtp_host', 'delivery_smtp_port', 'delivery_smtp_user', 'delivery_smtp_from',
    'delivery_twilio_sid', 'delivery_twilio_from', 'sms_provider'];
  return keys.map(k => k + '=' + (s[k] || '')).join('|');
}

function twilioConfigured(cfg) { return !!(cfg && cfg.twilio_sid && cfg.twilio_token && cfg.twilio_from); }
function textbeltConfigured(cfg) { return !!(cfg && cfg.textbelt_key); }
function emailConfigured(cfg) { return !!(cfg && cfg.smtp_host && (cfg.smtp_from || cfg.smtp_user)); }
function effectiveSmsProvider(cfg) { return (cfg && cfg.effectiveProvider) || 'none'; }
function smsConfigured(cfg) {
  if (!cfg) return false;
  const eff = effectiveSmsProvider(cfg);
  if (eff === 'twilio') return twilioConfigured(cfg);
  if (eff === 'textbelt') return textbeltConfigured(cfg);
  return false;
}

async function resolveDeliveryConfig(db, settings) {
  const sig = settingsSig(settings) + '#' + envSig();
  if (cache && cache.db === db && cache.sig === sig && (Date.now() - cache.at) < TTL_MS) {
    return { ...cache.cfg };
  }
  let panel = {};
  if (db) {
    try {
      const { loadGlobalCredentials } = require('./credentials');
      panel = await loadGlobalCredentials(db, 'delivery');
    } catch (e) { panel = {}; /* table missing / key missing -> env-only, never a crash */ }
  }
  const S = settings || {};
  const pick = (panelVal, envVal) => {
    const p = String(panelVal === undefined || panelVal === null ? '' : panelVal).trim();
    if (p) return p;
    return String(envVal || '').trim();
  };
  const pickSetting = (key, envVal) => pick(getS(S, key, ''), envVal);
  const cfg = {
    smtp_host: pickSetting('delivery_smtp_host', process.env.SMTP_HOST),
    smtp_port: pickSetting('delivery_smtp_port', process.env.SMTP_PORT) || '587',
    smtp_user: pickSetting('delivery_smtp_user', process.env.SMTP_USER),
    smtp_pass: pick(panel.smtp_pass, process.env.SMTP_PASS),
    smtp_from: pickSetting('delivery_smtp_from', process.env.SMTP_FROM),
    twilio_sid: pickSetting('delivery_twilio_sid', process.env.TWILIO_SID),
    twilio_token: pick(panel.twilio_token, process.env.TWILIO_TOKEN),
    twilio_from: pickSetting('delivery_twilio_from', process.env.TWILIO_FROM),
    textbelt_key: pick(panel.textbelt_key, process.env.TEXTBELT_KEY),
    // Test-only provider endpoint hooks (default to the real provider
    // URLs; overridden only by tests pointing at a local double).
    textbelt_url: String(process.env.TEXTBELT_API_URL || 'https://textbelt.com/text'),
    twilio_base: String(process.env.TWILIO_API_BASE || 'https://api.twilio.com').replace(/\/+$/, ''),
    // Which source supplied each secret (booleans only — never values).
    panel: {
      smtp_pass: !!String(panel.smtp_pass || '').trim(),
      twilio_token: !!String(panel.twilio_token || '').trim(),
      textbelt_key: !!String(panel.textbelt_key || '').trim(),
      smtp_host: !!String(getS(S, 'delivery_smtp_host', '')).trim(),
      twilio_sid: !!String(getS(S, 'delivery_twilio_sid', '')).trim(),
    },
  };
  const selectedRaw = String(process.env.SMS_PROVIDER || getS(S, 'sms_provider', '') || '').trim().toLowerCase();
  cfg.selectedProvider = selectedRaw === 'textbelt' ? 'textbelt' : (selectedRaw === 'twilio' ? 'twilio' : '');
  const tw = twilioConfigured(cfg), tb = textbeltConfigured(cfg);
  if (cfg.selectedProvider === 'textbelt') cfg.effectiveProvider = tb ? 'textbelt' : (tw ? 'twilio' : 'none');
  else if (cfg.selectedProvider === 'twilio') cfg.effectiveProvider = tw ? 'twilio' : (tb ? 'textbelt' : 'none');
  else cfg.effectiveProvider = tw ? 'twilio' : (tb ? 'textbelt' : 'none');
  cfg.fallbackUsed = !!cfg.selectedProvider && cfg.effectiveProvider !== 'none' && cfg.effectiveProvider !== cfg.selectedProvider;
  cfg.emailConfigured = emailConfigured(cfg);
  cfg.smsConfigured = smsConfigured(cfg);
  if (db) cache = { db, at: Date.now(), sig, cfg };
  return { ...cfg };
}

module.exports = {
  resolveDeliveryConfig, invalidate,
  emailConfigured, smsConfigured, twilioConfigured, textbeltConfigured, effectiveSmsProvider,
  DELIVERY_HOME,
};
