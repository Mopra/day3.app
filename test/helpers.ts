import { env } from "cloudflare:workers";
import { createDb, type Db } from "../src/worker/db/client";
import {
  accounts,
  audiences,
  campaigns,
  sendingDomains,
  subscribers,
  type Account,
  type Audience,
  type Campaign,
  type SendingDomain,
  type Subscriber,
} from "../src/worker/db/schema";
import { newId, nowIso } from "../src/worker/lib/ids";
import type { QueueMessage } from "../src/worker/queue/messages";
import type {
  EmailProvider,
  SendEmailInput,
  SendEmailResult,
} from "../src/worker/email/provider";

export const testEnv = env as unknown as Env;

export function testDb(): Db {
  return createDb(testEnv.DB);
}

export class FakeQueue {
  messages: QueueMessage[] = [];
  async send(message: QueueMessage): Promise<void> {
    this.messages.push(message);
  }
  async sendBatch(batch: Iterable<{ body: QueueMessage }>): Promise<void> {
    for (const m of batch) this.messages.push(m.body);
  }
}

export function asQueue(q: FakeQueue): Queue<QueueMessage> {
  return q as unknown as Queue<QueueMessage>;
}

export class RecordingProvider implements EmailProvider {
  sent: SendEmailInput[] = [];
  // Per-call overrides: results[i] is returned for call i (otherwise sent ok).
  results = new Map<number, SendEmailResult>();
  throwOnCall: number | null = null;
  private calls = 0;

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const call = this.calls++;
    if (this.throwOnCall !== null && call === this.throwOnCall) {
      throw new Error("provider exploded");
    }
    this.sent.push(input);
    return (
      this.results.get(call) ?? {
        provider: "mock",
        messageId: `m_${call}`,
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
    plan: "tiny",
    subscriptionStatus: "active",
    monthlyEmailLimit: 10_000,
    monthlyEmailSentCount: 0,
    sendingEnabled: 1,
    riskStatus: "normal",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return (await db.query.accounts.findFirst({
    where: (t, { eq }) => eq(t.id, id),
  }))!;
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
