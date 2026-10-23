import type { Child, FC } from "hono/jsx";
import { renderToString } from "hono/jsx/dom/server";
import { z } from "zod";
import { PasswordResetEmail, passwordResetSchema } from "./templates/password-reset";
import { VerifyEmail, verifyEmailSchema } from "./templates/verify-email";
import { WelcomeEmail, welcomeSchema } from "./templates/welcome";

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

/** Pairs template data validation with its subject and rendering. */
export function defineEmail<S extends z.ZodType>(email: {
  schema: S;
  subject: (data: z.output<S>) => string;
  component: FC<z.output<S>>;
  /** Falls back to a plain-text conversion of the HTML. */
  text?: (data: z.output<S>) => string;
}) {
  return {
    ...email,
    render: (data: unknown): RenderedEmail => {
      const parsed = email.schema.parse(data);
      // Email templates are synchronous by convention. renderToString still
      // throws if a component returns a Promise, so the cast only bridges the
      // type gap, it does not hide an async mistake.
      const html = renderToString(email.component(parsed) as unknown as Child);
      return {
        subject: email.subject(parsed),
        html,
        text: email.text?.(parsed) ?? htmlToText(html),
      };
    },
  };
}

export const emails = {
  welcome: defineEmail({
    schema: welcomeSchema,
    subject: (data) => `Welcome to Acme, ${data.name}`,
    component: WelcomeEmail,
  }),
  passwordReset: defineEmail({
    schema: passwordResetSchema,
    subject: () => "Reset your password",
    component: PasswordResetEmail,
  }),
  verifyEmail: defineEmail({
    schema: verifyEmailSchema,
    subject: () => "Verify your email address",
    component: VerifyEmail,
  }),
};

export type EmailName = keyof typeof emails;
/** The data a template expects, as the caller passes it (before defaults). */
export type EmailData<N extends EmailName> = z.input<(typeof emails)[N]["schema"]>;

export function renderEmail(name: string, data: unknown): RenderedEmail {
  const template = emails[name as EmailName];
  if (!template) throw new Error(`Unknown email template "${name}"`);
  return template.render(data);
}

/** Fallback only; templates can provide custom text when needed. */
function htmlToText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h1|h2|h3|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}
