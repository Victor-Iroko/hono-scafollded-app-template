// Logging, tracing and error reporting for every process.
//
// - Console logs are always on: JSON in production, pretty elsewhere.
// - OTEL_EXPORTER_OTLP_ENDPOINT set: traces, logs and metrics are exported over
//   OTLP. The collector fans traces out to the trace backend and to Sentry.
// - SENTRY_DSN set: errors are reported to Sentry. Without an OTLP endpoint,
//   Sentry also receives traces and logs directly.
import * as Sentry from "@sentry/effect/server";
import { Effect, Layer, Logger, Option, Redacted, References, Tracer } from "effect";
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
