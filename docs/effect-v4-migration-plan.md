# Effect v4 rewrite plan

A full rewrite of the template on Effect v4. Nothing from the current `src/` is kept as-is.
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

1. **Request id:** `x-request-id` is read or generated, echoed back, and added as a log annotation and span attribute.
2. **Tracing and access log:** `HttpMiddleware.tracer` and `HttpMiddleware.logger`, both built in.
3. **Security headers + CORS:** CORS uses the same trusted-origin list as Better Auth.
4. **Body limit + timeout:** body size limit and a per-request `Effect.timeout`, which returns 503.
5. **Unprotected routes:** `/healthz` and `/readyz`, outside the rate limiter. `/readyz` caches its probes for 2 s.
6. **Better Auth:** `/api/auth/*`. It has its own Redis-backed limiter.
7. **`HttpApi` groups under `/v1`:** the `RateLimit` middleware applies to every group, and `Authenticated` to the groups that declare it.
8. **Docs:** `/openapi.json`, `/docs` and `/llms.txt`, only when `DOCS_ENABLED`.

### 5.2 Error contract

The current JSON body stays, so clients don't break:
`{ success: false, error: { code, message, fields?, details? }, requestId, path }`.

- **Shared errors:** `Schema.TaggedError` classes with an `httpApiStatus` annotation: `BadRequest`, `Unauthorized`, `SessionExpired`, `Forbidden`, `NotFound`, `Conflict`, `ValidationFailed`, `TooManyRequests`, `ServiceUnavailable`, `InternalServerError`. They are declared on the `HttpApi`, so they appear in OpenAPI and in the typed client.
- **Invalid input:** request decode failures become `ValidationFailed` with up to 20 `fields`.
- **Database errors:** `database.error.ts` ports the SQLSTATE tables. It unwraps `EffectDrizzleQueryError` / `SqlError` to reach the pg error and never logs `params`.
- **Unmapped failures and defects:** a 500 with a generic message in production. They are reported through `Effect.withErrorReporting`, so they reach Sentry. 4xx errors are annotated `ErrorReporter.ignore`.
- **Other responses:** one outer middleware formats 404, 405 and anything else that escaped, so every error has the same shape.

### 5.3 Rate limiting: token bucket

```ts
rateLimiter.consume({
  algorithm: "token-bucket",
  key: `global:${clientKey}`,
  limit: config.capacity, // RATE_LIMIT_CAPACITY, bucket size (burst)
  window: config.refillWindow, // RATE_LIMIT_REFILL_WINDOW, time to refill the whole bucket
  tokens: endpointCost, // default 1; expensive endpoints can cost more
  onExceeded: "fail",
});
```

