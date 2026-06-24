import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  signOpenToken,
  verifyOpenToken,
  recordOpen,
  openTrackingUrl,
  signClickToken,
  verifyClickToken,
  recordClick,
  clickTrackingUrl,
} from "../src/services/open-tracking";
import { renderCampaignEmail, extractTrackableLinks } from "../src/services/render";
import { campaignRecipients, emailEvents } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import type { Db } from "../src/db/client";
import { seedAccount, testDb } from "./helpers";

const SECRET = "test-secret-key-1234567890";

function payloadFor(accountId: string, recipientId: string) {
  return {
    accountId,
    campaignId: "cmp_1",
    campaignRecipientId: recipientId,
    email: "alice@example.com",
  };
}

async function insertRecipient(
  db: Db,
  accountId: string,
  overrides: Partial<typeof campaignRecipients.$inferInsert> = {},
): Promise<string> {
  const id = newId("rcp");
  const now = nowIso();
  await db.insert(campaignRecipients).values({
    id,
    campaignId: "cmp_1",
    accountId,
    email: "alice@example.com",
    status: "sent",
    sentAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return id;
}

describe("open-tracking tokens", () => {
  it("round-trips a valid token and stamps an iat", async () => {
    const payload = payloadFor("acc_1", "rcp_1");
    const token = await signOpenToken(payload, SECRET);
    const verified = await verifyOpenToken(token, SECRET);
    expect(verified).toMatchObject(payload);
    expect(typeof verified?.iat).toBe("number");
  });

  it("rejects tampered, wrong-secret, and garbage tokens", async () => {
    const token = await signOpenToken(payloadFor("a", "r"), SECRET);
    expect(await verifyOpenToken(token + "x", SECRET)).toBeNull();
    expect(await verifyOpenToken(token, "different-secret-abc")).toBeNull();
    expect(await verifyOpenToken("garbage", SECRET)).toBeNull();
    expect(await verifyOpenToken("", SECRET)).toBeNull();
  });

  it("rejects an over-age token", async () => {
    const oldIat = Math.floor(Date.now() / 1000) - 10 * 24 * 60 * 60; // 10 days ago
    const token = await signOpenToken({ ...payloadFor("a", "r"), iat: oldIat }, SECRET);
    expect(await verifyOpenToken(token, SECRET)).toBeTruthy();
    expect(await verifyOpenToken(token, SECRET, 24 * 60 * 60)).toBeNull();
  });

  it("builds an absolute pixel URL with the token in the query", () => {
    const url = openTrackingUrl("https://go.day3.app/", "abc.def");
    expect(url).toBe("https://go.day3.app/api/track/open?t=abc.def");
  });
});

describe("recordOpen", () => {
  it("stamps opened_at once and records a single open event", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const recipientId = await insertRecipient(db, account.id);

    await recordOpen(db, payloadFor(account.id, recipientId));

    const fresh = await db.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.id, recipientId),
    });
    expect(fresh?.openedAt).toBeTruthy();

    const events = await db.query.emailEvents.findMany({
      where: eq(emailEvents.campaignRecipientId, recipientId),
    });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("open");
  });

  it("is idempotent — repeat loads never inflate the count", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const recipientId = await insertRecipient(db, account.id);

    await recordOpen(db, payloadFor(account.id, recipientId));
    const first = await db.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.id, recipientId),
    });
    await recordOpen(db, payloadFor(account.id, recipientId));
    await recordOpen(db, payloadFor(account.id, recipientId));

    const events = await db.query.emailEvents.findMany({
      where: eq(emailEvents.campaignRecipientId, recipientId),
    });
    expect(events).toHaveLength(1);
    // opened_at is not bumped on later loads (first-open semantics).
    const after = await db.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.id, recipientId),
    });
    expect(after?.openedAt).toBe(first?.openedAt);
  });

  it("does nothing for an unknown recipient", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await recordOpen(db, payloadFor(account.id, "rcp_does_not_exist"));
    const events = await db.query.emailEvents.findMany({});
    expect(events).toHaveLength(0);
  });

  it("won't record an open for a recipient in another account (account-scoped)", async () => {
    const db = await testDb();
    const owner = await seedAccount(db);
    const other = await seedAccount(db);
    const recipientId = await insertRecipient(db, owner.id);

    // Token claims the other account but names the owner's recipient id.
    await recordOpen(db, payloadFor(other.id, recipientId));

    const fresh = await db.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.id, recipientId),
    });
    expect(fresh?.openedAt).toBeNull();
    const events = await db.query.emailEvents.findMany({});
    expect(events).toHaveLength(0);
  });
});

