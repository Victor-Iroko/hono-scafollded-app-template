// Renders and sends one queued email.
//
// - Transient failures (relay down, timeouts, 4xx) fail the job so it retries.
// - Permanent failures (5xx rejection, data that no longer fits the template)
//   are logged and reported, then the job completes: retrying cannot help.
// - Sends are throttled across every worker to EMAIL_RATE_PER_SECOND.
// Recipient addresses are never logged.
import { Cause, Duration, Effect, ErrorReporter } from "effect";
import { EmailConfig } from "../config";
import { renderEmail } from "../integrations/email/templates";
import { Mailer } from "../platform/mailer";
import { RateLimits } from "../platform/rate-limits";
import type { JobContext } from "./consume";
import type { SendEmail } from "./email.queue";

const dropPermanently = (reason: string, cause: unknown) =>
  Effect.logError(`email dropped: ${reason}`).pipe(
    Effect.annotateLogs({ cause }),
    Effect.andThen(ErrorReporter.report(Cause.fail(cause))),
  );

export const makeDeliverEmail = Effect.gen(function* () {
  const mailer = yield* Mailer;
  const limits = yield* RateLimits;
  const { ratePerSecond } = yield* EmailConfig;

  const waitForSendSlot = Effect.gen(function* () {
    while (true) {
      const decision = yield* limits.consume({
        key: "email:relay",
        capacity: ratePerSecond,
        refillWindow: Duration.seconds(1),
      });
      // Unavailable (Redis down) sends anyway; the relay is the final limit.
      if (decision._tag !== "Limited") return;
      yield* Effect.sleep(decision.retryAfter);
    }
  });

  return (job: SendEmail, _context: JobContext) =>
    Effect.gen(function* () {
      const rendered = yield* Effect.exit(renderEmail(job.template, job.data));
      if (rendered._tag === "Failure") {
        return yield* dropPermanently(
          "data does not match the template",
          Cause.squash(rendered.cause),
        );
      }

      yield* waitForSendSlot;
      const sent = yield* mailer
        .send({ to: job.to, replyTo: job.replyTo, ...rendered.value })
        .pipe(
          Effect.catchTag("MailerError", (error) =>
            error.permanent
              ? Effect.as(dropPermanently("rejected by the relay", error), undefined)
              : Effect.fail(error),
          ),
        );
      if (sent) {
        yield* Effect.logInfo("email sent").pipe(
          Effect.annotateLogs({ template: job.template, messageId: sent.messageId }),
        );
      }
    }).pipe(Effect.annotateLogs({ template: job.template }));
});
