import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { ApiError, apiJson } from "@/api/v1/errors";
import { effectiveTopics } from "@/api/v1/contact-topics";
import { requireAudienceV1, requireContactV1 } from "@/api/v1/finders";
import { serializeContact } from "@/api/v1/serialize";
import { subscribers, topicSubscriptions } from "@/db/schema";
import { slugifyFieldKey, isReservedFieldKey } from "@/lib/form-fields";
import { nowIso } from "@/lib/ids";
import { registerAudienceFields } from "@/services/audience-fields";

// {contactRef} is a sub_… id or a URL-encoded email — email is unique per
// audience, so both address exactly one contact.
type Params = { params: Promise<{ audienceId: string; contactRef: string }> };

// GET /api/v1/audiences/{id}/contacts/{id_or_email}[?expand=topics]
export const GET = apiRoute<Params>(async (req, { db, account }, { params }) => {
  const { audienceId, contactRef } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const contact = await requireContactV1(db, account.id, audience.id, contactRef);
  const expandTopics = req.nextUrl.searchParams.get("expand") === "topics";
  return apiJson(
    serializeContact(
      contact,
      expandTopics ? await effectiveTopics(db, account.id, audience.id, contact.id) : undefined,
    ),
  );
});

const PatchContactSchema = z.object({
  first_name: z.string().trim().max(100).nullable().optional(),
  last_name: z.string().trim().max(100).nullable().optional(),
  attributes: z.record(z.string().max(60), z.string().max(500).nullable()).optional(),
  status: z.enum(["subscribed", "unsubscribed"]).optional(),
});

const PIPELINE_OWNED = new Set(["bounced", "complained", "suppressed", "pending"]);

// PATCH /api/v1/audiences/{id}/contacts/{id_or_email} — partial update.
// `attributes` is a shallow merge (null deletes a key); `status` may only flip
// subscribed ↔ unsubscribed. Pipeline-owned statuses are immutable.
export const PATCH = apiRoute<Params>(async (req, { db, account }, { params }) => {
  const { audienceId, contactRef } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const contact = await requireContactV1(db, account.id, audience.id, contactRef);
  const body = await readJson(req, PatchContactSchema);

  const set: Partial<typeof subscribers.$inferInsert> = { updatedAt: nowIso() };
  if (body.first_name !== undefined) set.firstName = body.first_name?.trim() || null;
  if (body.last_name !== undefined) set.lastName = body.last_name?.trim() || null;

  if (body.attributes !== undefined) {
    const merged: Record<string, string> = { ...(contact.attributes ?? {}) };
    const newKeys: string[] = [];
    for (const [rawKey, rawValue] of Object.entries(body.attributes)) {
      const key = slugifyFieldKey(rawKey);
      if (!key || isReservedFieldKey(key)) continue;
      if (rawValue === null) {
        delete merged[key];
        continue;
      }
      const value = rawValue.trim();
      if (!value) continue;
      merged[key] = value;
      newKeys.push(key);
    }
    set.attributes = Object.keys(merged).length > 0 ? merged : null;
    if (newKeys.length > 0) {
      await registerAudienceFields(db, account.id, audience.id, newKeys.map((key) => ({ key })));
    }
  }

  if (body.status !== undefined && body.status !== contact.status) {
    if (PIPELINE_OWNED.has(contact.status)) {
      throw new ApiError(
        422,
        "immutable_field",
        `A "${contact.status}" contact's status is set by the delivery pipeline and cannot be changed via the API`,
        { param: "status" },
      );
    }
    set.status = body.status;
    set.unsubscribedAt = body.status === "unsubscribed" ? nowIso() : null;
  }

  const [updated] = await db
    .update(subscribers)
    .set(set)
    .where(eq(subscribers.id, contact.id))
    .returning();
  return apiJson(serializeContact(updated));
});

// DELETE /api/v1/audiences/{id}/contacts/{id_or_email} — erases the row (GDPR).
// To stop mailing someone without erasing them, PATCH status=unsubscribed.
export const DELETE = apiRoute<Params>(async (_req, { db, account }, { params }) => {
  const { audienceId, contactRef } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const contact = await requireContactV1(db, account.id, audience.id, contactRef);
  await db.delete(topicSubscriptions).where(eq(topicSubscriptions.subscriberId, contact.id));
  await db.delete(subscribers).where(eq(subscribers.id, contact.id));
  return apiJson({ id: contact.id, object: "contact", deleted: true });
});
