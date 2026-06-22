import { eq } from "drizzle-orm";
import { describe, it, expect } from "vitest";
import { forms, subscribers, type Form } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import { submitFormSignup } from "../src/services/form-signup";
import { confirmFormSignup } from "../src/services/form-confirm";
import { generateCampaignRecipients } from "../src/queue/handlers/generate-recipients";
import { campaignRecipients } from "../src/db/schema";
import {
  signFormConfirmToken,
  verifyFormConfirmToken,
} from "../src/services/form-token";
import { sendFormConfirmation } from "../src/queue/handlers/send-form-confirmation";
import { addSuppression } from "../src/services/suppression";
import {
  testDb,
  seedAccount,
  seedAudience,
  seedDomain,
  seedCampaign,
  FakeQueue,
  RecordingProvider,
} from "./helpers";
import type { Db } from "../src/db/client";

const SECRET = "test-secret-at-least-16-chars-long";

async function seedForm(
  db: Db,
  accountId: string,
  audienceId: string,
  overrides: Partial<Form> = {},
): Promise<Form> {
  const now = nowIso();
  const id = newId("frm");
  await db.insert(forms).values({
    id,
    accountId,
    audienceId,
    slug: `form-${id.slice(-6)}`,
    name: "Website signup",
    status: "active",
    doubleOptIn: true,
    buttonLabel: "Subscribe",
    collectName: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return (await db.query.forms.findFirst({ where: eq(forms.id, id) }))!;
}

describe("submitFormSignup", () => {
  it("double opt-in: new signup is pending and enqueues a confirmation", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const form = await seedForm(db, account.id, audience.id, { doubleOptIn: true });
    const queue = new FakeQueue();

    const result = await submitFormSignup(db, queue, {
      form,
      email: "New@Example.com",
      consentIp: "1.2.3.4",
    });

    expect(result.outcome).toBe("pending");
    const sub = await db.query.subscribers.findFirst({
      where: eq(subscribers.email, "new@example.com"),
    });
    expect(sub?.status).toBe("pending");
    expect(sub?.source).toBe("form");
    expect(sub?.formId).toBe(form.id);
    expect(sub?.consentIp).toBe("1.2.3.4");
    expect(sub?.confirmedAt).toBeNull();

    expect(queue.messages).toEqual([
      { type: "send_form_confirmation", subscriberId: sub!.id, accountId: account.id },
    ]);

    const fresh = await db.query.forms.findFirst({ where: eq(forms.id, form.id) });
    expect(fresh?.submitCount).toBe(1);
    expect(fresh?.confirmedCount).toBe(0);
  });

  it("single opt-in: new signup is immediately subscribed, no confirmation", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const form = await seedForm(db, account.id, audience.id, { doubleOptIn: false });
    const queue = new FakeQueue();

    const result = await submitFormSignup(db, queue, { form, email: "a@example.com" });

    expect(result.outcome).toBe("subscribed");
    const sub = await db.query.subscribers.findFirst({
      where: eq(subscribers.email, "a@example.com"),
    });
    expect(sub?.status).toBe("subscribed");
    expect(sub?.confirmedAt).not.toBeNull();
    expect(queue.messages).toHaveLength(0);

    const fresh = await db.query.forms.findFirst({ where: eq(forms.id, form.id) });
    expect(fresh?.submitCount).toBe(1);
    expect(fresh?.confirmedCount).toBe(1);
  });

  it("is idempotent: a repeat submit never duplicates the subscriber", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const form = await seedForm(db, account.id, audience.id, { doubleOptIn: true });
    const queue = new FakeQueue();

    await submitFormSignup(db, queue, { form, email: "dupe@example.com" });
    const second = await submitFormSignup(db, queue, { form, email: "dupe@example.com" });

    expect(second.outcome).toBe("already_pending");
    const rows = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.email, "dupe@example.com"));
    expect(rows).toHaveLength(1);
    // The confirmation is re-sent so a lost first email can be recovered.
    expect(queue.messages).toHaveLength(2);
  });

  it("respects the suppression list and never resurrects opt-outs", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const form = await seedForm(db, account.id, audience.id);
    const queue = new FakeQueue();

    await addSuppression(db, {
      accountId: account.id,
      email: "gone@example.com",
      reason: "unsubscribe",
    });

    const result = await submitFormSignup(db, queue, { form, email: "gone@example.com" });
    expect(result.outcome).toBe("opted_out");
    const rows = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.email, "gone@example.com"));
    expect(rows).toHaveLength(0);
    expect(queue.messages).toHaveLength(0);
  });

  it("an already-subscribed address is a no-op", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const form = await seedForm(db, account.id, audience.id, { doubleOptIn: false });
    const queue = new FakeQueue();

    await submitFormSignup(db, queue, { form, email: "member@example.com" });
    const again = await submitFormSignup(db, queue, { form, email: "member@example.com" });
    expect(again.outcome).toBe("already_subscribed");
  });
});

