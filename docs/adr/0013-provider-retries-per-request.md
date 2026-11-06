# ADR-0013: Providers retry each request; a create repeats only when it did not land

- **Status**: Accepted
- **Date**: 2026-09-25

## Context

`withRetry` (5 attempts, 1 s, 4 s, 16 s and 60 s of backoff) ran in two layers that did not know about each other. `action-poster.js` wrapped every write, and GitLab and Azure DevOps also wrapped their own methods. Bitbucket and GitHub had no retry of their own. Measured with every call failing:

- A failing reply on GitLab or Azure DevOps made 25 requests and waited 8 minutes.
- On Bitbucket or GitHub, one 502 on a read failed the run. On a post it dropped the finding, because `postThreadsBatch` catches failures into `{ ok: false }` results and the outer wrap never saw them.
- Azure DevOps fetched file content without a retry. On a failure it reviewed the file as an empty patch.

Repeating a POST after a 5xx can duplicate a thread or a reply if the server applied the first attempt before it failed.

## Decision

1. **The provider's HTTP layer retries, one request at a time.**
   - Bitbucket: `_api` and `_postForm`.
   - GitLab: `_api`, and each page of `_paginate`.
   - Azure DevOps: `_api`.
   - GitHub: one Octokit `hook.wrap('request')`. It is registered after the `hook.error` of ADR-0012, so it retries typed errors from REST, pagination and GraphQL alike.

   Nothing above the provider wraps provider calls in `withRetry`. A retry never repeats a step that already succeeded. `review`, `reply`, `learn` and the summary upsert all behave the same way.
2. **What repeats depends on the request's effect** (`requestRetry` in `lib/retry.js`).
   - GET, PUT, PATCH, DELETE and GraphQL queries repeat on any retryable error.
   - A POST or a GraphQL mutation is a create. It repeats only when the server provably did nothing: a `RateLimitError`, or a connection that never opened (`ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN` or `UND_ERR_CONNECT_TIMEOUT` in the `cause` chain).
   - A call that is safe to repeat opts in with `idempotent: true`. Today that is Bitbucket's resolve POST and GitHub's resolve and unresolve mutations.
3. **One wait is at most 60 s.** When the server asks for longer, `withRetry` throws at once instead of holding the job. For a GitHub rate limit, the wait is:
   - `retry-after` when GitHub sends it;
   - else, once the quota is spent, the time until `x-ratelimit-reset`;
   - else 60 s, GitHub's documented minimum for a secondary limit.
4. **Each retry logs one stderr line**, for example `{"level":"warn","msg":"retry","label":"GET /repos/acme/widgets/pulls/7","attempt":1,"waitMs":1000,"errName":"ProviderError","errStatus":503}`. The label is the method and the redacted path, with no host and no query string.
5. **Azure DevOps `getDiff` no longer swallows a content fetch error.** An error that survives the retries fails the run before any LLM spend. A 404 still gives an empty patch.

## Alternatives considered

1. **Retry only in `action-poster.js`.** It sees whole operations, such as a batch or a reopen's reply then status update, so it repeats steps that already succeeded. It also misses reads, `reply`, `learn`, and batch failures, which come back as `{ ok: false }`.
2. **`@octokit/plugin-retry`.** It repeats POSTs on 5xx, the duplicate risk this ADR avoids, and pulls in `bottleneck`. One hook in `makeOctokit` covers what is needed.
3. **Repeat creates on 5xx too.** Developers see duplicate threads and replies and have to delete them by hand. A create that failed is picked up by the next run's reconcile.

## Consequences

- A create that fails with a 5xx or a timeout fails that item: it is logged and the run exits 6. The next run reconciles and posts it.
- An LLM 429 that asks for more than 60 s fails at once. A configured fallback model takes over (ADR-0005).
- A GitHub secondary rate limit can hold one request for up to 4 minutes (4 waits of 60 s).
- Tests pass `deps.sleep` next to `deps.fetch`, and `withRetry` takes a `sleep` option. Tests count attempts and waits without sleeping.
- To get retries, a new provider sends each request through `withRetry(…, requestRetry(method, url, …))` in its HTTP helper.
