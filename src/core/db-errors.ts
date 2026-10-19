import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DatabaseError } from "pg";
import { getEnv } from "./env";
import type { ErrorCode, FieldError } from "./error-schema";

type PostgresError = DatabaseError & Record<"code" | "severity", string>;

export type MappedDbError = {
  status: ContentfulStatusCode;
  code: ErrorCode;
  message: string;
  fields?: FieldError[];
  /** Diagnostic context without Drizzle's bound-parameter array. */
  log: Record<string, unknown>;
};

// SQLSTATE is five alphanumerics. Requiring severity alongside it rejects the
// Node errno codes (EPIPE, ...) that happen to share the shape.
const SQLSTATE = /^[0-9A-Z]{5}$/;

const SQLSTATE_TO_HTTP_ERROR: Record<
  string,
  { status: ContentfulStatusCode; code: ErrorCode; message: string }
> = {
  "23505": { status: 409, code: "CONFLICT", message: "Resource already exists" },
  "23503": { status: 409, code: "CONFLICT", message: "Referenced resource does not exist" },
  "23P01": { status: 409, code: "CONFLICT", message: "Resource conflicts with an existing one" },
  "23502": { status: 422, code: "VALIDATION_ERROR", message: "Required field is missing" },
  "23514": { status: 422, code: "VALIDATION_ERROR", message: "Value violates a constraint" },
  "22001": { status: 422, code: "VALIDATION_ERROR", message: "Value is too long" },
  "22003": { status: 422, code: "VALIDATION_ERROR", message: "Value is out of range" },
  "22P02": { status: 400, code: "BAD_REQUEST", message: "Malformed value" },
  "40001": {
    status: 503,
    code: "SERVICE_UNAVAILABLE",
    message: "Conflicting write, retry the request",
  },
  "40P01": {
    status: 503,
    code: "SERVICE_UNAVAILABLE",
    message: "Conflicting write, retry the request",
  },
  "57014": { status: 503, code: "SERVICE_UNAVAILABLE", message: "Query timed out" },
};

// SQLSTATE classes that blame the database rather than the request. Classes 23
// (integrity) and 42 (undefined table/column, syntax) stay unmapped on purpose:
// 23 is handled case by case above, and 42 is always a bug in our own SQL.
const SQLSTATE_CLASS_TO_HTTP_ERROR: Record<
  string,
  { status: ContentfulStatusCode; code: ErrorCode; message: string }
> = {
  "08": { status: 503, code: "SERVICE_UNAVAILABLE", message: "Database unavailable" },
  "53": { status: 503, code: "SERVICE_UNAVAILABLE", message: "Database unavailable" },
  "57": { status: 503, code: "SERVICE_UNAVAILABLE", message: "Database unavailable" },
};

// Field-level codes, only ever used when the server names the column outright.
// Constraint names cannot be parsed reliably: `users_org_id_email_key` (a
// composite key) reads exactly like a single-column unique on `email`.
const SQLSTATE_TO_FIELD_ERROR_CODE: Record<string, string> = {
  "23502": "required",
  "23514": "invalid",
  "22001": "too_long",
  "22003": "out_of_range",
};

// The server error, found by walking the cause chain. Drizzle wraps it in a
// DrizzleQueryError, and matching on shape rather than on that class survives
// the ESM/CJS copies of the module having different class identities.
function findPostgresError(err: unknown): PostgresError | undefined {
  let current: unknown = err;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    const candidate = current as Partial<PostgresError>;
    if (
      typeof candidate.code === "string" &&
      SQLSTATE.test(candidate.code) &&
      typeof candidate.severity === "string"
    ) {
      return current as PostgresError;
    }
    current = current.cause;
  }
  return undefined;
}

// Drizzle's wrapper carries the SQL text; values stay as $1 placeholders.
function getDrizzleQueryText(err: unknown): string | undefined {
  const query = (err as { query?: unknown } | null)?.query;
  return typeof query === "string" ? query : undefined;
}

// Bun adds stack-derived line/column fields, so server fields are read as text.
function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function createDbErrorLogContext(server: PostgresError, err: unknown): Record<string, unknown> {
  const isProd = getEnv().NODE_ENV === "production";
  const detail = asString(server.detail);
  return {
    name: server.name,
    // Use the server message; Drizzle's wrapper includes bound parameter values.
    message: server.message,
    sqlstate: server.code,
    severity: server.severity,
    schema: asString(server.schema),
    table: asString(server.table),
    column: asString(server.column),
    constraint: asString(server.constraint),
    query: getDrizzleQueryText(err),
    // `detail` can contain row values.
    ...(!isProd && detail ? { detail } : {}),
    stack: server.stack,
  };
}

export function mapDbErrorToHttp(err: unknown): MappedDbError | undefined {
  const postgresError = findPostgresError(err);
  if (!postgresError) return undefined;
  const mapped =
    SQLSTATE_TO_HTTP_ERROR[postgresError.code] ??
    SQLSTATE_CLASS_TO_HTTP_ERROR[postgresError.code.slice(0, 2)];
  if (!mapped) return undefined;
  return {
    ...mapped,
    fields: getDbFieldErrors(postgresError, mapped.message),
    log: createDbErrorLogContext(postgresError, err),
  };
}

function getDbFieldErrors(postgresError: PostgresError, message: string): FieldError[] | undefined {
  const code = SQLSTATE_TO_FIELD_ERROR_CODE[postgresError.code];
  const column = asString(postgresError.column);
  if (!code || !column) return undefined;
  return [{ path: column, code, message }];
}

/** Replaces Drizzle's parameter-bearing wrapper with PostgreSQL diagnostic context. */
export function getDbErrorLogContext(err: unknown): unknown {
  const postgresError = findPostgresError(err);
  return postgresError ? createDbErrorLogContext(postgresError, err) : err;
}

export function getDbErrorMessage(err: unknown): string {
  const postgresError = findPostgresError(err);
  if (postgresError) return postgresError.message;
  return err instanceof Error ? err.message : String(err);
}