- **Store:** `RateLimiter.layerStoreRedis`, provided with the cache Redis.
- **Breaker:** the store call runs inside `CircuitBreaker` (rate trip policy). A classifier counts only timeouts and connection errors as failures, which resolves the TODO.md item.
- **Store down:** a 100 ms timeout. Fail-open or fail-closed is set per limiter, and state changes are logged once.
- **Response headers:** `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `Retry-After`, computed from the `ConsumeResult`.
- **Client key:** taken from `X-Forwarded-For` only when `TRUST_PROXY_HEADERS` is on. Unknown addresses get their own bucket instead of sharing the global one.
- **Per-route limits:** the middleware reads an endpoint annotation (`RateLimit.cost`, `RateLimit.policy`), so a route can have a stricter bucket without new middleware.

## 6. Services

### 6.1 Database

- **Client:** `PgClient.layer` with pool size, idle timeout, connect timeout, `applicationName` and `statement_timeout` (startup parameter) from config. `@effect/sql-pg` v4 speaks the wire protocol itself and Drizzle's own codecs parse column types, so the `pg` package is only needed for Better Auth's pool.
- **Service:** `Database` = `PgDrizzle.make({ relations })`. It uses `EffectLogger.layer` in development and the no-op logger in production.
- **Transactions:** `db.transaction(...)` delegates to `SqlClient.withTransaction`, which is fiber-scoped: any `db` call made inside it, from any service, joins the transaction. Verified by an integration test, so services never take a `tx` argument.
- **Migrations:** `drizzle-kit@rc generate` writes them, and `src/migrate.ts` runs `migrate()` from `drizzle-orm/effect-postgres/migrator`.

### 6.2 Redis

- **Two instances:** `CacheRedis` (`allkeys-lru`) and `JobsRedis` (`noeviction` + AOF), each its own `BunRedis.layerConfig`.
- **Why two:** both expose Effect's `Redis` service, so each consumer gets its instance provided locally. The rate limiter gets the cache instance and the queue store gets the jobs instance, and the two can never be swapped by accident.
- **Fallback:** if `BunRedis` lacks something we need (Lua `eval` for the Better Auth limiter, command timeouts), we write a one-file `Redis` implementation over `ioredis`.

### 6.3 Observability

All telemetry leaves the process as OpenTelemetry, and Sentry also gets every error.

| Signal  | Destination                                                                                                                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Traces  | `Otlp.layer` sends them to `OTEL_EXPORTER_OTLP_ENDPOINT` (the collector). The collector fans out to your trace backend **and** to Sentry's OTLP ingest endpoint.                                                          |
| Logs    | `Otlp.layer`, plus a console JSON logger (pretty in development) so container logs still work.                                                                                                                            |
| Metrics | `Otlp.layer`, OTLP metrics only.                                                                                                                                                                                          |
| Errors  | `Sentry.effectLayer`, which registers Sentry as an `ErrorReporter`. `SentryEffectExternalSpanLayer` stamps each error with the active trace id, so Sentry links the error to the trace it received through the collector. |

- **Fan-out in the collector:** an Effect runtime has exactly one `Tracer`. Fanning out in the collector keeps the app on a single tracer and sends traces to both destinations.
- **Collector config:** `observability/otel-collector.yml` gains a Sentry `otlphttp` exporter. `docker-compose.observability.yml` swaps Prometheus for a trace UI (Jaeger) and keeps the collector.
- **Without a collector:** if only `SENTRY_DSN` is set, the app uses `SentryEffectTracer` and `SentryEffectLogger` directly. If neither is set, only console logs.
- **Metric names:** `http.server.*` comes from the built-in HTTP middleware, and SQL spans come from `@effect/sql`. The rest are custom: `storage.operations`, `email.sent`, `jobs.processed`, `jobs.dead_lettered`, `rate_limit.rejected`, `circuit_breaker.state`.

### 6.4 Auth (Better Auth)

- **`BetterAuth` service:** builds the Better Auth instance inside `make`.
  - **Its own pool:** a small dedicated `pg.Pool` with `drizzle-orm/node-postgres` from the same rc, because the adapter needs Promises. The pool is closed by a finalizer.
  - **Callbacks:** it captures the current context with `Effect.context()`, so callbacks run Effects through `Effect.runPromiseWith(context)`. The welcome, verify and reset hooks call `EmailService.enqueue` directly, with no dynamic `import()` workaround.
  - **Rate-limit storage:** the same token-bucket `RateLimiter` service.
- **Route:** `/api/auth/*` converts the request to a web `Request` (`HttpServerRequest.toWeb`), calls `auth.handler`, and converts the result back with `HttpServerResponse.fromWeb`.
- **Middleware:** `Authenticated` is an `HttpApiMiddleware` with a cookie security scheme. It provides `CurrentUser` and `CurrentSession`, and `OptionalSession` is the non-failing variant. Handlers read `yield* CurrentUser`, which replaces `getSessionUser(c)`.
- **OpenAPI:** `scripts/openapi.ts` merges `OpenApi.fromApi(Api)` with Better Auth's generated schema (tagged `Auth`) into `openapi.json`.

### 6.5 Jobs (PersistedQueue)

```ts
// src/jobs/queues.ts
export const EmailQueue = defineQueue({
  name: "email",
  payload: SendEmailPayload, // Schema, validated on offer and on take
  concurrency: 10,
  maxAttempts: 3,
  retry: Schedule.exponential("1 second").pipe(Schedule.jittered),
  throughput: { limit: 10, window: "1 second" }, // relay ceiling, token bucket
});
```

- **Producers:** `yield* EmailQueue.offer(payload, { id })`. The `id` is the idempotency key, and `deduplicate: "untilExecuted"` collapses double enqueues.
- **`WorkerLive`:** starts `concurrency` fibers per queue, each looping `take(handler)`. A handler runs in a span annotated with `job.id`, `job.attempt` and `queue`.
- **Throughput:** limited with `RateLimiter.consume({ algorithm: "token-bucket", onExceeded: "delay" })`.
- **Dead letter:** when `isDeadLetterCause(cause)` is true, the job is logged at error level, reported to Sentry, and counted in `jobs.dead_lettered`. The payload stays in Redis for inspection.
- **Cleanup:** `PersistedQueue.layerCleanup` runs in the worker.
- **Dashboard:** Bull Board goes away. The README documents inspecting queues through `redis-cli` and the metrics instead.

### 6.6 Storage (S3)

- **API:** the `Storage` service exposes `put`, `remove`, `presignUpload`, `presignDownload`, `ensureBucket` and `check`.
- **Wrapping:** each method wraps AWS SDK calls in `Effect.tryPromise` with a timeout, a span, and a `StorageError`. The separate public-endpoint presign client stays.
- **Bucket creation:** `ensureBucket` runs at layer build when `S3_AUTO_CREATE_BUCKET` is set.

### 6.7 Paystack

- **Client:** the `PaystackClient` service runs on `HttpClient` with the base URL and bearer token applied once.
- **Responses:** every response is decoded with Schema into `PaystackError` variants: `Network`, `Http`, `Decode`, `Api`.
- **Retries:** reads retry transient failures with jittered backoff. Money-moving calls never retry automatically and require a caller-supplied `reference`, the idempotency key.
- **Webhooks:** verification stays a pure function (`timingSafeEqual` on HMAC-SHA512), plus a ready-to-mount webhook endpoint that reads the raw body.

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
3. **HTTP contract:** `HttpApi`, error schemas, middleware pipeline, health and readiness, docs routes.
4. **Redis + rate limit:** both Redis layers, token-bucket middleware, circuit breaker.
5. **Auth:** `BetterAuth` service, auth route, `Authenticated` middleware, the OpenAPI merge script.
6. **Jobs + email:** `PersistedQueue` definitions, worker, `Mailer`, `html` templates, `EmailService`.
7. **Integrations:** `Storage`, `PaystackClient`.
8. **Sentry + OTLP:** collector fan-out config, a real Sentry event and trace checked from Bun.
9. **Tests, CI, Docker, docs:** README, AGENTS.md, the repo skills (backend rules, serverless conversion, customize template), the production guide scorecard, `.env.example`.

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
