import { eq } from "drizzle-orm";
import { describe, it, expect } from "vitest";
import { accounts, forms, notifications, subscribers, type Form } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import {
  submitFormSignup,
  claimConfirmationSend,
  MAX_CONFIRMATION_SENDS,
  CONFIRMATION_RESEND_COOLDOWN_MS,
} from "../src/services/form-signup";
import { sendFormConfirmation } from "../src/queue/handlers/send-form-confirmation";
import { splitSubmittedFields } from "../src/lib/form-fields";
import { SANDBOX_MONTHLY_ALLOWANCE } from "../src/lib/plans-catalog";
import {
  testDb,
  seedAccount,
  seedAudience,
  seedDomain,
  FakeQueue,
  RecordingProvider,
} from "./helpers";
import type { Db } from "../src/db/client";

// The public signup form is the one surface where an anonymous stranger picks
// both the recipient and the send rate. These cover the two things that makes
// dangerous: mailing someone who never asked, and mailing on an account that is
// not allowed to send.

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

// Drives one pending signup up to the point the confirmation handler takes over.
async function pendingSignup(db: Db, account: { id: string }) {
  const audience = await seedAudience(db, account.id);
  const form = await seedForm(db, account.id, audience.id, { doubleOptIn: true });
  const queue = new FakeQueue();
  const result = await submitFormSignup(db, queue, { form, email: "visitor@example.com" });
  return { form, queue, subscriberId: result.subscriberId! };
}

async function expireCooldown(db: Db, subscriberId: string): Promise<void> {
  const past = new Date(Date.now() - CONFIRMATION_RESEND_COOLDOWN_MS - 60_000).toISOString();
  await db
    .update(subscribers)
    .set({ confirmationSentAt: past })
    .where(eq(subscribers.id, subscriberId));
}

async function accountRow(db: Db, id: string) {
  return (await db.query.accounts.findFirst({ where: eq(accounts.id, id) }))!;
}

describe("confirmation resend throttle", () => {
  it("a flood of repeat submits produces exactly one confirmation email", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const form = await seedForm(db, account.id, audience.id, { doubleOptIn: true });
    const queue = new FakeQueue();

    for (let i = 0; i < 25; i++) {
      await submitFormSignup(db, queue, { form, email: "victim@example.com" });
    }

    const confirmations = queue.messages.filter((m) => m.type === "send_form_confirmation");
    expect(confirmations).toHaveLength(1);
  });

  it("a throttled resend is indistinguishable from a delivered one", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const form = await seedForm(db, account.id, audience.id, { doubleOptIn: true });
    const queue = new FakeQueue();

    // If the throttle changed the visitor-facing outcome, the response would
    // tell a prober which addresses are already pending on this form.
    const first = await submitFormSignup(db, queue, { form, email: "victim@example.com" });
    const second = await submitFormSignup(db, queue, { form, email: "victim@example.com" });

    expect(first.outcome).toBe("pending");
    expect(second.outcome).toBe("already_pending");
  });

  it("releases a new send once the cooldown expires, up to the lifetime cap", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const { subscriberId } = await pendingSignup(db, account);

    // The signup itself already claimed the first send.
    expect(await claimConfirmationSend(db, subscriberId)).toBe(false);

    for (let sent = 1; sent < MAX_CONFIRMATION_SENDS; sent++) {
      await expireCooldown(db, subscriberId);
      expect(await claimConfirmationSend(db, subscriberId)).toBe(true);
    }

    // Lifetime cap reached: no amount of waiting buys another one.
    await expireCooldown(db, subscriberId);
    expect(await claimConfirmationSend(db, subscriberId)).toBe(false);

    const row = await db.query.subscribers.findFirst({ where: eq(subscribers.id, subscriberId) });
    expect(row!.confirmationSendCount).toBe(MAX_CONFIRMATION_SENDS);
  });
});

