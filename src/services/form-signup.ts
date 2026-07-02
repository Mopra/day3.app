import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, forms, subscribers, type Form } from "../db/schema";
import { canonicalizeEmail } from "../lib/csv";
import { newId, nowIso } from "../lib/ids";
import { maxSubscribersForPlan } from "../lib/plans-catalog";
import type { JobQueue } from "../queue/messages";
import { isEmailSuppressed } from "./suppression";
import { countAccountSubscribers } from "./subscriber-limit";
import { notifyAccountThrottled } from "./notifications";

// Every public signup surface (hosted page, iframe, raw HTML form, future API)
// funnels through submitFormSignup. It is the single place a public signup is
// born, and it is deliberately idempotent and reputation-safe:
//   - A repeat submit of the same address is never an error to the visitor and
//     never duplicates a row (unique (audienceId, email) + onConflictDoNothing).
//   - A previously unsubscribed/bounced/complained address is NOT resurrected —
//     respecting an opt-out is non-negotiable for deliverability and law.
//   - Under double opt-in the new row is `pending`; generate-recipients only ever
//     mails `subscribed` rows, so a bot/typo signup can never be sent a campaign
//     until a human clicks the confirmation link.
// The confirmation email is enqueued ID-only (subscriberId + accountId); the
// worker re-reads content from Postgres and signs the token (queue messages
// carry IDs, never content).

export type FormSignupOutcome =
  | "pending" // new row awaiting confirmation; confirmation email enqueued
  | "subscribed" // new (or promoted) confirmed row — single opt-in form
  | "already_pending" // existing unconfirmed row; confirmation re-sent
  | "already_subscribed" // already a confirmed member — no-op
  | "opted_out"; // unsubscribed/bounced/complained/suppressed — left untouched

export type FormSignupResult = {
  outcome: FormSignupOutcome;
  subscriberId?: string;
};

export type FormSignupInput = {
  form: Form;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  // Custom field values keyed by FormField.key (everything beyond email/name).
  attributes?: Record<string, string> | null;
  consentIp?: string | null;
};

const OPTED_OUT_STATUSES = new Set(["unsubscribed", "bounced", "complained", "suppressed"]);

export async function submitFormSignup(
  db: Db,
  queue: JobQueue,
  input: FormSignupInput,
): Promise<FormSignupResult> {
  const { form } = input;
  const email = canonicalizeEmail(input.email);
  const now = nowIso();

  // Honour the suppression list before anything else: a previously suppressed
  // address must never be re-added or re-mailed, even via a fresh form.
  if (await isEmailSuppressed(db, form.accountId, email)) {
    return { outcome: "opted_out" };
  }

  // Free-tier subscriber cap (spam/abuse protection). When at the cap, never grow
  // the list from a public form: a brand-new address is silently dropped (the
  // visitor still sees the same success message), while an address already in the
  // audience falls through to normal handling below (which adds no new row).
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, form.accountId),
  });
  const cap = account ? maxSubscribersForPlan(account.plan) : null;
  if (cap !== null && (await countAccountSubscribers(db, form.accountId)) >= cap) {
    const existing = await db.query.subscribers.findFirst({
      where: and(eq(subscribers.audienceId, form.audienceId), eq(subscribers.email, email)),
    });
    if (!existing) {
      // A real signup is being turned away because the list is full. Silently
      // dropping it (and only it) protects the cap, but the account owner must
      // know their form has stopped collecting — otherwise they just see the
      // count plateau at 500 with no explanation. Notify at most once a day.
      if (account) {
        await notifyAccountThrottled(
          db,
          account,
          {
            kind: "subscribers_cap_reached",
            title: "Your signup form has hit the Free plan limit",
            body: `You've reached the Free plan's ${cap.toLocaleString()}-subscriber limit, so new signups from your forms are being turned away. Upgrade to a paid plan for unlimited subscribers and keep growing your list.`,
            ctaHref: "/billing",
            ctaLabel: "Upgrade your plan",
          },
          24,
        );
      }
      return { outcome: "opted_out" };
    }
  }

  const wantsConfirmation = form.doubleOptIn;
  const newStatus = wantsConfirmation ? "pending" : "subscribed";

  const inserted = await db
    .insert(subscribers)
    .values({
      id: newId("sub"),
      accountId: form.accountId,
      audienceId: form.audienceId,
      email,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      attributes: input.attributes ?? null,
      status: newStatus,
      source: "form",
      formId: form.id,
      consentIp: input.consentIp ?? null,
      confirmedAt: wantsConfirmation ? null : now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: subscribers.id });

  if (inserted.length > 0) {
    const subscriberId = inserted[0].id;
    await bumpCounters(db, form.id, { submit: true, confirmed: !wantsConfirmation });
    if (wantsConfirmation) {
      await enqueueConfirmation(queue, subscriberId, form.accountId);
      return { outcome: "pending", subscriberId };
    }
    return { outcome: "subscribed", subscriberId };
  }

  // Conflict: the address is already in this audience. Decide based on its state.
  const existing = await db.query.subscribers.findFirst({
    where: and(eq(subscribers.audienceId, form.audienceId), eq(subscribers.email, email)),
  });
  if (!existing) {
    // Vanishingly unlikely (deleted between insert-conflict and read); treat as
    // a benign no-op rather than 500 the visitor.
    return { outcome: "already_subscribed" };
  }

  if (existing.status === "subscribed") {
    return { outcome: "already_subscribed", subscriberId: existing.id };
  }

  if (OPTED_OUT_STATUSES.has(existing.status)) {
    // Never resurrect an opt-out from a public form.
    return { outcome: "opted_out", subscriberId: existing.id };
  }

  // existing.status === "pending"
  if (wantsConfirmation) {
    // Re-send the confirmation (the visitor may have lost the first email).
    await enqueueConfirmation(queue, existing.id, form.accountId);
    return { outcome: "already_pending", subscriberId: existing.id };
  }
  // A single opt-in form re-captured a previously-pending address: the visitor
  // has now signed up via a no-confirmation form, so promote them.
  await db
    .update(subscribers)
    .set({ status: "subscribed", confirmedAt: now, updatedAt: now })
    .where(eq(subscribers.id, existing.id));
  await bumpCounters(db, form.id, { submit: false, confirmed: true });
  return { outcome: "subscribed", subscriberId: existing.id };
}

async function bumpCounters(
  db: Db,
  formId: string,
  delta: { submit: boolean; confirmed: boolean },
): Promise<void> {
  if (!delta.submit && !delta.confirmed) return;
  await db
    .update(forms)
    .set({
      ...(delta.submit ? { submitCount: sql`${forms.submitCount} + 1` } : {}),
      ...(delta.confirmed ? { confirmedCount: sql`${forms.confirmedCount} + 1` } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(forms.id, formId));
}

async function enqueueConfirmation(
  queue: JobQueue,
  subscriberId: string,
  accountId: string,
): Promise<void> {
  await queue.send({ type: "send_form_confirmation", subscriberId, accountId });
}
