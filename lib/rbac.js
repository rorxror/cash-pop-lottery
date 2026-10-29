'use strict';
/* Staff RBAC (v14): action-level permissions for admin roles.
   Views (GET) are readable by all staff roles — the control is on ACTIONS,
   where money and safety live. role 'super' (and legacy ''/null, which
   pre-v14 admins carry) is unrestricted. The stealth middleware runs BEFORE
   this, so outsiders never reach a 403: they get the plain 404 first.
   Unmatched POST actions default to super-only (fail closed). */
const MONEY = ['super', 'finance'];
const SAFETY = ['super', 'risk'];
const SUPPORT = ['super', 'support'];
const SUPER = ['super'];

const RULES = [
  ['POST', /^\/deposits\/\d+\/(approve|reject|revoke|note)$/, MONEY],
  ['POST', /^\/withdrawals\/\d+\/(approve|reject|revoke|note|mark-paid)$/, MONEY],
  ['POST', /^\/approvals\/\d+\/(approve|reject)$/, ['super', 'finance', 'risk']], // DS-069: draw.* approvals are the risk desk's job; handler enforces the money/draw domain split
  ['POST', /^\/methods(\/.*)?$/, MONEY],
  ['POST', /^\/agents$/, SUPER],
  ['POST', /^\/agents\/\d+\/(fund|settle-commissions)$/, MONEY],
  ['POST', /^\/users\/\d+\/adjust$/, MONEY],
  ['POST', /^\/users\/\d+\/(block|matrix|revoke-sessions|reset-password|set-password|login-as|verify-contact|kyc-verify)$/, SAFETY],
  ['POST', /^\/users\/\d+$/, SAFETY],
  ['POST', /^\/support\/.+$/, SUPPORT],
  ['POST', /^\/kyc\/.+$/, MONEY], // BP-21: KYC approve/reject/manual-verify are money-desk decisions
  ['POST', /^\/contact-messages\/.+$/, SUPPORT],
  ['POST', /^\/draws\/.+$/, SAFETY],
  ['POST', /^\/settings\/.+$/, SUPER],
  ['POST', /^\/automation(\/.*)?$/, SUPER],
  ['POST', /^\/bonuses(\/.*)?$/, MONEY],
  ['POST', /^\/pages\/.+$/, SUPER],
  ['POST', /^\/content\/.+$/, SUPER],
  ['POST', /^\/extensions\/.+$/, SUPER],
  ['POST', /^\/notifications\/.+$/, ['super', 'support']],
  ['POST', /^\/otp(\/.*)?$/, SUPER],
  ['POST', /^\/cron\/.+$/, SUPER],
  ['POST', /^\/staff(\/.*)?$/, SUPER],
  ['POST', /^\/reconciliation\/.+$/, MONEY],
  ['POST', /^\/flags\/.+$/, SAFETY],
  // Self-service: any staff member may enroll/manage their OWN authenticator.
  ['POST', /^\/security\/totp\/.+$/, ['super', 'finance', 'support', 'risk']],
  // AUTH-CHANNELS-01: channel test sends (spend tiny provider amounts).
  ['POST', /^\/security\/test-(email|sms)$/, ['super', 'support']],
  // ADMIN-SELF-01: the My Account page only ever touches req.user.id,
  // so every staff role may use it for their OWN account.
  ['POST', /^\/my-account(\/.*)?$/, ['super', 'finance', 'support', 'risk']],
];

function normalizeRole(user) {
  const r = user && (user.admin_role || '');
  if (!r || r === 'super') return 'super';
  return r;
}

function canAccess(user, method, path) {
  const role = normalizeRole(user);
  if (role === 'super') return true;
  if (method === 'GET') return true; // views are read-only for all staff
  for (const [m, re, roles] of RULES) {
    if (m === method && re.test(path)) return roles.includes(role);
  }
  return false; // unmatched POST: fail closed
}

function rbacMiddleware(req, res, next) {
  if (!canAccess(req.user, req.method, req.path)) {
    return res.status(403).render('error', { status: 403, message: 'Your staff role does not permit this action.' });
  }
  next();
}

module.exports = { canAccess, normalizeRole, rbacMiddleware, ROLES: ['super', 'finance', 'support', 'risk'] };
