import { Hono } from "hono";
import type { AppVariables } from "../core/context";
import { healthRouter } from "./health/health.router";

export const apiRouter = new Hono<{ Variables: AppVariables }>();

apiRouter.route("/", healthRouter);
