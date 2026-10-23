import type { FC } from "hono/jsx";
import { z } from "zod";
import { Button, EmailLayout, Heading, Paragraph } from "../components";

export const verifyEmailSchema = z.object({
  name: z.string().min(1),
  verifyUrl: z.url(),
  expiresInMinutes: z.number().int().min(1).default(60),
});

export type VerifyEmailData = z.output<typeof verifyEmailSchema>;

export const VerifyEmail: FC<VerifyEmailData> = ({ name, verifyUrl, expiresInMinutes }) => (
  <EmailLayout preview="Verify your email address." title="Verify your email">
    <Heading>Verify your email</Heading>
    <Paragraph>Hi {name}, confirm your email address to finish setting up your account.</Paragraph>
    <Button href={verifyUrl}>Verify email</Button>
    <Paragraph>
      The link expires in {expiresInMinutes} minutes. If you did not create this account, ignore
      this email.
    </Paragraph>
  </EmailLayout>
);
