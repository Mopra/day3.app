import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  automationEnrollments,
  campaignRecipients,
  emailEvents,
  sendingDomains,
  subscribers,
  topicSubscriptions,
  topics,
  type Automation,
  type AutomationEnrollment,
  type CampaignRecipient,
} from "../../db/schema";
import type { EmailProvider } from "../../email/provider";
import {
  E_ACCOUNT_SUSPENDED,
  E_DAILY_LIMIT_EXCEEDED,
  E_SENDER_NOT_VERIFIED,
  E_SENDING_MISCONFIGURED,
} from "../../email/ses";
import {
  SendNodeConfigSchema,
  findNode,
  type AutomationGraph,
  type AutomationGraphNode,
} from "../../lib/automation-graph";
import { canonicalizeEmail } from "../../lib/csv";
import { newId, nowIso } from "../../lib/ids";
import { logJob } from "../../lib/job-log";
import { logger } from "../../lib/logger";
import { safeParseTheme } from "../../lib/theme";
import { getAudienceFieldFallbacks } from "../../services/audience-fields";
import {
  HOLD_RETRY_MS,
  PAUSED_RETRY_MS,
  TOO_STALE_REASON,
  accountHoldReason,
  applyArrival,
  arrivalFor,
  casEnrollment,
  exitEnrollment,
  failEnrollment,
  holdEnrollment,
  holdIsStale,
  loadAccount,
  loadAutomation,
  loadGraph,
  newEngineContext,
  visitNoFor,
  writeSkippedLedgerRow,
  type EngineDeps,
} from "../../services/automation-engine";
import { enforceAccountHealth } from "../../services/health";
import {
  clickTrackingUrl,
  openTrackingUrl,
  signClickToken,
  signOpenToken,
} from "../../services/open-tracking";
import { releaseReservation, reserveQuota } from "../../services/quota";
import { extractTrackableLinks, renderCampaignEmail } from "../../services/render";
import { SANDBOX_MONTHLY_ALLOWANCE, orgMemberEmails } from "../../services/sandbox";
import { addSuppression, isEmailSuppressed } from "../../services/suppression";
import { signUnsubscribeToken, unsubscribeUrl } from "../../services/unsubscribe";
import { emitWebhookEvent } from "../../services/webhook-events";
import type { JobQueue } from "../messages";

// One enrollment's send node: the automation counterpart of sendCampaignBatch,
// for exactly one recipient. Same ledger (campaign_recipients, with campaign_id
// NULL and the automation columns set), same render path, same tokens, same
// quota reservation, same error classification. What is different is the
// idempotency anchor: the unique (enrollment, node, visit_no) index. The row is
// inserted `pending` first and claimed to `sending` in a guarded UPDATE, so a
// retried or duplicated job finds the row and does one of three things: claims
// it (nobody sent), leaves it (another worker is mid-send), or, when the row is
// already terminal, just moves the cursor (the send happened and only the
// bookkeeping after it was lost). It never sends twice.

export type SendAutomationNodeDeps = {
  db: Db;
  queue: JobQueue;
  emailProvider: EmailProvider;
  appUrl: string;
  unsubscribeSecret: string;
};

const JOB = "send_automation_node";

