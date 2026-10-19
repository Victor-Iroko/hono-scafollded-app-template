import { Worker } from "bullmq";
import type { Job } from "bullmq";
import { getEnv } from "./env";
import { getLogger } from "./logger";
import { getDbErrorLogContext } from "./db-errors";
import { getQueueConnection, getTelemetry } from "./queue";
import { queues, runJob } from "../jobs";
import type { QueueConfig, QueueName } from "../jobs";
import { moveToDeadLetter } from "../jobs/dead-letter";

export function startWorkers(): Worker[] {
  return (Object.keys(queues) as QueueName[]).map(startWorker);
}

function startWorker(queue: QueueName): Worker {
  const log = getLogger();

  const config: QueueConfig = queues[queue];
  const worker = new Worker(queue, (job: Job) => runJob(queue, job), {
    connection: getQueueConnection(),
    prefix: getEnv().QUEUE_PREFIX,
    telemetry: getTelemetry(),
    concurrency: config.concurrency,
    limiter: config.limiter?.(),
  });

  worker.on("completed", (job) => {
    log.info({ queue, job: job.name, id: job.id }, "job completed");
  });

  worker.on("failed", (job, error) => {
    if (!job) return;
    log.error(
      {
        queue,
        job: job.name,
        id: job.id,
        attempt: job.attemptsMade,
        err: getDbErrorLogContext(error),
      },
      "job failed",
    );
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      void moveToDeadLetter(job, error).catch((err) =>
        log.error({ err, id: job.id }, "failed to move job to dead letter queue"),
      );
    }
  });

  worker.on("stalled", (jobId) => log.warn({ queue, id: jobId }, "job stalled"));
  worker.on("error", (error) => log.error({ queue, err: error }, "worker error"));

  return worker;
}
