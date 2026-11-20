// Every environment variable the app reads, grouped by domain. Services read
// their group with `yield* <Group>Config` while their layer is built, so a
// missing or invalid value fails the boot before the server starts listening.
import { Config, Schema } from "effect";

/** An integer env var within [minimum, maximum], with a default. */
const intInRange = (name: string, range: { minimum: number; maximum: number }, fallback: number) =>
  Config.schema(Schema.NumberFromString.check(Schema.isInt(), Schema.isBetween(range)), name).pipe(
    Config.withDefault(fallback),
  );

export const AppConfig = Config.all({
  env: Config.Literals(["development", "production", "test"], "NODE_ENV").pipe(
    Config.withDefault("development"),
  ),
  serviceName: Config.String("SERVICE_NAME").pipe(Config.withDefault("api")),
  serviceVersion: Config.String("SERVICE_VERSION").pipe(Config.withDefault("0.0.0")),
  logLevel: Config.LogLevel("LOG_LEVEL").pipe(Config.withDefault("Info")),
});

export const HttpConfig = Config.all({
  host: Config.String("HOST").pipe(Config.withDefault("0.0.0.0")),
  port: Config.Port("PORT").pipe(Config.withDefault(3000)),
  // Browser origins allowed to make credentialed requests, comma-separated.
  trustedOrigins: Config.Array(Schema.String, "TRUSTED_ORIGINS", { separator: "," }).pipe(
    Config.withDefault([]),
  ),
  // CIDRs of reverse proxies whose X-Forwarded-For is believed, e.g. 10.0.0.0/8.
  // Empty means the TCP peer is the client address.
  trustedProxies: Config.Array(Schema.String, "TRUSTED_PROXIES", { separator: "," }).pipe(
    Config.withDefault([]),
  ),
  maxBodyBytes: intInRange(
    "HTTP_MAX_BODY_BYTES",
    { minimum: 1_024, maximum: 104_857_600 },
    1_048_576,
  ),
  requestTimeoutMs: intInRange(
    "HTTP_REQUEST_TIMEOUT_MS",
    { minimum: 1_000, maximum: 300_000 },
    30_000,
  ),
  // How long /readyz reports 503 before the server stops, so load balancers stop routing first.
  shutdownGraceMs: intInRange("HTTP_SHUTDOWN_GRACE_MS", { minimum: 0, maximum: 120_000 }, 5_000),
  docsEnabled: Config.Boolean("DOCS_ENABLED").pipe(Config.withDefault(false)),
});

export const ObservabilityConfig = Config.all({
  // OTLP/HTTP collector base URL, e.g. http://localhost:4318.
  otlpEndpoint: Config.option(Config.URL("OTEL_EXPORTER_OTLP_ENDPOINT")),
  sentryDsn: Config.option(Config.Redacted("SENTRY_DSN")),
  sentryTracesSampleRate: Config.Number("SENTRY_TRACES_SAMPLE_RATE").pipe(Config.withDefault(0.1)),
});

export const DatabaseConfig = Config.all({
  url: Config.Redacted("DATABASE_URL"),
  poolMax: intInRange("DB_POOL_MAX", { minimum: 1, maximum: 100 }, 10),
  idleTimeoutMs: intInRange("DB_IDLE_TIMEOUT_MS", { minimum: 0, maximum: 3_600_000 }, 30_000),
  connectTimeoutMs: intInRange(
    "DB_CONNECT_TIMEOUT_MS",
    { minimum: 1_000, maximum: 120_000 },
    10_000,
  ),
  // Server-side cap on any single statement; 0 disables it.
  statementTimeoutMs: intInRange(
    "DB_STATEMENT_TIMEOUT_MS",
    { minimum: 0, maximum: 3_600_000 },
    30_000,
  ),
});

export const RedisConfig = Config.all({
  // Cache and rate-limit store: evictable (allkeys-lru), no persistence needed.
  cacheUrl: Config.Redacted("REDIS_URL"),
  // Job queue store: must run with noeviction and persistence.
  jobsUrl: Config.Redacted("REDIS_JOBS_URL"),
  connectTimeoutMs: intInRange(
    "REDIS_CONNECT_TIMEOUT_MS",
    { minimum: 100, maximum: 60_000 },
    5_000,
  ),
});

export const RateLimitConfig = Config.all({
  // Token bucket: up to `capacity` requests in a burst, refilled evenly over `refillWindowS`.
  capacity: intInRange("RATE_LIMIT_CAPACITY", { minimum: 1, maximum: 1_000_000 }, 100),
  refillWindowS: intInRange("RATE_LIMIT_REFILL_WINDOW_S", { minimum: 1, maximum: 86_400 }, 60),
  // What to do when Redis is unreachable: "open" serves the request, "closed" answers 503.
  failMode: Config.Literals(["open", "closed"], "RATE_LIMIT_FAIL_MODE").pipe(
    Config.withDefault("open"),
  ),
});

export const AuthConfig = Config.all({
  secret: Config.schema(
    Schema.Redacted(Schema.String.check(Schema.isMinLength(32))),
    "BETTER_AUTH_SECRET",
  ),
  // Public origin of this API, e.g. https://api.example.com.
  baseUrl: Config.URL("BETTER_AUTH_URL"),
  requireEmailVerification: Config.Boolean("AUTH_REQUIRE_EMAIL_VERIFICATION").pipe(
    Config.withDefault(false),
  ),
  // Google sign-in: set both or neither.
  googleClientId: Config.option(Config.String("GOOGLE_CLIENT_ID")),
  googleClientSecret: Config.option(Config.Redacted("GOOGLE_CLIENT_SECRET")),
  // Better Auth's adapter is Promise-based, so it keeps its own small pool.
  poolMax: intInRange("AUTH_DB_POOL_MAX", { minimum: 1, maximum: 50 }, 5),
});
