import { sql } from "drizzle-orm";
import { Context, Duration, Effect, Layer } from "effect";
import { ShutdownSignal } from "../../http/shutdown";
import { Database } from "../../platform/database";
import { CacheRedis } from "../../platform/redis";
import type { DependencyCheck, DependencyChecks } from "./health.schema";

const PROBE_TIMEOUT = Duration.seconds(2);
// Probes hit real dependencies; caching keeps frequent /readyz polling cheap.
const PROBE_CACHE_TTL = Duration.seconds(2);

export interface Readiness {
  readonly ok: boolean;
  readonly draining: boolean;
  readonly checks: DependencyChecks;
}

/** Runs a probe with a timeout and reports the outcome instead of failing. */
const checkDependency = <A, E>(name: string, probe: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const startedAt = performance.now();
    const outcome = yield* probe.pipe(Effect.timeout(PROBE_TIMEOUT), Effect.exit);
    const latencyMs = Math.round(performance.now() - startedAt);
    if (outcome._tag === "Failure") {
      yield* Effect.logWarning("readiness probe failed").pipe(
        Effect.annotateLogs({ dependency: name, cause: outcome.cause }),
      );
    }
    return { ok: outcome._tag === "Success", latencyMs } satisfies DependencyCheck;
  });

// Requires ShutdownSignal from outside the HTTP app: the server's shutdown hook
// flips the same instance this service reads.
export class HealthService extends Context.Service<
  HealthService,
  { readonly readiness: Effect.Effect<Readiness> }
>()("app/HealthService") {
  static readonly layer = Layer.effect(
    HealthService,
    Effect.gen(function* () {
      const db = yield* Database;
      const redis = yield* CacheRedis;
      const shutdown = yield* ShutdownSignal;

      const probeAll = Effect.all(
        {
          database: checkDependency("database", db.execute(sql`select 1`)),
          redis: checkDependency("redis", redis.send("PING")),
        },
        { concurrency: "unbounded" },
      );
      const cachedChecks = yield* Effect.cachedWithTTL(probeAll, PROBE_CACHE_TTL);

      const readiness = Effect.gen(function* () {
        const draining = yield* shutdown.isDraining;
        const checks = yield* cachedChecks;
        const ok = !draining && Object.values(checks).every((check) => check.ok);
        return { ok, draining, checks };
      }).pipe(Effect.withSpan("HealthService.readiness"));

      return HealthService.of({ readiness });
    }),
  ).pipe(Layer.provide([Database.layer, CacheRedis.layer]));
}
