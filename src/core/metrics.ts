import { prometheus } from "@hono/prometheus";
import { Registry } from "prom-client";

let registry: Registry | undefined;
let metrics: ReturnType<typeof prometheus> | undefined;

export function getMetricsRegistry(): Registry {
  if (!registry) registry = new Registry();
  return registry;
}

export function initMetrics() {
  return (metrics ??= prometheus({
    registry: getMetricsRegistry(),
    collectDefaultMetrics: true,
  }));
}
