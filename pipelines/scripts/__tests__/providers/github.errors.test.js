'use strict';

// #69: Octokit errors become the pipeline's typed errors (ADR-0012).

const test = require('node:test');
const assert = require('node:assert/strict');
const { GitHubReviewProvider, __test__: { toTypedError } } = require('../../lib/providers/github.js');
const { AuthError, ProviderError, RateLimitError } = require('../../lib/errors.js');
const { describeError } = require('../../lib/run-lifecycle.js');

const URL_ = 'https://api.github.com/repos/acme/widgets/pulls/7';

/** An Octokit RequestError as the hook sees it (name "HttpError"). */
function httpErr(status, { message = 'boom', headers = {}, url = URL_ } = {}) {
  return Object.assign(new Error(message), {
    name: 'HttpError', status, request: { method: 'GET', url }, response: { headers, data: {} },
  });
}

/** @param {Error} e */
const isPlainProviderError = (e) =>
  e instanceof ProviderError && !(e instanceof AuthError) && !(e instanceof RateLimitError);

test('toTypedError: 401 -> AuthError with the shared message shape', () => {
  const e = toTypedError(httpErr(401, { message: 'Bad credentials' }));
  assert.ok(e instanceof AuthError);
  assert.equal(e.status, 401);
  assert.equal(e.message, `GitHub GET ${URL_} failed: 401 Bad credentials`);
});

test('toTypedError: 403 without rate-limit signals -> AuthError, status and message kept', () => {
  const e = toTypedError(httpErr(403, {
    message: 'Resource not accessible by integration', headers: { 'x-ratelimit-remaining': '4999' },
  }));
  assert.ok(e instanceof AuthError);
  assert.equal(e.status, 403);
  // github-write.js _isScopeError soft-skips on status 403 + this substring.
  assert.match(e.message, /Resource not accessible by integration/);
});

test('toTypedError: 403 primary rate limit (x-ratelimit-remaining 0) -> RateLimitError waiting for x-ratelimit-reset', () => {
  const reset = String(Math.floor(Date.now() / 1000) + 30);
  const e = toTypedError(httpErr(403, {
    message: 'API rate limit exceeded', headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
  }));
  assert.ok(e instanceof RateLimitError);
  assert.equal(e.status, 403);
  assert.ok(e.retryAfterMs > 28_000 && e.retryAfterMs <= 30_000, `retryAfterMs=${e.retryAfterMs}`);
});

