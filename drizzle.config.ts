import { defineConfig } from "drizzle-kit";

// `generate` needs only dialect + schema + out. `migrate`/`push`/`studio` also
// need a connection — point DATABASE_URL at the Supabase *direct/session*
// connection (port 5432) when running migrations.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
});
