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
  { key: 'crypto',
    prevDefaultInstructions: ['Send the exact amount to the wallet address below, on the network shown, then paste your transaction hash as proof.'], name: 'Cryptocurrency', icon: '₿',
    credentialFields: [
      { key: 'asset', label: 'Asset (e.g. BTC, USDT, ETH)', type: 'text', required: true, help: 'One method = one asset on one network. Create a separate method per asset/network.' },
      { key: 'network', label: 'Network (e.g. Bitcoin, TRC20, ERC20)', type: 'text', required: true, help: 'The player must send on exactly this network; a wrong-network transfer can be lost.' },
      { key: 'wallet_address', label: 'Receiving wallet address', type: 'text', required: true, help: 'The deposit address from YOUR own wallet or exchange account — open your wallet app, choose Receive/Deposit for this asset and network, and copy the address it shows.' },
      { key: 'confirmations', label: 'Required confirmations', type: 'number', help: 'Shown to the player; staff credit the deposit after this many network confirmations.' },
      { key: 'api_key', label: 'Processor API key', type: 'password', secret: true, help: 'Only if a crypto processor (e.g. NOWPayments, Coinbase Commerce) handles this asset: both call this the API Key — NOWPayments: Settings -> Payments -> API keys; Coinbase Commerce: Settings -> API keys. Not needed for direct wallet receiving. ' + API_HELP },
      { key: 'webhook_secret', label: 'Processor webhook signing secret', type: 'password', secret: true, help: 'Only if a crypto processor sends HMAC webhooks to /webhooks/crypto. NOWPayments calls this the IPN Secret Key (Settings -> Payments -> Instant payment notifications); Coinbase Commerce calls it the Webhook Shared Secret (Settings -> Webhook subscriptions). ' + API_HELP },
    ],
    defaultInstruction: '1. Copy the wallet address shown below — check the asset and network match exactly (sending on the wrong network can lose your money).\n2. In your own wallet or exchange app, send the exact amount you enter below to that address.\n3. After sending, copy the transaction hash (TxID) from your wallet — you will find it in the transaction details.\n4. Paste the transaction hash in the box below and press Submit Deposit.\n5. Our team checks the payment on the network and credits your balance after approval.',
    withdrawInstruction: '1. Enter YOUR wallet address and its network below — triple-check both: a payout sent to a wrong address or network cannot be recovered.\n2. Press Submit and confirm with your verification code if asked.\n3. The amount is held while our team reviews the request.\n4. We send the payout to your address outside this site and mark it paid — the transaction hash is recorded against your request.',
    autoInstruction: '1. Copy the wallet address shown below — check the asset and network match exactly (the wrong network can lose your money).\n2. Send the exact amount from your wallet or exchange.\n3. No proof chasing: once the payment provider confirms your payment on the network, your balance is credited automatically.',
    userFields: [{ key: 'tx_hash', label: 'Transaction hash', type: 'text', required: true }],
    withdrawUserFields: [
      { key: 'wallet_address', label: 'Your wallet address', type: 'text', required: true },
      { key: 'network', label: 'Network (must match the asset)', type: 'text', required: true },
    ], webhook: true },
  { key: 'cards',
    prevDefaultInstructions: ['Card deposits are reviewed manually: submit your request below and our team will contact you with a secure payment link. Your balance is credited once payment is confirmed.'], name: 'Credit / Debit Cards', icon: '💳',
    credentialFields: [
      { key: 'provider', label: 'Card processor', type: 'select', options: ['Stripe', 'Checkout.com', 'Other'], required: true },
      { key: 'mode', label: 'Mode', type: 'select', options: ['live', 'sandbox'], help: 'Must match the keys below: sandbox = test keys, live = real-money keys.' },
      { key: 'publishable_key', label: 'Publishable key', type: 'text', help: 'Public key (not a secret) — Stripe and Checkout.com both call it the Publishable key. Found in Stripe Dashboard -> Developers -> API keys. Used by the hosted checkout integration; manual payment-link mode works without it.' },
      { key: 'secret_key', label: 'Secret key', type: 'password', secret: true, help: 'Stripe calls this the Secret key — same page as the publishable key: Stripe Dashboard -> Developers -> API keys. ' + API_HELP },
      { key: 'webhook_secret', label: 'Webhook signing secret', type: 'password', secret: true, help: 'Stripe calls this the Signing secret: Stripe Dashboard -> Developers -> Webhooks -> your endpoint -> Signing secret. Signs provider webhooks to /webhooks/cards so completed payments can be auto-credited. ' + API_HELP },
    ],
    defaultInstruction: '1. Enter the amount below and press Submit Deposit.\n2. Our team will contact you with a secure payment link for this request — never pay through any other link.\n3. Pay the exact amount on that link with your card.\n4. Your balance is credited once our team confirms the payment arrived.',
    withdrawInstruction: '1. Enter the amount and press Submit, then confirm with your verification code if asked.\n2. This method has no built-in payout destination, so our team will contact you to arrange where to send your payout.\n3. The amount is held while our team reviews the request.\n4. We complete the payout outside this site and mark the request paid.',
    autoInstruction: '1. Enter the amount below and press Submit Deposit.\n2. Complete the card payment with the payment provider.\n3. Once the card provider confirms your payment, your balance is credited automatically — no proof needs to be sent.',
    userFields: [],
    withdrawUserFields: [], webhook: true },
  { key: 'upi',
    prevDefaultInstructions: ['Pay to the UPI ID below and enter your UTR / reference number.'], name: 'UPI', icon: '📱',
    credentialFields: [
      { key: 'upi_id', label: 'Receiving UPI ID (VPA)', type: 'text', required: true, help: 'Your UPI ID is also called a VPA (Virtual Payment Address), e.g. yourname@okhdfcbank. It is shown in your UPI app (Google Pay, PhonePe, Paytm) on your profile or QR screen. Players pay exactly this ID.' },
      { key: 'merchant_name', label: 'Verified name linked to this UPI ID', type: 'text', help: 'The name registered with the bank against this UPI ID/VPA — the payer sees exactly this name on the confirmation screen before entering their PIN, so copy it from your bank/UPI app exactly; do not invent a display name.' },
    ],
    defaultInstruction: '1. Open your UPI app (Google Pay, PhonePe, Paytm) and pay the exact amount to the UPI ID (VPA) shown below.\n2. After paying, open that payment in your UPI app and copy the UTR / reference number (12 digits).\n3. Enter the UTR in the box below and press Submit Deposit.\n4. Our team matches your UTR with the payment received and credits your balance after approval.',
    withdrawInstruction: '1. Enter YOUR UPI ID (VPA) below — double-check it, a payout sent to a wrong UPI ID cannot be pulled back.\n2. Press Submit and confirm with your verification code if asked.\n3. The amount is held while our team reviews the request.\n4. We pay your UPI ID outside this site and mark the request paid.',
    autoInstruction: '1. Pay the exact amount to the UPI ID (VPA) shown below in your UPI app.\n2. Enter the UTR / reference number from that payment below and submit.\n3. Once the payment provider confirms your payment, your balance is credited automatically.',
    userFields: [{ key: 'utr', label: 'UTR / reference number', type: 'text', required: true }],
    withdrawUserFields: [{ key: 'upi_id', label: 'Your UPI ID', type: 'text', required: true }], webhook: false },
  { key: 'pix',
    prevDefaultInstructions: ['Pay via Pix to the key below and paste the transaction ID.'], name: 'Pix (Brazil)', icon: '🇧🇷',
    credentialFields: [
      { key: 'pix_key', label: 'Pix key (receiving)', type: 'text', required: true, help: 'Your Pix key exactly as registered in your bank app (in the bank app it is under Pix -> My keys / Chaves Pix): it can be your CPF, CNPJ, email, phone number, or a random key.' },
      { key: 'pix_key_type', label: 'Pix key type', type: 'select', options: ['cpf', 'cnpj', 'email', 'phone', 'random'] },
      { key: 'provider', label: 'Bank / payment institution (PSP) holding this Pix key', type: 'text', help: 'The bank or payment institution where this Pix key (chave Pix) is registered. Only needed if a PSP/gateway processes Pix for you; direct Pix to your own key needs no provider entry.' },
      { key: 'api_token', label: 'Provider API token', type: 'password', secret: true, help: 'Only if a named PSP/gateway processes Pix for you — Pix itself (Banco Central) issues no token; this is that gateway\'s own credential, under whatever name the gateway uses (token, Client ID/Secret, access token). ' + API_HELP },
      { key: 'webhook_secret', label: 'Provider webhook signing secret', type: 'password', secret: true, help: 'Signs the named PSP/gateway webhooks to /webhooks/pix — again the gateway\'s credential, not a Pix/Banco Central one. ' + API_HELP },
    ],
    defaultInstruction: '1. In your bank app, choose Pix and pay the exact amount to the Pix key shown below.\n2. After paying, copy the transaction ID from the Pix receipt in your bank app.\n3. Paste the transaction ID in the box below and press Submit Deposit.\n4. Our team matches it with the payment received and credits your balance after approval.',
    withdrawInstruction: '1. Enter YOUR Pix key below — double-check it, a payout sent to a wrong Pix key cannot be pulled back.\n2. Press Submit and confirm with your verification code if asked.\n3. The amount is held while our team reviews the request.\n4. We send the Pix payment outside this site and mark the request paid.',
    autoInstruction: '1. Pay the exact amount to the Pix key shown below in your bank app.\n2. Paste the transaction ID from the Pix receipt below and submit.\n3. Once the payment provider confirms your payment, your balance is credited automatically.',
    userFields: [{ key: 'pix_txid', label: 'Pix transaction ID', type: 'text', required: true }],
    withdrawUserFields: [{ key: 'pix_key', label: 'Your Pix key', type: 'text', required: true }], webhook: true },
  { key: 'mobile_money',
    prevDefaultInstructions: ['Send to the mobile money account below and enter the SMS receipt code.'], name: 'Mobile Money', icon: '📲',
    credentialFields: [
      { key: 'provider', label: 'Provider (M-Pesa, MTN, Airtel...)', type: 'text', required: true },
      { key: 'account_type', label: 'Receiving type', type: 'select', options: ['paybill', 'till', 'mobile'], required: true, help: 'How players pay you on M-Pesa (Lipa na M-PESA): Paybill = they choose Pay Bill and enter your Business Number plus their own account reference; Till = they choose Buy Goods and enter your Till Number; Mobile = they send to your M-Pesa-registered mobile number. Pick the one that matches the number below.' },
      { key: 'account_number', label: 'Business Number / Till Number / mobile number', type: 'text', required: true, help: 'The number matching the type above: your Paybill Business Number, your Till Number, or your registered mobile number. (On Paybill, the "Account Number" the PLAYER types is their own reference — it is not yours to enter here.)' },
      { key: 'account_name', label: 'Registered organisation / merchant name', type: 'text', help: 'The organisation name registered on that Paybill/Till/number — the player sees exactly this name on the confirmation prompt, so copy it as registered.' },
      { key: 'api_key', label: 'Provider API key / Consumer Key', type: 'password', secret: true, help: 'M-Pesa (Daraja) calls this the Consumer Key: developer.safaricom.co.ke -> My Apps -> your app. MTN MoMo calls theirs API Key (with a separate API User and Subscription Key). Only needed for API mode. ' + API_HELP },
      { key: 'webhook_secret', label: 'Provider webhook signing secret', type: 'password', secret: true, help: 'M-Pesa Daraja has NO webhook signing secret (it uses registered Callback URLs instead) — leave blank for M-Pesa. Fill only if YOUR provider actually gave you a signing secret for webhooks to /webhooks/mobile_money. ' + API_HELP },
    ],
    defaultInstruction: '1. Send the exact amount from your mobile money account to the account number shown below — check the provider name matches yours.\n2. You will get an SMS receipt with a code after sending.\n3. Enter that SMS receipt code in the box below and press Submit Deposit.\n4. Our team matches the code with the payment received and credits your balance after approval.',
    withdrawInstruction: '1. Enter YOUR mobile money number and the name registered on it below — double-check the number, a payout sent to a wrong number cannot be pulled back.\n2. Press Submit and confirm with your verification code if asked.\n3. The amount is held while our team reviews the request.\n4. We send the money to your number outside this site and mark the request paid.',
    autoInstruction: '1. Send the exact amount to the mobile money account shown below.\n2. Enter the SMS receipt code you received and submit.\n3. Once the payment provider confirms your payment, your balance is credited automatically.',
    userFields: [{ key: 'receipt_code', label: 'Receipt / SMS code', type: 'text', required: true }],
    withdrawUserFields: [
      { key: 'account_number', label: 'Your mobile money number', type: 'text', required: true },
      { key: 'account_name', label: 'Name registered on the account', type: 'text', required: true },
    ], webhook: true },
  { key: 'ewallet',
    prevDefaultInstructions: ['Send to the e-wallet account below and paste the transaction ID.'], name: 'E-Wallets', icon: '👛',
    credentialFields: [
      { key: 'provider', label: 'Wallet', type: 'select', options: ['Skrill', 'Neteller', 'Other'], required: true, help: 'For PayPal, use the dedicated PayPal method instead.' },
      { key: 'account_email', label: 'Merchant account email / ID (receiving)', type: 'text', required: true, help: 'Skrill: your merchant account processing email (the pay_to_email your account is registered with). NETELLER: your account email or 12-digit NETELLER Account ID. Players send to exactly this.' },
      { key: 'client_id', label: 'Client ID', type: 'text', help: 'NETELLER only: NETELLER merchant portal -> Settings -> Developer Settings -> API Keys (NETELLER REST API keys). Skrill has NO Client ID — Skrill uses a Merchant ID (Customer ID) + Secret Word instead; leave blank for Skrill. ' + API_HELP },
      { key: 'client_secret', label: 'Client Secret', type: 'password', secret: true, help: 'NETELLER only: same API Keys page as the Client ID. Skrill has NO Client Secret (its equivalent is the Secret Word below) — leave blank for Skrill. ' + API_HELP },
      { key: 'merchant_id', label: 'Merchant ID (Customer ID)', type: 'text', help: 'Skrill only — needed for Auto Pay: Skrill calls this your Merchant ID / Customer ID; it is shown in your Skrill merchant account (top of the page / Account overview) and Skrill prints it on every status report so we can check the report is really yours. NETELLER does not use this — leave blank for NETELLER. ' + API_HELP },
      { key: 'secret_word', label: 'Secret Word', type: 'password', secret: true, help: 'Skrill only — needed for Auto Pay: the Secret Word signs Skrill\'s payment status reports to /webhooks/skrill, and we verify that signature before crediting anything. Set or find it in your Skrill merchant account -> Settings -> Developer Settings -> Secret Word. It is NOT your Skrill password. NETELLER has no Secret Word — leave blank. ' + API_HELP },
      { key: 'webhook_secret', label: 'Webhook signing secret', type: 'password', secret: true, help: 'Skrill does NOT use a webhook signing secret (its status reports are signed with the Secret Word above) and NETELLER webhooks are configured in the portal — fill this only if your wallet provider actually gave you a signing secret for webhooks to /webhooks/ewallet. ' + API_HELP },
    ],
    defaultInstruction: '1. Send the exact amount from your e-wallet to the account email/ID shown below.\n2. After sending, copy the transaction ID from that payment in your wallet app.\n3. Paste the transaction ID in the box below and press Submit Deposit.\n4. Our team matches it with the payment received and credits your balance after approval.',
    withdrawInstruction: '1. Enter YOUR wallet account email/ID below — double-check it, a payout sent to a wrong account cannot be pulled back.\n2. Press Submit and confirm with your verification code if asked.\n3. The amount is held while our team reviews the request.\n4. We send the payout to your wallet account outside this site and mark it paid.',
    autoInstruction: '1. Send the exact amount to the e-wallet account shown below.\n2. Paste the transaction ID from that payment below and submit.\n3. Once the payment provider confirms your payment, your balance is credited automatically.',
    userFields: [{ key: 'ewallet_txid', label: 'Transaction ID', type: 'text', required: true }],
    withdrawUserFields: [{ key: 'account_email', label: 'Your wallet account email/ID', type: 'text', required: true }], webhook: true },
  { key: 'apple_pay',
    prevDefaultInstructions: ['Apple Pay deposits are reviewed manually: submit your request below and our team will confirm your payment. Your balance is credited once payment is confirmed.'], name: 'Apple Pay', icon: '🍎',
    credentialFields: [
      { key: 'merchant_id', label: 'Apple merchant ID', type: 'text', required: true, help: 'Your Apple Pay merchant identifier, e.g. merchant.com.example.pay. Found in your Apple Developer account -> Certificates, Identifiers & Profiles -> Merchant IDs. Public config, not a secret.' },
      { key: 'processor', label: 'Payment processor', type: 'text', required: true, help: 'The PSP that processes Apple Pay for you (e.g. Stripe).' },
      { key: 'api_key', label: 'Processor API key', type: 'password', secret: true, help: 'Apple itself issues NO API key — this is the API key of the processor named above, from that processor\'s own dashboard (for Stripe: Developers -> API keys). ' + API_HELP },
      { key: 'webhook_secret', label: 'Processor webhook signing secret', type: 'password', secret: true, help: 'From the same processor\'s Webhooks section. Signs processor webhooks to /webhooks/apple_pay. ' + API_HELP },
    ],
    defaultInstruction: '1. Enter the amount below and press Submit Deposit.\n2. Our team will confirm your Apple Pay payment with you directly — follow only the instructions our team gives for this request.\n3. Your balance is credited once our team confirms the payment arrived.',
    withdrawInstruction: '1. Enter the amount and press Submit, then confirm with your verification code if asked.\n2. This method has no built-in payout destination, so our team will contact you to arrange where to send your payout.\n3. The amount is held while our team reviews the request.\n4. We complete the payout outside this site and mark the request paid.',
    autoInstruction: '1. Enter the amount below and press Submit Deposit.\n2. Complete the payment with Apple Pay.\n3. Once the payment provider confirms your payment, your balance is credited automatically.',
    userFields: [],
    withdrawUserFields: [], webhook: true },
  { key: 'google_pay',
    prevDefaultInstructions: ['Google Pay deposits are reviewed manually: submit your request below and our team will confirm your payment. Your balance is credited once payment is confirmed.'], name: 'Google Pay', icon: '🅖',
    credentialFields: [
      { key: 'merchant_id', label: 'Google Pay merchant ID', type: 'text', required: true, help: 'Issued by Google Pay & Wallet Console. Public config, not a secret.' },
      { key: 'merchant_name', label: 'Merchant name', type: 'text', help: 'The name shown on the Google Pay sheet.' },
      { key: 'gateway', label: 'Gateway name', type: 'text', required: true, help: 'e.g. stripe, checkoutltd — the gateway that tokenises the payment.' },
      { key: 'gateway_merchant_id', label: 'Gateway merchant ID', type: 'text', help: 'Your merchant/account ID at the gateway above — for Stripe this is shown in the Stripe Dashboard under Settings -> Account.' },
      { key: 'environment', label: 'Environment', type: 'select', options: ['TEST', 'PRODUCTION'], help: 'TEST for test cards only; PRODUCTION charges real cards.' },
      { key: 'webhook_secret', label: 'Gateway webhook signing secret', type: 'password', secret: true, help: 'Google Pay itself has no webhook or signing secret — this is your GATEWAY\'s signing secret (the gateway named above), from its Webhooks section. Signs gateway webhooks to /webhooks/google_pay. ' + API_HELP },
    ],
    defaultInstruction: '1. Enter the amount below and press Submit Deposit.\n2. Our team will confirm your Google Pay payment with you directly — follow only the instructions our team gives for this request.\n3. Your balance is credited once our team confirms the payment arrived.',
    withdrawInstruction: '1. Enter the amount and press Submit, then confirm with your verification code if asked.\n2. This method has no built-in payout destination, so our team will contact you to arrange where to send your payout.\n3. The amount is held while our team reviews the request.\n4. We complete the payout outside this site and mark the request paid.',
    autoInstruction: '1. Enter the amount below and press Submit Deposit.\n2. Complete the payment with Google Pay.\n3. Once the payment provider confirms your payment, your balance is credited automatically.',
    userFields: [],
    withdrawUserFields: [], webhook: true },
  { key: 'samsung_pay',
    prevDefaultInstructions: ['Samsung Pay deposits are reviewed manually: submit your request below and our team will confirm your payment. Your balance is credited once payment is confirmed.'], name: 'Samsung Pay', icon: 'ⓢ',
    credentialFields: [
      { key: 'service_id', label: 'Service ID (your Samsung merchant ID)', type: 'text', required: true, help: 'Samsung\'s own docs: the Service ID IS your merchant ID ("serviceId = Merchant ID that is assigned after onboarding") — there is no second merchant ID to find. Issued in the Samsung Pay Developers portal when you create the service.' },
      { key: 'processor', label: 'Payment processor', type: 'text', help: 'The PSP that processes Samsung Pay for you (e.g. Stripe, Adyen), if any.' },
      { key: 'api_key', label: 'Processor API key', type: 'password', secret: true, help: 'Samsung Pay itself issues NO API key — this is the API key of the processor named above, from that processor\'s own dashboard. ' + API_HELP },
      { key: 'webhook_secret', label: 'Processor webhook signing secret', type: 'password', secret: true, help: 'Samsung Pay itself has no webhook signing secret — this is your processor\'s signing secret, from its Webhooks section. Signs processor webhooks to /webhooks/samsung_pay. ' + API_HELP },
    ],
    defaultInstruction: '1. Enter the amount below and press Submit Deposit.\n2. Our team will confirm your Samsung Pay payment with you directly — follow only the instructions our team gives for this request.\n3. Your balance is credited once our team confirms the payment arrived.',
    withdrawInstruction: '1. Enter the amount and press Submit, then confirm with your verification code if asked.\n2. This method has no built-in payout destination, so our team will contact you to arrange where to send your payout.\n3. The amount is held while our team reviews the request.\n4. We complete the payout outside this site and mark the request paid.',
    autoInstruction: '1. Enter the amount below and press Submit Deposit.\n2. Complete the payment with Samsung Pay.\n3. Once the payment provider confirms your payment, your balance is credited automatically.',
    userFields: [],
    withdrawUserFields: [], webhook: true },
  { key: 'bank_transfer',
    prevDefaultInstructions: ['Transfer to the bank account below and upload/enter your transfer reference.'], name: 'Bank Transfer', icon: '🏦',
    credentialFields: [
      { key: 'bank_name', label: 'Bank name', type: 'text', required: true },
      { key: 'account_name', label: 'Account holder name', type: 'text', required: true, help: 'Exactly as on the bank account (transfer forms also call this the beneficiary name) — a mismatch can bounce the transfer.' },
      { key: 'account_number', label: 'Account number (non-IBAN countries)', type: 'text', help: 'Your domestic account number. If your account has an IBAN, use the IBAN field below instead and leave this blank.' },
      { key: 'iban', label: 'IBAN', type: 'text', help: 'For IBAN countries: the full IBAN from your banking app -> account details (it already contains the bank and account — no separate routing code is needed with an IBAN).' },
      { key: 'swift', label: 'SWIFT / BIC code', type: 'text', help: 'For international transfers, e.g. CHASUS33. Found in your banking app -> account details / international transfer page.' },
      { key: 'routing_number', label: 'US routing number (ABA)', type: 'text', help: 'For US domestic transfers — the 9-digit ABA Routing Transit Number, on your cheques and in the app -> account details.' },
      { key: 'routing_code_local', label: 'Local routing code (sort code / IFSC / BSB)', type: 'text', help: 'Only if your country uses one with a domestic account number: UK sort code, India IFSC, Australia BSB. Leave blank for IBAN or US accounts.' },
    ],
    defaultInstruction: '1. Send the exact amount by bank transfer to the bank account shown below.\n2. After sending, copy the transfer reference from your bank receipt or banking app.\n3. Enter the reference (and the name on the sending account) in the boxes below and press Submit Deposit.\n4. Our team matches your reference with the payment received and credits your balance after approval. Bank transfers can take time to arrive — credit follows arrival, not sending.',
    withdrawInstruction: '1. Enter YOUR bank details below — account holder name exactly as on the account, account number/IBAN, and bank name. Double-check every digit: a payout sent to wrong details cannot be pulled back.\n2. Press Submit and confirm with your verification code if asked.\n3. The amount is held while our team reviews the request.\n4. We send the bank transfer outside this site and mark the request paid with the bank reference.',
    autoInstruction: '1. Send the exact amount by bank transfer to the bank account shown below, keeping your transfer reference.\n2. Enter the reference below and submit.\n3. Once the payment provider confirms your payment arrived, your balance is credited automatically.',
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
  { key: 'qr_pay',
    prevDefaultInstructions: ['Scan the QR code to pay, then enter your payment reference.'], name: 'QR Pay', icon: '🔳',
    credentialFields: [
      { key: 'provider', label: 'Network / scheme for this QR', type: 'text', required: true, help: 'e.g. PromptPay / Thai QR, DuitNow QR, QRIS, UPI QR. The player must scan with a compatible app.' },
      { key: 'payee_id', label: 'Payee ID inside the QR (PromptPay ID / account)', type: 'text', required: true, help: 'The actual receiving identifier the QR encodes — for PromptPay: your mobile number, citizen/tax ID, e-Wallet ID or bank account number. This is what a player can pay manually if the QR image fails; generate the matching QR in your banking app (My QR) from this same ID.' },
      { key: 'qr_image_url', label: 'QR code image URL', type: 'text', required: true, help: 'https URL of the QR image shown to players — the QR you generated in your banking app (My QR) or the placard from your bank, for the Payee ID above.' },
      { key: 'account_label', label: 'Recipient name (shown to payer on confirmation)', type: 'text', help: 'The merchant/payee name encoded in the QR — the payer sees this name on their confirmation screen before paying.' },
    ],
    defaultInstruction: '1. Open your wallet app and scan the QR code shown below.\n2. Pay the exact amount you enter below.\n3. After paying, copy the payment reference from the payment screen in your app.\n4. Enter the reference in the box below and press Submit Deposit.\n5. Our team matches it with the payment received and credits your balance after approval.',
    withdrawInstruction: '1. Enter YOUR wallet account / number for the same wallet/network as this method below — double-check it, a payout sent to a wrong account cannot be pulled back.\n2. Press Submit and confirm with your verification code if asked.\n3. The amount is held while our team reviews the request.\n4. We send the payout outside this site and mark the request paid.',
    autoInstruction: '1. Scan the QR code shown below with your wallet app and pay the exact amount.\n2. Enter the payment reference from your app below and submit.\n3. Once the payment provider confirms your payment, your balance is credited automatically.',
    userFields: [{ key: 'reference', label: 'Payment reference', type: 'text', required: true }],
    withdrawUserFields: [{ key: 'account_label', label: 'Your wallet account / number (on the same wallet/network as this method)', type: 'text', required: true }], webhook: false },
  { key: 'voucher',
    prevDefaultInstructions: ['Enter your voucher PIN code below.'], name: 'Vouchers', icon: '🎟️',
    credentialFields: [
      { key: 'issuer', label: 'Voucher issuer', type: 'text', required: true, help: 'The issuer/brand of the voucher stock you bought (players must buy THIS issuer\'s vouchers). There is no issuer API key in the manual flow — PINs are checked by hand against your stock.' },
    ],
    defaultInstruction: '1. Buy a voucher from the issuer shown below if you do not have one yet.\n2. Scratch/enter the voucher PIN in the box below exactly as printed.\n3. Press Submit Deposit.\n4. Our team checks the PIN and credits your balance after approval.',
    withdrawInstruction: '1. Enter the amount and press Submit, then confirm with your verification code if asked.\n2. This method has no built-in payout destination, so our team will contact you to arrange where to send your payout.\n3. The amount is held while our team reviews the request.\n4. We complete the payout outside this site and mark the request paid.',
    autoInstruction: '1. Enter your voucher PIN in the box below exactly as printed and submit.\n2. Once the issuer confirms the PIN, your balance is credited automatically.',
    userFields: [{ key: 'voucher_pin', label: 'Voucher PIN', type: 'text', required: true }],
    withdrawUserFields: [], webhook: false },
  { key: 'cash_agent',
    prevDefaultInstructions: ['Visit a cash agent location, hand over cash with your account reference, and enter the agent receipt code.'], name: 'Cash Agents', icon: '🤝',
    credentialFields: [
      { key: 'agent_network', label: 'Agent network name', type: 'text', required: true },
      { key: 'instructions', label: 'Agent instructions', type: 'textarea', help: 'Where/how the player pays an agent. Shown to the player.' },
    ],
    defaultInstruction: '1. Visit a cash agent of the network shown below.\n2. Hand over the cash and tell the agent your account email so the payment is booked to you.\n3. The agent gives you a receipt with a receipt code — keep it.\n4. Enter the agent location and the receipt code in the boxes below and press Submit Deposit.\n5. Our team confirms with the agent network and credits your balance after approval.',
    withdrawInstruction: '1. Enter the cash agent location where you want to collect your payout below.\n2. Press Submit and confirm with your verification code if asked.\n3. The amount is held while our team reviews the request.\n4. Collect your cash from that agent once we confirm the payout is ready — bring your ID and account email.',
    autoInstruction: '1. Visit a cash agent of the network shown below and hand over the cash with your account email.\n2. Enter the agent location and the receipt code the agent gives you below and submit.\n3. Once the agent network confirms your payment, your balance is credited automatically.',
    userFields: [
      { key: 'agent_location', label: 'Agent location', type: 'text', required: true },
      { key: 'receipt_code', label: 'Agent receipt code', type: 'text', required: true },
    ],
    withdrawUserFields: [
      { key: 'agent_location', label: 'Agent location for cash-out', type: 'text', required: true },
    ], webhook: false },
  { key: 'paypal',
    prevDefaultInstructions: ['Send your payment to the PayPal account below (Friends & Family is not required — send as Goods & Services if asked), then enter the PayPal transaction ID.'], name: 'PayPal', icon: '🅿',
    credentialFields: [
      { key: 'account_email', label: 'PayPal account email (receiving)', type: 'text', required: true, help: 'The email of YOUR PayPal account — players send PayPal payments to this email. This alone is enough for manual PayPal deposits.' },
      { key: 'account_name', label: 'Account name shown to sender', type: 'text', help: 'The name the player sees in PayPal when sending — lets them verify the account.' },
      { key: 'mode', label: 'Mode (Live / Sandbox)', type: 'select', options: ['live', 'sandbox'], help: 'Mirrors the two tabs in PayPal Developer (Sandbox tab = test money, Live tab = real money) — the credentials below must come from the SAME tab you pick here. API mode only.' },
      { key: 'client_id', label: 'Client ID', type: 'text', help: 'PayPal\'s own name for this value is Client ID (some PayPal guides loosely call the pair "API keys"). Found at: developer.paypal.com -> Log in to Dashboard -> Apps & Credentials -> Live tab -> your app -> Client ID. Do NOT enter the older Classic "API Username" here — that is a different, older credential this method does not use. ' + API_HELP },
      { key: 'client_secret', label: 'Secret (client secret)', type: 'password', secret: true, help: 'PayPal calls this simply "Secret" — it sits right under the Client ID on the same app page: developer.paypal.com -> Apps & Credentials -> Live tab -> your app -> Secret (press Show). Not the Classic "API Password" or "API Signature" — those belong to the old NVP/SOAP credentials and are not used here. Enter it only here — never send it to anyone. ' + API_HELP },
      { key: 'webhook_id', label: 'Webhook ID', type: 'text', help: 'Needed for Auto Pay only: PayPal signs its payment notifications and we verify them with PayPal using this ID. Found at: developer.paypal.com -> Apps & Credentials -> (same tab as above) -> your app -> Webhooks -> the webhook whose URL ends in /webhooks/paypal -> its "Webhook ID". Create that webhook subscribed to "Payment captures completed" (and "Payment captures refunded") if it does not exist yet. ' + API_HELP },
    ],
    defaultInstruction: '1. Sign in to YOUR PayPal and send the exact amount to the PayPal account email shown below (if PayPal asks, send as Goods & Services — Friends & Family is not required).\n2. After sending, open that payment in your PayPal Activity and copy its Transaction ID.\n3. Paste the Transaction ID in the box below (and the email you sent from, if different) and press Submit Deposit.\n4. Our team matches your Transaction ID with the payment in our PayPal account and credits your balance after approval.',
    withdrawInstruction: '1. Enter YOUR PayPal email below — double-check it, a payout sent to a wrong email cannot be pulled back.\n2. Press Submit and confirm with your verification code if asked.\n3. The amount is held while our team reviews the request.\n4. We send the PayPal payment outside this site and mark the request paid with the PayPal transaction ID.',
    autoInstruction: '1. Sign in to YOUR PayPal and send the exact amount to the PayPal account email shown below.\n2. Paste the Transaction ID from your PayPal Activity below and submit.\n3. Once PayPal confirms your payment, your balance is credited automatically.',
    userFields: [
      { key: 'paypal_txid', label: 'PayPal transaction ID', type: 'text', required: true },
      { key: 'sender_email', label: 'Email you sent from', type: 'text' },
    ],
    withdrawUserFields: [{ key: 'account_email', label: 'Your PayPal email', type: 'text', required: true }],
    // AUTO-INTEGRATION round: PayPal verification is NOT HMAC — it is
    // done by lib/paypal.js (OAuth2 + GET capture + PayPal's own
    // verify-webhook-signature API) on the dedicated /webhooks/paypal
    // route, which is registered BEFORE the generic HMAC route. This
    // rail's `webhook: true` therefore means "a real provider
    // confirmation path exists" (the METHOD-MODE-01 meaning), and
    // autoCapability() below requires Client ID + Secret + Webhook ID
    // before Auto can be saved. The generic HMAC verifier is never
    // used for PayPal.
    webhook: true },
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
  /* Skrill's Secret Word is the one documented exception to the
     8-char floor: Skrill lets merchants set a word of up to 10 chars
     with no 8-char minimum, so a shorter one is a REAL credential,
     not a truncated paste. */
  if ((f.secret || f.type === 'password') && v.length < 8 && f.key !== 'secret_word') return bad('looks too short — provider secrets are at least 8 characters. Check for a truncated paste.');
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
    case 'iban': {
      const c = v.replace(/[\s-]/g, '').toUpperCase();
      if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(c)) return bad('must be a valid IBAN (country code + 2 check digits + account part, e.g. GB29NWBK60161331926819).');
      break;
    }
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
  /* CREDENTIALS-REAL-01: bank accounts come in two shapes — an IBAN, or a
     domestic account number. Either satisfies the rail; neither is a
     method a player can pay. */
  if (railKey === 'bank_transfer' && !String(values.account_number || '').trim() && !String(values.iban || '').trim())
    return { ok: false, error: '"Account number" or "IBAN" is required for Bank Transfer — enter whichever your account uses.', field: 'account_number' };
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
  const ccHeader = req.headers['x-cc-webhook-signature'] || '';   // Coinbase Commerce
  const nowpHeader = req.headers['x-nowpayments-sig'] || '';      // NOWPayments IPN
  if (!header && !ccHeader && !nowpHeader) return { ok: false, reason: 'missing signature header' };
  // Candidate signatures: raw header, "sha256=<hex>" form, and Stripe-style
  // "t=<ts>,v1=<hex>" (signed payload "ts.rawBody").
  const candidates = [];
  const stripe = /v1=([0-9a-fA-F]+)/.exec(header);
  const ts = /t=(\d+)/.exec(header);
  // H3-07 (v23): a Stripe-style timestamped signature gets Stripe's own
  // replay rule — a correctly-signed capture older than 5 minutes is
  // refused, bounding the replay window (the HMAC must still match).
  if (stripe && ts) {
    const tSec = parseInt(ts[1], 10);
    if (!Number.isFinite(tSec) || Math.abs(Math.floor(Date.now() / 1000) - tSec) > 300)
      return { ok: false, reason: 'webhook timestamp outside the 5-minute tolerance' };
  }
  if (stripe && ts) candidates.push({ algo: 'sha256', payload: Buffer.concat([Buffer.from(ts[1] + '.'), raw]), sig: stripe[1] });
  const plain = header.replace(/^sha256=/, '').trim();
  if (plain) candidates.push({ algo: 'sha256', payload: raw, sig: plain });
  /* AUTO-INTEGRATION round: two more REAL provider schemes, both keyed
     HMACs over the same configured webhook_secret — accepting them can
     only match a signature made with the operator's own secret:
     - Coinbase Commerce sends the shared-secret HMAC-SHA256 of the raw
       body in its own header (docs.cdp.coinbase.com).
     - NOWPayments IPN signs with HMAC-SHA512 (header x-nowpayments-sig)
       over the JSON payload with keys sorted recursively
       (nowpayments.io IPN docs). Both the raw-body and the
       sorted-canonical payloads are tried. */
  if (ccHeader) candidates.push({ algo: 'sha256', payload: raw, sig: String(ccHeader).trim() });
  if (nowpHeader) {
    candidates.push({ algo: 'sha512', payload: raw, sig: String(nowpHeader).trim() });
    try {
      const sortDeep = (v) => Array.isArray(v) ? v.map(sortDeep)
        : (v && typeof v === 'object' ? Object.keys(v).sort().reduce((o, k) => (o[k] = sortDeep(v[k]), o), {}) : v);
      const canonical = JSON.stringify(sortDeep(JSON.parse(raw.toString('utf8'))));
      candidates.push({ algo: 'sha512', payload: Buffer.from(canonical), sig: String(nowpHeader).trim() });
    } catch { /* body not JSON: raw candidate already queued */ }
  }
  const crypto = require('crypto');
  for (const { id, secret } of secrets) {
    for (const c of candidates) {
      const expected = crypto.createHmac(c.algo, secret).update(c.payload).digest('hex');
      try {
        if (c.sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(c.sig, 'utf8'), Buffer.from(expected, 'utf8')))
          return { ok: true, provider: railKey, methodId: id };
      } catch (e) { /* length/encoding mismatch: not a match */ }
    }
  }
  return { ok: false, reason: 'signature mismatch' };
}

