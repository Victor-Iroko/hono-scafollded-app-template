import type { FC } from "hono/jsx";
import { z } from "zod";
import { Button, EmailLayout, Heading, Paragraph } from "../components";

export const welcomeSchema = z.object({
  name: z.string().min(1),
  loginUrl: z.url(),
});

export type WelcomeData = z.output<typeof welcomeSchema>;

export const WelcomeEmail: FC<WelcomeData> = ({ name, loginUrl }) => (
  <EmailLayout preview="Your account is ready." title="Welcome">
    <Heading>Welcome, {name}</Heading>
    <Paragraph>Thanks for signing up. Your account is ready to use.</Paragraph>
    <Button href={loginUrl}>Sign in</Button>
    <Paragraph>If you did not create this account, you can ignore this email.</Paragraph>
  </EmailLayout>
);
