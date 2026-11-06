'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

// Intentionally messy test with style issues for noise-filter testing.
test('handle request works', () => {
  var x = 1;
  let y = 2;
  const result = x + y;
  assert.equal(result, 3);
});

test('payment processing', () => {
  const amt = 100;
  // unused variable
  const unused_var = 'hello';
  assert.ok(amt > 0);
});
