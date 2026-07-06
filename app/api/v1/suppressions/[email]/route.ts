import { and, desc, eq, isNull, or } from "drizzle-orm";
import { apiRoute } from "@/api/v1/route";
import { ApiError, apiJson } from "@/api/v1/errors";
import { serializeSuppression } from "@/api/v1/serialize";
import { suppressionEntries } from "@/db/schema";
import { canonicalizeEmail } from "@/lib/csv";

// GET /api/v1/suppressions/{email} — is this address suppressed for the
// account (or platform-wide)? 200 with the entry (and why), 404 if clean.
// Lets a migration script explain a batch item's `email_suppressed` failure.
export const GET = apiRoute<{ params: Promise<{ email: string }> }>(
  async (_req, { db, account }, { params }) => {
    const { email: raw } = await params;
    const email = canonicalizeEmail(decodeURIComponent(raw));

    const entry = await db.query.suppressionEntries.findFirst({
      where: and(
        eq(suppressionEntries.email, email),
        or(
          eq(suppressionEntries.accountId, account.id),
          isNull(suppressionEntries.accountId),
          eq(suppressionEntries.scope, "global"),
        ),
      ),
      orderBy: desc(suppressionEntries.createdAt),
    });
    if (!entry) throw new ApiError(404, "not_found", "This email is not suppressed");
    return apiJson(serializeSuppression(entry));
  },
);