/* METHOD-MODE-01 + AUTO-INTEGRATION: what Auto Pay genuinely needs on
   this rail, given the credentials actually saved. Returns null when
   the rail has NO provider-confirmation path at all (Auto can never be
   honest there — plain bank transfer, voucher, cash agent, plain UPI
   ID, plain QR: no provider API exists to confirm a payment with).
   Otherwise returns the credential-field KEYS Auto requires:
   - every rail: its own `required` receiving fields (a method that
     cannot even receive manually cannot run automatically);
   - paypal: Client ID + Secret + Webhook ID (lib/paypal.js verifies);
   - ewallet + Skrill: Merchant ID + Secret Word (lib/skrill.js
     verifies the status report's md5sig — Skrill has no webhook
     secret, so requiring one would be a false gate);
   - every other webhook rail: the provider webhook signing secret. */
function autoRequiredKeys(rail, creds = {}) {
  if (!rail || !rail.webhook) return null;
  const keys = (rail.credentialFields || []).filter(f => f.required).map(f => f.key);
  const add = (k) => { if (!keys.includes(k)) keys.push(k); };
  if (rail.key === 'paypal') { add('client_id'); add('client_secret'); add('webhook_id'); }
  else if (rail.key === 'ewallet' && String(creds.provider || '') === 'Skrill') { add('merchant_id'); add('secret_word'); }
  else add('webhook_secret');
  return keys;
}
function autoCapability(rail, creds = {}) {
  const keys = autoRequiredKeys(rail, creds);
  if (!keys) return { canAuto: false, blocked: true, missing: [] };
  const missing = keys
    .filter(k => !String(creds[k] || '').trim())
    .map(k => { const f = fieldOf(rail, k); return f ? f.label : k; });
  return { canAuto: missing.length === 0, blocked: false, missing };
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
  mobile_money: ['provider', 'account_type', 'account_number', 'account_name'],
  ewallet: ['provider', 'account_email'],
  paypal: ['account_email', 'account_name'],
  bank_transfer: ['bank_name', 'account_name', 'account_number', 'iban', 'swift', 'routing_number', 'routing_code_local'],
  qr_pay: ['provider', 'payee_id', 'qr_image_url', 'account_label'],
  cash_agent: ['agent_network', 'instructions'],
  // MANUAL-PAYMENTS field audit: voucher had NO receiving fields, so
  // the player was never told WHICH issuer's voucher to buy — the
  // issuer is public pay-to information, not a secret.
  voucher: ['issuer'],
};
/* U-21: NON-SECRET gateway configuration a payment page legitimately
   needs client-side (Stripe publishable key, Google Pay gateway
   parameters, Apple merchant ID). Secret/password fields are never
   in this map; getPublicConfig also hard-skips them defensively.
   HOTFIX 2026-10-29 (owner-reported on live v21): 'paypal: client_id'
   REMOVED from this map and the deposit page no longer renders ANY
   gateway config at all. Rationale: in this product the PayPal
   Client ID is one half of the app's API credential pair, nothing
   client-side consumes it (no JS SDK checkout exists), and the
   owner's standing rule is that credential values stay admin-side.
   The U-21 "public by design" reasoning applied to SDK checkout
   pages that this product does not have. Do NOT re-add credential
   keys here; a future real client-side checkout must whitelist only
   values its own code actually consumes, with a leak test. */
const PUBLIC_CONFIG_FIELDS = {
  cards: ['provider', 'publishable_key'],
  apple_pay: ['merchant_id', 'processor'],
  google_pay: ['merchant_id', 'merchant_name', 'gateway', 'gateway_merchant_id', 'environment'],
  samsung_pay: ['service_id'],
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

module.exports = { RAILS, BLOCKED_RAILS, getRail, isBlockedRail, verifyWebhookSignature, RECEIVING_FIELDS, PUBLIC_CONFIG_FIELDS, getReceivingDetails, getPublicConfig, isSecretField, validateCredentialValue, validateRailCredentials, validateUserProof, autoRequiredKeys, autoCapability };
