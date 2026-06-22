import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { accounts, forms, sendingDomains, subscribers } from "../../db/schema";
import { logJob } from "../../lib/job-log";
import { formsBaseUrl } from "../../lib/public-url";
import type { EmailProvider } from "../../email/provider";
import { signFormConfirmToken } from "../../services/form-token";
import { renderFormConfirmationEmail } from "../../services/render-form";

export type SendFormConfirmationDeps = {
  db: Db;
  emailProvider: EmailProvider;
  // Same HMAC secret used for unsubscribe links (UNSUBSCRIBE_SECRET).
  confirmSecret: string;
};

// Sends the double opt-in confirmation email for a public-form signup. ID-only
// message: we re-read the subscriber/form/account here (Postgres is the source
// of truth) and sign the confirm token. Idempotent and retry-safe:
//   - Only acts on a row still in `pending` — a redelivered/duplicate job after
//     the subscriber already confirmed is a no-op (logged skipped).
//   - A transient provider error THROWS so BullMQ retries; a missing verified
//     sending domain is logged skipped (retrying can't help until the operator
//     verifies a domain — the form UI gates against this case up front).
export async function sendFormConfirmation(
  message: { subscriberId: string; accountId: string },
  deps: SendFormConfirmationDeps,
): Promise<void> {
  const { db } = deps;

  const subscriber = await db.query.subscribers.findFirst({
    where: and(
      eq(subscribers.id, message.subscriberId),
      eq(subscribers.accountId, message.accountId),
    ),
  });
  if (!subscriber) {
    await logJob(db, {
      jobType: "send_form_confirmation",
      entityType: "subscriber",
      entityId: message.subscriberId,
      status: "skipped",
      error: "subscriber not found",
    });
    return;
  }
  if (subscriber.status !== "pending") {
    // Already confirmed (or opted out) since enqueue — nothing to send.
    await logJob(db, {
      jobType: "send_form_confirmation",
      entityType: "subscriber",
      entityId: subscriber.id,
      status: "skipped",
      error: `status is ${subscriber.status}`,
    });
    return;
  }

  const form = subscriber.formId
    ? await db.query.forms.findFirst({ where: eq(forms.id, subscriber.formId) })
    : undefined;
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, message.accountId),
  });
  if (!form || !account) {
    await logJob(db, {
      jobType: "send_form_confirmation",
      entityType: "subscriber",
      entityId: subscriber.id,
      status: "skipped",
      error: !form ? "form not found" : "account not found",
    });
    return;
  }

  // Confirmation must come from a verified sending identity, or SES rejects it.
  const domains = await db
    .select()
    .from(sendingDomains)
    .where(eq(sendingDomains.accountId, account.id));
  const domain = domains.find(
    (d) => d.fromEmail && (d.verificationStatus === "verified" || d.adminOverrideVerified),
  );
  if (!domain?.fromEmail) {
    await logJob(db, {
      jobType: "send_form_confirmation",
      entityType: "subscriber",
      entityId: subscriber.id,
      status: "skipped",
      error: "no verified sending domain",
    });
    return;
  }

  const token = await signFormConfirmToken(
    {
      accountId: account.id,
      subscriberId: subscriber.id,
      formId: form.id,
      email: subscriber.email,
    },
    deps.confirmSecret,
  );
  const confirmUrl = `${formsBaseUrl()}/api/public/forms/confirm?token=${encodeURIComponent(token)}`;

  const rendered = renderFormConfirmationEmail({
    companyName: account.name,
    formName: form.name,
    confirmUrl,
    accentColor: form.accentColor,
  });

  const result = await deps.emailProvider.send({
    accountId: account.id,
    fromEmail: domain.fromEmail,
    fromName: domain.fromName ?? account.name,
    toEmail: subscriber.email,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    headers: {
      "X-Account-ID": account.id,
      "X-Form-ID": form.id,
    },
  });

  if (result.status !== "sent") {
    // Transient (or sender-not-verified) failure → throw so BullMQ retries.
    throw new Error(`form confirmation send failed: ${result.error ?? result.status}`);
  }

  await logJob(db, {
    jobType: "send_form_confirmation",
    entityType: "subscriber",
    entityId: subscriber.id,
    status: "completed",
    payload: { formId: form.id, messageId: result.messageId },
  });
}
