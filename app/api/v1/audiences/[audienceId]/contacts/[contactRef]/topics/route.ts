import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { ApiError, apiJson } from "@/api/v1/errors";
import { effectiveTopics } from "@/api/v1/contact-topics";
import { requireAudienceV1, requireContactV1 } from "@/api/v1/finders";
import { topics } from "@/db/schema";
import { setTopicSubscription } from "@/services/topic-subscription";

type Params = { params: Promise<{ audienceId: string; contactRef: string }> };

// GET /api/v1/audiences/{id}/contacts/{id_or_email}/topics
export const GET = apiRoute<Params>(async (_req, { db, account }, { params }) => {
  const { audienceId, contactRef } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const contact = await requireContactV1(db, account.id, audience.id, contactRef);
  return apiJson({ data: await effectiveTopics(db, account.id, audience.id, contact.id) });
});

const PatchTopicsSchema = z.object({
  // topic_id → desired state; topics not mentioned are left untouched.
  topics: z.record(z.string().max(100), z.boolean()),
});

// PATCH /api/v1/audiences/{id}/contacts/{id_or_email}/topics — record explicit
// choices for the listed topics only (sparse-row model).
export const PATCH = apiRoute<Params>(async (req, { db, account }, { params }) => {
  const { audienceId, contactRef } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const contact = await requireContactV1(db, account.id, audience.id, contactRef);
  const body = await readJson(req, PatchTopicsSchema);

  const topicIds = Object.keys(body.topics);
  if (topicIds.length > 0) {
    const rows = await db
      .select({ id: topics.id })
      .from(topics)
      .where(
        and(
          eq(topics.accountId, account.id),
          eq(topics.audienceId, audience.id),
          inArray(topics.id, topicIds),
        ),
      );
    const valid = new Set(rows.map((r) => r.id));
    const unknown = topicIds.find((id) => !valid.has(id));
    if (unknown) {
      throw new ApiError(400, "invalid_request", `Unknown topic: ${unknown}`, { param: "topics" });
    }
    for (const topicId of topicIds) {
      await setTopicSubscription(db, {
        accountId: account.id,
        topicId,
        subscriberId: contact.id,
        subscribed: body.topics[topicId],
      });
    }
  }

  return apiJson({ data: await effectiveTopics(db, account.id, audience.id, contact.id) });
});
