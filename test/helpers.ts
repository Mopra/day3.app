import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../src/db/schema";
import type { Db } from "../src/db/client";
import {
  accounts,
  audiences,
  campaigns,
  sendingDomains,
  senders,
  subscribers,
  type Account,
  type Audience,
  type Campaign,
  type Sender,
  type SendingDomain,
  type Subscriber,
} from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import type { JobQueue, QueueMessage } from "../src/queue/messages";
import type { ObjectStore, StoredObject } from "../src/lib/storage";
import type { EmailProvider, SendEmailInput, SendEmailResult } from "../src/email/provider";
import { applyMigrations } from "./apply-migrations";

// Fresh in-memory Postgres (pglite) per call → full test isolation.
export async function testDb(): Promise<Db> {
  const pg = new PGlite();
  await applyMigrations(pg);
  return drizzle(pg, { schema }) as unknown as Db;
}

export class FakeQueue implements JobQueue {
  messages: QueueMessage[] = [];
  async send(message: QueueMessage): Promise<void> {
    this.messages.push(message);
  }
}

export function asQueue(q: FakeQueue): JobQueue {
  return q;
}

// In-memory object store standing in for Supabase Storage (the import handler's
// ObjectStore seam).
export class FakeStore implements ObjectStore {
  private files = new Map<string, string>();
  put(key: string, content: string): void {
    this.files.set(key, content);
  }
  async get(key: string): Promise<StoredObject | null> {
    const content = this.files.get(key);
    return content === undefined ? null : { text: async () => content };
  }
}

let recordingProviderSeq = 0;

export class RecordingProvider implements EmailProvider {
  sent: SendEmailInput[] = [];
  // Per-call overrides: results[i] is returned for call i (otherwise sent ok).
  results = new Map<number, SendEmailResult>();
  throwOnCall: number | null = null;
  private calls = 0;
  // Message ids are unique across provider instances (like real SES ids) —
  // email_events dedupes on (providerMessageId, eventType), so two instances
  // both emitting "m_0" would silently collide.
  private prefix = `m${recordingProviderSeq++}`;

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const call = this.calls++;
    if (this.throwOnCall !== null && call === this.throwOnCall) {
      throw new Error("provider exploded");
    }
    this.sent.push(input);
    return (
      this.results.get(call) ?? {
        provider: "mock",
        messageId: `${this.prefix}_${call}`,
        status: "sent",
      }
    );
  }
}

export async function seedAccount(db: Db, overrides: Partial<Account> = {}): Promise<Account> {
  const now = nowIso();
  const id = newId("acc");
  await db.insert(accounts).values({
    id,
    clerkOrgId: `org_${id}`,
    name: "Test Co",
    // A fully set-up, sendable account has a mailing address (the send gate now
    // requires it for CAN-SPAM compliance). Tests for the missing-address gate
    // override this with null explicitly.
    companyAddress: "123 Test St, Test City, 0000",
    plan: "10k_plan",
    subscriptionStatus: "active",
    monthlyEmailLimit: 10_000,
    monthlyEmailSentCount: 0,
    sendingEnabled: true,
    riskStatus: "normal",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return (await db.query.accounts.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!;
}

export async function seedDomain(
  db: Db,
  accountId: string,
  overrides: Partial<SendingDomain> = {},
): Promise<SendingDomain> {
  const now = nowIso();
  const id = newId("dom");
  await db.insert(sendingDomains).values({
    id,
    accountId,
    domain: "updates.test.co",
    fromName: "Test Co",
    fromEmail: "news@updates.test.co",
    verificationStatus: "verified",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return (await db.query.sendingDomains.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!;
}

export async function seedSender(
  db: Db,
  accountId: string,
  sendingDomainId: string,
  overrides: Partial<Sender> = {},
): Promise<Sender> {
  const now = nowIso();
  const id = newId("snd");
  await db.insert(senders).values({
    id,
    accountId,
    sendingDomainId,
    fromName: "Test Co",
    fromEmail: "news@updates.test.co",
    isDefault: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return (await db.query.senders.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!;
}

export async function seedAudience(db: Db, accountId: string): Promise<Audience> {
  const now = nowIso();
  const id = newId("aud");
  await db.insert(audiences).values({
    id,
    accountId,
    name: "Test audience",
    createdAt: now,
    updatedAt: now,
  });
  return (await db.query.audiences.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!;
}

export async function seedSubscribers(
  db: Db,
  accountId: string,
  audienceId: string,
  emails: string[],
  status: Subscriber["status"] = "subscribed",
): Promise<Subscriber[]> {
  const now = nowIso();
  const rows = emails.map((email) => ({
    id: newId("sub"),
    accountId,
    audienceId,
    email,
    firstName: email.split("@")[0],
    status,
    createdAt: now,
    updatedAt: now,
  }));
  for (const row of rows) await db.insert(subscribers).values(row);
  return db.query.subscribers.findMany({
    where: (t, { eq }) => eq(t.audienceId, audienceId),
  });
}

export async function seedCampaign(
  db: Db,
  input: {
    accountId: string;
    audienceId: string;
    sendingDomainId: string;
    status?: Campaign["status"];
    subject?: string;
    htmlBody?: string;
  },
): Promise<Campaign> {
  const now = nowIso();
  const id = newId("cmp");
  await db.insert(campaigns).values({
    id,
    accountId: input.accountId,
    audienceId: input.audienceId,
    sendingDomainId: input.sendingDomainId,
    name: "Test campaign",
    subject: input.subject ?? "Product update: new dashboard",
    fromName: "Test Co",
    fromEmail: "news@updates.test.co",
    htmlBody: input.htmlBody ?? "<p>Hi {{first_name}}, we shipped a new dashboard.</p>",
    status: input.status ?? "draft",
    createdAt: now,
    updatedAt: now,
  });
  return (await db.query.campaigns.findFirst({ where: (t, { eq }) => eq(t.id, id) }))!;
}

export const TEST_EMAILS = [
  "alice@example.com",
  "bob@example.com",
  "charlie@example.com",
  "dana@example.com",
  "erik@example.com",
];
