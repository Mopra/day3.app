import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import {
  automationEnrollments,
  automations,
  campaignRecipients,
  emailEvents,
  forms,
  notifications,
  subscribers,
  type Form,
} from "../src/db/schema";
import type { AutomationGraph } from "../src/lib/automation-graph";
import { newId, nowIso } from "../src/lib/ids";
import { sweepAutomationEnrollments } from "../src/queue/cron";
import { advanceAutomationEnrollment } from "../src/queue/handlers/automation-advance";
import { sendAutomationNode } from "../src/queue/handlers/automation-send";
import { runAutomationTick } from "../src/queue/handlers/automation-tick";
import {
  LOOP_GUARD_NOTIFICATION_KIND,
  advanceEnrollment,
  nextWindowOpen,
} from "../src/services/automation-engine";
import { enrollAudienceJoin, enrollSubscriber } from "../src/services/automation-enroll";
import { confirmFormSignup } from "../src/services/form-confirm";
import { submitFormSignup } from "../src/services/form-signup";
import { recordOpen } from "../src/services/open-tracking";
import { addSuppression } from "../src/services/suppression";
import {
  FakeQueue,
  RecordingProvider,
  asQueue,
  seedAccount,
  seedAudience,
  seedAutomation,
  seedDomain,
  seedMember,
  seedSubscribers,
  testDb,
} from "./helpers";

const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000).toISOString();
const daysAgo = (d: number) => minutesAgo(d * 24 * 60);

// trigger -> send -> wait 1h -> branch(first_name equals alice) yes -> send -> end
//                                                            no  -> end
const FLOW: AutomationGraph = {
  nodes: [
    { key: "nd_trigger", kind: "trigger", config: {} },
    { key: "nd_send1", kind: "send", config: { subject: "Welcome {{first_name}}", htmlBody: "<p>Hi {{first_name}}, <a href=\"https://example.com/start\">start here</a>.</p>" } },
    { key: "nd_wait", kind: "wait", config: { value: 1, unit: "hours" } },
    {
      key: "nd_branch",
      kind: "branch",
      config: {
        condition: {
          kind: "filter",
          filter: { match: "all", conditions: [{ field: "first_name", op: "equals", value: "alice" }] },
        },
      },
    },
    { key: "nd_send2", kind: "send", config: { subject: "Next steps", htmlBody: "<p>Step two.</p>" } },
    { key: "nd_end", kind: "end", config: {} },
  ],
  edges: [
    { fromKey: "nd_trigger", port: "next", toKey: "nd_send1" },
    { fromKey: "nd_send1", port: "next", toKey: "nd_wait" },
    { fromKey: "nd_wait", port: "next", toKey: "nd_branch" },
    { fromKey: "nd_branch", port: "yes", toKey: "nd_send2" },
    { fromKey: "nd_branch", port: "no", toKey: "nd_end" },
    { fromKey: "nd_send2", port: "next", toKey: "nd_end" },
  ],
};

const ONE_SEND: AutomationGraph = {
  nodes: [
    { key: "nd_trigger", kind: "trigger", config: {} },
    { key: "nd_send1", kind: "send", config: { subject: "Welcome", htmlBody: "<p>Hello</p>" } },
  ],
  edges: [{ fromKey: "nd_trigger", port: "next", toKey: "nd_send1" }],
};

async function setup(accountOverrides: Record<string, unknown> = {}) {
  const db = await testDb();
  const account = await seedAccount(db, accountOverrides);
  const domain = await seedDomain(db, account.id);
  const audience = await seedAudience(db, account.id);
  const subs = await seedSubscribers(db, account.id, audience.id, [
    "alice@example.com",
    "bob@example.com",
  ]);
  const alice = subs.find((s) => s.email === "alice@example.com")!;
  const bob = subs.find((s) => s.email === "bob@example.com")!;
  return { db, account, domain, audience, alice, bob };
}

function sendDeps(db: Db, queue: FakeQueue, provider: RecordingProvider) {
  return {
    db,
    queue: asQueue(queue),
    emailProvider: provider,
    appUrl: "http://localhost:5173",
    unsubscribeSecret: "test-secret",
  };
}

async function enrollmentRow(db: Db, id: string) {
  return (await db.query.automationEnrollments.findFirst({
    where: eq(automationEnrollments.id, id),
  }))!;
}

async function ledgerRows(db: Db, enrollmentId: string) {
  return db
    .select()
    .from(campaignRecipients)
    .where(eq(campaignRecipients.automationEnrollmentId, enrollmentId));
}

