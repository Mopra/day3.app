import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findCampaign } from "@/api/finders";
import { campaigns } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { enforceRateLimit } from "@/lib/rate-limit";

// Duplicate an existing campaign into a fresh draft. The common case: a send
// went well and the user wants to send "the same again" — copy the content and
// settings verbatim, then tweak. Any status can be duplicated (a sent campaign
// is the whole point); the copy always starts at "draft" with a clean slate of
// send-time state (no recipients, no risk review, never sent or scheduled).
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  // Same gate as creating a campaign — a duplicate is a new draft.
  await enforceRateLimit("campaign_create", account.id);

  const source = await findCampaign(db, account.id, id);
  if (!source) throw new HttpError(404, "Not found");

  const newCampaignId = newId("cmp");
  const now = nowIso();
  // Copy only the content/settings columns. htmlBody and sectionsJson are already
  // consistent on the source row, so copy them straight across (no re-derivation).
  // Everything send-related (status, recipients, risk, timestamps) resets.
  await db.insert(campaigns).values({
    id: newCampaignId,
    accountId: account.id,
    audienceId: source.audienceId,
    sendingDomainId: source.sendingDomainId,
    senderId: source.senderId,
    name: `Copy of ${source.name}`.slice(0, 150),
    subject: source.subject,
    previewText: source.previewText,
    fromName: source.fromName,
    fromEmail: source.fromEmail,
    replyTo: source.replyTo,
    htmlBody: source.htmlBody,
    sectionsJson: source.sectionsJson,
    textBody: source.textBody,
    footerText: source.footerText,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });
  return json({ id: newCampaignId }, 201);
});
