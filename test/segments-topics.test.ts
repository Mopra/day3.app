import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  campaignRecipients,
  campaigns,
  segments,
  subscribers,
  suppressionEntries,
  topics,
  topicSubscriptions,
} from "../src/db/schema";
import type { Db } from "../src/db/client";
import type { Account, Audience, Subscriber } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import { segmentFilterCondition, type SegmentFilter } from "../src/lib/segment-filter";
import { generateCampaignRecipients } from "../src/queue/handlers/generate-recipients";
import { setTopicSubscription } from "../src/services/topic-subscription";
import { signUnsubscribeToken } from "../src/services/unsubscribe";
import {
  FakeQueue,
  seedAccount,
  seedAudience,
  seedCampaign,
  seedDomain,
  seedSubscribers,
  testDb,
} from "./helpers";

// The account-scoped routes resolve their tenant via requireAccount; the public
// unsubscribe route resolves its DB via getDb. Both seams are replaced here.
let currentDb: Db;
let currentAccount: Account;

vi.mock("../src/api/context", () => ({
  requireAccount: async () => ({
    db: currentDb,
    account: currentAccount,
    auth: { userId: "user_test", orgId: "org_test", has: () => true },
  }),
}));
vi.mock("../src/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/rate-limit")>();
  return { ...actual, enforceRateLimit: async () => {} };
});
vi.mock("../src/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/client")>();
  return { ...actual, getDb: () => currentDb };
});

const SECRET = "test-unsubscribe-secret-0123456789abcdef";
process.env.UNSUBSCRIBE_SECRET = SECRET;

const segmentsRoute = await import("../app/api/audiences/[id]/segments/route");
const segmentItemRoute = await import("../app/api/audiences/[id]/segments/[segmentId]/route");
const previewRoute = await import("../app/api/audiences/[id]/segments/preview/route");
const topicsRoute = await import("../app/api/audiences/[id]/topics/route");
const subscriberTopicsRoute = await import("../app/api/subscribers/[id]/topics/route");
const publicUnsubscribeRoute = await import("../app/api/public/unsubscribe/route");

function jsonReq(url: string, method: string, body: unknown): Request {
  const req = new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  Object.defineProperty(req, "nextUrl", { value: new URL(url) });
  return req;
}

function bareReq(url: string, method = "GET"): Request {
  const req = new Request(url, { method });
  Object.defineProperty(req, "nextUrl", { value: new URL(url) });
  return req;
}

function params(id: string, extra: Record<string, string> = {}) {
  return { params: Promise.resolve({ id, ...extra }) } as never;
}

let audience: Audience;

beforeEach(async () => {
  currentDb = await testDb();
  currentAccount = await seedAccount(currentDb);
  audience = await seedAudience(currentDb, currentAccount.id);
});

async function setAttributes(sub: Subscriber, attributes: Record<string, string>) {
  await currentDb.update(subscribers).set({ attributes }).where(eq(subscribers.id, sub.id));
}

async function matchingEmails(filter: SegmentFilter): Promise<string[]> {
  const rows = await currentDb
    .select({ email: subscribers.email })
    .from(subscribers)
    .where(and(eq(subscribers.audienceId, audience.id), segmentFilterCondition(filter)));
  return rows.map((r) => r.email).sort();
}

