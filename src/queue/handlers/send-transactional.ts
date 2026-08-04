import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  accounts,
  emailEvents,
  sendingDomains,
  transactionalEmails,
  type TransactionalEmail,
} from "../../db/schema";
import { newId, nowIso } from "../../lib/ids";
import { logJob } from "../../lib/job-log";
import { logger } from "../../lib/logger";
import type { EmailProvider } from "../../email/provider";
import {
  E_ACCOUNT_SUSPENDED,
  E_SENDER_NOT_VERIFIED,
  E_SENDING_MISCONFIGURED,
} from "../../email/ses";
import { addSuppression } from "../../services/suppression";
import { releaseReservation } from "../../services/quota";
import { PLATFORM_HEADERS, emailDomain, mergeSendHeaders } from "../../services/transactional";

export type SendTransactionalDeps = {
  db: Db;
  emailProvider: EmailProvider;
};

// Sends one transactional email accepted by POST /v1/emails. ID-only message;
// the row is re-read here (Postgres is the source of truth). Duplicate-safety
// mirrors send-batch: the atomic queued→sending claim means a redelivered or
// concurrent job is a no-op, and only provably-unsent outcomes (rate_limited /
// transient) return the row to `queued` and THROW so BullMQ retries with
// backoff. Ambiguous transport errors stay terminal — the email may already be
// at the provider, and a duplicate password-reset is worse than a missing one
// the caller can observe (GET /v1/emails/{id}) and re-send deliberately.
//
// Quota: the API route reserved `to.length` units at accept time. A successful
// send keeps the reservation; terminal non-sends (failed / suppressed) release
// it here so the counter converges on emails actually sent. Retries keep it
// held — the email is still expected to go out.
export async function sendTransactionalEmail(
  message: { emailId: string; accountId: string },
  deps: SendTransactionalDeps,
): Promise<void> {
  const { db } = deps;

  // Atomic claim: only a `queued` row proceeds. A stale redelivery (row already
  // sent/failed) or a concurrent worker claims nothing and drops out here.
  const claimed = await db
    .update(transactionalEmails)
    .set({ status: "sending", lockedAt: nowIso(), updatedAt: nowIso() })
    .where(
      and(
        eq(transactionalEmails.id, message.emailId),
        eq(transactionalEmails.accountId, message.accountId),
        eq(transactionalEmails.status, "queued"),
      ),
    )
    .returning();
  const email = claimed[0];
  if (!email) {
    const existing = await db.query.transactionalEmails.findFirst({
      where: and(
        eq(transactionalEmails.id, message.emailId),
        eq(transactionalEmails.accountId, message.accountId),
      ),
    });
    await logJob(db, {
      jobType: "send_transactional",
      entityType: "transactional_email",
      entityId: message.emailId,
      status: "skipped",
      error: existing ? `status is ${existing.status}` : "not found",
    });
    return;
  }

  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, message.accountId),
  });
  // Eligibility can change between accept and send (risk pause, subscription
  // lapse). Sandbox rows come from free orgs whose sendingEnabled is false by
  // design, so they check risk/subscription only.
  const eligible =
    account &&
    account.riskStatus !== "paused" &&
    account.subscriptionStatus === "active" &&
    (email.sandbox || account.sendingEnabled);
  if (!eligible) {
    await finishTerminal(db, email, "failed", "account is not eligible to send");
    await logJob(db, {
      jobType: "send_transactional",
      entityType: "transactional_email",
      entityId: email.id,
      status: "skipped",
      error: "account not eligible to send",
    });
    return;
  }

  const result = await deps.emailProvider.send({
    accountId: account.id,
    fromEmail: email.fromEmail,
    fromName: email.fromName ?? "",
    replyTo: email.replyTo ?? undefined,
    toEmail: email.to,
    subject: email.subject,
    html: email.htmlBody ?? undefined,
    text: email.textBody ?? undefined,
    headers: mergeSendHeaders(email.headers, {
      [PLATFORM_HEADERS.accountId]: account.id,
      [PLATFORM_HEADERS.transactionalEmailId]: email.id,
    }),
  });

  const now = nowIso();

  // Every post-send write below is guarded on `status = 'sending'`: if this
  // worker stalled past the sweep's 15-minute stuck-lock window, the sweep has
  // already failed the row and released its reservation — an unguarded write
  // here would resurrect the row (or double-release the billing counter).
  // Losing that race means the ledger says failed for an email that may have
  // gone out: the same accepted, safe-side tradeoff as the campaign sweep.

  if (result.status === "sent") {
    const won = await db
      .update(transactionalEmails)
      .set({
        status: "sent",
        sentAt: now,
        provider: result.provider,
        providerMessageId: result.messageId,
        lockedAt: null,
        error: null,
        updatedAt: now,
      })
      .where(and(eq(transactionalEmails.id, email.id), eq(transactionalEmails.status, "sending")))
      .returning({ id: transactionalEmails.id });
    if (won.length === 0) {
      await logJob(db, {
        jobType: "send_transactional",
        entityType: "transactional_email",
        entityId: email.id,
        status: "skipped",
        error: "swept to failed before the send completed (stuck lock)",
      });
      return;
    }
    // Dedupe-safe like every event insert: unique (providerMessageId, eventType).
    await db
      .insert(emailEvents)
      .values({
        id: newId("evt"),
        accountId: account.id,
        transactionalEmailId: email.id,
        eventType: "sent",
        email: email.to[0],
        provider: result.provider,
        providerMessageId: result.messageId,
        payloadJson: email.to.length > 1 ? JSON.stringify({ to: email.to }) : null,
        createdAt: now,
      })
      .onConflictDoNothing();
    await logJob(db, {
      jobType: "send_transactional",
      entityType: "transactional_email",
      entityId: email.id,
      status: "completed",
      payload: { messageId: result.messageId, recipients: email.to.length },
    });
    return;
  }

  if (result.status === "rate_limited" || result.status === "transient") {
    // Provably unsent — safe to retry. Return the row to queued and throw so
    // BullMQ applies its backoff; the retried job re-claims it. If retries
    // exhaust (dead letter), the cron sweep fails long-queued rows.
    const err = result.error ?? "";
    if (err.startsWith(E_ACCOUNT_SUSPENDED) || err.startsWith(E_SENDING_MISCONFIGURED)) {
      // Platform-level provider problems threaten every tenant — page ops.
      void logger.reportError(
        "SES platform-level error on transactional send",
        new Error(err),
        { transactionalEmailId: email.id, accountId: account.id },
      );
    }
    const requeued = await db
      .update(transactionalEmails)
      .set({ status: "queued", lockedAt: null, updatedAt: now })
      .where(and(eq(transactionalEmails.id, email.id), eq(transactionalEmails.status, "sending")))
      .returning({ id: transactionalEmails.id });
    if (requeued.length === 0) return; // swept meanwhile — its release stands
    throw new Error(`transactional send will retry: ${result.error ?? result.status}`);
  }

  if (result.status === "suppressed") {
    // The provider's own suppression list rejected the address. Mirror it into
    // ours so the next API call gets a synchronous 4xx instead of a silent drop
    // (only attributable when there is exactly one recipient).
    if (email.to.length === 1) {
      await addSuppression(db, {
        accountId: account.id,
        email: email.to[0],
        reason: "provider_suppressed",
        source: "send_transactional",
      });
    }
    await finishTerminal(db, email, "suppressed", result.error ?? "provider suppressed");
    await logJob(db, {
      jobType: "send_transactional",
      entityType: "transactional_email",
      entityId: email.id,
      status: "completed",
      payload: { outcome: "suppressed" },
    });
    return;
  }

  // Terminal failure. A sender-identity rejection also flips the domain's
  // verification status so the dashboard tells the user what broke.
  if (result.error?.startsWith(E_SENDER_NOT_VERIFIED)) {
    await db
      .update(sendingDomains)
      .set({ verificationStatus: "failed", updatedAt: now })
      .where(
        and(
          eq(sendingDomains.accountId, account.id),
          eq(sendingDomains.domain, emailDomain(email.fromEmail)),
        ),
      );
  }
  await finishTerminal(db, email, "failed", result.error ?? "unknown error");
  await logJob(db, {
    jobType: "send_transactional",
    entityType: "transactional_email",
    entityId: email.id,
    status: "completed",
    payload: { outcome: "failed", error: result.error },
  });
}

// Terminal non-send: record the outcome, release the quota reservation (these
// recipients never consumed bandwidth), and write the failed event row. The
// guarded update is what makes the release exactly-once: if the sweep already
// failed this row (stall > stuck-lock window), it also already released, and
// this call must do neither again.
async function finishTerminal(
  db: Db,
  email: TransactionalEmail,
  status: "failed" | "suppressed",
  error: string,
): Promise<void> {
  const now = nowIso();
  const won = await db
    .update(transactionalEmails)
    .set({ status, error, lockedAt: null, updatedAt: now })
    .where(and(eq(transactionalEmails.id, email.id), eq(transactionalEmails.status, "sending")))
    .returning({ id: transactionalEmails.id });
  if (won.length === 0) return;
  await releaseReservation(db, email.accountId, email.to.length);
  await db
    .insert(emailEvents)
    .values({
      id: newId("evt"),
      accountId: email.accountId,
      transactionalEmailId: email.id,
      eventType: "failed",
      email: email.to[0],
      provider: email.provider ?? "ses",
      payloadJson: JSON.stringify({ error, outcome: status }),
      createdAt: now,
    })
    .onConflictDoNothing();
}
