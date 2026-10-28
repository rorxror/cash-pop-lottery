'use strict';
/* Payment rails + EBT hard-block. (v20/U-21 rework — see
   audits/owner-fix-round/adj-payments.md for the three-way audit.)
   Each rail: { key, name, icon, credentialFields, defaultInstruction,
   userFields (deposit proof), withdrawUserFields (player's own payout
   destination), webhook: bool }
   Rails run in manual mode out of the box (user submits proof, admin
   approves). Fields a provider/API mode genuinely needs are present but
   NOT required, so manual mode is never blocked by API credentials that
   manual review does not use; help text on each such field says so.
   `secret: true` marks fields that must never be shown to players;
   getReceivingDetails/getPublicConfig hard-skip secret/password fields
   even if a key is ever added to their maps by mistake. */

const BLOCKED_RAILS = new Set(['ebt']);

const API_HELP = 'Only needed for the provider/API (automated) mode. Manual review works without it. Stored encrypted, never shown to players.';

const RAILS = [
  { key: 'crypto', name: 'Cryptocurrency', icon: '₿',
    credentialFields: [
      { key: 'asset', label: 'Asset (e.g. BTC, USDT, ETH)', type: 'text', required: true, help: 'One method = one asset on one network. Create a separate method per asset/network.' },
      { key: 'network', label: 'Network (e.g. Bitcoin, TRC20, ERC20)', type: 'text', required: true, help: 'The player must send on exactly this network; a wrong-network transfer can be lost.' },
      { key: 'wallet_address', label: 'Receiving wallet address', type: 'text', required: true },
      { key: 'confirmations', label: 'Required confirmations', type: 'number', help: 'Shown to the player; staff credit the deposit after this many network confirmations.' },
      { key: 'webhook_secret', label: 'Processor webhook signing secret', type: 'password', secret: true, help: 'Only if a crypto processor sends HMAC webhooks to /webhooks/crypto. ' + API_HELP },
    ],
    defaultInstruction: 'Send the exact amount to the wallet address below, on the network shown, then paste your transaction hash as proof.',
    userFields: [{ key: 'tx_hash', label: 'Transaction hash', type: 'text', required: true }],
    withdrawUserFields: [
      { key: 'wallet_address', label: 'Your wallet address', type: 'text', required: true },
      { key: 'network', label: 'Network (must match the asset)', type: 'text', required: true },
    ], webhook: true },
  { key: 'cards', name: 'Credit / Debit Cards', icon: '💳',
    credentialFields: [
      { key: 'provider', label: 'Card processor', type: 'select', options: ['Stripe', 'Checkout.com', 'Other'], required: true },
      { key: 'mode', label: 'Mode', type: 'select', options: ['live', 'sandbox'], help: 'Must match the keys below: sandbox = test keys, live = real-money keys.' },
      { key: 'publishable_key', label: 'Publishable key', type: 'text', help: 'Public key (not a secret). Used by the hosted checkout integration; manual payment-link mode works without it.' },
      { key: 'secret_key', label: 'Secret key', type: 'password', secret: true, help: API_HELP },
      { key: 'webhook_secret', label: 'Webhook signing secret', type: 'password', secret: true, help: 'Signs provider webhooks to /webhooks/cards so completed payments can be auto-credited. ' + API_HELP },
    ],
    defaultInstruction: 'Card deposits are reviewed manually: submit your request below and our team will contact you with a secure payment link. Your balance is credited once payment is confirmed.',
    userFields: [],
    withdrawUserFields: [], webhook: true },
  { key: 'upi', name: 'UPI', icon: '📱',
    credentialFields: [
      { key: 'upi_id', label: 'Receiving UPI ID', type: 'text', required: true, help: 'Your VPA, e.g. yourname@okhdfcbank. Players pay exactly this ID.' },
      { key: 'merchant_name', label: 'Merchant display name', type: 'text', help: 'The name the player sees in their UPI app when paying.' },
    ],
    defaultInstruction: 'Pay to the UPI ID below and enter your UTR / reference number.',
    userFields: [{ key: 'utr', label: 'UTR / reference number', type: 'text', required: true }],
    withdrawUserFields: [{ key: 'upi_id', label: 'Your UPI ID', type: 'text', required: true }], webhook: false },
  { key: 'pix', name: 'Pix (Brazil)', icon: '🇧🇷',
    credentialFields: [
      { key: 'pix_key', label: 'Pix key (receiving)', type: 'text', required: true },
      { key: 'pix_key_type', label: 'Pix key type', type: 'select', options: ['cpf', 'cnpj', 'email', 'phone', 'random'] },
      { key: 'provider', label: 'Pix provider (PSP)', type: 'text', help: 'Only if a PSP processes Pix for you; direct Pix to your own key needs no provider.' },
      { key: 'mode', label: 'Mode', type: 'select', options: ['live', 'sandbox'], help: 'Provider mode. Applies only when a PSP is used.' },
      { key: 'api_token', label: 'Provider API token', type: 'password', secret: true, help: API_HELP },
      { key: 'webhook_secret', label: 'Provider webhook signing secret', type: 'password', secret: true, help: 'Signs PSP webhooks to /webhooks/pix. ' + API_HELP },
    ],
    defaultInstruction: 'Pay via Pix to the key below and paste the transaction ID.',
    userFields: [{ key: 'pix_txid', label: 'Pix transaction ID', type: 'text', required: true }],
    withdrawUserFields: [{ key: 'pix_key', label: 'Your Pix key', type: 'text', required: true }], webhook: true },
  { key: 'mobile_money', name: 'Mobile Money', icon: '📲',
    credentialFields: [
      { key: 'provider', label: 'Provider (M-Pesa, MTN, Airtel...)', type: 'text', required: true },
      { key: 'account_number', label: 'Receiving account / till number', type: 'text', required: true },
      { key: 'account_name', label: 'Registered account name', type: 'text', help: 'The name the player sees when confirming the payment — lets them verify they are paying the right account.' },
      { key: 'api_key', label: 'Provider API key', type: 'password', secret: true, help: API_HELP },
      { key: 'webhook_secret', label: 'Provider webhook signing secret', type: 'password', secret: true, help: 'Signs provider webhooks to /webhooks/mobile_money. ' + API_HELP },
    ],
    defaultInstruction: 'Send to the mobile money account below and enter the SMS receipt code.',
    userFields: [{ key: 'receipt_code', label: 'Receipt / SMS code', type: 'text', required: true }],
    withdrawUserFields: [
      { key: 'account_number', label: 'Your mobile money number', type: 'text', required: true },
      { key: 'account_name', label: 'Name registered on the account', type: 'text', required: true },
    ], webhook: true },
  { key: 'ewallet', name: 'E-Wallets', icon: '👛',
    credentialFields: [
      { key: 'provider', label: 'Wallet', type: 'select', options: ['Skrill', 'Neteller', 'Other'], required: true, help: 'For PayPal, use the dedicated PayPal method instead.' },
      { key: 'account_email', label: 'Receiving account email/ID', type: 'text', required: true },
      { key: 'client_id', label: 'API client ID', type: 'text', help: API_HELP },
      { key: 'client_secret', label: 'API client secret', type: 'password', secret: true, help: API_HELP },
      { key: 'webhook_secret', label: 'Webhook signing secret', type: 'password', secret: true, help: API_HELP },
    ],
    defaultInstruction: 'Send to the e-wallet account below and paste the transaction ID.',
    userFields: [{ key: 'ewallet_txid', label: 'Transaction ID', type: 'text', required: true }],
    withdrawUserFields: [{ key: 'account_email', label: 'Your wallet account email/ID', type: 'text', required: true }], webhook: true },
  { key: 'apple_pay', name: 'Apple Pay', icon: '🍎',
    credentialFields: [
      { key: 'merchant_id', label: 'Apple merchant ID', type: 'text', required: true, help: 'Your Apple Pay merchant identifier, e.g. merchant.com.example.pay. Public config, not a secret.' },
      { key: 'processor', label: 'Payment processor', type: 'text', required: true, help: 'The PSP that processes Apple Pay for you (e.g. Stripe).' },
      { key: 'api_key', label: 'Processor API key', type: 'password', secret: true, help: API_HELP },
      { key: 'webhook_secret', label: 'Processor webhook signing secret', type: 'password', secret: true, help: 'Signs processor webhooks to /webhooks/apple_pay. ' + API_HELP },
    ],
    defaultInstruction: 'Apple Pay deposits are reviewed manually: submit your request below and our team will confirm your payment. Your balance is credited once payment is confirmed.',
    userFields: [],
    withdrawUserFields: [], webhook: true },
  { key: 'google_pay', name: 'Google Pay', icon: '🅖',
    credentialFields: [
      { key: 'merchant_id', label: 'Google Pay merchant ID', type: 'text', required: true, help: 'Issued by Google Pay & Wallet Console. Public config, not a secret.' },
      { key: 'merchant_name', label: 'Merchant name', type: 'text', help: 'The name shown on the Google Pay sheet.' },
      { key: 'gateway', label: 'Gateway name', type: 'text', required: true, help: 'e.g. stripe, checkoutltd — the gateway that tokenises the payment.' },
      { key: 'gateway_merchant_id', label: 'Gateway merchant ID', type: 'text', help: 'Your merchant/account ID at the gateway above.' },
      { key: 'environment', label: 'Environment', type: 'select', options: ['TEST', 'PRODUCTION'], help: 'TEST for test cards only; PRODUCTION charges real cards.' },
      { key: 'webhook_secret', label: 'Gateway webhook signing secret', type: 'password', secret: true, help: 'Signs gateway webhooks to /webhooks/google_pay. ' + API_HELP },
    ],
    defaultInstruction: 'Google Pay deposits are reviewed manually: submit your request below and our team will confirm your payment. Your balance is credited once payment is confirmed.',
    userFields: [],
    withdrawUserFields: [], webhook: true },
  { key: 'samsung_pay', name: 'Samsung Pay', icon: 'ⓢ',
    credentialFields: [
      { key: 'merchant_id', label: 'Samsung Pay merchant ID', type: 'text', required: true },
      { key: 'service_id', label: 'Service ID', type: 'text', help: 'Issued by Samsung Pay / your payment partner for this service.' },
      { key: 'api_key', label: 'API key', type: 'password', secret: true, help: API_HELP },
      { key: 'webhook_secret', label: 'Webhook signing secret', type: 'password', secret: true, help: API_HELP },
    ],
    defaultInstruction: 'Samsung Pay deposits are reviewed manually: submit your request below and our team will confirm your payment. Your balance is credited once payment is confirmed.',
    userFields: [],
    withdrawUserFields: [], webhook: true },
  { key: 'bank_transfer', name: 'Bank Transfer', icon: '🏦',
    credentialFields: [
      { key: 'bank_name', label: 'Bank name', type: 'text', required: true },
      { key: 'account_name', label: 'Account holder name', type: 'text', required: true },
      { key: 'account_number', label: 'Account number / IBAN', type: 'text', required: true },
      { key: 'swift', label: 'SWIFT / BIC code', type: 'text', help: 'For international transfers, e.g. CHASUS33.' },
      { key: 'routing_number', label: 'US routing number (ABA)', type: 'text', help: 'For US domestic transfers — 9 digits. Use this OR SWIFT, as your bank requires.' },
    ],
    defaultInstruction: 'Transfer to the bank account below and upload/enter your transfer reference.',
    userFields: [
      { key: 'reference', label: 'Transfer reference', type: 'text', required: true },
      { key: 'sender_name', label: 'Name on the sending account', type: 'text' },
    ],
    withdrawUserFields: [
      { key: 'account_name', label: 'Your account holder name', type: 'text', required: true },
      { key: 'account_number', label: 'Your account number / IBAN', type: 'text', required: true },
      { key: 'bank_name', label: 'Your bank name', type: 'text', required: true },
      { key: 'swift', label: 'Your SWIFT / routing code', type: 'text' },
    ], webhook: false },
  { key: 'qr_pay', name: 'QR Pay', icon: '🔳',
    credentialFields: [
      { key: 'provider', label: 'Wallet / network for this QR', type: 'text', required: true, help: 'e.g. PromptPay, UPI, GCash. The player must scan with a compatible app.' },
      { key: 'qr_image_url', label: 'QR code image URL', type: 'text', required: true, help: 'https URL of the QR image shown to players.' },
      { key: 'account_label', label: 'Account label under QR', type: 'text' },
    ],
    defaultInstruction: 'Scan the QR code to pay, then enter your payment reference.',
    userFields: [{ key: 'reference', label: 'Payment reference', type: 'text', required: true }],
    withdrawUserFields: [{ key: 'account_label', label: 'Your wallet account / number', type: 'text', required: true }], webhook: false },
  { key: 'voucher', name: 'Vouchers', icon: '🎟️',
    credentialFields: [
      { key: 'issuer', label: 'Voucher issuer', type: 'text', required: true },
      { key: 'api_key', label: 'Issuer API key', type: 'password', secret: true, help: API_HELP },
    ],
    defaultInstruction: 'Enter your voucher PIN code below.',
    userFields: [{ key: 'voucher_pin', label: 'Voucher PIN', type: 'text', required: true }],
    withdrawUserFields: [], webhook: false },
  { key: 'cash_agent', name: 'Cash Agents', icon: '🤝',
    credentialFields: [
      { key: 'agent_network', label: 'Agent network name', type: 'text', required: true },
      { key: 'instructions', label: 'Agent instructions', type: 'textarea', help: 'Where/how the player pays an agent. Shown to the player.' },
    ],
    defaultInstruction: 'Visit a cash agent location, hand over cash with your account reference, and enter the agent receipt code.',
    userFields: [
      { key: 'agent_location', label: 'Agent location', type: 'text', required: true },
      { key: 'receipt_code', label: 'Agent receipt code', type: 'text', required: true },
    ],
    withdrawUserFields: [
      { key: 'agent_location', label: 'Agent location for cash-out', type: 'text', required: true },
    ], webhook: false },
  { key: 'paypal', name: 'PayPal', icon: '🅿',
    credentialFields: [
      { key: 'account_email', label: 'PayPal account email (receiving)', type: 'text', required: true, help: 'Players send PayPal payments to this email. This alone is enough for manual PayPal deposits.' },
      { key: 'account_name', label: 'Account name shown to sender', type: 'text', help: 'The name the player sees in PayPal when sending — lets them verify the account.' },
      { key: 'mode', label: 'Mode', type: 'select', options: ['live', 'sandbox'], help: 'API mode only: sandbox for test payments, live for real money.' },
      { key: 'client_id', label: 'API client ID', type: 'text', help: API_HELP },
      { key: 'client_secret', label: 'API client secret', type: 'password', secret: true, help: API_HELP },
    ],
    defaultInstruction: 'Send your payment to the PayPal account below (Friends & Family is not required — send as Goods & Services if asked), then enter the PayPal transaction ID.',
    userFields: [
      { key: 'paypal_txid', label: 'PayPal transaction ID', type: 'text', required: true },
      { key: 'sender_email', label: 'Email you sent from', type: 'text' },
    ],
    withdrawUserFields: [{ key: 'account_email', label: 'Your PayPal email', type: 'text', required: true }],
    // PayPal webhook verification is NOT HMAC: it needs PayPal's
    // verify-webhook-signature API (webhook_id + access token). No such
    // client exists in this codebase, so webhook stays false rather than
    // pretending the generic HMAC route verifies PayPal events.
    webhook: false },
];

