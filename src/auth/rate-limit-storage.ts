import type { BetterAuthRateLimitStorage } from "better-auth";
import { getLogger } from "../core/logger";
import { getRedis } from "../core/redis";

// Atomic so concurrent requests cannot read a stale count before incrementing.
const consumeScript = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
return {count, ttl}
`;

/** Shares Better Auth's rate limit counters across every API instance. */
export function createRedisRateLimitStorage(): BetterAuthRateLimitStorage {
  return {
    async consume(key, rule) {
      try {
        const [count, ttl] = (await getRedis().eval(
          consumeScript,
          1,
          `auth:rate-limit:${key}`,
          rule.window * 1000,
        )) as [number, number];

        if (count <= rule.max) return { allowed: true, retryAfter: null };

        const retryAfter = ttl > 0 ? Math.max(1, Math.ceil(ttl / 1000)) : rule.window;
        return { allowed: false, retryAfter };
      } catch (err) {
        // Match the global limiter: an unavailable Redis must not block sign-in.
        getLogger().warn({ err }, "auth rate limiter unavailable; allowing request");
        return { allowed: true, retryAfter: null };
      }
    },
  };
}
