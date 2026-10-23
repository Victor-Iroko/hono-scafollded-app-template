# Hono Scaffolded App Template

A production-minded API starter on [Bun](https://bun.sh) and [Hono](https://hono.dev), with the boilerplate most services need already wired up:

- Postgres + Drizzle ORM, Better Auth (email/password, Google, verification)
- Redis-backed rate limiting and BullMQ jobs with a separate worker process
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

Run the API and job worker together with `bun run dev:all`, or the worker alone with `bun run worker`.

API docs are served when `DOCS_ENABLED=true` in `.env`. Health and metrics endpoints are always available.

| URL             | Description                        |
| --------------- | ---------------------------------- |
| `/docs`         | Scalar API reference               |
| `/openapi.json` | Generated OpenAPI spec             |
| `/llms.txt`     | API reference as Markdown for LLMs |
| `/healthz`      | Liveness check                     |
| `/readyz`       | Dependency readiness check         |
| `/metrics`      | Prometheus metrics                 |

## API and jobs

- Add API domains under `src/api/<module>/` using the `router` / `schema` / `service` split.
- Define BullMQ queues and job handlers in `src/jobs/index.ts`; the worker runs them from `src/worker.ts`.
- Regenerate `openapi.json` after changing routes:

```sh
bun run openapi:generate
```

## Queue dashboard

Inspect BullMQ jobs (Redis on port `6381`) with Bull Board:

```sh
bunx @bull-board/cli -r redis://:redis@localhost:6381/0 -p 4000
```

Then open http://localhost:4000.

## Fern documentation

Run or generate the Fern documentation:

```sh
bunx fern docs dev
# or
bunx fern generate docs
```

Configure the organization and instance in `fern/fern.config.json` and `fern/docs.yml` first.

## Scripts

| Command                                  | Description                              |
| ---------------------------------------- | ---------------------------------------- |
| `bun run dev`                            | Start the API with hot reload            |
| `bun run dev:all`                        | Start API and worker together            |
| `bun run worker`                         | Start the job worker                     |
| `bun run db:generate`                    | Generate Drizzle migrations              |
| `bun run db:migrate`                     | Apply migrations                         |
| `bun run db:push`                        | Push schema directly (local development) |
| `bun run db:seed`                        | Seed the database                        |
| `bun run openapi:generate`               | Regenerate `openapi.json`                |
| `bun run auth:generate`                  | Regenerate the Better Auth schema        |
| `bun run test`                           | Run the test suite                       |
| `bun run test:unit` / `test:integration` | Run one test layer                       |
| `bun run test:coverage`                  | Run tests with coverage                  |
| `bun run lint` / `format` / `typecheck`  | Lint, format, and type-check             |

## Project layout

```
src/
  api/              HTTP modules (router, schema, service)
  auth/             Better Auth configuration and middleware
  core/             Env validation, DB, Redis, queues, logging, metrics, S3
  db/               Drizzle schema and relations
  integrations/     Email templates and Paystack
  jobs/             Queue definitions, handlers, dead-letter handling
  middleware/       Rate limiting
  app.ts            Hono app assembly
  index.ts          API entry point
  worker.ts         Worker entry point
fern/               Fern docs configuration
scripts/            OpenAPI, seeding, and database scripts
observability/      OpenTelemetry collector and Prometheus configs
```

## Before deploying

- Replace every development credential and secret in `.env`.
- Set `DOCS_ENABLED=false` and enable `METRICS_TOKEN` (or keep `/metrics` private).
- Use real S3 and SMTP credentials, and run the API and worker as separate processes.
- Apply migrations with `bun run db:migrate` instead of `db:push`.
- Point `OTEL_EXPORTER_OTLP_ENDPOINT` at your collector; start the local stack with `docker compose -f docker-compose.observability.yml up -d`.