describe("segmentFilterCondition", () => {
  beforeEach(async () => {
    const [alice, bob, carol, dave] = await seedSubscribers(
      currentDb,
      currentAccount.id,
      audience.id,
      ["alice@example.com", "bob@example.com", "carol@example.com", "dave@example.com"],
    );
    await setAttributes(alice, { plan: "Pro", seats: "12", company: "50% off deals" });
    await setAttributes(bob, { plan: "free", seats: "3", company: "500 units co" });
    await setAttributes(dave, { plan: "pro plus", seats: "lots" });
    void carol; // no attributes at all
  });

  it("equals is case-insensitive; not_equals includes contacts missing the field", async () => {
    expect(
      await matchingEmails({ match: "all", conditions: [{ field: "plan", op: "equals", value: "pro" }] }),
    ).toEqual(["alice@example.com"]);
    expect(
      await matchingEmails({
        match: "all",
        conditions: [{ field: "plan", op: "not_equals", value: "pro" }],
      }),
    ).toEqual(["bob@example.com", "carol@example.com", "dave@example.com"]);
  });

  it("contains works on built-ins and attributes; LIKE wildcards are escaped", async () => {
    expect(
      await matchingEmails({
        match: "all",
        conditions: [{ field: "email", op: "contains", value: "bob@" }],
      }),
    ).toEqual(["bob@example.com"]);
    expect(
      await matchingEmails({ match: "all", conditions: [{ field: "plan", op: "contains", value: "pro" }] }),
    ).toEqual(["alice@example.com", "dave@example.com"]);
    // "50%" must match the literal string, not act as a wildcard (which would
    // also match "500 units co").
    expect(
      await matchingEmails({
        match: "all",
        conditions: [{ field: "company", op: "contains", value: "50%" }],
      }),
    ).toEqual(["alice@example.com"]);
  });

  it("is_set / is_not_set treat missing attributes as empty", async () => {
    expect(
      await matchingEmails({ match: "all", conditions: [{ field: "plan", op: "is_set" }] }),
    ).toEqual(["alice@example.com", "bob@example.com", "dave@example.com"]);
    expect(
      await matchingEmails({ match: "all", conditions: [{ field: "plan", op: "is_not_set" }] }),
    ).toEqual(["carol@example.com"]);
  });

  it("greater_than compares numerically and skips non-numeric values", async () => {
    // dave's seats is "lots" — must not match (and must not error the query).
    expect(
      await matchingEmails({
        match: "all",
        conditions: [{ field: "seats", op: "greater_than", value: "5" }],
      }),
    ).toEqual(["alice@example.com"]);
  });

  it("match any ORs the conditions", async () => {
    expect(
      await matchingEmails({
        match: "any",
        conditions: [
          { field: "plan", op: "equals", value: "free" },
          { field: "seats", op: "greater_than", value: "5" },
        ],
      }),
    ).toEqual(["alice@example.com", "bob@example.com"]);
  });
});

describe("segments API", () => {
  beforeEach(async () => {
    const [alice, bob] = await seedSubscribers(currentDb, currentAccount.id, audience.id, [
      "alice@example.com",
      "bob@example.com",
    ]);
    await setAttributes(alice, { plan: "pro" });
    await setAttributes(bob, { plan: "free" });
  });

  const proFilter: SegmentFilter = {
    match: "all",
    conditions: [{ field: "plan", op: "equals", value: "pro" }],
  };

  it("creates a segment with a live count and lists it", async () => {
    const res = await segmentsRoute.POST(
      jsonReq(`http://localhost/api/audiences/${audience.id}/segments`, "POST", {
        name: "Pro customers",
        filter: proFilter,
      }) as never,
      params(audience.id),
    );
    expect(res.status).toBe(201);
    const { segment } = (await res.json()) as { segment: { id: string; count: number } };
    expect(segment.count).toBe(1);

    const listRes = await segmentsRoute.GET(
      bareReq(`http://localhost/api/audiences/${audience.id}/segments`) as never,
      params(audience.id),
    );
    const { segments: rows } = (await listRes.json()) as {
      segments: { name: string; count: number }[];
    };
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Pro customers", count: 1 });
  });

  it("previews a filter's match count without saving", async () => {
    const res = await previewRoute.POST(
      jsonReq(`http://localhost/api/audiences/${audience.id}/segments/preview`, "POST", {
        filter: { match: "all", conditions: [{ field: "plan", op: "is_set" }] },
      }) as never,
      params(audience.id),
    );
    const { count } = (await res.json()) as { count: number };
    expect(count).toBe(2);
  });

  it("rejects an invalid filter (missing value)", async () => {
    const res = await segmentsRoute.POST(
      jsonReq(`http://localhost/api/audiences/${audience.id}/segments`, "POST", {
        name: "Broken",
        filter: { match: "all", conditions: [{ field: "plan", op: "equals", value: "" }] },
      }) as never,
      params(audience.id),
    );
    expect(res.status).toBe(400);
  });

  it("blocks deletion while a scheduled campaign targets the segment, then clears drafts", async () => {
    const domain = await seedDomain(currentDb, currentAccount.id);
    const created = await segmentsRoute.POST(
      jsonReq(`http://localhost/api/audiences/${audience.id}/segments`, "POST", {
        name: "Pro",
        filter: proFilter,
      }) as never,
      params(audience.id),
    );
    const { segment } = (await created.json()) as { segment: { id: string } };

    const scheduled = await seedCampaign(currentDb, {
      accountId: currentAccount.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "scheduled",
    });
    await currentDb
      .update(campaigns)
      .set({ segmentId: segment.id })
      .where(eq(campaigns.id, scheduled.id));

    const blocked = await segmentItemRoute.DELETE(
      bareReq(
        `http://localhost/api/audiences/${audience.id}/segments/${segment.id}`,
        "DELETE",
      ) as never,
      params(audience.id, { segmentId: segment.id }),
    );
    expect(blocked.status).toBe(409);

    // Once the campaign is no longer in flight, deletion clears its reference.
    await currentDb
      .update(campaigns)
      .set({ status: "draft" })
      .where(eq(campaigns.id, scheduled.id));
    const ok = await segmentItemRoute.DELETE(
      bareReq(
        `http://localhost/api/audiences/${audience.id}/segments/${segment.id}`,
        "DELETE",
      ) as never,
      params(audience.id, { segmentId: segment.id }),
    );
    expect(ok.status).toBe(200);
    const fresh = await currentDb.query.campaigns.findFirst({
      where: eq(campaigns.id, scheduled.id),
    });
    expect(fresh?.segmentId).toBeNull();
  });

  it("404s for another account's audience", async () => {
    const other = await seedAccount(currentDb);
    const otherAudience = await seedAudience(currentDb, other.id);
    const res = await segmentsRoute.GET(
      bareReq(`http://localhost/api/audiences/${otherAudience.id}/segments`) as never,
      params(otherAudience.id),
    );
    expect(res.status).toBe(404);
  });
});

