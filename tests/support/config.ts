import { ConfigProvider, Layer } from "effect";

/** Matches docker-compose.test.yml; override with TEST_DATABASE_URL. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/app_db_test";

/** Replaces the env-backed config for a test layer. */
export const testConfig = (env: Record<string, string> = {}) =>
  ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: { NODE_ENV: "test", DATABASE_URL: TEST_DATABASE_URL, ...env },
    }),
  );

export const withTestConfig =
  (env?: Record<string, string>) =>
  <A, E, R>(layer: Layer.Layer<A, E, R>) =>
    layer.pipe(Layer.provide(testConfig(env)));
