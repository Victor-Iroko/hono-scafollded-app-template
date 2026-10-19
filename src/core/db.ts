import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Context, Next } from "hono";
import * as schema from "../db/schema";
import * as relations from "../db/relations";
import { getEnv } from "./env";
import { getLogger } from "./logger";

const dbSchema = { ...schema, ...relations };

export type DB = NodePgDatabase<typeof dbSchema>;
export type DbTransaction = Parameters<Parameters<DB["transaction"]>[0]>[0];
export type DbOrTx = DB | DbTransaction;
export type DbVariables = { db: DB };

// Cache on globalThis so `bun --hot` reloads don't leak pools.
const globalCache = globalThis as unknown as {
  __db?: { pool: Pool; db: DB };
};

export function getDb(): DB {
  if (globalCache.__db) return globalCache.__db.db;
  const env = getEnv();
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
    // Serverless (Neon/Vercel/Workers): use `max: 1` with a pooler URL.
    // pg is auto-instrumented by OTel; postgres-js is not.
  });

  const db = drizzle(pool, {
    schema: dbSchema,
    logger:
      env.NODE_ENV === "development"
        ? {
            logQuery: (query, params) => getLogger().debug({ query, params }, "db query"),
          }
        : undefined,
  });

  globalCache.__db = { pool, db };
  return db;
}

export function dbMiddleware() {
  return async (c: Context<{ Variables: DbVariables }>, next: Next) => {
    c.set("db", getDb());
    await next();
  };
}

export async function checkDbHealth(
  timeoutMs = 2_000,
): Promise<{ ok: boolean; latencyMs: number }> {
  const start = performance.now();
  try {
    await Promise.race([
      getDb().execute("select 1"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("db health timeout")), timeoutMs),
      ),
    ]);
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (err) {
    getLogger().warn({ err }, "database health check failed");
    return { ok: false, latencyMs: Math.round(performance.now() - start) };
  }
}

export async function closeDb(): Promise<void> {
  const cached = globalCache.__db;
  if (!cached) return;
  globalCache.__db = undefined;
  await cached.pool.end();
}
