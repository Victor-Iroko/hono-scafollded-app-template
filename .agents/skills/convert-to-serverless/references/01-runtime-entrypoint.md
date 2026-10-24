# Runtime and entrypoint

## Pick the adapter

| Target             | Export                                            | Node APIs                         | Watch out                                                             |
| ------------------ | ------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------- |
| Vercel (Node)      | `export default app`                              | Yes                               | Zero-config; set `maxDuration`; use a pooler                          |
| Vercel (Bun)       | `export default app` + `vercel.json` `bunVersion` | Yes (Bun)                         | Commit `bun.lock`; keep `types: ["bun"]`                              |
| Cloudflare Workers | `export default { fetch }`                        | No (partial with `nodejs_compat`) | No `pg`, `ioredis`, `nodemailer`, `node:crypto`, `prom-client` scrape |
| AWS Lambda         | `handle` from `hono/aws-lambda`                   | Yes                               | Flush telemetry before returning; Lambda timeout                      |
| Netlify            | `handle` from `hono/netlify`                      | Node or edge                      | Same branching as above                                               |

Do not keep a `Bun.serve()` entry on an edge runtime. Hono's `app.fetch` is the portable surface.

## `src/index.ts` — remove

Delete all of this:

- `initEnv()` and `initInstrumentation()` at module top level.
- `await ensureBucket()` and the `S3_AUTO_CREATE_BUCKET` boot branch.
- `closeDb`, `closeRedis`, `closeS3`, `closeQueues`, `closeSmtp`.
- `process.once("SIGINT", ...)`, `process.once("SIGTERM", ...)`, and `process.exit(0)`.
- `export default app` as the Bun server entry.

Keep a lazy `getApp()` so importing the module has no side effects. That matters for build-time analysis and for platform bindings.

## `src/index.ts` — add

```ts
import { createApp } from "./app";
import { createAuth } from "./auth/auth";
import { getEnv, initEnv } from "./core/env";
import { initInstrumentation, otelMiddleware } from "./core/instrumentation";
import { loggerMiddleware } from "./core/logger";
import { dbMiddleware } from "./core/db";
import { redisMiddleware } from "./core/redis";
import { s3Middleware } from "./core/s3";
import { globalRateLimit } from "./middleware/rate-limit";

let app: ReturnType<typeof createApp> | undefined;

/**
 * Builds the app once per isolate. Pass platform bindings on edge runtimes
 * (Cloudflare) instead of relying on `process.env`.
 */
export function getApp(source: Record<string, string | undefined> = process.env) {
  if (app) return app;

  initEnv(source);
  initInstrumentation();
  const env = getEnv();

  app = createApp({
    env,
    auth: createAuth(env),
    middleware: {
      otel: otelMiddleware(),
      logger: loggerMiddleware(),
      redis: redisMiddleware(),
      rateLimit: globalRateLimit(),
      database: dbMiddleware(),
      s3: s3Middleware(),
    },
  });

  return app;
}
```

Then add exactly one platform export, and a local dev wrapper.

### Local development — `src/dev.ts`

`src/index.ts` no longer starts a Bun server, so `bun run --hot src/index.ts` does nothing. Add:

```ts
import { getApp } from "./index";

const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  port,
  fetch: getApp().fetch,
});

console.log(`API on http://localhost:${port}`);
```

Change the script to `"dev": "bun run --hot src/dev.ts"`. On edge, use `wrangler dev` or `vercel dev` instead so bindings exist.

### Vercel — standalone

Vercel detects the default export in `src/index.ts`; no adapter is needed:

```ts
const app = getApp();
export default app;
```

One default export handles every method. `app.fetch` is the request handler Vercel calls.

### Vercel — Bun runtime

A default export does **not** choose Bun. Vercel runs the function on Node.js unless `bunVersion` is set in `vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "bunVersion": "1.4.x"
}
```

Valid values are `"1.4.x"` (the Rust rewrite of Bun, with breaking changes) and `"1.x"` (the previous line, currently 1.3.14). Match the local line: this repo runs Bun 1.4.2, so `"1.4.x"` is the match.

Rules:

- Commit `bun.lock`; Vercel's Bun runtime uses it.
- There is no per-route Bun runtime value. `bunVersion` is project-wide.
- `bunVersion` applies to every Vercel Function except functions explicitly on the Edge runtime.
- Without it, Bun APIs such as `Bun.file` or `Bun.serve` fail even though the repo is Bun-based.

Optional, only when the emitted function path is known:

```json
{
  "functions": {
    "api/**/*.ts": { "maxDuration": 30 }
  },
  "regions": ["iad1"]
}
```

Keep QStash callbacks short; `maxDuration` is a guard, not a queue. If the framework preset controls the output path, set duration in the project settings instead of guessing the glob.

The Bun framework preset is an alternative to the default export: it uses one `Bun.serve()` entrypoint in `server.ts` or `src/server.ts`. Do not mix both entry styles. The default export above plus `bunVersion` is the smaller change.

### Cloudflare Workers

```ts
export default {
  fetch(request: Request, env: Record<string, string | undefined>) {
    return getApp(env).fetch(request);
  },
};
```

### AWS Lambda

```ts
import { handle } from "hono/aws-lambda";

export const handler = handle(getApp());
```

### Netlify

```ts
import { handle } from "hono/netlify";

export default handle(getApp());
```

## `src/app.ts`

### Remove the disk read

`src/app.ts` currently reads `openapi.json` with `Bun.file` on each cold start:

```ts
const spec = await Bun.file("openapi.json").text();
// and
c.json(await Bun.file("openapi.json").json());
```

Replace it with a bundled import:

```ts
import openapi from "../../openapi.json";
```

```ts
async function generateLlmsTxt() {
  const { createMarkdownFromOpenApi } = await import("@scalar/openapi-to-markdown");
  return createMarkdownFromOpenApi(JSON.stringify(openapi));
}
```

```ts
app.get("/openapi.json", describeRoute({ hide: true }), (c) => c.json(openapi));
```

Add `"resolveJsonModule": true` to `tsconfig.json`. If the JSON makes the bundle too large, serve `/docs` and `/openapi.json` from the platform's static assets instead and delete these routes.

### Mount the jobs callback

The jobs reference does this in `src/api/router.ts`:

```ts
import { jobsRouter } from "./jobs/jobs.router";

apiRouter.route("/api/jobs", jobsRouter);
```

The destination is `${QSTASH_DESTINATION_URL}/api/jobs/:queue`. Keep this path stable: it is also the JWT `sub` claim QStash signs.

### Remove the metrics route

See [06-observability.md](06-observability.md). The `/metrics` scrape target does not exist behind autoscaling.

## `scripts/create-bucket.ts`

Bucket creation moves from boot to a deploy step:

```ts
import { initEnv } from "../src/core/env";
import { ensureBucket } from "../src/core/s3";

initEnv();
await ensureBucket();
```

Add to `package.json`:

```json
"bucket:create": "bun run scripts/create-bucket.ts"
```

Run it once per environment after the bucket exists in IaC, or let IaC own the bucket and skip the script.

## `tsconfig.json`

```json
{
  "compilerOptions": {
    "resolveJsonModule": true,
    "types": ["bun"]
  }
}
```

On Cloudflare Workers, replace `"types": ["bun"]` with `"types": ["@cloudflare/workers-types"]` and remove Bun-only imports.

## Cold-start checklist

- Importing `src/index.ts` must not throw or open a socket.
- `initEnv()` runs inside `getApp()`, not at import.
- No S3 head/create, no Redis connect, no DB pool, no SMTP verify before a request.
- `globalThis` caches are optimizations only; a fresh isolate must still work.
