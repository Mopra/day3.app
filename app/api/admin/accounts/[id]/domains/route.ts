import { desc, eq } from "drizzle-orm";
import { route, json } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { sendingDomains } from "@/db/schema";

// Lets the admin see (and override-verify) any account's domains.
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { db } = await requireAdmin();
  const { id } = await params;
  const rows = await db
    .select()
    .from(sendingDomains)
    .where(eq(sendingDomains.accountId, id))
    .orderBy(desc(sendingDomains.createdAt));
  return json({ domains: rows });
});
