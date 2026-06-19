import path from "node:path";
import { defineConfig } from "vitest/config";

// The domain handlers run against real Postgres via pglite (Postgres-in-WASM):
// a fresh in-memory database per test, migrations applied from migrations/.
// No external services — the idempotency suite (the crown jewels) runs hermetic.
export default defineConfig({
  // Mirror the tsconfig "@/*" → src alias so route handlers (which import via
  // "@/") can be exercised directly in tests.
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
