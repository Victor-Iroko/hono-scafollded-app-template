# Database

`src/core/db.ts` builds a `pg.Pool` with `max: 10` and keeps it on `globalThis`. Every function instance gets its own pool, so 100 concurrent functions can open 1,000 connections. A serverless Postgres endpoint will reject that.

The correct target depends on the runtime answer.

## Option A — Node runtime (Vercel Node, AWS Lambda, Netlify Node)

Keep `pg` and Drizzle's `node-postgres` driver, but point `DATABASE_URL` at a pooler and set the pool to one connection.

### Pooler

- **Neon:** copy the `-pooler` host from the dashboard (PgBouncer, transaction mode).
- **Supabase:** use the transaction pooler on port `6543`.
- **Generic:** PgBouncer in transaction mode.

Transaction pooling does not support session-level prepared statements. `pg` does not name statements by default, so it is fine. If you switch to `postgres-js`, set `prepare: false`.

### `src/core/db.ts`

```ts
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

let cached: { pool: Pool; db: DB } | undefined;

export function getDb(): DB {
  if (cached) return cached.db;

  const env = getEnv();
  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    // One connection per function instance. Scale with the pooler, not the pool.
    max: env.DB_POOL_MAX,
    idleTimeoutMillis: env.DB_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: env.DB_CONNECT_TIMEOUT_MS,
    allowExitOnIdle: true,
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

  cached = { pool, db };
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
```

Set:

```sh
DB_POOL_MAX=1
DB_IDLE_TIMEOUT_MS=10000
DB_CONNECT_TIMEOUT_MS=10000
```

`closeDb()` is only useful in tests now. Keep it if the test suite calls it; remove it from the entrypoint.

## Option B — Neon HTTP (Vercel, edge-friendly)

The HTTP driver removes the pool entirely. Use it when the runtime cannot open TCP, or when you want the lowest cold-start cost on Neon.

Install:

```sh
bun add @neondatabase/serverless
```

```ts
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import type { Context, Next } from "hono";
import * as schema from "../db/schema";
import * as relations from "../db/relations";
import { getEnv } from "./env";
import { getLogger } from "./logger";

const dbSchema = { ...schema, ...relations };

export type DB = NeonHttpDatabase<typeof dbSchema>;
export type DbVariables = { db: DB };

let cached: DB | undefined;

export function getDb(): DB {
  if (cached) return cached;
  const sql = neon(getEnv().DATABASE_URL);
  cached = drizzle({ client: sql, schema: dbSchema });
  return cached;
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
```

Remove `closeDb`, `DbTransaction`, and `DbOrTx`. **The Neon HTTP driver does not support `db.transaction()`.** The template does not use transactions yet, but `DbOrTx` is exported. If you need interactive transactions, use `drizzle-orm/neon-serverless` with a WebSocket pool instead of the HTTP driver, and keep `max: 1`.

## Option C — Supabase / generic Postgres with `postgres-js`

Install:

```sh
bun add postgres
```

```ts
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

const dbSchema = { ...schema, ...relations };
const client = postgres(getEnv().DATABASE_URL, {
  prepare: false, // required with a transaction pooler
  max: 1,
});

export type DB = PostgresJsDatabase<typeof dbSchema>;
export const db = drizzle({ client, schema: dbSchema });
```

`prepare: false` is mandatory behind Supabase's transaction pooler and PgBouncer transaction mode.

## Option D — Cloudflare D1

D1 is a binding, not a URL:

```ts
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";

export type DB = DrizzleD1Database<typeof dbSchema>;

export function getDb(env: { DB: D1Database }) {
  return drizzle(env.DB, { schema: dbSchema });
}
```

Wire the binding through `getApp(env)` and `dbMiddleware`. `src/core/env.ts` keeps non-DB vars; `DATABASE_URL` is no longer required on D1.

## Migrations

Keep them out of the request path and out of boot:

```json
"db:migrate": "drizzle-kit migrate"
```

Run `bun run db:migrate` in CI or a release step, using a **direct** (non-pooler) connection string. `db:push` stays local-only.

## Connection math

| `DB_POOL_MAX`  | Concurrent functions | Max connections                |
| -------------- | -------------------- | ------------------------------ |
| 10 (current)   | 100                  | 1,000                          |
| 1 (serverless) | 100                  | 100                            |
| 1 + pooler     | 1,000                | Pooler limit (for example 200) |

The pooler is the thing that scales, not the per-function pool.
