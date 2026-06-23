import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

// drizzle-kit is a standalone CLI and doesn't read Next's .env.local, so load it
// (then .env) ourselves. `override: false` keeps real environment variables
// (CI/prod) winning over the files.
config({ path: ".env.local", override: false });
config({ path: ".env", override: false });

// `generate` needs only dialect + schema + out. `migrate`/`push`/`studio` also
// need a connection — and must use the Supabase *session* connection (port 5432),
// NOT the transaction pooler (6543) which can't run migrations. Prefer DIRECT_URL
// (the 5432 URL) and fall back to DATABASE_URL so existing setups still work.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? "",
  },
});
