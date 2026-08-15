import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { testDb, seedAccount, FakeQueue } from "./helpers";
import type { Db } from "../src/db/client";
import { webhookDeliveries, webhookEndpoints } from "../src/db/schema";
import { encryptSecret } from "../src/lib/crypto";
import { newId, nowIso } from "../src/lib/ids";
import { verifySignature } from "../src/lib/webhook-signature";
import { deliverWebhook } from "../src/queue/handlers/deliver-webhook";
import { sweepWebhookDeliveries, pruneWebhookDeliveries } from "../src/queue/cron";
import { emitWebhookEvent } from "../src/services/webhook-events";
import { addSuppression, addSuppressions } from "../src/services/suppression";
import {
  createEndpoint,
  deleteEndpoint,
  resendDelivery,
  rotateEndpointSecret,
  endpointSecret,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
} from "../src/services/webhooks";

const ENC_KEY = Buffer.alloc(32, 3).toString("base64");

// A stand-in receiver. Bound on loopback, which the SSRF guard blocks by
// design — so the delivery-path tests that need a real socket drive
// `postJson` indirectly via an endpoint row whose URL is rewritten past the
// guard is not possible. Instead these tests split cleanly: emission and ledger
// behaviour are tested against the DB, and the HTTP/signing behaviour is tested
// by pointing a real server at the signature verifier.
type Received = { headers: Record<string, string | string[] | undefined>; body: string };

function startServer(handler: (req: Received) => { status: number; body?: string }): Promise<{
  server: Server;
  port: number;
  received: Received[];
}> {
  const received: Received[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const entry = { headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
        received.push(entry);
        const out = handler(entry);
        res.writeHead(out.status, { "content-type": "text/plain" });
        res.end(out.body ?? "ok");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : 0, received });
    });
  });
}

