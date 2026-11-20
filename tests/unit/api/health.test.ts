import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { HttpServer } from "effect/http";
import { HttpApiTest } from "effect/http-api";
import { HealthHandlers } from "../../../src/api/health/health.handlers";
import { Api } from "../../../src/http/api";

const TestLive = Layer.mergeAll(HealthHandlers, HttpServer.layerServices);

describe("health api", () => {
  test("GET /healthz reports the process is alive", async () => {
    const response = await Effect.gen(function* () {
      const client = yield* HttpApiTest.groups(Api, ["health"]);
      return yield* client.getHealth();
    }).pipe(Effect.provide(TestLive), Effect.scoped, Effect.runPromise);

    expect(response).toEqual({ ok: true });
  });
});
