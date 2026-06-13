import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../src/worker/services/unsubscribe";
import { api } from "../src/worker/api";
import { subscribers, suppressionEntries } from "../src/worker/db/schema";
import { getSuppressedEmails } from "../src/worker/services/suppression";
import { seedAccount, seedAudience, seedSubscribers, testDb, testEnv } from "./helpers";

const SECRET = "test-secret";

describe("unsubscribe tokens", () => {
  it("round-trips a valid token", async () => {
    const payload = {
      accountId: "acc_1",
      subscriberId: "sub_1",
      email: "alice@example.com",
      campaignId: "cmp_1",
    };
    const token = await signUnsubscribeToken(payload, SECRET);
    expect(await verifyUnsubscribeToken(token, SECRET)).toEqual(payload);
  });

  it("rejects tampered and garbage tokens", async () => {
    const token = await signUnsubscribeToken(
      { accountId: "a", subscriberId: "s", email: "e@x.co" },
      SECRET,
    );
    expect(await verifyUnsubscribeToken(token + "x", SECRET)).toBeNull();
    expect(await verifyUnsubscribeToken(token, "wrong-secret")).toBeNull();
    expect(await verifyUnsubscribeToken("garbage", SECRET)).toBeNull();
    expect(await verifyUnsubscribeToken("", SECRET)).toBeNull();
  });
});

describe("public unsubscribe flow", () => {
  it("unsubscribes the subscriber, adds suppression, and excludes from future sends", async () => {
    const db = testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const [subscriber] = await seedSubscribers(db, account.id, audience.id, [
      "alice@example.com",
    ]);

    const token = await signUnsubscribeToken(
      {
        accountId: account.id,
        subscriberId: subscriber.id,
        email: subscriber.email,
      },
      // The route verifies with env.UNSUBSCRIBE_SECRET from the test env.
      testEnv.UNSUBSCRIBE_SECRET,
    );

    const res = await api.fetch(
      new Request("http://test.local/api/public/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      }),
      testEnv,
    );
    expect(res.status).toBe(200);

    const fresh = await db.query.subscribers.findFirst({
      where: eq(subscribers.id, subscriber.id),
    });
    expect(fresh?.status).toBe("unsubscribed");
    expect(fresh?.unsubscribedAt).toBeTruthy();

    const entry = await db.query.suppressionEntries.findFirst({
      where: eq(suppressionEntries.email, "alice@example.com"),
    });
    expect(entry?.reason).toBe("unsubscribe");

    const suppressed = await getSuppressedEmails(db, account.id, ["alice@example.com"]);
    expect(suppressed.has("alice@example.com")).toBe(true);
  });

  it("rejects an invalid token", async () => {
    const res = await api.fetch(
      new Request("http://test.local/api/public/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "bogus" }),
      }),
      testEnv,
    );
    expect(res.status).toBe(400);
  });
});
