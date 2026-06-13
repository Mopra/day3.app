import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Db = PostgresJsDatabase<typeof schema>;
export { schema };

// One factory, two connection styles (per migration plan):
//   - Vercel web tier (serverless) → Supabase *transaction pooler* (port 6543).
//     pgbouncer in transaction mode can't keep prepared statements, so
//     `prepare: false`, and we keep the per-instance pool tiny.
//   - VPS worker (long-lived) → *direct/session* connection (port 5432) with a
//     normal pool.
// The right mode is inferred from DATABASE_URL so both processes share this code.
function isPooledUrl(url: string): boolean {
  return /(?::6543\b)|(?:pooler\.)/.test(url);
}

export function createDb(connectionString: string | undefined = process.env.DATABASE_URL): Db {
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const pooled = isPooledUrl(connectionString);
  const client = postgres(connectionString, {
    prepare: pooled ? false : undefined,
    max: pooled ? 1 : 10,
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
