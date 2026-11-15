# Production Backend Guide

What a production-grade backend needs, how this template scores against it, and the order to build one from scratch with Hono and Bun.

Use the inventory as a review rubric and the build phases as the implementation path. Each phase leaves the app runnable; do not skip ahead to queues or tracing before the error contract and database layer are solid.

## Contents

1. [The inventory](#1-the-inventory)
2. [How this template scores](#2-how-this-template-scores)
3. [Build order from scratch](#3-build-order-from-scratch)
4. [Runtime fork: long-running vs serverless](#4-runtime-fork-long-running-vs-serverless)
5. [Agent skills and MCPs](#5-agent-skills-and-mcps)
6. [The 80/20 version](#6-the-8020-version)

---

## 1. The inventory

### 1.1 Foundations and repo hygiene

- Pinned runtime and package manager (Bun 1.x, lockfile committed, `.tool-versions` or `engines`).
- Repo organized by domain, not only by file type: `api/<module>/`, `core/`, `db/`, `jobs/`, `integrations/`.
- TypeScript `strict: true`, no implicit `any`, path aliases when the tree gets deep.
- Linter and formatter enforced in CI (this template uses `oxlint` and `oxfmt`).
- Pre-commit hooks (`lint-staged`) and a commit message convention.
- Branch protection, required review, `CODEOWNERS`.
- Dependency policy: pinned versions, Dependabot or Renovate, lockfile review, license check.
- One-command bootstrap: install, env, infra, migrate, seed, dev.
- `.gitignore` covers `.env*`, build output, coverage, and local volumes.
- Architecture diagram, README, onboarding doc, ADRs for irreversible decisions.
- One source of truth for backend rules. This template uses `AGENTS.md` and `.agents/skills/backend-engineering-rules/SKILL.md`.

### 1.2 Configuration, environment, and secrets

- One validated schema at boot, fail fast, typed access. See `src/core/env.ts`. No scattered `process.env`.
- Per-environment config: local, test, staging, production. A fully documented `.env.example`.
- Cross-field validation: both-or-neither provider credentials, URL format checks, minimum secret lengths.
- Safe production defaults: docs off, metrics private, debug logging off.
- Secrets in a secret manager in production (AWS or GCP Secrets Manager, Vault, Doppler, 1Password), injected at runtime. Never baked into images or committed.
- A tested rotation procedure, including acceptance of the old secret during overlap.
- Config changes reviewed and released like code. Runtime toggles use feature flags, not redeploys.
- Least-privilege credentials per process. The API and the worker usually need different database and queue permissions.
- Fail fast at startup when required config or dependencies are missing. Never boot into a half-working state.

### 1.3 HTTP and API layer

- Router composition by module: `router` / `schema` / `service`, plus `error` when a domain needs it.
- Validation at the boundary for params, query, body, and headers. Reject unknown fields and cap sizes.
- A consistent error envelope with a stable machine code, human message, field errors, request ID, and path. Correct status codes. See `src/core/errors.ts` and `src/core/error-schema.ts`.
- 404 and 405 handling, HEAD semantics, and caching headers where relevant.
- Pagination on every list endpoint, cursor or keyset preferred. Sort and filter allowlists. No unbounded queries.
- API versioning strategy (`/v1` or media type) and a deprecation policy.
- Idempotency keys on retryable writes such as payments, orders, and invites.
- OpenAPI generated from code (`hono-openapi` plus `describeRoute`), docs behind a flag or auth (`DOCS_ENABLED`), Scalar or Fern reference, and `llms.txt` for agents.
- Contract tests or a drift check so the spec cannot silently diverge.
- CORS allowlist (never `*` with credentials), CSRF protection for cookie auth, security headers, body limits, compression, and request timeouts.
- Large uploads go directly to object storage through presigned URLs, not through the API process.
- Health, metrics, and docs mounted outside auth and the global rate limiter.

### 1.4 Authentication and authorization

- An explicit choice between server sessions and JWT. Short-lived access tokens plus refresh. A clear revocation story.
- Password hashing with argon2id or bcrypt, breach-list checks, minimum length, no composition rules.
- Email verification, single-use password reset with expiry, and session revocation on password change.
- OAuth and OIDC with state and PKCE, plus defined account-linking rules.
- MFA or WebAuthn for sensitive accounts and admin actions.
- RBAC or ABAC plus resource-level authorization to prevent IDOR. Tenant identity comes from the credential or server-side membership, never a trusted `X-Tenant-Id` header.
- API keys stored as a hash plus prefix, scopes, last-used timestamp, and revocation metadata.
- Rate limits on auth endpoints, lockout, credential-stuffing protection, and account-enumeration resistance.
- Secure cookies: `HttpOnly`, `Secure`, `SameSite=Lax` or `Strict`, `__Host-` prefix, no `Domain`.
- Service-to-service authentication: mTLS, signed requests, or client credentials.
- Audit log for logins, permission changes, impersonation, and money movement.

### 1.5 Database and data lifecycle

- Postgres or the chosen store, with a pool sized against `max_connections` across all replicas. Set `statement_timeout` and `idle_in_transaction_session_timeout`.
- PgBouncer, Neon pooler, or Hyperdrive when serverless or many instances share a database.
- Schema in code, migrations generated and versioned. Never edit an applied migration.
- Expand, migrate, contract: migrations stay compatible with the currently running version during a rolling deploy.
- Lock-safe DDL: `CREATE INDEX CONCURRENTLY`, batched backfills, no long table locks.
- Constraints in the database (`NOT NULL`, `UNIQUE`, `FK`, `CHECK`), plus indexes for every `WHERE`, `JOIN`, and `ORDER BY` on non-trivial tables.
- No N+1 queries, no `SELECT *` in application code, only needed columns, bulk operations for bulk work.
- Transactions for multi-write operations. Keep them short and never make network calls inside them.
- Optimistic locking (`version`) or `SELECT ... FOR UPDATE` for concurrent updates.
- A decision on soft versus hard delete, a retention policy, PII classification, encryption at rest, and column-level encryption for sensitive fields.
- Automated backups, point-in-time recovery, and a rehearsed restore with documented RPO and RTO.
- Read replicas for read scaling, with explicit handling of replica lag.
- Data lifecycle jobs: archive, purge, export, and GDPR delete.
- Migrations run as a deploy step, never at boot, using a separate least-privilege migration user.
- Seeds and factories for dev and test, with anonymized data when copying production.

### 1.6 Caching

- Redis with TLS and a password. Separate instances or logical databases for cache, rate limits, and queues.
- An eviction policy per use: `allkeys-lru` for cache, `noeviction` plus persistence for BullMQ. The two-Redis split in `docker-compose.yml` is correct.
- Cache-aside with explicit TTL and an invalidation strategy. Versioned and namespaced keys per environment.
- Stampede protection through single-flight or a lock, negative caching, and jittered TTLs.
- Never cache authorization decisions beyond the revocation window.
- Observe hit rate, latency, and evictions. Degrade gracefully when Redis is down.
- In-process caches are bounded and per-instance only.

### 1.7 Background jobs and scheduling

- Queue choice follows the runtime: BullMQ plus a worker for long-running Redis, QStash, Cloudflare Queues, or SQS for serverless.
- A separate worker deployment that scales independently and shuts down gracefully by stopping fetches and finishing in-flight work.
- Job payloads validated at enqueue and again at execution. A typed job registry, as in `src/jobs/index.ts`.
- Retries with exponential backoff and jitter, capped attempts, and a distinction between retryable and fatal errors.
- Idempotent handlers, with dedupe by job ID or business key.
- A dead-letter queue with replay tooling and an alert when depth grows.
- Per-queue concurrency and rate limits, plus priority and fairness where needed.
- Scheduling or cron with leader election or a managed scheduler, so replicas do not double-fire.
- Job observability: a trace per job, queue depth and age metrics, failure alerts, and duration histograms.
- The transactional outbox pattern when a database write and an event must both happen, plus consumer-side inbox and dedupe when at-least-once matters.
- Poison-message handling, payload size limits, and heartbeats or checkpoints for long jobs.

### 1.8 Integrations and outbound calls

- One outbound HTTP wrapper with connect and read timeouts, bounded retries for idempotent calls only, a circuit breaker, a bulkhead, and connection reuse.
- An egress allowlist or proxy where the threat model requires it.
- Email: a provider (SES, Postmark, Mailgun, Resend) or SMTP, plus SPF, DKIM, DMARC, templates, bounce and complaint webhooks, a suppression list, and send-rate limits.
- Payments: idempotency keys, webhook signature verification over the raw body, a replay window, event dedupe, and a reconciliation job.
- Inbound webhooks: verify signature and timestamp, dedupe by event ID, return 2xx fast, queue the work, mount outside the global rate limiter, and keep the secret rotatable.
- Outbound webhooks: signed, retried with backoff, dead-lettered, and auto-disabled after repeated failure.
- Object storage: private by default, short-lived presigned URLs, filename sanitization, content-type and size checks, virus scanning, and lifecycle rules.
- Documented failure modes and a fallback for every third party.

### 1.9 Observability

- Structured JSON logs to stdout only. No file writes.
- Every line carries `timestamp`, `level`, `service`, `env`, `version`, `requestId`, `traceId`, `spanId`, and non-PII `userId` or `tenantId` where useful.
- Redaction of authorization headers, cookies, tokens, passwords, and PII. Request and response bodies off by default.
- OpenTelemetry initialized before the app graph loads. Auto-instrumentation for HTTP, Postgres, Redis, and queues. W3C `traceparent` propagation across async boundaries.
- Spans for inbound requests, outbound HTTP, database queries, cache calls, and queue publish and consume.
- RED metrics per route with templated paths and bounded cardinality, USE metrics for resources, database pool stats, queue depth and age, cache hit rate, and business metrics.
- Prometheus scrape or OTLP push, with `/metrics` private or token-gated.
- Dashboards before launch: traffic, errors, p50/p95/p99, saturation, dependencies, and queue backlog.
- SLIs, SLOs, and an error budget. Alerts on burn rate or user-visible symptoms, not CPU. Every alert links to a runbook. On-call rotation assigned.
- Error tracking (Sentry) with release and commit, environment, source maps, and noise controls.
- Log aggregation with retention, searchable by trace ID. Audit logs stored separately.
- Continuous profiling, heap and CPU visibility, and a slow query log.

### 1.10 Reliability and resilience

- Liveness checks only whether the process is alive. Readiness checks whether it can serve traffic. A startup probe covers slow boots. A database outage must not cause a restart loop.
- Graceful shutdown: on `SIGTERM`, stop accepting connections, drain in-flight requests with a deadline, stop workers, close pools and queues, then exit. Size the `preStop` hook and termination grace period to match.
- Timeouts at every layer, nested inside the caller's deadline, with cancellation propagation.
- Retries capped, jittered, at one layer only, and only for idempotent operations.
- Circuit breakers, bulkheads, load shedding, bounded queues, backpressure, and `429` or `503` with `Retry-After`.
- Rate limiting per IP, user, tenant, and API key, plus a global ceiling. A shared store. A deliberate fail-open or fail-closed choice per endpoint.
- Idempotency keys for writes and dedupe at the edge.
- Graceful degradation: cache miss, stale read, queue delay, read-only mode.
- Multiple replicas, anti-affinity, PodDisruptionBudget, rolling deploys, zero downtime.
- Load tests with k6 or autocannon against realistic traffic, a capacity plan, and sane autoscaling bounds.
- Chaos or failure injection: kill the database, the queue, and a third party, then verify behavior.
- Backup and restore drills plus a disaster recovery runbook.
- Protection against retry storms, thundering herds, and cold-start stampedes.

### 1.11 Security

- A threat model and a baseline such as OWASP ASVS or the Top 10.
- TLS everywhere, HSTS, secure headers (`X-Content-Type-Options`, `Referrer-Policy`, CSP, `frame-ancestors`), and no `X-Powered-By`.
- CORS allowlist, CSRF protection for cookie auth, and correct `SameSite`.
- Input validation, output encoding, parameterized SQL, SSRF protection (allowlist, block link-local and metadata IPs), and path traversal defense.
- Body-size limits, upload validation, and decompression-bomb protection.
- Secrets manager plus rotation, least-privilege IAM and database roles, and network segmentation.
- Dependency and container image scanning in CI, an SBOM, and pinned image digests.
- Container hardening: non-root, no privilege escalation, dropped capabilities, read-only filesystem where possible.
- PII classification, minimization, encryption, retention, access control, data-subject requests, and an audit trail.
- WAF or bot protection, credential-stuffing defenses, and account-enumeration defenses.
- A vulnerability disclosure process, a patch SLA, and an incident response plan.
- Periodic penetration tests or DAST.
- Never log secrets, tokens, full PII, or raw payment data.

### 1.12 Testing

- Unit tests for business logic, integration tests for HTTP with real Postgres and Redis (containers), end-to-end tests for critical flows, and contract tests against OpenAPI.
- Load tests and security tests before launch.
- Deterministic tests: isolated database per run, transaction rollback or schema per worker, factories, a fake clock, and no real network.
- Coverage on critical paths, not vanity percentages.
- A regression test for every bug fix, plus success, validation-failure, and auth-failure coverage for every endpoint.
- Migration tests against a production-like schema and dataset.
- Job tests covering retry, idempotency, and dead-letter behavior.
- Everything runs on every PR. Flaky tests are quarantined, not ignored.
- Ephemeral or preview environments, post-deploy smoke tests, and synthetic monitoring.

### 1.13 CI/CD and release engineering

- CI: frozen install, lint, format check, typecheck, unit and integration tests with services, build, container build, image scan, dependency audit, migration check, and OpenAPI drift check.
- CD: an immutable artifact or image, environment promotion from dev to staging to production, approvals, canary or blue-green, and automated rollback.
- IaC for infrastructure (Terraform, Pulumi, or Cloudflare), with no console changes and drift detection.
- Per-environment secrets and short-lived cloud credentials through OIDC, not long-lived keys.
- Migrations as a separate, gated deploy step, backward compatible across two releases.
- Feature flags for risky changes and a kill switch.
- Versioning, a changelog, and build metadata in telemetry.
- Post-deploy verification and automatic rollback on SLO burn.
- Runbooks and on-call ownership per service.

### 1.14 Operations and governance

- A named owner, on-call rotation, escalation path, incident process, status page, and blameless postmortems.
- SLOs, a capacity plan, and a cost budget with alerts.
- Backups and disaster recovery tested on a schedule, with documented RTO and RPO.
- Compliance as applicable: GDPR, CCPA, HIPAA, SOC 2, DPAs, audit trails, and retention schedules.
- Access reviews and a break-glass procedure.
- Architecture diagram, runbooks, ADRs, and support or admin tooling.
- Third-party and vendor risk review.

---

## 2. How this template scores

| Layer              | This template | Main gaps                                                                  |
| ------------------ | ------------- | -------------------------------------------------------------------------- |
| Foundations        | Strong        | No `CODEOWNERS`, commit convention, or engines pin                         |
| Config and secrets | Strong        | Env only; no secret manager integration                                    |
| HTTP and API       | Partial       | No CORS, security headers, body limit, timeout, versioning, or idempotency |
| Auth               | Strong core   | No RBAC, MFA, audit log, or API keys                                       |
| Database           | Strong core   | No backups, PITR, retention, replicas, or restore drill                    |
| Caching            | Good          | No stampede protection or hit-rate metrics                                 |
| Background jobs    | Strong        | No outbox, scheduler safety, or DLQ replay UI                              |
| Integrations       | Good          | No inbound webhook verification or outbound resilience wrapper             |
| Observability      | Strong core   | No SLOs, dashboards, alerting, or log shipping                             |
| Reliability        | Partial       | Shutdown does not drain HTTP; no request timeout or budget                 |
| Security           | Partial       | No scanning, headers, CSRF, SSRF controls, or audit                        |
| Testing            | Empty         | Only `.gitkeep` files; CI does not run tests                               |
| CI/CD              | Partial       | Lint, format, and typecheck only; no tests, build, scan, or deploy         |
| Operations         | Absent        | No runbooks, on-call, SLOs, DR, or retention                               |

Two things this template does better than most starters, and you should keep both:

- The two-Redis split: `noeviction` for jobs, `allkeys-lru` for cache.
- The error contract with Postgres SQLSTATE mapping.

Two subtle bugs to fix before copying it:

1. **OTel loads too late.** `initInstrumentation()` runs after the import graph has evaluated `pg` and `ioredis`. Auto-instrumentation patches modules as they load, so spans can be silently missed. Start the SDK from a preload entry (`bun --preload ./src/instrumentation.ts`) or an `--import` bootstrap.
2. **Health and metrics pass through the global rate limiter.** In `src/app.ts`, `/metrics` is registered after `rateLimit`, so Prometheus scrapes consume rate-limit points. `/readyz` also opens database, S3, and SMTP checks on every probe. Mount them on a separate pipeline or exempt the paths, and make readiness cheap.

---

## 3. Build order from scratch

Each phase leaves the app runnable. Do not skip ahead.

### Phase 0: Decide the runtime and topology

See [section 4](#4-runtime-fork-long-running-vs-serverless). Pick one model before writing code. Mixing them produces a worker that never runs and a pool that exhausts the database.

### Phase 1: Scaffold and tooling

```sh
mkdir my-api && cd my-api
bun init -y
bun add hono zod @hono/standard-validator
bun add -d typescript @types/bun oxlint oxfmt husky lint-staged
bunx husky init
```

- Create `src/api`, `src/core`, `src/db`, `src/jobs`, `src/integrations`, `src/middleware`, `tests/unit`, and `tests/integration`.
- Set `strict: true` in `tsconfig.json`.
- Add scripts for `dev`, `worker`, `lint`, `format`, `format:check`, `typecheck`, `test`, `db:generate`, `db:migrate`, `db:seed`, and `openapi:generate`.
- Configure `lint-staged` so hooks lint and format changed files.

**Done when:** `bun run typecheck` and `bun run lint` pass on an empty app.

### Phase 2: Environment schema and secrets

- Create `.env.example` with every variable, commented defaults, and a note on which are required in production.
- Create `src/core/env.ts` with one Zod schema, `initEnv()` at entry, and `getEnv()` everywhere else. Log `z.prettifyError(error)` and throw on failure.
- Add cross-field refinements for both-or-neither credentials, URL checks, minimum lengths, and safe defaults (`DOCS_ENABLED=false`, `LOG_LEVEL=info`).
- Create `.env.test` and ignore all real env files.

**Done when:** a missing or malformed variable stops the process with one readable error before it binds a port.

### Phase 3: App shell and middleware order

Create `src/app.ts` as a factory that takes dependencies (`env`, `auth`, middleware), and `src/index.ts` as the composition root. Middleware order is a security decision:

```ts
app.use("*", contextStorage());
app.use("*", requestId({ headerName: "" })); // do not trust client-supplied IDs
app.use("*", secureHeaders());
app.use("*", bodyLimit({ maxSize: 1_000_000 }));
app.use("*", cors({ origin: allowlist, credentials: true }));
app.use(middleware.otel);
app.use(middleware.logger);

// Cheap rejects are done; now authenticate.
app.use("*", authContext(auth));

// Rate limit before any database work.
app.use(middleware.rateLimit);
app.use("*", middleware.database);
```

- Add `app.notFound(...)` and `app.onError(globalErrorHandler)`.
- Mount `/healthz`, `/readyz`, `/metrics`, `/docs`, and `/openapi.json` before the global limiter, or exempt them.
- Add a request timeout middleware for slow handlers.

**Done when:** `curl /healthz` returns 200, `/metrics` is private in production, and an unknown route returns the JSON error envelope.

### Phase 4: Error contract and validation

- Define the `ErrorCode` union and `ErrorResponseBody` with `success`, `error.code`, `error.message`, optional `fields`, `requestId`, and `path`.
- Add `AppError` subclasses for 400, 401, 403, 404, 409, 422, 429, 500, and 503.
- Map Postgres SQLSTATEs to HTTP: `23505` to 409, `23503` to 409, `23502` to 422, `57014` to 503, and classes 08, 53, and 57 to 503. Never leak SQL or stack traces in production.
- Validate with Zod at the route boundary and convert `ZodError` into field-level errors.

**Done when:** every failure mode returns the same shape with a stable code, and production responses contain no internals.

### Phase 5: Database

```sh
docker compose up -d postgres
bun add drizzle-orm pg
bun add -d drizzle-kit @types/pg
```

- In `src/core/db.ts`: a pool with max, idle, and connect timeouts, the Drizzle instance, `getDb()`, `dbMiddleware()`, `checkDbHealth()`, and `closeDb()`.
- Add `src/db/schema/*` and `src/db/relations/*`, plus `drizzle.config.ts` pointing at the schema folder.
- Run `bunx drizzle-kit generate`, review the SQL, then `bunx drizzle-kit migrate`. `push` is for local only; production uses `migrate`.
- Add a seed script and a test database compose file.
- Write down the transaction rule: multi-write operations use `db.transaction`, and no HTTP, queue, or email calls happen inside it.

**Done when:** `/readyz` reports database latency, migrations apply to a fresh database, and a duplicate insert returns 409 instead of 500.

### Phase 6: Authentication and authorization

```sh
bun add better-auth @better-auth/drizzle-adapter
bun run auth:generate
```

- Configure Better Auth with the Drizzle adapter, trusted origins, email verification policy, password reset, session cookie cache, and Redis-backed rate limiting.
- Add `authContext`, `optionalSession`, `requireSession`, and `getSessionUser`.
- Mount the auth handler at a fixed base path.
- Add authorization helpers next: role and permission checks plus resource ownership checks per route.
- Add an `audit_log` table and write to it on login, role change, and privileged actions. It can be a queue job.

**Done when:** an unauthenticated request gets 401, a valid session gets the user in context, and user A cannot read user B's record.

### Phase 7: Cache and rate limiting

```sh
bun add ioredis rate-limiter-flexible cockatiel
```

- In `src/core/redis.ts`: a fail-fast client (`enableOfflineQueue: false`, command timeout), a health check, and graceful close.
- In `src/middleware/rate-limit.ts`: configurable points and window, key prefix, per-IP and per-user and per-key limiters, `X-RateLimit-*` and `Retry-After` headers, a circuit breaker around Redis, and an explicit fail-open or fail-closed choice.
- Add a cache helper with namespaced keys, TTL, explicit delete-on-write, and optional single-flight.

**Done when:** Redis going down does not take the API down, and a hot endpoint returns 429 under load.

### Phase 8: Background jobs

For a long-running deployment:

```sh
bun add bullmq bullmq-otel
```

- In `src/core/queue.ts`: a separate jobs Redis, `maxRetriesPerRequest: null`, default attempts and backoff and retention, and OTel telemetry.
- In `src/jobs/index.ts`: queue configs with concurrency and limiter, a typed `defineJob({ queue, schema, run })`, and an `enqueue()` that validates before adding.
- In `src/core/worker.ts`: one `Worker` per queue with completed, failed, stalled, and error handlers, and a dead-letter move after the final attempt.
- In `src/worker.ts`: init env and instrumentation, start workers, and shut down gracefully.

For serverless, replace this phase with QStash (`@upstash/qstash`), a signed callback route that verifies the raw body, and `flowControl` instead of worker concurrency.

**Done when:** enqueue leads to execution, a failing job retries with backoff and lands in the dead-letter queue, and `SIGTERM` finishes in-flight jobs before exit.

### Phase 9: Integrations

- S3 client with a private bucket, presigned PUT and GET, short expiry, a path-style toggle for local, a health check, and optional bucket bootstrap.
- Email: a provider adapter, templates, enqueue instead of inline sends, a per-relay rate limit, and bounce and complaint handling.
- Payments and webhooks: signature verification on the raw body, a timestamp window, an event dedupe table, and a fast 2xx with the work queued.
- One outbound HTTP helper with timeouts, retries, and a circuit breaker. No bare `fetch` in services.

**Done when:** a third-party outage degrades a feature instead of hanging a request, and a replayed webhook is ignored.

### Phase 10: Observability

```sh
bun add pino hono-pino @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-metrics-otlp-http \
  @hono/otel prom-client @hono/prometheus @sentry/bun @sentry/hono
```

- Pino: JSON in production, pretty in dev, base fields for service and env and version, a redaction list, and an OTel trace and span mixin.
- OTel: `service.name` and `service.version` resource attributes, OTLP trace and metric exporters, auto-instrumentation, and a sampling policy. Start it before the app graph through `bun --preload`.
- Prometheus: default metrics plus RED metrics, a token on `/metrics`, and no public exposure.
- Sentry: environment, release, a lower `tracesSampleRate` in production, and PII scrubbing.
- Define five to ten alerts on day one: 5xx rate, p95 latency, database pool saturation, queue backlog age, dead-letter depth, dependency failures, and restart count.

**Done when:** one request produces a log line, a trace, and a metric that can all be correlated by request ID.

### Phase 11: Reliability hardening

- Split liveness from readiness. Make readiness check only what is essential and cache the result for a few seconds.
- Implement graceful shutdown with a drain deadline. This template closes pools but does not stop accepting HTTP.
- Add per-request timeouts and a global body limit.
- Add idempotency keys for retryable writes:

```sql
create table idempotency_keys (
  key text primary key,
  user_id uuid not null,
  request_hash text not null,
  status text not null,          -- pending | completed | failed
  response jsonb,
  expires_at timestamptz not null
);

create index on idempotency_keys (expires_at);
```

- Add an outbox table when a database write must reliably trigger an event or email.
- Add retry, dead-letter, and replay runbooks.
- Load test the top three endpoints and record the numbers.

**Done when:** `SIGTERM` drains cleanly, a duplicate `POST` with the same key returns the same response, and a dependency outage produces 503s rather than timeouts.

### Phase 12: Tests

```sh
docker compose -f docker-compose.test.yml up -d
bun test tests/unit
bun test tests/integration
```

- Unit: pure business logic, error mapping, and validators.
- Integration: the real HTTP app against real Postgres, and Redis when used. One schema or transaction per test, with factories for fixtures.
- For each endpoint: success, validation failure, unauthenticated, forbidden, not-found, and conflict.
- Jobs: success, retry, idempotent replay, and dead-letter behavior.
- Add a smoke test that boots the app and hits `/healthz` and `/readyz`.

**Done when:** CI fails on a broken endpoint without manual testing.

### Phase 13: CI/CD and containers

CI should run, in order:

```yaml
- bun ci
- bun run lint
- bun run format:check
- bun run typecheck
- bun test
- bun run openapi:generate && git diff --exit-code openapi.json
- docker build .
- trivy image ...
```

- Multi-stage Dockerfile, production dependencies only, a non-root user, a healthcheck, `NODE_ENV=production`, and a pinned base image digest.
- Deploy pipeline: build once, promote the same image, run migrations as a gate, deploy, smoke test, and roll back on failure.
- IaC for the database, Redis, bucket, secrets, DNS, and monitoring.
- Staging runs the same image and migrations as production.

**Done when:** a merge to `main` reaches staging without a human running commands, and rollback is one action.

### Phase 14: Launch gate

Do not ship until every item is true:

- Every secret rotated and every development default removed.
- `DOCS_ENABLED=false` and `/metrics` private.
- Migrations applied with `migrate`, not `push`.
- API and worker deployed separately, with resource limits and autoscaling bounds.
- Backups enabled and a restore rehearsed.
- Alerts routed to a human, with runbooks linked.
- Load test passed at expected peak with headroom.
- SLOs documented and an error budget agreed.
- On-call and incident process assigned.
- Retention and compliance requirements signed off.

---

## 4. Runtime fork: long-running vs serverless

| Concern  | Long-running (Bun, Docker, Fly, Railway, Render, K8s) | Serverless (Vercel, Cloudflare, Lambda)                |
| -------- | ----------------------------------------------------- | ------------------------------------------------------ |
| HTTP     | `Bun.serve` or a container                            | Platform handler                                       |
| Postgres | `pg` pool plus PgBouncer                              | Neon HTTP driver or a pooler with `max: 1`, Hyperdrive |
| Redis    | `ioredis` over TCP                                    | Upstash REST                                           |
| Jobs     | BullMQ plus a separate worker                         | QStash, Cloudflare Queues, SQS                         |
| Cron     | BullMQ repeatable jobs or a managed scheduler         | Platform cron                                          |
| Metrics  | Prometheus scrape                                     | OTLP push, no scrape                                   |
| Tracing  | Long-lived NodeSDK                                    | Flush through `waitUntil`                              |
| Shutdown | `SIGTERM` drain                                       | None                                                   |
| Files    | Local temp is fine                                    | R2 or S3 only                                          |

Choose one model before scaffolding. This template assumes the left column. `.agents/skills/convert-to-serverless/SKILL.md` documents the migration to the right column.

---

## 5. Agent skills and MCPs

Encode backend rules as skills and give agents read-only access to the systems they need.

### Skills

OpenCode discovers skills in `.opencode/skills/<id>/SKILL.md`, and also in `.agents/skills`, `.claude/skills`, and `~/.config/opencode/skills`. A skill is a folder with `SKILL.md` plus optional `references/` and `scripts/`.

This repo already has:

- `backend-engineering-rules`: the non-negotiables for queries, transactions, idempotency, errors, security, migrations, and tests.
- `convert-to-serverless`: the BullMQ to QStash and ioredis to Upstash migration path.
- `customize-hono-template`: renaming and branding a new service.

Add project-specific skills as patterns repeat:

- `api-contract`: how to add a module, schema, route, error codes, and regenerate OpenAPI.
- `db-migration`: expand and contract rules, index conventions, and the backfill procedure.
- `job-authoring`: how to add a queue, a typed job, retries, and dead-letter handling.
- `security-review`: the checklist to run before merging an endpoint.
- `incident-response`: how to triage alerts and write the postmortem.
- `release`: version bump, changelog, deploy, and rollback.

Keep skills short and link to real files. A skill that restates the README is noise.

### MCPs

Add only what you will use. Each server's tools consume context. Configure with `opencode mcp add` or in `opencode.jsonc`:

```jsonc
{
  "mcp": {
    "servers": {
      "context7": {
        "type": "remote",
        "url": "https://mcp.context7.com/mcp",
      },
      "sentry": {
        "type": "remote",
        "url": "https://mcp.sentry.dev/mcp",
      },
    },
  },
}
```

Useful for backend work:

- **context7**: current framework and library docs for Hono, Drizzle, Better Auth, and BullMQ.
- **Postgres or Neon MCP**: inspect schema, run read-only queries, and explain plans. Point it at staging or local, never production writes.
- **Sentry MCP**: pull issue context, stack traces, and recent events.
- **Cloudflare or Vercel MCP**: deployments, logs, and resource state.
- **GitHub MCP**: pull requests, issues, and CI runs.
- **Playwright MCP**: drive the API or admin UI for verification.

Guardrails: read-only credentials, no production write access, a separate token per environment, and no secret that the server does not need. `opencode mcp list` shows connection state, and OAuth is managed with `/mcps` or `opencode mcp auth <name>`.

---

## 6. The 80/20 version

If you only do ten things before your first real user:

1. A validated env schema that fails fast.
2. One error contract with request IDs.
3. Migrations, never `push`, with a restore drill.
4. Auth plus resource-level authorization.
5. Rate limiting with a shared store.
6. Structured logs, traces, and basic RED metrics.
7. Liveness and readiness split, plus graceful shutdown.
8. Timeouts on every outbound call.
9. Integration tests in CI for every endpoint.
10. Alerts that page a human, each with a runbook.

Everything else in the inventory is scale-driven (replicas, caching, read replicas), risk-driven (MFA, audit, compliance), or integration-driven (webhooks, outbox, payments).
