# Observability, metrics, and health

Every observability path in the template assumes a process that lives long enough to batch and be scraped:

- `src/core/instrumentation.ts` starts a `NodeSDK` with a 60-second periodic metric reader.
- `src/core/metrics.ts` holds a Prometheus registry; `src/app.ts` exposes `/metrics`.
- `src/app.ts` installs `@sentry/hono/bun`.
- `src/api/health/health.service.ts` checks DB, Redis, S3, and SMTP on every probe.
- `src/core/logger.ts` writes through a pino transport worker thread in development.

Treat each one separately.

## Traces

### Node runtimes

Keep `NodeSDK`, but make shutdown explicit. Functions can freeze immediately after the response, so a batch that has not flushed is lost.

`src/core/instrumentation.ts`:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { httpInstrumentationMiddleware } from "@hono/otel";
import { getEnv } from "./env";
import { getLogger } from "./logger";

let sdk: NodeSDK | undefined;

export function initInstrumentation(serviceName = "api"): NodeSDK | undefined {
  if (sdk) return sdk;

  const env = getEnv();
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return undefined;

  try {
    sdk = new NodeSDK({
      resource: resourceFromAttributes({
        "service.name": serviceName,
        "service.version": "1.0.0",
      }),
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      instrumentations: [getNodeAutoInstrumentations()],
    });
    sdk.start();
    getLogger().info({ endpoint }, "OTel instrumentation started");
  } catch (err) {
    getLogger().error({ err }, "OTel instrumentation failed");
    sdk = undefined;
  }

  return sdk;
}

/** Call before the function returns so buffered spans are sent. */
export async function flushTelemetry(): Promise<void> {
  await sdk?.shutdown().catch(() => undefined);
  sdk = undefined;
}

export function otelMiddleware(serviceName = "api") {
  return httpInstrumentationMiddleware({ serviceName });
}
```

The periodic **metric** reader is removed: a 60-second interval rarely fires in a short-lived function, and metrics are better exported by the platform. For traces, prefer the platform integration when one exists:

- **Vercel:** `@vercel/otel` with `registerOTel`.
- **AWS Lambda:** the ADOT Lambda layer.
- **Cloudflare:** the Workers OpenTelemetry integration.

If you adopt one, delete `NodeSDK` and `getNodeAutoInstrumentations`, keep `otelMiddleware`, and let the platform configure the exporter.

### Flushing on a platform

- **Vercel:** `import { waitUntil } from "@vercel/functions"; waitUntil(flushTelemetry());`
- **Cloudflare:** `ctx.waitUntil(flushTelemetry())` (only if you use a Node-compatible SDK).
- **AWS Lambda:** `await flushTelemetry()` before returning from `handler`.

Do not call `flushTelemetry()` on every request when the platform already batches; it adds latency.

## Sentry

`@sentry/hono/bun` is Bun-specific. Replace it with the platform SDK:

| Runtime            | Package                  |
| ------------------ | ------------------------ |
| Vercel Node        | `@sentry/node`           |
| Vercel Edge        | `@sentry/vercel-edge`    |
| Cloudflare Workers | `@sentry/cloudflare`     |
| AWS Lambda         | `@sentry/aws-serverless` |

Keep the `sentry()` middleware shape if the package supports Hono, or use the platform's serverless handler wrapper. The exact wrapper changes between SDKs, so follow the package's own setup for the chosen platform rather than copying one shape.

Initialize with `SENTRY_DSN` and `NODE_ENV`, and flush before the response settles:

```ts
await Sentry.flush(2_000);
```

Sentry's serverless integrations usually flush automatically; verify in a test by forcing an error and checking that the event arrives.

## Metrics

The Prometheus scrape model does not survive autoscaling: each instance has its own registry, `collectDefaultMetrics` describes one short-lived process, and the scraper has no stable target.

Delete:

- `src/core/metrics.ts`
- The `/metrics` route in `src/app.ts`
- `initMetrics()` and `registerMetrics` / `printMetrics`
- The `prom-client` blocks in `src/core/s3.ts` and `src/integrations/email/send.ts`
- `prom-client`, `METRICS_TOKEN`, and the `/metrics` row in `README.md`

Replace with one of:

- **OTLP metrics** through the same collector as traces, if the platform supports it.
- **Platform metrics** (Vercel Analytics, CloudWatch, Cloudflare Analytics).
- **No custom metrics**: spans already carry duration and status.

If you keep `prom-client`, do it only for a single always-on container, not a serverless target.

## Health

`src/api/health/health.service.ts` currently calls DB, Redis, S3, and SMTP. On every probe that is four network calls, including an SMTP handshake, and it can exceed a function timeout.

### `/healthz`

Keep it dependency-free:

```ts
healthRouter.get("/healthz", /* describeRoute */ (c) => c.json({ ok: true as const }));
```

### `/readyz`

Keep it only if an uptime monitor needs it. Check DB and Redis, never S3 or SMTP:

```ts
import { checkDbHealth } from "../../core/db";
import { checkRedisHealth } from "../../core/redis";

export async function checkReadiness() {
  const [db, redis] = await Promise.all([checkDbHealth(), checkRedisHealth()]);

  return {
    ok: db.ok && redis.ok,
    db,
    redis,
  };
}
```

Update `health.schema.ts` to drop the `s3` and `email` fields. On Vercel and Lambda there is no orchestrator readiness gate; the endpoint is only for humans and monitors.

## Logging

### Node runtimes

Keep pino. In production it writes JSON to stdout, which the platform collects. Remove the development transport in production (the current code already guards on `NODE_ENV`). Do not write to files.

### Edge runtimes

`pino` needs Node APIs and its transport uses a worker thread. On Workers, replace `src/core/logger.ts` with a small structured console logger:

```ts
type LogFields = Record<string, unknown>;

function write(level: string, fields: LogFields | string, message?: string) {
  const body = typeof fields === "string" ? { msg: fields } : { ...fields, msg: message };
  console.log(JSON.stringify({ level, time: new Date().toISOString(), ...body }));
}

export function getLogger() {
  return {
    trace: (fields: LogFields | string, message?: string) => write("trace", fields, message),
    debug: (fields: LogFields | string, message?: string) => write("debug", fields, message),
    info: (fields: LogFields | string, message?: string) => write("info", fields, message),
    warn: (fields: LogFields | string, message?: string) => write("warn", fields, message),
    error: (fields: LogFields | string, message?: string) => write("error", fields, message),
    fatal: (fields: LogFields | string, message?: string) => write("fatal", fields, message),
  };
}
```

Remove `hono-pino` and `pino` from the edge build. `loggerMiddleware` becomes a no-op or attaches `requestId`.

`hono/context-storage` uses `AsyncLocalStorage`; it works on Node/Bun and on Workers with `nodejs_compat`. The existing `tryGetContext` fallback in `getLogger()` already handles a missing store.

## Instrumentation side effects to remove

- `src/index.ts` and `src/worker.ts` no longer call `initInstrumentation()` at module load; `getApp()` does.
- `src/worker.ts` is deleted.
- `sdk.shutdown()` is the only shutdown left, and it is per-invocation, not a global signal handler.