describe("enrollSubscriber gates", () => {
  it("refuses an automation that is not live", async () => {
    const { db, account, audience, alice } = await setup();
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: ONE_SEND,
      status: "draft",
    });
    const r = await enrollSubscriber(db, null, { automation, subscriberId: alice.id, source: "manual" });
    expect(r).toEqual({ outcome: "automation_not_active", enrollmentId: null });
  });

  it("refuses a subscriber from another audience and an unsubscribed one", async () => {
    const { db, account, audience, alice, bob } = await setup();
    const other = await seedAudience(db, account.id);
    const stranger = (await seedSubscribers(db, account.id, other.id, ["stranger@example.com"])).find(
      (s) => s.email === "stranger@example.com",
    )!;
    await db
      .update(subscribers)
      .set({ status: "unsubscribed" })
      .where(eq(subscribers.id, bob.id));
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: ONE_SEND,
    });
    expect(
      (await enrollSubscriber(db, null, { automation, subscriberId: stranger.id, source: "manual" }))
        .outcome,
    ).toBe("wrong_audience");
    expect(
      (await enrollSubscriber(db, null, { automation, subscriberId: bob.id, source: "manual" })).outcome,
    ).toBe("not_subscribed");
    expect(
      (await enrollSubscriber(db, null, { automation, subscriberId: alice.id, source: "manual" })).outcome,
    ).toBe("enrolled");
  });

  it("refuses a suppressed address and an entry-filter miss", async () => {
    const { db, account, audience, alice, bob } = await setup();
    await addSuppression(db, { accountId: account.id, email: alice.email, reason: "hard_bounce" });
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: ONE_SEND,
      entryFilterJson: JSON.stringify({
        match: "all",
        conditions: [{ field: "first_name", op: "equals", value: "alice" }],
      }),
    });
    expect(
      (await enrollSubscriber(db, null, { automation, subscriberId: alice.id, source: "manual" })).outcome,
    ).toBe("suppressed");
    expect(
      (await enrollSubscriber(db, null, { automation, subscriberId: bob.id, source: "manual" })).outcome,
    ).toBe("entry_filter_no_match");
  });

  it("enforces re-entry: once refuses a second enrollment, always allows it", async () => {
    const { db, account, audience, alice } = await setup();
    const once = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: ONE_SEND,
      reentry: "once",
    });
    const always = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: ONE_SEND,
      reentry: "always",
    });
    const queue = new FakeQueue();
    const first = await enrollSubscriber(db, asQueue(queue), {
      automation: once.automation,
      subscriberId: alice.id,
      source: "manual",
    });
    expect(first.outcome).toBe("enrolled");
    expect(first.enrollmentId).toBeTruthy();
    // The immediate path: an advance job for the new row.
    expect(queue.messages).toEqual([
      { type: "advance_automation_enrollment", enrollmentId: first.enrollmentId, accountId: account.id },
    ]);
    const second = await enrollSubscriber(db, asQueue(queue), {
      automation: once.automation,
      subscriberId: alice.id,
      source: "api",
    });
    expect(second).toEqual({ outcome: "already_enrolled", enrollmentId: null });

    const a1 = await enrollSubscriber(db, null, { automation: always.automation, subscriberId: alice.id, source: "api" });
    const a2 = await enrollSubscriber(db, null, { automation: always.automation, subscriberId: alice.id, source: "api" });
    expect(a1.outcome).toBe("enrolled");
    expect(a2.outcome).toBe("enrolled");
    expect(a1.enrollmentId).not.toBe(a2.enrollmentId);
  });

  it("sandbox automations only enroll org members", async () => {
    const { db, account, audience, alice, bob } = await setup();
    await seedMember(db, account.id, alice.email);
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: ONE_SEND,
      sandbox: true,
    });
    expect(
      (await enrollSubscriber(db, null, { automation, subscriberId: bob.id, source: "manual" })).outcome,
    ).toBe("sandbox_not_member");
    const r = await enrollSubscriber(db, null, { automation, subscriberId: alice.id, source: "manual" });
    expect(r.outcome).toBe("enrolled");
    const row = await enrollmentRow(db, r.enrollmentId!);
    expect(row.sandbox).toBe(true);
    expect(row.currentNodeKey).toBe("nd_trigger");
    expect(row.status).toBe("active");
  });
});

