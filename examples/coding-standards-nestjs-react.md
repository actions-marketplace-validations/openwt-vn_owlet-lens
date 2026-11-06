# Coding standards — NestJS + React TypeScript

> Example coding-standards file. Point `review.codingStandardsPath` at this
> file (or a copy in your repo) to inject these rules into the AI reviewer's
> system prompt. These are the rules previously hardcoded into
> `prompt-builder.js` before v1.1; preserved here so adopters of the
> NestJS/React stack get the same review behaviour.

## Performance review areas

- N+1 queries, unnecessary loops, missing pagination, large memory allocations
- Unoptimized database queries, missing indexes
- Synchronous operations that should be async

## Backend (NestJS / TypeORM)

- Always use `softDelete`, never `repository.delete()` — flag any hard deletes.
- Every controller endpoint must have `@UseGuards(JwtAuthGuard)` and `@Roles()` decorators.
- All user input must be validated with class-validator DTOs (`@IsEmail`, `@MinLength`, etc.).
- Multi-table writes must be wrapped in `dataSource.transaction()`.
- Use built-in NestJS exceptions (`NotFoundException`, `BadRequestException`), not generic `Error`.
- Repository queries with relations must specify them explicitly — no lazy loading.
- Domain entities must not leak into API responses — use DTOs and mappers.
- Never import from infrastructure layer in domain/application layers.
  CLEAN direction: `Presentation -> Application -> Domain <- Infrastructure`.
- Auto-sequenced IDs (`riskId`, `issueId`, `changeRequestId`) must not be set manually — database triggers handle them.
- Inject dependencies via constructor, never use `new` for services/repositories.
- No `console.log` — use NestJS `Logger` (`this.logger.log/error/warn`).

## Frontend (React / TypeScript / Zustand)

- Components must have typed `Props` interfaces — no `any` type.
- `useEffect` must include cleanup functions for subscriptions, timers, and event listeners.
- `useEffect` dependency arrays must be explicit — no missing dependencies.
- API calls must handle loading, error, and success states.
- Use Zustand stores for shared state, not prop drilling beyond 2 levels.
- Error boundaries must wrap feature-level components.
- No inline styles — use CSS modules or the project styling approach.
- Event handlers with complex logic should be extracted, not defined inline in JSX.
- Toast notifications for user-facing errors (`toast.error`), not silent failures.
- No `@ts-ignore` or `as any` type assertions — use proper typing.
- Components should be under 200 lines — extract hooks or sub-components if larger.

<!-- ai-review:learned:start v1 -->
<!-- Auto-managed by `ai-review learn`. Edit ABOVE this block, not inside. -->

### Learned conventions

- **[architecture]** Attach hidden per-run metadata as non-enumerable properties on the findings array, read via @type {any} casts, instead of widening the return type.
  _Learned from wontfix across PRs #15._
  <!-- ai-review:learned-rule=ae6a61cf777a2185 -->

- **[architecture]** Each provider adapter owns its own endpoint/URL-shape convention; no shared URL-normalization helper or centralized per-provider validation.
  _Learned from wontfix across PRs #17._
  <!-- ai-review:learned-rule=74f647fe12f4f955 -->

- **[bug]** Auxiliary outputs (webhook exports, overflow chunk reviews) fail soft: log/report the failure but never alter the exit code or skip the operation.
  _Learned from wontfix across PRs #18, #11._
  <!-- ai-review:learned-rule=16ac083c3db53403 -->

- **[bug]** The pre-commit hook is opt-in and fail-open: tool failures never block commits, only warn, since review also runs in CI.
  _Learned from wontfix across PRs #14._
  <!-- ai-review:learned-rule=87a3f8e8e0f7c802 -->

- **[bug]** Prefer security-first over-redaction/whitelisting in secret handling, accepting false positives and reduced tracing coverage rather than risking secret exposure.
  _Learned from wontfix across PRs #8, #6._
  <!-- ai-review:learned-rule=3a0d537bcc11c8e5 -->

<!-- ai-review:learned:end -->
