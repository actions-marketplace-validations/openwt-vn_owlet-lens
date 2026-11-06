# ADR-0012: Providers own platform concerns

- **Status**: Accepted
- **Date**: 2026-09-24

## Context

The four review providers look alike, so #63 proposed a `provider-base.js` sharing four things: credential and CI-env resolution, bot-comment detection, a diff-status mapper, and the HTTP-status-to-error mapping.

Only the last is the same logic in every provider. The other three look alike but encode platform facts:

- **Credentials and CI env.** Each platform has its own token variables, fallbacks and auth header: `GITLAB_TOKEN` or `CI_JOB_TOKEN` (sent as `JOB-TOKEN`), `SYSTEM_ACCESSTOKEN` on Azure DevOps, a Bearer token on Bitbucket. The config loader also resolved these tokens from env, duplicating each provider's own fallback chain.
- **Bot identity.** An account id on Bitbucket, a user flag or name pattern on GitLab, a service descriptor on Azure DevOps, an app login on GitHub.
- **Diff vocabulary.** Each platform names file changes its own way, so a shared table is still one lookup per platform.

## Decision

1. **Providers own platform concerns.** Credentials, CI env, bot identity and diff vocabulary live in each provider. The config loader resolves LLM keys only; for review providers it just picks the effective provider from CI signals so it can refuse an unresolved `${VAR}` in that provider's auth field.
2. **Share only the HTTP status-to-error table.** `lib/providers/http-error.js` exports `httpError(origin, method, url, res, text)`: 429 becomes `RateLimitError` (honouring `Retry-After`, delta-seconds or HTTP-date), 401 and 403 become `AuthError`, 5xx becomes a retryable `ProviderError`, anything else a terminal `ProviderError`. The fetch-based providers (Bitbucket, GitLab, Azure DevOps) call it from their HTTP helpers; GitHub calls it from an Octokit `hook.error('request')` hook, which sees REST and GraphQL HTTP errors alike. Platform quirks are handled before the call, in the provider (Azure DevOps's 203 sign-in page, GitHub's rate-limit 403).
3. **`parseRetryAfter` lives in `lib/retry.js`.** It is HTTP logic used by LLM adapters and providers alike, so no provider depends on `lib/llm/`.

## Alternatives considered

1. **A `provider-base.js` with all four pieces.** Three of them would be a switch on the platform: the code moves without concentrating (it fails the deletion test).
2. **Map GitHub errors in `httpError` too.** GitHub uses Octokit, which throws its own `RequestError`, and signals rate limits with a 403 plus headers. #69 typed those errors by calling `httpError` from the Octokit hook and keeping the 403 check in `github.js`.
3. **Share the LLM status mapping in `llm/base.js`.** A different domain (Cloudflare challenges, 529 overload), so it stays.

## Consequences

- A new fetch-based provider gets typed errors, exit code 3 on bad credentials and `Retry-After` handling by calling `httpError` from its HTTP helper.
- GitLab and Azure DevOps now honour an HTTP-date `Retry-After` (capped at 24 h), as Bitbucket already did.
- Provider error messages share one shape: `<label> <METHOD> <url without query> failed: <status> <redacted body>`.
- The loader no longer fills `auth.bitbucketToken`, `auth.gitlabToken` or `auth.azureToken` from env. A value set in the config file still passes through, and each provider falls back to the same env vars, so runs behave the same. `auth.azureOrgUrl` was never read; see #71.
- Which layer retries, and which requests may repeat: [ADR-0013](./0013-provider-retries-per-request.md).