function getRail(key) { return RAILS.find(r => r.key === key); }
function isBlockedRail(key, extraCsv) {
  const k = String(key || '').toLowerCase();
  if (BLOCKED_RAILS.has(k)) return true; // EBT is hard-blocked by policy, always.
  // R-045: the blocked_rails SETTING (comma list) adds operator blocks on
  // top of the hard block; callers with settings pass it in. Without
  // settings the hard block alone applies (previously the setting was
  // seeded but never read anywhere).
  if (extraCsv) return String(extraCsv).split(',').map(x => x.trim().toLowerCase()).includes(k);
  return false;
}

function fieldOf(rail, key) { return (rail && rail.credentialFields || []).find(f => f.key === key); }
function isSecretField(railKey, fieldKey) {
  const f = fieldOf(getRail(railKey), fieldKey);
  return !!(f && (f.secret || f.type === 'password'));
}

/* ---------- U-21: per-key format validation (true-reason errors) ----------
   validateCredentialValue returns '' when valid, else the true reason.
   Only shapes that are genuinely fixed by the provider/format are
   enforced; everything else is length/charset sanity. Empty optional
   values are valid (requiredness is validateRailCredentials' job). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
function validateCredentialValue(railKey, field, rawValue, allValues = {}) {
  const f = typeof field === 'string' ? fieldOf(getRail(railKey), field) : field;
  if (!f) return 'Unknown configuration field.';
  const v = String(rawValue === null || rawValue === undefined ? '' : rawValue).trim();
  if (!v) return '';
  const bad = (why) => `"${f.label}" ${why}`;
  if (v.length > 2000) return bad('is too long (max 2000 characters).');
  if (f.type === 'select' && Array.isArray(f.options) && !f.options.includes(v))
    return bad(`must be one of: ${f.options.join(', ')}.`);
  if (f.type === 'number' && (!/^\d+$/.test(v) || Number(v) > 100)) return bad('must be a whole number between 0 and 100.');
  if ((f.secret || f.type === 'password') && v.length < 8) return bad('looks too short — provider secrets are at least 8 characters. Check for a truncated paste.');
  switch (f.key) {
    case 'wallet_address':
      if (/\s/.test(v) || v.length < 26 || v.length > 120) return bad('must be a single wallet address (26-120 characters, no spaces). Check the network matches the address.');
      break;
    case 'asset':
      if (!/^[A-Z0-9]{2,10}$/.test(v)) return bad('must be the asset ticker in capitals, e.g. BTC, USDT, ETH.');
      break;
    case 'network':
      if (v.length < 2 || v.length > 30) return bad('must name the network, e.g. Bitcoin, TRC20, ERC20.');
      break;
    case 'upi_id':
      if (!/^[\w.\-]{2,}@[A-Za-z]{2,}$/.test(v)) return bad('must be a UPI ID / VPA in the form name@bank (e.g. yourname@okhdfcbank).');
      break;
    case 'pix_key': {
      const digits = v.replace(/\D/g, '');
      const ok = EMAIL_RE.test(v) || /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(v)
        || digits.length === 11 || digits.length === 14 || (v.length === 32 && /^[A-Za-z0-9]+$/.test(v)) || /^\+?\d{10,15}$/.test(v.replace(/[\s()-]/g, ''));
      if (!ok) return bad('must be a valid Pix key: CPF (11 digits), CNPJ (14 digits), email, phone, or the 32-character random key.');
      break;
    }
    case 'account_email': case 'sender_email':
      if (railKey === 'paypal' && !EMAIL_RE.test(v)) return bad('must be a valid PayPal email address.');
      if (v.includes('@') && !EMAIL_RE.test(v)) return bad('must be a valid email address.');
      if (!v.includes('@') && v.length < 3) return bad('must be a valid email address or account ID.');
      break;
    case 'account_number':
      if (railKey === 'bank_transfer') { const c = v.replace(/[\s-]/g, ''); if (!/^[A-Za-z0-9]{4,34}$/.test(c)) return bad('must be 4-34 characters (account number or IBAN, letters and digits).'); }
      else if (railKey === 'mobile_money') { if (!/^\+?[\d\s-]{7,20}$/.test(v)) return bad('must be a mobile money number (7-20 digits).'); }
      break;
    case 'swift':
      if (!/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(v.toUpperCase())) return bad('must be a valid SWIFT/BIC code (8 or 11 characters, e.g. CHASUS33). For a US routing number, use the routing number field instead.');
      break;
    case 'routing_number':
      if (!/^\d{9}$/.test(v)) return bad('must be exactly 9 digits (US ABA routing number).');
      break;
    case 'qr_image_url':
      if (!/^https:\/\/[^\s]+$/i.test(v)) return bad('must be an https:// URL of the QR image.');
      break;
    case 'merchant_id':
      if (railKey === 'apple_pay' && !/^merchant\./.test(v)) return bad('must be your Apple merchant identifier, starting with "merchant." (e.g. merchant.com.example.pay).');
      break;
    case 'publishable_key': case 'secret_key': case 'webhook_secret': {
      const isStripe = railKey === 'cards' && String(allValues.provider || 'Stripe') === 'Stripe';
      if (isStripe && f.key === 'publishable_key' && !/^pk_(live|test)_/.test(v)) return bad('for Stripe must start with pk_live_ or pk_test_.');
      if (isStripe && f.key === 'secret_key' && !/^(sk|rk)_(live|test)_/.test(v)) return bad('for Stripe must start with sk_live_, sk_test_, rk_live_ or rk_test_.');
      if (isStripe && f.key === 'webhook_secret' && !/^whsec_/.test(v)) return bad('for Stripe must start with whsec_ (Stripe Dashboard -> Webhooks -> signing secret).');
      if (isStripe && allValues.mode) {
        const m = /_(live|test)_/.exec(v);
        if (m && ((allValues.mode === 'live') !== (m[1] === 'live'))) return bad(`is a ${m[1]} key but the method Mode is set to ${allValues.mode}. Live mode needs live keys; sandbox needs test keys.`);
      }
      break;
    }
    default: break;
  }
  return '';
}
function validateRailCredentials(railKey, values = {}) {
  const rail = getRail(railKey);
  if (!rail) return { ok: false, error: 'Unknown rail.' };
  for (const f of rail.credentialFields || []) {
    const v = String(values[f.key] === null || values[f.key] === undefined ? '' : values[f.key]).trim();
    if (f.required && !v) return { ok: false, error: `"${f.label}" is required for ${rail.name}.`, field: f.key };
    const err = validateCredentialValue(railKey, f, v, values);
    if (err) return { ok: false, error: err, field: f.key };
  }
  return { ok: true };
}

/* Player-submitted proof formats (deposit/withdraw userFields). Only
   keys whose format is fixed by the payment system are enforced, and
   only when a value was actually submitted — requiredness stays with
   the route, as before. Returns '' or the true reason. */
