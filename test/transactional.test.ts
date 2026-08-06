import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import type { Account } from "../src/db/schema";
import {
  accountUsers,
  accounts,
  apiKeys,
  emailEvents,
  idempotencyKeys,
  sendingDomains,
  suppressionEntries,
  transactionalEmails,
} from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import type { EmailProvider } from "../src/email/provider";
import { isDomainClaimed } from "../src/services/domain-ownership";
import { computeAccountHealth, enforceAccountHealth } from "../src/services/health";
import { releaseReservation } from "../src/services/quota";
import { FakeQueue, RecordingProvider, seedAccount, seedDomain, testDb } from "./helpers";

// POST /v1/emails resolves its DB via getDb (inside requireApiKey), enqueues
// via the Redis-backed producer, and rate-limits via Redis. All three seams are
// replaced; key auth, validation, quota, and the send handler run REAL.
let currentDb: Db;
let fakeQueue: FakeQueue;

vi.mock("../src/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/client")>();
  return { ...actual, getDb: () => currentDb };
});
vi.mock("../src/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/rate-limit")>();
  return {
    ...actual,
    checkRateLimit: async () => ({
      allowed: true,
      retryAfterSeconds: 0,
      limit: 600,
      remaining: 599,
    }),
    enforceRateLimit: async () => {},
  };
});
vi.mock("../src/queue/producer", () => ({
  getQueue: () => fakeQueue,
  getRedisConnection: () => {
    throw new Error("no redis in tests");
  },
}));

const { generateApiKey } = await import("../src/api/v1/auth");
const emailsRoute = await import("../app/api/v1/emails/route");
const emailItemRoute = await import("../app/api/v1/emails/[emailId]/route");
const { sendTransactionalEmail } = await import("../src/queue/handlers/send-transactional");
const { sweepTransactionalEmails, pruneTransactionalBodies } = await import("../src/queue/cron");

let account: Account;
let liveKey: string;

async function seedApiKey(accountId: string): Promise<string> {
  const { key, keyHash, keyPrefix } = generateApiKey();
  const now = nowIso();
  await currentDb.insert(apiKeys).values({
    id: newId("key"),
    accountId,
    name: "test",
    keyHash,
    keyPrefix,
    createdBy: "user_test",
    createdAt: now,
    updatedAt: now,
  });
  return key;
}

async function seedMember(accountId: string, email: string): Promise<void> {
  const now = nowIso();
  await currentDb.insert(accountUsers).values({
    id: newId("usr"),
    accountId,
    clerkUserId: `user_${newId("usr")}`,
    email,
    role: "member",
    createdAt: now,
    updatedAt: now,
  });
}

function v1Req(
  url: string,
  opts: { method?: string; body?: unknown; key?: string; headers?: Record<string, string> } = {},
): Request {
  const req = new Request(url, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.key === undefined ? {} : { authorization: `Bearer ${opts.key}` }),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  Object.defineProperty(req, "nextUrl", { value: new URL(url) });
  return req;
}

