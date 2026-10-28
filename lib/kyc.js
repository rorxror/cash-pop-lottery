'use strict';
/* BP-21 (v19): KYC state helpers. The system is a SWITCHABLE module:
   master setting kyc_enabled ships '0' (dormant). Two orthogonal knobs:
   WHO is required — users.kyc_override: 'required' forces it for that
   user even with the master switch off; 'exempt' never gates; 'default'
   follows the master switch. WHICH actions are gated — setting kyc_gate:
   'withdrawals' (default) or 'deposits_and_withdrawals'.
   Status vocabulary reuses the EXISTING users.kyc_status column:
   none / pending / verified / rejected (verified = approved). */
const { getS, getBool } = require('./settings');

const GATE_WITHDRAWALS = 'withdrawals';
const GATE_BOTH = 'deposits_and_withdrawals';

function kycOverrideOf(user) {
  const o = String((user && user.kyc_override) || 'default');
  return o === 'required' || o === 'exempt' ? o : 'default';
}
function kycStatusOf(user) {
  const s = String((user && user.kyc_status) || 'none');
  return s === 'pending' || s === 'verified' || s === 'rejected' ? s : 'none';
}
function kycGateCovers(s, action) {
  if (action === 'withdraw') return true; // both gate scopes cover withdrawals
  if (action === 'deposit') return getS(s, 'kyc_gate', GATE_WITHDRAWALS) === GATE_BOTH;
  return false;
}
/* Is this user required to be KYC-approved before `action`? */
function kycRequiredFor(s, user, action) {
  if (!user) return false;
  const o = kycOverrideOf(user);
  if (o === 'exempt') return false;
  if (!kycGateCovers(s, action)) return false;
  if (o === 'required') return true;
  return getBool(s, 'kyc_enabled');
}
function kycApproved(user) { return kycStatusOf(user) === 'verified'; }
function kycBlock(s, user, action) {
  const required = kycRequiredFor(s, user, action);
  return { required, blocked: required && !kycApproved(user), status: kycStatusOf(user) };
}
const KYC_MESSAGES = {
  withdraw: 'KYC approval is required before withdrawals. Please submit your identity document on the KYC page.',
  deposit: 'KYC approval is required before deposits. Please submit your identity document on the KYC page.',
};
const DOC_TYPES = ['national_id', 'passport', 'driving_licence'];
const DOC_TYPE_LABELS = { national_id: 'National ID card', passport: 'Passport', driving_licence: 'Driving licence' };
const STATUS_LABELS = {
  none: 'Not submitted', pending: 'Pending review', verified: 'Approved', rejected: 'Rejected',
};

module.exports = { kycOverrideOf, kycStatusOf, kycGateCovers, kycRequiredFor, kycApproved, kycBlock, KYC_MESSAGES, DOC_TYPES, DOC_TYPE_LABELS, STATUS_LABELS };
