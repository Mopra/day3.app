import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  campaignRecipients,
  emailEvents,
  subscribers,
  suppressionEntries,
} from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import type { Db } from "../src/db/client";
import {
  seedAccount,
  seedAudience,
  seedCampaign,
  seedDomain,
  seedSubscribers,
  testDb,
} from "./helpers";

// The route resolves its DB via the process-wide getDb() singleton and validates
// the SNS signature via sns-payload-validator. Both are seams we replace here so
// the handler runs against the hermetic pglite DB with a pre-validated payload.
let currentDb: Db;
vi.mock("../src/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/client")>();
  return { ...actual, getDb: () => currentDb };
});

// validator.validate(rawBody) returns the parsed SNS envelope. We bypass the
// real signature check and hand back whatever we pass in as the request body.
vi.mock("sns-payload-validator", () => ({
  default: class {
    async validate(raw: string) {
      return JSON.parse(raw);
    }
  },
}));

// Imported after the mocks above are registered.
const { POST } = await import("../app/api/webhooks/ses/route");

const MESSAGE_ID = "0100000000000000-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-000000";

function snsNotification(message: Record<string, unknown>) {
  return {
    Type: "Notification",
    MessageId: "sns-msg-1",
    TopicArn: "arn:aws:sns:eu-west-1:123456789012:ses-events",
    Message: JSON.stringify(message),
  };
}

function bouncePayload(email: string) {
  return {
    eventType: "Bounce",
    mail: { messageId: MESSAGE_ID, destination: [email] },
    bounce: {
      bounceType: "Permanent",
      bounceSubType: "General",
      bouncedRecipients: [{ emailAddress: email }],
    },
  };
}

function post(envelope: unknown): Promise<Response> {
  const req = new Request("http://localhost/api/webhooks/ses", {
    method: "POST",
    body: JSON.stringify(envelope),
  });
  // The route signature is (NextRequest); a standard Request satisfies the only
  // method it uses (req.text()).
  return POST(req as never);
}

async function seedSentRecipient(db: Db, email: string) {
  const account = await seedAccount(db);
  const domain = await seedDomain(db, account.id);
  const audience = await seedAudience(db, account.id);
  const [subscriber] = await seedSubscribers(db, account.id, audience.id, [email]);
  const campaign = await seedCampaign(db, {
    accountId: account.id,
    audienceId: audience.id,
    sendingDomainId: domain.id,
    status: "sent",
  });
  const now = nowIso();
  const recipientId = newId("rcp");
  await db.insert(campaignRecipients).values({
    id: recipientId,
    campaignId: campaign.id,
    accountId: account.id,
    subscriberId: subscriber.id,
    email,
    status: "sent",
    provider: "ses",
    providerMessageId: MESSAGE_ID,
    sentAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return { account, recipientId, subscriberId: subscriber.id };
}

describe("SES/SNS webhook idempotency", () => {
  beforeEach(async () => {
    currentDb = await testDb();
  });

  it("processes a hard bounce: one event, suppression, recipient bounced", async () => {
    const email = "bouncer@example.com";
    const { account, recipientId, subscriberId } = await seedSentRecipient(currentDb, email);

    const res = await post(snsNotification(bouncePayload(email)));
    expect(res.status).toBe(200);

    const events = await currentDb.select().from(emailEvents);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("bounce");

    const sup = await currentDb
      .select()
      .from(suppressionEntries)
      .where(eq(suppressionEntries.email, email));
    expect(sup).toHaveLength(1);
    expect(sup[0].reason).toBe("hard_bounce");
    expect(sup[0].accountId).toBe(account.id);

    const rec = await currentDb.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.id, recipientId),
    });
    expect(rec?.status).toBe("bounced");

    const sub = await currentDb.query.subscribers.findFirst({
      where: eq(subscribers.id, subscriberId),
    });
    expect(sub?.status).toBe("bounced");
  });

  it("is idempotent under SNS at-least-once redelivery (same bounce twice)", async () => {
    const email = "bouncer@example.com";
    const { recipientId } = await seedSentRecipient(currentDb, email);

    const envelope = snsNotification(bouncePayload(email));

    // First delivery.
    expect((await post(envelope)).status).toBe(200);
    // Re-delivery of the identical validated notification.
    expect((await post(envelope)).status).toBe(200);

    // Exactly one event row — the unique (providerMessageId, eventType) index +
    // onConflictDoNothing collapse the duplicate.
    const events = await currentDb.select().from(emailEvents);
    expect(events).toHaveLength(1);

    // Exactly one suppression entry — suppression is not double-applied.
    const sup = await currentDb
      .select()
      .from(suppressionEntries)
      .where(eq(suppressionEntries.email, email));
    expect(sup).toHaveLength(1);

    const rec = await currentDb.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.id, recipientId),
    });
    expect(rec?.status).toBe("bounced");
  });
});
