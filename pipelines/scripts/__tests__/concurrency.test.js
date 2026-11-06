'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mapWithConcurrency } = require('../lib/concurrency.js');

test('mapWithConcurrency: preserves input order in result array', async () => {
  const result = await mapWithConcurrency(
    [1, 2, 3, 4, 5],
    async (n) => n * 10,
    2,
  );
  assert.deepEqual(result, [
    { ok: true, value: 10 }, { ok: true, value: 20 }, { ok: true, value: 30 },
    { ok: true, value: 40 }, { ok: true, value: 50 },
  ]);
});

test('mapWithConcurrency: caps in-flight to limit', async () => {
  let inFlight = 0;
  let maxObserved = 0;
  const fn = async (n) => {
    inFlight++;
    maxObserved = Math.max(maxObserved, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n;
  };
  await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], fn, 3);
  assert.equal(maxObserved, 3);
});

test('mapWithConcurrency: collects per-item errors without aborting peers', async () => {
  const fn = async (n) => {
    if (n === 3) throw new Error('boom');
    return n;
  };
  const result = await mapWithConcurrency([1, 2, 3, 4], fn, 2);
  assert.deepEqual(result[0], { ok: true, value: 1 });
  assert.deepEqual(result[1], { ok: true, value: 2 });
  assert.equal(result[2].ok, false);
  assert.equal(result[2].error.message, 'boom');
  assert.deepEqual(result[3], { ok: true, value: 4 });
});

test('mapWithConcurrency: empty input → empty output', async () => {
  const result = await mapWithConcurrency([], async (n) => n, 4);
  assert.deepEqual(result, []);
});

test('mapWithConcurrency: limit larger than input is safe', async () => {
  const result = await mapWithConcurrency([1, 2], async (n) => n + 1, 10);
  assert.deepEqual(result, [{ ok: true, value: 2 }, { ok: true, value: 3 }]);
});