describe("the engine runs a flow end to end", () => {
  it("trigger -> send -> wait -> branch -> send -> end", async () => {
    const { db, account, audience, alice, bob } = await setup();
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: FLOW,
    });
    const queue = new FakeQueue();
    const provider = new RecordingProvider();

    const enrolled = await enrollSubscriber(db, asQueue(queue), {
      automation,
      subscriberId: alice.id,
      source: "manual",
    });
    const enrollmentId = enrolled.enrollmentId!;
    expect(queue.messages.map((m) => m.type)).toEqual(["advance_automation_enrollment"]);

    // Advancing walks trigger -> send inline and hands off to the send job.
    await advanceAutomationEnrollment({ enrollmentId, accountId: account.id }, { db, queue: asQueue(queue) });
    let row = await enrollmentRow(db, enrollmentId);
    expect(row.status).toBe("sending");
    expect(row.currentNodeKey).toBe("nd_send1");
    expect(row.lockedAt).toBeTruthy();
    expect(queue.messages.at(-1)).toEqual({
      type: "send_automation_node",
      enrollmentId,
      accountId: account.id,
    });

    // The send job writes the shared ledger with the automation columns set and
    // campaign_id null, then parks the cursor on the wait with a future due time.
    await sendAutomationNode({ enrollmentId, accountId: account.id }, sendDeps(db, queue, provider));
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].toEmail).toBe("alice@example.com");
    expect(provider.sent[0].subject).toBe("Welcome alice");
    expect(provider.sent[0].html).toContain("/unsubscribe?token=");
    expect(provider.sent[0].html).toContain("/api/track/open?t=");
    expect(provider.sent[0].html).toContain("/api/track/click?t=");
    expect(provider.sent[0].headers?.["List-Unsubscribe"]).toContain("http");
    expect(provider.sent[0].headers?.["X-Automation-ID"]).toBe(automation.id);

    const ledger = await ledgerRows(db, enrollmentId);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      campaignId: null,
      automationId: automation.id,
      automationEnrollmentId: enrollmentId,
      automationNodeKey: "nd_send1",
      visitNo: 0,
      subscriberId: alice.id,
      email: "alice@example.com",
      status: "sent",
    });
    expect(ledger[0].providerMessageId).toBeTruthy();
    const sentEvents = await db
      .select()
      .from(emailEvents)
      .where(eq(emailEvents.campaignRecipientId, ledger[0].id));
    expect(sentEvents).toHaveLength(1);
    expect(sentEvents[0]).toMatchObject({
      eventType: "sent",
      campaignId: null,
      automationId: automation.id,
      automationNodeKey: "nd_send1",
    });

    row = await enrollmentRow(db, enrollmentId);
    expect(row.status).toBe("active");
    expect(row.currentNodeKey).toBe("nd_wait");
    expect(row.sendCount).toBe(1);
    expect(row.lockedAt).toBeNull();
    expect(Date.parse(row.nextRunAt!)).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
    // Nothing to advance until the wait elapses, so no advance job was queued.
    expect(queue.messages.filter((m) => m.type === "advance_automation_enrollment")).toHaveLength(1);

    // Not due: the tick leaves it alone.
    const idle = await runAutomationTick({ db, queue: asQueue(queue) });
    expect(idle.advanced).toBe(0);

    // Fast-forward the wait. The tick claims it, the branch routes alice down
    // "yes" (a filter on her first name) and the second send is dispatched.
    await db
      .update(automationEnrollments)
      .set({ nextRunAt: minutesAgo(1) })
      .where(eq(automationEnrollments.id, enrollmentId));
    const tick = await runAutomationTick({ db, queue: asQueue(queue) });
    expect(tick.advanced).toBe(1);
    row = await enrollmentRow(db, enrollmentId);
    expect(row.status).toBe("sending");
    expect(row.currentNodeKey).toBe("nd_send2");

    await sendAutomationNode({ enrollmentId, accountId: account.id }, sendDeps(db, queue, provider));
    expect(provider.sent).toHaveLength(2);
    expect(provider.sent[1].subject).toBe("Next steps");
    row = await enrollmentRow(db, enrollmentId);
    expect(row.status).toBe("completed");
    expect(row.completedAt).toBeTruthy();
    expect(row.currentNodeKey).toBe("nd_end");
    expect(row.sendCount).toBe(2);
    expect(row.visitCount).toBe(4); // send1, wait, branch, send2

    // Open tracking on an automation send attributes the event to the flow.
    await recordOpen(db, {
      accountId: account.id,
      campaignRecipientId: ledger[0].id,
      email: alice.email,
    });
    const opens = await db
      .select()
      .from(emailEvents)
      .where(and(eq(emailEvents.campaignRecipientId, ledger[0].id), eq(emailEvents.eventType, "open")));
    expect(opens).toHaveLength(1);
    expect(opens[0].automationId).toBe(automation.id);
    expect(opens[0].automationNodeKey).toBe("nd_send1");
    expect(opens[0].campaignId).toBeNull();

    // Bob takes the "no" branch straight to the end after his first email.
    const bobEnrolled = await enrollSubscriber(db, null, { automation, subscriberId: bob.id, source: "manual" });
    await advanceEnrollment(db, { queue: asQueue(queue) }, bobEnrolled.enrollmentId!);
    await sendAutomationNode(
      { enrollmentId: bobEnrolled.enrollmentId!, accountId: account.id },
      sendDeps(db, queue, provider),
    );
    await db
      .update(automationEnrollments)
      .set({ nextRunAt: minutesAgo(1) })
      .where(eq(automationEnrollments.id, bobEnrolled.enrollmentId!));
    expect(await advanceEnrollment(db, { queue: asQueue(queue) }, bobEnrolled.enrollmentId!)).toBe(
      "completed",
    );
    expect(provider.sent).toHaveLength(3);
  });

  it("unsubscribing mid-flow exits the enrollment before the next node", async () => {
    const { db, account, audience, alice } = await setup();
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: FLOW,
    });
    const queue = new FakeQueue();
    const r = await enrollSubscriber(db, null, { automation, subscriberId: alice.id, source: "manual" });
    await db
      .update(subscribers)
      .set({ status: "unsubscribed" })
      .where(eq(subscribers.id, alice.id));
    expect(await advanceEnrollment(db, { queue: asQueue(queue) }, r.enrollmentId!)).toBe("exited");
    const row = await enrollmentRow(db, r.enrollmentId!);
    expect(row.exitReason).toBe("unsubscribed");
    expect(queue.messages).toHaveLength(0);
  });
});

