// Runs a handler against a queue with a fixed number of concurrent workers.
//
// - Handler fails: the job is retried with backoff until `maxAttempts`. The
//   last failure is logged as an error and reported (Sentry); earlier ones are
//   warnings. The failed job stays in Redis as the dead-letter record.
// - Store fails (Redis down): logged, then the worker pauses and resumes.
// - Shutdown interrupts the workers; an interrupted job is released and
//   redelivered later.
import { Cause, type Context, Duration, Effect, Exit, Layer, Metric } from "effect";
import { PersistedQueue } from "effect/persistence";
import { reportError } from "../platform/observability";
import type { QueueOptions } from "./queue";

export interface JobContext {
  readonly id: string;
  readonly attempt: number;
}

const STORE_FAILURE_PAUSE = Duration.seconds(5);

const jobsProcessed = Metric.counter("jobs.processed", {
  description: "Job attempts by queue and outcome (completed, retried, failed)",
  incremental: true,
});
const jobDuration = Metric.timer("jobs.duration", { description: "Job handler duration" });

export const consume = <Self, A, E, R>(
  queue: Context.Key<Self, PersistedQueue.PersistedQueue<A>>,
  options: QueueOptions & { readonly concurrency: number },
  handler: (job: A, context: JobContext) => Effect.Effect<void, E, R>,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const jobs = yield* queue;
      const { name, maxAttempts } = options;

      const recordOutcome = (
        exit: Exit.Exit<unknown, unknown>,
        attempts: number,
        startedAt: number,
      ) => {
        if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) return Effect.void;
        const outcome = Exit.isSuccess(exit)
          ? "completed"
          : attempts < maxAttempts
            ? "retried"
            : "failed";
        const attributes = { queue: name, outcome };
        return Effect.andThen(
          Metric.update(Metric.withAttributes(jobsProcessed, attributes), 1),
          Metric.update(
            Metric.withAttributes(jobDuration, attributes),
            Duration.millis(performance.now() - startedAt),
          ),
        );
      };

      const runJob = (job: A, { id, attempts }: { id: string; attempts: number }) =>
        Effect.suspend(() => {
          const startedAt = performance.now();
          return handler(job, { id, attempt: attempts }).pipe(
            Effect.onExit((exit) => recordOutcome(exit, attempts, startedAt)),
          );
        }).pipe(
          Effect.tapCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.void;
            if (attempts < maxAttempts) {
              return Effect.logWarning("job failed; will retry").pipe(
                Effect.annotateLogs({ cause }),
              );
            }
            return Effect.logError("job failed permanently").pipe(
              Effect.annotateLogs({ cause }),
              Effect.andThen(reportError(cause)),
            );
          }),
          Effect.annotateLogs({ "job.queue": name, "job.id": id, "job.attempt": attempts }),
          Effect.withSpan(`job ${name}`, {
            attributes: { "job.queue": name, "job.id": id, "job.attempt": attempts },
          }),
        );

      const worker = jobs.take(runJob).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
          // A handler failure was already logged in runJob; move on to the next job.
          if (!(Cause.squash(cause) instanceof PersistedQueue.PersistedQueueError)) {
            return Effect.void;
          }
          return Effect.logError("job queue unavailable; pausing worker").pipe(
            Effect.annotateLogs({ "job.queue": name, cause }),
            Effect.andThen(Effect.sleep(STORE_FAILURE_PAUSE)),
          );
        }),
        Effect.forever,
      );

      yield* Effect.logInfo("job workers started").pipe(
        Effect.annotateLogs({ "job.queue": name, concurrency: options.concurrency }),
      );
      yield* Effect.forkScoped(
        Effect.all(
          Array.from({ length: options.concurrency }, () => worker),
          {
            concurrency: "unbounded",
            discard: true,
          },
        ),
      );
    }),
  );