function params(values: Record<string, string>) {
  return { params: Promise.resolve(values) } as never;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function body(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, never>;
}

const URL_EMAILS = "https://day3.app/api/v1/emails";

function sendBody(overrides: Record<string, unknown> = {}) {
  return {
    from: "Test Co <notify@updates.test.co>",
    to: ["jane@example.com"],
    subject: "Reset your password",
    html: "<p>Click here</p>",
    ...overrides,
  };
}

async function postEmail(
  payload: Record<string, unknown>,
  opts: { key?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return emailsRoute.POST(
    v1Req(URL_EMAILS, { method: "POST", body: payload, key: opts.key ?? liveKey, headers: opts.headers }) as never,
    params({}),
  );
}

async function usage(accountId: string): Promise<number> {
  const row = await currentDb.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  return row!.monthlyEmailSentCount;
}

beforeEach(async () => {
  currentDb = await testDb();
  fakeQueue = new FakeQueue();
  account = await seedAccount(currentDb);
  await seedDomain(currentDb, account.id); // updates.test.co, verified
  liveKey = await seedApiKey(account.id);
});

describe("POST /v1/emails — accept path", () => {
  it("accepts a valid send: persists queued row, reserves quota, enqueues the job", async () => {
    const res = await postEmail(sendBody());
    expect(res.status).toBe(200);
    const email = await body(res);
    expect(email.id).toMatch(/^eml_/);
    expect(email.status).toBe("queued");
    expect(email.sandbox).toBe(false);
    expect(email.to).toEqual(["jane@example.com"]);
    expect(email.from).toBe("Test Co <notify@updates.test.co>");

    const row = await currentDb.query.transactionalEmails.findFirst({
      where: eq(transactionalEmails.id, email.id),
    });
    expect(row?.status).toBe("queued");
    expect(row?.htmlBody).toBe("<p>Click here</p>");

    expect(await usage(account.id)).toBe(1);
    expect(fakeQueue.messages).toEqual([
      { type: "send_transactional", emailId: email.id, accountId: account.id },
    ]);
  });

  it("accepts any local-part on the verified domain, string `to`, and text-only bodies", async () => {
    const res = await postEmail(
      sendBody({ from: "receipts@updates.test.co", to: "solo@example.com", html: undefined, text: "plain" }),
    );
    expect(res.status).toBe(200);
    const email = await body(res);
    expect(email.to).toEqual(["solo@example.com"]);
  });

  it("de-duplicates recipients and reserves quota per recipient", async () => {
    const res = await postEmail(
      sendBody({ to: ["a@example.com", "A@example.com", "b@example.com"] }),
    );
    expect(res.status).toBe(200);
    const email = await body(res);
    expect(email.to).toEqual(["a@example.com", "b@example.com"]);
    expect(await usage(account.id)).toBe(2);
  });

  it("replays an Idempotency-Key hit without a second row or reservation", async () => {
    const headers = { "idempotency-key": "idem-1" };
    const first = await body(await postEmail(sendBody(), { headers }));
    const replay = await postEmail(sendBody(), { headers });
    expect((await body(replay)).id).toBe(first.id);

    const rows = await currentDb.query.transactionalEmails.findMany({
      where: eq(transactionalEmails.accountId, account.id),
    });
    expect(rows).toHaveLength(1);
    expect(await usage(account.id)).toBe(1);
    expect(fakeQueue.messages).toHaveLength(1);
  });

  it("rejects invalid from / missing body / reserved and invalid headers", async () => {
    let res = await postEmail(sendBody({ from: "not-an-address" }));
    expect(res.status).toBe(400);
    expect((await body(res)).error.param).toBe("from");

    res = await postEmail(sendBody({ html: undefined }));
    expect(res.status).toBe(400);

    res = await postEmail(sendBody({ headers: { "List-Unsubscribe": "x" } }));
    expect(res.status).toBe(400);

    res = await postEmail(sendBody({ to: ["not an email"] }));
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("invalid_email");
  });

  it("rejects header-smuggling shapes: mailbox in display name, control chars, angled addresses", async () => {
    // A display name carrying a second <mailbox> could ride another tenant's
    // verified identity in the shared SES account — must be a 400.
    let res = await postEmail(
      sendBody({ from: '"Evil <ceo@other-tenant.com>" <notify@updates.test.co>' }),
    );
    expect(res.status).toBe(400);
    expect((await body(res)).error.param).toBe("from");

    // CR/LF in header values is the classic header-injection vector.
    res = await postEmail(sendBody({ headers: { "X-Ref": "a\r\nBcc: victim@example.com" } }));
    expect(res.status).toBe(400);

    // Control characters in the subject.
    res = await postEmail(sendBody({ subject: "Hi\r\nBcc: victim@example.com" }));
    expect(res.status).toBe(400);
    expect((await body(res)).error.param).toBe("subject");

    // Addresses with angle brackets / commas pass the loose house EMAIL_RE but
    // are never legitimate here.
    res = await postEmail(sendBody({ to: ["a<b@example.com"] }));
    expect(res.status).toBe(400);
    res = await postEmail(sendBody({ reply_to: 'x"y@example.com' }));
    expect(res.status).toBe(400);
  });

  it("409s a concurrent request holding the same Idempotency-Key, and takes over an abandoned claim", async () => {
    // A fresh in-flight claim (another request mid-execution).
    await currentDb.insert(idempotencyKeys).values({
      id: newId("idem"),
      accountId: account.id,
      endpoint: "POST /v1/emails",
      key: "race-1",
      requestHash: "someone-elses-hash",
      responseStatus: null,
      responseBody: null,
      createdAt: nowIso(),
    });
    let res = await postEmail(sendBody(), { headers: { "idempotency-key": "race-1" } });
    expect(res.status).toBe(409);
    expect((await body(res)).error.code).toBe("idempotency_conflict");
    expect(fakeQueue.messages).toHaveLength(0); // nothing executed

    // The same claim, aged past the in-flight TTL (crashed request) — taken over.
    await currentDb
      .update(idempotencyKeys)
      .set({ createdAt: new Date(Date.now() - 6 * 60 * 1000).toISOString() })
      .where(eq(idempotencyKeys.key, "race-1"));
    res = await postEmail(sendBody(), { headers: { "idempotency-key": "race-1" } });
    expect(res.status).toBe(200);
  });

  it("accepts the email even when the enqueue fails — the sweep rescues it", async () => {
    fakeQueue.send = async () => {
      throw new Error("redis down");
    };
    const res = await postEmail(sendBody());
    expect(res.status).toBe(200);
    const email = await body(res);

    const row = (await currentDb.query.transactionalEmails.findFirst({
      where: eq(transactionalEmails.id, email.id),
    }))!;
    expect(row.status).toBe("queued"); // accepted; NOT failed
    expect(await usage(account.id)).toBe(1); // reservation kept

    // The sweep re-enqueues it once it goes stale.
    await currentDb
      .update(transactionalEmails)
      .set({ updatedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() })
      .where(eq(transactionalEmails.id, email.id));
    const rescueQueue = new FakeQueue();
    const result = await sweepTransactionalEmails(currentDb, rescueQueue, new Date());
    expect(result.requeued).toBe(1);
    expect(rescueQueue.messages[0]).toEqual({
      type: "send_transactional",
      emailId: email.id,
      accountId: account.id,
    });
  });

  it("rejects an unverified or foreign from-domain with domain_not_verified", async () => {
    await seedDomain(currentDb, account.id, { domain: "pending.test.co", verificationStatus: "pending" });

    let res = await postEmail(sendBody({ from: "x@pending.test.co" }));
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe("domain_not_verified");

    res = await postEmail(sendBody({ from: "x@never-added.test" }));
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe("domain_not_verified");
  });

  it("blocks bounced/complained recipients but not unsubscribed ones", async () => {
    const now = nowIso();
    await currentDb.insert(suppressionEntries).values([
      { id: newId("sup"), accountId: account.id, email: "dead@example.com", scope: "account", reason: "hard_bounce", createdAt: now },
      { id: newId("sup"), accountId: account.id, email: "optout@example.com", scope: "account", reason: "unsubscribe", createdAt: now },
    ]);

    let res = await postEmail(sendBody({ to: ["dead@example.com"] }));
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("email_suppressed");

    // Unsubscribed from marketing ≠ unreachable for transactional.
    res = await postEmail(sendBody({ to: ["optout@example.com"] }));
    expect(res.status).toBe(200);
  });

  it("rejects at the monthly limit with plan_limit_reached and doesn't leak the reservation", async () => {
    await currentDb
      .update(accounts)
      .set({ monthlyEmailSentCount: account.monthlyEmailLimit })
      .where(eq(accounts.id, account.id));

    const res = await postEmail(sendBody());
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe("plan_limit_reached");
    expect(await usage(account.id)).toBe(account.monthlyEmailLimit);
    expect(fakeQueue.messages).toHaveLength(0);
  });

  it("a keyed request rejected with 4xx releases its claim so a later retry can succeed", async () => {
    await currentDb
      .update(accounts)
      .set({ monthlyEmailSentCount: account.monthlyEmailLimit })
      .where(eq(accounts.id, account.id));
    const headers = { "idempotency-key": "quota-retry" };

    let res = await postEmail(sendBody(), { headers });
    expect(res.status).toBe(403);

    // Quota frees up (upgrade / new period) — the same key must re-execute,
    // not replay the stale 403 or dead-end on an orphaned claim.
    await currentDb
      .update(accounts)
      .set({ monthlyEmailSentCount: 0 })
      .where(eq(accounts.id, account.id));
    res = await postEmail(sendBody(), { headers });
    expect(res.status).toBe(200);
  });

  it("blocks a risk-paused paid account with sending_disabled", async () => {
    await currentDb
      .update(accounts)
      .set({ riskStatus: "paused", sendingEnabled: false })
      .where(eq(accounts.id, account.id));
    const res = await postEmail(sendBody());
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe("sending_disabled");
  });
});

describe("POST /v1/emails — sandbox (free tier)", () => {
  let freeAccount: Account;
  let freeKey: string;

  beforeEach(async () => {
    freeAccount = await seedAccount(currentDb, {
      plan: "free_org",
      monthlyEmailLimit: 0,
      sendingEnabled: false,
    });
    await seedDomain(currentDb, freeAccount.id, { domain: "free.test.co" });
    await seedMember(freeAccount.id, "dev@free.test.co");
    freeKey = await seedApiKey(freeAccount.id);
  });

  it("sends to org members, flagged sandbox, against the sandbox allowance", async () => {
    const res = await postEmail(
      sendBody({ from: "notify@free.test.co", to: ["dev@free.test.co"] }),
      { key: freeKey },
    );
    expect(res.status).toBe(200);
    const email = await body(res);
    expect(email.sandbox).toBe(true);
    expect(await usage(freeAccount.id)).toBe(1);
  });

  it("rejects recipients outside the org", async () => {
    const res = await postEmail(
      sendBody({ from: "notify@free.test.co", to: ["dev@free.test.co", "stranger@example.com"] }),
      { key: freeKey },
    );
    expect(res.status).toBe(403);
    const error = (await body(res)).error;
    expect(error.code).toBe("sandbox_recipient_not_allowed");
    expect(error.message).toContain("stranger@example.com");
  });

  it("stops at the sandbox monthly allowance", async () => {
    await currentDb
      .update(accounts)
      .set({ monthlyEmailSentCount: 100 })
      .where(eq(accounts.id, freeAccount.id));
    const res = await postEmail(
      sendBody({ from: "notify@free.test.co", to: ["dev@free.test.co"] }),
      { key: freeKey },
    );
    expect(res.status).toBe(403);
    const error = (await body(res)).error;
    expect(error.code).toBe("plan_limit_reached");
    expect(error.message).toMatch(/sandbox/i);
  });
});

// ── The worker side ──────────────────────────────────────────────────────────

async function acceptedEmail(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await postEmail(sendBody(overrides));
  expect(res.status).toBe(200);
  return (await body(res)).id as string;
}

describe("send_transactional handler", () => {
  it("stamps platform attribution headers that a caller header cannot shadow", async () => {
    // `x-account-id` (lowercase) is reserved at the API boundary, so post one
    // directly to the row — older rows or a future writer must still not be
    // able to ship a second, attacker-chosen attribution header.
    const id = await acceptedEmail();
    await currentDb
      .update(transactionalEmails)
      .set({ headers: { "x-account-id": "acc_someone_else", "X-Ref": "keep-me" } })
      .where(eq(transactionalEmails.id, id));

    const provider = new RecordingProvider();
    await sendTransactionalEmail(
      { emailId: id, accountId: account.id },
      { db: currentDb, emailProvider: provider },
    );

    const headers = provider.sent[0].headers!;
    expect(headers["X-Ref"]).toBe("keep-me");
    expect(headers["X-Account-ID"]).toBe(account.id);
    expect(headers["x-account-id"]).toBeUndefined();
  });

  it("sends a queued email: sent status, provider message id, event row, quota kept", async () => {
    const id = await acceptedEmail({ to: ["a@example.com", "b@example.com"] });
    const provider = new RecordingProvider();

    await sendTransactionalEmail({ emailId: id, accountId: account.id }, { db: currentDb, emailProvider: provider });

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].toEmail).toEqual(["a@example.com", "b@example.com"]);
    expect(provider.sent[0].fromEmail).toBe("notify@updates.test.co");

    const row = (await currentDb.query.transactionalEmails.findFirst({
      where: eq(transactionalEmails.id, id),
    }))!;
    expect(row.status).toBe("sent");
    expect(row.providerMessageId).toBeTruthy();
    expect(row.sentAt).toBeTruthy();
    expect(await usage(account.id)).toBe(2);

    const events = await currentDb
      .select()
      .from(emailEvents)
      .where(eq(emailEvents.transactionalEmailId, id));
    expect(events.map((e) => e.eventType)).toEqual(["sent"]);
  });

  it("is idempotent: a redelivered job for a sent email never re-sends", async () => {
    const id = await acceptedEmail();
    const provider = new RecordingProvider();
    const deps = { db: currentDb, emailProvider: provider };

    await sendTransactionalEmail({ emailId: id, accountId: account.id }, deps);
    await sendTransactionalEmail({ emailId: id, accountId: account.id }, deps);

    expect(provider.sent).toHaveLength(1);
  });

  it("returns the row to queued and throws on provably-unsent errors (retryable)", async () => {
    const id = await acceptedEmail();
    const provider = new RecordingProvider();
    provider.results.set(0, { provider: "ses", status: "transient", error: "ECONNREFUSED" });

    await expect(
      sendTransactionalEmail({ emailId: id, accountId: account.id }, { db: currentDb, emailProvider: provider }),
    ).rejects.toThrow(/will retry/);

    const row = (await currentDb.query.transactionalEmails.findFirst({
      where: eq(transactionalEmails.id, id),
    }))!;
    expect(row.status).toBe("queued");
    // Reservation stays held — the email is still expected to go out.
    expect(await usage(account.id)).toBe(1);
  });

  it("marks terminal failures failed and releases the reservation", async () => {
    const id = await acceptedEmail();
    const provider = new RecordingProvider();
    provider.results.set(0, { provider: "ses", status: "failed", error: "MessageRejected: bad content" });

    await sendTransactionalEmail({ emailId: id, accountId: account.id }, { db: currentDb, emailProvider: provider });

    const row = (await currentDb.query.transactionalEmails.findFirst({
      where: eq(transactionalEmails.id, id),
    }))!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("MessageRejected");
    expect(await usage(account.id)).toBe(0);
  });

  it("mirrors a provider suppression into our list and releases the reservation", async () => {
    const id = await acceptedEmail({ to: ["listed@example.com"] });
    const provider = new RecordingProvider();
    provider.results.set(0, { provider: "ses", status: "suppressed", error: "MessageRejected" });

    await sendTransactionalEmail({ emailId: id, accountId: account.id }, { db: currentDb, emailProvider: provider });

    const row = (await currentDb.query.transactionalEmails.findFirst({
      where: eq(transactionalEmails.id, id),
    }))!;
    expect(row.status).toBe("suppressed");
    expect(await usage(account.id)).toBe(0);

    const sup = await currentDb.query.suppressionEntries.findFirst({
      where: and(
        eq(suppressionEntries.accountId, account.id),
        eq(suppressionEntries.email, "listed@example.com"),
      ),
    });
    expect(sup?.reason).toBe("provider_suppressed");
  });

  it("flips the sending domain when the provider reports the identity unverified", async () => {
    const id = await acceptedEmail();
    const provider = new RecordingProvider();
    provider.results.set(0, {
      provider: "ses",
      status: "failed",
      error: "E_SENDER_NOT_VERIFIED: Email address is not verified",
    });

    await sendTransactionalEmail({ emailId: id, accountId: account.id }, { db: currentDb, emailProvider: provider });

    const domain = await currentDb.query.sendingDomains.findFirst({
      where: and(eq(sendingDomains.accountId, account.id), eq(sendingDomains.domain, "updates.test.co")),
    });
    expect(domain?.verificationStatus).toBe("failed");
  });

  it("never double-releases quota when the sweep failed the row mid-send", async () => {
    const id = await acceptedEmail();
    // Pad the counter so a double release is distinguishable from a single one
    // (the GREATEST(…, 0) floor would otherwise mask it at zero).
    await currentDb
      .update(accounts)
      .set({ monthlyEmailSentCount: 6 })
      .where(eq(accounts.id, account.id));

    // A provider whose send() stalls long enough for the stuck-lock sweep to
    // fire: the sweep flips the row to failed and releases the reservation
    // while the worker is still inside the provider call.
    const provider: EmailProvider = {
      send: async () => {
        await currentDb
          .update(transactionalEmails)
          .set({ status: "failed", error: "send attempt did not complete (stuck lock)" })
          .where(eq(transactionalEmails.id, id));
        await releaseReservation(currentDb, account.id, 1);
        return { provider: "mock", status: "failed", error: "SomeError: rejected" };
      },
    };

    await sendTransactionalEmail(
      { emailId: id, accountId: account.id },
      { db: currentDb, emailProvider: provider },
    );

    // Single release only: 6 - 1 = 5. A double release would read 4.
    expect(await usage(account.id)).toBe(5);
    const row = (await currentDb.query.transactionalEmails.findFirst({
      where: eq(transactionalEmails.id, id),
    }))!;
    expect(row.status).toBe("failed");
  });

  it("fails (not sends) when the account became ineligible after accept", async () => {
    const id = await acceptedEmail();
    await currentDb
      .update(accounts)
      .set({ riskStatus: "paused" })
      .where(eq(accounts.id, account.id));
    const provider = new RecordingProvider();

    await sendTransactionalEmail({ emailId: id, accountId: account.id }, { db: currentDb, emailProvider: provider });

    expect(provider.sent).toHaveLength(0);
    const row = (await currentDb.query.transactionalEmails.findFirst({
      where: eq(transactionalEmails.id, id),
    }))!;
    expect(row.status).toBe("failed");
    expect(await usage(account.id)).toBe(0);
  });
});

