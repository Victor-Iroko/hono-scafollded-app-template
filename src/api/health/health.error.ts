import { Schema } from "effect";
import { HttpApiError } from "effect/http-api";
import { DependencyChecks } from "./health.schema";

export class NotReady extends HttpApiError.Problem<NotReady>()(
  "NotReady",
  { type: "about:blank", status: 503, title: "Service Unavailable" },
  { draining: Schema.Boolean, checks: DependencyChecks },
) {}
