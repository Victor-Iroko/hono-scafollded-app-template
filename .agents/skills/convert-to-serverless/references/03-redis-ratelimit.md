# Redis and rate limiting: ioredis to Upstash

The app has two Redis clients and two limiters:

- `src/core/redis.ts` — ioredis over TCP, cached on `globalThis`, with `keepAlive`, offline queue, and a `closeRedis` shutdown.
- `src/middleware/rate-limit.ts` — `rate-limiter-flexible` `RateLimiterRedis`, a per-process cockatiel circuit breaker, and `getConnInfo` from `@hono/bun`.
- `src/auth/rate-limit-storage.ts` — a Lua `EVAL` script for Better Auth counters.

All three assume a socket and a long-lived process. Replace them with the Upstash HTTP client.

## `src/core/redis.ts` — replace

```ts
import { Redis } from "@upstash/redis";
import { createMiddleware } from "hono/factory";
import { getEnv } from "./env";

export type RedisVariables = { redis: Redis };

let client: Redis | undefined;

export function getRedis(): Redis {
  if (client) return client;

  const env = getEnv();
  client = new Redis({
    url: env.UPSTASH_REDIS_REST_URL,
    token: env.UPSTASH_REDIS_REST_TOKEN,
  });

  return client;
}

export function redisMiddleware() {
  return createMiddleware<{ Variables: RedisVariables }>(async (c, next) => {
    c.set("redis", getRedis());
    await next();
  });
}

export async function checkRedisHealth(): Promise<{
  ok: boolean;
  latencyMs: number;
}> {
  const start = performance.now();
  try {
    const res = await getRedis().ping();
    return { ok: res === "PONG", latencyMs: Math.round(performance.now() - start) };
  } catch {
    return { ok: false, latencyMs: Math.round(performance.now() - start) };
  }
}
```

Removed:

- `import Redis from "ioredis"`.
- `maxRetriesPerRequest`, `enableOfflineQueue`, `enableReadyCheck`, `connectTimeout`, `commandTimeout`, `keepAlive`.
- The `error` / `close` listeners.
- `void getRedis()` in the middleware factory — there is no connection to warm.
- `closeRedis()`. The HTTP client has nothing to close.

Keep `RedisVariables` and the middleware so `src/core/context.ts` and the existing route surface do not change. The client is a lazy singleton with no socket.

## `src/middleware/rate-limit.ts` — replace

```ts
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { Ratelimit } from "@upstash/ratelimit";
import { getRedis } from "../core/redis";
import { getEnv } from "../core/env";
import { getLogger } from "../core/logger";
import type { ErrorResponseBody } from "../core/errors";

export type RateLimitFailMode = "open" | "closed";

export type RateLimitOptions = {
  /** Max points per window. Defaults to env RATE_LIMIT_POINTS. */
  points?: number;
  /** Window length in seconds. Defaults to env RATE_LIMIT_DURATION_S. */
  duration?: number;
  /** Redis key prefix. Defaults to "rl". */
  keyPrefix?: string;
  /** What to do when Redis itself errors. Defaults to "open". */
  failMode?: RateLimitFailMode;
  /** Tokens consumed per request. Defaults to 1. */
  cost?: number;
  /** Resolve the bucket key. Defaults to the client IP from proxy headers. */
  keyGenerator?: (c: Context) => string;
};

const clientIpHeaders = [
  "x-forwarded-for",
  "cf-connecting-ip",
  "x-vercel-forwarded-for",
  "x-real-ip",
];

/**
 * Serverless has no socket address. Read the platform's client IP header
 * instead, and only trust it when a proxy overwrites it.
 */
export function getClientKey(c: Context, trustProxyHeaders: boolean): string {
  if (trustProxyHeaders) {
    for (const header of clientIpHeaders) {
      const first = c.req.header(header)?.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return "unknown";
}

function defaultKeyGenerator(c: Context): string {
  return getClientKey(c, getEnv().AUTH_TRUST_PROXY_HEADERS);
}

export function createRateLimiter(options: RateLimitOptions = {}) {
  const {
    points,
    duration,
    keyPrefix = "rl",
    failMode = "open",
    cost = 1,
    keyGenerator = defaultKeyGenerator,
  } = options;

  // Resolve env lazily so initEnv() ordering is respected.
  const resolvedPoints = points ?? getEnv().RATE_LIMIT_POINTS;
  const resolvedDuration = duration ?? getEnv().RATE_LIMIT_DURATION_S;

  const limiter = new Ratelimit({
    redis: getRedis(),
    // Token bucket: refill `points` every `duration`, burst up to `points`.
    limiter: Ratelimit.tokenBucket(resolvedPoints, `${resolvedDuration} s`, resolvedPoints),
    prefix: keyPrefix,
    timeout: 1_000,
  });

  return createMiddleware(async (c, next) => {
    const key = keyGenerator(c);

    let outcome: Awaited<ReturnType<typeof limiter.limit>>;
    try {
      outcome = await limiter.limit(key, { rate: cost });
    } catch (err) {
      getLogger().warn({ err, key: `${keyPrefix}:${key}` }, "rate limiter error");

      if (failMode === "closed") {
        return c.json<ErrorResponseBody>(
          {
            success: false,
            error: { code: "SERVICE_UNAVAILABLE", message: "Service unavailable" },
            requestId: c.get("requestId"),
            path: `${c.req.method} ${c.req.path}`,
          },
          503,
        );
      }

      // failMode "open": serve the request anyway.
      return next();
    }

    c.header("X-RateLimit-Limit", String(outcome.limit));
    c.header("X-RateLimit-Remaining", String(outcome.remaining));

    if (!outcome.success) {
      const retryAfter = Math.max(1, Math.ceil((outcome.reset - Date.now()) / 1000));
      c.header("Retry-After", String(retryAfter));

      return c.json<ErrorResponseBody>(
        {
          success: false,
          error: { code: "TOO_MANY_REQUESTS", message: "Too many requests" },
          requestId: c.get("requestId"),
          path: `${c.req.method} ${c.req.path}`,
        },
        429,
      );
    }

    await next();
  });
}

export function globalRateLimit(overrides: Partial<RateLimitOptions> = {}) {
  return createRateLimiter({
    keyPrefix: "rl:global",
    failMode: "open",
    ...overrides,
  });
}
```

