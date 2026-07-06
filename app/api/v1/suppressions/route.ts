import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { ApiError, apiJson } from "@/api/v1/errors";
import { withIdempotency } from "@/api/v1/idempotency";
import { cursorCondition, pageResponse, parsePageQuery } from "@/api/v1/pagination";
import {
  PUBLIC_SUPPRESSION_REASONS,
  PUBLIC_TO_REASON,
  serializeSuppression,
} from "@/api/v1/serialize";
import type { Db } from "@/db/client";
import { suppressionEntries } from "@/db/schema";
import { canonicalizeEmail, isValidEmail } from "@/lib/csv";
import { newId, nowIso } from "@/lib/ids";

const MAX_BATCH = 1000;

// GET /api/v1/suppressions — the account's own suppression entries (global
// platform-level entries are not listed; GET /v1/suppressions/{email} checks
// both).
export const GET = apiRoute(async (req, { db, account }) => {
  const { limit, after } = parsePageQuery(req);
  const filters = [eq(suppressionEntries.accountId, account.id)];
  if (after) filters.push(cursorCondition(suppressionEntries.createdAt, suppressionEntries.id, after));

  const rows = await db
    .select()
    .from(suppressionEntries)
    .where(and(...filters))
    .orderBy(desc(suppressionEntries.createdAt), desc(suppressionEntries.id))
    .limit(limit + 1);

  return apiJson(pageResponse(rows, limit, serializeSuppression));
});

const ImportSchema = z.object({
  // Required and explicit — no default. An accidental import must be
  // attributable ("who suppressed these, and as what?").
  reason: z.enum(PUBLIC_SUPPRESSION_REASONS),
  emails: z.array(z.string().trim().max(320)).min(1).max(MAX_BATCH),
});

async function countSuppressed(db: Db, accountId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(distinct ${suppressionEntries.email})`.as("count") })
    .from(suppressionEntries)
    .where(eq(suppressionEntries.accountId, accountId));
  return Number(count);
}

// POST /api/v1/suppressions — import a suppression list (the old provider's
// unsubscribes / hard bounces / complaints). Deliberately guardrailed: this is
// the API's biggest foot-gun (posting the wrong file makes a whole audience
// unmailable), so:
//   - add-only: there is no DELETE in v1; un-suppression is a deliberate act
//     in the app UI, per entry — a scripting mistake is human-recoverable but
//     can't be script-reverted or abused to force-mail bounced addresses
//   - the response reports the blast radius (before/after totals)
//   - entries are tagged source "api:<key id>" so the app can offer
//     "undo this import" over exactly these rows
// Suppressing never deletes contact rows — they just become unmailable.
export const POST = apiRoute(async (req, ctx) => {
  const body = await readJson(req, ImportSchema);

  return withIdempotency(ctx, req, "POST /v1/suppressions", body, async () => {
    const { db, account, apiKey } = ctx;
    const reason = PUBLIC_TO_REASON[body.reason];
    const now = nowIso();

    const seen = new Set<string>();
    const rows: (typeof suppressionEntries.$inferInsert)[] = [];
    let invalid = 0;
    for (const raw of body.emails) {
      const email = canonicalizeEmail(raw);
      if (!isValidEmail(email)) {
        invalid++;
        continue;
      }
      if (seen.has(email)) continue; // in-payload duplicate — harmless, dedupe
      seen.add(email);
      rows.push({
        id: newId("sup"),
        accountId: account.id,
        email,
        scope: "account",
        reason,
        source: `api:${apiKey.id}`,
        createdAt: now,
      });
    }
    if (rows.length === 0 && invalid > 0) {
      throw new ApiError(400, "invalid_email", "No valid email addresses in the payload", {
        param: "emails",
      });
    }

    const before = await countSuppressed(db, account.id);

    // onConflictDoNothing on (account, email, reason): already-suppressed
    // entries are counted, not duplicated. Chunked under the bound-params cap.
    let added = 0;
    for (let i = 0; i < rows.length; i += 1000) {
      const inserted = await db
        .insert(suppressionEntries)
        .values(rows.slice(i, i + 1000))
        .onConflictDoNothing()
        .returning({ id: suppressionEntries.id });
      added += inserted.length;
    }

    const after = await countSuppressed(db, account.id);

    return apiJson({
      object: "suppression_import",
      reason: body.reason,
      added,
      already_suppressed: rows.length - added,
      invalid,
      total_suppressed_before: before,
      total_suppressed_after: after,
    });
  });
});
