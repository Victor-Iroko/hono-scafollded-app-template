import { enqueue } from "../../jobs";
import { emails } from "./registry";
import type { EmailData, EmailName } from "./registry";

export type EnqueueEmailInput<N extends EmailName> = {
  template: N;
  to: string | string[];
  data: EmailData<N>;
  replyTo?: string;
};

/**
 * Validate now, send later. The props are checked against the template's own
 * schema, and again when the worker renders it.
 */
export function enqueueEmail<N extends EmailName>(input: EnqueueEmailInput<N>) {
  const template = emails[input.template];
  return enqueue("email", "send", {
    template: input.template,
    to: input.to,
    replyTo: input.replyTo,
    data: template.schema.parse(input.data),
  });
}
