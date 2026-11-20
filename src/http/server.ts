import { BunHttpServer } from "@effect/platform-bun";
import { Duration, Effect, Layer } from "effect";
import { HttpRouter } from "effect/http";
import { HttpApiBuilder, HttpApiMiddleware } from "effect/http-api";
import { HealthHandlers } from "../api/health/health.handlers";
import { HttpConfig } from "../config";
import { Api } from "./api";
import { DocsLive } from "./docs";
import { HttpMiddlewareLive } from "./middleware";
import { ShutdownSignal } from "./shutdown";

const ApiLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide([HealthHandlers]),
  // API middleware must be visible while the routes are built.
  Layer.provideMerge(HttpApiMiddleware.layerProblemDetails({ includeDetails: true })),
);

/** Every route plus the global middleware, without a server (tests use this). */
export const AppRoutes = Layer.mergeAll(ApiLive, DocsLive, HttpMiddlewareLive);

// Built after the server, so its finalizer runs first on shutdown: /readyz
// starts failing, the grace period lets load balancers notice, and only then
// does the server stop accepting and drain in-flight requests.
const DrainBeforeStop = Layer.effectDiscard(
  Effect.gen(function* () {
    const shutdown = yield* ShutdownSignal;
    const { shutdownGraceMs } = yield* HttpConfig;
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* shutdown.beginDraining;
        yield* Effect.logInfo("draining before shutdown").pipe(
          Effect.annotateLogs({ graceMs: shutdownGraceMs }),
        );
        yield* Effect.sleep(Duration.millis(shutdownGraceMs));
      }),
    );
  }),
);

const ServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { host, port, requestTimeoutMs } = yield* HttpConfig;
    // The access log in ./middleware.ts replaces the built-in one.
    return HttpRouter.serve(AppRoutes, { disableLogger: true }).pipe(
      Layer.provide(
        BunHttpServer.layer({
          hostname: host,
          port,
          gracefulShutdownTimeout: Duration.millis(requestTimeoutMs),
        }),
      ),
    );
  }),
);

export const HttpServerLive = DrainBeforeStop.pipe(
  Layer.provide(ServerLive),
  Layer.provideMerge(ShutdownSignal.layer),
);
