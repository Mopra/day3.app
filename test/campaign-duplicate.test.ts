import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { campaigns } from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { Account } from "../src/db/schema";
import { nowIso } from "../src/lib/ids";
import { seedAccount, seedAudience, seedCampaign, seedDomain, testDb } from "./helpers";

// Drive the duplicate route handler directly against a hermetic pglite DB.
// requireAccount is the only seam we replace; the rate limiter is stubbed.
let currentDb: Db;
let currentAccount: Account;

vi.mock("../src/api/context", () => ({
  requireAccount: async () => ({
    db: currentDb,
    account: currentAccount,
    auth: { userId: "user_test", orgId: "org_test", has: () => true },
  }),
}));
vi.mock("../src/lib/rate-limit", () => ({ enforceRateLimit: async () => {} }));

const duplicateRoute = await import("../app/api/campaigns/[id]/duplicate/route");

function call(id: string) {
  return duplicateRoute.POST(
    new Request(`http://localhost/api/campaigns/${id}/duplicate`, { method: "POST" }) as never,
    { params: Promise.resolve({ id }) } as never,
  );
}

describe("POST /api/campaigns/[id]/duplicate", () => {
  let audienceId: string;
  let domainId: string;

  beforeEach(async () => {
    currentDb = await testDb();
    currentAccount = await seedAccount(currentDb);
    const audience = await seedAudience(currentDb, currentAccount.id);
    const domain = await seedDomain(currentDb, currentAccount.id);
    audienceId = audience.id;
    domainId = domain.id;
  });

  it("copies a sent campaign into a fresh draft", async () => {
    const source = await seedCampaign(currentDb, {
      accountId: currentAccount.id,
      audienceId,
      sendingDomainId: domainId,
      status: "sent",
      subject: "Launch week recap",
      htmlBody: "<p>Hi {{first_name}}, here's what shipped.</p>",
    });
    // Stamp a send so we can confirm the copy doesn't inherit it.
    await currentDb
      .update(campaigns)
      .set({ sentAt: nowIso(), previewText: "Recap inside" })
      .where(eq(campaigns.id, source.id));

    const res = await call(source.id);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    expect(id).not.toBe(source.id);

    const copy = await currentDb.query.campaigns.findFirst({
      where: (t, { eq }) => eq(t.id, id),
    });
    expect(copy).toBeTruthy();
    expect(copy?.status).toBe("draft");
    expect(copy?.name).toBe("Copy of Test campaign");
    expect(copy?.subject).toBe("Launch week recap");
    expect(copy?.htmlBody).toBe("<p>Hi {{first_name}}, here's what shipped.</p>");
    expect(copy?.previewText).toBe("Recap inside");
    expect(copy?.audienceId).toBe(audienceId);
    expect(copy?.sendingDomainId).toBe(domainId);
    // Send-time state must reset on the copy.
    expect(copy?.sentAt).toBeNull();
    expect(copy?.scheduledAt).toBeNull();

    // The source is left untouched.
    const after = await currentDb.query.campaigns.findFirst({
      where: (t, { eq }) => eq(t.id, source.id),
    });
    expect(after?.status).toBe("sent");
  });

  it("404s for a campaign owned by another account", async () => {
    const other = await seedAccount(currentDb);
    const foreign = await seedCampaign(currentDb, {
      accountId: other.id,
      audienceId,
      sendingDomainId: domainId,
    });
    const res = await call(foreign.id);
    expect(res.status).toBe(404);
  });

  it("404s for an unknown campaign id", async () => {
    const res = await call("cmp_does_not_exist");
    expect(res.status).toBe(404);
  });
});
