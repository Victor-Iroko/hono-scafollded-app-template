import { z, type ZodError } from "zod";

export const ERROR_CODES = [
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "ROUTE_NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "CONFLICT",
  "VALIDATION_ERROR",
  "TOO_MANY_REQUESTS",
  "INTERNAL_SERVER_ERROR",
  "SERVICE_UNAVAILABLE",
  "HTTP_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorCodeSchema = z.enum(ERROR_CODES);

export const fieldErrorSchema = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
});

export type FieldError = z.infer<typeof fieldErrorSchema>;

export const errorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    fields: z.array(fieldErrorSchema).optional(),
    details: z.unknown().optional(),
  }),
  requestId: z.string().optional(),
  path: z.string().optional(),
});

export type ErrorResponseBody = z.infer<typeof errorResponseSchema>;

// Zod issues reduced to the client-facing shape; capped so one bad array
// cannot balloon the payload.
export function toFieldErrors(error: ZodError, limit = 20): FieldError[] {
  return error.issues.slice(0, limit).map((issue) => ({
    // toDotPath is symbol-safe; Array.join throws on symbol path segments.
    path: z.core.toDotPath(issue.path),
    code: issue.code,
    message: issue.message,
  }));
}
