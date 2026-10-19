import { Queue } from "bullmq";
import { BullMQOtel } from "bullmq-otel";
import { getEnv } from "./env";

// Cache on globalThis so `bun --hot` reloads don't leak connections.
const globalCache = globalThis as unknown as { __queues?: Map<string, Queue> };

let telemetry: BullMQOtel | undefined;

export function getTelemetry(): BullMQOtel {
  return (telemetry ??= new BullMQOtel({
    tracerName: "bullmq",
    meterName: "bullmq",
    enableMetrics: true,
  }));
}

// BullMQ opens blocking connections, which need maxRetriesPerRequest: null.
// Keep this separate from the cache Redis client in ./redis.ts.
export function getQueueConnection() {
  return { url: getEnv().REDIS_JOBS_URL, maxRetriesPerRequest: null };
}

export function getQueue(name: string): Queue {
  const queues = (globalCache.__queues ??= new Map());
  const existing = queues.get(name);
  if (existing) return existing;

  const queue = new Queue(name, {
    connection: getQueueConnection(),
    prefix: getEnv().QUEUE_PREFIX,
    telemetry: getTelemetry(),
    defaultJobOptions: {
      attempts: getEnv().JOB_MAX_ATTEMPTS,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 86_400, count: 5_000 },
    },
  });
  queues.set(name, queue);
  return queue;
}

export async function closeQueues(): Promise<void> {
  const queues = globalCache.__queues;
  globalCache.__queues = undefined;
  if (!queues) return;
  await Promise.allSettled([...queues.values()].map((queue) => queue.close()));
}
