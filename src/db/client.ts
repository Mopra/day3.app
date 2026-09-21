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
  //   - idle_timeout retires a connection that has been sitting in the pool, so a
  //     socket that went stale while the instance was frozen is dropped rather
  //     than reused after it thaws (see the note on max_lifetime, which used to
  //     do this job and wedged the pool doing it), and
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
          // max_lifetime is OFF here, and that is the fix for a hard outage, not
          // an oversight. It used to be 120s, as a hard cap on connection age so
          // a serverless instance couldn't keep handing requests to a socket that
          // went stale while it was frozen. But postgres.js starts the lifetime
          // timer once, at connect, and never cancels it: when it fires it calls
          // the connection's `end()`, which moves the connection OUT of the pool
          // and then, because a query is in flight, declines to terminate it. With
          // `max: 1` there is now no connection left to serve anyone. Every later
          // query lands on the pool's backlog, nothing ever closes the socket, so
          // `onclose` never runs and the backlog is never drained: the instance's
          // pool is wedged permanently, silently, with no error raised. Reproduced
          // against the real pooler by compressing the timer — throughput goes to
          // zero at the first expiry and never recovers.
          //
          // What follows is the visible damage: the hung requests trip
          // `withDeadline`, /api/health calls `resetDb()`, and postgres.js's
          // `destroy()` rejects every other queued query on that instance with
          // `write CONNECTION_DESTROYED` — a burst of unrelated 500s across
          // whatever routes that instance happened to be holding.
          //
          // Nothing is given up by switching it off. `idle_timeout` above covers
          // the stale-socket case it was there for, and covers it better: a socket
          // that went stale while the instance was frozen is by definition an idle
          // one, the idle timer is armed the moment a connection returns to the
          // pool, and 20s is a tighter bound than 120s. Crucially the pool cancels
          // the idle timer whenever the connection is busy (`move()` in
          // postgres.js), so unlike the lifetime timer it can never retire a
          // connection out from under a live query. The only thing max_lifetime
          // uniquely caps is a connection that is never idle for 20s — one that is
          // continuously answering queries, i.e. provably not stale.
          //
          // DB_MAX_LIFETIME_S still overrides if a future pooler makes an age cap
          // necessary; 0 disables, and that is the default.
          max_lifetime: Number(process.env.DB_MAX_LIFETIME_S ?? "0"),
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
