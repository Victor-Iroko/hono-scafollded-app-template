import pino from "pino";
import { context, trace } from "@opentelemetry/api";
import { pinoLogger } from "hono-pino";
import type { PinoLogger } from "hono-pino";
import { tryGetContext } from "hono/context-storage";
import type { RequestIdVariables } from "hono/request-id";
import { getEnv } from "./env";

export type LoggerVariables = {
  logger: import("hono-pino").PinoLogger;
};

export type ObservabilityVariables = RequestIdVariables & LoggerVariables;

let rootLogger: pino.Logger | undefined;

// Runs on every log line; adds trace IDs when inside an OTel span.
function otelLogMixin(): Record<string, string> {
  const spanContext = trace.getSpan(context.active())?.spanContext();
  if (!spanContext || !trace.isSpanContextValid(spanContext)) return {};
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}

function getRootLogger(): pino.Logger {
  if (rootLogger) return rootLogger;
  const env = getEnv();
  const isDev = env.NODE_ENV !== "production";
  rootLogger = pino({
    level: env.LOG_LEVEL,
    base: { service: "api", env: env.NODE_ENV },
    mixin: otelLogMixin,
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      'res.headers["set-cookie"]',
      "*.password",
      "*.token",
    ],
    transport: isDev
      ? { target: "hono-pino/debug-log", options: { colorEnabled: true } }
      : undefined,
  });
  return rootLogger;
}

export function getLogger(): pino.Logger | PinoLogger {
  try {
    const requestLogger = tryGetContext<{
      Variables: ObservabilityVariables;
    }>()?.var.logger;
    if (requestLogger) return requestLogger;
  } catch {
    // No request context (boot, background) — use the root logger.
  }
  return getRootLogger();
}

export function loggerMiddleware() {
  return pinoLogger({ pino: getRootLogger() });
}
