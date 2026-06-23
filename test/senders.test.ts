import { beforeEach, describe, expect, it, vi } from "vitest";
import { campaigns, senders } from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { Account } from "../src/db/schema";
import { seedAccount, seedAudience, seedDomain, seedSender, testDb } from "./helpers";

// Drive the sender/domain/campaign route handlers directly against a hermetic
// pglite DB. requireAccount is the only seam we replace; the rate limiter is
// stubbed for the campaign-create path.
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

const sendersRoute = await import("../app/api/senders/route");
const senderItemRoute = await import("../app/api/senders/[id]/route");
const domainsRoute = await import("../app/api/domains/route");
const campaignsRoute = await import("../app/api/campaigns/route");

function jsonReq(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/senders", () => {
  let domainId: string;

  beforeEach(async () => {
    currentDb = await testDb();
    currentAccount = await seedAccount(currentDb);
    const domain = await seedDomain(currentDb, currentAccount.id, {
      domain: "news.acme.com",
      fromName: null,
      fromEmail: null,
    });
    domainId = domain.id;
  });

  it("rejects a from address that isn't on the selected domain", async () => {
    const res = await sendersRoute.POST(
      jsonReq("http://localhost/api/senders", "POST", {
        sendingDomainId: domainId,
        fromName: "Jane",
        fromEmail: "jane@other.com",
      }) as never,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/selected sending domain/i);
  });

  it("rejects a domain that belongs to another account", async () => {
    const other = await seedAccount(currentDb);
    const otherDomain = await seedDomain(currentDb, other.id, { domain: "news.evil.com" });
    const res = await sendersRoute.POST(
      jsonReq("http://localhost/api/senders", "POST", {
        sendingDomainId: otherDomain.id,
        fromName: "Jane",
        fromEmail: "jane@news.evil.com",
      }) as never,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/not found/i);
  });

  it("creates the account's first sender as default", async () => {
    const res = await sendersRoute.POST(
      jsonReq("http://localhost/api/senders", "POST", {
        sendingDomainId: domainId,
        fromName: "Jane from Acme",
        fromEmail: "jane@news.acme.com",
      }) as never,
    );
    expect(res.status).toBe(201);
    const { sender } = (await res.json()) as { sender: { id: string; isDefault: boolean } };
    expect(sender.isDefault).toBe(true);

    // A second sender on the same account is not default.
    const res2 = await sendersRoute.POST(
      jsonReq("http://localhost/api/senders", "POST", {
        sendingDomainId: domainId,
        fromName: "Support",
        fromEmail: "support@news.acme.com",
      }) as never,
    );
    const { sender: sender2 } = (await res2.json()) as { sender: { isDefault: boolean } };
    expect(sender2.isDefault).toBe(false);
  });

  it("rejects a duplicate from address with 409", async () => {
    await seedSender(currentDb, currentAccount.id, domainId, { fromEmail: "jane@news.acme.com" });
    const res = await sendersRoute.POST(
      jsonReq("http://localhost/api/senders", "POST", {
        sendingDomainId: domainId,
        fromName: "Jane again",
        fromEmail: "jane@news.acme.com",
      }) as never,
    );
    expect(res.status).toBe(409);
  });
});

describe("GET /api/senders", () => {
  it("returns senders joined with their domain + verification state", async () => {
    currentDb = await testDb();
    currentAccount = await seedAccount(currentDb);
    const domain = await seedDomain(currentDb, currentAccount.id, {
      domain: "news.acme.com",
      verificationStatus: "verified",
    });
    await seedSender(currentDb, currentAccount.id, domain.id, {
      fromEmail: "jane@news.acme.com",
    });

    const res = await sendersRoute.GET(new Request("http://localhost/api/senders") as never, {} as never);
    const { senders: rows } = (await res.json()) as {
      senders: { fromEmail: string; domain: string; verificationStatus: string }[];
    };
    expect(rows).toHaveLength(1);
    expect(rows[0].domain).toBe("news.acme.com");
    expect(rows[0].verificationStatus).toBe("verified");
  });
});

