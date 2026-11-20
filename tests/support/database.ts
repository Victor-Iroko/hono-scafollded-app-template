import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { Effect } from "effect";
import { join } from "node:path";
import { Database } from "../../src/platform/database";

const MIGRATIONS_FOLDER = join(import.meta.dir, "..", "..", "src", "db", "migrations");

/** Applies the app's migrations to the test database. */
export const migrateTestDatabase = Effect.gen(function* () {
  const db = yield* Database;
  yield* migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
});

/** Empties the given tables; only ever run against the test database. */
export const truncateTables = (...tables: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* db.execute(sql.raw(`truncate table ${tables.map((t) => `"${t}"`).join(", ")} cascade`));
  });
