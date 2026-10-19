import { describe, expect, test } from "bun:test";
import type { MiddlewareHandler } from "hono";
import { createApp } from "../../src/app";
import { envSchema } from "../../src/core/env";

const passThrough: MiddlewareHandler = async (_c, next) => next();
const env = envSchema.parse({
  DATABASE_URL: "postgres://localhost/test",
  REDIS_URL: "redis://localhost:6379",
  REDIS_JOBS_URL: "redis://localhost:6379/1",
  S3_BUCKET: "test",
  EMAIL_FROM: "test@example.com",
  SMTP_URL: "smtp://localhost:1025",
});

function createTestApp() {
  return createApp({
    env,
    middleware: {
      otel: passThrough,
      logger: passThrough,
      redis: passThrough,
      rateLimit: passThrough,
      database: passThrough,
      s3: passThrough,
    },
  });
}

describe("createApp", () => {
  test("serves the liveness route", async () => {
    const app = createTestApp();
    const health = await app.request("/healthz");

    expect(health.status).toBe(200);
  });
});
