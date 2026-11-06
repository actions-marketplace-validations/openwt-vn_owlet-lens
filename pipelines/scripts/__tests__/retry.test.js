// @ts-check
'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { withRetry, isRetryable, backoffMs, requestRetry } = require('../lib/retry.js');
const { RateLimitError, ProviderError, ConfigError, AuthError } = require('../lib/errors.js');

/** A `sleep` stand-in that records each wait instead of waiting. */
function recorder() {
  /** @type {number[]} */
  const waits = [];
  return { waits, sleep: async (/** @type {number} */ ms) => { waits.push(ms); } };
}

const http503 = () => new ProviderError('unavailable', { provider: 'test', status: 503, retryable: true });

/** A fetch failure whose root cause carries a socket error code. */
const netError = (/** @type {string} */ code) =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });

/** Silence and capture stderr for one test (restored when the test ends). */
function captureStderr(/** @type {any} */ t) {
  /** @type {string[]} */
  const lines = [];
  t.mock.method(process.stderr, 'write', (/** @type {any} */ line) => { lines.push(String(line)); return true; });
  return lines;
}

describe('isRetryable', () => {
  it('returns true for RateLimitError', () => {
    const err = new RateLimitError('rate limited', { provider: 'github', status: 429 });
    assert.equal(isRetryable(err), true);
  });

  it('returns true for retryable ProviderError', () => {
    const err = new ProviderError('server error', { provider: 'github', status: 503, retryable: true });
    assert.equal(isRetryable(err), true);
  });

  it('returns false for non-retryable ProviderError', () => {
    const err = new ProviderError('bad request', { provider: 'github', status: 400, retryable: false });
    assert.equal(isRetryable(err), false);
  });

  it('returns true for status 429', () => {
    assert.equal(isRetryable({ status: 429 }), true);
  });

  it('returns true for status 529', () => {
    assert.equal(isRetryable({ status: 529 }), true);
  });

  it('returns true for status 503 (5xx)', () => {
    assert.equal(isRetryable({ status: 503 }), true);
  });

  it('returns true for fetch transport failures', () => {
    assert.equal(isRetryable(new TypeError('fetch failed')), true);
  });

  it('returns false for status 400', () => {
    assert.equal(isRetryable({ status: 400 }), false);
  });

  it('returns false for status 401', () => {
    assert.equal(isRetryable({ status: 401 }), false);
  });

  it('returns false for status 404', () => {
    assert.equal(isRetryable({ status: 404 }), false);
  });

  it('returns false for ConfigError', () => {
    const err = new ConfigError('bad config');
    assert.equal(isRetryable(err), false);
  });

  it('returns false for AuthError', () => {
    const err = new AuthError('unauthorized', { provider: 'github', status: 401 });
    assert.equal(isRetryable(err), false);
  });
});

describe('backoffMs', () => {
  it('returns 1000 for attempt 0', () => {
    assert.equal(backoffMs(0), 1000);
  });

  it('returns 4000 for attempt 1', () => {
    assert.equal(backoffMs(1), 4000);
  });

  it('returns 16000 for attempt 2', () => {
    assert.equal(backoffMs(2), 16000);
  });

  it('caps at 60000', () => {
    assert.equal(backoffMs(10), 60_000);
  });
});

