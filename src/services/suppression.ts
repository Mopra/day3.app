import { and, eq, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { suppressionEntries, type SuppressionReason } from "../db/schema";
import { canonicalizeEmail } from "../lib/csv";
import { newId, nowIso } from "../lib/ids";

// Emails suppressed for this account (account scope) or globally. Returned set
// members and the optional `emails` filter are compared in canonical form
// (trimmed + lowercased) so callers must look up canonical emails too.
export async function getSuppressedEmails(
  db: Db,
  accountId: string,
  emails?: string[],
): Promise<Set<string>> {
  const scopeFilter = or(
    eq(suppressionEntries.accountId, accountId),
    isNull(suppressionEntries.accountId),
    eq(suppressionEntries.scope, "global"),
  );

  const suppressed = new Set<string>();

  if (emails && emails.length > 0) {
    // Canonicalize and de-dupe the lookup keys so the IN filter matches the
    // canonical values we store (and so a mixed-case input still matches).
    const canonical = [...new Set(emails.map(canonicalizeEmail))];
    // Chunk to stay under D1's 100-bound-parameter limit.
    for (let i = 0; i < canonical.length; i += 80) {
      const chunk = canonical.slice(i, i + 80);
      const rows = await db
        .select({ email: suppressionEntries.email })
        .from(suppressionEntries)
        .where(and(scopeFilter, inArray(suppressionEntries.email, chunk)));
      for (const r of rows) suppressed.add(r.email.toLowerCase());
    }
  } else {
    const rows = await db
      .select({ email: suppressionEntries.email })
      .from(suppressionEntries)
      .where(scopeFilter);
    for (const r of rows) suppressed.add(r.email.toLowerCase());
  }

  return suppressed;
}

export async function isEmailSuppressed(
  db: Db,
  accountId: string,
  email: string,
): Promise<boolean> {
  const canonical = canonicalizeEmail(email);
  const set = await getSuppressedEmails(db, accountId, [canonical]);
  return set.has(canonical);
}

export async function addSuppression(
  db: Db,
  input: {
    accountId: string | null;
    email: string;
    reason: SuppressionReason;
    source?: string;
    scope?: "account" | "global";
  },
): Promise<void> {
  await db
    .insert(suppressionEntries)
    .values({
      id: newId("sup"),
      accountId: input.accountId,
      email: canonicalizeEmail(input.email),
      scope: input.scope ?? "account",
      reason: input.reason,
      source: input.source,
      createdAt: nowIso(),
    })
    .onConflictDoNothing();
}
