import z from "zod";

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
    SENTRY_DSN: z.string().optional(),
    METRICS_TOKEN: z.string().optional(),
    DOCS_ENABLED: z.stringbool().default(false),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    DB_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DB_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(30_000),
    DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(10_000),

    BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
    BETTER_AUTH_URL: z.url("BETTER_AUTH_URL must be a URL"),
    BETTER_AUTH_TRUSTED_ORIGINS: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    AUTH_REQUIRE_EMAIL_VERIFICATION: z.stringbool().default(false),
    AUTH_TRUST_PROXY_HEADERS: z.stringbool().default(false),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),

    REDIS_URL: z.string().min(1, "REDIS_URL is required"),
    RATE_LIMIT_POINTS: z.coerce.number().int().min(1).default(100),
    RATE_LIMIT_DURATION_S: z.coerce.number().int().min(1).default(60),

    REDIS_JOBS_URL: z.string().min(1, "REDIS_JOBS_URL is required"),
    QUEUE_PREFIX: z.string().min(1).default("bull"),
    JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(3),

    S3_BUCKET: z.string().min(1, "S3_BUCKET is required"),
    S3_REGION: z.string().min(1).default("us-east-1"),
    S3_ENDPOINT: z.url().optional(),
    S3_PUBLIC_ENDPOINT: z.url().optional(),
    S3_ACCESS_KEY_ID: z.string().min(1).optional(),
    S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    S3_FORCE_PATH_STYLE: z.stringbool().default(true),
    S3_PRESIGN_EXPIRES_S: z.coerce.number().int().min(1).max(604_800).default(3_600),
    S3_AUTO_CREATE_BUCKET: z.stringbool().default(false),

    EMAIL_FROM: z.string().min(1, "EMAIL_FROM is required"),
    EMAIL_REPLY_TO: z.email().optional(),
    SMTP_URL: z.url("SMTP_URL must be a URL, e.g. smtp://localhost:1025"),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),

    EMAIL_RATE_MAX: z.coerce.number().int().min(1).default(10),

    PAYSTACK_SECRET_KEY: z.string().min(1).optional(),
  })
  .refine((env) => Boolean(env.S3_ACCESS_KEY_ID) === Boolean(env.S3_SECRET_ACCESS_KEY), {
    message: "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together",
    path: ["S3_SECRET_ACCESS_KEY"],
  })
  .refine((env) => Boolean(env.SMTP_USER) === Boolean(env.SMTP_PASSWORD), {
    message: "SMTP_USER and SMTP_PASSWORD must be set together",
    path: ["SMTP_PASSWORD"],
  })
  .refine((env) => Boolean(env.GOOGLE_CLIENT_ID) === Boolean(env.GOOGLE_CLIENT_SECRET), {
    message: "GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together",
    path: ["GOOGLE_CLIENT_SECRET"],
  });

export type ENV = z.infer<typeof envSchema>;

let cached: ENV | undefined;

export function initEnv(source = process.env): ENV {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    console.error(z.prettifyError(parsed.error));
    throw new Error("Invalid Environment Variables");
  }
  cached = parsed.data;
  return cached;
}

export function getEnv(): ENV {
  if (!cached) throw new Error("Call initEnv() at app entry first");
  return cached;
}