describe("topics API + subscriber preferences", () => {
  it("creates a topic and resolves subscriber preferences (default vs override)", async () => {
    const [alice] = await seedSubscribers(currentDb, currentAccount.id, audience.id, [
      "alice@example.com",
    ]);

    const created = await topicsRoute.POST(
      jsonReq(`http://localhost/api/audiences/${audience.id}/topics`, "POST", {
        name: "Product updates",
        description: "Ship notes",
      }) as never,
      params(audience.id),
    );
    expect(created.status).toBe(201);
    const { topic } = (await created.json()) as { topic: { id: string } };

    // Default: subscribed (opt-out model), no explicit row.
    let res = await subscriberTopicsRoute.GET(
      bareReq(`http://localhost/api/subscribers/${alice.id}/topics`) as never,
      params(alice.id),
    );
    let body = (await res.json()) as { topics: { id: string; subscribed: boolean }[] };
    expect(body.topics).toEqual([
      expect.objectContaining({ id: topic.id, subscribed: true }),
    ]);

    // Explicit opt-out via the edit dialog's PATCH.
    const patchRes = await subscriberTopicsRoute.PATCH(
      jsonReq(`http://localhost/api/subscribers/${alice.id}/topics`, "PATCH", {
        subscriptions: { [topic.id]: false },
      }) as never,
      params(alice.id),
    );
    expect(patchRes.status).toBe(200);

    res = await subscriberTopicsRoute.GET(
      bareReq(`http://localhost/api/subscribers/${alice.id}/topics`) as never,
      params(alice.id),
    );
    body = (await res.json()) as { topics: { id: string; subscribed: boolean }[] };
    expect(body.topics[0].subscribed).toBe(false);

    // The topics list surfaces the opt-out count.
    const listRes = await topicsRoute.GET(
      bareReq(`http://localhost/api/audiences/${audience.id}/topics`) as never,
      params(audience.id),
    );
    const list = (await listRes.json()) as { topics: { optedOut: number }[] };
    expect(list.topics[0].optedOut).toBe(1);
  });

  it("rejects a topic from another audience in the subscriber PATCH", async () => {
    const [alice] = await seedSubscribers(currentDb, currentAccount.id, audience.id, [
      "alice@example.com",
    ]);
    const otherAudience = await seedAudience(currentDb, currentAccount.id);
    const now = nowIso();
    const foreignTopicId = newId("top");
    await currentDb.insert(topics).values({
      id: foreignTopicId,
      accountId: currentAccount.id,
      audienceId: otherAudience.id,
      name: "Elsewhere",
      createdAt: now,
      updatedAt: now,
    });

    const res = await subscriberTopicsRoute.PATCH(
      jsonReq(`http://localhost/api/subscribers/${alice.id}/topics`, "PATCH", {
        subscriptions: { [foreignTopicId]: false },
      }) as never,
      params(alice.id),
    );
    expect(res.status).toBe(400);
  });
});

