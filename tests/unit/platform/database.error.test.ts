import { describe, expect, test } from "bun:test";
import { Cause } from "effect";
import {
  classifyDatabaseError,
  databaseErrorLogContext,
} from "../../../src/platform/database.error";

const dev = { includeDetail: true };
const prod = { includeDetail: false };

/** The cause chain the Drizzle rc + @effect/sql-pg stack produces. */
function drizzleError(fields: Record<string, string>) {
  const server = Object.assign(new Error(fields.message ?? "server error"), fields);
  const reason = Object.assign(new Error("reason"), { _tag: "ConstraintError", cause: server });
  const sqlError = Object.assign(new Error("sql"), { _tag: "SqlError", cause: reason });
  return Object.assign(new Error("Failed query"), {
    _tag: "EffectDrizzleQueryError",
    query: 'insert into "users" ("email") values ($1)',
    cause: Cause.fail(sqlError),
  });
}

describe("classifyDatabaseError", () => {
  test("maps a unique violation to a conflict without field errors", () => {
    const failure = classifyDatabaseError(
      drizzleError({ code: "23505", severity: "ERROR", constraint: "users_email_key" }),
      dev,
    );

    expect(failure?.kind).toBe("Conflict");
    expect(failure?.message).toBe("Resource already exists");
    expect(failure?.fields).toBeUndefined();
    expect(failure?.log.constraint).toBe("users_email_key");
  });

  test("names the column for a not-null violation", () => {
    const failure = classifyDatabaseError(
      drizzleError({ code: "23502", severity: "ERROR", column: "email" }),
      dev,
    );

    expect(failure?.kind).toBe("ValidationFailed");
    expect(failure?.fields).toEqual([
      { path: "email", code: "required", message: "Required field is missing" },
    ]);
  });

  test("maps a whole SQLSTATE class to service unavailable", () => {
    const failure = classifyDatabaseError(drizzleError({ code: "08006", severity: "FATAL" }), dev);
    expect(failure?.kind).toBe("ServiceUnavailable");
  });

  test("leaves bugs in our own SQL unclassified", () => {
    expect(classifyDatabaseError(drizzleError({ code: "42P01", severity: "ERROR" }), dev)).toBe(
      undefined,
    );
  });

  test("ignores Node errno codes that look like a SQLSTATE", () => {
    const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
    expect(classifyDatabaseError(error, dev)).toBeUndefined();
  });
});

describe("databaseErrorLogContext", () => {
  const error = drizzleError({
    code: "23505",
    severity: "ERROR",
    detail: "Key (email)=(ada@example.com) already exists.",
  });

  test("keeps the query text and drops row values in production", () => {
    const context = databaseErrorLogContext(error, prod) as Record<string, unknown>;
    expect(context.query).toBe('insert into "users" ("email") values ($1)');
    expect(context.detail).toBeUndefined();
    expect(JSON.stringify(context)).not.toContain("ada@example.com");
  });

  test("includes the detail outside production", () => {
    const context = databaseErrorLogContext(error, dev) as Record<string, unknown>;
    expect(context.detail).toContain("ada@example.com");
  });

  test("passes non-database errors through unchanged", () => {
    const plain = new Error("boom");
    expect(databaseErrorLogContext(plain, prod)).toBe(plain);
  });
});
