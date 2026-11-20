import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { HealthResponse } from "./health.schema";

export class HealthApi extends HttpApiGroup.make("health", { topLevel: true })
  .add(
    HttpApiEndpoint.get("getHealth", "/healthz", { success: HealthResponse }).annotate(
      OpenApi.Summary,
      "Check whether the process is alive",
    ),
  )
  .annotate(OpenApi.Description, "Liveness and readiness probes.") {}
