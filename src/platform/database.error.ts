// Classifies Postgres failures by SQLSTATE so callers can answer with the right
// client-facing error instead of a blanket 500. Unlisted codes return
// `undefined` and stay internal errors: class 42 (undefined table/column,
// syntax) is always a bug in our own SQL.
//
// The server error sits at the end of the cause chain:
// EffectDrizzleQueryError → Cause (Fail reason) → SqlError → reason
// (UniqueViolation, ...) → Error carrying the Postgres ErrorResponse fields.
import { Cause } from "effect";

export type DatabaseFailureKind =
  | "BadRequest"
  | "Conflict"
  | "ValidationFailed"
  | "ServiceUnavailable";

export interface DatabaseFieldError {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface DatabaseFailure {
  readonly kind: DatabaseFailureKind;
  readonly message: string;
  readonly fields?: ReadonlyArray<DatabaseFieldError>;
  /** Diagnostic context for logs. Never contains bound parameters. */
  readonly log: Record<string, unknown>;
}

export interface ClassifyOptions {
  /** Postgres `detail` can contain row values, so include it only outside production. */
  readonly includeDetail: boolean;
}

interface PostgresErrorFields {
  readonly code: string;
  readonly severity: string;
  readonly message?: unknown;
  readonly detail?: unknown;
  readonly schema?: unknown;
  readonly table?: unknown;
  readonly column?: unknown;
  readonly constraint?: unknown;
}

type Mapping = { readonly kind: DatabaseFailureKind; readonly message: string };

const RETRY_MESSAGE = "Conflicting write, retry the request";

const SQLSTATE_TO_FAILURE: Record<string, Mapping> = {
  "23505": { kind: "Conflict", message: "Resource already exists" },
  "23503": { kind: "Conflict", message: "Referenced resource does not exist" },
  "23P01": { kind: "Conflict", message: "Resource conflicts with an existing one" },
  "23502": { kind: "ValidationFailed", message: "Required field is missing" },
  "23514": { kind: "ValidationFailed", message: "Value violates a constraint" },
  "22001": { kind: "ValidationFailed", message: "Value is too long" },
  "22003": { kind: "ValidationFailed", message: "Value is out of range" },
  "22P02": { kind: "BadRequest", message: "Malformed value" },
  "40001": { kind: "ServiceUnavailable", message: RETRY_MESSAGE },
  "40P01": { kind: "ServiceUnavailable", message: RETRY_MESSAGE },
  "57014": { kind: "ServiceUnavailable", message: "Query timed out" },
};

// Classes that blame the database rather than the request.
const SQLSTATE_CLASS_TO_FAILURE: Record<string, Mapping> = {
  "08": { kind: "ServiceUnavailable", message: "Database unavailable" },
  "53": { kind: "ServiceUnavailable", message: "Database unavailable" },
  "57": { kind: "ServiceUnavailable", message: "Database unavailable" },
};

// Field-level codes, used only when the server names the column. Constraint
// names are never parsed: `users_org_id_email_key` (composite) reads exactly
// like a single-column unique on `email`.
const SQLSTATE_TO_FIELD_CODE: Record<string, string> = {
  "23502": "required",
  "23514": "invalid",
  "22001": "too_long",
  "22003": "out_of_range",
};

// Five alphanumerics. Requiring `severity` as well rejects Node errno codes
// (EPIPE, ...) that share the shape.
const SQLSTATE = /^[0-9A-Z]{5}$/;
const MAX_CAUSE_DEPTH = 6;

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

function isPostgresError(value: unknown): value is PostgresErrorFields {
  const candidate = value as Partial<PostgresErrorFields> | null;
  return (
    typeof candidate?.code === "string" &&
    SQLSTATE.test(candidate.code) &&
    typeof candidate.severity === "string"
  );
}

/** The errors one level down: an Effect `Cause` holds them as reasons, everything else as `cause`. */
function nestedErrors(value: unknown): ReadonlyArray<unknown> {
  if (Cause.isCause(value)) {
    return value.reasons.flatMap((reason) =>
      Cause.isFailReason(reason)
        ? [reason.error]
        : Cause.isDieReason(reason)
          ? [reason.defect]
          : [],
    );
  }
  if (typeof value === "object" && value !== null && "cause" in value) return [value.cause];
  return [];
}

export function findPostgresError(error: unknown): PostgresErrorFields | undefined {
  let level: ReadonlyArray<unknown> = [error];
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && level.length > 0; depth++) {
    const match = level.find(isPostgresError);
    if (match) return match;
    level = level.flatMap(nestedErrors);
  }
  return undefined;
}

function findQueryText(error: unknown): string | undefined {
  return asString((error as { query?: unknown } | null)?.query);
}

function buildLogContext(
  server: PostgresErrorFields,
  error: unknown,
  options: ClassifyOptions,
): Record<string, unknown> {
  const detail = asString(server.detail);
  return {
    sqlstate: server.code,
    severity: server.severity,
    message: asString(server.message),
    schema: asString(server.schema),
    table: asString(server.table),
    column: asString(server.column),
    constraint: asString(server.constraint),
    query: findQueryText(error),
    ...(options.includeDetail && detail ? { detail } : {}),
  };
}

export function classifyDatabaseError(
  error: unknown,
  options: ClassifyOptions,
): DatabaseFailure | undefined {
  const server = findPostgresError(error);
  if (!server) return undefined;

  const mapping =
    SQLSTATE_TO_FAILURE[server.code] ?? SQLSTATE_CLASS_TO_FAILURE[server.code.slice(0, 2)];
  if (!mapping) return undefined;

  const fieldCode = SQLSTATE_TO_FIELD_CODE[server.code];
  const column = asString(server.column);
  return {
    ...mapping,
    ...(fieldCode && column
      ? { fields: [{ path: column, code: fieldCode, message: mapping.message }] }
      : {}),
    log: buildLogContext(server, error, options),
  };
}

/** Log context for any error; Postgres failures are reduced to their diagnostic fields. */
export function databaseErrorLogContext(error: unknown, options: ClassifyOptions): unknown {
  const server = findPostgresError(error);
  return server ? buildLogContext(server, error, options) : error;
}
