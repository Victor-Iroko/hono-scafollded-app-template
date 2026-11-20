import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Option } from "effect";
import { AppConfig, HttpConfig, ObservabilityConfig } from "../../src/config";

const fromEnv = (env: Record<string, string>) => ConfigProvider.fromEnv({ env });

describe("config", () => {
  test("applies defaults when nothing is set", async () => {
    const app = await Effect.runPromise(AppConfig.parse(fromEnv({})));
    const http = await Effect.runPromise(HttpConfig.parse(fromEnv({})));

    expect(app).toEqual({
      env: "development",
      serviceName: "api",
      serviceVersion: "0.0.0",
      logLevel: "Info",
    });
    expect(http).toEqual({ host: "0.0.0.0", port: 3000 });
  });

  test("rejects an unknown NODE_ENV", async () => {
    const result = await Effect.runPromise(
      Effect.exit(AppConfig.parse(fromEnv({ NODE_ENV: "staging" }))),
    );
    expect(result._tag).toBe("Failure");
  });

  test("keeps the Sentry DSN redacted", async () => {
    const dsn = "https://key@o1.ingest.sentry.io/1";
    const config = await Effect.runPromise(ObservabilityConfig.parse(fromEnv({ SENTRY_DSN: dsn })));

    const redacted = Option.getOrThrow(config.sentryDsn);
    expect(String(redacted)).not.toContain("key");
    expect(Option.isNone(config.otlpEndpoint)).toBe(true);
  });
});
