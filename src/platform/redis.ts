// Two Redis instances with different durability contracts:
//
// - CacheRedis: cache and rate-limit state. Evictable (allkeys-lru), commands
//   fail fast while disconnected instead of queueing behind a dead socket.
// - JobsRedis: the persisted job queue. Must run with noeviction and AOF, and
//   commands queue during a reconnect so producers ride out a blip.
//
// Both expose Effect's generic `Redis` service shape. Effect modules that need
// a `Redis` (RateLimiter, PersistedQueue stores) get one of them provided
// locally through `asRedis`, so the two can never be swapped by accident.
import { BunRedis } from "@effect/platform-bun";
import { Context, Duration, Effect, Layer, Redacted, Schedule } from "effect";
import { Redis } from "effect/persistence";
import { RedisConfig } from "../config";

type RedisShape = Redis.Redis["Service"];

// Exponential backoff capped at 5 seconds between attempts.
const RECONNECT_SCHEDULE = Schedule.min([
  Schedule.exponential(Duration.millis(200)),
  Schedule.spaced(Duration.seconds(5)),
]);

// Bun's client connects lazily, and with the offline queue off the first
// command would fail before any socket exists. Connect while the layer builds;
// if Redis is down at boot, start anyway and keep retrying in the background,
// so a cache outage degrades requests instead of crash-looping the process.
const connectOnBuild = (name: string, timeout: Duration.Duration) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const { client } = yield* BunRedis.BunRedis;
      const connect = Effect.tryPromise(() => client.connect());
      const connected = yield* Effect.exit(Effect.timeout(connect, timeout));
      if (connected._tag === "Success") return;

      yield* Effect.logWarning("redis unavailable at startup; retrying in the background").pipe(
        Effect.annotateLogs({ redis: name }),
      );
      yield* connect.pipe(Effect.retry(RECONNECT_SCHEDULE), Effect.ignore, Effect.forkScoped);
    }),
  );

const redisLayer = (select: "cacheUrl" | "jobsUrl", options: { readonly failFast: boolean }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* RedisConfig;
      const client = BunRedis.layer({
        url: Redacted.value(config[select]),
        connectionTimeout: config.connectTimeoutMs,
        autoReconnect: true,
        enableOfflineQueue: !options.failFast,
      });
      const timeout = Duration.millis(config.connectTimeoutMs);
      return connectOnBuild(select, timeout).pipe(Layer.provideMerge(client));
    }),
  );

export class CacheRedis extends Context.Service<CacheRedis, RedisShape>()("app/CacheRedis") {
  static readonly layer = Layer.effect(CacheRedis, Effect.service(Redis.Redis)).pipe(
    Layer.provide(redisLayer("cacheUrl", { failFast: true })),
  );

  /** Provides this instance as Effect's generic `Redis` service. */
  static readonly asRedis = Layer.effect(Redis.Redis, Effect.service(CacheRedis)).pipe(
    Layer.provide(CacheRedis.layer),
  );
}

export class JobsRedis extends Context.Service<JobsRedis, RedisShape>()("app/JobsRedis") {
  static readonly layer = Layer.effect(JobsRedis, Effect.service(Redis.Redis)).pipe(
    Layer.provide(redisLayer("jobsUrl", { failFast: false })),
  );

  /** Provides this instance as Effect's generic `Redis` service. */
  static readonly asRedis = Layer.effect(Redis.Redis, Effect.service(JobsRedis)).pipe(
    Layer.provide(JobsRedis.layer),
  );
}
