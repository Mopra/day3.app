import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { recheckPendingDomains, type DomainIdentityFetcher } from "../src/queue/cron";
import { sendingDomains } from "../src/db/schema";
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
