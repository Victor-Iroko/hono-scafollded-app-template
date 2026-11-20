// The HTTP contract: every endpoint group, in one place. It drives routing,
// request decoding, the OpenAPI document and the typed client.
//
// Order matters: `prefix` and `middleware` apply to the groups added before
// them. Feature groups go first so they are versioned and rate limited;
// health probes come after, unversioned and never rate limited.
// `ProblemDetails` (last) turns request decoding failures on every endpoint
// into 400 problems that list each invalid field.
import { HttpApi, HttpApiMiddleware, OpenApi } from "effect/http-api";
import { HealthApi } from "../api/health/health.api";
import { RateLimit } from "./rate-limit";

export class Api extends HttpApi.make("api")
  // Feature groups: .add(UsersApi)
  .prefix("/v1")
  .middleware(RateLimit)
  .add(HealthApi)
  .middleware(HttpApiMiddleware.ProblemDetails)
  .annotate(OpenApi.Title, "Hono Scaffolded App API")
  .annotate(OpenApi.Version, "1.0.0")
  .annotate(OpenApi.Description, "HTTP API for the scaffolded application.") {}
