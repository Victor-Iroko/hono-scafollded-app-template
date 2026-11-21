---
name: Convert Template to Serverless
description: Migrate this Bun/Effect v4 starter from long-running API + worker processes to serverless functions. Use when moving jobs from PersistedQueue to QStash, Redis from TCP to Upstash REST, removing the worker process, or deploying to Vercel or AWS Lambda.
---

# Convert this template to serverless

The template runs two long-lived processes: the API (`src/main.ts`) and the
worker (`src/worker.ts`), both talking TCP to Postgres and two Redis
instances. A function platform freezes or kills the process between requests,
so four things change:

1. **Entry point:** the HTTP app becomes a Fetch handler built once per instance.
2. **Jobs:** `PersistedQueue` needs a polling worker; QStash pushes each job to an HTTP callback instead.
3. **Redis:** TCP connections do not survive freezes; Upstash's REST API does.
4. **Telemetry:** exporters batch on a timer; each invocation must flush before it returns.

Everything else stays: the `HttpApi` contract, schemas, error contract, Better
Auth, Drizzle schema and migrations, email templates, Paystack, Storage.

## Stop and ask first

1. **Runtime:** Vercel (Node or Bun) / AWS Lambda / other Node-compatible. Cloudflare Workers and other edge runtimes are out of scope: `@effect/sql-pg` and Better Auth's `pg` pool need TCP sockets. Say so if the user picks one.
2. **Email transport:** Resend / Postmark / SES / keep SMTP (SMTP works on Node functions, one connection per invocation).
3. **Postgres provider:** must offer a pooled (PgBouncer/transaction-mode) URL: Neon, Supabase, RDS Proxy.

If the user delegates, default to **Vercel Node + Resend + Neon** and say so.

## Rules

- Work on a branch; keep the app runnable after every step.
- Keep the service conventions in `AGENTS.md`: each service owns its `layer`, config only through `src/config.ts`, errors as problem classes.
- Do not change the public API, the Drizzle schema, the auth schema, templates or Paystack behavior.
- Migrations stay a deploy step (`bun run src/migrate.ts`), never at function boot.
- Run only the tests that cover each change, per `AGENTS.md`.

## Order of work

1. [references/05-local-dev.md](references/05-local-dev.md): add the Upstash REST shim and QStash dev server to compose; run the stack.
2. [references/03-redis-rest.md](references/03-redis-rest.md): an Upstash REST implementation of Effect's `Redis` service behind `CacheRedis`; rate limiting keeps working unchanged.
3. [references/01-entrypoint.md](references/01-entrypoint.md): `src/serverless.ts` Fetch handler, platform config, what to drop from the long-running entry.
4. [references/02-jobs-qstash.md](references/02-jobs-qstash.md): `EmailService.enqueue` publishes to QStash; a signed callback runs the existing email handler; delete the worker.
5. [references/04-database-email-telemetry.md](references/04-database-email-telemetry.md): pooled Postgres with one connection, HTTP email provider, per-invocation flush of OTLP and Sentry.
6. Update `README.md`, `.env.example`, `docs/production-backend-guide.md` §4, and report every changed file.

Steps 3 and 4 are paired: the app is deployable after step 3 only once jobs no longer need the worker.

## File map

| File                                            | Action                                                               |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `src/serverless.ts`                             | **add**: `HttpRouter.toWebHandler` over `AppRoutes`, flush per call  |
| `src/platform/redis.ts`                         | **rewrite**: Upstash REST `Redis` for `CacheRedis`; drop `JobsRedis` |
| `src/platform/qstash.ts`                        | **add**: publish + signature verification service                    |
| `src/jobs/email.queue.ts`, `queue.ts`           | **delete**                                                           |
| `src/jobs/consume.ts`, `worker.ts`              | **delete**                                                           |
| `src/jobs/email.job.ts`                         | **keep**: the handler is reused by the callback                      |
| `src/jobs/jobs.route.ts`                        | **add**: `POST /internal/jobs/:queue` callback                       |
| `src/integrations/email/email.service.ts`       | **modify**: `enqueue` publishes to QStash                            |
| `src/worker.ts`                                 | **delete**                                                           |
| `src/http/server.ts`                            | **modify**: mount the jobs route; `DrainBeforeStop` is not used      |
| `src/api/health/health.service.ts`              | **modify**: drop the `jobsRedis` check                               |
| `src/platform/database.ts`, `src/auth/auth.ts`  | **modify**: one connection each, `prepare: false` for poolers        |
| `src/platform/mailer.ts`                        | **branch**: HTTP provider on `HttpClient`, same `Mailer` interface   |
| `src/config.ts`                                 | **modify**: Upstash/QStash groups, drop `REDIS_JOBS_URL`             |
| `package.json`, `.env.example`, `README.md`     | **modify**                                                           |
| `docker-compose.yml`, `docker-compose.test.yml` | **modify**: see `assets/docker-compose.additions.yml`                |
| `vercel.json`                                   | **add** for Vercel Bun: see `assets/vercel.json`                     |

## Definition of done

- [ ] No `PersistedQueue`, `BunRedis` or `JobsRedis` imports; `src/worker.ts` and `src/jobs/{queue,consume,worker,email.queue}.ts` are gone.
- [ ] `src/serverless.ts` builds the handler once at module scope and flushes telemetry after each request.
- [ ] `EmailService.enqueue` returns the QStash message id; the idempotency key becomes `Upstash-Deduplication-Id`.
- [ ] `/internal/jobs/:queue` rejects a bad `Upstash-Signature` with a 401 problem and never runs the job.
- [ ] Permanent job failures answer 489 with `Upstash-NonRetryable-Error: true`; transient ones answer 5xx so QStash retries.
- [ ] Rate limiting still answers 429 with `Retry-After` (now over Upstash REST).
- [ ] `bun run typecheck`, `lint`, `format:check`, unit tests and the affected integration tests pass.
- [ ] Local round trip: sign up → QStash dev server → callback → email in Mailpit.
