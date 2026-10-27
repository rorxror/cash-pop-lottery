'use strict';
/* v16 regression tests: fixes from the independent audit round.
   Run: node --test test/v16-fixes.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const { toMinor, signTicket, parseAmountList } = require('../lib/util');
const { checkCsrf } = require('../lib/auth');

test('toMinor rejects unsafe integers instead of silently rounding', () => {
  assert.strictEqual(toMinor('12.50'), 1250);
  assert.strictEqual(toMinor('1000000.00'), 100000000);
  assert.strictEqual(toMinor('99999999999999999'), null); // far past 2^53 minor units
  assert.strictEqual(toMinor('90071992547410.00'), null); // *100 passes MAX_SAFE_INTEGER
  assert.strictEqual(toMinor('12.5'), 1250);
  assert.strictEqual(toMinor('abc'), null);
});

test('checkCsrf: wrong-length token fails closed (no throw)', () => {
  const req = { body: { _csrf: 'short' }, headers: {}, sessionData: { _csrf: 'a-much-longer-stored-token-value' } };
  assert.strictEqual(checkCsrf(req), false); // pre-v16 this threw RangeError
  const okReq = { body: { _csrf: 'token123' }, headers: {}, sessionData: { _csrf: 'token123' } };
  assert.strictEqual(checkCsrf(okReq), true);
  const missing = { body: {}, headers: {}, sessionData: {} };
  assert.strictEqual(checkCsrf(missing), false);
});

test('signTicket: deterministic and sensitive to every field', () => {
  const t = { public_id: 'T1', user_id: 7, pops: '[1,5]', wager: 100, draw_ids: '[3]', total: 200, currency: 'USD' };
  const a = signTicket('secret', t);
  assert.strictEqual(a, signTicket('secret', t));
  assert.notStrictEqual(a, signTicket('secret', { ...t, wager: 101 }));
  assert.notStrictEqual(a, signTicket('secret', { ...t, pops: '[1,6]' }));
  assert.notStrictEqual(a, signTicket('secret', { ...t, total: 201 }));
  assert.notStrictEqual(a, signTicket('other', t));
});

test('wager options: setting is MAJOR dollars, parsed to minor at request time', () => {
  // server.js: req.wagerOptions = parseAmountList(setting, [100,200,500,1000]).
  // parseAmountList runs each value through toMinor, so the stored setting
  // MUST stay in major dollars. A draft v9 migration briefly rewrote it to
  // minor units (100,200,500,1000) which would have priced wagers at $100+;
  // v10 restored it. This test locks the correct contract in place.
  assert.deepStrictEqual(parseAmountList('1,2,5,10', [100, 200, 500, 1000]), [100, 200, 500, 1000]);
  assert.strictEqual(parseAmountList('1,2,5,10', []).includes(100), true);
  // The minor form as a SETTING would be parsed to $100 wagers — never store it.
  assert.deepStrictEqual(parseAmountList('100,200,500,1000', []), [10000, 20000, 50000, 100000]);
});