describe("recipient generation with segment/topic scope", () => {
  let domainId: string;
  let alice: Subscriber;
  let bob: Subscriber;
  let carol: Subscriber;

  beforeEach(async () => {
    const domain = await seedDomain(currentDb, currentAccount.id);
    domainId = domain.id;
    [alice, bob, carol] = await seedSubscribers(currentDb, currentAccount.id, audience.id, [
      "alice@example.com",
      "bob@example.com",
      "carol@example.com",
    ]);
    await setAttributes(alice, { plan: "pro" });
    await setAttributes(bob, { plan: "free" });
  });

  async function approvedCampaign(overrides: { segmentId?: string; topicId?: string }) {
    const campaign = await seedCampaign(currentDb, {
      accountId: currentAccount.id,
      audienceId: audience.id,
      sendingDomainId: domainId,
      status: "approved",
    });
    await currentDb.update(campaigns).set(overrides).where(eq(campaigns.id, campaign.id));
    return campaign;
  }

  async function recipientEmails(campaignId: string): Promise<string[]> {
    const rows = await currentDb
      .select({ email: campaignRecipients.email })
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaignId));
    return rows.map((r) => r.email).sort();
  }

  it("a segment narrows recipients to matching subscribers", async () => {
    const now = nowIso();
    const segmentId = newId("seg");
    await currentDb.insert(segments).values({
      id: segmentId,
      accountId: currentAccount.id,
      audienceId: audience.id,
      name: "Pro",
      filterJson: JSON.stringify({
        match: "all",
        conditions: [{ field: "plan", op: "equals", value: "pro" }],
      }),
      createdAt: now,
      updatedAt: now,
    });
    const campaign = await approvedCampaign({ segmentId });

    await generateCampaignRecipients(
      { campaignId: campaign.id, accountId: currentAccount.id },
      currentDb,
      new FakeQueue(),
    );

    expect(await recipientEmails(campaign.id)).toEqual(["alice@example.com"]);
    const fresh = await currentDb.query.campaigns.findFirst({
      where: eq(campaigns.id, campaign.id),
    });
    expect(fresh?.status).toBe("sending");
  });

  it("an opt-out topic excludes subscribers who left it", async () => {
    const now = nowIso();
    const topicId = newId("top");
    await currentDb.insert(topics).values({
      id: topicId,
      accountId: currentAccount.id,
      audienceId: audience.id,
      name: "Promotions",
      defaultSubscribed: true,
      createdAt: now,
      updatedAt: now,
    });
    await setTopicSubscription(currentDb, {
      accountId: currentAccount.id,
      topicId,
      subscriberId: bob.id,
      subscribed: false,
    });
    const campaign = await approvedCampaign({ topicId });

    await generateCampaignRecipients(
      { campaignId: campaign.id, accountId: currentAccount.id },
      currentDb,
      new FakeQueue(),
    );

    expect(await recipientEmails(campaign.id)).toEqual([
      "alice@example.com",
      "carol@example.com",
    ]);
  });

  it("an opt-in topic includes only subscribers who joined", async () => {
    const now = nowIso();
    const topicId = newId("top");
    await currentDb.insert(topics).values({
      id: topicId,
      accountId: currentAccount.id,
      audienceId: audience.id,
      name: "Beta news",
      defaultSubscribed: false,
      createdAt: now,
      updatedAt: now,
    });
    await setTopicSubscription(currentDb, {
      accountId: currentAccount.id,
      topicId,
      subscriberId: carol.id,
      subscribed: true,
    });
    const campaign = await approvedCampaign({ topicId });

    await generateCampaignRecipients(
      { campaignId: campaign.id, accountId: currentAccount.id },
      currentDb,
      new FakeQueue(),
    );

    expect(await recipientEmails(campaign.id)).toEqual(["carol@example.com"]);
  });

  it("pauses (never widens) a campaign whose segment vanished", async () => {
    const campaign = await approvedCampaign({ segmentId: "seg_gone" });

    await generateCampaignRecipients(
      { campaignId: campaign.id, accountId: currentAccount.id },
      currentDb,
      new FakeQueue(),
    );

    expect(await recipientEmails(campaign.id)).toEqual([]);
    const fresh = await currentDb.query.campaigns.findFirst({
      where: eq(campaigns.id, campaign.id),
    });
    expect(fresh?.status).toBe("paused");
    expect(fresh?.pausedCode).toBe("user");
    expect(fresh?.pausedReason).toMatch(/segment/i);
  });
});

