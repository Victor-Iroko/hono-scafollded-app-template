// Durable job queues on the jobs Redis, built on Effect's PersistedQueue.
//
// Delivery is at-least-once: a crash between a handler finishing and the
// acknowledgement redelivers the job, so handlers must be idempotent. Offer
// with `{ id }` to make the id an idempotency key: a second offer with the same
// id is ignored while the first is retained (30 days after it completes).
//
// A queue is a service declared next to its payload schema:
//
//   export class EmailQueue extends Context.Service<EmailQueue, PersistedQueue<SendEmail>>()(
//     "app/jobs/EmailQueue",
//   ) {
//     static readonly options = { name: "email", maxAttempts: 5 };
//     static readonly layer = queueLayer(EmailQueue, SendEmail, EmailQueue.options);
//   }
import { Context, Duration, Layer, Schedule, type Schema } from "effect";
import { PersistedQueue } from "effect/persistence";
import { JobsRedis } from "../platform/redis";

export interface QueueOptions {
  readonly name: string;
  readonly maxAttempts: number;
}

// Exponential backoff from 2 s, capped at 10 minutes between attempts.
const RETRY_SCHEDULE = Schedule.min([
  Schedule.exponential(Duration.seconds(2)),
  Schedule.spaced(Duration.minutes(10)),
]);

const QueueStoreLive = PersistedQueue.layerStoreRedis({ prefix: "jobs:" }).pipe(
  Layer.provide(JobsRedis.asRedis),
);

const QueueFactoryLive = PersistedQueue.layer.pipe(Layer.provide(QueueStoreLive));

/** Removes completed jobs after 30 days. Failed jobs are the dead-letter record and are kept. */
export const QueueCleanupLive = PersistedQueue.layerCleanup().pipe(Layer.provide(QueueStoreLive));

/** Payload schemas must encode and decode without extra services. */
type PayloadSchema = Schema.Top & {
  readonly DecodingServices: never;
  readonly EncodingServices: never;
};

export const queueLayer = <Self, S extends PayloadSchema>(
  tag: Context.Service<Self, PersistedQueue.PersistedQueue<S["Type"]>>,
  schema: S,
  options: QueueOptions,
) =>
  Layer.effect(
    tag,
    PersistedQueue.make({
      name: options.name,
      schema,
      maxAttempts: options.maxAttempts,
      retrySchedule: RETRY_SCHEDULE,
    }),
  ).pipe(Layer.provide(QueueFactoryLive));
