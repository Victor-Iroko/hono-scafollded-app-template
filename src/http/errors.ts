// The error contract: every error response is an RFC 9457 problem
// (`application/problem+json`): { type, title, status, detail?, errors? }.
//
// Handlers fail with these classes. Declare the ones an endpoint can return in
// its `error` option so they appear in OpenAPI and in the typed client.
import { Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiError } from "effect/http-api";
import { STATUS_CODES } from "node:http";
import type { DatabaseFailure } from "../platform/database.error";

const BLANK = "about:blank";

/** A request value that failed validation; the first path segment names its source. */
export const FieldIssue = Schema.Struct({
  path: Schema.Array(Schema.Union([Schema.String, Schema.Number])),
  message: Schema.String,
});

export class BadRequest extends HttpApiError.Problem<BadRequest>()("BadRequest", {
  type: BLANK,
  status: 400,
  title: "Bad Request",
}) {}

export class Unauthorized extends HttpApiError.Problem<Unauthorized>()("Unauthorized", {
  type: BLANK,
  status: 401,
  title: "Unauthorized",
}) {}

export class Forbidden extends HttpApiError.Problem<Forbidden>()("Forbidden", {
  type: BLANK,
  status: 403,
  title: "Forbidden",
}) {}

export class NotFound extends HttpApiError.Problem<NotFound>()("NotFound", {
  type: BLANK,
  status: 404,
  title: "Not Found",
}) {}

export class Conflict extends HttpApiError.Problem<Conflict>()("Conflict", {
  type: BLANK,
  status: 409,
  title: "Conflict",
}) {}

export class ValidationFailed extends HttpApiError.Problem<ValidationFailed>()(
  "ValidationFailed",
  { type: BLANK, status: 422, title: "Unprocessable Content" },
  { errors: Schema.optionalKey(Schema.Array(FieldIssue)) },
) {}

export class TooManyRequests extends HttpApiError.Problem<TooManyRequests>()("TooManyRequests", {
  type: BLANK,
  status: 429,
  title: "Too Many Requests",
}) {}

export class InternalServerError extends HttpApiError.Problem<InternalServerError>()(
  "InternalServerError",
  { type: BLANK, status: 500, title: "Internal Server Error" },
) {}

export class ServiceUnavailable extends HttpApiError.Problem<ServiceUnavailable>()(
  "ServiceUnavailable",
  { type: BLANK, status: 503, title: "Service Unavailable" },
) {}

/** The problem a classified database failure answers with. */
export function problemFromDatabaseFailure(failure: DatabaseFailure) {
  const detail = failure.message;
  switch (failure.kind) {
    case "BadRequest":
      return new BadRequest({ detail });
    case "Conflict":
      return new Conflict({ detail });
    case "ServiceUnavailable":
      return new ServiceUnavailable({ detail });
    case "ValidationFailed":
      return new ValidationFailed({
        detail,
        ...(failure.fields
          ? {
              errors: failure.fields.map((field) => ({
                path: ["payload", field.path],
                message: field.message,
              })),
            }
          : {}),
      });
  }
}

/** A bare problem for statuses without a dedicated class (404 route, 413, ...). */
export function problemResponse(status: number) {
  return HttpServerResponse.jsonUnsafe(
    { type: BLANK, title: STATUS_CODES[status] ?? "Error", status },
    { status, contentType: "application/problem+json" },
  );
}