describe("sending-domain ownership is global (anti-spoofing boundary)", () => {
  it("refuses a domain another account already holds", async () => {
    // Without this, the attacker's row would be stamped verified from SES's
    // account-wide identity state and could send DKIM-signed mail as the
    // victim's domain — the from-domain gate in POST /v1/emails trusts exactly
    // this row.
    expect(await isDomainClaimed(currentDb, "updates.test.co")).toBe(true);

    const attacker = await seedAccount(currentDb);
    expect(await isDomainClaimed(currentDb, "updates.test.co")).toBe(true);
    // The attacker's own (different) domain is free to add.
    expect(await isDomainClaimed(currentDb, "attacker-owned.test")).toBe(false);

    // And the gate really is the row: with no row of their own, the attacker
    // cannot send from the victim's verified domain.
    const attackerKey = await seedApiKey(attacker.id);
    const res = await postEmail(sendBody({ from: "billing@updates.test.co" }), {
      key: attackerKey,
    });
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe("domain_not_verified");
  });
});

describe("transactional sends count toward account reputation", () => {
  it("auto-pauses on a transactional bounce rate, and weighs each recipient", async () => {
    // 100 recipients' worth of clean transactional sends, then enough bounced
    // ones to cross the 4% pause threshold. Without transactional volume in
    // computeAccountHealth this account would read 0 attempted and never pause.
    const now = nowIso();
    const mk = async (status: "sent" | "bounced", recipients: number) => {
      await currentDb.insert(transactionalEmails).values({
        id: newId("eml"),
        accountId: account.id,
        fromEmail: "notify@updates.test.co",
        to: Array.from({ length: recipients }, (_, i) => `r${i}-${newId("eml")}@example.com`),
        subject: "s",
        htmlBody: "<p>x</p>",
        status,
        provider: "ses",
        sentAt: now,
        createdAt: now,
        updatedAt: now,
      });
    };
    await mk("sent", 100);
    const health = await computeAccountHealth(currentDb, account.id);
    expect(health.attempted).toBe(100); // recipients, not rows
    expect(health.status).toBe("normal");

    await mk("bounced", 5); // 5 / 105 ≈ 4.8% > 4%
    const bad = await enforceAccountHealth(currentDb, account.id);
    expect(bad.attempted).toBe(105);
    expect(bad.bounced).toBe(5);
    expect(bad.status).toBe("paused");

    const acct = (await currentDb.query.accounts.findFirst({
      where: eq(accounts.id, account.id),
    }))!;
    expect(acct.riskStatus).toBe("paused");
    expect(acct.sendingEnabled).toBe(false);
  });
});