export async function sendAutomationNode(
  message: { enrollmentId: string; accountId: string },
  deps: SendAutomationNodeDeps,
): Promise<void> {
  const { db } = deps;
  const engine: EngineDeps = { queue: deps.queue, ctx: newEngineContext() };
  const skip = (error: string) =>
    logJob(db, {
      jobType: JOB,
      entityType: "automation_enrollment",
      entityId: message.enrollmentId,
      status: "skipped",
      error,
    });

  const enrollment = await db.query.automationEnrollments.findFirst({
    where: and(
      eq(automationEnrollments.id, message.enrollmentId),
      eq(automationEnrollments.accountId, message.accountId),
    ),
  });
  // Only a `sending` enrollment is ours to act on. Anything else means this
  // message is stale (already advanced, exited, swept to failed) and is dropped.
  if (!enrollment || enrollment.status !== "sending" || !enrollment.currentNodeKey) {
    await skip(enrollment ? `enrollment status is ${enrollment.status}` : "not found");
    return;
  }
  const log = logger.child({
    enrollmentId: enrollment.id,
    automationId: enrollment.automationId,
    accountId: enrollment.accountId,
  });

  const automation = await loadAutomation(db, engine, enrollment.accountId, enrollment.automationId);
  if (!automation) {
    await failEnrollment(db, enrollment, "automation no longer exists");
    return;
  }
  // Re-check the automation is still live, the way sendCampaignBatch re-checks
  // its campaign is still `sending`. The engine checked before dispatch, but a
  // pause click can land in the gap (seconds normally, minutes across a
  // transient retry), and "paused" means nothing goes out. Archive exits the
  // enrollment itself, so this only ever sees a pause; the hold is what the
  // resume route knows how to release.
  if (automation.status !== "active") {
    await holdEnrollment(db, enrollment, "automation_paused", PAUSED_RETRY_MS);
    await skip(`automation status is ${automation.status}`);
    return;
  }
  const graph = await loadGraph(db, engine, enrollment.accountId, enrollment.automationVersionId);
  const node = findNode(graph, enrollment.currentNodeKey);
  if (!node || node.kind !== "send") {
    // The cursor is not on a send node, so nothing was ever going to be sent:
    // hand the row back to the engine instead of leaving it for the sweep.
    await casEnrollment(db, enrollment, { status: "active", lockedAt: null, nextRunAt: nowIso() });
    await skip("cursor is not on a send node");
    return;
  }
  const visitNo = visitNoFor(node, enrollment);

  // The idempotency anchor, read before anything else.
  const existing = await findLedgerRow(db, enrollment, node.key, visitNo);
  if (existing && existing.status !== "pending") {
    if (existing.status === "sending") {
      // A concurrent job owns this send (or a crashed one did; the stuck-lock
      // sweep resolves that side). Either way it is not ours to touch.
      await skip("send already in flight for this node");
      return;
    }
    // Terminal: the send resolved and only the cursor move was lost.
    await finishNode(db, engine, enrollment, automation, graph, node, {
      sent: SENT_STATUSES.has(existing.status),
    });
    return;
  }

  const config = SendNodeConfigSchema.safeParse(node.config ?? {});
  if (!config.success || !config.data.subject.trim() || !config.data.htmlBody.trim()) {
    await writeSkippedLedgerRow(db, enrollment, automation, node, "invalid_config");
    await finishNode(db, engine, enrollment, automation, graph, node, { sent: false });
    return;
  }
  const content = config.data;

  const account = await loadAccount(db, engine, enrollment.accountId);
  const subscriber = await db.query.subscribers.findFirst({
    where: and(eq(subscribers.id, enrollment.subscriberId), eq(subscribers.accountId, enrollment.accountId)),
  });

  // Re-check the recipient at send time: they may have opted out since the
  // engine dispatched this node seconds (or, after a hold, days) ago.
  if (!subscriber || subscriber.status !== "subscribed") {
    const reason = subscriber?.status === "unsubscribed" ? "unsubscribed" : "not_subscribed";
    await writeSkippedLedgerRow(db, enrollment, automation, node, reason, subscriber?.email);
    await exitEnrollment(db, enrollment, reason);
    return;
  }
  if (await isEmailSuppressed(db, enrollment.accountId, subscriber.email)) {
    await writeSkippedLedgerRow(db, enrollment, automation, node, "suppressed", subscriber.email);
    await exitEnrollment(db, enrollment, "suppressed");
    return;
  }
  // Sandbox runs may only reach the org's own members (the free tier's
  // carve-out, services/sandbox.ts). Membership was checked at enrollment;
  // a member removed since simply gets no mail from this node.
  if (enrollment.sandbox) {
    const members = await orgMemberEmails(db, enrollment.accountId);
    if (!members.has(canonicalizeEmail(subscriber.email))) {
      await writeSkippedLedgerRow(db, enrollment, automation, node, "sandbox_not_member", subscriber.email);
      await finishNode(db, engine, enrollment, automation, graph, node, { sent: false });
      return;
    }
  }
  // Topics apply exactly as to a campaign sent under the topic.
  if (automation.topicId && !(await topicAllows(db, automation, subscriber.id))) {
    await writeSkippedLedgerRow(db, enrollment, automation, node, "topic_opted_out", subscriber.email);
    await finishNode(db, engine, enrollment, automation, graph, node, { sent: false });
    return;
  }

  // §5.6: everything that makes the account unable to send holds the
  // enrollment (surfaced as "held", never a failure), bounded by the staleness
  // cutoff after which the node is skipped and the flow moves on.
  const hold =
    accountHoldReason(account, enrollment.sandbox) ??
    (!automation.fromEmail || !automation.fromName ? "from_identity_missing" : null) ??
    (await domainHoldReason(db, automation));
  if (hold) {
    await holdOrSkip(db, engine, enrollment, automation, graph, node, hold, subscriber.email);
    return;
  }

  // Atomically reserve one unit before the row is claimed, against the sandbox
  // allowance for sandbox runs (same counter, different ceiling, exactly as
  // send-batch does). Exhausted quota holds; it never skips.
  const granted = await reserveQuota(
    db,
    enrollment.accountId,
    1,
    enrollment.sandbox ? SANDBOX_MONTHLY_ALLOWANCE : undefined,
  );
  if (granted <= 0) {
    await holdOrSkip(db, engine, enrollment, automation, graph, node, "quota", subscriber.email);
    return;
  }

  // Ledger row: insert `pending` (dedupe-safe), then claim it. From here on a
  // reservation is held and must be released on every non-sent exit.
  const ledger = await claimLedgerRow(db, existing, enrollment, automation, node, visitNo, subscriber.email);
  if (!ledger) {
    await releaseReservation(db, enrollment.accountId, 1);
    await skip("ledger row claimed by another worker");
    return;
  }

  // Render. A render/token failure is provably pre-send, so it is a terminal
  // failure for this node only, never a reason to strand the enrollment.
  let rendered: ReturnType<typeof renderCampaignEmail>;
  let unsubUrl: string;
  try {
    const token = await signUnsubscribeToken(
      {
        accountId: enrollment.accountId,
        subscriberId: subscriber.id,
        email: subscriber.email,
        campaignRecipientId: ledger.id,
      },
      deps.unsubscribeSecret,
    );
    unsubUrl = unsubscribeUrl(deps.appUrl, token);

    let openUrl: string | null = null;
    let linkTracking: Record<string, string> | null = null;
    if (deps.appUrl) {
      const openToken = await signOpenToken(
        { accountId: enrollment.accountId, campaignRecipientId: ledger.id, email: subscriber.email },
        deps.unsubscribeSecret,
      );
      openUrl = openTrackingUrl(deps.appUrl, openToken);
      const links = extractTrackableLinks(content.htmlBody);
      if (links.length > 0) {
        linkTracking = {};
        for (const link of links) {
          const clickToken = await signClickToken(
            {
              accountId: enrollment.accountId,
              campaignRecipientId: ledger.id,
              email: subscriber.email,
              url: link.url,
            },
            deps.unsubscribeSecret,
          );
          linkTracking[link.raw] = clickTrackingUrl(deps.appUrl, clickToken);
        }
      }
    }

    rendered = renderCampaignEmail({
      campaign: {
        subject: content.subject,
        htmlBody: content.htmlBody,
        textBody: content.textBody,
        footerText: automation.footerText,
      },
      theme: safeParseTheme(automation.themeJson),
      subscriber: {
        email: subscriber.email,
        firstName: subscriber.firstName,
        lastName: subscriber.lastName,
        attributes: subscriber.attributes,
      },
      companyName: account!.name,
      companyAddress: account!.companyAddress,
      unsubscribeUrl: unsubUrl,
      openTrackingUrl: openUrl,
      linkTracking,
      fieldFallbacks: await getAudienceFieldFallbacks(db, automation.audienceId),
    });
  } catch (err) {
    const error = `render failed: ${err instanceof Error ? err.message : String(err)}`;
    await markLedgerFailed(db, enrollment, automation, node, ledger, error);
    // Nothing reached the provider, so the unit reserved above goes back, as it
    // does on every other non-sent exit below.
    await releaseReservation(db, enrollment.accountId, 1);
    await finishNode(db, engine, enrollment, automation, graph, node, { sent: false });
    return;
  }

  // From here the email may be at the provider. If send() throws, the ledger
  // row stays `sending` and the enrollment stays `sending`: the stuck-lock
  // sweeps fail both, the side that can never duplicate.
  const result = await deps.emailProvider.send({
    accountId: enrollment.accountId,
    recipientId: ledger.id,
    fromEmail: automation.fromEmail!,
    fromName: automation.fromName!,
    replyTo: automation.replyTo ?? undefined,
    toEmail: subscriber.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: {
      "List-Unsubscribe": `<${unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      "X-Automation-ID": automation.id,
      "X-Account-ID": enrollment.accountId,
      "X-Recipient-ID": ledger.id,
    },
  });

  const now = nowIso();

  if (result.status === "sent") {
    // Guarded on `sending`: if this worker stalled past the sweep window the
    // row is already `failed` and its reservation released; resurrecting it
    // would double-count. Losing that race leaves a ledger that says failed for
    // an email that went out, the same accepted tradeoff as the campaign sweep.
    const won = await db
      .update(campaignRecipients)
      .set({
        status: "sent",
        sentAt: now,
        providerMessageId: result.messageId,
        provider: result.provider,
        error: null,
        lockedAt: null,
        updatedAt: now,
      })
      .where(and(eq(campaignRecipients.id, ledger.id), eq(campaignRecipients.status, "sending")))
      .returning({ id: campaignRecipients.id });
    if (won.length > 0) {
      const eventId = newId("evt");
      const inserted = await db
        .insert(emailEvents)
        .values({
          id: eventId,
          accountId: enrollment.accountId,
          campaignId: null,
          campaignRecipientId: ledger.id,
          automationId: automation.id,
          automationNodeKey: node.key,
          eventType: "sent",
          email: subscriber.email,
          provider: result.provider,
          providerMessageId: result.messageId,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: emailEvents.id });
      if (inserted.length > 0) {
        await emitWebhookEvent(db, {
          type: "email.sent",
          accountId: enrollment.accountId,
          eventId,
          source: automationSource(automation, node, ledger, subscriber.id, subscriber.email),
          subject: rendered.subject,
          providerMessageId: result.messageId ?? null,
        });
      }
      await enforceAccountHealth(db, enrollment.accountId);
    }
    await finishNode(db, engine, enrollment, automation, graph, node, { sent: true });
    await logJob(db, {
      jobType: JOB,
      entityType: "automation_enrollment",
      entityId: enrollment.id,
      status: "completed",
      payload: { nodeKey: node.key, messageId: result.messageId },
    });
    return;
  }

  if (result.status === "suppressed") {
    // The provider's own list rejected the address: mirror it into ours so the
    // next node (and every campaign) skips it synchronously.
    await db
      .update(campaignRecipients)
      .set({ status: "skipped", error: result.error ?? "provider suppressed", lockedAt: null, updatedAt: now })
      .where(and(eq(campaignRecipients.id, ledger.id), eq(campaignRecipients.status, "sending")));
    await addSuppression(db, {
      accountId: enrollment.accountId,
      email: subscriber.email,
      reason: "provider_suppressed",
      source: JOB,
    });
    await releaseReservation(db, enrollment.accountId, 1);
    await finishNode(db, engine, enrollment, automation, graph, node, { sent: false });
    return;
  }

  if (result.status === "rate_limited" || result.status === "transient") {
    // Provably unsent (the provider rejected the request before sending, or it
    // never reached the provider). Return the row to pending and give back the
    // reservation; what happens next depends on why.
    await unclaimLedgerRow(db, ledger.id, now);
    await releaseReservation(db, enrollment.accountId, 1);
    const err = result.error ?? "";
    const providerHold = providerHoldReason(err);
    if (providerHold) {
      // Account- or platform-level: a retry in seconds will not help. Hold the
      // enrollment for an hour and page ops for the platform ones.
      if (err.startsWith(E_ACCOUNT_SUSPENDED) || err.startsWith(E_SENDING_MISCONFIGURED)) {
        void logger.reportError("SES platform-level error on automation send", new Error(err), {
          enrollmentId: enrollment.id,
          automationId: automation.id,
          accountId: enrollment.accountId,
        });
      }
      await holdEnrollment(db, enrollment, providerHold, HOLD_RETRY_MS);
      return;
    }
    // A plain throttle or a connection-phase failure: the THROW-on-transient
    // contract (messages.ts). BullMQ retries with backoff and the retried job
    // re-claims the pending row; the enrollment stays `sending` meanwhile so
    // the tick leaves it alone.
    throw new Error(`automation send will retry: ${result.error ?? result.status}`);
  }

  if (result.error?.startsWith(E_SENDER_NOT_VERIFIED)) {
    // Provider rejected the identity. Nothing sent; flip the domain so the
    // dashboard says what broke, and hold rather than fail the person's flow.
    await unclaimLedgerRow(db, ledger.id, now);
    await releaseReservation(db, enrollment.accountId, 1);
    if (automation.sendingDomainId) {
      await db
        .update(sendingDomains)
        .set({ verificationStatus: "failed", updatedAt: now })
        .where(
          and(
            eq(sendingDomains.id, automation.sendingDomainId),
            eq(sendingDomains.accountId, enrollment.accountId),
          ),
        );
    }
    await holdEnrollment(db, enrollment, "sender_not_verified", HOLD_RETRY_MS);
    return;
  }

  // Permanent for this recipient (bad address, rejected content). The node is
  // failed on the ledger and the flow continues: a bad address should not
  // strand the enrollment on a node it can never pass.
  await markLedgerFailed(db, enrollment, automation, node, ledger, result.error ?? "unknown error", {
    subscriberId: subscriber.id,
    email: subscriber.email,
    provider: result.provider,
  });
  await releaseReservation(db, enrollment.accountId, 1);
  await finishNode(db, engine, enrollment, automation, graph, node, { sent: false });
  log.info("automation send failed for recipient", { nodeKey: node.key, error: result.error });
}

/* ─────────────────────────────── helpers ──────────────────────────────── */

// Ledger statuses that mean "the email went out" (and later moved on). Used
// when a retried job finds the node already resolved and needs to know whether
// to count the send.
const SENT_STATUSES = new Set<CampaignRecipient["status"]>([
  "sent",
  "delivered",
  "bounced",
  "complained",
  "unsubscribed",
]);

async function findLedgerRow(
  db: Db,
  enrollment: AutomationEnrollment,
  nodeKey: string,
  visitNo: number,
): Promise<CampaignRecipient | undefined> {
  return db.query.campaignRecipients.findFirst({
    where: and(
      eq(campaignRecipients.accountId, enrollment.accountId),
      eq(campaignRecipients.automationEnrollmentId, enrollment.id),
      eq(campaignRecipients.automationNodeKey, nodeKey),
      eq(campaignRecipients.visitNo, visitNo),
    ),
  });
}

// Insert the row `pending` if it does not exist, then claim it to `sending`.
// Returns the claimed row, or null when another worker got there first.
async function claimLedgerRow(
  db: Db,
  existing: CampaignRecipient | undefined,
  enrollment: AutomationEnrollment,
  automation: Automation,
  node: AutomationGraphNode,
  visitNo: number,
  email: string,
): Promise<CampaignRecipient | null> {
  const now = nowIso();
  let id = existing?.id;
  if (!id) {
    const candidate = newId("rcp");
    const inserted = await db
      .insert(campaignRecipients)
      .values({
        id: candidate,
        campaignId: null,
        accountId: enrollment.accountId,
        subscriberId: enrollment.subscriberId,
        email,
        automationId: automation.id,
        automationEnrollmentId: enrollment.id,
        automationNodeKey: node.key,
        visitNo,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: campaignRecipients.id });
    if (inserted.length > 0) {
      id = candidate;
    } else {
      // Lost the insert race to a concurrent job; claim whatever it inserted
      // (a pending row) or back off (it is already sending).
      const raced = await findLedgerRow(db, enrollment, node.key, visitNo);
      if (!raced || raced.status !== "pending") return null;
      id = raced.id;
    }
  }
  const [claimed] = await db
    .update(campaignRecipients)
    .set({ status: "sending", lockedAt: now, updatedAt: now })
    .where(and(eq(campaignRecipients.id, id), eq(campaignRecipients.status, "pending")))
    .returning();
  return claimed ?? null;
}

// Provably-unsent exits give the row back so the retry (or the hold's next
// attempt) can claim it again. Guarded on `sending`: a row the sweep already
// failed must not resurrect.
async function unclaimLedgerRow(db: Db, ledgerId: string, now: string): Promise<void> {
  await db
    .update(campaignRecipients)
    .set({ status: "pending", lockedAt: null, updatedAt: now })
    .where(and(eq(campaignRecipients.id, ledgerId), eq(campaignRecipients.status, "sending")));
}

async function markLedgerFailed(
  db: Db,
  enrollment: AutomationEnrollment,
  automation: Automation,
  node: AutomationGraphNode,
  ledger: CampaignRecipient,
  error: string,
  event?: { subscriberId: string; email: string; provider: "ses" | "mock" },
): Promise<void> {
  const now = nowIso();
  const won = await db
    .update(campaignRecipients)
    .set({ status: "failed", error, lockedAt: null, updatedAt: now })
    .where(and(eq(campaignRecipients.id, ledger.id), eq(campaignRecipients.status, "sending")))
    .returning({ id: campaignRecipients.id });
  if (won.length === 0 || !event) return;
  const eventId = newId("evt");
  const inserted = await db
    .insert(emailEvents)
    .values({
      id: eventId,
      accountId: enrollment.accountId,
      campaignId: null,
      campaignRecipientId: ledger.id,
      automationId: automation.id,
      automationNodeKey: node.key,
      eventType: "failed",
      email: event.email,
      provider: event.provider,
      payloadJson: JSON.stringify({ error }),
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: emailEvents.id });
  if (inserted.length > 0) {
    await emitWebhookEvent(db, {
      type: "email.failed",
      accountId: enrollment.accountId,
      eventId,
      source: automationSource(automation, node, ledger, event.subscriberId, event.email),
      subject: null,
      providerMessageId: null,
      error,
    });
  }
}

function automationSource(
  automation: Automation,
  node: AutomationGraphNode,
  ledger: CampaignRecipient,
  subscriberId: string | null,
  email: string,
) {
  return {
    kind: "automation" as const,
    automationId: automation.id,
    nodeKey: node.key,
    enrollmentId: ledger.automationEnrollmentId,
    recipientId: ledger.id,
    subscriberId,
    email,
  };
}

// The node is resolved (sent, failed, or skipped): move the cursor to `next`
// in the same write that clears the lock and counts the send, then kick the
// engine so the next step does not wait for the tick.
async function finishNode(
  db: Db,
  engine: EngineDeps,
  enrollment: AutomationEnrollment,
  automation: Automation,
  graph: AutomationGraph,
  node: AutomationGraphNode,
  opts: { sent: boolean },
): Promise<void> {
  const now = new Date();
  const arrival = arrivalFor(graph, automation, node.key, "next", now);
  const moved = await applyArrival(db, enrollment, arrival, {
    sendCount: opts.sent ? enrollment.sendCount + 1 : enrollment.sendCount,
  });
  if (!moved) {
    // The enrollment changed under us (swept to failed after a long stall, or
    // exited by hand). The ledger already records what happened to the email.
    logger.warn("automation enrollment changed during send; cursor not moved", {
      enrollmentId: enrollment.id,
      automationId: automation.id,
    });
    return;
  }
  if (moved.status === "active" && moved.nextRunAt && Date.parse(moved.nextRunAt) <= now.getTime()) {
    try {
      await engine.queue.send({
        type: "advance_automation_enrollment",
        enrollmentId: enrollment.id,
        accountId: enrollment.accountId,
      });
    } catch (err) {
      logger.warn("advance enqueue after send failed (tick will resume)", {
        enrollmentId: enrollment.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// The §5.6 hold from inside the send handler, including the staleness cutoff.
async function holdOrSkip(
  db: Db,
  engine: EngineDeps,
  enrollment: AutomationEnrollment,
  automation: Automation,
  graph: AutomationGraph,
  node: AutomationGraphNode,
  reason: string,
  email: string,
): Promise<void> {
  if (holdIsStale(enrollment)) {
    await writeSkippedLedgerRow(db, enrollment, automation, node, TOO_STALE_REASON, email);
    await finishNode(db, engine, enrollment, automation, graph, node, { sent: false });
    return;
  }
  await holdEnrollment(db, enrollment, reason, HOLD_RETRY_MS);
}

// Provider outcomes that are provably unsent AND not worth a retry in seconds:
// the account's daily SES quota, a platform suspension, a misconfiguration.
// Returned as the hold reason; null means "an ordinary throttle, just retry".
function providerHoldReason(error: string): string | null {
  if (error === E_DAILY_LIMIT_EXCEEDED) return "provider_daily_limit";
  if (error.startsWith(E_ACCOUNT_SUSPENDED)) return "provider_suspended";
  if (error.startsWith(E_SENDING_MISCONFIGURED)) return "provider_misconfigured";
  return null;
}

// A sending domain that has lost verification would be rejected by SES; hold
// (the dashboard already explains what to fix) instead of burning the node.
async function domainHoldReason(db: Db, automation: Automation): Promise<string | null> {
  if (!automation.sendingDomainId) return null;
  const domain = await db.query.sendingDomains.findFirst({
    columns: { verificationStatus: true },
    where: and(
      eq(sendingDomains.id, automation.sendingDomainId),
      eq(sendingDomains.accountId, automation.accountId),
    ),
  });
  if (!domain) return "domain_missing";
  return domain.verificationStatus === "verified" ? null : "domain_not_verified";
}

// Mirrors campaignRecipientScope's topic rule for one subscriber: an opt-out
// topic reaches everyone who has not left it, an opt-in topic only those who
// joined. A deleted topic sends to nobody, same as the campaign path.
async function topicAllows(db: Db, automation: Automation, subscriberId: string): Promise<boolean> {
  const topic = await db.query.topics.findFirst({
    where: and(eq(topics.id, automation.topicId!), eq(topics.accountId, automation.accountId)),
  });
  if (!topic) return false;
  const sub = await db.query.topicSubscriptions.findFirst({
    columns: { subscribed: true },
    where: and(
      eq(topicSubscriptions.topicId, topic.id),
      eq(topicSubscriptions.subscriberId, subscriberId),
    ),
  });
  if (topic.defaultSubscribed) return sub ? sub.subscribed : true;
  return sub ? sub.subscribed : false;
}