describe('withRetry', () => {
  it('returns success on first try', async () => {
    const result = await withRetry(async () => 42);
    assert.equal(result, 42);
  });

  it('retries on RateLimitError up to maxAttempts then rethrows', async () => {
    let calls = 0;
    const err = new RateLimitError('rate limited', { provider: 'test', status: 429, retryAfterMs: 1 });
    await assert.rejects(
      () => withRetry(async () => {
        calls++;
        throw err;
      }, { maxAttempts: 3 }),
      (thrown) => thrown === err,
    );
    assert.equal(calls, 3);
  });

  it('does NOT retry on non-retryable ConfigError', async () => {
    let calls = 0;
    const err = new ConfigError('bad config');
    await assert.rejects(
      () => withRetry(async () => {
        calls++;
        throw err;
      }, { maxAttempts: 3 }),
      (thrown) => thrown === err,
    );
    assert.equal(calls, 1, 'should not retry non-retryable errors');
  });

  it('does NOT retry on AuthError', async () => {
    let calls = 0;
    const err = new AuthError('unauthorized', { provider: 'github', status: 401 });
    await assert.rejects(
      () => withRetry(async () => {
        calls++;
        throw err;
      }, { maxAttempts: 3 }),
      (thrown) => thrown === err,
    );
    assert.equal(calls, 1, 'AuthError is not retryable');
  });

  it('honors retryAfterMs from RateLimitError', async (t) => {
    captureStderr(t);
    const { waits, sleep } = recorder();
    let calls = 0;
    const err = new RateLimitError('rate limited', { provider: 'test', status: 429, retryAfterMs: 50 });
    await assert.rejects(() => withRetry(async () => { calls++; throw err; }, { maxAttempts: 2, sleep }));
    assert.equal(calls, 2);
    assert.deepEqual(waits, [50]);
  });

  it('succeeds after transient failure', async () => {
    let calls = 0;
    const err = new RateLimitError('rate limited', { provider: 'test', status: 429, retryAfterMs: 1 });
    const result = await withRetry(async () => {
      calls++;
      if (calls < 2) throw err;
      return 'ok';
    }, { maxAttempts: 3 });
    assert.equal(result, 'ok');
    assert.equal(calls, 2);
  });

  it('backs off 1s, 4s, 16s and 60s over five attempts, then rethrows', async (t) => {
    captureStderr(t);
    const { waits, sleep } = recorder();
    let calls = 0;
    const err = http503();
    await assert.rejects(() => withRetry(async () => { calls++; throw err; }, { sleep }), (e) => e === err);
    assert.equal(calls, 5);
    assert.deepEqual(waits, [1000, 4000, 16000, 60000]);
  });

  it('throws at once when the server asks to wait longer than 60s', async (t) => {
    captureStderr(t);
    const { waits, sleep } = recorder();
    let calls = 0;
    const err = new RateLimitError('rate limited', { provider: 'test', status: 429, retryAfterMs: 60_001 });
    await assert.rejects(() => withRetry(async () => { calls++; throw err; }, { sleep }), (e) => e === err);
    assert.equal(calls, 1);
    assert.deepEqual(waits, []);
  });

  it('waits exactly 60s when asked to', async (t) => {
    captureStderr(t);
    const { waits, sleep } = recorder();
    const err = new RateLimitError('rate limited', { provider: 'test', status: 429, retryAfterMs: 60_000 });
    await assert.rejects(() => withRetry(async () => { throw err; }, { maxAttempts: 2, sleep }));
    assert.deepEqual(waits, [60_000]);
  });

  it('logs one warn line per retry with the attempt that failed, the wait and the error', async (t) => {
    const lines = captureStderr(t);
    const { sleep } = recorder();
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) throw http503();
      return 'ok';
    }, { label: 'GET /2.0/repositories/acme/widgets/pullrequests/7', sleep });
    assert.equal(result, 'ok');
    const base = { level: 'warn', msg: 'retry', label: 'GET /2.0/repositories/acme/widgets/pullrequests/7', errName: 'ProviderError', errStatus: 503 };
    assert.deepEqual(lines.map((l) => JSON.parse(l)), [
      { ...base, attempt: 1, waitMs: 1000 },
      { ...base, attempt: 2, waitMs: 4000 },
    ]);
  });

  it('redacts secrets from the logged label', async (t) => {
    const lines = captureStderr(t);
    const { sleep } = recorder();
    const token = 'sk-ant-api03-' + 'A'.repeat(40);
    await assert.rejects(() => withRetry(async () => { throw http503(); }, { label: `POST /v1/${token}`, maxAttempts: 2, sleep }));
    assert.equal(lines.length, 1);
    assert.ok(!lines[0].includes(token), lines[0]);
    assert.equal(JSON.parse(lines[0]).label, 'POST /v1/[REDACTED]');
  });

  it('logs nothing when the call is not retried', async (t) => {
    const lines = captureStderr(t);
    await assert.rejects(() => withRetry(async () => { throw new AuthError('no', { provider: 'test', status: 401 }); }));
    assert.deepEqual(lines, []);
  });
});

