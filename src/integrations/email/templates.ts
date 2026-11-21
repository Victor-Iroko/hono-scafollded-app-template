// Email templates. Each pairs a data schema with its subject and markup; the
// data is validated when the email is enqueued and again when it is rendered.
// To add one: define it below and add it to `emailTemplates`.
import { Effect, Schema } from "effect";
import { html, htmlToText, type Html } from "./html";
import { button, heading, layout, paragraph } from "./layout";

const APP_NAME = "Acme";

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

interface EmailTemplate<S extends Schema.Top> {
  readonly schema: S;
  readonly subject: (data: S["Type"]) => string;
  readonly render: (data: S["Type"]) => Html;
  /** Defaults to a plain-text conversion of the HTML. */
  readonly text?: (data: S["Type"]) => string;
}

/** Keeps the typed schema for callers and exposes one validating `render` for the worker. */
const defineEmail = <S extends Schema.Top & { readonly DecodingServices: never }>(
  template: EmailTemplate<S>,
) => ({
  schema: template.schema,
  render: (data: unknown) =>
    Effect.map(Schema.decodeUnknownEffect(template.schema)(data), (decoded): RenderedEmail => {
      const markup = template.render(decoded).value;
      return {
        subject: template.subject(decoded),
        html: markup,
        text: template.text?.(decoded) ?? htmlToText(markup),
      };
    }),
});

const welcome = defineEmail({
  schema: Schema.Struct({ name: Schema.NonEmptyString, loginUrl: Schema.NonEmptyString }),
  subject: ({ name }) => `Welcome to ${APP_NAME}, ${name}`,
  render: ({ name, loginUrl }) =>
    layout({
      title: "Welcome",
      preview: "Your account is ready.",
      body: html`${[
        heading(`Welcome, ${name}`),
        paragraph("Thanks for signing up. Your account is ready to use."),
        button({ href: loginUrl, label: "Sign in" }),
        paragraph("If you did not create this account, you can ignore this email."),
      ]}`,
    }),
});

const verifyEmail = defineEmail({
  schema: Schema.Struct({
    name: Schema.NonEmptyString,
    verifyUrl: Schema.NonEmptyString,
    expiresInMinutes: Schema.Int,
  }),
  subject: () => "Verify your email address",
  render: ({ name, verifyUrl, expiresInMinutes }) =>
    layout({
      title: "Verify your email",
      preview: "Verify your email address.",
      body: html`${[
        heading("Verify your email"),
        paragraph(`Hi ${name}, confirm your email address to finish setting up your account.`),
        button({ href: verifyUrl, label: "Verify email" }),
        paragraph(
          `The link expires in ${expiresInMinutes} minutes. If you did not create this account, ignore this email.`,
        ),
      ]}`,
    }),
});

const passwordReset = defineEmail({
  schema: Schema.Struct({
    name: Schema.NonEmptyString,
    resetUrl: Schema.NonEmptyString,
    expiresInMinutes: Schema.Int,
  }),
  subject: () => "Reset your password",
  render: ({ name, resetUrl, expiresInMinutes }) =>
    layout({
      title: "Reset your password",
      preview: "Reset your password.",
      body: html`${[
        heading("Reset your password"),
        paragraph(`Hi ${name}, we received a request to reset your password.`),
        button({ href: resetUrl, label: "Choose a new password" }),
        paragraph(
          `The link expires in ${expiresInMinutes} minutes. If you did not ask for this, ignore this email; your password stays the same.`,
        ),
      ]}`,
    }),
});

export const emailTemplates = { welcome, verifyEmail, passwordReset };

export type EmailTemplateName = keyof typeof emailTemplates;
export type EmailTemplateData<N extends EmailTemplateName> =
  (typeof emailTemplates)[N]["schema"]["Type"];
export const EmailTemplateName = Schema.Literals(
  Object.keys(emailTemplates) as Array<EmailTemplateName>,
);

/** Validates the data against the template's schema and renders subject, HTML and text. */
export const renderEmail = (name: EmailTemplateName, data: unknown) =>
  emailTemplates[name]
    .render(data)
    .pipe(Effect.withSpan("renderEmail", { attributes: { template: name } }));
