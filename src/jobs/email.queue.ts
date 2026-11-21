import { Context, Schema } from "effect";
import type { PersistedQueue } from "effect/persistence";
import { EmailTemplateName } from "../integrations/email/templates";
import { queueLayer } from "./queue";

export const SendEmail = Schema.Struct({
  template: EmailTemplateName,
  to: Schema.Array(Schema.String),
  replyTo: Schema.optionalKey(Schema.String),
  // Validated by the template's own schema, on enqueue and again on render.
  data: Schema.Unknown,
});

export type SendEmail = typeof SendEmail.Type;

export class EmailQueue extends Context.Service<
  EmailQueue,
  PersistedQueue.PersistedQueue<SendEmail>
>()("app/jobs/EmailQueue") {
  static readonly options = { name: "email", maxAttempts: 5 };
  static readonly layer = queueLayer(EmailQueue, SendEmail, EmailQueue.options);
}
