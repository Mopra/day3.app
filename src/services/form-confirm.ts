import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { forms, subscribers, type Form } from "../db/schema";
import { nowIso } from "../lib/ids";
import type { JobQueue } from "../queue/messages";
import { enrollAudienceJoin } from "./automation-enroll";
import type { FormConfirmTokenPayload } from "./form-token";

// Applies a verified double opt-in confirmation. Idempotent: clicking the link
// twice (or a mail client pre-fetching it) confirms once and is a no-op
// thereafter. Never resurrects an opt-out.
export type FormConfirmOutcome =
  | "confirmed" // pending → subscribed
  | "already_confirmed" // was already subscribed
  | "opted_out" // unsubscribed/bounced/complained — left untouched
  | "invalid"; // subscriber not found / mismatched account

export type FormConfirmResult = {
  outcome: FormConfirmOutcome;
  form?: Form;
};

// `queue` is optional: the public confirm route holds none, and the
// audience-join trigger then enqueues through the tier's ambient queue.
export async function confirmFormSignup(
  db: Db,
  payload: FormConfirmTokenPayload,
  queue: JobQueue | null = null,
): Promise<FormConfirmResult> {
  const subscriber = await db.query.subscribers.findFirst({
    where: and(
      eq(subscribers.id, payload.subscriberId),
      eq(subscribers.accountId, payload.accountId),
    ),
  });
  if (!subscriber) return { outcome: "invalid" };

  const form = await db.query.forms.findFirst({ where: eq(forms.id, payload.formId) });

  if (subscriber.status === "subscribed") {
    return { outcome: "already_confirmed", form };
  }
  if (subscriber.status !== "pending") {
    // unsubscribed / bounced / complained / suppressed — do not flip back.
    return { outcome: "opted_out", form };
  }

  const now = nowIso();
  await db
    .update(subscribers)
    .set({ status: "subscribed", confirmedAt: now, updatedAt: now })
    .where(eq(subscribers.id, subscriber.id));

  if (form) {
    await db
      .update(forms)
      .set({ confirmedCount: sql`${forms.confirmedCount} + 1`, updatedAt: now })
      .where(eq(forms.id, form.id));
  }

  // The confirmation is the moment a double opt-in signup joins the audience.
  await enrollAudienceJoin(db, queue, {
    accountId: subscriber.accountId,
    audienceId: subscriber.audienceId,
    subscriberIds: [subscriber.id],
    formId: payload.formId,
  });

  return { outcome: "confirmed", form };
}
