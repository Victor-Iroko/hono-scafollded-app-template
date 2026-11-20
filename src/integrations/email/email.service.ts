// Validate now, send later: `enqueue` checks the data against the template's
// schema and hands the email to the job queue; the worker renders and sends it.
import { Context, Effect, Layer, Schema } from "effect";
import { EmailQueue } from "../../jobs/email.queue";
import { emailTemplates, type EmailTemplateData, type EmailTemplateName } from "./templates";

export interface EnqueueEmail<N extends EmailTemplateName> {
  readonly template: N;
  readonly to: string | ReadonlyArray<string>;
  readonly data: EmailTemplateData<N>;
  readonly replyTo?: string;
  /** Repeating an enqueue with the same key sends the email once. */
  readonly idempotencyKey?: string;
}

export class EmailEnqueueError extends Schema.TaggedError<EmailEnqueueError>()(
  "EmailEnqueueError",
  { cause: Schema.Defect() },
) {}

export class EmailService extends Context.Service<
  EmailService,
  {
    readonly enqueue: <N extends EmailTemplateName>(
      email: EnqueueEmail<N>,
    ) => Effect.Effect<string, EmailEnqueueError>;
  }
>()("app/EmailService") {
  static readonly layer = Layer.effect(
    EmailService,
    Effect.gen(function* () {
      const queue = yield* EmailQueue;

      const enqueue = Effect.fn("EmailService.enqueue")(
        function* <N extends EmailTemplateName>(email: EnqueueEmail<N>) {
          const template = emailTemplates[email.template];
          yield* Schema.decodeUnknownEffect(template.schema)(email.data);
          return yield* queue.offer(
            {
              template: email.template,
              to: typeof email.to === "string" ? [email.to] : email.to,
              data: email.data,
              ...(email.replyTo ? { replyTo: email.replyTo } : {}),
            },
            email.idempotencyKey ? { id: email.idempotencyKey } : undefined,
          );
        },
        Effect.mapError((cause) => new EmailEnqueueError({ cause })),
      );

      return EmailService.of({ enqueue });
    }),
  ).pipe(Layer.provide(EmailQueue.layer));
}