function clickPayloadFor(accountId: string, recipientId: string, url = "https://example.com/post") {
  return {
    accountId,
    campaignId: "cmp_1",
    campaignRecipientId: recipientId,
    email: "alice@example.com",
    url,
  };
}

describe("click-tracking tokens", () => {
  it("round-trips a valid token carrying the destination URL", async () => {
    const payload = clickPayloadFor("acc_1", "rcp_1");
    const token = await signClickToken(payload, SECRET);
    const verified = await verifyClickToken(token, SECRET);
    expect(verified).toMatchObject(payload);
    expect(typeof verified?.iat).toBe("number");
  });

  it("rejects tampered, wrong-secret, and garbage tokens", async () => {
    const token = await signClickToken(clickPayloadFor("a", "r"), SECRET);
    expect(await verifyClickToken(token + "x", SECRET)).toBeNull();
    expect(await verifyClickToken(token, "different-secret-abc")).toBeNull();
    expect(await verifyClickToken("garbage", SECRET)).toBeNull();
  });

  it("rejects a token whose destination is not absolute http(s)", async () => {
    for (const url of ["mailto:a@b.co", "javascript:alert(1)", "/relative", "ftp://x.co"]) {
      const token = await signClickToken(clickPayloadFor("a", "r", url), SECRET);
      expect(await verifyClickToken(token, SECRET)).toBeNull();
    }
  });

  it("rejects an over-age token", async () => {
    const oldIat = Math.floor(Date.now() / 1000) - 10 * 24 * 60 * 60;
    const token = await signClickToken({ ...clickPayloadFor("a", "r"), iat: oldIat }, SECRET);
    expect(await verifyClickToken(token, SECRET)).toBeTruthy();
    expect(await verifyClickToken(token, SECRET, 24 * 60 * 60)).toBeNull();
  });

  it("builds an absolute redirect URL with the token in the query", () => {
    expect(clickTrackingUrl("https://go.day3.app/", "abc.def")).toBe(
      "https://go.day3.app/api/track/click?t=abc.def",
    );
  });
});

describe("recordClick", () => {
  it("stamps clicked_at and opened_at once, recording a click and an open event", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const recipientId = await insertRecipient(db, account.id, { openedAt: null });

    await recordClick(db, clickPayloadFor(account.id, recipientId));

    const fresh = await db.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.id, recipientId),
    });
    expect(fresh?.clickedAt).toBeTruthy();
    // A click is proof of an open, so opened_at is back-filled too.
    expect(fresh?.openedAt).toBeTruthy();

    const events = await db.query.emailEvents.findMany({
      where: eq(emailEvents.campaignRecipientId, recipientId),
    });
    expect(events.map((e) => e.eventType).sort()).toEqual(["click", "open"]);
  });

  it("does not re-open or double-count when the recipient already opened", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const recipientId = await insertRecipient(db, account.id);
    await recordOpen(db, payloadFor(account.id, recipientId));

    await recordClick(db, clickPayloadFor(account.id, recipientId));

    const events = await db.query.emailEvents.findMany({
      where: eq(emailEvents.campaignRecipientId, recipientId),
    });
    // The pre-existing open is kept; the click adds exactly one click event.
    expect(events.filter((e) => e.eventType === "open")).toHaveLength(1);
    expect(events.filter((e) => e.eventType === "click")).toHaveLength(1);
  });

  it("is idempotent across repeat clicks", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const recipientId = await insertRecipient(db, account.id);

    await recordClick(db, clickPayloadFor(account.id, recipientId));
    await recordClick(db, clickPayloadFor(account.id, recipientId));
    await recordClick(db, clickPayloadFor(account.id, recipientId));

    const events = await db.query.emailEvents.findMany({
      where: eq(emailEvents.campaignRecipientId, recipientId),
    });
    expect(events.filter((e) => e.eventType === "click")).toHaveLength(1);
  });

  it("won't record a click for a recipient in another account", async () => {
    const db = await testDb();
    const owner = await seedAccount(db);
    const other = await seedAccount(db);
    const recipientId = await insertRecipient(db, owner.id);

    await recordClick(db, clickPayloadFor(other.id, recipientId));

    const fresh = await db.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.id, recipientId),
    });
    expect(fresh?.clickedAt).toBeNull();
    expect(await db.query.emailEvents.findMany({})).toHaveLength(0);
  });
});

