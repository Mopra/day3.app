import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { SUPPRESSION_REASONS, type SuppressionReason } from "@/db/schema";
import { MAX_IMPORT_ROWS } from "@/lib/csv";
import {
  addSuppressions,
  countAccountSuppressed,
  findGlobalSuppression,
  listAccountSuppressions,
} from "@/services/suppression";

const ListSchema = z.object({
  search: z.string().trim().max(320).optional(),
  reason: z.enum(SUPPRESSION_REASONS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /api/suppressions — the account's own suppression entries, filtered and
// offset-paginated. Global (platform-wide) entries are never listed: they belong
// to the platform, not this tenant, so enumerating them would expose addresses
// that opted out at other accounts. When the search box holds a full address with
// no account entry, we do report a global hit for exactly that address —
// answering "why is this one still blocked?" without leaking a list.
export const GET = route(async (req) => {
  const { db, account } = await requireAccount();
  const query = ListSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success) throw new HttpError(400, "Invalid query");
  const { search, reason, limit, offset } = query.data;

  const { rows, total } = await listAccountSuppressions(db, account.id, {
    search,
    reason,
    limit,
    offset,
  });

  // Only when the account has nothing for a fully-typed address.
  const globalHit =
    rows.length === 0 && search && search.includes("@")
      ? await findGlobalSuppression(db, search)
      : null;

  return json({
    suppressions: rows,
    total,
    totalSuppressed: await countAccountSuppressed(db, account.id),
    globalEntry: globalHit
      ? { email: globalHit.email, reason: globalHit.reason, createdAt: globalHit.createdAt }
      : null,
  });
});

const AddSchema = z.object({
  // Free-form paste: the textarea is split on commas/semicolons/whitespace before
  // it gets here, so this is already a list of candidate addresses.
  emails: z.array(z.string().trim().max(320)).min(1).max(MAX_IMPORT_ROWS),
  // Required and explicit, exactly as in the public API — a suppression must
  // always be attributable to a stated reason.
  reason: z.enum(SUPPRESSION_REASONS),
});

// POST /api/suppressions — block addresses for this account. Shares
// addSuppressions() with POST /v1/suppressions, so the app and the API apply
// identical canonicalization, dedupe and already-suppressed accounting.
export const POST = route(async (req) => {
  const { db, account } = await requireAccount();
  const { emails, reason } = await parseJson(req, AddSchema);

  const before = await countAccountSuppressed(db, account.id);
  const result = await addSuppressions(db, {
    accountId: account.id,
    emails,
    reason: reason as SuppressionReason,
    source: "app",
  });
  if (result.added === 0 && result.alreadySuppressed === 0) {
    throw new HttpError(400, "No valid email addresses found");
  }
  const after = await countAccountSuppressed(db, account.id);

  return json({ ...result, totalSuppressedBefore: before, totalSuppressedAfter: after }, 201);
});
