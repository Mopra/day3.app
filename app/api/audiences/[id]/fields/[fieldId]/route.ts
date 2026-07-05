import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { audienceFields, subscribers, AUDIENCE_FIELD_TYPES } from "@/db/schema";
import { nowIso } from "@/lib/ids";

type Params = { params: Promise<{ id: string; fieldId: string }> };

async function findField(
  db: Awaited<ReturnType<typeof requireAccount>>["db"],
  accountId: string,
  audienceId: string,
  fieldId: string,
) {
  return db.query.audienceFields.findFirst({
    where: and(
      eq(audienceFields.id, fieldId),
      eq(audienceFields.accountId, accountId),
      eq(audienceFields.audienceId, audienceId),
    ),
  });
}

const UpdateFieldSchema = z.object({
  label: z.string().trim().min(1).max(60).optional(),
  type: z.enum(AUDIENCE_FIELD_TYPES).optional(),
  // "" clears the fallback.
  fallback: z.string().trim().max(500).optional(),
});

// PATCH /api/audiences/[id]/fields/[fieldId] — edit label/type/fallback. The
// key is deliberately immutable: it's both the {{merge_tag}} and the
// subscribers.attributes key, so renaming it would orphan every stored value
// and silently break campaigns that reference it.
export const PATCH = route<Params>(async (req, { params }) => {
  const { id, fieldId } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");
  const field = await findField(db, account.id, audience.id, fieldId);
  if (!field) throw new HttpError(404, "Not found");

  const data = await parseJson(req, UpdateFieldSchema);
  const set: Partial<typeof audienceFields.$inferInsert> = { updatedAt: nowIso() };
  if (data.label !== undefined) set.label = data.label;
  if (data.type !== undefined) set.type = data.type;
  if (data.fallback !== undefined) set.fallback = data.fallback || null;

  const [updated] = await db
    .update(audienceFields)
    .set(set)
    .where(eq(audienceFields.id, field.id))
    .returning();
  return json({ field: updated });
});

// DELETE /api/audiences/[id]/fields/[fieldId][?purge=1] — remove the field from
// the registry (menus, columns, merge suggestions). Stored subscriber values are
// KEPT by default — a later import/edit carrying the key re-registers it
// (auto-detect semantics). With ?purge=1 the value is also stripped from every
// subscriber in the audience, so the field is gone for good.
export const DELETE = route<Params>(async (req, { params }) => {
  const { id, fieldId } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");
  const field = await findField(db, account.id, audience.id, fieldId);
  if (!field) throw new HttpError(404, "Not found");

  const purge = req.nextUrl.searchParams.get("purge") === "1";
  if (purge) {
    // jsonb `-` drops the key; the `?` guard keeps the update off rows that
    // never had it. One statement, safe at any audience size.
    await db
      .update(subscribers)
      .set({
        // ::text — `jsonb - ?` is otherwise ambiguous (text vs integer overloads).
        attributes: sql`${subscribers.attributes} - ${field.key}::text`,
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(subscribers.audienceId, audience.id),
          sql`${subscribers.attributes} ? ${field.key}`,
        ),
      );
  }

  await db.delete(audienceFields).where(eq(audienceFields.id, field.id));
  return json({ ok: true });
});
