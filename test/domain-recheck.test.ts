import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  recheckPendingDomains,
  recheckVerifiedDomains,
  type DomainIdentityFetcher,
} from "../src/queue/cron";
import { notifications, sendingDomains } from "../src/db/schema";
import { testDb, seedAccount, seedDomain } from "./helpers";
import type { DomainIdentityState } from "../src/services/ses-identity";

const RECORDS = [
  { type: "CNAME" as const, name: "a._domainkey.updates.test.co", value: "a.dkim.amazonses.com", required: true },
];

function verifiedState(): DomainIdentityState {
  return {
    verified: true,
    verificationStatus: "verified",
    dkimStatus: "success",
    mailFromDomain: "send.updates.test.co",
    mailFromStatus: "success",
    records: RECORDS,
  };
}
function pendingState(): DomainIdentityState {
  return {
    verified: false,
    verificationStatus: "pending",
    dkimStatus: "pending",
    mailFromDomain: "send.updates.test.co",
    mailFromStatus: "pending",
    records: RECORDS,
  };
}

// Records which domains the fetcher was asked about, returning a configured state.
function fakeFetcher(byDomain: Record<string, DomainIdentityState>): DomainIdentityFetcher & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (domain: string) => {
    calls.push(domain);
    return byDomain[domain] ?? pendingState();
  }) as DomainIdentityFetcher & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe("recheckPendingDomains", () => {
  it("flips a pending domain to verified when SES now reports it", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const domain = await seedDomain(db, account.id, {
      domain: "updates.test.co",
      verificationStatus: "pending",
      dkimStatus: "pending",
      dnsRecordsJson: JSON.stringify(RECORDS),
    });

    const fetcher = fakeFetcher({ "updates.test.co": verifiedState() });
    const count = await recheckPendingDomains(db, fetcher);

    expect(count).toBe(1);
    const row = await db.query.sendingDomains.findFirst({ where: eq(sendingDomains.id, domain.id) });
    expect(row?.verificationStatus).toBe("verified");
  });

  it("persists a Return-Path (mailFromStatus) change even when verification is unchanged", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const domain = await seedDomain(db, account.id, {
      domain: "updates.test.co",
      verificationStatus: "pending",
      dkimStatus: "pending",
      mailFromStatus: "pending",
      dnsRecordsJson: JSON.stringify(RECORDS),
    });

    // Same verification/DKIM status, but the custom MAIL FROM has gone live.
    const state: DomainIdentityState = {
      verified: false,
      verificationStatus: "pending",
      dkimStatus: "pending",
      mailFromDomain: "send.updates.test.co",
      mailFromStatus: "success",
      records: RECORDS,
    };
    await recheckPendingDomains(db, fakeFetcher({ "updates.test.co": state }));

    const row = await db.query.sendingDomains.findFirst({ where: eq(sendingDomains.id, domain.id) });
    expect(row?.mailFromStatus).toBe("success");
  });

  it("stamps lastCheckedAt even when nothing moved, so the rotation advances", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const domain = await seedDomain(db, account.id, {
      verificationStatus: "pending",
      dkimStatus: "pending",
      mailFromStatus: "pending",
      dnsRecordsJson: JSON.stringify(RECORDS),
    });

    await recheckPendingDomains(db, fakeFetcher({}));

    const row = await db.query.sendingDomains.findFirst({ where: eq(sendingDomains.id, domain.id) });
    expect(row?.lastCheckedAt).toBeTruthy();
    expect(row?.verificationStatus).toBe("pending"); // and nothing else moved
  });

  it("leaves a still-pending domain unchanged and reports zero", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedDomain(db, account.id, {
      verificationStatus: "pending",
      dnsRecordsJson: JSON.stringify(RECORDS),
    });

    const count = await recheckPendingDomains(db, fakeFetcher({}));
    expect(count).toBe(0);
  });

  it("ignores verified domains and ones without records", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    // already verified (default helper status) — must not be re-checked
    await seedDomain(db, account.id, { domain: "done.test.co" });
    // pending but no records issued yet — must not be re-checked
    await seedDomain(db, account.id, {
      domain: "norecords.test.co",
      verificationStatus: "pending",
      dnsRecordsJson: null,
    });

    const fetcher = fakeFetcher({});
    await recheckPendingDomains(db, fetcher);
    expect(fetcher.calls).toEqual([]); // neither domain qualified
  });

  it("skips domains that have been pending longer than the recheck window", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await seedDomain(db, account.id, {
      domain: "stale.test.co",
      verificationStatus: "pending",
      dnsRecordsJson: JSON.stringify(RECORDS),
      updatedAt: old,
    });

    const fetcher = fakeFetcher({ "stale.test.co": verifiedState() });
    const count = await recheckPendingDomains(db, fetcher);
    expect(fetcher.calls).toEqual([]);
    expect(count).toBe(0);
  });

  it("does nothing when SES is not configured (null fetcher)", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const domain = await seedDomain(db, account.id, {
      verificationStatus: "pending",
      dnsRecordsJson: JSON.stringify(RECORDS),
    });

    const count = await recheckPendingDomains(db, null);
    expect(count).toBe(0);
    const row = await db.query.sendingDomains.findFirst({ where: eq(sendingDomains.id, domain.id) });
    expect(row?.verificationStatus).toBe("pending");
  });

  it("isolates a failing domain and still processes the rest", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedDomain(db, account.id, {
      domain: "boom.test.co",
      verificationStatus: "pending",
      dnsRecordsJson: JSON.stringify(RECORDS),
    });
    await seedDomain(db, account.id, {
      domain: "good.test.co",
      verificationStatus: "pending",
      dnsRecordsJson: JSON.stringify(RECORDS),
    });

    const fetcher = (async (domain: string) => {
      if (domain === "boom.test.co") throw new Error("SES timeout");
      return verifiedState();
    }) as DomainIdentityFetcher;

    const count = await recheckPendingDomains(db, fetcher);
    expect(count).toBe(1); // good.test.co still got verified
  });
});

