// Requires the Postgres from docker-compose.test.yml:
//   docker compose -f docker-compose.test.yml up -d --wait postgres-test
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { pgTable, text, uuid } from "drizzle-orm/pg-core";
import { Effect, ManagedRuntime } from "effect";
import { Database } from "../../src/platform/database";
import { classifyDatabaseError } from "../../src/platform/database.error";
import { withTestConfig } from "../support/config";

const widgets = pgTable("test_widgets", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull().unique(),
});

const runtime = ManagedRuntime.make(Database.layer.pipe(withTestConfig()));
const run = <A, E>(effect: Effect.Effect<A, E, Database>) => runtime.runPromise(effect);

const insertWidget = (name: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* db.insert(widgets).values({ name });
  });

const countWidgets = (name: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const rows = yield* db.select({ id: widgets.id }).from(widgets).where(eq(widgets.name, name));
    return rows.length;
  });

beforeAll(() =>
  run(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.execute(sql`drop table if exists test_widgets`);
      yield* db.execute(
        sql`create table test_widgets (id uuid primary key default gen_random_uuid(), name text not null unique)`,
      );
    }),
  ),
);

afterAll(async () => {
  await run(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.execute(sql`drop table if exists test_widgets`);
    }),
  );
  await runtime.dispose();
});

describe("Database", () => {
  test("inserts and reads rows", async () => {
    await run(insertWidget("alpha"));
    expect(await run(countWidgets("alpha"))).toBe(1);
  });

  test("rolls back every write in a failed transaction", async () => {
    const failed = Effect.gen(function* () {
      const db = yield* Database;
      yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* insertWidget("rolled-back");
          return yield* Effect.fail("abort" as const);
        }),
      );
    });

    const exit = await run(Effect.exit(failed));
    expect(exit._tag).toBe("Failure");
    expect(await run(countWidgets("rolled-back"))).toBe(0);
  });

  test("joins the outer transaction from nested service calls", async () => {
    // insertWidget uses `db`, not the `tx` handle, and still runs inside the transaction.
    const failed = Effect.gen(function* () {
      const db = yield* Database;
      yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* insertWidget("nested-1");
          yield* db.transaction(() => insertWidget("nested-2"));
          return yield* Effect.fail("abort" as const);
        }),
      );
    });

    await run(Effect.exit(failed));
    expect(await run(countWidgets("nested-1"))).toBe(0);
    expect(await run(countWidgets("nested-2"))).toBe(0);
  });

  test("applies session settings from config", async () => {
    const settings = await run(
      Effect.gen(function* () {
        const db = yield* Database;
        return yield* db.execute<{ timeout: string; app: string }>(
          sql`select current_setting('statement_timeout') as timeout, current_setting('application_name') as app`,
        );
      }),
    );
    expect(settings.rows[0]).toEqual({ timeout: "30s", app: "api" });
  });

  test("classifies a real unique violation as a conflict", async () => {
    await run(insertWidget("duplicate"));
    const error = await run(Effect.flip(insertWidget("duplicate")));

    const failure = classifyDatabaseError(error, { includeDetail: false });
    expect(failure?.kind).toBe("Conflict");
    expect(failure?.log.constraint).toBe("test_widgets_name_key");
    expect(failure?.log.query).toContain("insert into");
  });
});
