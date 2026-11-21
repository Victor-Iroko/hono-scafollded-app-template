// SMTP delivery through nodemailer. Any relay works: Mailpit locally; SES,
// Postmark, Mailgun, ... in production. Swap this service to use an HTTP API
// provider without changing callers.
import { Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect";
import { createTransport } from "nodemailer";
import { EmailConfig } from "../config";

export interface OutboundEmail {
  readonly to: string | ReadonlyArray<string>;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly replyTo?: string | undefined;
}

export class MailerError extends Schema.TaggedError<MailerError>()("MailerError", {
  /** A 5xx SMTP reply: retrying the same message will not help. */
  permanent: Schema.Boolean,
  cause: Schema.Defect(),
}) {}

const isPermanentSmtpFailure = (error: unknown) => {
  const code = (error as { responseCode?: unknown } | null)?.responseCode;
  return typeof code === "number" && code >= 500 && code < 600;
};

export class Mailer extends Context.Service<
  Mailer,
  {
    readonly send: (
      email: OutboundEmail,
    ) => Effect.Effect<{ readonly messageId: string }, MailerError>;
    /** Verifies the relay accepts a connection and our credentials. */
    readonly check: Effect.Effect<void, MailerError>;
  }
>()("app/Mailer") {
  static readonly layer = Layer.effect(
    Mailer,
    Effect.gen(function* () {
      const config = yield* EmailConfig;
      if (Option.isSome(config.smtpUser) !== Option.isSome(config.smtpPassword)) {
        return yield* Effect.fail(new Error("SMTP_USER and SMTP_PASSWORD must be set together"));
      }

      const url = new URL(Redacted.value(config.smtpUrl));
      if (Option.isSome(config.smtpUser)) url.username = config.smtpUser.value;
      if (Option.isSome(config.smtpPassword))
        url.password = Redacted.value(config.smtpPassword.value);

      const transport = yield* Effect.acquireRelease(
        Effect.sync(() => createTransport(url.toString())),
        (transport) => Effect.sync(() => transport.close()),
      );
      const fromNodemailer = (error: unknown) =>
        new MailerError({ permanent: isPermanentSmtpFailure(error), cause: error });
      const withTimeout = (duration: Duration.Duration, operation: string) =>
        Effect.timeoutOrElse({
          duration,
          orElse: () =>
            Effect.fail(
              new MailerError({
                permanent: false,
                cause: new Error(`SMTP ${operation} timed out`),
              }),
            ),
        });

      const send = Effect.fn("Mailer.send")(function* (email: OutboundEmail) {
        const replyTo = email.replyTo ?? Option.getOrUndefined(config.replyTo);
        const info = yield* Effect.tryPromise({
          try: () =>
            transport.sendMail({
              from: config.from,
              to: [...(typeof email.to === "string" ? [email.to] : email.to)],
              subject: email.subject,
              html: email.html,
              text: email.text,
              ...(replyTo ? { replyTo } : {}),
            }),
          catch: fromNodemailer,
        }).pipe(withTimeout(Duration.millis(config.sendTimeoutMs), "send"));
        return { messageId: info.messageId };
      });

      const check = Effect.tryPromise({
        try: () => transport.verify(),
        catch: fromNodemailer,
      }).pipe(withTimeout(Duration.seconds(2), "verify"), Effect.asVoid);

      return Mailer.of({ send, check });
    }),
  );
}
