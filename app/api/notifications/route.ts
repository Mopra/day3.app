import { and, eq, isNull, sql } from "drizzle-orm";
import { route, json, parseJson } from "@/api/http";
import { requireAccount } from "@/api/context";
import { z } from "zod";
import { notifications } from "@/db/schema";
import { listNotifications, markAllNotificationsRead, markNotificationRead } from "@/services/notifications";

// The in-app notification bell: recent account notifications + an unread count.
export const GET = route(async () => {
  const { db, account } = await requireAccount();
  const rows = await listNotifications(db, account.id, 20);
  const [{ unread }] = await db
    .select({ unread: sql<number>`count(*)`.as("unread") })
    .from(notifications)
    .where(and(eq(notifications.accountId, account.id), isNull(notifications.readAt)));
  return json({ notifications: rows, unreadCount: Number(unread) });
});

const ReadSchema = z.object({
  // A specific notification to mark read, or omitted to mark all read.
  id: z.string().optional(),
});

export const POST = route(async (req) => {
  const { db, account } = await requireAccount();
  const { id } = await parseJson(req, ReadSchema);
  if (id) {
    await markNotificationRead(db, account.id, id);
  } else {
    await markAllNotificationsRead(db, account.id);
  }
  return json({ ok: true });
});
