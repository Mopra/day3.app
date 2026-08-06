import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import type { Account } from "../src/db/schema";
import { subscribers, suppressionEntries } from "../src/db/schema";
import {
  addSuppression,
  addSuppressions,
  countAccountSuppressed,
  findGlobalSuppression,
  getSuppressedEmails,
  listAccountSuppressions,
} from "../src/services/suppression";
import { seedAccount, seedAudience, seedSubscribers, testDb } from "./helpers";

// The suppression list is the one thing in the product with no bulk undo over the
// API — un-suppression lives only in the app, so these tests pin the semantics the
// UI promises: it clears the block, it lets delivery-failed contacts be mailed
// again, it never resurrects someone who unsubscribed themselves, it can't touch a
// platform-wide entry, and it can't reach across tenants.

let currentDb: Db;
let currentAccount: Account;

vi.mock("../src/api/context", () => ({
  requireAccount: async () => ({ db: currentDb, account: currentAccount }),
}));

const listRoute = await import("../app/api/suppressions/route");
const entryRoute = await import("../app/api/suppressions/[email]/route");

async function del(email: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await entryRoute.DELETE(new Request("https://x", { method: "DELETE" }) as never, {
    params: Promise.resolve({ email: encodeURIComponent(email) }),
  } as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function list(query = ""): Promise<Record<string, never>> {
  const url = `https://x/api/suppressions?${query}`;
  const req = new Request(url);
  // The handler reads req.nextUrl.searchParams; a plain Request needs it grafted on.
  Object.defineProperty(req, "nextUrl", { value: new URL(url) });
  const res = await listRoute.GET(req as never, {} as never);
  return (await res.json()) as Record<string, never>;
}

beforeEach(async () => {
  currentDb = await testDb();
  currentAccount = await seedAccount(currentDb);
});

describe("addSuppressions (shared by the app and POST /v1/suppressions)", () => {
  it("canonicalizes, dedupes in-payload, and counts invalid separately", async () => {
    const result = await addSuppressions(currentDb, {
      accountId: currentAccount.id,
      emails: ["Bounced@Example.com", "bounced@example.com", "nope", "other@example.com"],
      reason: "hard_bounce",
      source: "app",
    });

    expect(result).toEqual({ added: 2, alreadySuppressed: 0, invalid: 1 });
    const rows = await currentDb.select().from(suppressionEntries);
    expect(rows.map((r) => r.email).sort()).toEqual(["bounced@example.com", "other@example.com"]);
  });

  it("counts an already-suppressed address instead of duplicating it", async () => {
    const input = {
      accountId: currentAccount.id,
      emails: ["a@example.com"],
      reason: "hard_bounce" as const,
      source: "app",
    };
    await addSuppressions(currentDb, input);
    const second = await addSuppressions(currentDb, input);

    expect(second).toEqual({ added: 0, alreadySuppressed: 1, invalid: 0 });
    expect(await countAccountSuppressed(currentDb, currentAccount.id)).toBe(1);
  });

  it("blocks the address for sending, whatever the reason", async () => {
    await addSuppressions(currentDb, {
      accountId: currentAccount.id,
      emails: ["gone@example.com"],
      reason: "complaint",
      source: "app",
    });
    const suppressed = await getSuppressedEmails(currentDb, currentAccount.id, [
      "gone@example.com",
    ]);
    expect(suppressed.has("gone@example.com")).toBe(true);
  });
});

describe("un-suppressing (DELETE /api/suppressions/{email})", () => {
  it("removes every reason held against the address, not just one", async () => {
    // The unique index is (account, email, reason), so one address can carry
    // several entries; a half-removal would leave it silently still blocked.
    for (const reason of ["hard_bounce", "complaint", "manual"] as const) {
      await addSuppression(currentDb, {
        accountId: currentAccount.id,
        email: "many@example.com",
        reason,
      });
    }

    const res = await del("many@example.com");
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(3);

    const suppressed = await getSuppressedEmails(currentDb, currentAccount.id, [
      "many@example.com",
    ]);
    expect(suppressed.has("many@example.com")).toBe(false);
  });

  it("matches a mixed-case address against the canonical stored form", async () => {
    await addSuppression(currentDb, {
      accountId: currentAccount.id,
      email: "mixed.case@example.com",
      reason: "hard_bounce",
    });

    const res = await del("Mixed.Case@Example.com");
    expect(res.status).toBe(200);
    expect(await countAccountSuppressed(currentDb, currentAccount.id)).toBe(0);
  });

  it("makes bounced and complained contacts mailable again", async () => {
    const audience = await seedAudience(currentDb, currentAccount.id);
    await seedSubscribers(currentDb, currentAccount.id, audience.id, ["b@example.com"], "bounced");
    await addSuppression(currentDb, {
      accountId: currentAccount.id,
      email: "b@example.com",
      reason: "hard_bounce",
    });

    const res = await del("b@example.com");
    expect(res.body.restoredContacts).toBe(1);

    const row = await currentDb.query.subscribers.findFirst({
      where: eq(subscribers.email, "b@example.com"),
    });
    expect(row?.status).toBe("subscribed");
  });

  it("never resubscribes someone who unsubscribed themselves", async () => {
    const audience = await seedAudience(currentDb, currentAccount.id);
    await seedSubscribers(
      currentDb,
      currentAccount.id,
      audience.id,
      ["left@example.com"],
      "unsubscribed",
    );
    await addSuppression(currentDb, {
      accountId: currentAccount.id,
      email: "left@example.com",
      reason: "unsubscribe",
    });

    const res = await del("left@example.com");
    // The block is gone (so an import could re-add them, and they can sign up
    // again) but their own choice stands until they reverse it.
    expect(res.body.removed).toBe(1);
    expect(res.body.restoredContacts).toBe(0);
    const row = await currentDb.query.subscribers.findFirst({
      where: eq(subscribers.email, "left@example.com"),
    });
    expect(row?.status).toBe("unsubscribed");
  });

  it("refuses to lift a platform-wide entry, and says why", async () => {
    await addSuppression(currentDb, {
      accountId: null,
      email: "global@example.com",
      reason: "complaint",
      scope: "global",
    });

    const res = await del("global@example.com");
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toContain("platform-wide");
    // Still suppressed for the account, which is the whole point.
    const suppressed = await getSuppressedEmails(currentDb, currentAccount.id, [
      "global@example.com",
    ]);
    expect(suppressed.has("global@example.com")).toBe(true);
  });

  it("404s on an address this account never suppressed", async () => {
    expect((await del("stranger@example.com")).status).toBe(404);
  });

  it("cannot reach another account's entry", async () => {
    const other = await seedAccount(currentDb, { name: "Other Co" });
    await addSuppression(currentDb, {
      accountId: other.id,
      email: "theirs@example.com",
      reason: "hard_bounce",
    });

    expect((await del("theirs@example.com")).status).toBe(404);
    expect(await countAccountSuppressed(currentDb, other.id)).toBe(1);
  });
});

describe("listing suppressions", () => {
  it("lists only this account's entries", async () => {
    const other = await seedAccount(currentDb, { name: "Other Co" });
    await addSuppression(currentDb, {
      accountId: currentAccount.id,
      email: "mine@example.com",
      reason: "hard_bounce",
    });
    await addSuppression(currentDb, {
      accountId: other.id,
      email: "theirs@example.com",
      reason: "hard_bounce",
    });

    const { rows, total } = await listAccountSuppressions(currentDb, currentAccount.id, {
      limit: 50,
      offset: 0,
    });
    expect(total).toBe(1);
    expect(rows[0].email).toBe("mine@example.com");
  });

  it("filters by reason and searches by substring", async () => {
    await addSuppression(currentDb, {
      accountId: currentAccount.id,
      email: "bounce@acme.com",
      reason: "hard_bounce",
    });
    await addSuppression(currentDb, {
      accountId: currentAccount.id,
      email: "spam@other.com",
      reason: "complaint",
    });

    const byReason = await listAccountSuppressions(currentDb, currentAccount.id, {
      reason: "complaint",
      limit: 50,
      offset: 0,
    });
    expect(byReason.rows.map((r) => r.email)).toEqual(["spam@other.com"]);

    const bySearch = await listAccountSuppressions(currentDb, currentAccount.id, {
      search: "ACME",
      limit: 50,
      offset: 0,
    });
    expect(bySearch.rows.map((r) => r.email)).toEqual(["bounce@acme.com"]);
  });

  it("never enumerates global entries, but reports one for an exact address", async () => {
    // Listing every global entry to a tenant would leak addresses that opted out
    // at other accounts; an exact-address hit only tells them what they typed.
    await addSuppression(currentDb, {
      accountId: null,
      email: "elsewhere@example.com",
      reason: "complaint",
      scope: "global",
    });

    const all = await list("");
    expect(all.suppressions).toHaveLength(0);
    expect(all.globalEntry).toBeNull();

    const searched = await list("search=elsewhere%40example.com");
    expect(searched.suppressions).toHaveLength(0);
    expect(searched.globalEntry).toMatchObject({ email: "elsewhere@example.com" });

    expect(await findGlobalSuppression(currentDb, "elsewhere@example.com")).not.toBeNull();
  });
});

describe("POST /api/suppressions", () => {
  it("adds a pasted list and reports the blast radius", async () => {
    const res = await listRoute.POST(
      new Request("https://x", {
        method: "POST",
        body: JSON.stringify({
          emails: ["one@example.com", "two@example.com", "junk"],
          reason: "hard_bounce",
        }),
      }) as never,
      {} as never,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      added: 2,
      alreadySuppressed: 0,
      invalid: 1,
      totalSuppressedBefore: 0,
      totalSuppressedAfter: 2,
    });
  });

  it("rejects a payload with nothing usable in it", async () => {
    const res = await listRoute.POST(
      new Request("https://x", {
        method: "POST",
        body: JSON.stringify({ emails: ["junk", "also junk"], reason: "manual" }),
      }) as never,
      {} as never,
    );
    expect(res.status).toBe(400);
  });
});