describe("PATCH /api/senders/[id] make default", () => {
  it("promotes one sender to default and demotes the rest", async () => {
    currentDb = await testDb();
    currentAccount = await seedAccount(currentDb);
    const domain = await seedDomain(currentDb, currentAccount.id, { domain: "news.acme.com" });
    const a = await seedSender(currentDb, currentAccount.id, domain.id, {
      fromEmail: "a@news.acme.com",
      isDefault: true,
    });
    const b = await seedSender(currentDb, currentAccount.id, domain.id, {
      fromEmail: "b@news.acme.com",
    });

    const res = await senderItemRoute.PATCH(
      jsonReq(`http://localhost/api/senders/${b.id}`, "PATCH", {
        sendingDomainId: domain.id,
        fromName: b.fromName,
        fromEmail: b.fromEmail,
        isDefault: true,
      }) as never,
      { params: Promise.resolve({ id: b.id }) },
    );
    expect(res.status).toBe(200);

    const rows = await currentDb.select().from(senders);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.isDefault]));
    expect(byId[b.id]).toBe(true);
    expect(byId[a.id]).toBe(false);
  });
});

describe("DELETE /api/senders/[id]", () => {
  it("removes the sender", async () => {
    currentDb = await testDb();
    currentAccount = await seedAccount(currentDb);
    const domain = await seedDomain(currentDb, currentAccount.id, { domain: "news.acme.com" });
    const s = await seedSender(currentDb, currentAccount.id, domain.id, {
      fromEmail: "jane@news.acme.com",
    });
    const res = await senderItemRoute.DELETE(
      new Request(`http://localhost/api/senders/${s.id}`, { method: "DELETE" }) as never,
      { params: Promise.resolve({ id: s.id }) },
    );
    expect(res.status).toBe(200);
    const rows = await currentDb.select().from(senders);
    expect(rows).toHaveLength(0);
  });
});

describe("adding a domain auto-creates a default sender", () => {
  it("creates a sender from the domain's From identity", async () => {
    currentDb = await testDb();
    currentAccount = await seedAccount(currentDb);

    const res = await domainsRoute.POST(
      jsonReq("http://localhost/api/domains", "POST", {
        domain: "news.acme.com",
        fromName: "Jane from Acme",
        fromEmail: "jane@news.acme.com",
      }) as never,
    );
    expect(res.status).toBe(201);

    const rows = await currentDb.select().from(senders);
    expect(rows).toHaveLength(1);
    expect(rows[0].fromEmail).toBe("jane@news.acme.com");
    expect(rows[0].isDefault).toBe(true);
  });
});

describe("campaign create persists the chosen sender", () => {
  it("stores senderId alongside the From snapshot", async () => {
    currentDb = await testDb();
    currentAccount = await seedAccount(currentDb);
    const domain = await seedDomain(currentDb, currentAccount.id, {
      domain: "news.acme.com",
      verificationStatus: "verified",
    });
    const audience = await seedAudience(currentDb, currentAccount.id);
    const sender = await seedSender(currentDb, currentAccount.id, domain.id, {
      fromEmail: "jane@news.acme.com",
      fromName: "Jane from Acme",
    });

    const res = await campaignsRoute.POST(
      jsonReq("http://localhost/api/campaigns", "POST", {
        name: "June update",
        subject: "What's new",
        audienceId: audience.id,
        sendingDomainId: domain.id,
        senderId: sender.id,
        fromName: sender.fromName,
        fromEmail: sender.fromEmail,
        htmlBody: "<p>Hi {{first_name}}</p>",
      }) as never,
    );
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const [row] = await currentDb.select().from(campaigns);
    expect(row.id).toBe(id);
    expect(row.senderId).toBe(sender.id);
    expect(row.fromEmail).toBe("jane@news.acme.com");
  });
});
