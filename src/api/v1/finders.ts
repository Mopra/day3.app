import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  audienceFields,
  audiences,
  segments,
  subscribers,
  topics,
  type Audience,
  type AudienceField,
  type Segment,
  type Subscriber,
  type Topic,
} from "../../db/schema";
import { canonicalizeEmail } from "../../lib/csv";
import { ApiError } from "./errors";

// Account-scoped lookups for the v1 routes. Cross-account ids resolve to the
// same 404 as unknown ids — existence is never leaked across tenants.

const NOT_FOUND = () => new ApiError(404, "not_found", "Not found");

export async function requireAudienceV1(
  db: Db,
  accountId: string,
  audienceId: string,
): Promise<Audience> {
  const audience = await db.query.audiences.findFirst({
    where: and(eq(audiences.id, audienceId), eq(audiences.accountId, accountId)),
  });
  if (!audience) throw NOT_FOUND();
  return audience;
}

// Contacts are addressable by prefixed id (sub_…) OR by email — email is
// unique per audience, so both are unambiguous. Anything containing "@" is
// treated as an email.
export async function findContactByRef(
  db: Db,
  accountId: string,
  audienceId: string,
  ref: string,
): Promise<Subscriber | undefined> {
  const decoded = decodeURIComponent(ref);
  const byEmail = decoded.includes("@");
  return db.query.subscribers.findFirst({
    where: and(
      eq(subscribers.accountId, accountId),
      eq(subscribers.audienceId, audienceId),
      byEmail ? eq(subscribers.email, canonicalizeEmail(decoded)) : eq(subscribers.id, decoded),
    ),
  });
}

export async function requireContactV1(
  db: Db,
  accountId: string,
  audienceId: string,
  ref: string,
): Promise<Subscriber> {
  const contact = await findContactByRef(db, accountId, audienceId, ref);
  if (!contact) throw NOT_FOUND();
  return contact;
}

// Fields are addressable by id (fld_…) or by key.
export async function requireFieldV1(
  db: Db,
  accountId: string,
  audienceId: string,
  ref: string,
): Promise<AudienceField> {
  const byId = ref.startsWith("fld_");
  const field = await db.query.audienceFields.findFirst({
    where: and(
      eq(audienceFields.accountId, accountId),
      eq(audienceFields.audienceId, audienceId),
      byId ? eq(audienceFields.id, ref) : eq(audienceFields.key, ref.toLowerCase()),
    ),
  });
  if (!field) throw NOT_FOUND();
  return field;
}

export async function requireSegmentV1(
  db: Db,
  accountId: string,
  audienceId: string,
  segmentId: string,
): Promise<Segment> {
  const segment = await db.query.segments.findFirst({
    where: and(
      eq(segments.id, segmentId),
      eq(segments.accountId, accountId),
      eq(segments.audienceId, audienceId),
    ),
  });
  if (!segment) throw NOT_FOUND();
  return segment;
}

export async function requireTopicV1(
  db: Db,
  accountId: string,
  audienceId: string,
  topicId: string,
): Promise<Topic> {
  const topic = await db.query.topics.findFirst({
    where: and(
      eq(topics.id, topicId),
      eq(topics.accountId, accountId),
      eq(topics.audienceId, audienceId),
    ),
  });
  if (!topic) throw NOT_FOUND();
  return topic;
}
