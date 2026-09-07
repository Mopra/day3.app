import { z } from "zod";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { ACTIVITY_SOURCES, getActivitySend } from "@/services/activity";

const Query = z.object({ source: z.enum(ACTIVITY_SOURCES) });

// One send with its event timeline — the drawer on the Activity page. `source`
// says which ledger the id lives in; an API send also returns its content
// (until the retention prune nulls the bodies).
export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { db, account } = await requireAccount();
  const { id } = await params;
  const query = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success) throw new HttpError(400, "Invalid query");

  const result = await getActivitySend(db, account.id, query.data.source, id);
  if (!result) throw new HttpError(404, "Send not found");

  const { send, events, email } = result;
  return json({
    send,
    events,
    email: email
      ? {
          replyTo: email.replyTo,
          fromName: email.fromName,
          to: email.to,
          tags: email.tags,
          htmlBody: email.htmlBody,
          textBody: email.textBody,
          bodyPrunedAt: email.bodyPrunedAt,
        }
      : null,
  });
});
