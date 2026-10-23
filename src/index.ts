import { createApp } from "./app";
import { createAuth } from "./auth/auth";
import { initEnv, getEnv } from "./core/env";
import { initInstrumentation, otelMiddleware } from "./core/instrumentation";
import { getLogger, loggerMiddleware } from "./core/logger";
import { closeDb, dbMiddleware } from "./core/db";
import { closeRedis, redisMiddleware } from "./core/redis";
import { closeS3, ensureBucket, s3Middleware } from "./core/s3";
import { closeQueues } from "./core/queue";
import { closeSmtp } from "./integrations/email";
import { globalRateLimit } from "./middleware/rate-limit";

initEnv();
initInstrumentation();

if (getEnv().S3_AUTO_CREATE_BUCKET) {
  await ensureBucket().catch((err) => {
    getLogger().warn({ err }, "s3 bucket bootstrap failed; /readyz will report it");
  });
}

const app = createApp({
  env: getEnv(),
  auth: createAuth(getEnv()),
  middleware: {
    otel: otelMiddleware(),
    logger: loggerMiddleware(),
    redis: redisMiddleware(),
    rateLimit: globalRateLimit(),
    database: dbMiddleware(),
    s3: s3Middleware(),
  },
});

async function shutdown() {
  await Promise.allSettled([closeDb(), closeRedis(), closeS3(), closeQueues()]);
  closeSmtp();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

export default app;
