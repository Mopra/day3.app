import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { accounts, sendingDomains } from "@/db/schema";
import { logAdminAction } from "@/lib/admin-audit";
import { blockDomain } from "@/services/blocked-domains";

// POST /api/admin/accounts/{id}/block-domains — ban every domain this account
// holds, platform-wide.
//
// Pausing an account stops its sends. It does not stop the operator behind it
// from deleting the domain rows (a paused account can still log in), signing up
// a fresh org, and re-verifying the same names an hour later, which is how the
// September 2026 phishing run resumed on its third account. A ban is keyed on
// the domain name itself (services/blocked-domains.ts), so it survives the row
// being deleted and the account being purged.
//
// Deliberately NOT part of Pause: an honest account paused for an ageing list
// must keep its domain, or the pause becomes unrecoverable. This is a separate,
// explicit operator decision with its own audit row.
const Schema = z.object({ reason: z.string().trim().min(1).max(500) });

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { db, auth, userEmail } = await requireAdmin();
  const { id } = await params;
  const { reason } = await parseJson(req, Schema);
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, id) });
  if (!account) throw new HttpError(404, "Not found");

  // The shared Day3 sandbox domain is ours, not theirs; cutting an account off
  // it is a different control (shared_disabled_at).
  const rows = await db
    .select({ domain: sendingDomains.domain })
    .from(sendingDomains)
    .where(and(eq(sendingDomains.accountId, account.id), eq(sendingDomains.shared, false)));

  const banned: string[] = [];
  for (const row of rows) {
    const result = await blockDomain(db, {
      domain: row.domain,
      reason,
      sourceAccountId: account.id,
      createdBy: userEmail,
    });
    banned.push(result.domain);
  }

  await logAdminAction(db, {
    action: "domains.block",
    actorEmail: userEmail,
    actorUserId: auth.userId,
    targetType: "account",
    targetId: account.id,
    details: { reason, domains: banned },
  });

  return json({ ok: true, banned });
});