describe("confirmation sends are on the one ledger", () => {
  it("a paid send reserves against the account's monthly limit", async () => {
    const db = await testDb();
    const account = await seedAccount(db, { monthlyEmailLimit: 10, monthlyEmailSentCount: 0 });
    await seedDomain(db, account.id);
    const { subscriberId } = await pendingSignup(db, account);
    const provider = new RecordingProvider();

    await sendFormConfirmation(
      { subscriberId, accountId: account.id },
      { db, emailProvider: provider, confirmSecret: SECRET },
    );

    expect(provider.sent).toHaveLength(1);
    expect((await accountRow(db, account.id)).monthlyEmailSentCount).toBe(1);
  });

  it("a free org confirms real signups, metered against the sandbox allowance", async () => {
    const db = await testDb();
    // free_org has sendingEnabled false and monthlyEmailLimit 0 by design; the
    // sandbox allowance is the only reason its forms work at all.
    const account = await seedAccount(db, {
      plan: "free_org",
      sendingEnabled: false,
      monthlyEmailLimit: 0,
    });
    await seedDomain(db, account.id);
    const { subscriberId } = await pendingSignup(db, account);
    const provider = new RecordingProvider();

    await sendFormConfirmation(
      { subscriberId, accountId: account.id },
      { db, emailProvider: provider, confirmSecret: SECRET },
    );

    expect(provider.sent).toHaveLength(1);
    expect((await accountRow(db, account.id)).monthlyEmailSentCount).toBe(1);
  });

  it("a free org past the sandbox allowance sends nothing and notifies the owner", async () => {
    const db = await testDb();
    const account = await seedAccount(db, {
      plan: "free_org",
      sendingEnabled: false,
      monthlyEmailLimit: 0,
      monthlyEmailSentCount: SANDBOX_MONTHLY_ALLOWANCE,
    });
    await seedDomain(db, account.id);
    const { subscriberId } = await pendingSignup(db, account);
    const provider = new RecordingProvider();

    await sendFormConfirmation(
      { subscriberId, accountId: account.id },
      { db, emailProvider: provider, confirmSecret: SECRET },
    );

    expect(provider.sent).toHaveLength(0);
    // The signup is kept, not discarded — the owner can still rescue it.
    const sub = await db.query.subscribers.findFirst({ where: eq(subscribers.id, subscriberId) });
    expect(sub!.status).toBe("pending");
    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.accountId, account.id));
    expect(notes.some((n) => n.kind === "form_confirmation_blocked")).toBe(true);
  });

  it("a paid account at its monthly limit sends nothing", async () => {
    const db = await testDb();
    const account = await seedAccount(db, { monthlyEmailLimit: 5, monthlyEmailSentCount: 5 });
    await seedDomain(db, account.id);
    const { subscriberId } = await pendingSignup(db, account);
    const provider = new RecordingProvider();

    await sendFormConfirmation(
      { subscriberId, accountId: account.id },
      { db, emailProvider: provider, confirmSecret: SECRET },
    );

    expect(provider.sent).toHaveLength(0);
  });

  it("a reputation-paused account never mails a stranger from a form", async () => {
    const db = await testDb();
    const account = await seedAccount(db, { riskStatus: "paused" });
    await seedDomain(db, account.id);
    const { subscriberId } = await pendingSignup(db, account);
    const provider = new RecordingProvider();

    await sendFormConfirmation(
      { subscriberId, accountId: account.id },
      { db, emailProvider: provider, confirmSecret: SECRET },
    );

    expect(provider.sent).toHaveLength(0);
    // Nothing reserved either, because nothing was sent.
    expect((await accountRow(db, account.id)).monthlyEmailSentCount).toBe(0);
  });

  it("a past-due account sends nothing", async () => {
    const db = await testDb();
    const account = await seedAccount(db, { subscriptionStatus: "past_due" });
    await seedDomain(db, account.id);
    const { subscriberId } = await pendingSignup(db, account);
    const provider = new RecordingProvider();

    await sendFormConfirmation(
      { subscriberId, accountId: account.id },
      { db, emailProvider: provider, confirmSecret: SECRET },
    );

    expect(provider.sent).toHaveLength(0);
  });

  it("gives the reservation back when the provider fails, so retries can't drain the month", async () => {
    const db = await testDb();
    const account = await seedAccount(db, { monthlyEmailLimit: 10, monthlyEmailSentCount: 0 });
    await seedDomain(db, account.id);
    const { subscriberId } = await pendingSignup(db, account);
    const provider = new RecordingProvider();
    provider.results.set(0, {
      provider: "mock",
      messageId: null,
      status: "failed",
      error: "throttled",
    });

    await expect(
      sendFormConfirmation(
        { subscriberId, accountId: account.id },
        { db, emailProvider: provider, confirmSecret: SECRET },
      ),
    ).rejects.toThrow();

    expect((await accountRow(db, account.id)).monthlyEmailSentCount).toBe(0);
  });
});

describe("required fields are enforced server-side", () => {
  it("reports a required field that a direct POST left out", () => {
    const fields = [
      { key: "company", label: "Company", type: "text" as const, required: true },
      { key: "role", label: "Role", type: "text" as const, required: false },
    ];
    expect(splitSubmittedFields(fields, {}).missingRequired).toEqual(["Company"]);
    expect(splitSubmittedFields(fields, { company: "   " }).missingRequired).toEqual(["Company"]);
    expect(splitSubmittedFields(fields, { company: "Acme" }).missingRequired).toEqual([]);
  });
});
