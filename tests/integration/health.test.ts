// Requires the Postgres from docker-compose.test.yml.
import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { HealthService } from "../../src/api/health/health.service";
import { ShutdownSignal } from "../../src/http/shutdown";
import { withTestConfig } from "../support/config";

const runtime = ManagedRuntime.make(
  HealthService.layer.pipe(Layer.provideMerge(ShutdownSignal.layer), withTestConfig()),
);

afterAll(() => runtime.dispose());

describe("HealthService", () => {
  test("is ready when the database answers", async () => {
    const readiness = await runtime.runPromise(
      Effect.gen(function* () {
        const health = yield* HealthService;
        return yield* health.readiness;
      }),
    );

    expect(readiness.ok).toBe(true);
    expect(readiness.draining).toBe(false);
    expect(readiness.checks.database.ok).toBe(true);
  });

  test("stops being ready once draining begins", async () => {
    const readiness = await runtime.runPromise(
      Effect.gen(function* () {
        const shutdown = yield* ShutdownSignal;
        const health = yield* HealthService;
        yield* shutdown.beginDraining;
        return yield* health.readiness;
      }),
    );

    expect(readiness).toMatchObject({ ok: false, draining: true });
  });
});
