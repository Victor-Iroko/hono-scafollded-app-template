import type { ErrorHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { ZodError } from "zod";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getEnv } from "./env";
import { getLogger } from "./logger";
import type { AppVariables } from "./context";

import { getDbErrorLogContext, getDbErrorMessage, mapDbErrorToHttp } from "./db-errors";
import { toFieldErrors } from "./error-schema";
import type { ErrorCode, ErrorResponseBody, FieldError } from "./error-schema";
export type { ErrorCode, ErrorResponseBody, FieldError };

export class AppError extends HTTPException {
  code: ErrorCode;
  fields?: FieldError[];

  constructor(
    status: ContentfulStatusCode,
    message: string,
    opts?: { code?: ErrorCode; cause?: unknown },
  ) {
    super(status, { message, cause: opts?.cause });
    this.code = opts?.code ?? "INTERNAL_SERVER_ERROR";
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request") {
    super(400, message, { code: "BAD_REQUEST" });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, message, { code: "UNAUTHORIZED" });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, message, { code: "FORBIDDEN" });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Resource not found") {
    super(404, message, { code: "NOT_FOUND" });
  }
}

export class MethodNotAllowedError extends AppError {
  constructor(message = "Method not allowed") {
    super(405, message, { code: "METHOD_NOT_ALLOWED" });
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(409, message, { code: "CONFLICT" });
  }
}

export class ValidationError extends AppError {
  constructor(error: ZodError, message = "Validation failed") {
    super(422, message, { code: "VALIDATION_ERROR" });
    this.fields = toFieldErrors(error);
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = "Too many requests") {
    super(429, message, { code: "TOO_MANY_REQUESTS" });
  }
}

export class InternalServerError extends AppError {
  constructor(message = "Internal server error") {
    super(500, message, { code: "INTERNAL_SERVER_ERROR" });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service unavailable") {
    super(503, message, { code: "SERVICE_UNAVAILABLE" });
  }
}

export const globalErrorHandler: ErrorHandler<{
  Variables: AppVariables;
}> = (err, c) => {
  const requestId = c.get("requestId");
  const path = `${c.req.method} ${c.req.path}`;
  const isProd = getEnv().NODE_ENV == "production";

  if (err instanceof AppError) {
    return c.json<ErrorResponseBody>(
      {
        success: false,
        error: {
          code: err.code,
          message: err.message,
          ...(err.fields ? { fields: err.fields } : {}),
          ...(!isProd && err.cause !== undefined ? { details: err.cause } : {}),
        },
        requestId,
        path,
      },
      err.status,
    );
  }

  if (err instanceof HTTPException) {
    return c.json<ErrorResponseBody>(
      {
        success: false,
        error: {
          code: "HTTP_ERROR",
          message: err.message,
          ...(!isProd && err.cause !== undefined ? { details: err.cause } : {}),
        },
        requestId,
        path,
      },
      err.status,
    );
  }

  if (err instanceof ZodError) {
    return c.json<ErrorResponseBody>(
      {
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          fields: toFieldErrors(err),
        },
        requestId,
        path,
      },
      422,
    );
  }

  const dbError = mapDbErrorToHttp(err);
  if (dbError) {
    const logFields = { ...dbError.log, requestId, path };
    if (dbError.status >= 500) getLogger().error(logFields, "database error");
    else getLogger().debug(logFields, "database error");

    return c.json<ErrorResponseBody>(
      {
        success: false,
        error: {
          code: dbError.code,
          message: dbError.message,
          ...(dbError.fields ? { fields: dbError.fields } : {}),
          ...(!isProd ? { details: dbError.log } : {}),
        },
        requestId,
        path,
      },
      dbError.status,
    );
  }

  getLogger().error({ err: getDbErrorLogContext(err), requestId, path }, "unhandled error");

  return c.json<ErrorResponseBody>(
    {
      success: false,
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: isProd ? "Internal Server Error" : getDbErrorMessage(err),
        ...(!isProd && err.cause !== undefined ? { details: err.cause } : {}),
      },
      requestId,
      path,
    },
    500,
  );
};