test('toTypedError: a reset already past falls back to plain backoff', () => {
  const e = toTypedError(httpErr(429, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1' } }));
  assert.ok(e instanceof RateLimitError);
  assert.equal(e.retryAfterMs, undefined);
});

test('toTypedError: 403 with retry-after -> RateLimitError honouring it', () => {
  const e = toTypedError(httpErr(403, { headers: { 'retry-after': '60' } }));
  assert.ok(e instanceof RateLimitError);
  assert.equal(e.retryAfterMs, 60_000);
});

test('toTypedError: 403 secondary rate limit message -> RateLimitError', () => {
  const e = toTypedError(httpErr(403, {
    message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
  }));
  assert.ok(e instanceof RateLimitError);
  assert.equal(e.retryAfterMs, 60_000); // GitHub: "wait for at least one minute"
});

test('toTypedError: 429 -> RateLimitError honouring retry-after', () => {
  const e = toTypedError(httpErr(429, { headers: { 'retry-after': '7' } }));
  assert.ok(e instanceof RateLimitError);
  assert.equal(e.status, 429);
  assert.equal(e.retryAfterMs, 7000);
  assert.equal(toTypedError(httpErr(429)).retryAfterMs, 60_000);
});

test('toTypedError: 5xx and network failures (Octokit status 500, no response) -> retryable ProviderError', () => {
  const network = Object.assign(new Error('read ECONNRESET'), {
    name: 'HttpError', status: 500, request: { method: 'GET', url: URL_ },
  });
  for (const raw of [httpErr(502), network]) {
    const e = toTypedError(raw);
    assert.ok(isPlainProviderError(e));
    assert.equal(e.retryable, true);
  }
});

test('toTypedError: keeps the network cause, so a create can tell the request never left', () => {
  const cause = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  const raw = Object.assign(new Error('connect ECONNREFUSED'), {
    name: 'HttpError', status: 500, request: { method: 'POST', url: URL_ }, cause,
  });
  assert.equal(toTypedError(raw).cause, cause);
});

test('toTypedError: other 4xx -> terminal ProviderError, status kept for the 404/422 checks', () => {
  for (const status of [404, 422]) {
    const e = toTypedError(httpErr(status));
    assert.ok(isPlainProviderError(e));
    assert.equal(e.status, status);
    assert.equal(e.retryable, false);
  }
});

test('toTypedError: non-HTTP errors pass through unchanged', () => {
  const e = new TypeError('x is not a function');
  assert.equal(toTypedError(e), e);
});

test('toTypedError: URL loses its query string and the message is redacted', () => {
  const e = toTypedError(httpErr(404, { url: `${URL_}?page=2&key=abc123`, message: 'echoed Bearer abc.def' }));
  assert.equal(e.message, `GitHub GET ${URL_} failed: 404 echoed Bearer [REDACTED]`);
});

// Wiring: the real Octokit clients, driven through deps.fetch.

const ENV = { GITHUB_TOKEN: 'dummy-token', GITHUB_REPOSITORY: 'acme/widgets', GITHUB_PR_NUMBER: '7' };
const PR = {
  number: 7, title: 't', html_url: 'https://github.com/acme/widgets/pull/7', user: { login: 'dev' },
  head: { ref: 'feature', sha: 'h1' }, base: { ref: 'main', sha: 'b1' },
};

/**
 * @param {(url: string) => [number, unknown, Record<string, string>?]} route
 * @param {Array<{ url: string, authorization?: string }>} [seen]
 */
function stubFetch(route, seen = []) {
  return async (url, init) => {
    seen.push({ url: String(url), authorization: init?.headers?.authorization });
    const [status, body, headers = {}] = route(String(url));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
}

const badCredentials = () => [401, { message: 'Bad credentials' }];

test('wiring: REST 401 -> AuthError, exit code 3, and Octokit writes nothing to stderr', async (t) => {
  const stderr = t.mock.method(process.stderr, 'write', () => true);
  const p = new GitHubReviewProvider({ config: {}, env: ENV, deps: { fetch: stubFetch(badCredentials) } });
  const e = await p.getPRMetadata().catch((x) => x);
  const writes = stderr.mock.callCount();
  stderr.mock.restore();
  assert.ok(e instanceof AuthError, `got ${e?.name}`);
  assert.deepEqual(describeError(e), { code: 3, label: 'auth error' });
  assert.equal(writes, 0);
});

test('wiring: GraphQL 401 -> AuthError (GraphQL goes through the same hook)', async () => {
  const seen = [];
  const route = (url) => (url.endsWith('/graphql') ? badCredentials() : [200, []]);
  const p = new GitHubReviewProvider({ config: {}, env: ENV, deps: { fetch: stubFetch(route, seen) } });
  const e = await p.listThreads().catch((x) => x);
  assert.ok(e instanceof AuthError, `got ${e?.name}`);
  assert.ok(seen.some((r) => r.url.endsWith('/graphql')));
});

test('wiring: the resolve-token client maps errors too', async () => {
  const seen = [];
  const env = { ...ENV, AI_REVIEW_RESOLVE_TOKEN: 'resolve-token' };
  const p = new GitHubReviewProvider({ config: {}, env, deps: { fetch: stubFetch(badCredentials, seen) } });
  const e = await p.graphqlForResolve('mutation { noop }').catch((x) => x);
  assert.ok(e instanceof AuthError, `got ${e?.name}`);
  assert.equal(seen[0].authorization, 'token resolve-token');
});

test('wiring: an Octokit warning becomes one structured JSON line on stderr', async (t) => {
  const lines = [];
  const stderr = t.mock.method(process.stderr, 'write', (s) => { lines.push(String(s)); return true; });
  const deprecated = () => [200, PR, { deprecation: 'true', sunset: 'Wed, 01 Jan 2031 00:00:00 GMT' }];
  const p = new GitHubReviewProvider({ config: {}, env: ENV, deps: { fetch: stubFetch(deprecated) } });
  await p.getPRMetadata();
  stderr.mock.restore();
  assert.equal(lines.length, 1);
  const line = JSON.parse(lines[0]);
  assert.equal(line.level, 'warn');
  assert.equal(line.msg, 'octokit warning');
  assert.match(line.detail, /is deprecated/);
});

// Per-request retry (ADR-0013), through the real Octokit hook.

const noSleep = async () => {};
const badGateway = () => [502, { message: 'bad gateway' }];

/** @param {Parameters<typeof stubFetch>[0]} route @param {any[]} seen */
const retrying = (route, seen) =>
  new GitHubReviewProvider({ config: {}, env: ENV, deps: { fetch: stubFetch(route, seen), sleep: noSleep } });

test('wiring: a REST GET is retried after a 5xx', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const seen = [];
  const p = retrying(() => (seen.length === 1 ? badGateway() : [200, PR]), seen);
  assert.equal((await p.getPRMetadata()).id, '7');
  assert.equal(seen.length, 2);
});

test('wiring: a REST POST is not retried after a 5xx: GitHub may have applied it', async () => {
  const seen = [];
  const p = retrying(badGateway, seen);
  const post = () => p.rest.issues.createComment({ owner: 'acme', repo: 'widgets', issue_number: 7, body: 'x' });
  await assert.rejects(post, ProviderError);
  assert.equal(seen.length, 1);
});

test('wiring: a REST POST is retried when the connection was refused (never sent)', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  let calls = 0;
  const fetch = async () => {
    calls++;
    if (calls === 1) {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    }
    return new Response(JSON.stringify({ id: 1 }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const p = new GitHubReviewProvider({ config: {}, env: ENV, deps: { fetch, sleep: noSleep } });
  const { data } = await p.rest.issues.createComment({ owner: 'acme', repo: 'widgets', issue_number: 7, body: 'x' });
  assert.equal(data.id, 1);
  assert.equal(calls, 2);
});

test('wiring: a GraphQL query is retried, a mutation is not', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const seen = [];
  const p = retrying(badGateway, seen);
  await assert.rejects(() => p.graphql('query { viewer { login } }'), ProviderError);
  assert.equal(seen.length, 5);
  seen.length = 0;
  await assert.rejects(() => p.graphql('mutation { addComment { id } }'), ProviderError);
  assert.equal(seen.length, 1);
});

test('wiring: the resolve mutation opts in as idempotent and is retried', async (t) => {
  t.mock.method(process.stderr, 'write', () => true);
  const seen = [];
  const resolved = [200, { data: { resolveReviewThread: { thread: { id: 'T' } } } }];
  const p = retrying(() => (seen.length === 1 ? badGateway() : resolved), seen);
  await p.patchThreadStatus('T', 'fixed', { skipMarkerReply: true });
  assert.equal(seen.length, 2);
});
