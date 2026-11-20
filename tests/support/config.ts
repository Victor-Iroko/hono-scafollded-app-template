import { ConfigProvider, Layer } from "effect";

/** Matches docker-compose.test.yml; override with TEST_DATABASE_URL. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/app_db_test";
/** Matches docker-compose.test.yml; override with TEST_REDIS_URL. One instance serves cache and jobs in tests. */
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://:redis@localhost:6380/0";

/** Replaces the env-backed config for a test layer. */
export const testConfig = (env: Record<string, string> = {}) =>
  ConfigProvider.layer(
    ConfigProvider.fromEnv({
      env: {
        NODE_ENV: "test",
        DATABASE_URL: TEST_DATABASE_URL,
        REDIS_URL: TEST_REDIS_URL,
        REDIS_JOBS_URL: TEST_REDIS_URL,
        ...env,
      },
    }),
  );

export const withTestConfig =
  (env?: Record<string, string>) =>
  <A, E, R>(layer: Layer.Layer<A, E, R>) =>
    layer.pipe(Layer.provide(testConfig(env)));
