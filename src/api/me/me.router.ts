import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { getSessionUser, requireSession } from "../../auth/middleware";
import type { AppVariables } from "../../core/context";
import { currentUserSchema } from "./me.schema";
import { toCurrentUser } from "./me.service";

export const meRouter = new Hono<{ Variables: AppVariables }>();

meRouter.get(
  "/me",
  requireSession,
  describeRoute({
    operationId: "getCurrentUser",
    summary: "Get the signed-in user",
    security: [{ cookieAuth: [] }],
    responses: {
      200: {
        description: "The signed-in user",
        content: { "application/json": { schema: resolver(currentUserSchema) } },
      },
      401: { description: "No valid session" },
    },
  }),
  (c) => c.json(toCurrentUser(getSessionUser(c))),
);
