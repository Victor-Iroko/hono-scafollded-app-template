# Jobs: PersistedQueue to QStash

`PersistedQueue` needs a worker that polls Redis. QStash is push-based: publish
a message, QStash POSTs it to your callback, retries on non-2xx with
exponential backoff, and dead-letters after the last retry.

## Semantics

| PersistedQueue (today)               | QStash                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| queue                                | callback URL `/internal/jobs/:queue`                                                        |
| `maxAttempts: 5`                     | `Upstash-Retries: 4` (retries after the first attempt)                                      |
| `offer(value, { id })`               | `Upstash-Deduplication-Id: <id>` (dedupe window is limited; keep handlers idempotent)       |
| `offer(value, { delay })`            | `Upstash-Delay: 30s`                                                                        |
| attempt number in `JobContext`       | `Upstash-Retried` header (0 on first delivery) + 1                                          |
| `EMAIL_RATE_PER_SECOND` token bucket | `Upstash-Flow-Control-Key` + `Upstash-Flow-Control-Value: rate=10,period=1s,parallelism=10` |
| failed jobs kept in Redis            | QStash DLQ                                                                                  |
| permanent failure → job completes    | answer 489 with `Upstash-NonRetryable-Error: true`                                          |

## `src/platform/qstash.ts`: add

A `QStash` service with `publish(queue, body, options)` on `HttpClient`
(`POST {QSTASH_URL}/v2/publish/{QSTASH_DESTINATION_URL}/internal/jobs/{queue}`
with `Authorization: Bearer {QSTASH_TOKEN}` and the headers above, decoding
`{ messageId }`), and `verify(signature, rawBody, url)` using `Receiver` from
`@upstash/qstash` with the current and next signing keys. Config goes in a new
`QStashConfig` group in `src/config.ts` (`Config.redacted` for the token and keys).

## `src/integrations/email/email.service.ts`: modify

Keep the schema validation. Replace `queue.offer(...)` with
`qstash.publish("email", payload, { deduplicationId: email.idempotencyKey })`
and provide `QStash.layer` instead of `EmailQueue.layer`. Move the
`SendEmail` schema from `src/jobs/email.queue.ts` into
`src/jobs/email.job.ts` before deleting the queue file.

## `src/jobs/jobs.route.ts`: add

```ts
HttpRouter.add("POST", "/internal/jobs/email", (request) =>
  Effect.gen(function* () {
    const rawBody = yield* request.text; // the signature covers the raw bytes
    const valid = yield* qstash.verify(request.headers["upstash-signature"], rawBody, publicUrl);
    if (!valid)
      return yield* HttpServerRespondable.toResponse(
        new Unauthorized({ detail: "Invalid signature" }),
      );

    const job = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(SendEmail))(rawBody); // 489 on failure
    const attempt = Number(request.headers["upstash-retried"] ?? 0) + 1;
    yield* deliverEmail(job, { id: request.headers["upstash-message-id"] ?? "", attempt });
    return HttpServerResponse.jsonUnsafe({ ok: true });
  }),
);
```

- Build `deliverEmail` once with `makeDeliverEmail` (unchanged from today) when
  the route layer is built. Its permanent-failure path already completes, so it
  answers 200; transient failures fail the effect and `renderFailures` answers
  500, which QStash retries. Map a decode failure to 489 +
  `Upstash-NonRetryable-Error: true`.
- `makeDeliverEmail` throttles through `RateLimits`; with QStash flow control
  that is redundant but harmless. Remove `waitForSendSlot` once flow control is set.
- Mount the route in `AppRoutes` (`src/http/server.ts`), outside the `/v1`
  HttpApi so it is not rate limited.

## Delete

`src/worker.ts`, `src/jobs/{queue,consume,worker,email.queue}.ts`, the
`worker`/`dev:worker`/`dev:all` scripts, the `jobsRedis` readiness check, and
`REDIS_JOBS_URL`. Delete them in the same step that adds the callback, then run
the round trip immediately.
