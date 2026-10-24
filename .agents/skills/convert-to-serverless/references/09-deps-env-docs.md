# Dependencies, environment, and docs

## `package.json`

### Remove

| Package                            | Why                                    |
| ---------------------------------- | -------------------------------------- |
| `bullmq`                           | QStash replaces it                     |
| `bullmq-otel`                      | BullMQ-only telemetry                  |
| `ioredis`                          | `@upstash/redis` replaces it           |
| `rate-limiter-flexible`            | `@upstash/ratelimit` replaces it       |
| `cockatiel`                        | The circuit breaker was process-local  |
| `@hono/bun`                        | Only `getConnInfo` was used            |
| `prom-client`                      | No scrape target (see observability)   |
| `nodemailer` + `@types/nodemailer` | Only when using an HTTP email provider |
| `@sentry/bun`                      | Replace with the platform SDK          |

### Add

| Package                                                                 | When                                   |
| ----------------------------------------------------------------------- | -------------------------------------- |
| `@upstash/redis`                                                        | Always                                 |
| `@upstash/ratelimit`                                                    | Always                                 |
| `@upstash/qstash`                                                       | Always                                 |
| `resend` / `postmark` / `@aws-sdk/client-sesv2`                         | Chosen email provider                  |
| `@neondatabase/serverless`                                              | Neon HTTP driver                       |
| `postgres`                                                              | `postgres-js` driver                   |
| `@vercel/functions`                                                     | Vercel `waitUntil` for telemetry flush |
| `@cloudflare/workers-types` (dev)                                       | Workers types                          |
| `@sentry/vercel-edge` / `@sentry/cloudflare` / `@sentry/aws-serverless` | Platform Sentry                        |

### Scripts

```json
{
  "scripts": {
    "dev": "bun run --hot src/dev.ts",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:push": "drizzle-kit push",
    "db:seed": "bun run scripts/seed/index.ts",
    "bucket:create": "bun run scripts/create-bucket.ts",
    "openapi:generate": "bun run scripts/openapi/generate.ts && bunx oxfmt openapi.json",
    "auth:generate": "bunx auth@latest generate --config ./src/auth/cli.ts --adapter drizzle --dialect postgresql --output ./src/db/schema/auth.ts --yes",
    "test": "bun test",
    "test:unit": "bun test tests/unit",
    "test:integration": "bun test tests/integration",
    "test:coverage": "bun test --coverage",
    "lint": "oxlint",
    "format": "oxfmt --write",
    "format:check": "oxfmt --check",
    "typecheck": "tsc --noEmit"
  }
}
```

Remove `worker` and `dev:all`. Keep `dev` for local Node/Bun development; use `wrangler dev` or `vercel dev` on edge so bindings exist.

## `src/core/env.ts`

Replace the two Redis blocks and the SMTP block. The provider-specific key depends on the email answer.

```ts
import z from "zod";

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
    SENTRY_DSN: z.string().optional(),
    DOCS_ENABLED: z.stringbool().default(false),

    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(1),
    DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(10_000),
    DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(10_000),

    BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
    BETTER_AUTH_URL: z.url("BETTER_AUTH_URL must be a URL"),
    BETTER_AUTH_TRUSTED_ORIGINS: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    AUTH_REQUIRE_EMAIL_VERIFICATION: z.stringbool().default(false),
    AUTH_TRUST_PROXY_HEADERS: z.stringbool().default(false),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

    UPSTASH_REDIS_REST_URL: z.url("UPSTASH_REDIS_REST_URL must be a URL"),
    UPSTASH_REDIS_REST_TOKEN: z.string().min(1, "UPSTASH_REDIS_REST_TOKEN is required"),
    RATE_LIMIT_POINTS: z.coerce.number().int().min(1).default(100),
    RATE_LIMIT_DURATION_S: z.coerce.number().int().min(1).default(60),

    QSTASH_URL: z.url().optional(),
    QSTASH_TOKEN: z.string().min(1, "QSTASH_TOKEN is required"),
    QSTASH_CURRENT_SIGNING_KEY: z.string().min(1),
    QSTASH_NEXT_SIGNING_KEY: z.string().min(1),
    QSTASH_DESTINATION_URL: z.url("QSTASH_DESTINATION_URL must be a URL"),
    JOB_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

    S3_BUCKET: z.string().min(1, "S3_BUCKET is required"),
    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_ENDPOINT: z.url().optional(),
    S3_PUBLIC_ENDPOINT: z.url().optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_FORCE_PATH_STYLE: z.stringbool().default(true),
    S3_PRESIGN_EXPIRES_S: z.coerce.number().int().min(1).max(604_800).default(3_600),
    S3_AUTO_CREATE_BUCKET: z.stringbool().default(false),

    EMAIL_FROM: z.string().min(1, "EMAIL_FROM is required"),
    EMAIL_REPLY_TO: z.email().optional(),
    EMAIL_RATE_MAX: z.coerce.number().int().min(1).default(10),
    // Pick one provider block:
    RESEND_API_KEY: z.string().min(1).optional(),
    // POSTMARK_SERVER_TOKEN: z.string().min(1).optional(),
    // POSTMARK_MESSAGE_STREAM: z.string().min(1).default("outbound"),
    // SES_REGION: z.string().min(1).optional(),
    // SMTP_URL: z.url("SMTP_URL must be a URL, e.g. smtp://localhost:1025"),
    // SMTP_USER: z.string().min(1).optional(),
    // SMTP_PASSWORD: z.string().min(1).optional(),

    PAYSTACK_SECRET_KEY: z.string().min(1).optional(),
  })
  .refine((env) => Boolean(env.S3_ACCESS_KEY_ID) === Boolean(env.S3_SECRET_ACCESS_KEY), {
    message: "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together",
    path: ["S3_SECRET_ACCESS_KEY"],
  })
  .refine((env) => Boolean(env.GOOGLE_CLIENT_ID) === Boolean(env.GOOGLE_CLIENT_SECRET), {
    message: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together",
    path: ["GOOGLE_CLIENT_SECRET"],
  });

export type ENV = z.infer<typeof envSchema>;

let cached: ENV | undefined;

export function initEnv(source = process.env): ENV {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    console.error(z.prettifyError(parsed.error));
    throw new Error("Invalid Environment Variables");
  }
  cached = parsed.data;
  return cached;
}

export function getEnv(): ENV {
  if (!cached) throw new Error("Call initEnv() at app entry first");
  return cached;
}
```

