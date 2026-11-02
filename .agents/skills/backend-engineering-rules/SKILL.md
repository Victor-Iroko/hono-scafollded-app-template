---
name: Backend Engineering Rules
description: Non-negotiable backend rules for queries, transactions, concurrency, idempotency, API design, errors, security, observability, migrations, and tests in this repo. Load before writing, reviewing, or fixing endpoints, services, queries, migrations, or jobs.
---

# Backend Engineering Rules

These rules override convenience and speed. If a requirement is ambiguous, or a
change touches data, auth, or money, ask before proceeding. When you knowingly
deviate, flag it in your summary instead of choosing silently.

## How the rules map to this repo

| Area | Where it lives |
| --- | --- |
| Queries | Drizzle builder in the relevant service; raw SQL only through `sql` templates with bound params |
| Validation | Zod schemas in `<module>.schema.ts`, applied at the route boundary |
| Transactions | `db.transaction(...)` from `src/core/db.ts`; pass `DbOrTx` into service helpers so they compose |
| Errors | `AppError` subclasses and `ERROR_CODES` in `src/core/errors.ts` / `src/core/error-schema.ts` |
| Jobs | BullMQ queues in `src/core/queue.ts`, job code in `src/jobs/`, and the worker entry point in `src/worker.ts` |
| Logging | pino through `src/core/logger.ts` |
| Config | `src/core/env.ts`, which fails fast on missing or invalid values |
| Migrations | `bun run db:generate` into `src/db/migrations` |
| Checks | `bun run lint`, `bun run typecheck`, `bun test <path>` |

## Database & Queries

- No N+1 queries. Never run a query inside a loop; batch with `WHERE id IN (...)`, joins, or eager loading/dataloaders.
- Select only the columns you need. No `SELECT *` in application code.
- Every list endpoint must be paginated (prefer cursor/keyset over offset for large tables). No unbounded queries.
- Any column used in a `WHERE`, `JOIN`, or `ORDER BY` on a non-trivial table needs an index. Mention the index in the PR when adding a query.
- Use parameterized queries only. Never build SQL by string concatenation.
- Don't load rows into memory just to count, filter, or aggregate them. Do it in the database.
- Bulk operations must use bulk inserts/updates, not one statement per row.

## Transactions & Data Integrity

- Multiple writes in a single request/operation must run in one transaction.
- Keep transactions short. No network calls (HTTP, queues, email) inside a transaction.
- Enforce invariants in the database too (NOT NULL, UNIQUE, foreign keys, CHECK), not only in application code.
- Use optimistic locking (version column) or `SELECT ... FOR UPDATE` where concurrent updates to the same row are possible.
- Side effects (emails, webhooks, events) must happen after the transaction commits. Use the outbox pattern if delivery must be guaranteed.

## Concurrency & Performance

- Independent I/O calls (DB queries, HTTP calls, cache lookups) must run concurrently, not sequentially. Only serialize when one depends on another's result.
- Cap concurrency (worker pools, semaphores). Never spawn unbounded tasks/promises over user-controlled input.
- Every outbound call (HTTP, DB, cache, queue) must have an explicit timeout.
- Retries only for idempotent operations, with exponential backoff + jitter and a max attempt count.
- Move slow or non-essential work (emails, report generation, third-party syncs) to background jobs, not the request path. Here that means enqueueing a BullMQ job, not inlining the work.
- Cache only with a clear invalidation strategy and TTL. Don't add caching to hide a slow query; fix the query.

## Idempotency & Reliability

- Write endpoints that can be retried by clients (payments, orders, etc.) must support idempotency keys.
- Background jobs must be idempotent: running twice must not cause duplicate effects.
- Handle partial failure explicitly. Never assume a downstream call succeeded.
- Fail fast on startup if required config or dependencies are missing or invalid.

## API Design

- Validate all input at the boundary (type, range, length, format). Never trust client data.
- Return consistent error shapes with correct HTTP status codes. Never return 200 for errors.
- Never change or remove fields in an existing response. Make additive changes or version the API.
- Don't expose internal models directly. Use explicit request/response DTOs/schemas.
- Rate-limit public and expensive endpoints.

## Error Handling

- Never swallow errors. Handle them, wrap them with context, or propagate them.
- No empty catch blocks and no bare `except`/`catch (e) {}`.
- Don't leak internals (stack traces, SQL, file paths) in API responses.
- Distinguish client errors (4xx) from server errors (5xx). Expected failures must not be logged as errors.

## Security

- Check authorization on every endpoint and at the resource level (not just "is logged in"). Prevent IDOR.
- Never log secrets, tokens, passwords, or PII.
- No secrets in code or committed config. Read them from environment or a secrets manager.
- Hash passwords with a modern algorithm (argon2/bcrypt). Never roll your own crypto.
- Sanitize and validate file uploads (type, size, storage location). Never trust filenames.
- Keep dependencies pinned and avoid adding new ones without justification.

## Observability

- Use structured logging with a request/correlation ID on every log line.
- Log at the right level. No `print`/`console.log` debugging left in code.
- Add metrics/tracing for new external calls and critical paths.
- Never log inside tight loops.

## Migrations

- Migrations must be backwards compatible with the currently running code (expand → migrate → contract).
- Never edit a migration that has already been merged or applied. Add a new one.
- Avoid locking operations on large tables (add indexes concurrently, backfill in batches).
- Every migration must be reversible, or explicitly documented as not.

## Testing

- Every bug fix includes a regression test.
- New business logic needs unit tests. New endpoints need integration tests covering success, validation errors, and auth failures.
- Tests must not depend on execution order, wall-clock time, or network access. Mock or fake external services.
- Don't weaken or delete a failing test to make it pass. Fix the code or ask.

## Code Quality & Change Discipline

- Keep changes minimal and scoped to the task. No drive-by refactors or unrelated formatting changes.
- Follow existing patterns and conventions in the codebase before introducing new ones.
- Business logic belongs in the service layer, not in routers or the data layer.
- No magic numbers or strings. Use named constants or config.
- Don't leave dead code, commented-out code, or TODOs without a linked issue.
- Run lint, type checks, and tests before declaring work complete.

## Agent Behavior

- Never run destructive commands (drop, truncate, force push, bulk delete) without explicit confirmation.
- Never modify production config, secrets, or CI/CD pipelines unless asked.
