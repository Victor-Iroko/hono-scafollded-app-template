import type { Job } from "bullmq";
import { getDbErrorMessage } from "../core/db-errors";
import { getQueue } from "../core/queue";

export const DEAD_LETTER_QUEUE = "dead-letter";

export async function moveToDeadLetter(job: Job, error: Error): Promise<void> {
  await getQueue(DEAD_LETTER_QUEUE).add(
    job.name,
    {
      data: job.data,
      error: getDbErrorMessage(error),
      sourceQueue: job.queueName,
      sourceJobId: job.id,
      failedAt: new Date().toISOString(),
    },
    { attempts: 1 },
  );
}
