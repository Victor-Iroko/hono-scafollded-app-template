// Requires the Redis from docker-compose.test.yml:
//   docker compose -f docker-compose.test.yml up -d --wait redis-test
import { afterAll, describe, expect, test } from "bun:test";
import { Effect, ManagedRuntime } from "effect";
import { RateLimits } from "../../src/platform/rate-limits";
import { withTestConfig } from "../support/config";

const runtime = ManagedRuntime.make(RateLimits.layer.pipe(withTestConfig()));
// Nothing listens on port 1, so every store call fails.
const deadRedis = ManagedRuntime.make(
  RateLimits.layer.pipe(
    withTestConfig({ REDIS_URL: "redis://localhost:1", REDIS_CONNECT_TIMEOUT_MS: "100" }),
  ),
);

afterAll(async () => {
  await Promise.all([runtime.dispose(), deadRedis.dispose()]);
});

const consume = (key: string, capacity: number) =>
  Effect.gen(function* () {
    const limits = yield* RateLimits;
    return yield* limits.consume({ key, capacity, refillWindow: "1 minute" });
  });

describe("RateLimits", () => {
  test("allows a burst up to capacity, then limits", async () => {
    const key = `test:${crypto.randomUUID()}`;
    const decisions = await runtime.runPromise(Effect.forEach([1, 2, 3, 4], () => consume(key, 3)));

    expect(decisions.map((decision) => decision._tag)).toEqual([
      "Allowed",
      "Allowed",
      "Allowed",
      "Limited",
    ]);
    expect(decisions[2]).toMatchObject({ remaining: 0 });
  });

  test("keeps buckets apart by key", async () => {
    const [first, second] = [`test:${crypto.randomUUID()}`, `test:${crypto.randomUUID()}`];
    await runtime.runPromise(consume(first, 1));

    const decision = await runtime.runPromise(consume(second, 1));
    expect(decision._tag).toBe("Allowed");
  });

  test("reports Unavailable instead of failing when Redis is down", async () => {
    const startedAt = performance.now();
    const decision = await deadRedis.runPromise(consume("test:dead", 10));

    expect(decision._tag).toBe("Unavailable");
    // Fail fast: bounded by the 100 ms store timeout, not a connection timeout.
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
