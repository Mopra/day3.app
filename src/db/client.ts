import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;
export { schema };

// One factory, two connection styles (per migration plan):
//   - Vercel web tier (serverless) → Supabase *transaction pooler* (port 6543).
//     Supavisor/pgbouncer in transaction mode can't keep prepared statements, so
//     `prepare: false`, and we keep the per-instance pool tiny.
//   - VPS worker (long-lived) → *direct* or *session pooler* (port 5432), both
//     of which support prepared statements, with a normal pool.
// The signal is the PORT, not the host: the session pooler is also on a
// `pooler.` host but runs on 5432 in session mode, so only :6543 means
// transaction mode. Inferred from DATABASE_URL so both processes share this code.
function isTransactionPooler(url: string): boolean {
  return /:6543\b/.test(url);
}

export function createDb(connectionString: string | undefined = process.env.DATABASE_URL): Db {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const txPooler = isTransactionPooler(connectionString);
  // Serverless (tx pooler) keeps a tiny per-instance pool; the long-lived worker
  // needs enough connections to cover its concurrent jobs (WORKER_CONCURRENCY
  // send lanes, each issuing its own claims/updates) plus headroom for cron and
  // the heartbeat — size DB_POOL_MAX at/above WORKER_CONCURRENCY. (Stays well
  // under Postgres' default 100-connection cap even with a few worker replicas.)
  const workerPoolMax = Math.max(1, Number(process.env.DB_POOL_MAX ?? "20"));
  const client = postgres(connectionString, {
    prepare: txPooler ? false : undefined,
    max: txPooler ? 1 : workerPoolMax,
  });
  return drizzle(client, { schema });
}

// Process-wide singleton. On Vercel this is reused across warm invocations on
// the same instance; on the VPS worker it's the single long-lived pool.
let cached: Db | undefined;
export function getDb(): Db {
  if (!cached) cached = createDb();
  return cached;
}
