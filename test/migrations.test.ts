import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "./apply-migrations";

// Migration discipline guard. These tests are the source of truth that
// `src/db/schema.ts`, the generated SQL, the journal, and the meta snapshots all
// agree — the chain CI relies on (CI additionally runs `drizzle-kit generate`
// and fails on any non-empty diff; see .github/workflows/ci.yml).
const MIGRATIONS_DIR = path.join(process.cwd(), "migrations");
const META_DIR = path.join(MIGRATIONS_DIR, "meta");

type JournalEntry = { idx: number; tag: string };
type Journal = { entries: JournalEntry[] };

function readJournal(): Journal {
  return JSON.parse(readFileSync(path.join(META_DIR, "_journal.json"), "utf8")) as Journal;
}

describe("migrations", () => {
  it("apply cleanly from scratch on a fresh database", async () => {
    const pg = new PGlite();
    await expect(applyMigrations(pg)).resolves.toBeUndefined();
    // A representative table proves the schema actually materialised.
    const rows = await pg.query<{ name: string }>(
      "select table_name as name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    const names = rows.rows.map((r) => r.name);
    expect(names).toContain("accounts");
    expect(names).toContain("campaign_recipients");
    expect(names).toContain("sending_domains");
  });

  it("journal entries match the SQL files on disk, in forward-only order", () => {
    const journal = readJournal();
    const sqlFiles = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    // One journal entry per migration file, same tags, monotonic idx.
    expect(journal.entries.map((e) => `${e.tag}.sql`)).toEqual(sqlFiles);
    journal.entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
    });
  });

  it("every journal entry has a meta snapshot (no orphan migrations)", () => {
    // The classic drift bug: a hand-written migration added to the journal
    // without its meta snapshot, so `drizzle-kit generate` re-emits its change.
    const journal = readJournal();
    for (const entry of journal.entries) {
      const snapshot = path.join(META_DIR, `${String(entry.idx).padStart(4, "0")}_snapshot.json`);
      expect(existsSync(snapshot), `missing snapshot for ${entry.tag}`).toBe(true);
    }
  });
});
