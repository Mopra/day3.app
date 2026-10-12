import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { listTopicRows } from "@/api/audience-detail";
import { topics } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";

// A generous backstop, well above any real setup.
const MAX_TOPICS = 20;

// GET /api/audiences/[id]/topics — the audience's topics with how many contacts
// have explicitly opted out / in (deviations from the default; everyone else
// follows defaultSubscribed).
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");

  return json({ topics: await listTopicRows(db, account.id, audience.id) });
});

const CreateTopicSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional().or(z.literal("")),
  defaultSubscribed: z.boolean().optional(),
});

// POST /api/audiences/[id]/topics — create a topic. defaultSubscribed=true
// (the default) is the opt-out model: everyone receives it unless they leave.
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");

  const input = await parseJson(req, CreateTopicSchema);

  const existing = await db
    .select({ id: topics.id })
    .from(topics)
    .where(and(eq(topics.accountId, account.id), eq(topics.audienceId, audience.id)));
  if (existing.length >= MAX_TOPICS) {
    throw new HttpError(400, `An audience can have up to ${MAX_TOPICS} topics`);
  }

  const now = nowIso();
  const topicId = newId("top");
  await db.insert(topics).values({
    id: topicId,
    accountId: account.id,
    audienceId: audience.id,
    name: input.name,
    description: input.description || null,
    defaultSubscribed: input.defaultSubscribed ?? true,
    createdAt: now,
    updatedAt: now,
  });

  return json(
    {
      topic: {
        id: topicId,
        name: input.name,
        description: input.description || null,
        defaultSubscribed: input.defaultSubscribed ?? true,
        optedOut: 0,
        optedIn: 0,
        createdAt: now,
      },
    },
    201,
  );
});
