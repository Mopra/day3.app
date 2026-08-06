import { and, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  subscribers,
  suppressionEntries,
  type SuppressionEntry,
  type SuppressionReason,
} from "../db/schema";
import { canonicalizeEmail, isValidEmail } from "../lib/csv";
import { newId, nowIso } from "../lib/ids";

// Emails suppressed for this account (account scope) or globally. Returned set
// members and the optional `emails` filter are compared in canonical form
// (trimmed + lowercased) so callers must look up canonical emails too.
//
// `reasons` narrows the check to specific suppression reasons. Campaign sends
// honor every reason; transactional sends pass the deliverability reasons only
// (hard_bounce / complaint / provider_suppressed) — unsubscribing from a
// newsletter must never block that same person's password reset.
export async function getSuppressedEmails(
  db: Db,
  accountId: string,
  emails?: string[],
  reasons?: SuppressionReason[],
): Promise<Set<string>> {
  const scopeFilter = and(
    or(
      eq(suppressionEntries.accountId, accountId),
      isNull(suppressionEntries.accountId),
      eq(suppressionEntries.scope, "global"),
    ),
    ...(reasons ? [inArray(suppressionEntries.reason, reasons)] : []),
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

// Postgres caps a statement at 65535 bound params; suppression rows are 7 columns,
// so 500 per insert is comfortably under.
const INSERT_CHUNK = 500;

export type SuppressionImportResult = {
  added: number;
  alreadySuppressed: number;
  invalid: number;
};

// Bulk-add account-scope suppressions. Shared by the public API
// (POST /v1/suppressions) and the app's Suppressions page so the two front doors
// can't drift: same canonicalization, same in-payload dedupe, same
// already-suppressed accounting. Add-only by design — removal is
// removeAccountSuppression, which the public API deliberately does not expose.
export async function addSuppressions(
  db: Db,
  input: {
    accountId: string;
    emails: string[];
    reason: SuppressionReason;
    source: string;
  },
): Promise<SuppressionImportResult> {
  const now = nowIso();
  const seen = new Set<string>();
  const rows: (typeof suppressionEntries.$inferInsert)[] = [];
  let invalid = 0;

  for (const raw of input.emails) {
    const email = canonicalizeEmail(raw);
    if (!isValidEmail(email)) {
      invalid++;
      continue;
    }
    if (seen.has(email)) continue; // in-payload duplicate — harmless, dedupe
    seen.add(email);
    rows.push({
      id: newId("sup"),
      accountId: input.accountId,
      email,
      scope: "account",
      reason: input.reason,
      source: input.source,
      createdAt: now,
    });
  }

  // onConflictDoNothing on (account, email, reason): an already-suppressed entry
  // is counted, not duplicated.
  let added = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const inserted = await db
      .insert(suppressionEntries)
      .values(rows.slice(i, i + INSERT_CHUNK))
      .onConflictDoNothing()
      .returning({ id: suppressionEntries.id });
    added += inserted.length;
  }

  return { added, alreadySuppressed: rows.length - added, invalid };
}

// Distinct suppressed addresses for an account — the "blast radius" figure both
// the API response and the page header report.
export async function countAccountSuppressed(db: Db, accountId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(distinct ${suppressionEntries.email})`.as("count") })
    .from(suppressionEntries)
    .where(eq(suppressionEntries.accountId, accountId));
  return Number(count);
}

// The account's own suppression entries, newest first. Deliberately excludes
// platform-wide (global) entries: those are addresses that opted out or
// complained anywhere on the platform, so listing them to one tenant would leak
// other tenants' recipients. An exact-address lookup can still report a global
// hit (findGlobalSuppression) — the user has to already know the address.
export async function listAccountSuppressions(
  db: Db,
  accountId: string,
  filters: { search?: string; reason?: SuppressionReason; limit: number; offset: number },
): Promise<{ rows: SuppressionEntry[]; total: number }> {
  const where = [eq(suppressionEntries.accountId, accountId)];
  if (filters.search) {
    where.push(like(suppressionEntries.email, `%${canonicalizeEmail(filters.search)}%`));
  }
  if (filters.reason) where.push(eq(suppressionEntries.reason, filters.reason));

  const rows = await db
    .select()
    .from(suppressionEntries)
    .where(and(...where))
    .orderBy(desc(suppressionEntries.createdAt), desc(suppressionEntries.id))
    .limit(filters.limit)
    .offset(filters.offset);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)`.as("total") })
    .from(suppressionEntries)
    .where(and(...where));

  return { rows, total: Number(total) };
}

// Is this exact address blocked platform-wide? Used to explain "why is this
// address still suppressed?" after the account's own entries are gone — a tenant
// cannot remove a global entry (it outlives accounts by design).
export async function findGlobalSuppression(
  db: Db,
  email: string,
): Promise<SuppressionEntry | null> {
  const entry = await db.query.suppressionEntries.findFirst({
    where: and(
      eq(suppressionEntries.email, canonicalizeEmail(email)),
      or(isNull(suppressionEntries.accountId), eq(suppressionEntries.scope, "global")),
    ),
    orderBy: desc(suppressionEntries.createdAt),
  });
  return entry ?? null;
}

// Statuses a contact can be lifted out of when its address is un-suppressed:
// these were set by our own delivery machinery (or an operator), which the user
// is now explicitly overriding. `unsubscribed` is deliberately NOT in the list —
// that was the recipient's own choice and only they can reverse it (by signing up
// again), so un-suppressing must never resubscribe them.
const RESTORABLE_STATUSES = ["bounced", "complained", "suppressed"] as const;

// Un-suppress an address for one account: drop every account-scope entry for it
// (the unique index is per reason, so one address can carry several) and let its
// contact rows be mailable again. Never touches global entries, and never touches
// another account's.
export async function removeAccountSuppression(
  db: Db,
  accountId: string,
  email: string,
): Promise<{ removed: number; restoredContacts: number }> {
  const canonical = canonicalizeEmail(email);

  const removed = await db
    .delete(suppressionEntries)
    .where(
      and(
        eq(suppressionEntries.accountId, accountId),
        eq(suppressionEntries.email, canonical),
        eq(suppressionEntries.scope, "account"),
      ),
    )
    .returning({ id: suppressionEntries.id });

  if (removed.length === 0) return { removed: 0, restoredContacts: 0 };

  const restored = await db
    .update(subscribers)
    .set({ status: "subscribed", updatedAt: nowIso() })
    .where(
      and(
        eq(subscribers.accountId, accountId),
        eq(subscribers.email, canonical),
        inArray(subscribers.status, [...RESTORABLE_STATUSES]),
      ),
    )
    .returning({ id: subscribers.id });

  return { removed: removed.length, restoredContacts: restored.length };
}
