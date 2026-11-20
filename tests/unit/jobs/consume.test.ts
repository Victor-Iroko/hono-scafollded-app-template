import { describe, expect, test } from "bun:test";
import { Context, Deferred, Effect, Layer, Schema } from "effect";
import { PersistedQueue } from "effect/persistence";
import { consume } from "../../../src/jobs/consume";

const Job = Schema.Struct({ value: Schema.String });

class TestQueue extends Context.Service<
  TestQueue,
  PersistedQueue.PersistedQueue<typeof Job.Type>
>()("test/TestQueue") {}

const options = { name: "test", maxAttempts: 1 };

const TestQueueLive = Layer.effect(
  TestQueue,
  PersistedQueue.make({ ...options, schema: Job }),
).pipe(Layer.provide(PersistedQueue.layer), Layer.provide(PersistedQueue.layerStoreMemory));

describe("consume", () => {
  test("keeps processing after a job fails permanently", async () => {
    const processed = await Effect.gen(function* () {
      const done = yield* Deferred.make<string>();
      const handled: string[] = [];

      const worker = consume(TestQueue, { ...options, concurrency: 1 }, (job) =>
        job.value === "bad"
          ? Effect.fail("boom" as const)
          : Effect.andThen(
              Effect.sync(() => handled.push(job.value)),
              Deferred.succeed(done, job.value),
            ),
      );

      const queue = yield* TestQueue;
      yield* queue.offer({ value: "bad" });
      yield* queue.offer({ value: "good" });
      yield* Layer.build(worker);

      yield* Deferred.await(done);
      return handled;
    }).pipe(Effect.provide(TestQueueLive), Effect.scoped, Effect.runPromise);

    expect(processed).toEqual(["good"]);
  });
});
