---
name: Convert Hono Template to Serverless
description: Migrate this Bun/Hono starter from a long-running server to serverless. Use when replacing BullMQ with QStash, ioredis with Upstash, removing the worker process, or deploying to Vercel, Cloudflare, or AWS Lambda.
---

# Convert this template to serverless

This template assumes one long-running Bun process plus a second worker process. This skill removes that assumption without changing the public API: jobs move to QStash, Redis moves to Upstash over HTTP, and the worker becomes an HTTP callback.

## Stop and ask first

Ask these before editing. Wait for the answers.

1. **Target runtime** — Cloudflare Workers / Vercel (Node) / Vercel (Bun) / AWS Lambda / Netlify / other.
2. **Email transport** — Resend / Postmark / Amazon SES v2 / keep SMTP.
3. **Edge only** — if the runtime is Cloudflare Workers or another edge runtime, ask which Postgres provider (Neon / Supabase / D1). `pg` and `ioredis` cannot run there.

If the user delegates the choice, default to **Vercel Node + Resend** and say so.

Do not start until the runtime and email answers are known. The entrypoint, DB driver, Sentry SDK, and email file all branch on them.

## Rules

- Work on a branch. Keep the app runnable after every step.
- Do not change the public API, Drizzle schema, auth schema, email templates, or Paystack behavior.
- Delete the worker files in the same step that adds the callback route, then run the round trip immediately. Keep the branch so the step can be reverted.
- Keep migrations deploy-time. Never run `db:migrate` or `db:push` at boot.
- Keep `src/api/<module>/` in the `<module>.router.ts` / `.schema.ts` / `.service.ts` split required by `AGENTS.md`.
- Run only the tests that cover the change, per `AGENTS.md`.

## Order of work

1. [references/08-local-dev-compose.md](references/08-local-dev-compose.md) — add the HTTP Redis service and QStash dev service, update `.env.example`, run the stack.
2. [references/03-redis-ratelimit.md](references/03-redis-ratelimit.md) — `@upstash/redis`, token-bucket limiter, Better Auth storage.
3. [references/01-runtime-entrypoint.md](references/01-runtime-entrypoint.md) — platform export, lazy app, `src/dev.ts`, `vercel.json` for Bun, remove signals and boot side effects.
4. [references/02-jobs-qstash.md](references/02-jobs-qstash.md) — QStash client, jobs registry, callback route, delete the worker, run the round trip.
5. [references/05-email.md](references/05-email.md) — HTTP email provider, or per-invocation SMTP.
6. [references/04-database.md](references/04-database.md) — pooler with `max: 1`, or an HTTP driver on edge.
7. [references/06-observability.md](references/06-observability.md) — flush telemetry, platform Sentry, no Prometheus scrape, slim health.
8. [references/07-runtime-pitfalls.md](references/07-runtime-pitfalls.md) — `Bun.file`, `node:crypto`, global state, S3 bootstrap.
9. [references/09-deps-env-docs.md](references/09-deps-env-docs.md) — `package.json`, `src/core/env.ts`, `README.md`, `tsconfig.json`.
10. Run the verification checklist and report every changed file.

Do not rewrite `src/jobs/index.ts` while `src/worker.ts` still imports the old `runJob`. Steps 3 and 4 are paired: step 3 makes the app runnable on the platform, step 4 swaps the jobs contract and removes the worker.

## File map

