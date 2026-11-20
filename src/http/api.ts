// The HTTP contract: every endpoint group, in one place. It drives routing,
// request decoding, the OpenAPI document and the typed client.
import { HttpApi, OpenApi } from "effect/http-api";
import { HealthApi } from "../api/health/health.api";

export class Api extends HttpApi.make("api")
  .add(HealthApi)
  .annotate(OpenApi.Title, "Hono Scaffolded App API")
  .annotate(OpenApi.Description, "HTTP API for the scaffolded application.") {}
