import { desc } from "drizzle-orm";
import { route, json } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { accounts } from "@/db/schema";

export const GET = route(async () => {
  const { db } = await requireAdmin();
  const rows = await db.select().from(accounts).orderBy(desc(accounts.createdAt));
  return json({ accounts: rows });
});