function validateUserProof(railKey, userData = {}) {
  const tx = String(userData.tx_hash || '').trim();
  if (tx && !/^(0x)?[A-Za-z0-9]{32,128}$/.test(tx)) return 'Transaction hash looks invalid: paste the full transaction hash from your wallet/explorer (at least 32 characters, letters and digits only).';
  const utr = String(userData.utr || '').trim();
  if (utr && !/^[A-Za-z0-9]{12,22}$/.test(utr)) return 'UTR / reference number looks invalid: UPI UTR numbers are 12 digits — copy the full UTR from your UPI app.';
  return '';
}

/* Webhook signature verification hooks. Each provider's real verification
   plugs in here; unknown/missing secrets => reject (fail closed). */
/* Real webhook verification (2026-10-27 audit fix): the old version returned
   ok:true whenever ANY signature header was present, without computing
   anything — a forged webhook passed. Now the HMAC-SHA256 of the raw body is
   computed with each configured method secret on the rail and compared with
   crypto.timingSafeEqual. Fails closed: no secret, or no match, is rejected.
   methods = [{ id, secret }] (all enabled methods on the rail — the old code
   used only the first method, which picked the wrong credentials when two
   methods shared a rail). */
function verifyWebhookSignature(railKey, req, methods) {
  const list = Array.isArray(methods) ? methods : [];
  // R-084: ONLY webhook_secret is a signing secret. Falling back to
  // api_token/secret_key masked misconfiguration as "signature mismatch".
  const secrets = list
    .map(m => ({ id: m.id, secret: m.webhook_secret || '' }))
    .filter(m => m.secret);
  if (!secrets.length) return { ok: false, reason: 'no webhook signing secret configured' };
  if (!Buffer.isBuffer(req.body) && typeof req.body !== 'string')
    return { ok: false, reason: 'raw webhook body unavailable (body was already parsed)' };
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
  const header = req.headers['x-signature'] || req.headers['x-webhook-signature'] || req.headers['stripe-signature'] || '';
  if (!header) return { ok: false, reason: 'missing signature header' };
  // Candidate signatures: raw header, "sha256=<hex>" form, and Stripe-style
  // "t=<ts>,v1=<hex>" (signed payload "ts.rawBody").
  const candidates = [];
  const stripe = /v1=([0-9a-fA-F]+)/.exec(header);
  const ts = /t=(\d+)/.exec(header);
  if (stripe && ts) candidates.push({ payload: Buffer.concat([Buffer.from(ts[1] + '.'), raw]), sig: stripe[1] });
  const plain = header.replace(/^sha256=/, '').trim();
  candidates.push({ payload: raw, sig: plain });
  const crypto = require('crypto');
  for (const { id, secret } of secrets) {
    for (const c of candidates) {
      const expected = crypto.createHmac('sha256', secret).update(c.payload).digest('hex');
      try {
        if (c.sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(c.sig, 'utf8'), Buffer.from(expected, 'utf8')))
          return { ok: true, provider: railKey, methodId: id };
      } catch (e) { /* length/encoding mismatch: not a match */ }
    }
  }
  return { ok: false, reason: 'signature mismatch' };
}

