// Every queue consumer the worker process runs. To add a queue: declare it
// (see ./email.queue.ts), write its handler, and add a `consume` line here.
import { Effect, Layer } from "effect";
import { EmailConfig } from "../config";
import { Mailer } from "../platform/mailer";
import { RateLimits } from "../platform/rate-limits";
import { consume } from "./consume";
import { makeDeliverEmail } from "./email.job";
import { EmailQueue } from "./email.queue";
import { QueueCleanupLive } from "./queue";

const EmailWorkerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { workerConcurrency } = yield* EmailConfig;
    const deliverEmail = yield* makeDeliverEmail;
    return consume(
      EmailQueue,
      { ...EmailQueue.options, concurrency: workerConcurrency },
      deliverEmail,
    );
  }),
).pipe(Layer.provide([EmailQueue.layer, Mailer.layer, RateLimits.layer]));

export const WorkerLive = Layer.mergeAll(EmailWorkerLive, QueueCleanupLive);