// The verified pass: the only thing watching a domain after it goes green.
describe("recheckVerifiedDomains", () => {
  // A verified domain whose optional Return-Path is live too, i.e. everything
  // that can regress is currently up.
  async function seedHealthy(db: Awaited<ReturnType<typeof testDb>>, accountId: string, overrides = {}) {
    return seedDomain(db, accountId, {
      domain: "updates.test.co",
      verificationStatus: "verified",
      dkimStatus: "success",
      mailFromDomain: "send.updates.test.co",
      mailFromStatus: "success",
      dnsRecordsJson: JSON.stringify(RECORDS),
      ...overrides,
    });
  }

  async function notificationKinds(db: Awaited<ReturnType<typeof testDb>>, accountId: string) {
    const rows = await db
      .select({ kind: notifications.kind })
      .from(notifications)
      .where(eq(notifications.accountId, accountId));
    return rows.map((r) => r.kind);
  }

  it("records and reports a domain SES has stopped verifying", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const domain = await seedHealthy(db, account.id);

    const lost: DomainIdentityState = {
      verified: false,
      verificationStatus: "failed",
      dkimStatus: "failed",
      mailFromDomain: "send.updates.test.co",
      mailFromStatus: "success",
      records: RECORDS,
    };
    const count = await recheckVerifiedDomains(db, fakeFetcher({ "updates.test.co": lost }));

    expect(count).toBe(1);
    const row = await db.query.sendingDomains.findFirst({ where: eq(sendingDomains.id, domain.id) });
    expect(row?.verificationStatus).toBe("failed");
    expect(await notificationKinds(db, account.id)).toEqual(["domain_verification_lost"]);
  });

  it("reports a Return-Path that was live and has gone away", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const domain = await seedHealthy(db, account.id);

    const revoked: DomainIdentityState = {
      verified: true,
      verificationStatus: "verified",
      dkimStatus: "success",
      mailFromDomain: "send.updates.test.co",
      mailFromStatus: "failed",
      records: RECORDS,
    };
    const count = await recheckVerifiedDomains(db, fakeFetcher({ "updates.test.co": revoked }));

    expect(count).toBe(1);
    const row = await db.query.sendingDomains.findFirst({ where: eq(sendingDomains.id, domain.id) });
    expect(row?.mailFromStatus).toBe("failed");
    expect(row?.verificationStatus).toBe("verified"); // mail still sends
    expect(await notificationKinds(db, account.id)).toEqual(["domain_return_path_lost"]);
  });

  it("stays quiet about a Return-Path that was never live", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedHealthy(db, account.id, { mailFromStatus: "pending" });

    const stillNotUp: DomainIdentityState = {
      verified: true,
      verificationStatus: "verified",
      dkimStatus: "success",
      mailFromDomain: "send.updates.test.co",
      mailFromStatus: "failed",
      records: RECORDS,
    };
    const count = await recheckVerifiedDomains(db, fakeFetcher({ "updates.test.co": stillNotUp }));

    expect(count).toBe(0);
    expect(await notificationKinds(db, account.id)).toEqual([]);
  });

  it("raises the regression once, not on every later sweep", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedHealthy(db, account.id);

    const revoked: DomainIdentityState = {
      verified: true,
      verificationStatus: "verified",
      dkimStatus: "success",
      mailFromDomain: "send.updates.test.co",
      mailFromStatus: "failed",
      records: RECORDS,
    };
    await recheckVerifiedDomains(db, fakeFetcher({ "updates.test.co": revoked }));
    // The row is still verified, so it stays in this pass's population. Force it
    // due again (the interval is what keeps this rare in production) and confirm
    // the second read reports nothing.
    await db.update(sendingDomains).set({ lastCheckedAt: null }).where(eq(sendingDomains.accountId, account.id));
    const second = await recheckVerifiedDomains(db, fakeFetcher({ "updates.test.co": revoked }));

    expect(second).toBe(0);
    expect(await notificationKinds(db, account.id)).toEqual(["domain_return_path_lost"]);
  });

  it("skips admin-overridden domains, where SES is not the truth", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedHealthy(db, account.id, { adminOverrideVerified: true });

    const fetcher = fakeFetcher({});
    await recheckVerifiedDomains(db, fetcher);
    expect(fetcher.calls).toEqual([]);
  });

  it("skips domains read within the recheck interval and stamps the ones it reads", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedHealthy(db, account.id, {
      domain: "fresh.test.co",
      lastCheckedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const due = await seedHealthy(db, account.id, { domain: "due.test.co", lastCheckedAt: null });

    const fetcher = fakeFetcher({});
    await recheckVerifiedDomains(db, fetcher);

    expect(fetcher.calls).toEqual(["due.test.co"]);
    const row = await db.query.sendingDomains.findFirst({ where: eq(sendingDomains.id, due.id) });
    expect(row?.lastCheckedAt).toBeTruthy();
  });

  it("takes the least-recently-checked domains first", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    await seedHealthy(db, account.id, { domain: "b.test.co", lastCheckedAt: hoursAgo(10) });
    await seedHealthy(db, account.id, { domain: "c.test.co", lastCheckedAt: hoursAgo(7) });
    await seedHealthy(db, account.id, { domain: "a.test.co", lastCheckedAt: null });

    const fetcher = fakeFetcher({});
    await recheckVerifiedDomains(db, fetcher);
    expect(fetcher.calls).toEqual(["a.test.co", "b.test.co", "c.test.co"]);
  });

  it("does nothing when SES is not configured (null fetcher)", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedHealthy(db, account.id);
    expect(await recheckVerifiedDomains(db, null)).toBe(0);
  });

  it("isolates a failing domain and still processes the rest", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedHealthy(db, account.id, { domain: "boom.test.co", lastCheckedAt: null });
    await seedHealthy(db, account.id, { domain: "good.test.co", lastCheckedAt: null });

    const fetcher = (async (domain: string) => {
      if (domain === "boom.test.co") throw new Error("SES timeout");
      return {
        verified: false,
        verificationStatus: "failed" as const,
        dkimStatus: "failed",
        mailFromDomain: "send.good.test.co",
        mailFromStatus: "success",
        records: RECORDS,
      };
    }) as DomainIdentityFetcher;

    expect(await recheckVerifiedDomains(db, fetcher)).toBe(1);
  });
});
