import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { accountUsers, subscribers } from "@/db/schema";
import { eq } from "drizzle-orm";
import { newId, nowIso } from "@/lib/ids";
import { canonicalizeEmail, isValidEmail } from "@/lib/csv";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getSuppressedEmails } from "@/services/suppression";
import { subscriberHeadroom, subscriberLimitMessage } from "@/services/subscriber-limit";

// POST /api/audiences/[id]/subscribers/team — add every member of the
// organization to this audience as a subscribed contact.
//
// This exists because of sandbox mode: on the free tier a campaign only reaches
// the org's own members, and an audience imported from a CSV of strangers
// contains none of them — so the first real send a new user attempts has nobody
// to go to. Rather than explain that, we hand them the one-click fix. It is
// useful on paid plans too (teams routinely want themselves on the list), so
// it isn't plan-gated.
//
// The roster is read server-side from account_users; the request carries no
// addresses, so this can't be used to inject arbitrary contacts. Re-running it
// is a no-op for members already present (onConflictDoNothing), which makes it
// safe to offer as a plain button with no confirmation.
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  await enforceRateLimit("campaign_create", account.id);

  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");

  const members = await db
    .select({ email: accountUsers.email })
    .from(accountUsers)
    .where(eq(accountUsers.accountId, account.id));

  const emails = [
    ...new Set(
      members.map((m) => canonicalizeEmail(m.email)).filter((email) => isValidEmail(email)),
    ),
  ];
  if (emails.length === 0) {
    throw new HttpError(400, "We couldn't find any members on your organization to add.");
  }

  // A teammate who hard-bounced or complained stays off the list — the
  // suppression list outranks convenience, exactly as it does on import.
  const suppressed = await getSuppressedEmails(db, account.id, emails);
  const addable = emails.filter((email) => !suppressed.has(email));
  if (addable.length === 0) {
    throw new HttpError(409, "Everyone on your team is on the suppression list.");
  }

  // Free-tier subscriber cap still applies; adding the team is the one case
  // where an account at its cap should get a clear message rather than a
  // silently short insert.
  const headroom = await subscriberHeadroom(db, account.id, account.plan);
  if (headroom < 1) throw new HttpError(403, subscriberLimitMessage(account.plan));

  const now = nowIso();
  const inserted = await db
    .insert(subscribers)
    .values(
      addable.slice(0, headroom).map((email) => ({
        id: newId("sub"),
        accountId: account.id,
        audienceId: audience.id,
        email,
        firstName: null,
        lastName: null,
        attributes: null,
        status: "subscribed" as const,
        source: "manual",
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: subscribers.id });

  // `added` counts only the rows that were really new; the rest were already
  // contacts. The UI needs both numbers to say something true either way.
  return json({ ok: true, added: inserted.length, teamSize: emails.length });
});
