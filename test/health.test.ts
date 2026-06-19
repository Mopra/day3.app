import { describe, expect, it } from "vitest";
import { checkHealth, healthHttpStatus, CRON_STALE_MS } from "../src/lib/health";
import {
  readHeartbeat,
  writeHeartbeat,
  HEARTBEAT_KEY,
  HEARTBEAT_STALE_MS,
} from "../src/lib/heartbeat";
import { jobLogs } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import type { Db } from "../src/db/client";
import { testDb } from "./helpers";

// Record a cron sweep in job_logs as runScheduledSweeps does, with a given age.
async function seedCronRun(db: Db, ageMs: number): Promise<void> {
  const at = new Date(Date.now() - ageMs).toISOString();
  await db.insert(jobLogs).values({
    id: newId("job"),
    jobType: "cron",
    status: "completed",
    payloadJson: JSON.stringify({ stuckFailed: 0 }),
    createdAt: at,
    updatedAt: at,
  });
}

// A Db stand-in whose first DB call throws — simulates Postgres being
// unreachable without tearing down a real pool.
const downDb = {
  execute: async () => {
    throw new Error("connection refused");
  },
  query: {
    jobLogs: {
      findFirst: async () => {
        throw new Error("connection refused");
      },
    },
  },
} as unknown as Db;

describe("checkHealth", () => {
  it("reports ok with build info and a 200 status when DB and cron are healthy", async () => {
    const db = await testDb();
    await seedCronRun(db, 60_000); // fresh
    const report = await checkHealth({
      db,
      heartbeat: { present: true, at: nowIso(), ageMs: 1000, stale: false },
    });

    expect(report.status).toBe("ok");
    expect(report.checks.db.ok).toBe(true);
    expect(report.checks.cron.ok).toBe(true);
    expect(report.checks.worker.ok).toBe(true);
    expect(report.build).toMatchObject({
      version: expect.any(String),
      commit: expect.any(String),
      env: expect.any(String),
    });
    expect(typeof report.timestamp).toBe("string");
    expect(healthHttpStatus(report)).toBe(200);
  });

  it("returns 503 / unhealthy when the DB is unreachable", async () => {
    const report = await checkHealth({ db: downDb, heartbeat: null });

    expect(report.status).toBe("unhealthy");
    expect(report.checks.db.ok).toBe(false);
    expect(report.checks.db.detail).toMatch(/connection refused/);
    // The cron check is skipped (not run against a dead DB) but still reported.
    expect(report.checks.cron.ok).toBe(false);
    expect(healthHttpStatus(report)).toBe(503);
    // The body still carries build info so a monitor can record which deploy failed.
    expect(report.build.version).toEqual(expect.any(String));
  });

  it("degrades (200) when the cron sweep is stale", async () => {
    const db = await testDb();
    await seedCronRun(db, CRON_STALE_MS + 60_000); // older than the threshold
    const report = await checkHealth({
      db,
      heartbeat: { present: true, at: nowIso(), ageMs: 1000, stale: false },
    });

    expect(report.checks.db.ok).toBe(true);
    expect(report.checks.cron.ok).toBe(false);
    expect(report.checks.cron.detail).toMatch(/stale/);
    expect(report.status).toBe("degraded");
    expect(healthHttpStatus(report)).toBe(200); // web tier itself is fine
  });

  it("flags cron unhealthy when no sweep has ever run", async () => {
    const db = await testDb();
    const report = await checkHealth({ db, heartbeat: null });
    expect(report.checks.cron.ok).toBe(false);
    expect(report.checks.cron.detail).toMatch(/no cron sweep/);
    expect(report.status).toBe("degraded");
  });

  it("degrades when the worker heartbeat is missing or stale", async () => {
    const db = await testDb();
    await seedCronRun(db, 60_000);

    const missing = await checkHealth({ db, heartbeat: { present: false } });
    expect(missing.checks.worker.ok).toBe(false);
    expect(missing.status).toBe("degraded");

    const stale = await checkHealth({
      db,
      heartbeat: { present: true, at: nowIso(), ageMs: HEARTBEAT_STALE_MS + 1, stale: true },
    });
    expect(stale.checks.worker.ok).toBe(false);
    expect(stale.status).toBe("degraded");
  });

  it("stays ok when the heartbeat is unavailable (null), relying on cron", async () => {
    const db = await testDb();
    await seedCronRun(db, 60_000);
    const report = await checkHealth({ db, heartbeat: null });
    expect(report.checks.worker.ok).toBe(true); // unknown-but-ok
    expect(report.status).toBe("ok");
  });
});

// In-memory Redis stand-in exercising the heartbeat read/write contract without
// a live Redis (the worker writes, the health endpoint reads the same key).
class FakeRedis {
  store = new Map<string, string>();
  async set(key: string, value: string): Promise<"OK"> {
    this.store.set(key, value);
    return "OK";
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
}

describe("worker heartbeat", () => {
  it("round-trips through Redis and reports fresh", async () => {
    const redis = new FakeRedis();
    const now = new Date();
    await writeHeartbeat(redis as never, now);
    expect(redis.store.get(HEARTBEAT_KEY)).toBe(now.toISOString());

    const state = await readHeartbeat(redis as never, now);
    expect(state).toEqual({ present: true, at: now.toISOString(), ageMs: 0, stale: false });
  });

  it("reports absent when no heartbeat was written", async () => {
    const state = await readHeartbeat(new FakeRedis() as never);
    expect(state).toEqual({ present: false });
  });

  it("reports stale once the heartbeat ages past the threshold", async () => {
    const redis = new FakeRedis();
    const wroteAt = new Date();
    await writeHeartbeat(redis as never, wroteAt);
    const later = new Date(wroteAt.getTime() + HEARTBEAT_STALE_MS + 1000);
    const state = await readHeartbeat(redis as never, later);
    expect(state.present && state.stale).toBe(true);
  });
});
