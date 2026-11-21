// The global request pipeline, outermost first:
//
//   client address → request id → access log + metrics → security headers → render failures
//   → body limit → timeout → route
//
// Typed endpoint errors are already problem responses when they reach this
// pipeline. What arrives as a failure is an unknown route, a request parse
// error, or a defect; `renderFailures` turns those into problem responses too.
import { ByteSize, Cause, Duration, Effect, Layer, Metric, Option } from "effect";
import { IpNetwork } from "effect/net";
import {
  HttpIncomingMessage,
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import { AppConfig, HttpConfig } from "../config";
import { classifyDatabaseError, databaseErrorLogContext } from "../platform/database.error";
import { reportError } from "../platform/observability";
import { problemFromDatabaseFailure, problemResponse, ServiceUnavailable } from "./errors";

type HttpApp<E, R> = Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>;

const REQUEST_ID_HEADER = "x-request-id";
const VALID_REQUEST_ID = /^[\w.-]{1,128}$/;
const QUIET_PATHS = new Set(["/healthz", "/readyz"]);

/** Reuses a well-formed incoming id, otherwise mints one; tags logs, the span and the response. */
const withRequestId = <E, R>(app: HttpApp<E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const incoming = request.headers[REQUEST_ID_HEADER];
    const requestId =
      incoming !== undefined && VALID_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();

    yield* Effect.annotateCurrentSpan("http.request.id", requestId);
    const span = yield* Effect.option(Effect.currentSpan);
    const traceIds = Option.match(span, {
      onNone: () => ({}),
      onSome: ({ traceId, spanId }) => ({ traceId, spanId }),
    });

    const response = yield* app.pipe(Effect.annotateLogs({ requestId, ...traceIds }));
    return HttpServerResponse.setHeader(response, REQUEST_ID_HEADER, requestId);
  });

// Method and status only: paths carry ids, which would explode metric cardinality.
const requestDuration = Metric.timer("http.server.request.duration", {
  description: "HTTP request duration by method and status code",
});

/** One access-log line and one duration sample per request. */
const observeRequest = <E, R>(app: HttpApp<E, R>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const startedAt = performance.now();
    const response = yield* app;
    const durationMs = performance.now() - startedAt;
    const path = request.url.split("?")[0] ?? request.url;
    const log = QUIET_PATHS.has(path) ? Effect.logDebug : Effect.logInfo;
    yield* log("http request").pipe(
      Effect.annotateLogs({
        "http.method": request.method,
        "http.path": path,
        "http.status": response.status,
        "http.duration_ms": Math.round(durationMs),
      }),
    );
    yield* Metric.update(
      Metric.withAttributes(requestDuration, {
        "http.request.method": request.method,
        "http.response.status_code": String(response.status),
      }),
      Duration.millis(durationMs),
    );
    return response;
  });

const withSecurityHeaders =
  (options: { readonly strictTransportSecurity: boolean }) =>
  <E, R>(app: HttpApp<E, R>) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const response = yield* app;
      const headers: Record<string, string> = {
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-resource-policy": "same-origin",
      };
      // The docs page runs scripts; every other response is data only.
      if (!request.url.startsWith("/docs")) {
        headers["content-security-policy"] = "default-src 'none'; frame-ancestors 'none'";
      }
      if (options.strictTransportSecurity) {
        headers["strict-transport-security"] = "max-age=31536000; includeSubDomains";
      }
      return HttpServerResponse.setHeaders(response, headers);
    });

const renderFailures =
  (options: { readonly includeDetail: boolean }) =>
  <E, R>(app: HttpApp<E, R>) =>
    Effect.catchCause(app, (cause) => {
      // A client that hung up gets no response; let the interruption through.
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);

      const error = Cause.squash(cause);
      const databaseFailure = classifyDatabaseError(error, options);
      if (databaseFailure) {
        const problem = problemFromDatabaseFailure(databaseFailure);
        const log = problem.status >= 500 ? Effect.logError : Effect.logDebug;
        return log("database error").pipe(
          Effect.annotateLogs({ error: databaseFailure.log }),
          Effect.andThen(HttpServerRespondable.toResponse(problem)),
        );
      }

      return Effect.gen(function* () {
        const response = yield* HttpServerRespondable.toResponseOrElse(
          error,
          HttpServerResponse.empty({ status: 500 }),
        );
        if (response.status >= 500) {
          yield* Effect.logError("unhandled error").pipe(
            Effect.annotateLogs({ error: databaseErrorLogContext(error, options) }),
          );
          yield* reportError(cause);
        }
        return response.body._tag === "Empty" ? problemResponse(response.status) : response;
      });
    });

const withBodyLimit =
  (maxBodyBytes: number) =>
  <E, R>(app: HttpApp<E, R>) =>
    Effect.provideService(app, HttpIncomingMessage.MaxBodySize, ByteSize.bytes(maxBodyBytes));

const withTimeout =
  (timeoutMs: number) =>
  <E, R>(app: HttpApp<E, R>) =>
    Effect.timeoutOrElse(app, {
      duration: Duration.millis(timeoutMs),
      orElse: () =>
        HttpServerRespondable.toResponse(new ServiceUnavailable({ detail: "Request timed out" })),
    });

// Only proxies in TRUSTED_PROXIES may rewrite the client address from X-Forwarded-For.
const withClientAddress = (trustedProxies: ReadonlyArray<IpNetwork.IpNetwork>) =>
  trustedProxies.length === 0
    ? <E, R>(app: HttpApp<E, R>) => app
    : HttpMiddleware.xForwardedHeaders({ trustedProxies });

export const HttpMiddlewareLive = Layer.unwrap(
  Effect.gen(function* () {
    const app = yield* AppConfig;
    const http = yield* HttpConfig;
    const isProduction = app.env === "production";
    const trustedProxies = yield* Effect.forEach(http.trustedProxies, (cidr) =>
      Effect.fromResult(IpNetwork.fromString(cidr)).pipe(
        Effect.mapError((cause) => new Error(`TRUSTED_PROXIES: invalid CIDR "${cidr}"`, { cause })),
      ),
    );

    const pipeline = HttpRouter.middleware(
      <E, R>(route: HttpApp<E, R>) =>
        route.pipe(
          withTimeout(http.requestTimeoutMs),
          withBodyLimit(http.maxBodyBytes),
          renderFailures({ includeDetail: !isProduction }),
          withSecurityHeaders({ strictTransportSecurity: isProduction }),
          observeRequest,
          withRequestId,
          withClientAddress(trustedProxies),
        ),
      { global: true },
    );

    if (http.trustedOrigins.length === 0) return pipeline;
    const cors = HttpRouter.cors({
      allowedOrigins: http.trustedOrigins,
      credentials: true,
      exposedHeaders: [REQUEST_ID_HEADER, "retry-after"],
    });
    return Layer.mergeAll(pipeline, cors);
  }),
);