describe('withRetry: creates (repeatable: false)', () => {
  it('does not repeat a create after a 5xx: the server may have applied it', async () => {
    let calls = 0;
    await assert.rejects(() => withRetry(async () => { calls++; throw http503(); }, { repeatable: false, sleep: recorder().sleep }));
    assert.equal(calls, 1);
  });

  for (const code of ['ECONNRESET', 'UND_ERR_HEADERS_TIMEOUT', 'ETIMEDOUT']) {
    it(`does not repeat a create after ${code}: the request may have reached the server`, async () => {
      let calls = 0;
      await assert.rejects(() => withRetry(async () => { calls++; throw netError(code); }, { repeatable: false, sleep: recorder().sleep }));
      assert.equal(calls, 1);
    });
  }

  it('does not repeat a create after a timeout abort', async () => {
    let calls = 0;
    const err = new DOMException('The operation timed out.', 'TimeoutError');
    await assert.rejects(() => withRetry(async () => { calls++; throw err; }, { repeatable: false, sleep: recorder().sleep }));
    assert.equal(calls, 1);
  });

  it('repeats a create after a RateLimitError: the server refused it', async (t) => {
    captureStderr(t);
    let calls = 0;
    const err = new RateLimitError('rate limited', { provider: 'test', status: 429 });
    await assert.rejects(() => withRetry(async () => { calls++; throw err; }, { repeatable: false, sleep: recorder().sleep }));
    assert.equal(calls, 5);
  });

  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']) {
    it(`repeats a create after ${code}: the connection never opened`, async (t) => {
      captureStderr(t);
      let calls = 0;
      const result = await withRetry(async () => {
        calls++;
        if (calls === 1) throw netError(code);
        return 'created';
      }, { repeatable: false, sleep: recorder().sleep });
      assert.equal(result, 'created');
      assert.equal(calls, 2);
    });
  }

  it("finds the socket code through a typed error's cause chain", async (t) => {
    captureStderr(t);
    let calls = 0;
    const typed = Object.assign(
      new ProviderError('GitHub POST failed: 500', { provider: 'github', status: 500, retryable: true }),
      { cause: netError('ENOTFOUND') },
    );
    await assert.rejects(() => withRetry(async () => { calls++; throw typed; }, { repeatable: false, sleep: recorder().sleep }));
    assert.equal(calls, 5);
  });
});

describe('requestRetry', () => {
  it('labels a request with its method and URL path, without host or query', () => {
    const r = requestRetry('GET', 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/7?fields=values.id&page=2');
    assert.equal(r.label, 'GET /2.0/repositories/acme/widgets/pullrequests/7');
  });

  it('repeats GET, PUT, PATCH and DELETE, and a POST only when it opts in as idempotent', () => {
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(requestRetry(method, 'https://host/x').repeatable, true, method);
    }
    assert.equal(requestRetry('POST', 'https://host/x').repeatable, false);
    assert.equal(requestRetry('post', 'https://host/x').repeatable, false);
    assert.equal(requestRetry('POST', 'https://host/x', { idempotent: true }).repeatable, true);
  });

  it('passes the sleep seam through', () => {
    const sleep = async () => {};
    assert.equal(requestRetry('GET', 'https://host/x', { sleep }).sleep, sleep);
  });
});