describe("send_automation_node idempotency", () => {
  it("a redelivered send job never sends twice and still moves the cursor", async () => {
    const { db, account, audience, alice } = await setup();
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: FLOW,
    });
    const queue = new FakeQueue();
    const provider = new RecordingProvider();
    const r = await enrollSubscriber(db, null, { automation, subscriberId: alice.id, source: "manual" });
    const enrollmentId = r.enrollmentId!;
    await advanceEnrollment(db, { queue: asQueue(queue) }, enrollmentId);
    const message = { enrollmentId, accountId: account.id };

    await sendAutomationNode(message, sendDeps(db, queue, provider));
    expect(provider.sent).toHaveLength(1);

    // Same message again while the cursor already moved on: stale, dropped.
    await sendAutomationNode(message, sendDeps(db, queue, provider));
    expect(provider.sent).toHaveLength(1);

    // The crash-after-send case: the ledger says sent but the enrollment is
    // still `sending` on the node. The retry finds the terminal row, sends
    // nothing, and only completes the cursor move.
    const afterFirst = await enrollmentRow(db, enrollmentId);
    await db
      .update(automationEnrollments)
      .set({ status: "sending", currentNodeKey: "nd_send1", visitCount: 1, sendCount: 0, lockedAt: nowIso() })
      .where(eq(automationEnrollments.id, enrollmentId));
    await sendAutomationNode(message, sendDeps(db, queue, provider));
    expect(provider.sent).toHaveLength(1);
    const row = await enrollmentRow(db, enrollmentId);
    expect(row.status).toBe("active");
    expect(row.currentNodeKey).toBe("nd_wait");
    expect(row.sendCount).toBe(1);
    expect(afterFirst.currentNodeKey).toBe("nd_wait");
    expect(await ledgerRows(db, enrollmentId)).toHaveLength(1);

    const account1 = await db.query.accounts.findFirst({ where: (t, { eq }) => eq(t.id, account.id) });
    expect(account1?.monthlyEmailSentCount).toBe(1);
  });

  it("a render failure fails the node, releases the reservation and moves on", async () => {
    const { db, account, audience, alice } = await setup();
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: FLOW,
    });
    const queue = new FakeQueue();
    const provider = new RecordingProvider();
    const r = await enrollSubscriber(db, null, { automation, subscriberId: alice.id, source: "manual" });
    await advanceEnrollment(db, { queue: asQueue(queue) }, r.enrollmentId!);
    // An empty signing secret makes the unsubscribe-token HMAC import throw,
    // which is the pre-send render/token failure path.
    await sendAutomationNode(
      { enrollmentId: r.enrollmentId!, accountId: account.id },
      { ...sendDeps(db, queue, provider), unsubscribeSecret: "" },
    );

    expect(provider.sent).toHaveLength(0);
    const [ledger] = await ledgerRows(db, r.enrollmentId!);
    expect(ledger.status).toBe("failed");
    expect(ledger.error).toContain("render failed");
    const row = await enrollmentRow(db, r.enrollmentId!);
    expect(row.status).toBe("active");
    expect(row.currentNodeKey).toBe("nd_wait");
    expect(row.sendCount).toBe(0);
    // The unit reserved before the claim is given back: nothing was sent.
    const account1 = await db.query.accounts.findFirst({ where: (t, { eq }) => eq(t.id, account.id) });
    expect(account1?.monthlyEmailSentCount).toBe(0);
  });

  it("a permanent per-recipient failure records the node and moves on", async () => {
    const { db, account, audience, alice } = await setup();
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: FLOW,
    });
    const queue = new FakeQueue();
    const provider = new RecordingProvider();
    provider.results.set(0, { provider: "mock", status: "failed", error: "MessageRejected: bad address" });
    const r = await enrollSubscriber(db, null, { automation, subscriberId: alice.id, source: "manual" });
    await advanceEnrollment(db, { queue: asQueue(queue) }, r.enrollmentId!);
    await sendAutomationNode({ enrollmentId: r.enrollmentId!, accountId: account.id }, sendDeps(db, queue, provider));

    const [ledger] = await ledgerRows(db, r.enrollmentId!);
    expect(ledger.status).toBe("failed");
    expect(ledger.error).toContain("bad address");
    const row = await enrollmentRow(db, r.enrollmentId!);
    expect(row.status).toBe("active");
    expect(row.currentNodeKey).toBe("nd_wait");
    expect(row.sendCount).toBe(0);
    // The reservation for a never-sent email is given back.
    const account1 = await db.query.accounts.findFirst({ where: (t, { eq }) => eq(t.id, account.id) });
    expect(account1?.monthlyEmailSentCount).toBe(0);
  });
});

describe("loop guard", () => {
  it("exits with loop_guard and notifies the account once", async () => {
    const { db, account, audience, alice, bob } = await setup();
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: FLOW,
    });
    const queue = new FakeQueue();
    const a = await enrollSubscriber(db, null, { automation, subscriberId: alice.id, source: "manual" });
    const b = await enrollSubscriber(db, null, { automation, subscriberId: bob.id, source: "manual" });
    await db
      .update(automationEnrollments)
      .set({ visitCount: 200 })
      .where(eq(automationEnrollments.id, a.enrollmentId!));
    await db
      .update(automationEnrollments)
      .set({ sendCount: 50 })
      .where(eq(automationEnrollments.id, b.enrollmentId!));

    expect(await advanceEnrollment(db, { queue: asQueue(queue) }, a.enrollmentId!)).toBe("exited");
    expect(await advanceEnrollment(db, { queue: asQueue(queue) }, b.enrollmentId!)).toBe("exited");
    const rows = await db
      .select()
      .from(automationEnrollments)
      .where(eq(automationEnrollments.automationId, automation.id));
    expect(rows.every((r) => r.status === "exited" && r.exitReason === "loop_guard")).toBe(true);

    const notes = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.accountId, account.id), eq(notifications.kind, LOOP_GUARD_NOTIFICATION_KIND)),
      );
    expect(notes).toHaveLength(1);
    expect(notes[0].ctaHref).toBe(`/automations/${automation.id}`);
  });
});

