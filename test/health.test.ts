import { describe, expect, it } from "vitest";
import { checkHealth, healthHttpStatus, CRON_STALE_MS } from "../src/lib/health";
import {
  readHeartbeat,
  writeHeartbeat,
  HEARTBEAT_KEY,
  HEARTBEAT_STALE_MS,
} from "../src/lib/heartbeat";
import { isDeadlineError, withDeadline } from "../src/lib/deadline";
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

// A raw driver error mimicking what postgres-js throws on a dead connection —
// it carries host/IP/port, which must NEVER reach the public response body.
const RAW_DRIVER_ERROR = "connect ECONNREFUSED 10.0.0.5:6543";

// A Db stand-in whose first DB call throws — simulates Postgres being
// unreachable without tearing down a real pool.
const downDb = {
  execute: async () => {
    throw new Error(RAW_DRIVER_ERROR);
  },
  query: {
    jobLogs: {
      findFirst: async () => {
        throw new Error(RAW_DRIVER_ERROR);
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
    // The public body must report a generic detail — never the raw driver error,
    // which carries the DB host/IP/port (information disclosure on a public,
    // unauthenticated endpoint).
    expect(report.checks.db.detail).toBe("database unreachable");
    expect(JSON.stringify(report)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(report)).not.toContain("10.0.0.5");
    expect(JSON.stringify(report)).not.toContain("6543");
    // The cron check is skipped (not run against a dead DB) but still reported.
    expect(report.checks.cron.ok).toBe(false);
    expect(healthHttpStatus(report)).toBe(503);
    // The body still carries build info so a monitor can record which deploy failed.
    expect(report.build.version).toEqual(expect.any(String));
  });

  it("does not leak the raw driver error when the cron check throws", async () => {
    // A DB that answers `select 1` but fails the cron query — exercises the
    // checkCron catch path independently of checkDb.
    const cronDownDb = {
      execute: async () => undefined,
      query: {
        jobLogs: {
          findFirst: async () => {
            throw new Error(RAW_DRIVER_ERROR);
          },
        },
      },
    } as unknown as Db;
    const report = await checkHealth({ db: cronDownDb, heartbeat: null });
    expect(report.checks.db.ok).toBe(true);
    expect(report.checks.cron.ok).toBe(false);
    expect(report.checks.cron.detail).toBe("cron check failed");
    expect(JSON.stringify(report)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(report)).not.toContain("10.0.0.5");
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

  it("reports per-check durations so a slow dependency is identifiable", async () => {
    const db = await testDb();
    await seedCronRun(db, 60_000);
    const report = await checkHealth({ db, heartbeat: null });
    expect(report.checks.db.durationMs).toEqual(expect.any(Number));
    expect(report.checks.cron.durationMs).toEqual(expect.any(Number));
  });
});

// The failure mode that caused the production incident: a connection that is
// "established" but whose queries never resolve and never reject (a half-open
// socket after a serverless instance thaws). statement_timeout is server-side so
// it never fires, and postgres.js has no client-side query timeout — without a
// deadline here the probe returns NO RESPONSE AT ALL and the monitor records a
// TTFB timeout, indistinguishable from the app being down.
describe("checkHealth against a wedged connection", () => {
  const hangForever = () => new Promise<never>(() => {});

  const wedgedDb = {
    execute: hangForever,
    query: { jobLogs: { findFirst: hangForever } },
  } as unknown as Db;

  it("returns 503 fast instead of hanging when the db check never settles", async () => {
    const started = Date.now();
    const report = await checkHealth({ db: wedgedDb, heartbeat: null, dbTimeoutMs: 50 });

    expect(report.status).toBe("unhealthy");
    expect(healthHttpStatus(report)).toBe(503);
    expect(report.checks.db.detail).toBe("database check timed out");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("discards the wedged pool so the next request doesn't inherit it", async () => {
    let wedgedCalls = 0;
    await checkHealth({
      db: wedgedDb,
      heartbeat: null,
      dbTimeoutMs: 50,
      onDbWedged: () => {
        wedgedCalls++;
      },
    });
    expect(wedgedCalls).toBe(1);
  });

  it("degrades (200) when only the cron query is wedged, and drops the pool", async () => {
    const cronWedgedDb = {
      execute: async () => undefined,
      query: { jobLogs: { findFirst: hangForever } },
    } as unknown as Db;

    let wedgedCalls = 0;
    const report = await checkHealth({
      db: cronWedgedDb,
      heartbeat: null,
      cronTimeoutMs: 50,
      onDbWedged: () => {
        wedgedCalls++;
      },
    });

    expect(report.checks.db.ok).toBe(true);
    expect(report.checks.cron.ok).toBe(false);
    expect(report.checks.cron.detail).toBe("cron check timed out");
    expect(healthHttpStatus(report)).toBe(200); // the tier still serves
    expect(wedgedCalls).toBe(1);
  });

  it("does not leak the internal timedOut marker into the public body", async () => {
    const report = await checkHealth({ db: wedgedDb, heartbeat: null, dbTimeoutMs: 50 });
    expect(JSON.stringify(report)).not.toContain("timedOut");
  });

  it("leaves onDbWedged alone when the connection is refused rather than wedged", async () => {
    let wedgedCalls = 0;
    const report = await checkHealth({
      db: downDb,
      heartbeat: null,
      onDbWedged: () => {
        wedgedCalls++;
      },
    });
    // A refused connection already failed fast; there is no stuck pool to discard.
    expect(report.checks.db.detail).toBe("database unreachable");
    expect(wedgedCalls).toBe(0);
  });
});

describe("withDeadline", () => {
  it("passes through a value that settles in time", async () => {
    await expect(withDeadline(Promise.resolve("done"), 1000, "x")).resolves.toBe("done");
  });

  it("propagates the original rejection rather than masking it as a deadline", async () => {
    const boom = Promise.reject(new Error("boom"));
    await expect(withDeadline(boom, 1000, "x")).rejects.toThrow("boom");
    await expect(withDeadline(Promise.reject(new Error("boom2")), 1000, "x")).rejects.not.toThrow(
      /deadline/,
    );
  });

  it("rejects with a DeadlineError once the ceiling passes", async () => {
    const never = new Promise<never>(() => {});
    const err = await withDeadline(never, 20, "slow thing").catch((e: unknown) => e);
    expect(isDeadlineError(err)).toBe(true);
    expect((err as Error).message).toContain("slow thing");
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
