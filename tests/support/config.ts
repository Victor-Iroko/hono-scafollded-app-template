import { ConfigProvider, Layer } from "effect";

/** Matches docker-compose.test.yml; override with TEST_DATABASE_URL. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5433/app_db_test";
/** Matches docker-compose.test.yml; override with TEST_REDIS_URL. One instance serves cache and jobs in tests. */
/** Mailpit from docker-compose.test.yml: SMTP on 1026, HTTP API on 8026. */
export const TEST_SMTP_URL = process.env.TEST_SMTP_URL ?? "smtp://localhost:1026";
export const TEST_MAILPIT_API = process.env.TEST_MAILPIT_API ?? "http://localhost:8026/api/v1";
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
        BETTER_AUTH_SECRET: "test-only-secret-with-at-least-32-characters",
        BETTER_AUTH_URL: "http://localhost:3000",
        SMTP_URL: TEST_SMTP_URL,
        EMAIL_FROM: "Test <no-reply@example.test>",
        // S3Mock from docker-compose.test.yml; it ignores credentials.
        S3_BUCKET: "app-bucket-test",
        S3_ENDPOINT: "http://localhost:9090",
        S3_ACCESS_KEY_ID: "test",
        S3_SECRET_ACCESS_KEY: "test",
        ...env,
      },
    }),
  );

export const withTestConfig =
  (env?: Record<string, string>) =>
  <A, E, R>(layer: Layer.Layer<A, E, R>) =>
    layer.pipe(Layer.provide(testConfig(env)));
