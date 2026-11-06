// @ts-check
'use strict';

/**
 * @typedef {{ ok: true, value: any } | { ok: false, error: Error }} Settled
 */

/**
 * Run `fn` over `items` with at most `limit` calls in flight at a time.
 * Resolves with a per-item Settled outcome in input order. Per-item errors
 * are captured so callers can log + count failures without aborting peers.
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} fn
 * @param {number} limit
 * @returns {Promise<Settled[]>}
 */
async function mapWithConcurrency(items, fn, limit) {
  const results = new Array(items.length);
  if (items.length === 0) return results;
  const cap = Math.max(1, Math.min(limit | 0, items.length));
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        const value = await fn(items[i], i);
        results[i] = { ok: true, value };
      } catch (error) {
        results[i] = { ok: false, error };
      }
    }
  }

  await Promise.all(Array.from({ length: cap }, () => worker()));
  return results;
}

module.exports = { mapWithConcurrency };