| File                                    | Action                                                           |
| --------------------------------------- | ---------------------------------------------------------------- |
| `src/core/qstash.ts`                    | **add** — `Client` + `Receiver` singletons                       |
| `src/api/jobs/jobs.router.ts`           | **add** — signature check and error mapping                      |
| `src/api/jobs/jobs.schema.ts`           | **add** — `{ name, data }` envelope                              |
| `src/api/jobs/jobs.service.ts`          | **add** — verify and dispatch                                    |
| `src/jobs/index.ts`                     | **rewrite** — no BullMQ types; `flowControl`; publish via QStash |
| `src/api/router.ts`                     | **modify** — mount `/api/jobs`                                   |
| `src/index.ts`                          | **rewrite** — lazy app factory and platform export               |
| `src/dev.ts`                            | **add** — local `Bun.serve` wrapper around `getApp()`            |
| `src/worker.ts`                         | **delete**                                                       |
| `src/core/worker.ts`                    | **delete**                                                       |
| `src/core/queue.ts`                     | **delete**                                                       |
| `src/jobs/dead-letter.ts`               | **delete** — QStash DLQ is automatic                             |
| `src/core/redis.ts`                     | **rewrite** — `@upstash/redis`, no TCP, no `closeRedis`          |
| `src/middleware/rate-limit.ts`          | **rewrite** — `@upstash/ratelimit` token bucket                  |
| `src/auth/rate-limit-storage.ts`        | **rewrite** — Upstash `multi().incr().expire()`                  |
| `src/auth/auth.ts`                      | **modify** — `advanced.ipAddress.ipAddressHeaders`               |
| `src/core/db.ts`                        | **branch** — `pg` max 1 + pooler, or HTTP driver                 |
| `src/core/env.ts`                       | **rewrite** — new env schema                                     |
| `src/core/logger.ts`                    | **branch** — stdout JSON on Node; console logger on edge         |
| `src/core/instrumentation.ts`           | **branch** — flush/`waitUntil`, or edge setup                    |
| `src/core/metrics.ts`                   | **delete** — OTLP or platform metrics                            |
| `src/core/s3.ts`                        | **modify** — drop metrics and boot bucket create                 |
| `src/integrations/email/smtp.ts`        | **branch** — delete for HTTP providers                           |
| `src/integrations/email/send.ts`        | **branch** — provider adapter                                    |
| `src/integrations/email/index.ts`       | **modify** — drop SMTP exports                                   |
| `src/api/health/health.service.ts`      | **rewrite** — DB + Redis only                                    |
| `src/api/health/health.schema.ts`       | **modify** — drop `s3` and `email`                               |
| `src/api/health/health.router.ts`       | **modify** — keep `/healthz`, slim `/readyz`                     |
| `src/app.ts`                            | **modify** — import `openapi.json`, mount jobs, drop `/metrics`  |
| `src/core/context.ts`                   | **modify** — only if the Redis middleware is removed             |
| `src/integrations/payments/paystack.ts` | **edge only** — WebCrypto instead of `node:crypto`               |
| `scripts/create-bucket.ts`              | **add** — deploy-time bucket bootstrap                           |
| `package.json`                          | **modify** — dependencies and scripts                            |
| `.env.example`                          | **rewrite** — Upstash/QStash variables                           |
| `docker-compose.yml`                    | **modify** — add SRH + QStash, remove `redis-jobs`               |
| `docker-compose.test.yml`               | **modify** — add SRH test service                                |
| `tsconfig.json`                         | **modify** — `resolveJsonModule`, runtime types                  |
| `vercel.json`                           | **add** (Vercel Bun only) — `bunVersion`; optional `maxDuration` |
| `README.md`                             | **modify** — remove worker/Bull Board, document serverless       |

## Definition of done

- [ ] No `bullmq`, `bullmq-otel`, `ioredis`, `rate-limiter-flexible`, or `cockatiel` imports.
- [ ] `src/worker.ts`, `src/core/worker.ts`, `src/core/queue.ts`, and `src/jobs/dead-letter.ts` are gone.
- [ ] No `SIGINT`, `SIGTERM`, or `process.exit` in `src/`.
- [ ] No `Bun.file` in a request path.
- [ ] `enqueue()` publishes to QStash and returns a message id.
- [ ] `/api/jobs/:queue` verifies `Upstash-Signature` against the raw body.
- [ ] Rate limiting uses `Ratelimit.tokenBucket`.
- [ ] Better Auth rate limiting shares counters through Upstash.
- [ ] `/healthz` touches no dependency.
- [ ] `bun run typecheck`, `bun run lint`, and `bun run format:check` pass.
- [ ] Local round trip works: publish → callback → job runs.
- [ ] Bad signature returns 401; bad payload returns 489 and lands in the QStash DLQ.

## Verification

```sh
bun run typecheck
bun run lint
bun run format:check
docker compose up -d
bun run dev

# Publish a job (QStash dev server on 8080)
curl -XPOST http://localhost:8080/v2/publish/"$QSTASH_DESTINATION_URL"/api/jobs/default \
  -H "Authorization: Bearer $QSTASH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"example","data":{"message":"hello"}}'
```

A successful publish logs `example job ran`. A wrong signature returns 401 and never reaches the job. A payload that fails the job schema returns 489 with `Upstash-NonRetryable-Error: true`.