// ── Read API ─────────────────────────────────────────────────────────────────

describe("GET /v1/emails", () => {
  it("lists own emails newest-first with status filter; details carry events; cross-tenant is 404", async () => {
    const id = await acceptedEmail();
    const provider = new RecordingProvider();
    await sendTransactionalEmail({ emailId: id, accountId: account.id }, { db: currentDb, emailProvider: provider });

    const list = await body(
      await emailsRoute.GET(v1Req(`${URL_EMAILS}?status=sent`, { key: liveKey }) as never, params({})),
    );
    expect(list.data).toHaveLength(1);
    expect(list.data[0].id).toBe(id);
    expect(list.data[0].status).toBe("sent");

    const detail = await body(
      await emailItemRoute.GET(v1Req(`${URL_EMAILS}/${id}`, { key: liveKey }) as never, params({ emailId: id })),
    );
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(["sent"]);

    // Another tenant's key reads the id as 404.
    const other = await seedAccount(currentDb);
    const otherKey = await seedApiKey(other.id);
    const res = await emailItemRoute.GET(
      v1Req(`${URL_EMAILS}/${id}`, { key: otherKey }) as never,
      params({ emailId: id }),
    );
    expect(res.status).toBe(404);
  });
});

// ── Cron sweeps ──────────────────────────────────────────────────────────────

