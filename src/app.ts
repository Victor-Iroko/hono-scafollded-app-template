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
import { AUTH_BASE_PATH } from "./auth/constants";
import type { AppAuth } from "./auth/auth";
import { authContext } from "./auth/middleware";

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
  auth: AppAuth;
  middleware: AppMiddleware;
};

let llmsTxt: Promise<string> | undefined;

function getLlmsTxt() {
  llmsTxt ??= generateLlmsTxt().catch((err) => {
    llmsTxt = undefined;
    throw err;
  });
  return llmsTxt;
}

async function generateLlmsTxt() {
  const spec = await Bun.file("openapi.json").text();
  const { createMarkdownFromOpenApi } = await import("@scalar/openapi-to-markdown");
  return createMarkdownFromOpenApi(spec);
}

export function createApp({ env, auth, middleware }: AppDependencies) {
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
  app.use("*", authContext(auth));

  const { registerMetrics, printMetrics } = initMetrics();
  app.use("*", registerMetrics);

  app.all(`${AUTH_BASE_PATH}/*`, (c) => auth.handler(c.req.raw));

  app.use("*", middleware.redis);
  app.use(middleware.rateLimit);
  app.use("*", middleware.database);
  app.use("*", middleware.s3);

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
    app.get("/llms.txt", describeRoute({ hide: true }), async (c) => {
      const markdown = await getLlmsTxt();
      return c.body(markdown, 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "public, max-age=300",
      });
    });
    app.get(
      "/docs",
      describeRoute({ hide: true }),
      Scalar({
        url: "/openapi.json",
        pageTitle: "Hono Scaffolded App API",
      }),
    );
  } else {
    app.get("/openapi.json", (c) => c.notFound());
    app.get("/llms.txt", (c) => c.notFound());
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
