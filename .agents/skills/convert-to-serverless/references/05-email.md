# Email

The template sends through a global nodemailer transporter with SMTP. That holds a raw TCP connection and a pool across requests, which a function cannot keep. Pick the branch that matches the answer to the email question.

Keep `src/integrations/email/registry.ts`, the templates, and `enqueueEmail` unchanged. Only the transport and the health check change.

## Common cleanup

`src/integrations/email/index.ts` currently exports SMTP internals:

```ts
export { checkEmailHealth, closeSmtp, getSmtpTransport } from "./smtp";
```

For every HTTP provider, delete that line and delete `src/integrations/email/smtp.ts`.

`src/api/health/health.service.ts` and `src/index.ts` import `checkEmailHealth` / `closeSmtp`. Remove both:

- `health.service.ts` no longer checks email.
- `index.ts` no longer calls `closeSmtp()` on shutdown.

If you keep SMTP, keep `smtp.ts` but make the transport per send (see the last section).

## Resend

Install:

```sh
bun add resend
```

Add to `src/core/env.ts`:

```ts
RESEND_API_KEY: z.string().min(1),
```

`src/integrations/email/send.ts` — replace:

```ts
import { Resend } from "resend";
import { getEnv } from "../../core/env";
import type { OutboundEmail } from "./send";

export type OutboundEmail = {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

let client: Resend | undefined;

function getResend(): Resend {
  return (client ??= new Resend(getEnv().RESEND_API_KEY));
}

/** Isolates email delivery so the provider can be replaced without changing callers. */
export async function sendEmail(message: OutboundEmail): Promise<{ messageId: string }> {
  const env = getEnv();

  const { data, error } = await getResend().emails.send({
    from: env.EMAIL_FROM,
    to: message.to,
    replyTo: message.replyTo ?? env.EMAIL_REPLY_TO,
    subject: message.subject,
    html: message.html,
    text: message.text,
  });

  if (error) throw new Error(error.message);
  return { messageId: data?.id ?? "" };
}
```

Resend accepts `to` as a string or an array. Remove the `prom-client` counters and histogram with the rest of the metrics code.

## Postmark

Install:

```sh
bun add postmark
```

Env:

```ts
POSTMARK_SERVER_TOKEN: z.string().min(1),
POSTMARK_MESSAGE_STREAM: z.string().min(1).default("outbound"),
```

```ts
import { ServerClient } from "postmark";
import { getEnv } from "../../core/env";

export type OutboundEmail = {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

let client: ServerClient | undefined;

function getPostmark(): ServerClient {
  return (client ??= new ServerClient(getEnv().POSTMARK_SERVER_TOKEN));
}

export async function sendEmail(message: OutboundEmail): Promise<{ messageId: string }> {
  const env = getEnv();

  const result = await getPostmark().sendEmail({
    From: env.EMAIL_FROM,
    To: Array.isArray(message.to) ? message.to.join(",") : message.to,
    ReplyTo: message.replyTo ?? env.EMAIL_REPLY_TO,
    Subject: message.subject,
    HtmlBody: message.html,
    TextBody: message.text,
    MessageStream: env.POSTMARK_MESSAGE_STREAM,
  });

  return { messageId: result.MessageID };
}
```

## Amazon SES v2

Install:

```sh
bun add @aws-sdk/client-sesv2
```

Env:

```ts
SES_REGION: z.string().min(1).optional(),
```

```ts
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { getEnv } from "../../core/env";

export type OutboundEmail = {
  to: string | string[];
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
};

let client: SESv2Client | undefined;

function getSes(): SESv2Client {
  const env = getEnv();
  return (client ??= new SESv2Client({
    region: env.SES_REGION ?? env.S3_REGION,
  }));
}

export async function sendEmail(message: OutboundEmail): Promise<{ messageId: string }> {
  const env = getEnv();
  const replyTo = message.replyTo ?? env.EMAIL_REPLY_TO;

  const result = await getSes().send(
    new SendEmailCommand({
      FromEmailAddress: env.EMAIL_FROM,
      Destination: {
        ToAddresses: Array.isArray(message.to) ? message.to : [message.to],
      },
      ReplyToAddresses: replyTo ? [replyTo] : undefined,
      Content: {
        Simple: {
          Subject: { Data: message.subject },
          Body: {
            Html: { Data: message.html },
            Text: { Data: message.text },
          },
        },
      },
    }),
  );

  return { messageId: result.MessageId ?? "" };
}
```

Use IAM credentials from the runtime role, not static keys. On Lambda, the execution role already has them.

## Keep SMTP

SMTP works from Node functions as long as you do not pool. Replace the global transporter:

```ts
import { createTransport } from "nodemailer";
import { getEnv } from "../../core/env";

function connectionUrl(): string {
  const env = getEnv();
  if (!env.SMTP_USER) return env.SMTP_URL;

  const url = new URL(env.SMTP_URL);
  url.username = env.SMTP_USER;
  url.password = env.SMTP_PASSWORD ?? "";
  return url.toString();
}

export async function sendEmail(message: OutboundEmail): Promise<{ messageId: string }> {
  const env = getEnv();
  const transport = createTransport(connectionUrl(), { pool: false });

  try {
    const info = await transport.sendMail({
      from: env.EMAIL_FROM,
      to: message.to,
      replyTo: message.replyTo ?? env.EMAIL_REPLY_TO,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    return { messageId: info.messageId };
  } finally {
    transport.close();
  }
}
```

Also:

- Remove `getSmtpTransport`, `closeSmtp`, and `checkEmailHealth` from `smtp.ts` and `index.ts`.
- Remove `pool=true` from `SMTP_URL` examples.
- Expect a TCP handshake per email; keep `EMAIL_RATE_MAX` low through QStash flow control.
- SMTP cannot run on Cloudflare Workers. If the target is edge, choose an HTTP provider.

## Rate limit

The email queue keeps its flow control:

```ts
flowControl: () => ({
  key: "email",
  rate: getEnv().EMAIL_RATE_MAX,
  period: "1s",
  parallelism: 10,
}),
```

That replaces the BullMQ worker `limiter` and `concurrency: 10`. QStash applies it per flow-control key, across all function instances.

## What does not change

- `src/integrations/email/registry.ts`
- `src/integrations/email/templates/*`
- `src/integrations/email/enqueue.ts` (only the return type, from `Job` to `{ messageId }`)
- Better Auth's `sendResetPassword`, `sendVerificationEmail`, and welcome hook
- `EMAIL_FROM` and `EMAIL_REPLY_TO`
