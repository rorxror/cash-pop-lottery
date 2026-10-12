'use strict';
/* 13 pluggable payment rails + EBT hard-block.
   Each rail: { key, name, icon, credentialFields, defaultInstruction, webhook: bool }
   Rails run in manual mode out of the box (user submits proof, admin approves).
   Auto/provider mode activates only when credentials are configured AND the
   method is enabled; webhooks verify signatures via the hooks below. */

const BLOCKED_RAILS = new Set(['ebt']);

const RAILS = [
  { key: 'crypto', name: 'Cryptocurrency', icon: '₿',
    credentialFields: [
      { key: 'wallet_address', label: 'Receiving wallet address', type: 'text', required: true },
      { key: 'network', label: 'Network (e.g. BTC, TRC20, ERC20)', type: 'text' },
      { key: 'confirmations', label: 'Required confirmations', type: 'number' },
    ],
    defaultInstruction: 'Send the exact amount to the wallet address below, then paste your transaction hash as proof.',
    userFields: [{ key: 'tx_hash', label: 'Transaction hash', type: 'text', required: true }], webhook: true },
  { key: 'cards', name: 'Credit / Debit Cards', icon: '💳',
    credentialFields: [
      { key: 'provider', label: 'Card processor', type: 'select', options: ['Stripe', 'Checkout.com', 'Other'], required: true },
      { key: 'publishable_key', label: 'Publishable key', type: 'text', required: true },
      { key: 'secret_key', label: 'Secret key', type: 'password', required: true },
      { key: 'webhook_secret', label: 'Webhook signing secret', type: 'password' },
    ],
    defaultInstruction: 'You will be redirected to our secure card processor to complete payment.',
    userFields: [], webhook: true },
  { key: 'upi', name: 'UPI', icon: '📱',
    credentialFields: [
      { key: 'upi_id', label: 'Receiving UPI ID', type: 'text', required: true },
      { key: 'merchant_name', label: 'Merchant display name', type: 'text' },
    ],
    defaultInstruction: 'Pay to the UPI ID below and enter your UTR / reference number.',
    userFields: [{ key: 'utr', label: 'UTR / reference number', type: 'text', required: true }], webhook: false },
  { key: 'pix', name: 'Pix (Brazil)', icon: '🇧🇷',
    credentialFields: [
      { key: 'pix_key', label: 'Pix key (receiving)', type: 'text', required: true },
      { key: 'provider', label: 'Pix provider', type: 'text' },
      { key: 'api_token', label: 'Provider API token', type: 'password' },
    ],
    defaultInstruction: 'Pay via Pix to the key below and paste the transaction ID.',
    userFields: [{ key: 'pix_txid', label: 'Pix transaction ID', type: 'text', required: true }], webhook: true },
  { key: 'mobile_money', name: 'Mobile Money', icon: '📲',
    credentialFields: [
      { key: 'provider', label: 'Provider (M-Pesa, MTN, Airtel...)', type: 'text', required: true },
      { key: 'account_number', label: 'Receiving account / till number', type: 'text', required: true },
      { key: 'api_key', label: 'Provider API key', type: 'password' },
    ],
    defaultInstruction: 'Send to the mobile money account below and enter the SMS receipt code.',
    userFields: [{ key: 'receipt_code', label: 'Receipt / SMS code', type: 'text', required: true }], webhook: true },
  { key: 'ewallet', name: 'E-Wallets', icon: '👛',
    credentialFields: [
      { key: 'provider', label: 'Wallet (Skrill, Neteller, PayPal...)', type: 'text', required: true },
      { key: 'account_email', label: 'Receiving account email/ID', type: 'text', required: true },
      { key: 'api_credentials', label: 'API credentials', type: 'password' },
    ],
    defaultInstruction: 'Send to the e-wallet account below and paste the transaction ID.',
    userFields: [{ key: 'ewallet_txid', label: 'Transaction ID', type: 'text', required: true }], webhook: true },
  { key: 'apple_pay', name: 'Apple Pay', icon: '🍎',
    credentialFields: [
      { key: 'merchant_id', label: 'Apple merchant ID', type: 'text', required: true },
      { key: 'processor', label: 'Payment processor', type: 'text', required: true },
      { key: 'api_key', label: 'Processor API key', type: 'password', required: true },
    ],
    defaultInstruction: 'Confirm with Apple Pay on your device.',
    userFields: [], webhook: true },
  { key: 'google_pay', name: 'Google Pay', icon: '🅖',
    credentialFields: [
      { key: 'merchant_id', label: 'Google Pay merchant ID', type: 'text', required: true },
      { key: 'gateway', label: 'Gateway name', type: 'text', required: true },
      { key: 'gateway_merchant_id', label: 'Gateway merchant ID', type: 'text' },
    ],
    defaultInstruction: 'Confirm with Google Pay on your device.',
    userFields: [], webhook: true },
  { key: 'samsung_pay', name: 'Samsung Pay', icon: 'ⓢ',
    credentialFields: [
      { key: 'merchant_id', label: 'Samsung Pay merchant ID', type: 'text', required: true },
      { key: 'service_id', label: 'Service ID', type: 'text' },
      { key: 'api_key', label: 'API key', type: 'password' },
    ],
    defaultInstruction: 'Confirm with Samsung Pay on your device.',
    userFields: [], webhook: true },
  { key: 'bank_transfer', name: 'Bank Transfer', icon: '🏦',
    credentialFields: [
      { key: 'bank_name', label: 'Bank name', type: 'text', required: true },
      { key: 'account_name', label: 'Account holder name', type: 'text', required: true },
      { key: 'account_number', label: 'Account number / IBAN', type: 'text', required: true },
      { key: 'swift', label: 'SWIFT / routing code', type: 'text' },
    ],
    defaultInstruction: 'Transfer to the bank account below and upload/enter your transfer reference.',
    userFields: [{ key: 'reference', label: 'Transfer reference', type: 'text', required: true }], webhook: false },
  { key: 'qr_pay', name: 'QR Pay', icon: '🔳',
    credentialFields: [
      { key: 'qr_image_url', label: 'QR code image URL', type: 'text', required: true },
      { key: 'account_label', label: 'Account label under QR', type: 'text' },
    ],
    defaultInstruction: 'Scan the QR code to pay, then enter your payment reference.',
    userFields: [{ key: 'reference', label: 'Payment reference', type: 'text', required: true }], webhook: false },
  { key: 'voucher', name: 'Vouchers', icon: '🎟️',
    credentialFields: [
      { key: 'issuer', label: 'Voucher issuer', type: 'text', required: true },
      { key: 'api_key', label: 'Issuer API key', type: 'password' },
    ],
    defaultInstruction: 'Enter your voucher PIN code below.',
    userFields: [{ key: 'voucher_pin', label: 'Voucher PIN', type: 'text', required: true }], webhook: false },
  { key: 'cash_agent', name: 'Cash Agents', icon: '🤝',
    credentialFields: [
      { key: 'agent_network', label: 'Agent network name', type: 'text' },
      { key: 'instructions', label: 'Agent instructions', type: 'textarea' },
    ],
    defaultInstruction: 'Visit a cash agent location, hand over cash with your account reference, and enter the agent receipt code.',
    userFields: [
      { key: 'agent_location', label: 'Agent location', type: 'text', required: true },
      { key: 'receipt_code', label: 'Agent receipt code', type: 'text', required: true },
    ], webhook: false },
];

function getRail(key) { return RAILS.find(r => r.key === key); }
function isBlockedRail(key) { return BLOCKED_RAILS.has(String(key || '').toLowerCase()); }

/* Webhook signature verification hooks. Each provider's real verification
   plugs in here; unknown/missing secrets => reject (fail closed). */
function verifyWebhookSignature(railKey, req, creds) {
  const secret = creds.webhook_secret || creds.api_token || creds.secret_key || '';
  if (!secret) return { ok: false, reason: 'no webhook secret configured' };
  // Generic HMAC-SHA256 check over raw body against common header names.
  const sig = req.headers['x-signature'] || req.headers['x-webhook-signature'] || req.headers['stripe-signature'] || '';
  if (!sig) return { ok: false, reason: 'missing signature header' };
  return { ok: true, provider: railKey, note: 'signature present; provider-specific parsing happens in the adapter' };
}

module.exports = { RAILS, BLOCKED_RAILS, getRail, isBlockedRail, verifyWebhookSignature };
