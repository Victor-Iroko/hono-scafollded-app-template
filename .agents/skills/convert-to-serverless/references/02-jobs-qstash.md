# Jobs: BullMQ to QStash

BullMQ owns a Redis connection, a worker process, and in-process job events. QStash is HTTP: publish a message, QStash calls your endpoint, retries on non-2xx, and dead-letters after the last retry.

## Delete

- `src/worker.ts`
- `src/core/worker.ts`
- `src/core/queue.ts`
- `src/jobs/dead-letter.ts` — QStash has a DLQ

Keep the old files until the callback route works. Delete them in the last job step.

## Semantics

| BullMQ                              | QStash                                                              |
| ----------------------------------- | ------------------------------------------------------------------- |
| queue name                          | destination URL `/api/jobs/:queue`                                  |
| `attempts: 3`                       | `retries: 2` (QStash counts retries after the first attempt, max 5) |
| exponential backoff                 | built-in exponential backoff, or `retryDelay`                       |
| `delay`                             | `delay` (seconds)                                                   |
| `jobId`                             | `deduplicationId` (10-minute window)                                |
| worker `limiter`                    | `flowControl.rate` + `period`                                       |
| worker `concurrency`                | `flowControl.parallelism`                                           |
| `removeOnComplete` / `removeOnFail` | QStash event log / DLQ; no direct equivalent                        |
| repeatable jobs                     | `schedules.create({ destination, cron })`                           |
| dead-letter queue                   | QStash DLQ                                                          |
| `stalled` event                     | none — rely on retries and idempotent handlers                      |

## `src/core/qstash.ts` — add

```ts
import { Client, Receiver } from "@upstash/qstash";
import { getEnv } from "./env";

let client: Client | undefined;
let receiver: Receiver | undefined;

export function getQStash(): Client {
  if (client) return client;

  const env = getEnv();
  client = new Client({
    token: env.QSTASH_TOKEN,
    // Omit in production to use the regional QStash default.
    ...(env.QSTASH_URL ? { baseUrl: env.QSTASH_URL } : {}),
  });

  return client;
}

export function getQStashReceiver(): Receiver {
  if (receiver) return receiver;

  const env = getEnv();
  receiver = new Receiver({
    currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY,
  });

  return receiver;
}
```

Do not use `devMode: true` if the local QStash service runs in Docker; the SDK would spawn a second server on the same port.

## `src/jobs/index.ts` — replace

```ts
import { z } from "zod";
import { getEnv } from "../core/env";
import { getLogger } from "../core/logger";
import { getQStash } from "../core/qstash";
import { renderEmail } from "../integrations/email/registry";
import { sendEmail } from "../integrations/email/send";

export type FlowControl = {
  key: string;
  rate?: number;
  period?: string;
  parallelism?: number;
};

export type QueueConfig = {
  flowControl?: () => FlowControl;
};

export const queues = {
  default: {},
  email: {
    // Stay under the relay's per-second ceiling.
    flowControl: () => ({
      key: "email",
      rate: getEnv().EMAIL_RATE_MAX,
      period: "1s",
      parallelism: 10,
    }),
  },
} as const satisfies Record<string, QueueConfig>;

export type QueueName = keyof typeof queues;

export type JobContext = {
  /** QStash's `Upstash-Retried` header: 0 on the first delivery. */
  retried: number;
};

export function defineJob<Q extends QueueName, S extends z.ZodType>(job: {
  queue: Q;
  schema: S;
  run: (data: z.output<S>, context: JobContext) => Promise<void>;
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

/** Validation and routing failures: retrying cannot fix them. */
export class NonRetryableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableJobError";
  }
}

export function enqueue<Q extends QueueName, N extends QueueJobName<Q>>(
  queue: Q,
  name: N,
  data: JobData<N>,
) {
  const config: QueueConfig = queues[queue];

  return getQStash().publishJSON({
    url: `${getEnv().QSTASH_DESTINATION_URL}/api/jobs/${queue}`,
    body: { name, data: jobs[name as JobName].schema.parse(data) },
    retries: getEnv().JOB_MAX_RETRIES,
    ...(config.flowControl ? { flowControl: config.flowControl() } : {}),
  });
}

export async function runJob(
  queue: QueueName,
  envelope: { name: string; data: unknown },
  context: JobContext,
) {
  const definition = jobs[envelope.name as JobName];
  if (!definition || definition.queue !== queue) {
    throw new NonRetryableJobError(`No handler for job "${envelope.name}" on queue "${queue}"`);
  }

  const data = definition.schema.parse(envelope.data);
  await definition.run(data, context);
}
```

`enqueue()` now returns `{ messageId: string }` instead of a BullMQ `Job`. Callers in `src/auth/auth.ts` and `src/integrations/email/enqueue.ts` already ignore the return value, so only the type changes.

