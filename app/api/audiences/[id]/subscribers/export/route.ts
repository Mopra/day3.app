import { and, asc, eq } from "drizzle-orm";
import { route, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { subscribers } from "@/db/schema";
import { toSubscriberCsv } from "@/lib/csv";

// Turn an audience name into a safe download filename stem: lowercase, only
// [a-z0-9-], collapsed dashes. Falls back to "audience" when nothing remains.
function filenameStem(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "audience";
}

// Export every subscriber in the audience as CSV (all statuses), in the same
// column shape the importer reads back. Scoped by account_id per the hard rules.
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");

  const rows = await db
    .select({
      email: subscribers.email,
      firstName: subscribers.firstName,
      lastName: subscribers.lastName,
      status: subscribers.status,
      attributes: subscribers.attributes,
    })
    .from(subscribers)
    .where(and(eq(subscribers.accountId, account.id), eq(subscribers.audienceId, audience.id)))
    .orderBy(asc(subscribers.email));

  const csv = toSubscriberCsv(rows);
  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filenameStem(audience.name)}-subscribers.csv"`,
      "Cache-Control": "no-store",
    },
  });
});
