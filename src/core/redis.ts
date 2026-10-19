import Redis from "ioredis";
import { createMiddleware } from "hono/factory";
import { getEnv } from "./env";
import { getLogger } from "./logger";

export type RedisVariables = { redis: Redis };

const globalCache = globalThis as unknown as {
  __redisClient?: Redis;
};

function createClient(): Redis {
  const created = new Redis(getEnv().REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    connectTimeout: 5_000,
    commandTimeout: 500,
    keepAlive: 30_000,
  });
  created.on("error", (err) => {
    try {
      getLogger().warn({ err }, "redis connection error");
    } catch {
      /* logger not ready */
    }
  });
  created.on("close", () => {
    try {
      getLogger().warn("redis connection closed");
    } catch {
      /* logger not ready */
    }
  });
  return created;
}

export function getRedis(): Redis {
  return (globalCache.__redisClient ??= createClient());
}

export function redisMiddleware() {
  void getRedis();
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
  const elapsed = () => Math.round(performance.now() - start);
  try {
    const res = await getRedis().ping();
    return { ok: res === "PONG", latencyMs: elapsed() };
  } catch {
    return { ok: false, latencyMs: elapsed() };
  }
}

export async function closeRedis(): Promise<void> {
  const active = globalCache.__redisClient;
  globalCache.__redisClient = undefined;
  if (active) await active.quit().catch(() => active.disconnect());
}
