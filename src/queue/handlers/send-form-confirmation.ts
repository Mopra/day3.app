import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { accounts, forms, sendingDomains, subscribers, type Account } from "../../db/schema";
import { logJob } from "../../lib/job-log";
import { formsBaseUrl } from "../../lib/public-url";
import type { EmailProvider } from "../../email/provider";
import { signFormConfirmToken } from "../../services/form-token";
import { renderFormConfirmationEmail } from "../../services/render-form";
import { notifyAccountThrottled } from "../../services/notifications";
import { releaseReservation, reserveQuota } from "../../services/quota";
import { accountSandboxMode, SANDBOX_MONTHLY_ALLOWANCE } from "../../services/sandbox";

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
//
// This is a REAL SES send to an address the account does not control, so it
// carries the same gates as every other send path and reserves on the same
// ledger (hard rule 5). It used to carry none of them, which let a free org
// mail the whole internet, unmetered, on the shared SES reputation. Free orgs
// still confirm real signups — a form that silently stops working is a broken
// product — but they draw on SANDBOX_MONTHLY_ALLOWANCE via reserveQuota's
// limitOverride, exactly as their campaigns and transactional sends do. One
// meter, not two.
//
// Every refusal leaves the subscriber `pending` and notifies the account: the
// visitor was already told to check their inbox, so an unsent confirmation is a
// real person stranded, and the owner is the only one who can unstick it.
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

  const [form, account] = await Promise.all([
    subscriber.formId
      ? db.query.forms.findFirst({ where: eq(forms.id, subscriber.formId) })
      : Promise.resolve(undefined),
    db.query.accounts.findFirst({ where: eq(accounts.id, message.accountId) }),
  ]);
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

  // Everything that makes the account unable to send at all. A sandbox (free)
  // org has sendingEnabled false by design, so that one check is skipped for
  // them — risk and subscription still apply, and a risk-paused account is
  // precisely the one that must not keep mailing strangers from a form.
  const sandbox = accountSandboxMode(account);
  const blocked = sendBlockedReason(account, sandbox);
  if (blocked) {
    await refuse(db, account, subscriber.id, blocked.code, blocked.notice);
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
    await refuse(db, account, subscriber.id, "no verified sending domain", {
      title: "Signup confirmations aren't being delivered",
      body: "Someone signed up through your form, but Day3 has no verified sending domain to send their confirmation email from — so they're stuck unconfirmed and won't receive your campaigns. Verify a sending domain to start confirming signups.",
      ctaHref: "/sending",
      ctaLabel: "Verify a domain",
    });
    return;
  }

  // Reserve one unit on the shared monthly counter before the send, against the
  // sandbox allowance for free orgs (same counter, different ceiling — exactly
  // what send-batch and POST /v1/emails do). Reserved before rather than after
  // so a crash over-counts by one instead of leaking a free send: the safe side
  // of an abuse boundary.
  const granted = await reserveQuota(
    db,
    account.id,
    1,
    sandbox ? SANDBOX_MONTHLY_ALLOWANCE : undefined,
  );
  if (granted <= 0) {
    await refuse(
      db,
      account,
      subscriber.id,
      "monthly email allowance exhausted",
      sandbox
        ? {
            title: "Your free sending allowance is used up",
            body: `Someone signed up through your form, but your free plan's ${SANDBOX_MONTHLY_ALLOWANCE} emails for this month are spent, so their confirmation email couldn't be sent and they're stuck unconfirmed. Upgrade to keep confirming signups.`,
            ctaHref: "/billing",
            ctaLabel: "Upgrade your plan",
          }
        : {
            title: "Signup confirmations have stopped — monthly limit reached",
            body: "Someone signed up through your form, but you've reached your plan's monthly email limit, so their confirmation email couldn't be sent and they're stuck unconfirmed. Upgrade to keep confirming signups.",
            ctaHref: "/billing",
            ctaLabel: "Upgrade your plan",
          },
    );
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
    // Nothing left the building, so give the reservation back before throwing —
    // the BullMQ retry reserves again, and without this a flapping provider
    // would burn a month's allowance on one signup.
    await releaseReservation(db, account.id, 1);
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

// Why this account may not send right now, or null when it may. Mirrors
// automation-engine's accountHoldReason — the same rule, phrased for a
// stranger's signup rather than an enrollment, because the person waiting is
// not the customer and the customer is the only one who can fix it.
function sendBlockedReason(
  account: Account,
  sandbox: boolean,
): { code: string; notice: FormConfirmationNotice } | null {
  if (account.subscriptionStatus !== "active") {
    return {
      code: `subscription is ${account.subscriptionStatus}`,
      notice: {
        title: "Signup confirmations have stopped — billing needs attention",
        body: "Someone signed up through your form, but your subscription isn't active, so Day3 couldn't send their confirmation email and they're stuck unconfirmed. Update your billing details to start confirming signups again.",
        ctaHref: "/billing",
        ctaLabel: "Fix billing",
      },
    };
  }
  if (account.riskStatus === "paused") {
    return {
      code: "account paused for reputation",
      notice: {
        title: "Signup confirmations have stopped — sending is paused",
        body: "Your account's sending is paused while we review its bounce and complaint rates, so confirmation emails for new signups aren't going out. New signups are still being captured and will need confirming once sending resumes. Contact support to resolve the review.",
        ctaHref: "/settings",
        ctaLabel: "Contact support",
      },
    };
  }
  if (!sandbox && !account.sendingEnabled) {
    return {
      code: "sending disabled",
      notice: {
        title: "Signup confirmations have stopped — sending is disabled",
        body: "Someone signed up through your form, but sending is turned off for your account, so their confirmation email couldn't be sent and they're stuck unconfirmed.",
        ctaHref: "/settings",
        ctaLabel: "Open settings",
      },
    };
  }
  return null;
}

type FormConfirmationNotice = {
  title: string;
  body: string;
  ctaHref: string;
  ctaLabel: string;
};

// Record a confirmation that will not be sent, and tell the account once a day.
// Deliberately NOT a throw: retrying cannot help with any of these reasons, and
// a dead-lettered job would hide the problem from the one person who can fix
// it. The subscriber stays `pending`, so nothing is mailed to them by mistake.
async function refuse(
  db: Db,
  account: Account,
  subscriberId: string,
  code: string,
  notice: FormConfirmationNotice,
): Promise<void> {
  await logJob(db, {
    jobType: "send_form_confirmation",
    entityType: "subscriber",
    entityId: subscriberId,
    status: "skipped",
    error: code,
  });
  await notifyAccountThrottled(db, account, { kind: "form_confirmation_blocked", ...notice }, 24);
}
