import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { httpInstrumentationMiddleware } from "@hono/otel";
import { getEnv } from "./env";
import { getLogger } from "./logger";

let sdk: NodeSDK | undefined;

// Call once at app entry, before `new Hono()`; no-op without an OTLP endpoint.
// Sentry is wired separately via the sentry() middleware.
export function initInstrumentation(serviceName = "api"): NodeSDK | undefined {
  if (sdk) return sdk;
  const env = getEnv();
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return undefined;
  try {
    sdk = new NodeSDK({
      resource: resourceFromAttributes({
        "service.name": serviceName,
        "service.version": "1.0.0",
      }),
      traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
      metricReader: new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` }),
        exportIntervalMillis: 60000,
      }),
      instrumentations: [getNodeAutoInstrumentations()],
    });
    sdk.start();
    getLogger().info({ endpoint }, "OTel instrumentation started");
  } catch (err) {
    getLogger().error({ err }, "OTel instrumentation failed");
    sdk = undefined;
  }
  return sdk;
}

export function otelMiddleware(serviceName = "api") {
  return httpInstrumentationMiddleware({ serviceName });
}
