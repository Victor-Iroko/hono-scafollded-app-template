// Every environment variable the app reads, grouped by domain. Services read
// their group with `yield* <Group>Config` while their layer is built, so a
// missing or invalid value fails the boot before the server starts listening.
import { Config } from "effect";

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
