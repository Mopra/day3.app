import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client";
import { subscribers, topics, type Subscriber } from "../../db/schema";
import { canonicalizeEmail, isValidEmail } from "../../lib/csv";
import { slugifyFieldKey, isReservedFieldKey } from "../../lib/form-fields";
import { newId, nowIso } from "../../lib/ids";
import { registerAudienceFields } from "../../services/audience-fields";
import { subscriberHeadroom, subscriberLimitMessage } from "../../services/subscriber-limit";
import { getSuppressedEmails } from "../../services/suppression";
import { setTopicSubscription } from "../../services/topic-subscription";
import { ApiError, type ApiErrorCode } from "./errors";

// Shared write path for v1 contacts — the single POST and the batch endpoint
// are the same machine with a different item count. Semantics (per the spec):
//   - create: 409 contact_already_exists on a duplicate email
//   - upsert: provided fields overwrite; `attributes` is a shallow merge where
//     a null value deletes the key
//   - status: only "subscribed"/"unsubscribed" are writable (migration needs
//     unsubscribed); pipeline-owned statuses (bounced/complained/suppressed/
//     pending) are never overwritten — an upsert against such a row updates the
//     other fields and leaves status alone
//   - suppressed emails are rejected (email_suppressed)
//   - new attribute keys auto-register in the audience field registry

export const ContactInputSchema = z.object({
  email: z.string().trim().max(320),
  first_name: z.string().trim().max(100).nullable().optional(),
  last_name: z.string().trim().max(100).nullable().optional(),
  // null deletes the key on update; blank keys/values are dropped.
  attributes: z.record(z.string().max(60), z.string().max(500).nullable()).optional(),
  status: z.enum(["subscribed", "unsubscribed"]).optional(),
  unsubscribed_at: z.iso.datetime({ offset: true }).optional(),
  // topic_id → desired subscribed state, applied after the contact is written.
  topics: z.record(z.string().max(100), z.boolean()).optional(),
});
export type ContactInput = z.infer<typeof ContactInputSchema>;

export type ContactWriteResult =
  | { status: "created" | "updated"; contact: Subscriber }
  | { status: "failed"; code: ApiErrorCode; message: string };

// Split an input's attribute bag into set/delete instructions with normalized
// merge-tag-safe keys.
function normalizeAttributeOps(input: ContactInput["attributes"]): {
  set: Record<string, string>;
  del: string[];
} {
  const set: Record<string, string> = {};
  const del: string[] = [];
  for (const [rawKey, rawValue] of Object.entries(input ?? {})) {
    const key = slugifyFieldKey(String(rawKey));
    if (!key || isReservedFieldKey(key)) continue;
    if (rawValue === null) {
      del.push(key);
      continue;
    }
    const value = String(rawValue).trim();
    if (value) set[key] = value;
  }
  return { set, del };
}

const PIPELINE_OWNED_STATUSES = new Set(["bounced", "complained", "suppressed", "pending"]);

type PreparedItem = {
  index: number;
  email: string;
  input: ContactInput;
  attrs: { set: Record<string, string>; del: string[] };
};

export type BatchOutcome = {
  results: ContactWriteResult[];
};

