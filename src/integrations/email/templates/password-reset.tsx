import type { FC } from "hono/jsx";
import { z } from "zod";
import { Button, EmailLayout, Heading, Paragraph } from "../components";

export const passwordResetSchema = z.object({
  name: z.string().min(1),
  resetUrl: z.url(),
  expiresInMinutes: z.number().int().min(1).default(60),
});

export type PasswordResetData = z.output<typeof passwordResetSchema>;

export const PasswordResetEmail: FC<PasswordResetData> = ({ name, resetUrl, expiresInMinutes }) => (
  <EmailLayout preview="Reset your password." title="Reset your password">
    <Heading>Reset your password</Heading>
    <Paragraph>Hi {name}, we received a request to reset your password.</Paragraph>
    <Button href={resetUrl}>Choose a new password</Button>
    <Paragraph>
      The link expires in {expiresInMinutes} minutes. If you did not ask for this, you can ignore
      this email — your password stays the same.
    </Paragraph>
  </EmailLayout>
);
