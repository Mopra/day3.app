// Platform-wide domain bans, and the two rules that make a ban stick: a banned
// name cannot be added to any account, and a paused account cannot release its
// domains. Both learned from the same afternoon: an attacker deleted two
// lookalike domains from his paused accounts, re-verified them on a fresh org,
// and was sending again within the hour.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { blockedDomains, sendingDomains } from "../src/db/schema";
import { blockDomain, isDomainBlocked } from "../src/services/blocked-domains";
import { sharedDomainSendError, BLOCKED_DOMAIN_MESSAGE } from "../src/services/shared-domain";
import { seedAccount, seedDomain, testDb } from "./helpers";

let currentDb: Db;
let currentAccountId: string;

vi.mock("../src/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/client")>();
  return { ...actual, getDb: () => currentDb };
});
// requireAccount resolves the tenant from Clerk; point it at the seeded account.
vi.mock("../src/api/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/context")>();
  return {
    ...actual,
    requireAccount: async () => {
      const account = await currentDb.query.accounts.findFirst({
        where: (t, { eq }) => eq(t.id, currentAccountId),
      });
      return {
        db: currentDb,
        account,
        auth: { userId: "user_test", orgId: "org_test", orgRole: "org:admin" },
        userId: "user_test",
        userEmail: "t@example.com",
      };
    },
  };
});
vi.mock("../src/services/ses-identity", () => ({
  createDomainIdentity: async () => {
    throw new Error("no SES in tests");
  },
}));

const domainsRoute = await import("../app/api/domains/route");
const apiKeysRoute = await import("../app/api/api-keys/route");
const domainItemRoute = await import("../app/api/domains/[id]/route");

function req(url: string, method: string, body?: unknown): Request {
  const r = new Request(url, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  Object.defineProperty(r, "nextUrl", { value: new URL(url) });
  return r;
}

beforeEach(async () => {
  currentDb = await testDb();
});

describe("blockDomain", () => {
  it("records the ban and stamps every row holding the name", async () => {
    const a = await seedAccount(currentDb);
    const b = await seedAccount(currentDb);
    await seedDomain(currentDb, a.id, { domain: "evil.example" , fromEmail: "x@evil.example" });
    await seedDomain(currentDb, b.id, { domain: "evil.example", fromEmail: "y@evil.example" });

    const result = await blockDomain(currentDb, {
      domain: "Evil.Example.",
      reason: "phishing",
      sourceAccountId: a.id,
      createdBy: "ops@day3.app",
    });
    expect(result.domain).toBe("evil.example");
    expect(result.rowsStamped).toBe(2);
    expect(await isDomainBlocked(currentDb, "evil.example")).toBe(true);

    const rows = await currentDb
      .select()
      .from(sendingDomains)
      .where(eq(sendingDomains.domain, "evil.example"));
    expect(rows.every((r) => r.blockedAt !== null)).toBe(true);
  });

  it("is idempotent", async () => {
    await blockDomain(currentDb, { domain: "x.example", reason: "a", createdBy: "ops" });
    await blockDomain(currentDb, { domain: "x.example", reason: "b", createdBy: "ops" });
    const rows = await currentDb.select().from(blockedDomains);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe("a");
  });
});

describe("the one send gate refuses a banned row", () => {
  it("outranks the shared-domain rules", () => {
    // A stamped row is refused whether or not it is the shared domain, and
    // whether or not the send is sandbox. This is the check every send door
    // already makes, so a ban needs no per-door wiring.
    const banned = { shared: false, sharedDisabledAt: null, blockedAt: "2026-09-22T00:00:00Z" };
    expect(sharedDomainSendError(banned, { sandbox: false })).toBe(BLOCKED_DOMAIN_MESSAGE);
    expect(sharedDomainSendError(banned, { sandbox: true })).toBe(BLOCKED_DOMAIN_MESSAGE);
    const clean = { shared: false, sharedDisabledAt: null, blockedAt: null };
    expect(sharedDomainSendError(clean, { sandbox: false })).toBeNull();
  });
});

describe("POST /api/domains", () => {
  it("refuses a banned name even when nobody holds it", async () => {
    const account = await seedAccount(currentDb);
    currentAccountId = account.id;
    await blockDomain(currentDb, { domain: "globalcitiys.com", reason: "phishing", createdBy: "ops" });

    const res = await domainsRoute.POST(
      req("http://localhost/api/domains", "POST", {
        domain: "globalcitiys.com",
        fromName: "Hot Doc",
        fromEmail: "news@globalcitiys.com",
      }) as never,
      {} as never,
    );
    expect(res.status).toBe(403);
    const rows = await currentDb
      .select()
      .from(sendingDomains)
      .where(eq(sendingDomains.domain, "globalcitiys.com"));
    expect(rows).toHaveLength(0);
  });

  it("still lets a clean name through", async () => {
    const account = await seedAccount(currentDb);
    currentAccountId = account.id;
    const res = await domainsRoute.POST(
      req("http://localhost/api/domains", "POST", {
        domain: "news.honest.example",
        fromName: "Honest",
        fromEmail: "hi@news.honest.example",
      }) as never,
      {} as never,
    );
    expect(res.status).toBe(201);
  });
});

describe("DELETE /api/domains/[id]", () => {
  it("refuses to release a domain from a paused account", async () => {
    const account = await seedAccount(currentDb, { riskStatus: "paused", sendingEnabled: false });
    currentAccountId = account.id;
    const domain = await seedDomain(currentDb, account.id);

    const res = await domainItemRoute.DELETE(
      req("http://localhost/api/domains/" + domain.id, "DELETE") as never,
      { params: Promise.resolve({ id: domain.id }) } as never,
    );
    expect(res.status).toBe(403);
    const still = await currentDb.query.sendingDomains.findFirst({
      where: eq(sendingDomains.id, domain.id),
    });
    expect(still).toBeTruthy();
  });

  it("refuses to delete a banned row on a normal account", async () => {
    const account = await seedAccount(currentDb);
    currentAccountId = account.id;
    const domain = await seedDomain(currentDb, account.id, { blockedAt: "2026-09-22T00:00:00Z" });
    const res = await domainItemRoute.DELETE(
      req("http://localhost/api/domains/" + domain.id, "DELETE") as never,
      { params: Promise.resolve({ id: domain.id }) } as never,
    );
    expect(res.status).toBe(403);
  });

  it("lets a normal account delete a clean domain", async () => {
    const account = await seedAccount(currentDb);
    currentAccountId = account.id;
    const domain = await seedDomain(currentDb, account.id);
    const res = await domainItemRoute.DELETE(
      req("http://localhost/api/domains/" + domain.id, "DELETE") as never,
      { params: Promise.resolve({ id: domain.id }) } as never,
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/api-keys", () => {
  it("refuses to mint a key on a paused account", async () => {
    // The morning after his first two accounts were paused, the operator
    // minted a fresh key on one of them and kept calling the API. A paused
    // account has no legitimate use for a new credential.
    const account = await seedAccount(currentDb, { riskStatus: "paused", sendingEnabled: false });
    currentAccountId = account.id;
    const res = await apiKeysRoute.POST(
      req("http://localhost/api/api-keys", "POST", { name: "aa" }) as never,
      {} as never,
    );
    expect(res.status).toBe(403);
  });

  it("still mints a key on a normal account", async () => {
    const account = await seedAccount(currentDb);
    currentAccountId = account.id;
    const res = await apiKeysRoute.POST(
      req("http://localhost/api/api-keys", "POST", { name: "ci" }) as never,
      {} as never,
    );
    expect(res.status).toBe(201);
  });
});