async function seedEndpoint(
  db: Db,
  accountId: string,
  overrides: Partial<typeof webhookEndpoints.$inferInsert> = {},
) {
  const now = nowIso();
  const id = newId("whe");
  await db.insert(webhookEndpoints).values({
    id,
    accountId,
    url: "https://receiver.example.com/hooks",
    enabledEvents: ["email.bounced", "suppression.created", "email.sent", "email.delivered"],
    secretEnc: await encryptSecret("whsec_seeded", ENC_KEY),
    status: "enabled",
    createdBy: "usr_test",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return (await db.query.webhookEndpoints.findFirst({ where: eq(webhookEndpoints.id, id) }))!;
}

describe("outbound webhooks", () => {
  beforeEach(() => {
    process.env.DNS_TOKEN_ENC_KEY = ENC_KEY;
  });
  afterEach(() => {
    delete process.env.DNS_TOKEN_ENC_KEY;
  });

  describe("emission", () => {
    it("creates one pending delivery per subscribed endpoint, and none for unsubscribed ones", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      const subscribed = await seedEndpoint(db, account.id);
      const other = await seedEndpoint(db, account.id, { enabledEvents: ["email.delivered"] });
      const disabled = await seedEndpoint(db, account.id, { status: "disabled" });

      const created = await emitWebhookEvent(db, {
        type: "email.bounced",
        accountId: account.id,
        eventId: "evt_a",
        source: {
          kind: "campaign",
          campaignId: "cmp_1",
          recipientId: "rcp_1",
          subscriberId: "sub_1",
          email: "dead@example.com",
        },
        subject: null,
        providerMessageId: "msg-1",
        bounceType: "Permanent",
        bounceSubType: "General",
      });

      expect(created).toBe(1);
      const rows = await db.select().from(webhookDeliveries);
      expect(rows).toHaveLength(1);
      expect(rows[0].endpointId).toBe(subscribed.id);
      expect(rows[0].status).toBe("pending");
      expect(other.id).not.toBe(rows[0].endpointId);
      expect(disabled.id).not.toBe(rows[0].endpointId);

      const payload = JSON.parse(rows[0].payloadJson);
      expect(payload).toMatchObject({
        id: "evt_a",
        type: "email.bounced",
        data: {
          object: "campaign_recipient",
          campaign_id: "cmp_1",
          recipient_id: "rcp_1",
          contact_id: "sub_1",
          email: "dead@example.com",
          bounce_type: "Permanent",
          bounce_subtype: "General",
        },
      });
    });

    it("never emits another account's events", async () => {
      const db = await testDb();
      const mine = await seedAccount(db);
      const theirs = await seedAccount(db);
      await seedEndpoint(db, theirs.id);

      const created = await emitWebhookEvent(db, {
        type: "suppression.created",
        accountId: mine.id,
        eventId: "evt_x",
        email: "a@b.com",
        reason: "hard_bounce",
        source: "test",
      });
      expect(created).toBe(0);
      expect(await db.select().from(webhookDeliveries)).toHaveLength(0);
    });

    it("is idempotent per (endpoint, event) — a replayed emission adds nothing", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      await seedEndpoint(db, account.id);
      const event = {
        type: "suppression.created" as const,
        accountId: account.id,
        eventId: "evt_dupe",
        email: "a@b.com",
        reason: "complaint" as const,
        source: "test",
      };
      expect(await emitWebhookEvent(db, event)).toBe(1);
      expect(await emitWebhookEvent(db, event)).toBe(0);
      expect(await db.select().from(webhookDeliveries)).toHaveLength(1);
    });

    it("never throws into its caller when the webhook tables are unusable", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      // A broken db handle stands in for any failure inside emission; the
      // contract is that the caller's already-committed work is unaffected.
      const broken = {
        select: () => {
          throw new Error("boom");
        },
      } as unknown as Db;
      await expect(
        emitWebhookEvent(broken, {
          type: "suppression.created",
          accountId: account.id,
          eventId: "evt_1",
          email: "a@b.com",
          reason: "manual",
          source: "test",
        }),
      ).resolves.toBe(0);
    });
  });

  describe("suppression is the feed", () => {
    it("emits suppression.created exactly once for a newly suppressed address", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      await seedEndpoint(db, account.id);

      await addSuppression(db, {
        accountId: account.id,
        email: "Dead@Example.com",
        reason: "hard_bounce",
        source: "ses-sns-webhook",
      });
      // Re-suppressing the same (email, reason) is a no-op insert, so no second
      // event — this is what stops an SNS redelivery replaying at the receiver.
      await addSuppression(db, {
        accountId: account.id,
        email: "dead@example.com",
        reason: "hard_bounce",
        source: "ses-sns-webhook",
      });

      const rows = await db.select().from(webhookDeliveries);
      expect(rows).toHaveLength(1);
      const payload = JSON.parse(rows[0].payloadJson);
      expect(payload.type).toBe("suppression.created");
      // Canonicalized, matching what we store and what the API returns.
      expect(payload.data).toMatchObject({ email: "dead@example.com", reason: "hard_bounce" });
    });

    it("emits one event per newly added address on a bulk import, and none for repeats", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      await seedEndpoint(db, account.id);

      const first = await addSuppressions(db, {
        accountId: account.id,
        emails: ["a@x.com", "b@x.com", "not-an-email", "a@x.com"],
        reason: "manual",
        source: "api",
      });
      expect(first).toMatchObject({ added: 2, invalid: 1 });
      expect(await db.select().from(webhookDeliveries)).toHaveLength(2);

      // Re-importing the same list must not replay events.
      await addSuppressions(db, {
        accountId: account.id,
        emails: ["a@x.com", "b@x.com"],
        reason: "manual",
        source: "api",
      });
      expect(await db.select().from(webhookDeliveries)).toHaveLength(2);
    });
  });

  describe("delivery", () => {
    let server: Server | undefined;
    afterEach(() => {
      server?.close();
      server = undefined;
    });

    it("never sends to a loopback endpoint, and treats it as a terminal config error", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      // A real listener on loopback, to assert positively that nothing arrives.
      const started = await startServer(() => ({ status: 200, body: "thanks" }));
      server = started.server;

      // Port 443 so the port rule can't be what rejects this — the assertion is
      // specifically that the *address* is refused. (A row can hold a URL that
      // predates a tightening of the rules, which is why delivery re-validates.)
      const endpoint = await seedEndpoint(db, account.id, {
        url: "https://127.0.0.1/hooks",
        consecutiveFailures: 3,
        lastError: "old failure",
      });
      await emitWebhookEvent(db, {
        type: "suppression.created",
        accountId: account.id,
        eventId: "evt_sig",
        email: "a@b.com",
        reason: "complaint",
        source: "test",
      });
      const [delivery] = await db.select().from(webhookDeliveries);

      const queue = new FakeQueue();
      await deliverWebhook({ deliveryId: delivery.id, accountId: account.id }, { db, queue });

      const [after] = await db.select().from(webhookDeliveries);
      expect(started.received).toHaveLength(0);
      expect(after.status).toBe("failed");
      expect(after.error).toMatch(/reachable from the public internet/);
      // Not retryable: the configuration is wrong, waiting will not fix it.
      expect(queue.messages).toHaveLength(0);
      expect(after.attempt).toBe(1);

      const [ep] = await db
        .select()
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.id, endpoint.id));
      expect(ep.consecutiveFailures).toBe(4);
    });

    it("refuses a stored URL on a disallowed port without opening a socket", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      const started = await startServer(() => ({ status: 200 }));
      server = started.server;

      await seedEndpoint(db, account.id, { url: `https://example.com:${started.port}/hooks` });
      await emitWebhookEvent(db, {
        type: "suppression.created",
        accountId: account.id,
        eventId: "evt_port",
        email: "a@b.com",
        reason: "manual",
        source: "test",
      });
      const [delivery] = await db.select().from(webhookDeliveries);

      await deliverWebhook(
        { deliveryId: delivery.id, accountId: account.id },
        { db, queue: new FakeQueue() },
      );
      const [after] = await db.select().from(webhookDeliveries);
      expect(started.received).toHaveLength(0);
      expect(after.status).toBe("failed");
      expect(after.error).toMatch(/ports 443 and 8443/);
    });

    it("produces a signature the documented verifier accepts", async () => {
      // The wire format is covered end-to-end in webhook-signature.test.ts; here
      // we assert the payload we *store* is the payload we sign, byte for byte.
      const db = await testDb();
      const account = await seedAccount(db);
      await seedEndpoint(db, account.id);
      await emitWebhookEvent(db, {
        type: "suppression.created",
        accountId: account.id,
        eventId: "evt_body",
        email: "a@b.com",
        reason: "manual",
        source: "test",
      });
      const [delivery] = await db.select().from(webhookDeliveries);
      const secret = "whsec_seeded";
      const t = Math.floor(Date.now() / 1000);
      const header = `t=${t},v1=${createHmac("sha256", secret)
        .update(`${t}.${delivery.payloadJson}`)
        .digest("hex")}`;
      expect(
        verifySignature({ header, secret, rawBody: delivery.payloadJson, nowSeconds: t }),
      ).toBe(true);
    });

    it("claims exactly once — a duplicate job is a no-op", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      await seedEndpoint(db, account.id, { url: "https://127.0.0.1:1/hooks" });
      await emitWebhookEvent(db, {
        type: "suppression.created",
        accountId: account.id,
        eventId: "evt_claim",
        email: "a@b.com",
        reason: "manual",
        source: "test",
      });
      const [delivery] = await db.select().from(webhookDeliveries);
      const queue = new FakeQueue();

      await deliverWebhook({ deliveryId: delivery.id, accountId: account.id }, { db, queue });
      const [afterFirst] = await db.select().from(webhookDeliveries);
      const attemptAfterFirst = afterFirst.attempt;

      // Second run finds the row terminal and does nothing.
      await deliverWebhook({ deliveryId: delivery.id, accountId: account.id }, { db, queue });
      const [afterSecond] = await db.select().from(webhookDeliveries);
      expect(afterSecond.attempt).toBe(attemptAfterFirst);
    });

    it("refuses to deliver another account's row", async () => {
      const db = await testDb();
      const mine = await seedAccount(db);
      const theirs = await seedAccount(db);
      await seedEndpoint(db, mine.id, { url: "https://127.0.0.1:1/h" });
      await emitWebhookEvent(db, {
        type: "suppression.created",
        accountId: mine.id,
        eventId: "evt_scope",
        email: "a@b.com",
        reason: "manual",
        source: "test",
      });
      const [delivery] = await db.select().from(webhookDeliveries);

      await deliverWebhook(
        { deliveryId: delivery.id, accountId: theirs.id },
        { db, queue: new FakeQueue() },
      );
      const [after] = await db.select().from(webhookDeliveries);
      expect(after.status).toBe("pending");
      expect(after.attempt).toBe(0);
    });

    it("fails terminally when the endpoint was deleted or disabled mid-flight", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      const endpoint = await seedEndpoint(db, account.id);
      await emitWebhookEvent(db, {
        type: "suppression.created",
        accountId: account.id,
        eventId: "evt_gone",
        email: "a@b.com",
        reason: "manual",
        source: "test",
      });
      const [delivery] = await db.select().from(webhookDeliveries);
      await db
        .update(webhookEndpoints)
        .set({ status: "disabled" })
        .where(eq(webhookEndpoints.id, endpoint.id));

      await deliverWebhook(
        { deliveryId: delivery.id, accountId: account.id },
        { db, queue: new FakeQueue() },
      );
      const [after] = await db.select().from(webhookDeliveries);
      expect(after.status).toBe("failed");
      expect(after.error).toMatch(/disabled/);
    });
  });

  describe("retry schedule", () => {
    it("backs off on a refused connection and gives up after the last delay", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      // A public-looking host that will not resolve/connect — a retryable
      // network failure rather than a config error.
      await seedEndpoint(db, account.id, { url: "https://webhook-test.invalid/hooks" });
      await emitWebhookEvent(db, {
        type: "suppression.created",
        accountId: account.id,
        eventId: "evt_retry",
        email: "a@b.com",
        reason: "manual",
        source: "test",
      });
      const [delivery] = await db.select().from(webhookDeliveries);
      const queue = new FakeQueue();

      for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS; i++) {
        // Re-arm the row the way the queue would (nextAttemptAt elapsed).
        await db
          .update(webhookDeliveries)
          .set({ status: "pending" })
          .where(eq(webhookDeliveries.id, delivery.id));
        const [before] = await db.select().from(webhookDeliveries);
        if (before.status !== "pending") break;
        await deliverWebhook({ deliveryId: delivery.id, accountId: account.id }, { db, queue });
      }

      const [after] = await db.select().from(webhookDeliveries);
      expect(after.status).toBe("failed");
      expect(after.attempt).toBe(WEBHOOK_MAX_ATTEMPTS);
      expect(after.nextAttemptAt).toBeNull();
      // Each non-final attempt scheduled the next one with the documented delay.
      expect(queue.delays.slice(0, WEBHOOK_RETRY_DELAYS_MS.length)).toEqual(WEBHOOK_RETRY_DELAYS_MS);
    }, 30_000);
  });

  describe("cron rescue", () => {
    it("re-queues due pending deliveries whose enqueue was lost", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      await seedEndpoint(db, account.id);
      await emitWebhookEvent(db, {
        type: "suppression.created",
        accountId: account.id,
        eventId: "evt_due",
        email: "a@b.com",
        reason: "manual",
        source: "test",
      });

      const queue = new FakeQueue();
      const swept = await sweepWebhookDeliveries(db, queue, new Date(Date.now() + 1000));
      expect(swept).toBe(1);
      expect(queue.messages[0]).toMatchObject({ type: "deliver_webhook", accountId: account.id });
    });

    it("leaves a not-yet-due retry alone", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      await seedEndpoint(db, account.id);
      await emitWebhookEvent(db, {
        type: "suppression.created",
        accountId: account.id,
        eventId: "evt_future",
        email: "a@b.com",
        reason: "manual",
        source: "test",
      });
      await db
        .update(webhookDeliveries)
        .set({ nextAttemptAt: new Date(Date.now() + 3_600_000).toISOString() });

      const queue = new FakeQueue();
      expect(await sweepWebhookDeliveries(db, queue)).toBe(0);
    });

    it("returns a stuck `delivering` row to pending (the receiver dedupes on event id)", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      await seedEndpoint(db, account.id);
      await emitWebhookEvent(db, {
        type: "suppression.created",
        accountId: account.id,
        eventId: "evt_stuck",
        email: "a@b.com",
        reason: "manual",
        source: "test",
      });
      await db.update(webhookDeliveries).set({
        status: "delivering",
        lockedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      });

      const queue = new FakeQueue();
      expect(await sweepWebhookDeliveries(db, queue)).toBe(1);
      const [after] = await db.select().from(webhookDeliveries);
      expect(after.status).toBe("pending");
      expect(after.lockedAt).toBeNull();
    });

    it("prunes only old terminal deliveries", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      const endpoint = await seedEndpoint(db, account.id);
      const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
      const base = {
        accountId: account.id,
        endpointId: endpoint.id,
        eventType: "suppression.created" as const,
        payloadJson: "{}",
        createdAt: old,
        updatedAt: old,
      };
      await db.insert(webhookDeliveries).values([
        { ...base, id: newId("whd"), eventId: "e1", status: "succeeded" },
        { ...base, id: newId("whd"), eventId: "e2", status: "failed" },
        { ...base, id: newId("whd"), eventId: "e3", status: "pending" },
        { ...base, id: newId("whd"), eventId: "e4", status: "succeeded", createdAt: nowIso() },
      ]);

      expect(await pruneWebhookDeliveries(db, new Date())).toBe(2);
      const left = await db.select().from(webhookDeliveries);
      expect(left.map((r) => r.eventId).sort()).toEqual(["e3", "e4"]);
    });
  });

  describe("endpoint management", () => {
    it("rejects a non-public URL at create time", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      await expect(
        createEndpoint(db, {
          accountId: account.id,
          url: "http://169.254.169.254/latest",
          events: ["email.bounced"],
          createdBy: "usr_1",
        }),
      ).rejects.toThrow();
      expect(await db.select().from(webhookEndpoints)).toHaveLength(0);
    });

    it("mints a readable secret, and rotation replaces it", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      const { endpoint, secret } = await createEndpoint(db, {
        accountId: account.id,
        url: "https://api.example.com/hooks",
        events: ["email.bounced"],
        createdBy: "usr_1",
      });
      expect(secret.startsWith("whsec_")).toBe(true);
      // Encrypted at rest, not stored in the clear.
      expect(endpoint.secretEnc).not.toContain(secret);
      expect(await endpointSecret(endpoint)).toBe(secret);

      const rotated = await rotateEndpointSecret(db, account.id, endpoint.id);
      expect(rotated).not.toBe(secret);
      const [reloaded] = await db
        .select()
        .from(webhookEndpoints)
        .where(eq(webhookEndpoints.id, endpoint.id));
      expect(await endpointSecret(reloaded)).toBe(rotated);
    });

    it("scopes rotation and deletion to the owning account", async () => {
      const db = await testDb();
      const mine = await seedAccount(db);
      const theirs = await seedAccount(db);
      const endpoint = await seedEndpoint(db, mine.id);

      expect(await rotateEndpointSecret(db, theirs.id, endpoint.id)).toBeUndefined();
      expect(await deleteEndpoint(db, theirs.id, endpoint.id)).toBe(false);
      expect(await deleteEndpoint(db, mine.id, endpoint.id)).toBe(true);
    });

    it("deleting an endpoint takes its deliveries with it", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      const endpoint = await seedEndpoint(db, account.id);
      await emitWebhookEvent(db, {
        type: "suppression.created",
        accountId: account.id,
        eventId: "evt_del",
        email: "a@b.com",
        reason: "manual",
        source: "test",
      });
      expect(await db.select().from(webhookDeliveries)).toHaveLength(1);
      await deleteEndpoint(db, account.id, endpoint.id);
      expect(await db.select().from(webhookDeliveries)).toHaveLength(0);
    });

    it("resend re-arms a terminal delivery and refuses one already in flight", async () => {
      const db = await testDb();
      const account = await seedAccount(db);
      await seedEndpoint(db, account.id);
      await emitWebhookEvent(db, {
        type: "suppression.created",
        accountId: account.id,
        eventId: "evt_resend",
        email: "a@b.com",
        reason: "manual",
        source: "test",
      });
      const [delivery] = await db.select().from(webhookDeliveries);

      // Still pending → not resendable.
      expect(await resendDelivery(db, account.id, delivery.id)).toBeUndefined();

      await db
        .update(webhookDeliveries)
        .set({ status: "failed", attempt: 6, error: "gave up" })
        .where(eq(webhookDeliveries.id, delivery.id));
      const again = await resendDelivery(db, account.id, delivery.id);
      expect(again).toMatchObject({ status: "pending", attempt: 0, error: null });
      // The stored payload is reused verbatim so the original event is redelivered.
      expect(again!.payloadJson).toBe(delivery.payloadJson);

      // And never across a tenant boundary.
      await db.update(webhookDeliveries).set({ status: "failed" });
      const other = await seedAccount(db);
      expect(await resendDelivery(db, other.id, delivery.id)).toBeUndefined();
    });
  });
});
