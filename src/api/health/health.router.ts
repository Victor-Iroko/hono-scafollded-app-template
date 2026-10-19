import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import type { AppVariables } from "../../core/context";
import { healthResponseSchema, notReadyResponseSchema, readyResponseSchema } from "./health.schema";
import { checkReadiness } from "./health.service";

export const healthRouter = new Hono<{ Variables: AppVariables }>();

healthRouter.get(
  "/healthz",
  describeRoute({
    operationId: "getHealth",
    summary: "Check whether the process is alive",
    responses: {
      200: {
        description: "The process is alive",
        content: { "application/json": { schema: resolver(healthResponseSchema) } },
      },
    },
  }),
  (c) => c.json({ ok: true as const }),
);

healthRouter.get(
  "/readyz",
  describeRoute({
    operationId: "getReadiness",
    summary: "Check whether required dependencies are ready",
    responses: {
      200: {
        description: "All dependencies are ready",
        content: { "application/json": { schema: resolver(readyResponseSchema) } },
      },
      503: {
        description: "One or more dependencies are unavailable",
        content: { "application/json": { schema: resolver(notReadyResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const readiness = await checkReadiness();
    if (!readiness.ok) return c.json({ ...readiness, ok: false as const }, 503);
    return c.json({ ...readiness, ok: true as const });
  },
);
