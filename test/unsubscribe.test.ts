import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "../src/services/unsubscribe";
import { applyUnsubscribe } from "../src/services/unsubscribe-action";
import { subscribers, suppressionEntries } from "../src/db/schema";
import { getSuppressedEmails } from "../src/services/suppression";
import { seedAccount, seedAudience, seedSubscribers, testDb } from "./helpers";

const SECRET = "test-secret";

describe("unsubscribe tokens", () => {
  it("round-trips a valid token and stamps an iat", async () => {
    const payload = {
      accountId: "acc_1",
      subscriberId: "sub_1",
      email: "alice@example.com",
      campaignId: "cmp_1",
    };
    const token = await signUnsubscribeToken(payload, SECRET);
    const verified = await verifyUnsubscribeToken(token, SECRET);
    expect(verified).toMatchObject(payload);
    expect(typeof verified?.iat).toBe("number");
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

  it("rejects a tampered payload (signature no longer matches)", async () => {
    const token = await signUnsubscribeToken(
      { accountId: "a", subscriberId: "s", email: "victim@x.co" },
      SECRET,
    );
    const [body, sig] = token.split(".");
    // Re-encode the body with a different victim email but keep the old sig.
    const forged = Buffer.from(
      JSON.stringify({
        accountId: "a",
        subscriberId: "s",
        email: "attacker@x.co",
        iat: Math.floor(Date.now() / 1000),
      }),
    )
      .toString("base64url")
      .replace(/=+$/, "");
    expect(body).not.toBe(forged);
    expect(await verifyUnsubscribeToken(`${forged}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects an over-age token", async () => {
    const oldIat = Math.floor(Date.now() / 1000) - 10 * 24 * 60 * 60; // 10 days ago
    const token = await signUnsubscribeToken(
      { accountId: "a", subscriberId: "s", email: "e@x.co", iat: oldIat },
      SECRET,
    );
    // Generous default still accepts it...
    expect(await verifyUnsubscribeToken(token, SECRET)).toBeTruthy();
    // ...but a tighter max age rejects it as expired.
    expect(await verifyUnsubscribeToken(token, SECRET, 24 * 60 * 60)).toBeNull();
  });

  it("rejects a token with no iat (predates expiry enforcement)", async () => {
    // Forge a validly-signed body that omits iat, mimicking a legacy token.
    const body = new TextEncoder().encode(
      JSON.stringify({ accountId: "a", subscriberId: "s", email: "e@x.co" }),
    );
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
    const enc = (b: Uint8Array) =>
      Buffer.from(b).toString("base64url").replace(/=+$/, "");
    const legacyToken = `${enc(body)}.${enc(sig)}`;
    expect(await verifyUnsubscribeToken(legacyToken, SECRET)).toBeNull();
  });
});

describe("public unsubscribe flow", () => {
  it("unsubscribes the subscriber, adds suppression, and excludes from future sends", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const [subscriber] = await seedSubscribers(db, account.id, audience.id, ["alice@example.com"]);

    // The route verifies the token then runs applyUnsubscribe — exercise the
    // same path the handler does.
    const token = await signUnsubscribeToken(
      { accountId: account.id, subscriberId: subscriber.id, email: subscriber.email },
      SECRET,
    );
    const payload = await verifyUnsubscribeToken(token, SECRET);
    expect(payload).toBeTruthy();
    await applyUnsubscribe(db, payload!);

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
    expect(await verifyUnsubscribeToken("bogus", SECRET)).toBeNull();
  });
});
