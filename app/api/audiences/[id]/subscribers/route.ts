import { and, desc, eq, like, sql } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { subscribers } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { isValidEmail } from "@/lib/csv";
import { isEmailSuppressed } from "@/services/suppression";

const ListSubscribersSchema = z.object({
  status: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");

  const query = ListSubscribersSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success) throw new HttpError(400, "Invalid query");
  const { status, search, limit, offset } = query.data;

  const filters = [eq(subscribers.audienceId, audience.id)];
  if (status) filters.push(eq(subscribers.status, status as never));
  if (search) filters.push(like(subscribers.email, `%${search.toLowerCase()}%`));

  const rows = await db
    .select()
    .from(subscribers)
    .where(and(...filters))
    .orderBy(desc(subscribers.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)`.as("total") })
    .from(subscribers)
    .where(and(...filters));

  return json({ subscribers: rows, total: Number(total) });
});

const AddSubscriberSchema = z.object({
  email: z.email().trim().toLowerCase(),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
});

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");

  const { email, firstName, lastName } = await parseJson(req, AddSubscriberSchema);
  if (!isValidEmail(email)) throw new HttpError(400, "Invalid email");
  if (await isEmailSuppressed(db, account.id, email)) {
    throw new HttpError(409, "This email is on the suppression list");
  }

  const now = nowIso();
  const inserted = await db
    .insert(subscribers)
    .values({
      id: newId("sub"),
      accountId: account.id,
      audienceId: audience.id,
      email,
      firstName: firstName ?? null,
      lastName: lastName ?? null,
      status: "subscribed",
      source: "manual",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: subscribers.id });

  if (inserted.length === 0) {
    throw new HttpError(409, "This email is already in the audience");
  }
  return json({ ok: true, id: inserted[0].id }, 201);
});