### Why token bucket

`Ratelimit.tokenBucket(refillRate, interval, maxTokens)` exists in `@upstash/ratelimit`, so use it:

- `refillRate = RATE_LIMIT_POINTS`
- `interval = RATE_LIMIT_DURATION_S` seconds
- `maxTokens = RATE_LIMIT_POINTS`

This preserves the existing "100 per 60 seconds" ceiling while smoothing the boundary. It allows an initial burst of 100, then refills continuously.

If the installed version lacks `tokenBucket`, fall back to:

```ts
limiter: Ratelimit.slidingWindow(resolvedPoints, `${resolvedDuration} s`);
```

Do not use `fixedWindow` unless the goal is to match the old behavior exactly; it reintroduces the boundary burst.

### Removed behavior

- **Cockatiel circuit breaker.** It was per-process; every cold start reset it and instances never shared state. The HTTP client fails per call. Keep `failMode` for the policy.
- **`blockDuration`.** Token bucket has no separate block. Drop the option; the bucket naturally delays.
- **`getConnInfo` from `@hono/bun`.** There is no Bun socket. Header-based keys replace it. Set `AUTH_TRUST_PROXY_HEADERS=true` in production, behind a proxy that overwrites the header.
- **`unknown` key pooling.** Requests with no resolvable IP share one bucket. That is the existing TODO item; the header list reduces it on major platforms.

### `pending` on edge

If you enable `analytics: true`, `limit()` returns a `pending` promise. On Vercel or Cloudflare, pass it to `waitUntil`:

```ts
const outcome = await limiter.limit(key);
c.executionCtx.waitUntil(outcome.pending); // Cloudflare
```

Leave analytics off if you do not need it.

## `src/auth/rate-limit-storage.ts` — replace

```ts
import type { BetterAuthRateLimitStorage } from "better-auth";
import { getLogger } from "../core/logger";
import { getRedis } from "../core/redis";

/** Shares Better Auth's rate limit counters across every function instance. */
export function createRedisRateLimitStorage(): BetterAuthRateLimitStorage {
  return {
    async consume(key, rule) {
      const redisKey = `auth:rate-limit:${key}`;

      try {
        // INCR + EXPIRE NX in one MULTI: no Lua, one round trip.
        const [count] = (await getRedis()
          .multi()
          .incr(redisKey)
          .expire(redisKey, rule.window, "NX")
          .exec()) as [number, number];

        if (count <= rule.max) return { allowed: true, retryAfter: null };

        const ttl = await getRedis().ttl(redisKey);
        return {
          allowed: false,
          retryAfter: ttl > 0 ? ttl : rule.window,
        };
      } catch (err) {
        // Match the global limiter: an unavailable Redis must not block sign-in.
        getLogger().warn({ err }, "auth rate limiter unavailable; allowing request");
        return { allowed: true, retryAfter: null };
      }
    },
  };
}
```

`rule.window` is in seconds, which is what `EXPIRE` expects. `EXPIRE ... NX` sets the TTL only on the first increment, matching the old script's `if count == 1`.

### Alternative: Better Auth secondary storage

Better Auth supports `secondaryStorage` with an `increment` method, and `rateLimit.storage: "secondary-storage"` uses it. That removes this file entirely, but it also mirrors sessions into Redis. Use it only if you want Redis-backed sessions too:

```ts
import { Redis } from "@upstash/redis";
import type { SecondaryStorage } from "better-auth";

const redis = Redis.fromEnv();

const secondaryStorage: SecondaryStorage = {
  get: (key) => redis.get(key),
  getAndDelete: (key) => redis.getdel(key),
  async increment(key, ttl) {
    const [value] = await redis.multi().incr(key).expire(key, ttl, "NX").exec();
    return value as number;
  },
  async set(key, value, ttl) {
    if (ttl) await redis.set(key, value, { ex: ttl });
    else await redis.set(key, value);
  },
  delete: (key) => redis.del(key),
};

// in betterAuth({ ... })
secondaryStorage,
rateLimit: { enabled: true, storage: "secondary-storage" },
```

Keep the `customStorage` path by default to avoid changing session behavior.

## `src/auth/auth.ts` — add proxy IP resolution

Serverless has no socket IP, and Better Auth falls back to one shared bucket when it cannot resolve an address. Add:

```ts
advanced: {
  trustedProxyHeaders: env.AUTH_TRUST_PROXY_HEADERS,
  ipAddress: {
    ipAddressHeaders: [
      "x-forwarded-for",
      "cf-connecting-ip",
      "x-vercel-forwarded-for",
    ],
  },
},
```

Keep `rateLimit.customStorage: createRedisRateLimitStorage()`. The import path does not change.

## Entrypoint cleanup

`src/index.ts` and `src/worker.ts` import `closeRedis`. Remove it from the shutdown list and delete the worker entirely. There is no Redis connection to quit.