Notes:

- `DB_POOL_MAX` defaults to `1` for serverless. On a long-running container, raise it.
- `METRICS_TOKEN` is removed with the `/metrics` route. Restore it if you keep Prometheus.
- `QSTASH_URL` is optional in production; omit it to use the regional QStash default.
- `QSTASH_DESTINATION_URL` is the public origin only; the route adds `/api/jobs/:queue`.
- `JOB_MAX_RETRIES` maps to 3 total attempts at `2`.
- For SMTP, keep `SMTP_URL` / `SMTP_USER` / `SMTP_PASSWORD` and the pairing refinement.

## `src/core/env.ts` refinements per provider

Add one so a missing key fails at boot, not on the first email:

```ts
.refine((env) => Boolean(env.RESEND_API_KEY), {
  message: "RESEND_API_KEY is required when using Resend",
  path: ["RESEND_API_KEY"],
})
```

```ts
.refine((env) => Boolean(env.POSTMARK_SERVER_TOKEN), {
  message: "POSTMARK_SERVER_TOKEN is required when using Postmark",
  path: ["POSTMARK_SERVER_TOKEN"],
})
```

```ts
.refine((env) => Boolean(env.SES_REGION ?? env.S3_REGION), {
  message: "SES_REGION is required when using SES v2",
  path: ["SES_REGION"],
})
```

## `README.md`

Update these sections.

**Intro bullet:**

```md
- Upstash Redis for rate limiting and QStash for background jobs (no worker process)
```

**Requirements:** Docker for Postgres, Redis, SRH, QStash, RustFS, and Mailpit. Mention Upstash/QStash accounts for production.

**Getting started:**

```sh
bun install
cp .env.example .env
docker compose up -d
bun run db:push
bun run dev
```

Delete `bun run dev:all` and `bun run worker`.

**Delete the Bull Board section.** Replace it with:

```md
## Jobs

Jobs are published to QStash and delivered to `/api/jobs/:queue`. Locally the
QStash dev server runs in Docker on `http://localhost:8080`; its console is in
the Upstash dashboard or at the dev server's log port. In production, use the
Upstash QStash dashboard.
```

**Scripts table:** remove `worker` and `dev:all`, add `bucket:create`.

**Project layout:**

```
src/
  api/              HTTP modules, including api/jobs for the QStash callback
  auth/             Better Auth configuration and middleware
  core/             Env, DB, Redis, QStash, logging, metrics, S3
  db/               Drizzle schema and relations
  integrations/     Email templates and Paystack
  jobs/             Queue definitions and handlers
  middleware/       Rate limiting
  app.ts            Hono app assembly
  index.ts          Platform entry point
```

Remove `worker.ts` and the `worker.ts` line from the layout.

**Before deploying:**

- Replace the QStash dev token and signing keys with production values.
- Set `QSTASH_DESTINATION_URL` to the public origin; it must match the URL QStash calls.
- Replace SRH with an Upstash Redis REST URL and token.
- Run migrations as a deploy step, not at boot.
- Create the S3 bucket with IaC or `bun run bucket:create`.
- Remove the `/metrics` instructions if metrics were removed.
- On Vercel Bun, add `vercel.json` with `"bunVersion": "1.4.x"` (or `"1.x"`) and commit `bun.lock`. Without it, Vercel runs Node.js and Bun APIs fail. See [01-runtime-entrypoint.md](01-runtime-entrypoint.md#vercel--bun-runtime).

## `scripts/create-bucket.ts`

```ts
import { initEnv } from "../src/core/env";
import { ensureBucket } from "../src/core/s3";

initEnv();
await ensureBucket();
```

## `tsconfig.json`

```json
{
  "compilerOptions": {
    "resolveJsonModule": true,
    "types": ["bun"]
  }
}
```

On Workers, switch `types` to `["@cloudflare/workers-types"]` and remove Bun-only imports.

## `AGENTS.md`

Add one line under "API modules" or "Tests":

> Jobs are QStash callbacks at `src/api/jobs/`; there is no worker process. Do not add BullMQ or a long-running consumer.

No other rule changes.

## Final grep

```sh
rg -n "bullmq|ioredis|rate-limiter-flexible|cockatiel|Bun\.file|SIGTERM|process\.exit|closeQueues|closeRedis|closeSmtp" src
```

The only acceptable leftovers are `process.exit` in scripts (not request paths) and any deliberate `Bun.file` outside a request handler.
