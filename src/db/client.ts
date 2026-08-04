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

// The raw postgres.js client behind `cached`, kept so a wedged pool can be
// destroyed outright (see resetDb). drizzle doesn't expose it.
type Client = ReturnType<typeof postgres>;
let cachedClient: Client | undefined;

function createDbWithClient(
  connectionString: string | undefined = process.env.DATABASE_URL,
): { db: Db; client: Client } {
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

  // Runaway-query cap for the web tier: a server-side statement_timeout makes a
  // long query fail fast and free the connection. Applied to the web tier only —
  // the long-lived worker runs legitimately long jobs (imports/sends), so it
  // defaults to no cap. Env-tunable; 0 disables.
  //
  // IMPORTANT: statement_timeout is NOT a hang guard. It is a server-side
  // parameter, so it only applies to queries the server actually receives. On a
  // half-open socket — established from the client's point of view, but with the
  // peer gone and no FIN/RST ever delivered, which is what a frozen-then-thawed
  // serverless instance is left holding — the query is written into a black hole
  // and neither statement_timeout nor connect_timeout (which only bounds
  // *establishing* a connection) ever fires. postgres.js has no client-side query
  // timeout, so the query hangs indefinitely and the request returns no response
  // at all. Two mitigations below, plus `withDeadline` at the call site:
  //   - max_lifetime recycles connections so a stale socket is far less likely to
  //     be reused after the instance thaws, and
  //   - keep_alive makes the kernel probe an idle socket so a dead peer is
  //     eventually detected rather than trusted forever.
  const statementTimeoutMs = Number(
    process.env.DB_STATEMENT_TIMEOUT_MS ?? (txPooler ? "15000" : "0"),
  );
  const connectTimeoutS = Number(process.env.DB_CONNECT_TIMEOUT_S ?? "10");
  const client = postgres(connectionString, {
    prepare: txPooler ? false : undefined,
    max: txPooler ? 1 : workerPoolMax,
    connect_timeout: connectTimeoutS,
    // Probe idle sockets (seconds) so a vanished peer surfaces as an error
    // instead of an indefinitely-trusted "established" connection.
    keep_alive: Number(process.env.DB_KEEP_ALIVE_S ?? "15"),
    ...(txPooler
      ? {
          // Release idle serverless connections back to the Supabase pooler so
          // many warm-but-idle instances don't sit on pooler slots.
          idle_timeout: Number(process.env.DB_IDLE_TIMEOUT_S ?? "20"),
          // Hard cap on connection age. Bounds how long a serverless instance can
          // keep handing requests to a socket that went stale while it was frozen.
          max_lifetime: Number(process.env.DB_MAX_LIFETIME_S ?? "120"),
        }
      : {}),
    ...(statementTimeoutMs > 0
      ? { connection: { statement_timeout: statementTimeoutMs } }
      : {}),
  });
  return { db: drizzle(client, { schema }), client };
}

export function createDb(connectionString?: string): Db {
  return createDbWithClient(connectionString).db;
}

// Process-wide singleton. On Vercel this is reused across warm invocations on
// the same instance; on the VPS worker it's the single long-lived pool.
let cached: Db | undefined;
export function getDb(): Db {
  if (!cached) {
    const created = createDbWithClient();
    cached = created.db;
    cachedClient = created.client;
  }
  return cached;
}

/**
 * Throw away the cached pool so the next `getDb()` reconnects.
 *
 * The recovery half of the half-open-socket problem described above. A query that
 * blew its `withDeadline` is abandoned, not cancelled, and it keeps occupying its
 * connection — with `max: 1` on the web tier that means the instance's only
 * connection stays busy forever, so every later request inherits the wedge. That
 * is what turns one stalled query into a multi-minute run of failures until the
 * platform happens to recycle the instance. Dropping the pool here bounds the
 * damage to the single request that hit it.
 *
 * Teardown is fire-and-forget with `{ timeout: 0 }` (destroy, don't drain): the
 * whole point is that this connection no longer responds, so awaiting a graceful
 * close would hang exactly as long as the query we just gave up on.
 */
export function resetDb(): void {
  const client = cachedClient;
  cached = undefined;
  cachedClient = undefined;
  if (!client) return;
  void Promise.resolve(client.end({ timeout: 0 })).catch(() => {});
}