## `src/api/jobs/jobs.schema.ts` — add

```ts
import { z } from "zod";

export const jobEnvelopeSchema = z.object({
  name: z.string().min(1),
  data: z.unknown(),
});

export type JobEnvelope = z.infer<typeof jobEnvelopeSchema>;
```

## `src/api/jobs/jobs.service.ts` — add

```ts
import { getEnv } from "../../core/env";
import { getQStashReceiver } from "../../core/qstash";
import { NonRetryableJobError, runJob } from "../../jobs";
import type { QueueName } from "../../jobs";
import { jobEnvelopeSchema } from "./jobs.schema";

export class UnauthorizedJobError extends Error {
  constructor(message = "Invalid signature") {
    super(message);
    this.name = "UnauthorizedJobError";
  }
}

export async function handleJobRequest(
  queue: QueueName,
  body: string,
  signature: string | undefined,
  retried: number,
) {
  if (!signature) throw new UnauthorizedJobError();

  const valid = await getQStashReceiver()
    .verify({
      signature,
      body,
      // Must equal the URL the message was published to: it is the JWT `sub`.
      url: `${getEnv().QSTASH_DESTINATION_URL}/api/jobs/${queue}`,
    })
    .catch(() => false);

  if (!valid) throw new UnauthorizedJobError();

  let envelope: ReturnType<typeof jobEnvelopeSchema.parse>;
  try {
    envelope = jobEnvelopeSchema.parse(JSON.parse(body));
  } catch {
    throw new NonRetryableJobError("Invalid job payload");
  }

  await runJob(queue, envelope, { retried });
}
```

Verify the signature against the raw body, before `JSON.parse`. Re-serializing changes the bytes and fails the hash.

## `src/api/jobs/jobs.router.ts` — add

```ts
import { Hono } from "hono";
import { NonRetryableJobError, queues } from "../../jobs";
import type { QueueName } from "../../jobs";
import { handleJobRequest, UnauthorizedJobError } from "./jobs.service";

export const jobsRouter = new Hono();

jobsRouter.post("/:queue", async (c) => {
  const queue = c.req.param("queue") as QueueName;
  if (!(queue in queues)) return c.text("Not Found", 404);

  try {
    await handleJobRequest(
      queue,
      await c.req.text(),
      c.req.header("upstash-signature"),
      Number(c.req.header("upstash-retried") ?? 0),
    );
    return c.json({ ok: true as const });
  } catch (err) {
    if (err instanceof UnauthorizedJobError) {
      return c.text("Invalid signature", 401);
    }

    if (err instanceof NonRetryableJobError) {
      // Tells QStash to stop retrying and move the message to the DLQ.
      return new Response("Non-retryable", {
        status: 489,
        headers: { "Upstash-NonRetryable-Error": "true" },
      });
    }

    throw err; // 5xx: QStash retries, then dead-letters
  }
});
```

## `src/api/router.ts` — mount

```ts
import { jobsRouter } from "./jobs/jobs.router";

apiRouter.route("/api/jobs", jobsRouter);
```

`app.ts` mounts `apiRouter` at `/`, so the final path is `/api/jobs/:queue`.

## Failure policy

| Case                             | Response                                   | Result                                          |
| -------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| Missing/invalid signature        | `401`                                      | QStash retries; fix the keys or destination URL |
| Malformed JSON or schema failure | `489` + `Upstash-NonRetryable-Error: true` | Straight to DLQ                                 |
| Unknown queue or job name        | `489`                                      | Straight to DLQ                                 |
| Provider/DB transient error      | throw → `500`                              | QStash retries, then DLQ                        |
| Success                          | `200`                                      | Message removed                                 |

## Idempotency

QStash delivers at least once. The email job can send twice if a callback times out after the provider accepted the message. Mitigations, in order:

1. Publish with a stable `deduplicationId` (for example the password-reset token hash or user id + template).
2. Persist an `emails` row before publishing and have the callback claim it by status. This is the outbox described in `TODO.md`.
3. Make handlers tolerate duplicates where the provider exposes an idempotency key.

Deduplication only covers a 10-minute window, so it is not a substitute for (2) on critical mail.

## Scheduling

Replace repeatable jobs with QStash schedules:

```ts
await getQStash().schedules.create({
  destination: `${env.QSTASH_DESTINATION_URL}/api/jobs/default`,
  cron: "0 * * * *",
  body: JSON.stringify({ name: "example", data: { message: "hourly" } }),
});
```

Schedules are created once per environment, not at boot.

## Long jobs

QStash waits for your endpoint and aborts at the plan's max HTTP response duration. Keep the callback short: send one email, write one row, return. Split batch work into child messages.
