import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { requestId } from "hono/request-id";
import { contextStorage } from "hono/context-storage";
import { sentry } from "@sentry/hono/bun";
import { Scalar } from "@scalar/hono-api-reference";
import { describeRoute } from "hono-openapi";
import type { AppVariables } from "./core/context";
import { ErrorResponseBody, globalErrorHandler } from "./core/errors";
import type { ENV } from "./core/env";
import { initMetrics } from "./core/metrics";
import { apiRouter } from "./api/router";

type AppMiddleware = {
  otel: MiddlewareHandler;
  logger: MiddlewareHandler;
  redis: MiddlewareHandler;
  rateLimit: MiddlewareHandler;
  database: MiddlewareHandler;
  s3: MiddlewareHandler;
};

type AppDependencies = {
  env: ENV;
  middleware: AppMiddleware;
};

export function createApp({ env, middleware }: AppDependencies) {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use("*", contextStorage());
  app.use("*", requestId());
  app.use(middleware.otel);

  if (env.SENTRY_DSN) {
    app.use(
      sentry(app, {
        dsn: env.SENTRY_DSN,
        environment: env.NODE_ENV,
        tracesSampleRate: env.NODE_ENV === "production" ? 0.1 : 1.0,
      }),
    );
  }

  app.use(middleware.logger);
  app.use("*", middleware.redis);
  app.use(middleware.rateLimit);
  app.use("*", middleware.database);
  app.use("*", middleware.s3);
  const { registerMetrics, printMetrics } = initMetrics();
  app.use("*", registerMetrics);

  app.get("/metrics", async (c) => {
    if (env.METRICS_TOKEN) {
      if (c.req.header("authorization") !== `Bearer ${env.METRICS_TOKEN}`)
        return c.text("Unauthorized", 401);
    } else if (env.NODE_ENV === "production") {
      return c.text("Not Found", 404);
    }
    return printMetrics(c);
  });

  app.route("/", apiRouter);

  if (env.DOCS_ENABLED) {
    app.get("/openapi.json", describeRoute({ hide: true }), async (c) =>
      c.json(await Bun.file("openapi.json").json()),
    );
    app.get(
      "/docs",
      describeRoute({ hide: true }),
      Scalar({ url: "/openapi.json", pageTitle: "Hono Scaffolded App API" }),
    );
  } else {
    app.get("/openapi.json", (c) => c.notFound());
    app.get("/docs", (c) => c.notFound());
  }

  app.notFound((c) =>
    c.json<ErrorResponseBody>(
      {
        success: false,
        error: {
          code: "ROUTE_NOT_FOUND",
          message: `Not Found: ${c.req.method} ${c.req.path}`,
        },
        requestId: c.get("requestId"),
        path: `${c.req.method} ${c.req.path}`,
      },
      404,
    ),
  );

  app.onError(globalErrorHandler);
  return app;
}
