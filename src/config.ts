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
