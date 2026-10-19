import { z } from "zod";

export const healthResponseSchema = z.object({ ok: z.literal(true) });

const dependencyHealthSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number(),
});

export const readyResponseSchema = z.object({
  ok: z.literal(true),
  db: dependencyHealthSchema,
  redis: dependencyHealthSchema,
  s3: dependencyHealthSchema,
  email: dependencyHealthSchema,
});

export const notReadyResponseSchema = z.object({
  ok: z.literal(false),
  db: dependencyHealthSchema,
  redis: dependencyHealthSchema,
  s3: dependencyHealthSchema,
  email: dependencyHealthSchema,
});
