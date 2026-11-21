// Enqueue → Redis queue → worker → SMTP → Mailpit. Requires Redis and Mailpit
// from docker-compose.test.yml.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Effect, Layer, ManagedRuntime } from "effect";
import { EmailService } from "../../src/integrations/email/email.service";
import { WorkerLive } from "../../src/jobs/worker";
import { TEST_MAILPIT_API, testConfig } from "../support/config";

const runtime = ManagedRuntime.make(
  Layer.mergeAll(EmailService.layer, WorkerLive).pipe(Layer.provide(testConfig())),
);

interface MailpitMessage {
  readonly ID: string;
  readonly Subject: string;
  readonly To: ReadonlyArray<{ readonly Address: string }>;
}

const messagesTo = async (address: string): Promise<ReadonlyArray<MailpitMessage>> => {
  const response = await fetch(
    `${TEST_MAILPIT_API}/search?query=${encodeURIComponent(`to:"${address}"`)}`,
  );
  const body = (await response.json()) as { messages: ReadonlyArray<MailpitMessage> };
  return body.messages;
};

const waitForMessages = async (address: string, count: number, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await messagesTo(address);
    if (messages.length >= count) return messages;
    await Bun.sleep(200);
  }
  return messagesTo(address);
};

const enqueueWelcome = (to: string, idempotencyKey?: string) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const emails = yield* EmailService;
      return yield* emails.enqueue({
        template: "welcome",
        to,
        data: { name: "Ada", loginUrl: "https://app.test/login" },
        ...(idempotencyKey ? { idempotencyKey } : {}),
      });
    }),
  );

const EMAIL_TEST_TIMEOUT_MS = 15_000;

/** Waits until Mailpit answers, so a freshly started container does not fail the first send. */
const waitForMailpit = async (timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await fetch(`${TEST_MAILPIT_API}/info`).then(
      (r) => r.ok,
      () => false,
    );
    if (ready) return;
    await Bun.sleep(200);
  }
  throw new Error("Mailpit did not start; run docker compose -f docker-compose.test.yml up -d");
};

beforeAll(async () => {
  await waitForMailpit();
  await runtime.runPromise(Effect.void); // builds the layers, which starts the workers
});

afterAll(() => runtime.dispose());

describe("email delivery", () => {
  test(
    "a queued email is rendered and delivered by the worker",
    async () => {
      const to = `ada.${crypto.randomUUID()}@example.test`;
      await enqueueWelcome(to);

      const [message] = await waitForMessages(to, 1);
      expect(message?.Subject).toBe("Welcome to Acme, Ada");
    },
    EMAIL_TEST_TIMEOUT_MS,
  );

  test(
    "an idempotency key sends the email once",
    async () => {
      const to = `grace.${crypto.randomUUID()}@example.test`;
      const key = `welcome:${crypto.randomUUID()}`;
      await enqueueWelcome(to, key);
      await enqueueWelcome(to, key);

      await waitForMessages(to, 1);
      await Bun.sleep(1_500); // give a duplicate time to arrive, if there were one
      expect(await messagesTo(to)).toHaveLength(1);
    },
    EMAIL_TEST_TIMEOUT_MS,
  );

  test("invalid template data is rejected at enqueue time", async () => {
    const exit = await runtime.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const emails = yield* EmailService;
          return yield* emails.enqueue({
            template: "welcome",
            to: "x@example.test",
            data: { name: "", loginUrl: "https://app.test" },
          });
        }),
      ),
    );
    expect(exit._tag).toBe("Failure");
  });
});
