import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { makeDeliverEmail } from "../../../src/jobs/email.job";
import type { SendEmail } from "../../../src/jobs/email.queue";
import { Mailer, MailerError, type OutboundEmail } from "../../../src/platform/mailer";
import { RateLimits } from "../../../src/platform/rate-limits";
import { testConfig } from "../../support/config";

const welcomeJob: SendEmail = {
  template: "welcome",
  to: ["ada@example.com"],
  data: { name: "Ada", loginUrl: "https://app.test" },
};

/** Runs one delivery with a scripted mailer; returns the exit and what was sent. */
async function deliver(
  job: SendEmail,
  send: (email: OutboundEmail) => Effect.Effect<{ messageId: string }, MailerError>,
) {
  const sent: OutboundEmail[] = [];
  const mailer = Layer.succeed(
    Mailer,
    Mailer.of({
      send: (email) => Effect.tap(send(email), () => Effect.sync(() => sent.push(email))),
      check: Effect.void,
    }),
  );
  const limits = Layer.succeed(
    RateLimits,
    RateLimits.of({ consume: () => Effect.succeed({ _tag: "Allowed", limit: 10, remaining: 9 }) }),
  );

  const exit = await Effect.gen(function* () {
    const deliverEmail = yield* makeDeliverEmail;
    return yield* deliverEmail(job, { id: "job-1", attempt: 1 });
  }).pipe(
    Effect.provide(Layer.mergeAll(mailer, limits, testConfig())),
    Effect.exit,
    Effect.runPromise,
  );

  return { exit, sent };
}

describe("deliverEmail", () => {
  test("renders and sends the email", async () => {
    const { exit, sent } = await deliver(welcomeJob, () => Effect.succeed({ messageId: "m-1" }));

    expect(exit._tag).toBe("Success");
    expect(sent[0]?.subject).toBe("Welcome to Acme, Ada");
    expect(sent[0]?.to).toEqual(["ada@example.com"]);
  });

  test("fails on a transient error so the job retries", async () => {
    const { exit } = await deliver(welcomeJob, () =>
      Effect.fail(new MailerError({ permanent: false, cause: new Error("connection reset") })),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("completes on a permanent rejection instead of retrying", async () => {
    const { exit } = await deliver(welcomeJob, () =>
      Effect.fail(
        new MailerError({ permanent: true, cause: new Error("550 mailbox unavailable") }),
      ),
    );
    expect(exit._tag).toBe("Success");
  });

  test("drops a job whose data no longer fits the template", async () => {
    const { exit, sent } = await deliver({ ...welcomeJob, data: { name: "" } }, () =>
      Effect.succeed({ messageId: "m-1" }),
    );

    expect(exit._tag).toBe("Success");
    expect(sent).toHaveLength(0);
  });
});
