import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { enforceRateLimit } from "@/lib/rate-limit";
import { subscriberLimitMessage } from "@/services/subscriber-limit";
import { addTeamToAudience } from "@/services/team-audience";

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
// The work itself lives in services/team-audience.ts because account
// provisioning seeds an audience through the same path, and "which contacts does
// adding your team create" must not have two answers.
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  await enforceRateLimit("campaign_create", account.id);

  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");

  const result = await addTeamToAudience(db, account, audience.id);
  if (!result.ok) {
    if (result.reason === "no_members") {
      throw new HttpError(400, "We couldn't find any members on your organization to add.");
    }
    if (result.reason === "all_suppressed") {
      throw new HttpError(409, "Everyone on your team is on the suppression list.");
    }
    throw new HttpError(403, subscriberLimitMessage(account.plan));
  }

  return json({ ok: true, added: result.added, teamSize: result.teamSize });
});