/* DS-005: credential fields that are RECEIVING details - the address/ID a
   player must pay TO. These are shown to players on the deposit page
   (they are the operator's public payment addresses, like a shop's bank
   details on an invoice). Password-type fields and API secrets are NEVER
   in this map and are never shown to players. */
const RECEIVING_FIELDS = {
  crypto: ['asset', 'network', 'wallet_address', 'confirmations'],
  upi: ['upi_id', 'merchant_name'],
  pix: ['pix_key', 'pix_key_type'],
  mobile_money: ['provider', 'account_number', 'account_name'],
  ewallet: ['provider', 'account_email'],
  paypal: ['account_email', 'account_name'],
  bank_transfer: ['bank_name', 'account_name', 'account_number', 'swift', 'routing_number'],
  qr_pay: ['provider', 'qr_image_url', 'account_label'],
  cash_agent: ['agent_network', 'instructions'],
};
/* U-21: NON-SECRET gateway configuration a payment page legitimately
   needs client-side (Stripe publishable key, Google Pay gateway
   parameters, Apple merchant ID, PayPal client ID). These are public
   by design in each provider's model. Secret/password fields are never
   in this map; getPublicConfig also hard-skips them defensively.
   Player-page rendering is spec'd in adj-payments.md §5.3. */
const PUBLIC_CONFIG_FIELDS = {
  cards: ['provider', 'publishable_key'],
  paypal: ['client_id'],
  apple_pay: ['merchant_id', 'processor'],
  google_pay: ['merchant_id', 'merchant_name', 'gateway', 'gateway_merchant_id', 'environment'],
  samsung_pay: ['merchant_id', 'service_id'],
};
async function loadSaved(db, method) {
  const { loadCredentials } = require('./credentials');
  return loadCredentials(db, method.id);
}
async function pickDetails(db, method, keysMap) {
  const rail = getRail(method.rail);
  const keys = (rail && keysMap[rail.key]) || [];
  if (!keys.length || !db) return [];
  const saved = await loadSaved(db, method);
  const out = [];
  for (const k of keys) {
    const f = fieldOf(rail, k);
    if (f && (f.secret || f.type === 'password')) continue; // defense in depth: secrets are never player-visible
    const v = String(saved[k] || '').trim();
    if (v) out.push({ key: k, label: f ? f.label : k, value: v });
  }
  return out;
}
async function getReceivingDetails(db, method) { return pickDetails(db, method, RECEIVING_FIELDS); }
async function getPublicConfig(db, method) { return pickDetails(db, method, PUBLIC_CONFIG_FIELDS); }

module.exports = { RAILS, BLOCKED_RAILS, getRail, isBlockedRail, verifyWebhookSignature, RECEIVING_FIELDS, PUBLIC_CONFIG_FIELDS, getReceivingDetails, getPublicConfig, isSecretField, validateCredentialValue, validateRailCredentials, validateUserProof };
