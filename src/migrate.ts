// Applies pending Drizzle migrations, then exits. Run it as a release step
// before starting new API or worker processes, never on API boot.
import { BunRuntime } from "@effect/platform-bun";
import { migrate } from "drizzle-orm/effect-postgres/migrator";
import { Effect, Layer } from "effect";
import { join } from "node:path";
import { Database } from "./platform/database";
import { ObservabilityLive } from "./platform/observability";

const MIGRATIONS_FOLDER = join(import.meta.dir, "db", "migrations");

const applyMigrations = Effect.gen(function* () {
  const db = yield* Database;
  yield* Effect.logInfo("applying migrations");
  yield* migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  yield* Effect.logInfo("migrations applied");
});

BunRuntime.runMain(
  applyMigrations.pipe(Effect.provide(Layer.merge(Database.layer, ObservabilityLive))),
);