describe("holds (design 5.6)", () => {
  it("quota exhaustion holds the enrollment rather than skipping the node", async () => {
    const { db, account, audience, alice } = await setup({ monthlyEmailLimit: 0 });
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: FLOW,
    });
    const queue = new FakeQueue();
    const provider = new RecordingProvider();
    const r = await enrollSubscriber(db, null, { automation, subscriberId: alice.id, source: "manual" });
    await advanceEnrollment(db, { queue: asQueue(queue) }, r.enrollmentId!);
    await sendAutomationNode({ enrollmentId: r.enrollmentId!, accountId: account.id }, sendDeps(db, queue, provider));

    expect(provider.sent).toHaveLength(0);
    const row = await enrollmentRow(db, r.enrollmentId!);
    expect(row.status).toBe("active");
    expect(row.currentNodeKey).toBe("nd_send1"); // not advanced
    expect(row.holdReason).toBe("quota");
    expect(row.heldSince).toBeTruthy();
    expect(row.lockedAt).toBeNull();
    expect(Date.parse(row.nextRunAt!)).toBeGreaterThan(Date.now() + 30 * 60 * 1000);
    expect(await ledgerRows(db, r.enrollmentId!)).toHaveLength(0);

    // The next tick leaves a held row alone until its retry time.
    expect((await runAutomationTick({ db, queue: asQueue(queue) })).advanced).toBe(0);
  });

  it("a hold older than the staleness cutoff skips the node as too_stale and moves on", async () => {
    const { db, account, audience, alice } = await setup({ monthlyEmailLimit: 0 });
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: FLOW,
    });
    const queue = new FakeQueue();
    const provider = new RecordingProvider();
    const r = await enrollSubscriber(db, null, { automation, subscriberId: alice.id, source: "manual" });
    await advanceEnrollment(db, { queue: asQueue(queue) }, r.enrollmentId!);
    await db
      .update(automationEnrollments)
      .set({ heldSince: daysAgo(8), holdReason: "quota" })
      .where(eq(automationEnrollments.id, r.enrollmentId!));
    await sendAutomationNode({ enrollmentId: r.enrollmentId!, accountId: account.id }, sendDeps(db, queue, provider));

    expect(provider.sent).toHaveLength(0);
    const [ledger] = await ledgerRows(db, r.enrollmentId!);
    expect(ledger.status).toBe("skipped");
    expect(ledger.error).toBe("too_stale");
    const row = await enrollmentRow(db, r.enrollmentId!);
    expect(row.status).toBe("active");
    expect(row.currentNodeKey).toBe("nd_wait");
    expect(row.holdReason).toBeNull();
    expect(row.heldSince).toBeNull();
  });

  it("the staleness clock survives the engine re-dispatching a held send node", async () => {
    // Quota is only known to the send handler, so a quota hold cycles engine ->
    // sending -> hold every hour. The engine must not reset heldSince on the way
    // through, or the 7-day cutoff never arrives and the hold is unbounded.
    const { db, account, audience, alice } = await setup({ monthlyEmailLimit: 0 });
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: FLOW,
    });
    const queue = new FakeQueue();
    const provider = new RecordingProvider();
    const r = await enrollSubscriber(db, null, { automation, subscriberId: alice.id, source: "manual" });
    await advanceEnrollment(db, { queue: asQueue(queue) }, r.enrollmentId!);
    await sendAutomationNode({ enrollmentId: r.enrollmentId!, accountId: account.id }, sendDeps(db, queue, provider));
    expect((await enrollmentRow(db, r.enrollmentId!)).holdReason).toBe("quota");

    // Eight days later the hold's retry comes due and the engine dispatches again.
    const heldSince = daysAgo(8);
    await db
      .update(automationEnrollments)
      .set({ heldSince, nextRunAt: minutesAgo(1) })
      .where(eq(automationEnrollments.id, r.enrollmentId!));
    expect(await advanceEnrollment(db, { queue: asQueue(queue) }, r.enrollmentId!)).toBe("sending");
    // The hand-off to the send job keeps the clock running.
    expect(Date.parse((await enrollmentRow(db, r.enrollmentId!)).heldSince!)).toBe(Date.parse(heldSince));
    await sendAutomationNode({ enrollmentId: r.enrollmentId!, accountId: account.id }, sendDeps(db, queue, provider));

    expect(provider.sent).toHaveLength(0);
    const [ledger] = await ledgerRows(db, r.enrollmentId!);
    expect(ledger.status).toBe("skipped");
    expect(ledger.error).toBe("too_stale");
    const row = await enrollmentRow(db, r.enrollmentId!);
    expect(row.status).toBe("active");
    expect(row.currentNodeKey).toBe("nd_wait");
    expect(row.holdReason).toBeNull();
    expect(row.heldSince).toBeNull();
  });

  it("a pause that lands between dispatch and send holds instead of sending", async () => {
    const { db, account, audience, alice } = await setup();
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: FLOW,
    });
    const queue = new FakeQueue();
    const provider = new RecordingProvider();
    const r = await enrollSubscriber(db, null, { automation, subscriberId: alice.id, source: "manual" });
    expect(await advanceEnrollment(db, { queue: asQueue(queue) }, r.enrollmentId!)).toBe("sending");
    await db.update(automations).set({ status: "paused" }).where(eq(automations.id, automation.id));

    await sendAutomationNode({ enrollmentId: r.enrollmentId!, accountId: account.id }, sendDeps(db, queue, provider));
    expect(provider.sent).toHaveLength(0);
    expect(await ledgerRows(db, r.enrollmentId!)).toHaveLength(0);
    const row = await enrollmentRow(db, r.enrollmentId!);
    expect(row.status).toBe("active");
    expect(row.currentNodeKey).toBe("nd_send1");
    expect(row.holdReason).toBe("automation_paused");
    expect(row.lockedAt).toBeNull();
    expect(Date.parse(row.nextRunAt!)).toBeGreaterThan(Date.now() + 4 * 60 * 1000);
    const account1 = await db.query.accounts.findFirst({ where: (t, { eq }) => eq(t.id, account.id) });
    expect(account1?.monthlyEmailSentCount).toBe(0);
  });

  it("a risk-paused account holds at the send node in the engine itself", async () => {
    const { db, account, audience, alice } = await setup({ riskStatus: "paused", sendingEnabled: false });
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: FLOW,
    });
    const queue = new FakeQueue();
    const r = await enrollSubscriber(db, null, { automation, subscriberId: alice.id, source: "manual" });
    expect(await advanceEnrollment(db, { queue: asQueue(queue) }, r.enrollmentId!)).toBe("held");
    const row = await enrollmentRow(db, r.enrollmentId!);
    expect(row.status).toBe("active");
    expect(row.holdReason).toBe("risk_paused");
    expect(queue.messages.filter((m) => m.type === "send_automation_node")).toHaveLength(0);
  });
});

