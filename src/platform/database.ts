// Postgres access through Drizzle on top of @effect/sql-pg.
//
// Queries are Effects: `yield* db.select().from(table)`. Wrap related writes in
// `db.transaction(...)`; the transaction follows the fiber, so any `db` call
// made inside it (including from other services) joins it automatically.
import { PgClient } from "@effect/sql-pg";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { EffectLogger } from "drizzle-orm/effect-postgres";
import { Context, Duration, Effect, Layer } from "effect";
import { AppConfig, DatabaseConfig } from "../config";
import { relations } from "../db/relations";

export type DatabaseClient = PgDrizzle.EffectPgDatabase<typeof relations> & {
  /** The underlying @effect/sql-pg client, for code that needs raw SQL on the same pool. */
  readonly $client: PgClient.PgClient;
};

const PgClientLive = Layer.unwrap(
  Effect.gen(function* () {
    const app = yield* AppConfig;
    const config = yield* DatabaseConfig;
    return PgClient.layer({
      url: config.url,
      maxConnections: config.poolMax,
      idleTimeout: Duration.millis(config.idleTimeoutMs),
      connectTimeout: Duration.millis(config.connectTimeoutMs),
      acquireTimeout: Duration.millis(config.connectTimeoutMs),
      applicationName: app.serviceName,
      startupParameters: { statement_timeout: String(config.statementTimeoutMs) },
    });
  }),
);

// SQL text only, at debug level. Bound parameters can carry personal data, and
// the SQL client already records a span per query.
const QueryLoggerLive = Layer.succeed(EffectLogger, {
  logQuery: (query) => Effect.logDebug("db query").pipe(Effect.annotateLogs({ query })),
});

export class Database extends Context.Service<Database, DatabaseClient>()("app/Database") {
  static readonly layer = Layer.effect(Database, PgDrizzle.make({ relations })).pipe(
    Layer.provide([PgClientLive, QueryLoggerLive]),
  );
}
