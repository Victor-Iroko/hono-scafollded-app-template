import { afterEach, describe, expect, test } from "bun:test";
import { Duration, Effect, Layer, Schema } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { RateLimit, RateLimitPolicy } from "../../../src/http/rate-limit";
import {
  type ConsumeOptions,
  type RateLimitDecision,
  RateLimits,
} from "../../../src/platform/rate-limits";
import { testConfig } from "../../support/config";

class TestGroup extends HttpApiGroup.make("test", { topLevel: true })
  .add(HttpApiEndpoint.get("open", "/open", { success: Schema.Struct({ ok: Schema.Boolean }) }))
  .add(
    HttpApiEndpoint.get("strict", "/strict", {
      success: Schema.Struct({ ok: Schema.Boolean }),
    }).annotate(RateLimitPolicy, {
      bucket: "strict",
      capacity: 2,
      refillWindow: "1 minute",
      cost: 2,
    }),
  )
  .middleware(RateLimit) {}

class TestApi extends HttpApi.make("test").add(TestGroup) {}

const TestHandlers = HttpApiBuilder.group(TestApi, "test", (handlers) =>
  handlers
    .handle("open", () => Effect.succeed({ ok: true }))
    .handle("strict", () => Effect.succeed({ ok: true })),
);

/** A RateLimits that answers with a scripted decision and records each call. */
function makeHandler(decision: RateLimitDecision, env: Record<string, string> = {}) {
  const calls: ConsumeOptions[] = [];
  const limits = Layer.succeed(
    RateLimits,
    RateLimits.of({
      consume: (options) => Effect.sync(() => (calls.push(options), decision)),
    }),
  );
  const app = HttpApiBuilder.layer(TestApi).pipe(
    Layer.provide(TestHandlers),
    Layer.provideMerge(RateLimit.layerNoDeps.pipe(Layer.provide(limits))),
    Layer.provide([testConfig(env), HttpServer.layerServices]),
  );
  const web = HttpRouter.toWebHandler(app, { disableLogger: true });
  disposers.push(web.dispose);
  return { calls, get: (path: string) => web.handler(new Request(`http://localhost${path}`)) };
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

describe("RateLimit middleware", () => {
  test("serves allowed requests with limit headers", async () => {
    const { get, calls } = makeHandler({ _tag: "Allowed", limit: 100, remaining: 99 });
    const response = await get("/open");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-ratelimit-limit")).toBe("100");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("99");
    expect(calls[0]).toMatchObject({ key: "global:unknown", capacity: 100 });
  });

  test("rejects limited requests with 429 and Retry-After", async () => {
    const { get } = makeHandler({
      _tag: "Limited",
      limit: 100,
      retryAfter: Duration.millis(1_500),
    });
    const response = await get("/open");

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("content-type")).toContain("application/problem+json");
  });

  test("applies an endpoint's own bucket, capacity and cost", async () => {
    const { get, calls } = makeHandler({ _tag: "Allowed", limit: 2, remaining: 0 });
    await get("/strict");

    expect(calls[0]).toMatchObject({ key: "strict:unknown", capacity: 2, cost: 2 });
  });

  test("fails open by default when the store is unavailable", async () => {
    const { get } = makeHandler({ _tag: "Unavailable" });
    expect((await get("/open")).status).toBe(200);
  });

  test("fails closed with 503 when configured", async () => {
    const { get } = makeHandler({ _tag: "Unavailable" }, { RATE_LIMIT_FAIL_MODE: "closed" });
    expect((await get("/open")).status).toBe(503);
  });
});
