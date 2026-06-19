import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { accounts, campaigns, jobLogs, sendingDomains, suppressionEntries } from "../src/db/schema";
import {
  seedAccount,
  seedAudience,
  seedCampaign,
  seedDomain,
  seedSubscribers,
  testDb,
} from "./helpers";

// Drive the admin route handlers through the REAL requireAdmin gate. We mock only
// the two seams it depends on: getDb (→ hermetic pglite) and @clerk/nextjs/server
// (→ a controllable signed-in user). Everything else — the ADMIN_EMAILS parsing,
// the 403s, the audit writes — runs for real.
let currentDb: Db;
let currentUserId = "user_admin";
let currentEmail: string | null = "admin@day3.app";

vi.mock("../src/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/client")>();
  return { ...actual, getDb: () => currentDb };
});

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: currentUserId, orgId: null, has: () => false }),
  clerkClient: async () => ({
    users: {
      getUser: async (_id: string) => ({
        primaryEmailAddressId: "eml_1",
        emailAddresses: currentEmail
          ? [{ id: "eml_1", emailAddress: currentEmail }]
          : [],
      }),
    },
  }),
}));

vi.mock("../src/queue/producer", () => ({ getQueue: () => ({ send: async () => {} }) }));

function post(url: string, body?: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }) as Request;
}

// Resolve a usable existing target id per route so the "non-admin → 403" sweep
// exercises the gate, not an incidental 404. The gate must fire BEFORE any lookup.
type AdminRoute = {
  path: string;
  importPath: string;
  method: "GET" | "POST";
  // builds (url, params, body) for a request against a real, existing target
  build: () => Promise<{ url: string; params?: Record<string, string>; body?: unknown }>;
};

let seeded: {
  accountId: string;
  domainId: string;
  campaignId: string;
  email: string;
};

async function seedFixtures(db: Db) {
  const account = await seedAccount(db);
  const domain = await seedDomain(db, account.id);
  const audience = await seedAudience(db, account.id);
  const subs = await seedSubscribers(db, account.id, audience.id, ["target@example.com"]);
  const campaign = await seedCampaign(db, {
    accountId: account.id,
    audienceId: audience.id,
    sendingDomainId: domain.id,
    status: "pending_review",
  });
  return {
    accountId: account.id,
    domainId: domain.id,
    campaignId: campaign.id,
    email: subs[0].email,
  };
}

function adminRoutes(): AdminRoute[] {
  return [
    {
      path: "accounts",
      importPath: "../app/api/admin/accounts/route",
      method: "GET",
      build: async () => ({ url: "http://localhost/api/admin/accounts" }),
    },
    {
      path: "overview",
      importPath: "../app/api/admin/overview/route",
      method: "GET",
      build: async () => ({ url: "http://localhost/api/admin/overview" }),
    },
    {
      path: "reviews",
      importPath: "../app/api/admin/reviews/route",
      method: "GET",
      build: async () => ({ url: "http://localhost/api/admin/reviews" }),
    },
    {
      path: "accounts/[id]",
      importPath: "../app/api/admin/accounts/[id]/route",
      method: "GET",
      build: async () => ({
        url: `http://localhost/api/admin/accounts/${seeded.accountId}`,
        params: { id: seeded.accountId },
      }),
    },
    {
      path: "accounts/[id]/domains",
      importPath: "../app/api/admin/accounts/[id]/domains/route",
      method: "GET",
      build: async () => ({
        url: `http://localhost/api/admin/accounts/${seeded.accountId}/domains`,
        params: { id: seeded.accountId },
      }),
    },
    {
      path: "accounts/[id]/pause",
      importPath: "../app/api/admin/accounts/[id]/pause/route",
      method: "POST",
      build: async () => ({
        url: `http://localhost/api/admin/accounts/${seeded.accountId}/pause`,
        params: { id: seeded.accountId },
        body: { reason: "spam" },
      }),
    },
    {
      path: "accounts/[id]/resume",
      importPath: "../app/api/admin/accounts/[id]/resume/route",
      method: "POST",
      build: async () => ({
        url: `http://localhost/api/admin/accounts/${seeded.accountId}/resume`,
        params: { id: seeded.accountId },
      }),
    },
    {
      path: "domains/[id]/override-verify",
      importPath: "../app/api/admin/domains/[id]/override-verify/route",
      method: "POST",
      build: async () => ({
        url: `http://localhost/api/admin/domains/${seeded.domainId}/override-verify`,
        params: { id: seeded.domainId },
      }),
    },
    {
      path: "campaigns/[id]/approve",
      importPath: "../app/api/admin/campaigns/[id]/approve/route",
      method: "POST",
      build: async () => ({
        url: `http://localhost/api/admin/campaigns/${seeded.campaignId}/approve`,
        params: { id: seeded.campaignId },
      }),
    },
    {
      path: "campaigns/[id]/block",
      importPath: "../app/api/admin/campaigns/[id]/block/route",
      method: "POST",
      build: async () => ({
        url: `http://localhost/api/admin/campaigns/${seeded.campaignId}/block`,
        params: { id: seeded.campaignId },
        body: { reason: "abuse" },
      }),
    },
    {
      path: "suppress",
      importPath: "../app/api/admin/suppress/route",
      method: "POST",
      build: async () => ({
        url: "http://localhost/api/admin/suppress",
        body: { email: seeded.email, accountId: seeded.accountId },
      }),
    },
  ];
}

