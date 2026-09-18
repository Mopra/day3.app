import { and, eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { campaignBodyFields } from "@/api/campaigns";
import { campaigns, senders } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { enforceRateLimit } from "@/lib/rate-limit";
import { CAMPAIGN_TEMPLATES, campaignTemplate } from "@/lib/campaign-templates";
import { serializeSections } from "@/lib/sections";
import { computeOnboardingState } from "@/services/onboarding";
import { findSharedDomain } from "@/services/shared-domain";
import { findTeamAudience } from "@/services/team-audience";

// POST /api/campaigns/first: the day-zero button.
//
// One call turns a brand new account into a draft that is ready to send: a real
// template (structure and styling, no blank canvas), addressed to the seeded team
// audience, leaving from the pre-verified Day3 sandbox domain. The user lands in
// the composer with Send already live, and the first email arrives before they
// have published a DNS record or imported a contact.
//
// It is NOT a second way to create a campaign. It refuses once the account has
// one, so it can only ever be the thing that happens before there is anything,
// which keeps "how does a campaign get created" a single answer
// (POST /api/campaigns) everywhere else.

export const POST = route(async (req) => {
  const { db, account } = await requireAccount();
  await enforceRateLimit("campaign_create", account.id);

  const onboarding = await computeOnboardingState(db, account);
  if (onboarding.hasCampaign) {
    throw new HttpError(
      409,
      "This account already has a campaign. Use New campaign to create another.",
    );
  }

  const [domain, audienceId] = await Promise.all([
    findSharedDomain(db, account.id),
    findTeamAudience(db, account.id),
  ]);
  if (!domain || !audienceId) {
    // Provisioning has not run (or the shared domain is unconfigured). The
    // dashboard only offers this button when onboarding says the path is open,
    // so this is a genuine edge, not a state to design copy around.
    throw new HttpError(
      409,
      "Your test address isn't ready yet. Refresh in a moment, or verify your own sending domain to get started.",
    );
  }

  // Let the caller name a template so the same endpoint serves "start with this
  // one" from the picker later; default to the first, which is the general
  // product-update layout.
  const url = new URL(req.url);
  const requested = url.searchParams.get("template");
  const template = (requested && campaignTemplate(requested)) || CAMPAIGN_TEMPLATES[0];

  const sections = template.build();
  const body = campaignBodyFields({ sections });
  // Belt and braces: serializeSections is what makes the stored body email-safe,
  // and campaignBodyFields already runs it. Asserting it is non-empty here means
  // a template that somehow built nothing fails now rather than as an empty email.
  if (!serializeSections(sections).trim()) {
    throw new HttpError(500, "Could not build the starter campaign.");
  }

  // The matching sender row, provisioned alongside the shared domain. Recorded as
  // provenance so reopening the draft re-selects the right option in the From
  // dropdown; fromName/fromEmail below stay the authoritative snapshot.
  const sender = await db.query.senders.findFirst({
    columns: { id: true },
    where: and(eq(senders.accountId, account.id), eq(senders.sendingDomainId, domain.id)),
  });

  const id = newId("cmp");
  const now = nowIso();
  await db.insert(campaigns).values({
    id,
    accountId: account.id,
    audienceId,
    segmentId: null,
    topicId: null,
    sendingDomainId: domain.id,
    senderId: sender?.id ?? null,
    name: template.subject,
    subject: template.subject,
    previewText: template.previewText,
    fromName: domain.fromName ?? account.name,
    fromEmail: domain.fromEmail ?? "",
    replyTo: null,
    htmlBody: body.htmlBody,
    sectionsJson: body.sectionsJson,
    themeJson: JSON.stringify(template.theme),
    textBody: null,
    footerText: null,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });

  return json({ id }, 201);
});
