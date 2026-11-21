# Effect API Template

A production-minded API starter on [Bun](https://bun.sh) and [Effect v4](https://effect.website), with the boilerplate most services need already wired up:

- **HTTP:** schema-first `HttpApi` with a generated OpenAPI spec, Scalar docs and RFC 9457 error responses
- **Data:** Postgres through Drizzle ORM (1.0 rc) on `@effect/sql-pg`, with migrations
- **Auth:** Better Auth (email/password, Google, email verification, password reset)
- **Traffic:** Redis token-bucket rate limiting behind a circuit breaker
- **Jobs:** durable Redis queues (Effect `PersistedQueue`) and a separate worker process
- **Integrations:** S3-compatible storage, SMTP email with escaped HTML templates, Paystack payments and webhooks
- **Operations:** OpenTelemetry traces, logs and metrics; Sentry errors linked to traces; graceful shutdown

## Requirements

- [Bun](https://bun.sh) 1.4+
- Docker, for Postgres, Redis, RustFS (S3) and Mailpit

## Getting started

```sh
bun install
cp .env.example .env       # then set BETTER_AUTH_SECRET to a random 32+ character string
docker compose up -d
bun run db:migrate
bun run dev:all            # API on http://localhost:3000 plus the job worker
```

| URL             | Description                                                 |
| --------------- | ----------------------------------------------------------- |
| `/healthz`      | Liveness                                                    |
| `/readyz`       | Readiness: database, both Redis instances, storage          |
| `/v1/me`        | Example authenticated endpoint                              |
| `/api/auth/*`   | Better Auth (sign-up, sign-in, sessions, OAuth)             |
| `/docs`         | Scalar API reference (`DOCS_ENABLED=true`)                  |
| `/openapi.json` | OpenAPI spec, including the auth endpoints (`DOCS_ENABLED`) |
| `/llms.txt`     | The spec as Markdown for LLM tools (`DOCS_ENABLED`)         |

Mailpit shows sent email at http://localhost:8025.

## How the code is organized

```
src/
  main.ts  worker.ts  migrate.ts   Process entry points
  config.ts                        Every environment variable, grouped by domain
  api/<module>/                    Feature modules: <module>.api.ts, .handlers.ts, .schema.ts, .service.ts
  http/                            The HttpApi contract, error types, middleware, docs, server
  auth/                            Better Auth service, /api/auth/* route, Authenticated middleware
  platform/                        Infrastructure services: database, Redis, rate limits,
                                   storage, mailer, observability
  integrations/                    Email templates and EmailService, Paystack
  jobs/                            Queues, job handlers, worker consumers
  db/                              Drizzle schema, relations, migrations
tests/unit  tests/integration      bun test
```

### Services and layers

Every service is a `Context.Service` whose `static layer` already provides its own dependencies, so the entry points only list what each process runs:

```ts
export class AccountService extends Context.Service<AccountService, {...}>()("app/AccountService") {
  static readonly layer = Layer.effect(AccountService, Effect.gen(function* () {
    const db = yield* Database;
    ...
  })).pipe(Layer.provide(Database.layer));
}
```

Resources are opened with `Effect.acquireRelease`, so on shutdown everything closes in reverse order. Environment variables are read only through `src/config.ts`; a missing or invalid value fails the boot.

### Adding an endpoint

1. Declare the endpoints in `src/api/<module>/<module>.api.ts` as an `HttpApiGroup`, with request and response schemas from `<module>.schema.ts` and the errors they can return.
2. Add the group to `src/http/api.ts` (before `.prefix("/v1")` to version and rate-limit it).
3. Implement the logic in `<module>.service.ts` and map endpoints to it in `<module>.handlers.ts`; provide the handlers in `src/http/server.ts`.
4. Protect it with `.middleware(Authenticated)` and read the user with `yield* CurrentUser` (see `src/api/account`).
5. Run `bun run openapi:generate`.

Give an endpoint its own rate limit with `.annotate(RateLimitPolicy, { bucket, capacity, refillWindow, cost })`.

### Error responses

Every error is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem served as `application/problem+json`:

```json
{ "type": "about:blank", "title": "Conflict", "status": 409, "detail": "Resource already exists" }
```

Invalid requests get a `400` with an `errors` array (`{ path, message }` per field). Fail handlers with the classes in `src/http/errors.ts`. Database errors are mapped by SQLSTATE (unique violation → 409, not-null → 422, ...), and unexpected errors become a generic 500 that is logged and reported to Sentry. Every response has an `x-request-id` header that also tags its log lines.

### Database

Tables live in `src/db/schema`. Queries are Effects (`yield* db.select().from(user)`), and `db.transaction(...)` follows the fiber: anything that uses `db` inside it joins the transaction, so services never pass a transaction handle around. After a schema change, run `bun run db:generate` and commit the migration.

### Jobs and email

Queues live in the jobs Redis. To add one: declare it like `src/jobs/email.queue.ts`, write its handler, and add a `consume(...)` line to `src/jobs/worker.ts`. Delivery is at least once, so handlers must be idempotent; pass an `id` when offering a job to make it an idempotency key. Failed jobs retry with exponential backoff; the last failure is logged, reported to Sentry, and kept in Redis as the dead-letter record.

Send email with `EmailService.enqueue({ template, to, data })`. Templates live in `src/integrations/email/templates.ts` and use an `html` tagged template that escapes every value. Sends are throttled across workers by `EMAIL_RATE_PER_SECOND`.

### Storage and payments

`Storage` (`src/platform/storage.ts`) hands out presigned URLs so clients upload and download directly. `PaystackClient` (`src/integrations/paystack`) never retries calls that move money and requires a `reference` for them; `paystackWebhookRoute` verifies Paystack's signature before your handler runs.

### Authentication

[Better Auth](https://better-auth.com) runs at `/api/auth/*`. Its tables in `src/db/schema/auth.ts` mirror Better Auth's core schema; after enabling a plugin that adds tables, add them there and run `bun run db:generate`. Auth emails go through the job queue.

## Observability

- **Logs:** JSON lines in production (pretty locally), tagged with `requestId`, `traceId` and `spanId`.
- **OpenTelemetry:** with `OTEL_EXPORTER_OTLP_ENDPOINT` set, traces, logs and metrics are exported. Locally: `docker compose -f docker-compose.observability.yml up -d`, set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318`, and open Grafana at http://localhost:3001.
- **Sentry:** with `SENTRY_DSN` set, unexpected errors are reported with their trace id and request or job id. To send traces to Sentry as well, add `docker-compose.observability.sentry.yml` with `SENTRY_OTLP_ENDPOINT` and `SENTRY_PUBLIC_KEY`. Without an OTLP endpoint, traces and logs go to Sentry directly.
- **Metrics:** `http.server.request.duration`, `rate_limit.decisions`, `storage.operation.duration`, `jobs.processed`, `jobs.duration`, `email.delivered`.

## Testing

```sh
bun run test:unit
docker compose -f docker-compose.test.yml up -d --wait
bun run test:integration
```

Integration tests use the services in `docker-compose.test.yml` (Postgres, Redis, S3Mock, Mailpit); CI runs the same set.

## Scripts

| Command                                  | Description                                       |
| ---------------------------------------- | ------------------------------------------------- |
| `bun run dev` / `start`                  | API (with / without file watching)                |
| `bun run dev:worker` / `worker`          | Job worker (with / without file watching)         |
| `bun run dev:all`                        | API and worker together                           |
| `bun run db:generate`                    | Generate a migration from the schema              |
| `bun run db:migrate`                     | Apply migrations                                  |
| `bun run db:push`                        | Push the schema directly (local experiments only) |
| `bun run openapi:generate`               | Write `openapi.json` (used by Fern)               |
| `bun run test:unit` / `test:integration` | Run one test layer                                |
| `bun run lint` / `format` / `typecheck`  | Lint, format and type-check                       |

Fern documentation: configure `fern/fern.config.json` and `fern/docs.yml`, then `bunx fern docs dev`.

## Deploying

The Docker image runs any of the three processes:

```sh
docker build -t app .
docker run --rm --env-file .env app bun run src/migrate.ts    # release step
docker run -d --env-file .env -p 3000:3000 app                # API
docker run -d --env-file .env --no-healthcheck app bun run src/worker.ts
```

On SIGTERM the API answers 503 on `/readyz` for `HTTP_SHUTDOWN_GRACE_MS`, drains in-flight requests, closes every connection and exits 0. The worker releases in-flight jobs for redelivery.

Before going live:

- Replace every development credential; generate `BETTER_AUTH_SECRET` with `openssl rand -base64 32`.
- Run migrations as a release step, never `db:push`.
- Point readiness checks at `/readyz` and liveness at `/healthz`, and give containers more than `HTTP_SHUTDOWN_GRACE_MS` to stop.
- Set `TRUSTED_ORIGINS` to the browser origins that call the API, and `TRUSTED_PROXIES` to your load balancer's CIDRs so rate limits see real client IPs.
- Use real S3 and SMTP credentials; the jobs Redis needs `maxmemory-policy noeviction` and persistence.
- Keep `DOCS_ENABLED` off unless the API reference should be public.
- Set `OTEL_EXPORTER_OTLP_ENDPOINT` and `SENTRY_DSN`.
