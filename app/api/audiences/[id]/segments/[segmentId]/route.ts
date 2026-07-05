import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { campaigns, segments } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { SegmentFilterSchema } from "@/lib/segment-filter";

type Params = { params: Promise<{ id: string; segmentId: string }> };

// Campaign statuses where the send pipeline may still read the segment; deleting
// it out from under them would change (or break) who receives the email.
const ACTIVE_STATUSES = [
  "scheduled",
  "pending_review",
  "approved",
  "generating_recipients",
  "sending",
  "paused",
] as const;

async function findSegment(
  db: Awaited<ReturnType<typeof requireAccount>>["db"],
  accountId: string,
  audienceId: string,
  segmentId: string,
) {
  return db.query.segments.findFirst({
    where: and(
      eq(segments.id, segmentId),
      eq(segments.accountId, accountId),
      eq(segments.audienceId, audienceId),
    ),
  });
}

const UpdateSegmentSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  filter: SegmentFilterSchema.optional(),
});

// PATCH /api/audiences/[id]/segments/[segmentId] — rename or refine the filter.
// Segments are dynamic, so an edited filter takes effect everywhere immediately
// (including campaigns not yet generated).
export const PATCH = route<Params>(async (req, { params }) => {
  const { id, segmentId } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");
  const segment = await findSegment(db, account.id, audience.id, segmentId);
  if (!segment) throw new HttpError(404, "Not found");

  const data = await parseJson(req, UpdateSegmentSchema);
  const set: Partial<typeof segments.$inferInsert> = { updatedAt: nowIso() };
  if (data.name !== undefined) set.name = data.name;
  if (data.filter !== undefined) set.filterJson = JSON.stringify(data.filter);

  const [updated] = await db
    .update(segments)
    .set(set)
    .where(eq(segments.id, segment.id))
    .returning();
  return json({ segment: updated });
});

// DELETE /api/audiences/[id]/segments/[segmentId]. Blocked while a scheduled or
// in-flight campaign targets the segment (the pipeline still reads it); drafts
// and finished campaigns get their reference cleared (a draft simply falls back
// to "everyone" and the composer shows that).
export const DELETE = route<Params>(async (_req, { params }) => {
  const { id, segmentId } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");
  const segment = await findSegment(db, account.id, audience.id, segmentId);
  if (!segment) throw new HttpError(404, "Not found");

  const active = await db
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.accountId, account.id),
        eq(campaigns.segmentId, segment.id),
        inArray(campaigns.status, [...ACTIVE_STATUSES]),
      ),
    );
  if (active.length > 0) {
    throw new HttpError(
      409,
      `"${active[0].name}" is scheduled or sending to this segment — pause or finish it first`,
    );
  }

  await db
    .update(campaigns)
    .set({ segmentId: null, updatedAt: nowIso() })
    .where(and(eq(campaigns.accountId, account.id), eq(campaigns.segmentId, segment.id)));
  await db.delete(segments).where(eq(segments.id, segment.id));
  return json({ ok: true });
});
