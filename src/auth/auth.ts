import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth/minimal";
import { openAPI } from "better-auth/plugins";
import { getDb } from "../core/db";
import type { DB } from "../core/db";
import type { ENV } from "../core/env";
import { getLogger } from "../core/logger";
import * as authSchema from "../db/schema/auth";
import { AUTH_BASE_PATH } from "./constants";
import { createRedisRateLimitStorage } from "./rate-limit-storage";

type AuthEnv = Pick<
  ENV,
  | "BETTER_AUTH_SECRET"
  | "BETTER_AUTH_URL"
  | "BETTER_AUTH_TRUSTED_ORIGINS"
  | "AUTH_REQUIRE_EMAIL_VERIFICATION"
  | "AUTH_TRUST_PROXY_HEADERS"
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
>;

export function createAuth(env: AuthEnv, db: DB = getDb()) {
  const baseURL = env.BETTER_AUTH_URL.replace(/\/+$/, "");
  const trustedOrigins = [
    ...new Set([new URL(baseURL).origin, ...env.BETTER_AUTH_TRUSTED_ORIGINS]),
  ];

  return betterAuth({
    baseURL,
    basePath: AUTH_BASE_PATH,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins,
    disabledPaths: ["/open-api/generate-schema"],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: authSchema.user,
        session: authSchema.session,
        account: authSchema.account,
        verification: authSchema.verification,
      },
    }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: env.AUTH_REQUIRE_EMAIL_VERIFICATION,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        void import("../integrations/email")
          .then(({ enqueueEmail }) =>
            enqueueEmail({
              template: "passwordReset",
              to: user.email,
              data: { name: user.name, resetUrl: url, expiresInMinutes: 60 },
            }),
          )
          .catch((err) =>
            getLogger().warn({ err, userId: user.id }, "failed to enqueue password reset email"),
          );
      },
    },
    emailVerification: {
      sendOnSignIn: false,
      autoSignInAfterVerification: true,
      expiresIn: 60 * 60,
      sendVerificationEmail: async ({ user, url }) => {
        void import("../integrations/email")
          .then(({ enqueueEmail }) =>
            enqueueEmail({
              template: "verifyEmail",
              to: user.email,
              data: { name: user.name, verifyUrl: url, expiresInMinutes: 60 },
            }),
          )
          .catch((err) =>
            getLogger().warn({ err, userId: user.id }, "failed to enqueue verification email"),
          );
      },
    },
    socialProviders:
      env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            },
          }
        : {},
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60, // 5 minutes
      },
    },
    advanced: {
      trustedProxyHeaders: env.AUTH_TRUST_PROXY_HEADERS,
    },
    rateLimit: {
      enabled: true,
      customStorage: createRedisRateLimitStorage(),
    },
    plugins: [openAPI({ disableDefaultReference: true })],
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            void import("../integrations/email")
              .then(({ enqueueEmail }) =>
                enqueueEmail({
                  template: "welcome",
                  to: user.email,
                  data: { name: user.name, loginUrl: baseURL },
                }),
              )
              .catch((err) =>
                getLogger().warn({ err, userId: user.id }, "failed to enqueue welcome email"),
              );
          },
        },
      },
    },
  });
}

export type AppAuth = ReturnType<typeof createAuth>;