// Write a batch of contact inputs (single create is a batch of one). Throws
// ApiError for whole-request failures (cap crossed, unknown topic ids);
// per-item failures come back in `results` in input order.
export async function writeContacts(
  db: Db,
  account: { id: string; plan: string },
  audienceId: string,
  inputs: ContactInput[],
  opts: { upsert: boolean },
): Promise<BatchOutcome> {
  const results: ContactWriteResult[] = new Array(inputs.length);
  const prepared: PreparedItem[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const email = canonicalizeEmail(input.email);
    if (!isValidEmail(email)) {
      results[i] = { status: "failed", code: "invalid_email", message: "Invalid email address" };
      continue;
    }
    prepared.push({ index: i, email, input, attrs: normalizeAttributeOps(input.attributes) });
  }

  // Validate referenced topic ids once against the audience — an unknown topic
  // id is a caller bug, so it fails the whole request, not one row.
  const topicIds = [...new Set(prepared.flatMap((p) => Object.keys(p.input.topics ?? {})))];
  if (topicIds.length > 0) {
    const rows = await db
      .select({ id: topics.id })
      .from(topics)
      .where(
        and(
          eq(topics.accountId, account.id),
          eq(topics.audienceId, audienceId),
          inArray(topics.id, topicIds),
        ),
      );
    const valid = new Set(rows.map((r) => r.id));
    const unknown = topicIds.find((id) => !valid.has(id));
    if (unknown) {
      throw new ApiError(400, "invalid_request", `Unknown topic: ${unknown}`, { param: "topics" });
    }
  }

  // Suppressed emails fail per-row.
  const suppressed = await getSuppressedEmails(db, account.id, prepared.map((p) => p.email));
  const writable: PreparedItem[] = [];
  for (const p of prepared) {
    if (suppressed.has(p.email)) {
      results[p.index] = {
        status: "failed",
        code: "email_suppressed",
        message: "This email is on the suppression list",
      };
    } else {
      writable.push(p);
    }
  }

  // Existing rows decide created-vs-updated (and conflicts in create mode).
  const existingByEmail = new Map<string, Subscriber>();
  const emails = [...new Set(writable.map((p) => p.email))];
  for (let i = 0; i < emails.length; i += 500) {
    const chunk = emails.slice(i, i + 500);
    const rows = await db
      .select()
      .from(subscribers)
      .where(and(eq(subscribers.audienceId, audienceId), inArray(subscribers.email, chunk)));
    for (const row of rows) existingByEmail.set(row.email, row);
  }

  const creations: PreparedItem[] = [];
  const updates: PreparedItem[] = [];
  for (const p of writable) {
    if (existingByEmail.has(p.email)) {
      if (opts.upsert) updates.push(p);
      else
        results[p.index] = {
          status: "failed",
          code: "contact_already_exists",
          message: "A contact with this email already exists in this audience",
        };
    } else {
      creations.push(p);
    }
  }

  // Free-tier cap: never partially applied — if the creations would cross it,
  // the whole request is rejected before any write.
  if (creations.length > 0) {
    const headroom = await subscriberHeadroom(db, account.id, account.plan);
    if (headroom < creations.length) {
      throw new ApiError(403, "plan_limit_reached", subscriberLimitMessage(account.plan));
    }
  }

  // Auto-register every attribute key that survives normalization (idempotent).
  const allKeys = new Set<string>();
  for (const p of [...creations, ...updates]) {
    for (const key of Object.keys(p.attrs.set)) allKeys.add(key);
  }
  if (allKeys.size > 0) {
    await registerAudienceFields(
      db,
      account.id,
      audienceId,
      [...allKeys].map((key) => ({ key })),
    );
  }

  const now = nowIso();

  // Inserts, chunked well under the 65535-bound-params statement cap.
  const insertRows = creations.map((p) => ({
    id: newId("sub"),
    accountId: account.id,
    audienceId,
    email: p.email,
    firstName: p.input.first_name?.trim() || null,
    lastName: p.input.last_name?.trim() || null,
    attributes: Object.keys(p.attrs.set).length > 0 ? p.attrs.set : null,
    status: (p.input.status ?? "subscribed") as Subscriber["status"],
    source: "api",
    unsubscribedAt:
      p.input.status === "unsubscribed" ? (p.input.unsubscribed_at ?? now) : null,
    createdAt: now,
    updatedAt: now,
  }));
  for (let i = 0; i < insertRows.length; i += 1000) {
    await db.insert(subscribers).values(insertRows.slice(i, i + 1000)).onConflictDoNothing();
  }
  // Re-read what actually landed (a concurrent writer may have raced a row in;
  // that row then reads as a conflict/update rather than silently vanishing).
  const insertedByEmail = new Map<string, Subscriber>();
  const insertedEmails = insertRows.map((r) => r.email);
  for (let i = 0; i < insertedEmails.length; i += 500) {
    const chunk = insertedEmails.slice(i, i + 500);
    const rows = await db
      .select()
      .from(subscribers)
      .where(and(eq(subscribers.audienceId, audienceId), inArray(subscribers.email, chunk)));
    for (const row of rows) insertedByEmail.set(row.email, row);
  }
  const insertedIds = new Set(insertRows.map((r) => r.id));
  for (const p of creations) {
    const row = insertedByEmail.get(p.email);
    if (!row) {
      results[p.index] = { status: "failed", code: "internal_error", message: "Insert failed" };
    } else if (insertedIds.has(row.id)) {
      results[p.index] = { status: "created", contact: row };
    } else if (opts.upsert) {
      updates.push(p); // lost the race to a concurrent insert — fall through to update
    } else {
      results[p.index] = {
        status: "failed",
        code: "contact_already_exists",
        message: "A contact with this email already exists in this audience",
      };
    }
  }

  // Updates: per-row (attribute merge is row-specific).
  for (const p of updates) {
    const existing = existingByEmail.get(p.email) ?? insertedByEmail.get(p.email)!;
    const set: Partial<typeof subscribers.$inferInsert> = { updatedAt: now };
    if (p.input.first_name !== undefined) set.firstName = p.input.first_name?.trim() || null;
    if (p.input.last_name !== undefined) set.lastName = p.input.last_name?.trim() || null;
    if (p.input.attributes !== undefined) {
      const merged: Record<string, string> = { ...(existing.attributes ?? {}) };
      for (const key of p.attrs.del) delete merged[key];
      Object.assign(merged, p.attrs.set);
      set.attributes = Object.keys(merged).length > 0 ? merged : null;
    }
    // status: only subscribed ↔ unsubscribed, and never off a pipeline-owned
    // status — those stay terminal under upsert (the rest of the row updates).
    if (p.input.status !== undefined && !PIPELINE_OWNED_STATUSES.has(existing.status)) {
      if (p.input.status !== existing.status) {
        set.status = p.input.status;
        set.unsubscribedAt =
          p.input.status === "unsubscribed" ? (p.input.unsubscribed_at ?? now) : null;
      }
    }
    const [updated] = await db
      .update(subscribers)
      .set(set)
      .where(eq(subscribers.id, existing.id))
      .returning();
    results[p.index] = { status: "updated", contact: updated };
  }

  // Topic choices, applied after the contact exists.
  for (const p of [...creations, ...updates]) {
    const result = results[p.index];
    if (!p.input.topics || result.status === "failed") continue;
    for (const [topicId, subscribedState] of Object.entries(p.input.topics)) {
      await setTopicSubscription(db, {
        accountId: account.id,
        topicId,
        subscriberId: result.contact.id,
        subscribed: subscribedState,
      });
    }
  }

  return { results };
}
