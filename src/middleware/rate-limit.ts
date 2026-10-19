import { createMiddleware } from "hono/factory";
import { getConnInfo } from "@hono/bun";
import type { Context } from "hono";
import { RateLimiterRedis, RateLimiterRes } from "rate-limiter-flexible";
import {
  BrokenCircuitError,
  SamplingBreaker,
  TimeoutStrategy,
  circuitBreaker,
  handleAll,
  timeout,
  wrap,
} from "cockatiel";
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
  /** What to do when Redis itself errors. "open" lets traffic through, "closed" returns 503. Defaults to "open". */
  failMode?: RateLimitFailMode;
  /** Points consumed per request. Defaults to 1. */
  cost?: number;
  /** Resolve the bucket key. Defaults to client IP. */
  keyGenerator?: (c: Context) => string;
  /** Block key for N seconds after exhaustion. Defaults to 0 (no extra block). */
  blockDuration?: number;
};

function defaultKeyGenerator(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** One guard shared by every limiter — they hit the same Redis, so a trip stops them all. */
let redisGuard: ReturnType<typeof buildRedisGuard> | undefined;

function buildRedisGuard() {
  const log = getLogger();

  const breaker = circuitBreaker(handleAll, {
    // After opening, wait 5s, then let one probe request through.
    halfOpenAfter: 5_000,
    // Open when >50% of calls fail over a 10s window, ignoring very low traffic.
    breaker: new SamplingBreaker({
      threshold: 0.5,
      duration: 10_000,
      minimumRps: 5,
    }),
  });

  // Log state transitions once, not per request.
  breaker.onBreak((reason) =>
    log.error(
      { err: "error" in reason ? reason.error : undefined },
      "rate limiter: Redis circuit OPEN, degrading per failMode",
    ),
  );
  breaker.onHalfOpen(() => log.warn("rate limiter: Redis circuit half-open, probing"));
  breaker.onReset(() => log.info("rate limiter: Redis circuit closed, recovered"));

  // Breaker wraps the timeout so timeouts count as failures. 100ms is
  // generous for a ~1-2ms check.
  return wrap(breaker, timeout(100, TimeoutStrategy.Aggressive));
}

function getRedisGuard() {
  return (redisGuard ??= buildRedisGuard());
}

type Outcome = { limited: boolean; res: RateLimiterRes };

/** "Over the limit" becomes a value. Only real infra errors are thrown. */
async function consume(limiter: RateLimiterRedis, key: string, cost: number): Promise<Outcome> {
  try {
    return { limited: false, res: await limiter.consume(key, cost) };
  } catch (err) {
    if (err instanceof RateLimiterRes) return { limited: true, res: err };
    throw err;
  }
}

export function createRateLimiter(options: RateLimitOptions = {}) {
  const {
    points,
    duration,
    keyPrefix = "rl",
    failMode = "open",
    cost = 1,
    keyGenerator = defaultKeyGenerator,
    blockDuration = 0,
  } = options;

  // Resolve env lazily so initEnv() ordering is respected.
  const resolvedPoints = points ?? getEnv().RATE_LIMIT_POINTS;
  const resolvedDuration = duration ?? getEnv().RATE_LIMIT_DURATION_S;

  const limiter = new RateLimiterRedis({
    storeClient: getRedis(),
    keyPrefix,
    points: resolvedPoints,
    duration: resolvedDuration,
    blockDuration,
    // Fail fast if Redis is down rather than queueing the request.
    rejectIfRedisNotReady: true,
  });

  const guard = getRedisGuard();

  return createMiddleware(async (c, next) => {
    const key = keyGenerator(c);
    let outcome: Outcome | undefined;

    try {
      outcome = await guard.execute(() => consume(limiter, key, cost));
    } catch (err) {
      // Only infra failures reach here. An open circuit was already logged,
      // so stay quiet.
      if (!(err instanceof BrokenCircuitError)) {
        getLogger().warn({ err, key: `${keyPrefix}:${key}` }, "rate limiter error");
      }

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
    }

    if (outcome) {
      c.header("X-RateLimit-Limit", String(resolvedPoints));
      c.header("X-RateLimit-Remaining", String(outcome.res.remainingPoints));

      if (outcome.limited) {
        c.header("Retry-After", String(Math.ceil(outcome.res.msBeforeNext / 1000)));
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
