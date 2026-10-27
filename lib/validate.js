'use strict';
/* Central input validation (v14). Money and admin handlers validate through
   here instead of ad-hoc checks, so invalid input fails the same way
   everywhere instead of reaching SQL with a surprising type. */
const { toMinor, validEmail } = require('./util');

function intInRange(v, min, max, fallback = null) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}
function moneyMinor(v) { return toMinor(v); } // null on invalid
function safeText(v, max = 2000) { return String(v || '').trim().slice(0, max); }
function enumVal(v, allowed, fallback = '') {
  return allowed.includes(String(v)) ? String(v) : fallback;
}
/* Password minimums by role (v14): players 8 (standing rule), agents 10,
   admins 12. Strong-composition rules apply when secure_password is on. */
function passwordMinFor(role) {
  if (role === 'admin') return 12;
  if (role === 'agent') return 10;
  return 8;
}
function passwordError(pw, role, secureEnabled) {
  const min = passwordMinFor(role);
  if (String(pw || '').length < min) return `Password must be at least ${min} characters.`;
  if (secureEnabled) {
    if (!/[A-Z]/.test(pw) || !/[a-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password needs upper, lower case and a number.';
  }
  return null;
}

module.exports = { intInRange, moneyMinor, safeText, enumVal, passwordMinFor, passwordError, validEmail };
