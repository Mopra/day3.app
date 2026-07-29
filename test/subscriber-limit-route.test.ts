import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client";
import type { Account } from "../src/db/schema";
import { seedAccount, seedAudience, seedSubscribers, testDb } from "./helpers";

// GET /api/account/subscriber-limit — the number behind the API keys page's
// "your plan holds N more contacts" warning, and behind the same figure baked
// into the AI migration prompt. It has to match what the write path actually
// enforces (all rows, every status, whole account), or the warning is worse
// than none: it would send someone into a migration that fails at batch one.

let currentDb: Db;
let currentAccount: Account;

vi.mock("../src/api/context", () => ({
  requireAccount: async () => ({ db: currentDb, account: currentAccount }),
}));

const limitRoute = await import("../app/api/account/subscriber-limit/route");

async function get(): Promise<Record<string, unknown>> {
  const res = await limitRoute.GET(new Request("https://x") as never, {} as never);
  return (await res.json()) as Record<string, unknown>;
}

const emails = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => `${prefix}${i}@acme.com`);

beforeEach(async () => {
  currentDb = await testDb();
});

describe("subscriber limit endpoint", () => {
  it("reports headroom on a capped plan", async () => {
    currentAccount = await seedAccount(currentDb, { plan: "free_org" });
    const audience = await seedAudience(currentDb, currentAccount.id);
    await seedSubscribers(currentDb, currentAccount.id, audience.id, emails(3, "a"));

    expect(await get()).toMatchObject({ plan: "free_org", cap: 500, used: 3, headroom: 497 });
  });

  it("counts unsubscribed rows too — the cap is about stored rows, not sendable ones", async () => {
    currentAccount = await seedAccount(currentDb, { plan: "free_org" });
    const audience = await seedAudience(currentDb, currentAccount.id);
    await seedSubscribers(currentDb, currentAccount.id, audience.id, emails(2, "b"), "unsubscribed");

    expect(await get()).toMatchObject({ used: 2, headroom: 498 });
  });

  it("counts across every audience in the account", async () => {
    currentAccount = await seedAccount(currentDb, { plan: "free_org" });
    const first = await seedAudience(currentDb, currentAccount.id);
    const second = await seedAudience(currentDb, currentAccount.id);
    await seedSubscribers(currentDb, currentAccount.id, first.id, emails(2, "c"));
    await seedSubscribers(currentDb, currentAccount.id, second.id, emails(3, "d"));

    expect(await get()).toMatchObject({ used: 5 });
  });

  it("ignores another account's subscribers", async () => {
    const other = await seedAccount(currentDb, { plan: "free_org" });
    const otherAudience = await seedAudience(currentDb, other.id);
    await seedSubscribers(currentDb, other.id, otherAudience.id, emails(4, "e"));

    currentAccount = await seedAccount(currentDb, { plan: "free_org" });
    expect(await get()).toMatchObject({ used: 0, headroom: 500 });
  });

  it("says nothing to count on an uncapped plan", async () => {
    currentAccount = await seedAccount(currentDb, { plan: "10k_plan" });
    expect(await get()).toMatchObject({ cap: null, used: null, headroom: null });
  });
});