describe("topic-scoped unsubscribe", () => {
  it("offers the topic on GET and opts out only that topic on POST", async () => {
    const domain = await seedDomain(currentDb, currentAccount.id);
    const [alice] = await seedSubscribers(currentDb, currentAccount.id, audience.id, [
      "alice@example.com",
    ]);
    const now = nowIso();
    const topicId = newId("top");
    await currentDb.insert(topics).values({
      id: topicId,
      accountId: currentAccount.id,
      audienceId: audience.id,
      name: "Promotions",
      defaultSubscribed: true,
      createdAt: now,
      updatedAt: now,
    });
    const campaign = await seedCampaign(currentDb, {
      accountId: currentAccount.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "sent",
    });
    await currentDb.update(campaigns).set({ topicId }).where(eq(campaigns.id, campaign.id));

    const token = await signUnsubscribeToken(
      {
        accountId: currentAccount.id,
        subscriberId: alice.id,
        email: alice.email,
        campaignId: campaign.id,
      },
      SECRET,
    );

    const getRes = await publicUnsubscribeRoute.GET(
      bareReq(`http://localhost/api/public/unsubscribe?token=${encodeURIComponent(token)}`) as never,
      {} as never,
    );
    const getBody = (await getRes.json()) as { topic: { id: string; name: string } | null };
    expect(getBody.topic).toMatchObject({ id: topicId, name: "Promotions" });

    const postRes = await publicUnsubscribeRoute.POST(
      jsonReq("http://localhost/api/public/unsubscribe", "POST", {
        token,
        scope: "topic",
      }) as never,
      {} as never,
    );
    expect(postRes.status).toBe(200);
    const postBody = (await postRes.json()) as { scope: string; topicName: string };
    expect(postBody).toMatchObject({ scope: "topic", topicName: "Promotions" });

    // The topic is opted out; the subscriber is otherwise untouched (still
    // subscribed, NOT suppressed).
    const sub = await currentDb.query.subscribers.findFirst({
      where: eq(subscribers.id, alice.id),
    });
    expect(sub?.status).toBe("subscribed");
    const suppression = await currentDb.query.suppressionEntries.findFirst({
      where: eq(suppressionEntries.email, alice.email),
    });
    expect(suppression).toBeUndefined();
    const override = await currentDb.query.topicSubscriptions.findFirst({
      where: and(
        eq(topicSubscriptions.topicId, topicId),
        eq(topicSubscriptions.subscriberId, alice.id),
      ),
    });
    expect(override?.subscribed).toBe(false);
  });

  it("scope=all still performs the full unsubscribe", async () => {
    const [alice] = await seedSubscribers(currentDb, currentAccount.id, audience.id, [
      "alice@example.com",
    ]);
    const token = await signUnsubscribeToken(
      { accountId: currentAccount.id, subscriberId: alice.id, email: alice.email },
      SECRET,
    );
    const res = await publicUnsubscribeRoute.POST(
      jsonReq("http://localhost/api/public/unsubscribe", "POST", { token, scope: "all" }) as never,
      {} as never,
    );
    expect(res.status).toBe(200);
    const sub = await currentDb.query.subscribers.findFirst({
      where: eq(subscribers.id, alice.id),
    });
    expect(sub?.status).toBe("unsubscribed");
  });

  it("409s a topic-scope request when the campaign has no topic", async () => {
    const domain = await seedDomain(currentDb, currentAccount.id);
    const [alice] = await seedSubscribers(currentDb, currentAccount.id, audience.id, [
      "alice@example.com",
    ]);
    const campaign = await seedCampaign(currentDb, {
      accountId: currentAccount.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "sent",
    });
    const token = await signUnsubscribeToken(
      {
        accountId: currentAccount.id,
        subscriberId: alice.id,
        email: alice.email,
        campaignId: campaign.id,
      },
      SECRET,
    );
    const res = await publicUnsubscribeRoute.POST(
      jsonReq("http://localhost/api/public/unsubscribe", "POST", { token, scope: "topic" }) as never,
      {} as never,
    );
    expect(res.status).toBe(409);
  });
});
