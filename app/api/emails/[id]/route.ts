import { and, asc, eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { emailEvents, transactionalEmails } from "@/db/schema";

// One transactional email with its full content (until the retention prune)
// and delivery-event timeline — the drawer on the /emails page.
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { db, account } = await requireAccount();
  const { id } = await params;

  const email = await db.query.transactionalEmails.findFirst({
    where: and(eq(transactionalEmails.id, id), eq(transactionalEmails.accountId, account.id)),
  });
  if (!email) throw new HttpError(404, "Email not found");

  const events = await db
    .select({
      id: emailEvents.id,
      eventType: emailEvents.eventType,
      payloadJson: emailEvents.payloadJson,
      createdAt: emailEvents.createdAt,
    })
    .from(emailEvents)
    .where(
      and(eq(emailEvents.accountId, account.id), eq(emailEvents.transactionalEmailId, email.id)),
    )
    .orderBy(asc(emailEvents.createdAt), asc(emailEvents.id))
    .limit(50);

  return json({ email, events });
});
