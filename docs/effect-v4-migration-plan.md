# Effect v4 rewrite plan

Status: complete. All nine phases are implemented; the sections below record the design as built.
Versions were checked against the npm registry on 2026-11-20.

## 1. Decisions

| #   | Topic           | Decision                                                                                                |
| --- | --------------- | ------------------------------------------------------------------------------------------------------- |
| D1  | Scope           | Full rewrite. The current `src/` is deleted and rebuilt.                                                |
| D2  | Runtime         | Bun, through `@effect/platform-bun`.                                                                    |
| D3  | HTTP            | `effect/http` + `effect/http-api`. Hono is removed.                                                     |
| D4  | Database        | `drizzle-orm@1.0.0-rc.6` on `drizzle-orm/effect-postgres` + `@effect/sql-pg`.                           |
| D5  | Observability   | OpenTelemetry only (Effect's built-in OTLP exporter). Prometheus and `/metrics` are removed.            |
| D6  | Errors          | Sentry through `@sentry/effect`. Traces go to both the OTLP backend and Sentry (section 6.3).           |
| D7  | Rate limiting   | Token bucket, `RateLimiter` with the Redis store, guarded by `CircuitBreaker`.                          |
| D8  | Jobs            | `PersistedQueue` on the jobs Redis. BullMQ is removed.                                                  |
| D9  | Email templates | A small escaping `html` tagged template (section 6.8). No JSX, and `hono` is removed entirely.          |
| D10 | Module files    | `<module>.api.ts` + `<module>.handlers.ts` replace `<module>.router.ts`. AGENTS.md is updated to match. |

## 2. Dependencies

Pin every Effect package to the same exact version. They release together, and `http-api`, `persistence`,
`observability` and `sql` are still tagged `@stability unstable`.

| Package                                               | Version      | Used for                                                                               |
| ----------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------- |
| `effect`                                              | `4.1.5`      | Core, Schema, Config, HTTP, HttpApi, OTLP, RateLimiter, CircuitBreaker, PersistedQueue |
| `@effect/platform-bun`                                | `4.1.5`      | `BunRuntime`, `BunHttpServer`, `BunRedis`                                              |
| `@effect/sql-pg`                                      | `4.1.5`      | `PgClient`                                                                             |
| `drizzle-orm` / `drizzle-kit`                         | `1.0.0-rc.6` | Queries, schema, migrations                                                            |
| `@sentry/effect`                                      | `11.16.0`    | Error reporting, Sentry tracing                                                        |
| `better-auth`, `@better-auth/drizzle-adapter`         | latest 1.7.x | Auth. The adapter peer range accepts drizzle `>=1.0.0-rc.1`                            |
| `pg`                                                  | 8.x          | Driver for `@effect/sql-pg` and the auth pool                                          |
| `nodemailer`                                          | 10.x         | SMTP transport                                                                         |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | 3.x          | Object storage. Effect has no S3 client.                                               |
| `@scalar/openapi-to-markdown`                         | 1.x          | `/llms.txt`                                                                            |

**Removed:** `hono` and all `@hono/*` packages, `hono-openapi`, `hono-pino`, `@scalar/hono-api-reference`, all
`@opentelemetry/*` packages, `@sentry/bun`, `@sentry/hono`, `bullmq`, `bullmq-otel`, `cockatiel`, `ioredis`,
`pino`, `prom-client`, `rate-limiter-flexible`, `zod`.

## 3. Architecture

### 3.1 The one rule for dependency injection

> **Every service owns its layer, and that layer already includes the service's own dependencies.**

A service file is read top to bottom: its config, its interface, how it is built, what it needs. No other file
wires it up. The entry points only list _what the process runs_, never _how services connect_.

```ts
// src/platform/mailer.ts
export class Mailer extends Context.Service<Mailer, {
  readonly send: (message: OutboundEmail) => Effect.Effect<{ messageId: string }, MailerError>
  readonly check: Effect.Effect<void, MailerError>
}>()("app/Mailer") {
  static readonly layer = Layer.effect(
    Mailer,
    Effect.gen(function* () {
      const config = yield* MailerConfig
      const transport = yield* Effect.acquireRelease(
        Effect.sync(() => createTransport(config.url)),
        (transport) => Effect.sync(() => transport.close()),
      )
      const send = Effect.fn("Mailer.send")(function* (message: OutboundEmail) { /* … */ })
      return Mailer.of({ send, check: /* … */ })
    }),
  )
}
```

A service with dependencies provides them in its own `layer`:

```ts
export class EmailService extends Context.Service<EmailService, { … }>()("app/EmailService") {
  static readonly layer = Layer.effect(EmailService, make).pipe(
    Layer.provide([EmailQueue.layer, Mailer.layer]),
  )
}
```

Effect memoizes layers by reference within one build. `Database.layer` is built once, no matter how many
service layers include it. Entry points stay short:

```ts
// src/main.ts
const ApiLive = HttpServer.layer.pipe(Layer.provide(Observability.layer));
BunRuntime.runMain(Layer.launch(ApiLive));
```

The same conventions apply to every service:

- **Key:** `app/<Name>`. The key string is the runtime identity.
- **Instance layer:** `static readonly layer`. A `static layerTest(...)` sits next to it when tests need a fake.
- **Methods:** `Effect.fn("<Service>.<method>")`. Every call then gets a span with no extra code.
- **Errors:** `Schema.TaggedError` classes in the module's `*.error.ts`, never a thrown `Error`.
- **Resources:** `Effect.acquireRelease` inside `make`. Shutdown comes for free.
- **No globals:** no `globalThis` caches and no module-level singletons.

### 3.2 Configuration

- **One place:** every env var is declared in `src/config.ts`, grouped by domain (`HttpConfig`, `DatabaseConfig`, `RedisConfig`, …).
- **Plain values:** each group is a plain `Config` value, not a service. A service reads it with `yield* DatabaseConfig` inside its `make`.
- **Secrets:** they use `Config.redacted`, so they never appear in logs or errors.
- **Paired values:** pairs that must be set together (S3 keys, SMTP credentials, Google OAuth) are `Config.mapOrFail` checks.
- **Fail fast:** every layer is built at boot, so a bad env value fails `Layer.launch` before the port binds.
- **Tests:** they swap the source with `ConfigProvider.fromUnknown({...})` instead of mutating `process.env`.

This keeps one file that lists every variable a deployer must set, and no extra DI wiring for config.

### 3.3 Process model

| Entry            | Runs                  | Command                  |
| ---------------- | --------------------- | ------------------------ |
| `src/main.ts`    | HTTP API              | `bun run src/main.ts`    |
| `src/worker.ts`  | Queue consumers       | `bun run src/worker.ts`  |
| `src/migrate.ts` | Migrations, then exit | `bun run src/migrate.ts` |

Each entry is `BunRuntime.runMain(Layer.launch(...))`. On SIGTERM the main fiber is interrupted and every
finalizer runs in reverse build order. The two hand-written `shutdown()` functions go away.

HTTP shutdown sequence: set a `Ref` so `/readyz` returns 503, wait `SHUTDOWN_GRACE_MS` for the load balancer to
notice, then stop the server. The server drains in-flight requests, and then the pools and queues close.

## 4. Project layout

```
src/
  main.ts  worker.ts  migrate.ts
  config.ts                      # every env var, grouped by domain

  platform/                      # infrastructure, one service per file
    database.ts                  # Database (EffectPgDatabase) + PgClient layer
    database.error.ts            # SQLSTATE → domain error mapping
    redis.ts                     # CacheRedis, JobsRedis
    storage.ts                   # Storage (S3)
    mailer.ts                    # Mailer (nodemailer)
    observability.ts             # Logger + OTLP + Sentry layers

  http/
    api.ts                       # the HttpApi: every group, shared errors, prefix
    errors.ts                    # error schemas + JSON error contract
    middleware.ts                # request id, CORS, security headers, body limit, timeout
    rate-limit.ts                # RateLimit HttpApiMiddleware (token bucket + breaker)
    docs.ts                      # /openapi.json, /docs (Scalar), /llms.txt
    server.ts                    # BunHttpServer + HttpApiBuilder + auth route + docs

  auth/
    auth.ts                      # BetterAuth service
    auth.middleware.ts           # Authenticated / OptionalSession middleware, CurrentUser
    auth.error.ts

  api/
    health/
      health.api.ts              # HttpApiGroup: endpoints + schemas they reference
      health.handlers.ts         # HttpApiBuilder.group: thin, calls the service
      health.schema.ts           # Schema DTOs
      health.service.ts          # HealthService: readiness probes, cached

  jobs/
    job.ts                       # defineJob + runner helper
    queues.ts                    # queue definitions (name, payload schema, options)
    email.job.ts  example.job.ts
    worker.ts                    # WorkerLive: starts consumers for every queue

  integrations/
    email/
      html.ts                    # escaping tagged template
      layout.ts                  # shared layout, button, heading helpers
      templates/  welcome.ts  verify-email.ts  password-reset.ts
      email.service.ts           # EmailService.enqueue / render
    paystack/
      paystack.client.ts         # PaystackClient service on HttpClient
      paystack.schema.ts         # request/response schemas
      paystack.error.ts
      paystack.webhook.ts        # signature verification + parsing

  db/
    schema/  relations.ts  migrations/

tests/
  support/                       # test layers, ConfigProvider helper, HttpApiTest client
  unit/  integration/
scripts/
  openapi.ts  seed.ts
```

Request flow through an `api` module:

1. `health.api.ts` declares what the endpoint accepts and returns. That declaration drives the OpenAPI spec and the typed client.
2. `health.handlers.ts` maps each endpoint to a service call. It holds no logic.
3. `health.service.ts` does the work. It is a normal service with its own `layer`.

## 5. HTTP layer

### 5.1 Pipeline order

1. **Request id:** `x-request-id` is read or generated, echoed back, and added as a log annotation and span attribute, along with the trace and span ids.
2. **Tracing and access log:** the built-in server span, plus our own access log (health probes log at debug level). The built-in logger is disabled.
3. **Security headers + CORS:** CORS uses the same trusted-origin list as Better Auth.
4. **Body limit + timeout:** body size limit and a per-request `Effect.timeout`, which returns 503.
5. **Unprotected routes:** `/healthz` and `/readyz`, outside the rate limiter. `/readyz` caches its probes for 2 s.
6. **Better Auth:** `/api/auth/*`. It has its own Redis-backed limiter.
7. **`HttpApi` groups under `/v1`:** the `RateLimit` middleware applies to every group, and `Authenticated` to the groups that declare it.
8. **Docs:** `/openapi.json`, `/docs` and `/llms.txt`, only when `DOCS_ENABLED`.

### 5.2 Error contract

Errors are RFC 9457 problems (`application/problem+json`), using Effect's built-in `HttpApiError.Problem` and `HttpApiMiddleware.ProblemDetails`. This replaces the old `{ success: false, error: {...} }` envelope.

- **Shared problems:** `src/http/errors.ts` defines `BadRequest`, `Unauthorized`, `Forbidden`, `NotFound`, `Conflict`, `ValidationFailed` (422 with `errors`), `TooManyRequests`, `InternalServerError` and `ServiceUnavailable`. Endpoints declare the ones they return, so they appear in OpenAPI and in the typed client.
- **Invalid input:** `ProblemDetails` turns request decode failures into a 400 problem whose `errors` lists `{ path, message }` per field, with the first path segment naming the slot (`payload`, `query`, ...).
- **Database errors:** a defect or failure carrying a Postgres error is classified by `database.error.ts` and answered with the matching problem (409, 422, 400, 503), so services may `Effect.orDie` database errors and still give the client the right status.
- **Unknown routes, parse errors, defects:** `renderFailures` in `src/http/middleware.ts` renders them as problems. 5xx are logged with the cause and passed to `ErrorReporter.report`, so they reach Sentry. Defect messages never reach the client.
- **Request id:** `x-request-id` is in the response headers and on every log line of the request, not in the body. A wrong method on a known path is a 404; the router has no 405.

### 5.3 Rate limiting: token bucket

- **Service:** `RateLimits` (`src/platform/rate-limits.ts`) wraps Effect's `RateLimiter` with `algorithm: "token-bucket"` on the cache Redis. It returns a decision (`Allowed`, `Limited`, `Unavailable`) and never fails, so the HTTP middleware, Better Auth and job throttling can share it.
- **Breaker:** the store call has a 100 ms timeout inside a `CircuitBreaker` (rate policy, in-memory per process). The classifier counts only store errors and timeouts, never a 429. Circuit transitions are logged once.
- **Middleware:** `RateLimit` (`src/http/rate-limit.ts`) is an `HttpApiMiddleware` applied in `api.ts` to every feature group (added before `.middleware(RateLimit)`); health probes are added after it and are exempt.
- **Headers:** `X-RateLimit-Limit`, `X-RateLimit-Remaining` from the bucket itself, and `Retry-After` on 429.
- **Per-endpoint policy:** `.annotate(RateLimitPolicy, { bucket, capacity, refillWindow, cost })`.
- **Client key:** the remote address. `TRUSTED_PROXIES` (CIDRs) enables Effect's `xForwardedHeaders`, which only believes proxies in those networks.
- **Store down:** `RATE_LIMIT_FAIL_MODE=open` (default) serves the request; `closed` answers 503.

## 6. Services

### 6.1 Database

- **Client:** `PgClient.layer` with pool size, idle timeout, connect timeout, `applicationName` and `statement_timeout` (startup parameter) from config. `@effect/sql-pg` v4 speaks the wire protocol itself and Drizzle's own codecs parse column types, so the `pg` package is only needed for Better Auth's pool.
- **Service:** `Database` = `PgDrizzle.make({ relations })`. It uses `EffectLogger.layer` in development and the no-op logger in production.
- **Transactions:** `db.transaction(...)` delegates to `SqlClient.withTransaction`, which is fiber-scoped: any `db` call made inside it, from any service, joins the transaction. Verified by an integration test, so services never take a `tx` argument.
- **Migrations:** `drizzle-kit@rc generate` writes them, and `src/migrate.ts` runs `migrate()` from `drizzle-orm/effect-postgres/migrator`.

### 6.2 Redis

- **Two instances:** `CacheRedis` (fail fast while disconnected, no offline queue) and `JobsRedis` (offline queue on), each a `BunRedis` client on Bun's native Redis.
- **Why two:** both expose Effect's `Redis` service, so each consumer gets its instance provided locally through `CacheRedis.asRedis` / `JobsRedis.asRedis`. The rate limiter gets the cache instance and the queue store will get the jobs instance.
- **Connecting:** the client connects while the layer builds. If Redis is down at boot the process still starts and retries in the background (exponential, capped at 5 s); verified that readiness recovers within seconds both after a cold start without Redis and after a mid-run outage.
- **Readiness:** `/readyz` pings the cache Redis.

### 6.3 Observability

All telemetry leaves the process as OpenTelemetry; Sentry also gets every unexpected error.

| Signal  | Destination                                                                                                                                                                                                                  |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Traces  | `Otlp.layerJson` to `OTEL_EXPORTER_OTLP_ENDPOINT` (the collector), which fans out to Grafana LGTM and, with `observability/collector.sentry.yml`, to Sentry's OTLP endpoint.                                                 |
| Logs    | Console (JSON in production) plus OTLP.                                                                                                                                                                                      |
| Metrics | OTLP, exported every 10 s.                                                                                                                                                                                                   |
| Errors  | `Sentry.effectLayer` registers Sentry as an `ErrorReporter`; `reportError` (`src/platform/observability.ts`) reports inside a Sentry scope carrying the active trace and span ids and the `requestId` / `job.*` annotations. |

- **One tracer:** an Effect runtime has exactly one `Tracer`, so fan-out happens in the collector. Without an OTLP endpoint, `SentryEffectTracer` and `SentryEffectLogger` send traces and logs to Sentry directly.
- **Linking:** Sentry's own reporter only sees the `Cause`, so `reportError` adds the trace context. Verified from Bun: a 500 produced one Sentry envelope whose `trace_id` matched the trace the collector received, with the `requestId` tag equal to the response's `x-request-id`.
- **Privacy:** `dataCollection` turns off user info, cookies, request bodies and query strings.
- **Metrics:** `http.server.request.duration` (method, status code), `rate_limit.decisions` (decision), `storage.operation.duration` (operation, outcome), `jobs.processed` and `jobs.duration` (queue, outcome), `email.delivered` (outcome). Attributes are low-cardinality by design. Verified arriving from both the API and the worker through a collector.
- **Local stack:** `docker-compose.observability.yml` runs the collector and `grafana/otel-lgtm` (Grafana on :3001); `docker-compose.observability.sentry.yml` adds the Sentry exporter. Both collector configs pass `otelcol validate`.

### 6.4 Auth (Better Auth)

- **`BetterAuth` service** (`src/auth/auth.ts`): `createAuth` is a pure factory (also used by `scripts/openapi.ts`). The adapter is Promise-based, so it gets drizzle's `pg-proxy` driver whose queries run on the app's `@effect/sql-pg` client: one pool, the same statement timeout, SQL spans (under `BetterAuth.query`) and metrics. The `pg` package is not used. `pg-proxy` has no transactions; Better Auth's adapter does not use them by default (`transaction: false`).
- **Callbacks** run Effects through the context the layer captured: rate-limit storage uses the shared token-bucket `RateLimits` (fails open), Better Auth's log lines go to the Effect logger (message only), and auth emails go to `sendEmail`, which phase 6 points at the email queue.
- **Client IP:** the auth route strips any incoming `x-client-ip` and sets it from the address the HTTP pipeline resolved (`TRUSTED_PROXIES` aware); Better Auth reads only that header.
- **Route:** `/api/auth/*` bridges to `auth.handler` with `HttpServerRequest.toWeb` / `HttpServerResponse.fromWeb`.
- **Middleware:** `Authenticated` (cookie security scheme in OpenAPI) resolves the session from the request headers and provides `CurrentUser` and `CurrentSession`; no session is a 401 problem.
- **Example module:** `src/api/account` serves `GET /v1/me`, versioned, rate limited and authenticated.
- **Schema:** `src/db/schema/auth.ts` mirrors Better Auth's core tables with `timestamptz` columns; the first migration is `src/db/migrations/*_auth`.
- **OpenAPI:** `/openapi.json`, `/docs` (Scalar from jsDelivr, pinned) and `/llms.txt` serve the HttpApi document merged with Better Auth's, tagged `Auth`. Verified with an end-to-end test (sign-up, session cookie, `/v1/me`, wrong password, duplicate email).

### 6.5 Jobs (PersistedQueue)

- **Queues** (`src/jobs/queue.ts`): `queueLayer(Tag, PayloadSchema, { name, maxAttempts })` builds a `PersistedQueue` on the jobs Redis (`jobs:` prefix) with exponential backoff from 2 s, capped at 10 minutes. A queue is a `Context.Service` declared next to its payload schema (`src/jobs/email.queue.ts`).
- **Producers:** `queue.offer(payload, { id })`; the id is an idempotency key (kept 30 days after completion).
- **Workers** (`src/jobs/consume.ts`): `consume(Queue, { ...Queue.options, concurrency }, handler)` runs N fibers looping `take`. Each job gets a span and log annotations (`job.queue`, `job.id`, `job.attempt`). Failures before the last attempt log a warning; the last logs an error and goes to `ErrorReporter` (Sentry). A store failure pauses the worker for 5 s. Shutdown interrupts workers and the job is redelivered.
- **Dead letters:** jobs that exhaust their attempts stay in Redis (`layerCleanup` keeps failed jobs, removes completed ones after 30 days).
- **Worker process:** `src/worker.ts` launches `WorkerLive` (`src/jobs/worker.ts`).
- **Email:** `EmailService.enqueue` validates against the template schema and offers to `EmailQueue`. The job renders, waits for a slot in a shared token bucket (`EMAIL_RATE_PER_SECOND`), and sends through `Mailer` (nodemailer). Transient failures retry; 5xx rejections and stale data are logged, reported and completed. Recipient addresses are never logged.
- **Auth emails:** Better Auth's welcome, verification and reset emails go through `EmailService`; the welcome email is keyed by user id. Verified live: sign-up succeeds with the relay down, the job retries, and the email is delivered once Mailpit is back.

### 6.6 Storage (S3)

- **API:** `Storage` (`src/platform/storage.ts`) exposes `put`, `remove`, `presignUpload`, `presignDownload` and `check`. Each call has a timeout (`S3_REQUEST_TIMEOUT_MS`, aborting the SDK request), a span, and fails with `StorageError`. A second client signs URLs for `S3_PUBLIC_ENDPOINT` when set.
- **Bucket bootstrap:** with `S3_AUTO_CREATE_BUCKET` the layer creates a missing bucket at startup; failure is logged and `/readyz` reports it instead of stopping the boot.
- **Readiness:** `/readyz` includes `storage` (HeadBucket). Verified against S3Mock (put, presigned GET, presigned PUT, delete) and on a real server with storage unreachable (boots, 503).

### 6.7 Paystack

- **Client:** `PaystackClient` (`src/integrations/paystack/paystack.client.ts`) on `HttpClient`: base URL and bearer key applied once, a timeout per call, the `{ status, message, data }` envelope unwrapped and `data` decoded with a schema. Helpers cover transactions, authorization charges, refunds, banks, account resolution, recipients and transfers; `request` covers any other endpoint.
- **Errors:** `PaystackError` with `reason` `Network` (outcome unknown, verify by reference), `Api` (Paystack refused, with its message and status) or `Decode`.
- **Retries:** GET requests retry network failures (3 times, jittered backoff). Anything that can move money never retries automatically and requires a caller `reference`.
- **Webhooks:** `verifyWebhookSignature` (constant-time HMAC-SHA512 over the raw body) and `paystackWebhookRoute(path, onEvent)`, which reads the raw text, answers 401/400 problems for bad signatures or payloads, and calls the handler with a decoded event. It is not mounted by default.

### 6.8 Email templates without JSX

The lightest option: a ~30-line tagged template with no dependency. It escapes every interpolated value by
default and allows explicit `raw()` and nested `html` fragments.

```ts
// src/integrations/email/templates/welcome.ts
export const welcome = defineEmail({
  schema: Schema.Struct({ name: Schema.NonEmptyString, loginUrl: Url }),
  subject: ({ name }) => `Welcome to Acme, ${name}`,
  render: ({ name, loginUrl }) =>
    layout({
      preview: "Your account is ready.",
      body: html`
        ${heading(html`Welcome, ${name}`)}
        ${paragraph("Thanks for signing up. Your account is ready to use.")}
        ${button({ href: loginUrl, label: "Sign in" })}
      `,
    }),
});
```

- **What goes away:** the `hono` dependency, the `jsx`/`jsxImportSource` tsconfig settings, and the `.tsx` files.
- **Escaping:** escape-by-default means a user's name can't inject markup. Unit tests cover the escaping.
- **Plain text:** the same `htmlToText` fallback stays, and a template may still supply its own `text`.

## 7. Production readiness

These close the gaps listed in `docs/production-backend-guide.md` §2:

- **HTTP hardening:** CORS, security headers, body size limit, per-request timeout, and a `/v1` API prefix.
- **Graceful shutdown:** the readiness flip plus HTTP drain from section 3.3.
- **Health checks:** `/readyz` caches its probes, and health routes sit outside the rate limiter.
- **Idempotency keys:** an `IdempotencyKey` middleware for write endpoints (Redis, `PersistedCache`).
- **Outbound timeouts:** every outbound call has an explicit timeout.
- **Unit tests:** config validation, error mapping, SQLSTATE mapping, rate-limit keys and headers, `html` escaping, job definitions, and Paystack signature checks.
- **Integration tests** against `docker-compose.test.yml`:
  - health and readiness
  - auth sign-up and sign-in
  - a protected route (401 vs 200)
  - token-bucket 429 behavior
  - the email queue end to end through Mailpit
- **CI:** lint, format, typecheck, unit tests, an integration job with service containers, `docker build`, and `bun audit`.
- **Docker:** one image with three commands (api, worker, migrate). Migrations run as a release step, not on boot.

## 8. Execution phases

Each phase ends with `typecheck`, `lint` and its own tests green.

1. ✅ **Skeleton:** dependencies, tsconfig, `config.ts`, `observability.ts`, and `main.ts` serving `/healthz` on `BunHttpServer`. Delete the old `src/`.
2. ✅ **Database:** drizzle rc, the `Database` service, migrate entry, drizzle-kit config, the SQLSTATE mapping with tests, and a transaction-composition check.
3. ✅ **HTTP contract:** `HttpApi`, error schemas, middleware pipeline, health and readiness, docs routes.
4. ✅ **Redis + rate limit:** both Redis layers, token-bucket middleware, circuit breaker.
5. ✅ **Auth:** `BetterAuth` service, auth route, `Authenticated` middleware, the OpenAPI merge script.
6. ✅ **Jobs + email:** `PersistedQueue` definitions, worker, `Mailer`, `html` templates, `EmailService`.
7. ✅ **Integrations:** `Storage`, `PaystackClient`.
8. ✅ **Sentry + OTLP:** collector fan-out config, a real Sentry event and trace checked from Bun.
9. ✅ **Tests, CI, Docker, docs:** README, AGENTS.md, the repo skills (backend rules, serverless conversion, customize template), the production guide scorecard, `.env.example`.

## 9. Risks

| Risk                                                                                                                               | Mitigation                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `http-api`, `persistence`, `observability` and `sql` can break in minor releases.                                                  | Exact pins. All Effect packages upgrade together.                                                    |
| `drizzle-orm` 1.0 is still RC, and its Effect driver rejects some column types (`timestamptz` string mode, `enum[]`, `vector`, …). | Exact pin. Use `timestamptz` in `date` mode. Check the generated Better Auth schema.                 |
| `@sentry/effect` is alpha, built on `@sentry/node`, and Bun isn't listed.                                                          | Phase 8 sends a real event from Bun. Fallback: `@sentry/bun` plus a ~20-line custom `ErrorReporter`. |
| `PersistedQueue` is young and has no dashboard.                                                                                    | Metrics, dead-letter reporting, and the cleanup layer. Integration test for the full path.           |
| Trace fan-out depends on the collector.                                                                                            | Without a collector, the app falls back to `SentryEffectTracer` directly (section 6.3).              |
| `BunRedis` may lack features we need.                                                                                              | One-file `ioredis` fallback that implements Effect's `Redis` interface.                              |
| Better Auth keeps its own Promise pool.                                                                                            | Small fixed size, closed by a finalizer, documented next to `DB_POOL_MAX`.                           |