describe("audience-join trigger", () => {
  async function seedForm(db: Db, accountId: string, audienceId: string, overrides: Partial<Form> = {}) {
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

  it("enrolls on double opt-in confirmation, not on the pending signup", async () => {
    const { db, account, audience } = await setup();
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: ONE_SEND,
    });
    const form = await seedForm(db, account.id, audience.id, { doubleOptIn: true });
    const queue = new FakeQueue();

    const signup = await submitFormSignup(db, asQueue(queue), { form, email: "new@example.com" });
    expect(signup.outcome).toBe("pending");
    expect(
      await db.select().from(automationEnrollments).where(eq(automationEnrollments.automationId, automation.id)),
    ).toHaveLength(0);

    const result = await confirmFormSignup(
      db,
      { accountId: account.id, subscriberId: signup.subscriberId!, formId: form.id, email: "new@example.com" },
      asQueue(queue),
    );
    expect(result.outcome).toBe("confirmed");
    const rows = await db
      .select()
      .from(automationEnrollments)
      .where(eq(automationEnrollments.automationId, automation.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].subscriberId).toBe(signup.subscriberId);
    expect(rows[0].status).toBe("active");
    expect(queue.messages.filter((m) => m.type === "advance_automation_enrollment")).toEqual([
      { type: "advance_automation_enrollment", enrollmentId: rows[0].id, accountId: account.id },
    ]);
  });

  it("respects a form-narrowed trigger and enrolls immediately on single opt-in", async () => {
    const { db, account, audience } = await setup();
    const formA = await seedForm(db, account.id, audience.id, { doubleOptIn: false });
    const formB = await seedForm(db, account.id, audience.id, { doubleOptIn: false });
    const narrowed = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: ONE_SEND,
      triggerFormId: formA.id,
    });
    const queue = new FakeQueue();
    await submitFormSignup(db, asQueue(queue), { form: formB, email: "b@example.com" });
    await submitFormSignup(db, asQueue(queue), { form: formA, email: "a@example.com" });
    const rows = await db
      .select()
      .from(automationEnrollments)
      .where(eq(automationEnrollments.automationId, narrowed.automation.id));
    expect(rows).toHaveLength(1);
    const sub = await db.query.subscribers.findFirst({ where: eq(subscribers.id, rows[0].subscriberId) });
    expect(sub?.email).toBe("a@example.com");

    // A manual add carries no form, so a form-narrowed trigger stays quiet.
    const manual = (await seedSubscribers(db, account.id, audience.id, ["manual@example.com"])).find(
      (s) => s.email === "manual@example.com",
    )!;
    await enrollAudienceJoin(db, asQueue(queue), {
      accountId: account.id,
      audienceId: audience.id,
      subscriberIds: [manual.id],
    });
    expect(
      await db.select().from(automationEnrollments).where(eq(automationEnrollments.automationId, narrowed.automation.id)),
    ).toHaveLength(1);
  });
});