describe("transactional cron sweeps", () => {
  it("fails stuck sending rows (releasing quota), requeues stale queued rows, gives up on ancient ones", async () => {
    const now = Date.now();
    const stuckId = await acceptedEmail({ to: ["stuck@example.com"] });
    const staleId = await acceptedEmail({ to: ["stale@example.com"] });
    const ancientId = await acceptedEmail({ to: ["ancient@example.com"] });
    const freshId = await acceptedEmail({ to: ["fresh@example.com"] });
    expect(await usage(account.id)).toBe(4);

    const old = (ms: number) => new Date(now - ms).toISOString();
    await currentDb
      .update(transactionalEmails)
      .set({ status: "sending", lockedAt: old(20 * 60 * 1000) })
      .where(eq(transactionalEmails.id, stuckId));
    await currentDb
      .update(transactionalEmails)
      .set({ updatedAt: old(20 * 60 * 1000) })
      .where(eq(transactionalEmails.id, staleId));
    await currentDb
      .update(transactionalEmails)
      .set({ createdAt: old(7 * 60 * 60 * 1000), updatedAt: old(7 * 60 * 60 * 1000) })
      .where(eq(transactionalEmails.id, ancientId));

    const queue = new FakeQueue();
    const result = await sweepTransactionalEmails(currentDb, queue, new Date(now));

    expect(result.failed).toBe(2); // stuck + ancient
    expect(result.requeued).toBe(1); // stale

    const byId = async (id: string) =>
      (await currentDb.query.transactionalEmails.findFirst({ where: eq(transactionalEmails.id, id) }))!;
    expect((await byId(stuckId)).status).toBe("failed");
    expect((await byId(ancientId)).status).toBe("failed");
    expect((await byId(staleId)).status).toBe("queued");
    expect((await byId(freshId)).status).toBe("queued");

    // Reservations of the two failed rows released; stale + fresh keep theirs.
    expect(await usage(account.id)).toBe(2);
    expect(queue.messages).toEqual([
      { type: "send_transactional", emailId: staleId, accountId: account.id },
    ]);
  });

  it("prunes bodies of old terminal emails, leaving metadata and fresh rows alone", async () => {
    const now = Date.now();
    const oldId = await acceptedEmail({ to: ["old@example.com"] });
    const freshId = await acceptedEmail({ to: ["new@example.com"] });
    const provider = new RecordingProvider();
    await sendTransactionalEmail({ emailId: oldId, accountId: account.id }, { db: currentDb, emailProvider: provider });
    await sendTransactionalEmail({ emailId: freshId, accountId: account.id }, { db: currentDb, emailProvider: provider });

    await currentDb
      .update(transactionalEmails)
      .set({ createdAt: new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString() })
      .where(eq(transactionalEmails.id, oldId));

    const pruned = await pruneTransactionalBodies(currentDb, new Date(now));
    expect(pruned).toBe(1);

    const oldRow = (await currentDb.query.transactionalEmails.findFirst({
      where: eq(transactionalEmails.id, oldId),
    }))!;
    expect(oldRow.htmlBody).toBeNull();
    expect(oldRow.bodyPrunedAt).toBeTruthy();
    expect(oldRow.subject).toBe("Reset your password");

    const freshRow = (await currentDb.query.transactionalEmails.findFirst({
      where: eq(transactionalEmails.id, freshId),
    }))!;
    expect(freshRow.htmlBody).toContain("Click here");
  });
});
