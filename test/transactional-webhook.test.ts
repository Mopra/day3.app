import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import {
  emailEvents,
  suppressionEntries,
  transactionalEmails,
} from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import { seedAccount, seedDomain, testDb } from "./helpers";

// Same seams as ses-webhook.test.ts: the process-wide getDb and the SNS
// signature validator. This suite covers the transactional (API-sent) branch —
// messages whose provider id resolves to transactional_emails, not
// campaign_recipients.
let currentDb: Db;
vi.mock("../src/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/client")>();
  return { ...actual, getDb: () => currentDb };
});
vi.mock("sns-payload-validator", () => ({
  default: class {
    async validate(raw: string) {
      return JSON.parse(raw);
    }
  },
}));

const { POST } = await import("../app/api/webhooks/ses/route");

const MESSAGE_ID = "0100000000000000-ffffffff-1111-2222-3333-444444444444-000000";

function post(message: Record<string, unknown>): Promise<Response> {
  const envelope = {
    Type: "Notification",
    MessageId: "sns-msg-tx",
    TopicArn: "arn:aws:sns:eu-west-1:123456789012:ses-events",
    Message: JSON.stringify(message),
  };
  const req = new Request("http://localhost/api/webhooks/ses", {
    method: "POST",
    body: JSON.stringify(envelope),
  });
  return POST(req as never);
}

async function seedSentEmail(db: Db, to: string[]) {
  const account = await seedAccount(db);
  await seedDomain(db, account.id);
  const now = nowIso();
  const id = newId("eml");
  await db.insert(transactionalEmails).values({
    id,
    accountId: account.id,
    fromEmail: "notify@updates.test.co",
    to,
    subject: "Reset your password",
    htmlBody: "<p>hi</p>",
    status: "sent",
    provider: "ses",
    providerMessageId: MESSAGE_ID,
    sentAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return { account, id };
}

beforeEach(async () => {
  currentDb = await testDb();
});

describe("SES webhook — transactional emails", () => {
  it("delivery advances sent → delivered and records one event under redelivery", async () => {
    const { id } = await seedSentEmail(currentDb, ["jane@example.com"]);
    const payload = {
      eventType: "Delivery",
      mail: { messageId: MESSAGE_ID, destination: ["jane@example.com"] },
      delivery: {},
    };

    expect((await post(payload)).status).toBe(200);
    expect((await post(payload)).status).toBe(200); // SNS redelivery

    const row = (await currentDb.query.transactionalEmails.findFirst({
      where: eq(transactionalEmails.id, id),
    }))!;
    expect(row.status).toBe("delivered");
    expect(row.deliveredAt).toBeTruthy();

    const events = await currentDb
      .select()
      .from(emailEvents)
      .where(eq(emailEvents.transactionalEmailId, id));
    expect(events.map((e) => e.eventType)).toEqual(["delivery"]);
  });

  it("a permanent bounce suppresses exactly the bounced address of a multi-recipient send", async () => {
    const { account, id } = await seedSentEmail(currentDb, ["ok@example.com", "dead@example.com"]);

    const res = await post({
      eventType: "Bounce",
      mail: { messageId: MESSAGE_ID, destination: ["dead@example.com"] },
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: "dead@example.com" }],
      },
    });
    expect(res.status).toBe(200);

    const row = (await currentDb.query.transactionalEmails.findFirst({
      where: eq(transactionalEmails.id, id),
    }))!;
    expect(row.status).toBe("bounced");

    const suppressed = await currentDb
      .select()
      .from(suppressionEntries)
      .where(eq(suppressionEntries.accountId, account.id));
    expect(suppressed.map((s) => s.email)).toEqual(["dead@example.com"]);
    expect(suppressed[0].reason).toBe("hard_bounce");
  });

  it("suppresses EVERY bounced recipient of one message — SES sends one notification per address", async () => {
    // The regression this guards: SES emits a separate notification per bounced
    // recipient, all sharing one messageId. Keying dedupe on the message alone
    // (or returning early once the message is already 'bounced') suppressed the
    // first address of fifty and left the other 49 mailable.
    const recipients = ["a@example.com", "b@example.com", "c@example.com"];
    const { account, id } = await seedSentEmail(currentDb, recipients);

    for (const address of recipients) {
      const res = await post({
        eventType: "Bounce",
        mail: { messageId: MESSAGE_ID, destination: [address] },
        bounce: {
          bounceType: "Permanent",
          bouncedRecipients: [{ emailAddress: address }],
        },
      });
      expect(res.status).toBe(200);
    }
    // ...and a redelivery of the first is still a no-op.
    await post({
      eventType: "Bounce",
      mail: { messageId: MESSAGE_ID, destination: [recipients[0]] },
      bounce: {
        bounceType: "Permanent",
        bouncedRecipients: [{ emailAddress: recipients[0] }],
      },
    });

    const suppressed = await currentDb
      .select()
      .from(suppressionEntries)
      .where(eq(suppressionEntries.accountId, account.id));
    expect(suppressed.map((s) => s.email).sort()).toEqual(recipients);

    // One event row per address, none duplicated by the redelivery.
    const events = await currentDb
      .select()
      .from(emailEvents)
      .where(eq(emailEvents.transactionalEmailId, id));
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.email).sort()).toEqual(recipients);
  });

  it("a transient bounce records the event but does not suppress or fail the email", async () => {
    const { account, id } = await seedSentEmail(currentDb, ["full@example.com"]);

    await post({
      eventType: "Bounce",
      mail: { messageId: MESSAGE_ID, destination: ["full@example.com"] },
      bounce: {
        bounceType: "Transient",
        bouncedRecipients: [{ emailAddress: "full@example.com" }],
      },
    });

    const row = (await currentDb.query.transactionalEmails.findFirst({
      where: eq(transactionalEmails.id, id),
    }))!;
    expect(row.status).toBe("sent");

    const suppressed = await currentDb
      .select()
      .from(suppressionEntries)
      .where(eq(suppressionEntries.accountId, account.id));
    expect(suppressed).toHaveLength(0);
  });

  it("a complaint marks the email complained and suppresses the complainant", async () => {
    const { account, id } = await seedSentEmail(currentDb, ["angry@example.com"]);

    await post({
      eventType: "Complaint",
      mail: { messageId: MESSAGE_ID, destination: ["angry@example.com"] },
      complaint: { complainedRecipients: [{ emailAddress: "angry@example.com" }] },
    });

    const row = (await currentDb.query.transactionalEmails.findFirst({
      where: eq(transactionalEmails.id, id),
    }))!;
    expect(row.status).toBe("complained");

    const sup = await currentDb.query.suppressionEntries.findFirst({
      where: and(
        eq(suppressionEntries.accountId, account.id),
        eq(suppressionEntries.email, "angry@example.com"),
      ),
    });
    expect(sup?.reason).toBe("complaint");
  });
});