describe("cron sweep", () => {
  it("fails stuck sending enrollments (never back to active) and re-enqueues overdue ones", async () => {
    const { db, account, audience, alice, bob } = await setup();
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: FLOW,
    });
    const stuck = await enrollSubscriber(db, null, { automation, subscriberId: alice.id, source: "manual" });
    const overdue = await enrollSubscriber(db, null, { automation, subscriberId: bob.id, source: "manual" });
    await db
      .update(automationEnrollments)
      .set({ status: "sending", currentNodeKey: "nd_send1", lockedAt: minutesAgo(20) })
      .where(eq(automationEnrollments.id, stuck.enrollmentId!));
    await db
      .update(automationEnrollments)
      .set({ nextRunAt: minutesAgo(10) })
      .where(eq(automationEnrollments.id, overdue.enrollmentId!));
    // A live send (fresh lock) must be spared.
    const carol = (await seedSubscribers(db, account.id, audience.id, ["carol@example.com"])).find(
      (s) => s.email === "carol@example.com",
    )!;
    const live = await enrollSubscriber(db, null, { automation, subscriberId: carol.id, source: "manual" });
    await db
      .update(automationEnrollments)
      .set({ status: "sending", currentNodeKey: "nd_send1", lockedAt: minutesAgo(1) })
      .where(eq(automationEnrollments.id, live.enrollmentId!));

    const queue = new FakeQueue();
    const result = await sweepAutomationEnrollments(db, asQueue(queue), new Date());
    expect(result.failed).toBe(1);
    expect(result.requeued).toBe(1);

    const failed = await enrollmentRow(db, stuck.enrollmentId!);
    expect(failed.status).toBe("failed");
    expect(failed.lastError).toContain("stuck lock");
    expect(failed.lockedAt).toBeNull();
    expect((await enrollmentRow(db, live.enrollmentId!)).status).toBe("sending");
    expect(queue.messages).toEqual([
      { type: "advance_automation_enrollment", enrollmentId: overdue.enrollmentId, accountId: account.id },
    ]);

    // A failed enrollment is final for the tick too.
    expect((await runAutomationTick({ db, queue: asQueue(new FakeQueue()) })).advanced).toBe(1);
    expect((await enrollmentRow(db, stuck.enrollmentId!)).status).toBe("failed");
  });

  it("resolves the pending ledger row a failed enrollment leaves behind", async () => {
    // The transient path gives the ledger row back as `pending` and throws for
    // BullMQ; once the retries run out and the enrollment is swept, nothing is
    // left to claim that row, so the sweep must not leave it counting as in-flight.
    const { db, account, audience, alice } = await setup();
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: FLOW,
    });
    const r = await enrollSubscriber(db, null, { automation, subscriberId: alice.id, source: "manual" });
    await db
      .update(automationEnrollments)
      .set({ status: "sending", currentNodeKey: "nd_send1", visitCount: 1, lockedAt: minutesAgo(20) })
      .where(eq(automationEnrollments.id, r.enrollmentId!));
    const now = nowIso();
    await db.insert(campaignRecipients).values({
      id: newId("rcp"),
      campaignId: null,
      accountId: account.id,
      subscriberId: alice.id,
      email: alice.email,
      automationId: automation.id,
      automationEnrollmentId: r.enrollmentId!,
      automationNodeKey: "nd_send1",
      visitNo: 0,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    const result = await sweepAutomationEnrollments(db, asQueue(new FakeQueue()), new Date());
    expect(result.failed).toBe(1);
    const [ledger] = await ledgerRows(db, r.enrollmentId!);
    expect(ledger.status).toBe("failed");
    expect(ledger.error).toContain("stuck lock");
    // A retried send job that arrives late finds the enrollment failed and drops out.
    const provider = new RecordingProvider();
    await sendAutomationNode(
      { enrollmentId: r.enrollmentId!, accountId: account.id },
      sendDeps(db, new FakeQueue(), provider),
    );
    expect(provider.sent).toHaveLength(0);
    expect((await enrollmentRow(db, r.enrollmentId!)).status).toBe("failed");
  });
});

describe("tick fairness", () => {
  it("serves every account with due work in one pass", async () => {
    const db = await testDb();
    const queue = new FakeQueue();
    const ids: string[] = [];
    for (const name of ["one", "two"]) {
      const account = await seedAccount(db, { name });
      const audience = await seedAudience(db, account.id);
      const subs = await seedSubscribers(db, account.id, audience.id, [
        `${name}-a@example.com`,
        `${name}-b@example.com`,
      ]);
      const { automation } = await seedAutomation(db, {
        accountId: account.id,
        audienceId: audience.id,
        graph: FLOW,
      });
      for (const s of subs) {
        const r = await enrollSubscriber(db, null, { automation, subscriberId: s.id, source: "manual" });
        ids.push(r.enrollmentId!);
      }
    }
    const result = await runAutomationTick({ db, queue: asQueue(queue) });
    expect(result.accounts).toBe(2);
    expect(result.advanced).toBe(4);
    for (const id of ids) {
      const row = await enrollmentRow(db, id);
      expect(row.status).toBe("sending");
      expect(row.currentNodeKey).toBe("nd_send1");
    }
    expect(queue.messages.filter((m) => m.type === "send_automation_node")).toHaveLength(4);
    // A second pass finds nothing due (everything is in `sending`).
    expect((await runAutomationTick({ db, queue: asQueue(queue) })).advanced).toBe(0);
  });
});

