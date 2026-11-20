import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { NotReady } from "./health.error";
import { HealthResponse, ReadyResponse } from "./health.schema";

export class HealthApi extends HttpApiGroup.make("health", { topLevel: true })
  .add(
    HttpApiEndpoint.get("getHealth", "/healthz", { success: HealthResponse }).annotate(
      OpenApi.Summary,
      "Check whether the process is alive",
    ),
    HttpApiEndpoint.get("getReadiness", "/readyz", {
      success: ReadyResponse,
      error: NotReady,
    }).annotate(OpenApi.Summary, "Check whether the service can take traffic"),
  )
  .annotate(OpenApi.Description, "Liveness and readiness probes.") {}
