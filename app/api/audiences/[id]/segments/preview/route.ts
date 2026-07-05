import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { subscribers } from "@/db/schema";
import { SegmentFilterSchema, segmentFilterCondition } from "@/lib/segment-filter";

const PreviewSchema = z.object({ filter: SegmentFilterSchema });

// POST /api/audiences/[id]/segments/preview — how many subscribed contacts a
// filter matches right now. Powers the live count in the segment editor, so the
// user sees what a condition does before saving it.
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");

  const { filter } = await parseJson(req, PreviewSchema);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)`.as("count") })
    .from(subscribers)
    .where(
      and(
        eq(subscribers.audienceId, audience.id),
        eq(subscribers.status, "subscribed"),
        segmentFilterCondition(filter),
      ),
    );
  return json({ count: Number(count) });
});