describe("nextWindowOpen", () => {
  const window = { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" };

  it("leaves a date already inside the window alone", () => {
    const inside = new Date("2026-09-14T10:00:00Z"); // Monday 12:00 in Copenhagen (CEST)
    expect(nextWindowOpen(inside, window, "Europe/Copenhagen").toISOString()).toBe(inside.toISOString());
  });

  it("pushes a weekend date to Monday's opening in the automation's zone", () => {
    const saturday = new Date("2026-09-12T10:00:00Z");
    expect(nextWindowOpen(saturday, window, "Europe/Copenhagen").toISOString()).toBe(
      "2026-09-14T07:00:00.000Z", // 09:00 CEST
    );
  });

  it("pushes an after-hours date to the next day's opening, and never advances", () => {
    const lateMonday = new Date("2026-09-14T16:30:00Z"); // 18:30 CEST
    expect(nextWindowOpen(lateMonday, window, "Europe/Copenhagen").toISOString()).toBe(
      "2026-09-15T07:00:00.000Z",
    );
    const earlyTuesday = new Date("2026-09-15T04:00:00Z"); // 06:00 CEST
    expect(nextWindowOpen(earlyTuesday, window, "Europe/Copenhagen").toISOString()).toBe(
      "2026-09-15T07:00:00.000Z",
    );
    // A malformed window degrades to "no window".
    expect(nextWindowOpen(saturdayish(), { days: [1], from: "09:00", to: "09:00" }, "UTC")).toEqual(
      saturdayish(),
    );
    expect(nextWindowOpen(saturdayish(), { days: [], from: "09:00", to: "17:00" }, "UTC")).toEqual(
      saturdayish(),
    );
    expect(nextWindowOpen(saturdayish(), { days: [1], from: "9am", to: "17:00" }, "UTC")).toEqual(
      saturdayish(),
    );
    // An unknown zone reads the window in UTC rather than dropping it.
    expect(nextWindowOpen(saturdayish(), window, "Mars/Olympus_Mons").toISOString()).toBe(
      "2026-09-14T09:00:00.000Z",
    );
  });

  function saturdayish() {
    return new Date("2026-09-12T10:00:00Z");
  }

  it("crosses a DST change: Saturday before the autumn switch lands on Monday 09:00 CET", () => {
    // 2026-10-24 is CEST (+2); the clocks go back on the 25th, so Monday's 09:00
    // is 08:00Z, not 07:00Z.
    const saturday = new Date("2026-10-24T10:00:00Z");
    expect(nextWindowOpen(saturday, window, "Europe/Copenhagen").toISOString()).toBe(
      "2026-10-26T08:00:00.000Z",
    );
  });

  it("a window that runs past midnight opens in the evening and closes the next morning", () => {
    const night = { days: [1], from: "22:00", to: "06:00" }; // Monday nights
    // Inside: Monday 23:00 CEST, and the small hours of Tuesday.
    const lateMonday = new Date("2026-09-14T21:00:00Z");
    expect(nextWindowOpen(lateMonday, night, "Europe/Copenhagen")).toEqual(lateMonday);
    const earlyTuesday = new Date("2026-09-15T01:00:00Z"); // 03:00 CEST
    expect(nextWindowOpen(earlyTuesday, night, "Europe/Copenhagen")).toEqual(earlyTuesday);
    // Monday daytime waits for that evening's opening.
    expect(nextWindowOpen(new Date("2026-09-14T08:00:00Z"), night, "Europe/Copenhagen").toISOString()).toBe(
      "2026-09-14T20:00:00.000Z",
    );
    // Tuesday after the window closed waits a week; Wednesday 03:00 is not a
    // tail of an allowed day.
    expect(nextWindowOpen(new Date("2026-09-15T05:00:00Z"), night, "Europe/Copenhagen").toISOString()).toBe(
      "2026-09-21T20:00:00.000Z",
    );
    expect(nextWindowOpen(new Date("2026-09-16T01:00:00Z"), night, "Europe/Copenhagen").toISOString()).toBe(
      "2026-09-21T20:00:00.000Z",
    );
  });

  it("a clamped wait lands on the window when the engine arrives at it", async () => {
    const { db, account, audience, alice } = await setup();
    const graph: AutomationGraph = {
      nodes: [
        { key: "nd_trigger", kind: "trigger", config: {} },
        { key: "nd_wait", kind: "wait", config: { value: 1, unit: "minutes", clampToSendWindow: true } },
      ],
      edges: [{ fromKey: "nd_trigger", port: "next", toKey: "nd_wait" }],
    };
    // A window that is never "now": one minute wide on the far side of the day.
    const now = new Date();
    const hh = String((now.getUTCHours() + 12) % 24).padStart(2, "0");
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph,
      sendWindowJson: JSON.stringify({ days: [0, 1, 2, 3, 4, 5, 6], from: `${hh}:00`, to: `${hh}:01` }),
      timezone: "UTC",
    });
    const r = await enrollSubscriber(db, null, { automation, subscriberId: alice.id, source: "manual" });
    expect(await advanceEnrollment(db, { queue: asQueue(new FakeQueue()) }, r.enrollmentId!)).toBe("waiting");
    const row = await enrollmentRow(db, r.enrollmentId!);
    const due = new Date(row.nextRunAt!);
    expect(due.getTime() - now.getTime()).toBeGreaterThan(60 * 60 * 1000);
    expect(due.getUTCHours()).toBe(Number(hh));
    expect(due.getUTCMinutes()).toBe(0);
  });
});
