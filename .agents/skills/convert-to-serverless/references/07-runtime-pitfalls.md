# Runtime pitfalls

These are the places where the template silently depends on Bun, Node, a socket, or a warm process. Fix them only when they apply to the chosen runtime; the table says where.

## `Bun.file` in request paths

**Where:** `src/app.ts:43` and `src/app.ts:92`

```ts
const spec = await Bun.file("openapi.json").text();
c.json(await Bun.file("openapi.json").json());
```

`Bun` is missing on Node and Workers, and the working directory or bundle may not contain `openapi.json`.

**Fix:** import the JSON at build time and serialize it.

```ts
import openapi from "../../openapi.json";

const spec = JSON.stringify(openapi);
// route
(c) => c.json(openapi);
```

Add `"resolveJsonModule": true` to `tsconfig.json`. If the bundle grows too much, move `/docs` and `/openapi.json` to static hosting and delete the routes.

**Applies to:** all targets.

## `@hono/bun` `getConnInfo`

**Where:** `src/middleware/rate-limit.ts:2` and `:48`

`getConnInfo(c).remote.address` reads the Bun server socket. Serverless has no socket.

**Fix:** read `x-forwarded-for`, `cf-connecting-ip`, `x-vercel-forwarded-for`, or `x-real-ip`, and require `AUTH_TRUST_PROXY_HEADERS=true` behind a proxy that overwrites them. This is covered in [03-redis-ratelimit.md](03-redis-ratelimit.md).

Remove `@hono/bun` if nothing else uses it.

**Applies to:** all targets.

## `node:crypto` and `Buffer` in Paystack

**Where:** `src/integrations/payments/paystack.ts:1` and `:482`

```ts
import { createHmac, timingSafeEqual } from "node:crypto";
const body = typeof rawBody === "string" ? rawBody : Buffer.from(new Uint8Array(rawBody));
```

`node:crypto` works on Node/Bun. Workers only get it with `nodejs_compat`, and `Buffer` needs a polyfill.

**Fix (edge):** WebCrypto.

```ts
async function hmacSha512(secret: string, body: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function verifyWebhookSignature(
  rawBody: string | ArrayBuffer | Uint8Array,
  signature: string | undefined,
): Promise<boolean> {
  if (!signature || !/^[a-f\d]{128}$/i.test(signature)) return false;
  const secret = getEnv().PAYSTACK_SECRET_KEY;
  if (!secret) return false;

  const text = typeof rawBody === "string" ? rawBody : new TextDecoder().decode(rawBody);
  const expected = await hmacSha512(secret, text);
  const received = new Uint8Array(
    signature.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16)),
  );

  return constantTimeEqual(expected, received);
}
```

The function becomes async. There is no webhook route in the template today, so no caller changes; if one is added, `await` it.

**Applies to:** edge targets. Node/Bun can keep `node:crypto`.

## Process-local caches

**Where:** `src/core/db.ts`, `src/core/redis.ts`, `src/core/s3.ts`, `src/core/queue.ts`, `src/integrations/email/smtp.ts`, `src/core/logger.ts`, `src/core/instrumentation.ts`, `src/app.ts` (`llmsTxt`).

`globalThis.__db`, `__redisClient`, `__s3`, `__s3Presign`, `__queues`, `__smtp`, plus `rootLogger`, `sdk`, and the memoized `llmsTxt`.

**Rule:** reuse is an optimization, never a correctness guarantee. A fresh isolate must work with empty caches.

- Delete the queue cache and the SMTP cache with those modules.
- Keep the DB, Redis, and S3 singletons; they are lazy and cheap.
- Do not store rate-limit counters, job state, or sessions in a module variable.
- `llmsTxt` may memoize per isolate; a cold start regenerates it.

**Applies to:** all targets.

## `process.env` on edge

**Where:** `src/core/env.ts:77`

`initEnv(source = process.env)` already accepts a source object. On Cloudflare, pass the binding object from the handler:

```ts
fetch(request, env) {
  return getApp(env).fetch(request);
}
```

`getEnv()` caches per isolate. Do not read `process.env` directly elsewhere.

**Applies to:** edge targets.

## `tsconfig` types

**Where:** `tsconfig.json:11` — `"types": ["bun"]`

- Node/Vercel/AWS: keep `bun` if the code uses Bun APIs; otherwise `["node"]`.
- Cloudflare: `["@cloudflare/workers-types"]`.
- Do not ship Bun types to a Workers build.

**Applies to:** all targets.

## S3 bucket bootstrap

**Where:** `src/index.ts:16-20` and `src/core/s3.ts:202-239`

`ensureBucket()` runs at boot. Every cold start pays an S3 round trip, concurrent instances race, and a missing bucket can block the first request.

**Fix:** move it to `scripts/create-bucket.ts`, run it as a deploy step or in IaC, and delete the boot branch. Keep `ensureBucket()` for local development.

**Applies to:** all targets.

## AWS SDK on edge

**Where:** `src/core/s3.ts` — `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`

The SDK is large and uses Node APIs in places. On Workers, prefer:

- R2 binding with `drizzle`/`fetch`, or
- `aws4fetch` for SigV4 signing, or
- an S3-compatible HTTP API with presigned URLs generated by a Node service.

The existing `S3_PUBLIC_ENDPOINT` logic still applies: presigned URLs must be signed for the host the browser reaches.

**Applies to:** edge targets.

## `hono/context-storage`

`AsyncLocalStorage` is available on Node/Bun and on Workers with `nodejs_compat`. `getLogger()` already falls back to the root logger when `tryGetContext` fails. Do not make correctness depend on the store; pass the request context explicitly where it matters.

**Applies to:** edge targets.

## `nodemailer` and `pg`

Neither runs on Workers. Pick the HTTP email provider and an HTTP DB driver (Neon HTTP or D1). This is why the skill asks for the runtime first.

**Applies to:** edge targets.

## `setTimeout` in health checks

The DB/S3/Redis health helpers race a timer. That still works, but do not call them on `/healthz`, and keep the timeout below the platform's function timeout.

**Applies to:** all targets.

## `Bun --hot` and dev scripts

`bun run dev` can stay for local Node/Bun development. Remove `worker` and `dev:all`; there is no worker process. On edge, use the platform's local dev server (`wrangler dev`, `vercel dev`) so bindings exist.

**Applies to:** all targets.
