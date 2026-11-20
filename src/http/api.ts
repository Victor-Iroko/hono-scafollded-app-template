// The HTTP contract: every endpoint group, in one place. It drives routing,
// request decoding, the OpenAPI document and the typed client.
//
// `ProblemDetails` turns request decoding failures into 400 problems that list
// each invalid field (see ./errors.ts for the error contract).
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/http-api";
import { HealthApi } from "../api/health/health.api";

export class Api extends HttpApi.make("api")
  .add(HealthApi)
  .middleware(HttpApiMiddleware.ProblemDetails)
  .annotate(OpenApi.Title, "Hono Scaffolded App API")
  .annotate(OpenApi.Version, "1.0.0")
  .annotate(OpenApi.Description, "HTTP API for the scaffolded application.") {}
