import { z } from "zod";
import type { Job } from "bullmq";
import { getEnv } from "../core/env";
import { getLogger } from "../core/logger";
import { getQueue } from "../core/queue";
import { renderEmail } from "../integrations/email/registry";
import { sendEmail } from "../integrations/email/send";

export type QueueConfig = {
  concurrency: number;
  /** Worker rate limit, resolved lazily so a queue can read its own env. */
  limiter?: () => { max: number; duration: number };
};

export const queues = {
  default: { concurrency: 5 },
  email: {
    concurrency: 10,
    // Stay under the relay's per-second ceiling or it starts rejecting.
    limiter: () => ({ max: getEnv().EMAIL_RATE_MAX, duration: 1_000 }),
  },
} as const satisfies Record<string, QueueConfig>;

export type QueueName = keyof typeof queues;

export function defineJob<Q extends QueueName, S extends z.ZodType>(job: {
  queue: Q;
  schema: S;
  run: (data: z.output<S>, job: Job) => Promise<void>;
}) {
  return job;
}

const exampleSchema = z.object({
  message: z.string().min(1),
  shouldFail: z.boolean().default(false),
});

const emailSchema = z.object({
  template: z.string().min(1),
  to: z.union([z.email(), z.array(z.email()).min(1)]),
  replyTo: z.email().optional(),
  // Kept opaque on purpose: the template's own schema validates it on render.
  data: z.unknown(),
});

export const jobs = {
  example: defineJob({
    queue: "default",
    schema: exampleSchema,
    run: async (data) => {
      if (data.shouldFail) throw new Error("example job failed on purpose");
      getLogger().info({ message: data.message }, "example job ran");
    },
  }),

  send: defineJob({
    queue: "email",
    schema: emailSchema,
    run: async (data) => {
      const { subject, html, text } = renderEmail(data.template, data.data);
      const { messageId } = await sendEmail({
        to: data.to,
        replyTo: data.replyTo,
        subject,
        html,
        text,
      });
      getLogger().info({ to: data.to, template: data.template, messageId }, "email sent");
    },
  }),
};

export type JobName = keyof typeof jobs;
export type JobData<N extends JobName> = z.input<(typeof jobs)[N]["schema"]>;
export type QueueJobName<Q extends QueueName> = {
  [N in JobName]: (typeof jobs)[N]["queue"] extends Q ? N : never;
}[JobName];

export function enqueue<Q extends QueueName, N extends QueueJobName<Q>>(
  queue: Q,
  name: N,
  data: JobData<N>,
) {
  return getQueue(queue).add(name, jobs[name as JobName].schema.parse(data));
}

export async function runJob(queue: QueueName, job: Job) {
  const definition = jobs[job.name as JobName];
  if (!definition || definition.queue !== queue) {
    throw new Error(`No handler for job "${job.name}" on queue "${queue}"`);
  }
  await definition.run(job.data, job);
}
