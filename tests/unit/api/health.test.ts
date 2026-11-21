import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiMiddleware, HttpApiTest } from "effect/http-api";
import { HealthHandlersNoDeps } from "../../../src/api/health/health.handlers";
import { HealthService, type Readiness } from "../../../src/api/health/health.service";
import { Authenticated } from "../../../src/auth/auth.middleware";
import { Api } from "../../../src/http/api";
import { RateLimit } from "../../../src/http/rate-limit";

// The health group uses neither; the in-memory client still builds the whole API.
const UnusedApiMiddleware = Layer.mergeAll(
  Layer.succeed(
    RateLimit,
    RateLimit.of((httpEffect) => httpEffect),
  ),
  Layer.succeed(Authenticated, Authenticated.of({ sessionCookie: () => Effect.die("unused") })),
);

const healthy: Readiness = {
  ok: true,
  draining: false,
  checks: {
    database: { ok: true, latencyMs: 1 },
    cacheRedis: { ok: true, latencyMs: 1 },
    jobsRedis: { ok: true, latencyMs: 1 },
    storage: { ok: true, latencyMs: 1 },
  },
};

const callHealthApi = <A, E>(
  readiness: Readiness,
  call: (client: Effect.Success<ReturnType<typeof makeClient>>) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const client = yield* makeClient();
    return yield* call(client);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        HealthHandlersNoDeps.pipe(
          Layer.provide(
            Layer.succeed(
              HealthService,
              HealthService.of({ readiness: Effect.succeed(readiness) }),
            ),
          ),
          Layer.provideMerge(
            Layer.mergeAll(HttpApiMiddleware.layerProblemDetails(), UnusedApiMiddleware),
          ),
        ),
        HttpServer.layerServices,
      ),
    ),
    Effect.scoped,
    Effect.runPromise,
  );

const makeClient = () => HttpApiTest.groups(Api, ["health"]);

describe("health api", () => {
  test("GET /healthz reports the process is alive", async () => {
    expect(await callHealthApi(healthy, (client) => client.getHealth())).toEqual({ ok: true });
  });

  test("GET /readyz reports every dependency when ready", async () => {
    expect(await callHealthApi(healthy, (client) => client.getReadiness())).toEqual({
      ok: true,
      checks: healthy.checks,
    });
  });

  test("GET /readyz fails with NotReady while draining", async () => {
    const draining: Readiness = { ...healthy, ok: false, draining: true };
    const error = await callHealthApi(draining, (client) => Effect.flip(client.getReadiness()));

    expect(error._tag).toBe("NotReady");
    expect(error).toMatchObject({ status: 503, draining: true });
  });
});
