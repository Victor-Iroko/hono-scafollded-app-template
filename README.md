# Hono Scaffolded App Template

> Being rewritten on Effect v4. See [docs/effect-v4-migration-plan.md](docs/effect-v4-migration-plan.md) for the plan and progress; sections below describe the new code only where it exists.

A production-minded API starter on [Bun](https://bun.sh) and [Hono](https://hono.dev), with the boilerplate most services need already wired up:

- Postgres + Drizzle ORM, Better Auth (email/password, Google, verification)
- Redis-backed token-bucket rate limiting and durable jobs (Effect PersistedQueue) with a separate worker process
- S3-compatible object storage, SMTP email with templates and a local inbox
- Structured logging, OpenTelemetry, Prometheus metrics, Sentry
- OpenAPI spec, Scalar API reference, and Fern documentation

## Requirements

- [Bun](https://bun.sh)
- Docker (for Postgres, Redis, RustFS, and Mailpit)

## Getting started

```sh
bun install
cp .env.example .env       # then set BETTER_AUTH_SECRET to a random 32+ char string
docker compose up -d
bun run db:push            # create tables
bun run dev                # API on http://localhost:3000
```

Run the API and job worker together with `bun run dev:all`, or the worker alone with `bun run dev:worker`.

API docs are served when `DOCS_ENABLED=true` in `.env`. Health endpoints are always available.

| URL             | Description                        |
| --------------- | ---------------------------------- |
| `/docs`         | Scalar API reference               |
| `/openapi.json` | Generated OpenAPI spec             |
| `/llms.txt`     | API reference as Markdown for LLMs |
| `/healthz`      | Liveness check                     |
| `/readyz`       | Dependency readiness check         |

## API and jobs

- Add API domains under `src/api/<module>/` (`*.api.ts`, `*.handlers.ts`, `*.schema.ts`, `*.service.ts`) and add the group to `src/http/api.ts`.
- Regenerate `openapi.json` after changing routes: `bun run openapi:generate`.
- Background work runs on durable queues in the jobs Redis (`src/jobs`). Delivery is at least once, so handlers must be idempotent. To add a queue: declare it like `src/jobs/email.queue.ts`, write its handler, and add a `consume(...)` line to `src/jobs/worker.ts`.
- Send email with `EmailService.enqueue({ template, to, data })`; templates live in `src/integrations/email/templates.ts`. Failed sends retry with backoff; permanent rejections are logged and reported instead.

Store files with `Storage` (`src/platform/storage.ts`): clients upload and download through presigned URLs, so bodies never pass through the API. Take payments with `PaystackClient` (`src/integrations/paystack`); calls that move money require a `reference` and never retry automatically, and `paystackWebhookRoute` verifies Paystack's signature before your handler runs.

Jobs that fail every attempt stay in Redis under `jobs:<queue>` as the dead-letter record, are logged at error level and reported to Sentry. Inspect them with `redis-cli -p 6381 -a redis`.

## Fern documentation

Run or generate the Fern documentation:

```sh
bunx fern docs dev
# or
bunx fern generate docs
```

Configure the organization and instance in `fern/fern.config.json` and `fern/docs.yml` first.

## Scripts

| Command                                  | Description                                         |
| ---------------------------------------- | --------------------------------------------------- |
| `bun run dev`                            | Start the API and restart on file changes           |
| `bun run start`                          | Start the API                                       |
| `bun run dev:worker` / `worker`          | Start the job worker (with / without file watching) |
| `bun run dev:all`                        | API and worker together                             |
| `bun run db:generate`                    | Generate Drizzle migrations                         |
| `bun run db:migrate`                     | Apply migrations                                    |
| `bun run db:push`                        | Push schema directly (local development)            |
| `bun run test`                           | Run the test suite                                  |
| `bun run test:unit` / `test:integration` | Run one test layer                                  |
| `bun run lint` / `format` / `typecheck`  | Lint, format, and type-check                        |

## Project layout

```
src/
  api/<module>/     <module>.api.ts (endpoints), .handlers.ts, .schema.ts, .service.ts
  auth/             Better Auth service, /api/auth/* route, Authenticated middleware
  http/             The HttpApi contract and the Bun HTTP server
  platform/         Infrastructure services: observability, database (Drizzle on @effect/sql-pg),
                    Redis (cache + jobs), token-bucket rate limits, S3 storage, SMTP mailer
  integrations/     Email templates + EmailService, Paystack client and webhook route
  jobs/             Durable queues, job handlers, and the worker's consumers
  db/               Drizzle schema, relations, and migrations
  config.ts         Every environment variable, grouped by domain
  main.ts           API entry point
  migrate.ts        Applies migrations, then exits
tests/              Unit and integration tests (bun test)
observability/      OpenTelemetry collector config
```

## Authentication

[Better Auth](https://better-auth.com) serves sign-up, sign-in, sessions and Google OAuth at `/api/auth/*` (listed under the Auth tag in `/docs`). To protect a group of endpoints, add `.middleware(Authenticated)` to its `HttpApiGroup` and read the user in a handler with `yield* CurrentUser` (see `src/api/account` for `GET /v1/me`).

The auth tables in `src/db/schema/auth.ts` mirror Better Auth's core schema. After enabling a Better Auth plugin that adds tables or fields, add them there and run `bun run db:generate`.

## Error responses

Every error is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem served as `application/problem+json`:

```json
{ "type": "about:blank", "title": "Conflict", "status": 409, "detail": "Resource already exists" }
```

Request validation failures are `400` problems with an `errors` array (`{ path, message }` per invalid field). Endpoint errors are declared in each module's `*.api.ts` using the classes in `src/http/errors.ts`, so they appear in OpenAPI and the typed client. Every response carries an `x-request-id` header that also tags its log lines.

## Before deploying

- Replace every development credential and secret in `.env`.
- Keep `DOCS_ENABLED` unset in production unless the API reference should be public.
- Set `TRUSTED_ORIGINS` to the browser origins that call the API.
- Set `TRUSTED_PROXIES` to your load balancer's CIDRs so rate limits key on the real client IP.
- Point the load balancer's readiness check at `/readyz` and liveness at `/healthz`.
- Use real S3 and SMTP credentials, and run the API and worker as separate processes.
- Apply migrations with `bun run db:migrate` instead of `db:push`.
- Point `OTEL_EXPORTER_OTLP_ENDPOINT` at your collector; start the local stack with `docker compose -f docker-compose.observability.yml up -d`.
