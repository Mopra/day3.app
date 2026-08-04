import { and, asc, eq } from "drizzle-orm";
import { apiRoute } from "@/api/v1/route";
import { ApiError, apiJson } from "@/api/v1/errors";
import { serializeEmail } from "@/api/v1/serialize";
import { emailEvents, transactionalEmails } from "@/db/schema";

// GET /api/v1/emails/{id} — one transactional email with its delivery events
// (sent → delivered / bounced / complained, fed by the provider webhook). This
// is the status poll a caller uses after POST /v1/emails.
export const GET = apiRoute<{ params: Promise<{ emailId: string }> }>(
  async (_req, { db, account }, { params }) => {
    const { emailId } = await params;

    const email = await db.query.transactionalEmails.findFirst({
      where: and(
        eq(transactionalEmails.id, emailId),
        eq(transactionalEmails.accountId, account.id),
      ),
    });
    if (!email) throw new ApiError(404, "not_found", "No such email");

    const events = await db
      .select({ eventType: emailEvents.eventType, createdAt: emailEvents.createdAt })
      .from(emailEvents)
      .where(
        and(
          eq(emailEvents.accountId, account.id),
          eq(emailEvents.transactionalEmailId, email.id),
        ),
      )
      .orderBy(asc(emailEvents.createdAt), asc(emailEvents.id))
      .limit(50);

    return apiJson(serializeEmail(email, events));
  },
);