describe("double opt-in protects sending", () => {
  it("pending (unconfirmed) signups are never turned into campaign recipients", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const domain = await seedDomain(db, account.id, { verificationStatus: "verified" });
    const form = await seedForm(db, account.id, audience.id, { doubleOptIn: true });
    const queue = new FakeQueue();

    // One confirmed member, one still-pending signup from the form.
    await submitFormSignup(db, queue, { form, email: "confirmed@example.com" });
    await submitFormSignup(db, queue, { form, email: "pending@example.com" });
    const confirmed = (await db.query.subscribers.findFirst({
      where: eq(subscribers.email, "confirmed@example.com"),
    }))!;
    await confirmFormSignup(db, {
      accountId: account.id,
      subscriberId: confirmed.id,
      formId: form.id,
      email: confirmed.email,
    });

    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "approved",
    });
    await generateCampaignRecipients(
      { campaignId: campaign.id, accountId: account.id },
      db,
      queue,
    );

    const recipients = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(recipients.map((r) => r.email)).toEqual(["confirmed@example.com"]);
  });
});

describe("confirmFormSignup", () => {
  it("flips pending → subscribed and bumps confirmedCount", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const form = await seedForm(db, account.id, audience.id, { doubleOptIn: true });
    const queue = new FakeQueue();

    await submitFormSignup(db, queue, { form, email: "c@example.com" });
    const sub = (await db.query.subscribers.findFirst({
      where: eq(subscribers.email, "c@example.com"),
    }))!;

    const result = await confirmFormSignup(db, {
      accountId: account.id,
      subscriberId: sub.id,
      formId: form.id,
      email: sub.email,
    });
    expect(result.outcome).toBe("confirmed");

    const after = await db.query.subscribers.findFirst({ where: eq(subscribers.id, sub.id) });
    expect(after?.status).toBe("subscribed");
    expect(after?.confirmedAt).not.toBeNull();

    const fresh = await db.query.forms.findFirst({ where: eq(forms.id, form.id) });
    expect(fresh?.confirmedCount).toBe(1);

    // Confirming twice is idempotent.
    const repeat = await confirmFormSignup(db, {
      accountId: account.id,
      subscriberId: sub.id,
      formId: form.id,
      email: sub.email,
    });
    expect(repeat.outcome).toBe("already_confirmed");
  });
});

describe("form confirmation token", () => {
  it("round-trips and rejects tampering", async () => {
    const token = await signFormConfirmToken(
      { accountId: "acc_1", subscriberId: "sub_1", formId: "frm_1", email: "x@example.com" },
      SECRET,
    );
    const ok = await verifyFormConfirmToken(token, SECRET);
    expect(ok?.subscriberId).toBe("sub_1");

    expect(await verifyFormConfirmToken(token, "wrong-secret-at-least-16chars")).toBeNull();
    expect(await verifyFormConfirmToken(`${token}x`, SECRET)).toBeNull();
  });
});

describe("sendFormConfirmation handler", () => {
  it("sends via a verified sending domain for a pending subscriber", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    await seedDomain(db, account.id, { verificationStatus: "verified" });
    const form = await seedForm(db, account.id, audience.id, { doubleOptIn: true });
    const queue = new FakeQueue();
    await submitFormSignup(db, queue, { form, email: "send@example.com" });
    const sub = (await db.query.subscribers.findFirst({
      where: eq(subscribers.email, "send@example.com"),
    }))!;

    const provider = new RecordingProvider();
    await sendFormConfirmation(
      { subscriberId: sub.id, accountId: account.id },
      { db, emailProvider: provider, confirmSecret: SECRET },
    );

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].toEmail).toBe("send@example.com");
    expect(provider.sent[0].fromEmail).toBe("news@updates.test.co");
    // The confirm link must carry a valid token.
    const match = /token=([^"&\s]+)/.exec(provider.sent[0].html);
    expect(match).not.toBeNull();
    const payload = await verifyFormConfirmToken(decodeURIComponent(match![1]), SECRET);
    expect(payload?.subscriberId).toBe(sub.id);
  });

  it("skips (does not send) when there is no verified domain", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const form = await seedForm(db, account.id, audience.id, { doubleOptIn: true });
    const queue = new FakeQueue();
    await submitFormSignup(db, queue, { form, email: "nodomain@example.com" });
    const sub = (await db.query.subscribers.findFirst({
      where: eq(subscribers.email, "nodomain@example.com"),
    }))!;

    const provider = new RecordingProvider();
    await sendFormConfirmation(
      { subscriberId: sub.id, accountId: account.id },
      { db, emailProvider: provider, confirmSecret: SECRET },
    );
    expect(provider.sent).toHaveLength(0);
  });

  it("skips an already-confirmed subscriber", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    await seedDomain(db, account.id, { verificationStatus: "verified" });
    const form = await seedForm(db, account.id, audience.id, { doubleOptIn: false });
    const queue = new FakeQueue();
    await submitFormSignup(db, queue, { form, email: "already@example.com" });
    const sub = (await db.query.subscribers.findFirst({
      where: eq(subscribers.email, "already@example.com"),
    }))!;

    const provider = new RecordingProvider();
    await sendFormConfirmation(
      { subscriberId: sub.id, accountId: account.id },
      { db, emailProvider: provider, confirmSecret: SECRET },
    );
    expect(provider.sent).toHaveLength(0);
  });
});
