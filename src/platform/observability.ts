// Logging, tracing and error reporting for every process.
//
// - Console logs are always on: JSON in production, pretty elsewhere.
// - OTEL_EXPORTER_OTLP_ENDPOINT set: traces, logs and metrics are exported over
//   OTLP. The collector fans traces out to the trace backend and to Sentry.
// - SENTRY_DSN set: errors are reported to Sentry. Without an OTLP endpoint,
//   Sentry also receives traces and logs directly.
import * as Sentry from "@sentry/effect/server";
import {
  type Cause,
  Effect,
  ErrorReporter,
  Layer,
  Logger,
  Option,
  Redacted,
  References,
  Tracer,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { Otlp } from "effect/observability";
import { AppConfig, ObservabilityConfig } from "../config";

export const ObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    const app = yield* AppConfig;
    const { otlpEndpoint, sentryDsn, sentryTracesSampleRate } = yield* ObservabilityConfig;

    const consoleLogger = app.env === "production" ? Logger.consoleJson : Logger.consolePretty();
    const minimumLogLevel = Layer.succeed(References.MinimumLogLevel, app.logLevel);

    const otlp = Option.map(otlpEndpoint, (endpoint) =>
      Otlp.layerJson({
        baseUrl: endpoint.toString(),
        resource: {
          serviceName: app.serviceName,
          serviceVersion: app.serviceVersion,
          attributes: { "deployment.environment.name": app.env },
        },
      }).pipe(Layer.provide(FetchHttpClient.layer)),
    );

    const sentry = Option.map(sentryDsn, (dsn) => {
      const errors = Sentry.effectLayer({
        dsn: Redacted.value(dsn),
        environment: app.env,
        release: app.serviceVersion,
        tracesSampleRate: sentryTracesSampleRate,
        // No user details, cookies, bodies or query strings: they carry PII and tokens.
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpBodies: [],
          urlQueryParams: false,
        },
      });
      if (Option.isSome(otlp)) return errors;
      return Layer.mergeAll(errors, Layer.succeed(Tracer.Tracer, Sentry.SentryEffectTracer));
    });

    const loggers =
      Option.isSome(sentry) && Option.isNone(otlp)
        ? [consoleLogger, Sentry.SentryEffectLogger]
        : [consoleLogger];

    // OTLP merges its logger into the console loggers, so it is built after them.
    const base = Layer.mergeAll(Logger.layer(loggers), minimumLogLevel);
    const exporters = Layer.mergeAll(
      Layer.empty,
      ...Option.toArray(otlp),
      ...Option.toArray(sentry),
    );
    return exporters.pipe(Layer.provideMerge(base));
  }),
);

// Log annotations that identify the unit of work; copied onto Sentry events as tags.
const TAGGED_ANNOTATIONS = ["requestId", "job.queue", "job.id", "job.attempt"];

/**
 * Reports a failure to the error trackers (Sentry) through Effect's
 * ErrorReporter. The event carries the active trace and span ids, so Sentry
 * links it to the trace it received (directly, or through the collector), plus
 * the request/job ids from the log annotations.
 */
export const reportError = <E>(cause: Cause.Cause<E>) =>
  Effect.gen(function* () {
    const span = yield* Effect.option(Effect.currentSpan);
    const annotations = yield* References.CurrentLogAnnotations;
    const runInFiberContext = Effect.runSyncWith(yield* Effect.context<never>());

    yield* Effect.sync(() =>
      Sentry.withScope((scope) => {
        if (Option.isSome(span)) {
          const { traceId, spanId } = span.value;
          scope.setPropagationContext({ traceId, parentSpanId: spanId, sampleRand: Math.random() });
          scope.setContext("trace", { trace_id: traceId, span_id: spanId });
        }
        for (const key of TAGGED_ANNOTATIONS) {
          const value = annotations[key];
          if (typeof value === "string" || typeof value === "number")
            scope.setTag(key, String(value));
        }
        runInFiberContext(ErrorReporter.report(cause));
      }),
    );
  });
