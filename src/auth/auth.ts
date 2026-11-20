// Better Auth, built inside an Effect layer.
//
// Better Auth's Drizzle adapter is Promise-based, so it runs on its own small
// `pg` pool with drizzle's node-postgres driver (same schema, same rc). Its
// callbacks (rate-limit storage, emails) run Effects through the context the
// layer captured, so they share the app's services, logs and traces.
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { BetterAuthRateLimitStorage } from "better-auth";
import { betterAuth } from "better-auth/minimal";
import { openAPI } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Context, Duration, Effect, Layer, Option, Redacted } from "effect";
import { Pool } from "pg";
import { AppConfig, AuthConfig, DatabaseConfig, HttpConfig } from "../config";
import * as authSchema from "../db/schema/auth";
import { EmailService, type EnqueueEmail } from "../integrations/email/email.service";
import { RateLimits } from "../platform/rate-limits";

export const AUTH_BASE_PATH = "/api/auth";

/**
 * Better Auth reads the client IP from this header only. The auth route sets
 * it from the address the HTTP pipeline resolved (TRUSTED_PROXIES aware) and
 * drops any value the client sent.
 */
export const CLIENT_IP_HEADER = "x-client-ip";

/** An email Better Auth asks us to send; `data` holds tokens, so it is never logged. */
export type AuthEmail = {
  [N in "welcome" | "verifyEmail" | "passwordReset"]: EnqueueEmail<N> & { readonly to: string };
}["welcome" | "verifyEmail" | "passwordReset"];

export interface AuthOptions {
  readonly baseUrl: string;
  readonly secret: string;
  readonly trustedOrigins: ReadonlyArray<string>;
  readonly requireEmailVerification: boolean;
  readonly google: Option.Option<{ readonly clientId: string; readonly clientSecret: string }>;
  readonly rateLimitStorage?: BetterAuthRateLimitStorage;
  /** Hands an auth email off for delivery. Must not throw. */
  readonly sendEmail: (email: AuthEmail) => Promise<void>;
  /** Receives Better Auth's own log lines. */
  readonly log?: (level: "debug" | "info" | "warn" | "error", message: string) => void;
}

const TOKEN_TTL_S = 60 * 60;

/** Pure Better Auth factory; the layer below and the OpenAPI script both use it. */
export function createAuth(db: NodePgDatabase<any>, options: AuthOptions) {
  const baseURL = options.baseUrl.replace(/\/+$/, "");
  const trustedOrigins = [...new Set([new URL(baseURL).origin, ...options.trustedOrigins])];

  return betterAuth({
    baseURL,
    basePath: AUTH_BASE_PATH,
    secret: options.secret,
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
      requireEmailVerification: options.requireEmailVerification,
      resetPasswordTokenExpiresIn: TOKEN_TTL_S,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, url }) =>
        options.sendEmail({
          template: "passwordReset",
          to: user.email,
          data: { name: user.name, resetUrl: url, expiresInMinutes: TOKEN_TTL_S / 60 },
        }),
    },
    emailVerification: {
      sendOnSignIn: false,
      autoSignInAfterVerification: true,
      expiresIn: TOKEN_TTL_S,
      sendVerificationEmail: ({ user, url }) =>
        options.sendEmail({
          template: "verifyEmail",
          to: user.email,
          data: { name: user.name, verifyUrl: url, expiresInMinutes: TOKEN_TTL_S / 60 },
        }),
    },
    socialProviders: Option.match(options.google, {
      onNone: () => ({}),
      onSome: (google) => ({ google }),
    }),
    session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
    advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
    rateLimit: {
      enabled: true,
      ...(options.rateLimitStorage ? { customStorage: options.rateLimitStorage } : {}),
    },
    plugins: [openAPI({ disableDefaultReference: true })],
    ...(options.log ? { logger: { log: options.log } } : {}),
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await options.sendEmail({
              template: "welcome",
              idempotencyKey: `welcome:${user.id}`,
              to: user.email,
              data: { name: user.name, loginUrl: baseURL },
            });
          },
        },
      },
    },
  });
}

export type AppAuth = ReturnType<typeof createAuth>;
export type AuthSession = NonNullable<Awaited<ReturnType<AppAuth["api"]["getSession"]>>>;

/** Shares the token-bucket store; an unreachable Redis must not block sign-in. */
const rateLimitStorage = (
  limits: RateLimits["Service"],
  run: <A>(effect: Effect.Effect<A>) => Promise<A>,
) =>
  ({
    consume: (key, rule) =>
      run(
        limits
          .consume({
            key: `auth:${key}`,
            capacity: rule.max,
            refillWindow: Duration.seconds(rule.window),
          })
          .pipe(
            Effect.map((decision) =>
              decision._tag === "Limited"
                ? {
                    allowed: false,
                    retryAfter: Math.max(1, Math.ceil(Duration.toSeconds(decision.retryAfter))),
                  }
                : { allowed: true, retryAfter: null },
            ),
          ),
      ),
  }) satisfies BetterAuthRateLimitStorage;

const logAtLevel = {
  debug: Effect.logDebug,
  info: Effect.logInfo,
  warn: Effect.logWarning,
  error: Effect.logError,
} as const;

export class BetterAuth extends Context.Service<BetterAuth, AppAuth>()("app/BetterAuth") {
  static readonly layer = Layer.effect(
    BetterAuth,
    Effect.gen(function* () {
      const app = yield* AppConfig;
      const auth = yield* AuthConfig;
      const database = yield* DatabaseConfig;
      const http = yield* HttpConfig;
      const limits = yield* RateLimits;
      const emails = yield* EmailService;
      const context = yield* Effect.context<never>();
      const run = Effect.runPromiseWith(context);

      if (Option.isSome(auth.googleClientId) !== Option.isSome(auth.googleClientSecret)) {
        return yield* Effect.fail(
          new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together"),
        );
      }
      const google = Option.zipWith(
        auth.googleClientId,
        auth.googleClientSecret,
        (clientId, secret) => ({
          clientId,
          clientSecret: Redacted.value(secret),
        }),
      );

      const pool = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Pool({
              connectionString: Redacted.value(database.url),
              max: auth.poolMax,
              idleTimeoutMillis: database.idleTimeoutMs,
              connectionTimeoutMillis: database.connectTimeoutMs,
              statement_timeout: database.statementTimeoutMs,
              application_name: `${app.serviceName}-auth`,
            }),
        ),
        (pool) => Effect.promise(() => pool.end()),
      );

      return createAuth(drizzle({ client: pool }), {
        baseUrl: auth.baseUrl.toString(),
        secret: Redacted.value(auth.secret),
        trustedOrigins: http.trustedOrigins,
        requireEmailVerification: auth.requireEmailVerification,
        google,
        rateLimitStorage: rateLimitStorage(limits, run),
        // Message only: Better Auth's extra arguments can include emails and payloads.
        log: (level, message) =>
          void run(logAtLevel[level](message).pipe(Effect.annotateLogs({ source: "better-auth" }))),
        // A queue failure must not fail sign-up; it is logged (without `data`) instead.
        sendEmail: (email) =>
          run(
            emails.enqueue(email).pipe(
              Effect.asVoid,
              Effect.catchTag("EmailEnqueueError", (error) =>
                Effect.logError("auth email not queued").pipe(
                  Effect.annotateLogs({ template: email.template, cause: error.cause }),
                ),
              ),
            ),
          ),
      });
    }),
  ).pipe(Layer.provide([RateLimits.layer, EmailService.layer]));
}
