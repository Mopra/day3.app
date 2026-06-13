import { Hono } from "hono";
import { and, desc, eq, like, sql } from "drizzle-orm";
import { z } from "zod";
import { audiences, imports, subscribers } from "../db/schema";
import { newId, nowIso } from "../lib/ids";
import { isValidEmail, MAX_IMPORT_ROWS } from "../lib/csv";
import { isEmailSuppressed } from "../services/suppression";
import { requireAccount } from "./middleware";
import { parseJson } from "./validate";
import type { AppContext } from "./context";

export const audienceRoutes = new Hono<AppContext>();
audienceRoutes.use("*", requireAccount);

audienceRoutes.get("/", async (c) => {
  const db = c.get("db");
  const accountId = c.get("account").id;
  const rows = await db
    .select({
      id: audiences.id,
      name: audiences.name,
      createdAt: audiences.createdAt,
      subscriberCount: sql<number>`(
        SELECT count(*) FROM subscribers s
        WHERE s.audience_id = ${audiences.id} AND s.status = 'subscribed'
      )`.as("subscriberCount"),
    })
    .from(audiences)
    .where(eq(audiences.accountId, accountId))
    .orderBy(desc(audiences.createdAt));
  return c.json({ audiences: rows });
});

const CreateAudienceSchema = z.object({ name: z.string().trim().min(1).max(100) });

audienceRoutes.post("/", async (c) => {
  const parsed = await parseJson(c, CreateAudienceSchema);
  if (!parsed.ok) return parsed.response;
  const id = newId("aud");
  const now = nowIso();
  await c.get("db").insert(audiences).values({
    id,
    accountId: c.get("account").id,
    name: parsed.data.name,
    createdAt: now,
    updatedAt: now,
  });
  return c.json({ audience: { id, name: parsed.data.name } }, 201);
});

async function findAudience(c: { get: (k: "db" | "account") => unknown }, id: string) {
  const db = c.get("db") as AppContext["Variables"]["db"];
  const account = c.get("account") as AppContext["Variables"]["account"];
  return db.query.audiences.findFirst({
    where: and(eq(audiences.id, id), eq(audiences.accountId, account.id)),
  });
}

audienceRoutes.get("/:id", async (c) => {
  const audience = await findAudience(c, c.req.param("id"));
  if (!audience) return c.json({ error: "Not found" }, 404);

  const counts = await c
    .get("db")
    .select({ status: subscribers.status, count: sql<number>`count(*)`.as("count") })
    .from(subscribers)
    .where(eq(subscribers.audienceId, audience.id))
    .groupBy(subscribers.status);

  return c.json({
    audience,
    counts: Object.fromEntries(counts.map((r) => [r.status, Number(r.count)])),
  });
});

audienceRoutes.delete("/:id", async (c) => {
  const audience = await findAudience(c, c.req.param("id"));
  if (!audience) return c.json({ error: "Not found" }, 404);
  const db = c.get("db");
  await db.delete(subscribers).where(eq(subscribers.audienceId, audience.id));
  await db.delete(audiences).where(eq(audiences.id, audience.id));
  return c.json({ ok: true });
});

const ListSubscribersSchema = z.object({
  status: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

audienceRoutes.get("/:id/subscribers", async (c) => {
  const audience = await findAudience(c, c.req.param("id"));
  if (!audience) return c.json({ error: "Not found" }, 404);

  const query = ListSubscribersSchema.safeParse(c.req.query());
  if (!query.success) return c.json({ error: "Invalid query" }, 400);
  const { status, search, limit, offset } = query.data;

  const filters = [eq(subscribers.audienceId, audience.id)];
  if (status) filters.push(eq(subscribers.status, status as never));
  if (search) filters.push(like(subscribers.email, `%${search.toLowerCase()}%`));

  const rows = await c
    .get("db")
    .select()
    .from(subscribers)
    .where(and(...filters))
    .orderBy(desc(subscribers.createdAt))
    .limit(limit)
    .offset(offset);

  const [{ total }] = await c
    .get("db")
    .select({ total: sql<number>`count(*)`.as("total") })
    .from(subscribers)
    .where(and(...filters));

  return c.json({ subscribers: rows, total: Number(total) });
});

const AddSubscriberSchema = z.object({
  email: z.email().toLowerCase(),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
});

audienceRoutes.post("/:id/subscribers", async (c) => {
  const audience = await findAudience(c, c.req.param("id"));
  if (!audience) return c.json({ error: "Not found" }, 404);

  const parsed = await parseJson(c, AddSubscriberSchema);
  if (!parsed.ok) return parsed.response;
  const { email, firstName, lastName } = parsed.data;
  const account = c.get("account");

  if (!isValidEmail(email)) return c.json({ error: "Invalid email" }, 400);
  if (await isEmailSuppressed(c.get("db"), account.id, email)) {
    return c.json({ error: "This email is on the suppression list" }, 409);
  }

  const now = nowIso();
  const inserted = await c
    .get("db")
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
    return c.json({ error: "This email is already in the audience" }, 409);
  }
  return c.json({ ok: true, id: inserted[0].id }, 201);
});

// CSV import: store the file in R2, create the import row, enqueue the job.
audienceRoutes.post("/:id/import", async (c) => {
  const audience = await findAudience(c, c.req.param("id"));
  if (!audience) return c.json({ error: "Not found" }, 404);

  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "Upload a CSV file in the 'file' field" }, 400);
  }
  if (file.size > 5 * 1024 * 1024) {
    return c.json({ error: "CSV too large (max 5 MB)" }, 400);
  }

  const account = c.get("account");
  const importId = newId("imp");
  const r2Key = `imports/${account.id}/${importId}.csv`;
  await c.env.IMPORTS_BUCKET.put(r2Key, await file.arrayBuffer(), {
    httpMetadata: { contentType: "text/csv" },
  });

  const now = nowIso();
  await c.get("db").insert(imports).values({
    id: importId,
    accountId: account.id,
    audienceId: audience.id,
    r2Key,
    filename: file.name || "subscribers.csv",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });

  await c.env.JOBS_QUEUE.send({
    type: "process_import",
    importId,
    accountId: account.id,
  });

  return c.json({ importId, maxRows: MAX_IMPORT_ROWS }, 202);
});

audienceRoutes.get("/:id/imports", async (c) => {
  const audience = await findAudience(c, c.req.param("id"));
  if (!audience) return c.json({ error: "Not found" }, 404);
  const rows = await c
    .get("db")
    .select()
    .from(imports)
    .where(eq(imports.audienceId, audience.id))
    .orderBy(desc(imports.createdAt))
    .limit(10);
  return c.json({ imports: rows });
});