describe("link rewriting", () => {
  it("extracts only absolute http(s) content links", () => {
    const body =
      '<p><a href="https://example.com/a">A</a> <a href="http://x.co/b">B</a> ' +
      '<a href="mailto:hi@x.co">mail</a> <a href="/relative">rel</a> <a href="#anchor">anch</a></p>';
    const links = extractTrackableLinks(body).map((l) => l.url).sort();
    expect(links).toEqual(["http://x.co/b", "https://example.com/a"]);
  });

  it("rewrites body links to the tracker but never the unsubscribe link", () => {
    const out = renderCampaignEmail({
      campaign: {
        subject: "Hi",
        htmlBody: '<p>See <a href="https://example.com/post">our post</a></p>',
        textBody: null,
      },
      subscriber: { email: "alice@x.co", firstName: "Alice", lastName: null },
      companyName: "Test Co",
      companyAddress: "1 Main St",
      unsubscribeUrl: "https://app.test/unsubscribe?token=abc",
      linkTracking: { "https://example.com/post": "https://go.day3.app/api/track/click?t=tok" },
    });
    // Content link redirects through the tracker; the original is gone.
    expect(out.html).toContain('href="https://go.day3.app/api/track/click?t=tok"');
    expect(out.html).not.toContain('href="https://example.com/post"');
    // The unsubscribe link is untouched and still works.
    expect(out.html).toContain('href="https://app.test/unsubscribe?token=abc"');
  });

  it("leaves links untouched when no link map is provided", () => {
    const out = renderCampaignEmail({
      campaign: {
        subject: "Hi",
        htmlBody: '<p><a href="https://example.com/post">post</a></p>',
        textBody: null,
      },
      subscriber: { email: "alice@x.co", firstName: "Alice", lastName: null },
      companyName: "Test Co",
      companyAddress: "1 Main St",
      unsubscribeUrl: "https://app.test/unsubscribe?token=abc",
    });
    expect(out.html).toContain('href="https://example.com/post"');
    expect(out.html).not.toContain("track/click");
  });
});

describe("tracking pixel injection", () => {
  const baseInput = {
    campaign: { subject: "Hi", htmlBody: "<p>Hello</p>", textBody: null },
    subscriber: { email: "alice@x.co", firstName: "Alice", lastName: null },
    companyName: "Test Co",
    companyAddress: "1 Main St",
    unsubscribeUrl: "https://app.test/unsubscribe?token=abc",
  };

  it("appends a hidden pixel to the HTML when a tracking URL is provided", () => {
    const url = "https://go.day3.app/api/track/open?t=tok123";
    const out = renderCampaignEmail({ ...baseInput, openTrackingUrl: url });
    expect(out.html).toContain(`src="${url}"`);
    expect(out.html).toContain('width="1" height="1"');
    // The plain-text body never carries a pixel.
    expect(out.text).not.toContain("track/open");
  });

  it("omits the pixel entirely when no tracking URL is given", () => {
    const out = renderCampaignEmail({ ...baseInput, openTrackingUrl: null });
    expect(out.html).not.toContain("track/open");
    expect(out.html).not.toContain('width="1" height="1"');
  });
});
