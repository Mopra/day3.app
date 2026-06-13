// npm run db:seed — applies seed.sql to DATABASE_URL. Idempotent (the seed uses
// ON CONFLICT DO NOTHING). Secret-free: reads DATABASE_URL from the environment.
import { readFileSync } from "node:fs";
import path from "node:path";
import postgres from "postgres";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });
const content = readFileSync(path.join(process.cwd(), "seed.sql"), "utf8");

await sql.unsafe(content);

const [{ accounts }] = await sql`select count(*)::int as accounts from accounts`;
const [{ subscribers }] = await sql`select count(*)::int as subscribers from subscribers`;
const [{ campaigns }] = await sql`select count(*)::int as campaigns from campaigns`;
console.log(`seeded: accounts=${accounts}, subscribers=${subscribers}, campaigns=${campaigns}`);
await sql.end();