async function callRoute(r: AdminRoute): Promise<Response> {
  const mod = (await import(r.importPath)) as Record<string, unknown>;
  const handler = mod[r.method] as (req: never, ctx: never) => Promise<Response>;
  const { url, params, body } = await r.build();
  const req = r.method === "GET" ? new Request(url) : post(url, body);
  const ctx = params ? { params: Promise.resolve(params) } : ({} as never);
  return handler(req as never, ctx as never);
}

const ROUTES = adminRoutes();

describe("admin route hardening", () => {
  beforeEach(async () => {
    currentDb = await testDb();
    seeded = await seedFixtures(currentDb);
    currentUserId = "user_admin";
    currentEmail = "admin@day3.app";
    process.env.ADMIN_EMAILS = "admin@day3.app";
  });

  afterEach(() => {
    vi.resetModules();
    delete process.env.ADMIN_EMAILS;
  });

  it("covers every route file under app/api/admin", () => {
    const root = join(process.cwd(), "app", "api", "admin");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) walk(full);
        else if (e === "route.ts") files.push(full);
      }
    };
    walk(root);
    expect(files.length).toBe(ROUTES.length);
  });

  describe("non-admin user gets 403 on every admin route", () => {
    for (const r of ROUTES) {
      it(`403 for ${r.method} ${r.path}`, async () => {
        currentEmail = "intruder@evil.com";
        const res = await callRoute(r);
        expect(res.status).toBe(403);
      });
    }
  });

  describe("ADMIN_EMAILS unset → 403 everywhere", () => {
    for (const r of ROUTES) {
      it(`403 for ${r.method} ${r.path} when unconfigured`, async () => {
        delete process.env.ADMIN_EMAILS;
        // even the configured admin email is rejected when the allowlist is empty
        currentEmail = "admin@day3.app";
        const res = await callRoute(r);
        expect(res.status).toBe(403);
      });
    }
  });

  it("admin gate passes for a configured admin (sanity)", async () => {
    const overview = ROUTES.find((r) => r.path === "overview")!;
    const res = await callRoute(overview);
    expect(res.status).toBe(200);
  });

  describe("admin mutations write an audit record (who/what/when/target)", () => {
    it("pause logs admin_action with actor + target", async () => {
      const res = await callRoute(ROUTES.find((r) => r.path === "accounts/[id]/pause")!);
      expect(res.status).toBe(200);
      const rows = await currentDb
        .select()
        .from(jobLogs)
        .where(eq(jobLogs.jobType, "admin_action"));
      expect(rows).toHaveLength(1);
      expect(rows[0].entityType).toBe("account");
      expect(rows[0].entityId).toBe(seeded.accountId);
      const payload = JSON.parse(rows[0].payloadJson!);
      expect(payload.action).toBe("account.pause");
      expect(payload.actorEmail).toBe("admin@day3.app");
      expect(payload.actorUserId).toBe("user_admin");
      expect(rows[0].createdAt).toBeTruthy();
      // and the mutation itself happened
      const acc = await currentDb.query.accounts.findFirst({
        where: eq(accounts.id, seeded.accountId),
      });
      expect(acc!.riskStatus).toBe("paused");
    });

    it("resume logs admin_action", async () => {
      await callRoute(ROUTES.find((r) => r.path === "accounts/[id]/resume")!);
      const rows = await currentDb
        .select()
        .from(jobLogs)
        .where(eq(jobLogs.jobType, "admin_action"));
      expect(rows.map((r) => JSON.parse(r.payloadJson!).action)).toContain("account.resume");
    });

    it("override-verify logs admin_action against the domain", async () => {
      const res = await callRoute(
        ROUTES.find((r) => r.path === "domains/[id]/override-verify")!,
      );
      expect(res.status).toBe(200);
      const rows = await currentDb
        .select()
        .from(jobLogs)
        .where(eq(jobLogs.jobType, "admin_action"));
      expect(rows).toHaveLength(1);
      expect(rows[0].entityType).toBe("sending_domain");
      expect(rows[0].entityId).toBe(seeded.domainId);
      expect(JSON.parse(rows[0].payloadJson!).action).toBe("domain.override_verify");
      const dom = await currentDb.query.sendingDomains.findFirst({
        where: eq(sendingDomains.id, seeded.domainId),
      });
      expect(dom!.adminOverrideVerified).toBe(true);
    });

    it("approve logs admin_action", async () => {
      const res = await callRoute(ROUTES.find((r) => r.path === "campaigns/[id]/approve")!);
      expect(res.status).toBe(200);
      const rows = await currentDb
        .select()
        .from(jobLogs)
        .where(eq(jobLogs.jobType, "admin_action"));
      expect(JSON.parse(rows[0].payloadJson!).action).toBe("campaign.approve");
    });

    it("block logs admin_action", async () => {
      const res = await callRoute(ROUTES.find((r) => r.path === "campaigns/[id]/block")!);
      expect(res.status).toBe(200);
      const rows = await currentDb
        .select()
        .from(jobLogs)
        .where(eq(jobLogs.jobType, "admin_action"));
      expect(rows[0].entityType).toBe("campaign");
      expect(JSON.parse(rows[0].payloadJson!).action).toBe("campaign.block");
      const c = await currentDb.query.campaigns.findFirst({
        where: eq(campaigns.id, seeded.campaignId),
      });
      expect(c!.status).toBe("blocked");
    });

    it("suppress logs admin_action and writes the suppression", async () => {
      const res = await callRoute(ROUTES.find((r) => r.path === "suppress")!);
      expect(res.status).toBe(200);
      const rows = await currentDb
        .select()
        .from(jobLogs)
        .where(eq(jobLogs.jobType, "admin_action"));
      expect(JSON.parse(rows[0].payloadJson!).action).toBe("suppression.add");
      const sup = await currentDb.select().from(suppressionEntries);
      expect(sup).toHaveLength(1);
    });
  });

  describe("targets are looked up explicitly → 404 when missing", () => {
    it("pause unknown account → 404", async () => {
      currentEmail = "admin@day3.app";
      const mod = await import("../app/api/admin/accounts/[id]/pause/route");
      const res = await mod.POST(
        post("http://localhost/x", { reason: "x" }) as never,
        { params: Promise.resolve({ id: "acc_does_not_exist" }) } as never,
      );
      expect(res.status).toBe(404);
    });

    it("override-verify unknown domain → 404", async () => {
      const mod = await import("../app/api/admin/domains/[id]/override-verify/route");
      const res = await mod.POST(
        post("http://localhost/x") as never,
        { params: Promise.resolve({ id: "dom_does_not_exist" }) } as never,
      );
      expect(res.status).toBe(404);
    });

    it("approve unknown campaign → 404", async () => {
      const mod = await import("../app/api/admin/campaigns/[id]/approve/route");
      const res = await mod.POST(
        post("http://localhost/x") as never,
        { params: Promise.resolve({ id: "cmp_does_not_exist" }) } as never,
      );
      expect(res.status).toBe(404);
    });

    it("suppress against unknown account → 404 (no suppression written)", async () => {
      const mod = await import("../app/api/admin/suppress/route");
      const res = await mod.POST(
        post("http://localhost/x", {
          email: "x@example.com",
          accountId: "acc_does_not_exist",
        }) as never,
      );
      expect(res.status).toBe(404);
      const sup = await currentDb.select().from(suppressionEntries);
      expect(sup).toHaveLength(0);
    });
  });

  it("rejects invalid input with 400 (pause requires a reason)", async () => {
    const mod = await import("../app/api/admin/accounts/[id]/pause/route");
    const res = await mod.POST(
      post("http://localhost/x", { reason: "" }) as never,
      { params: Promise.resolve({ id: seeded.accountId }) } as never,
    );
    expect(res.status).toBe(400);
  });
});
