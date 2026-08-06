import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client";
import { audiences, campaigns, senders, sendingDomains, type Campaign } from "../../db/schema";
import { markdownToSections, sectionsToMarkdown } from "../../lib/campaign-markdown";
import {
  MAX_SERIALIZED_BODY_CHARS,
  SectionsSchema,
  htmlBodyToSections,
  safeParseSections,
  serializeSections,
  type CampaignSection,
} from "../../lib/sections";
import { CampaignThemeSchema, safeParseTheme } from "../../lib/theme";
import { newId, nowIso } from "../../lib/ids";
import { getAudienceFieldFallbacks } from "../../services/audience-fields";
import { renderCampaignEmail, sanitizeHtml } from "../../services/render";
import { ApiError } from "./errors";
import { toIso } from "./serialize";

// The public campaign surface, shared by every /v1/campaigns route.
//
// A campaign is the one v1 resource whose *content* is the interesting part, and
// the format that content arrives in is the whole design. `markdown` (see
// lib/campaign-markdown.ts) is the front door: it is what an agent writes well,
// and it lands as real builder sections so the campaign stays editable in the
// app afterwards. `sections` is the escape hatch for byte-exact fidelity, and
// `html` is the legacy path for callers that already have a rendered body.

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const CampaignBodySchema = z.object({
  // Day3 Markdown → builder sections. The recommended way to write a body.
  markdown: z.string().max(MAX_SERIALIZED_BODY_CHARS).optional(),
  // The builder's own model, for callers round-tripping exact content.
  sections: SectionsSchema.optional(),
  // A pre-rendered body. Sanitized on the way in and stored without sections;
  // the composer wraps it as a single block when the campaign is opened.
  html: z.string().max(MAX_SERIALIZED_BODY_CHARS).optional(),
});

export const CampaignInputSchema = CampaignBodySchema.extend({
  name: z.string().trim().max(150).optional(),
  subject: z.string().trim().max(200).optional(),
  preview_text: z.string().trim().max(200).optional(),
  audience_id: z.string().max(100).optional(),
  segment_id: z.string().max(100).nullable().optional(),
  topic_id: z.string().max(100).nullable().optional(),
  sender_id: z.string().max(100).optional(),
  from_name: z.string().trim().max(100).optional(),
  from_email: z.union([z.literal(""), z.email().toLowerCase()]).optional(),
  reply_to: z.union([z.literal(""), z.email().toLowerCase()]).optional(),
  footer_text: z.string().trim().max(2_000).optional(),
  theme: CampaignThemeSchema.optional(),
});

export type CampaignInput = z.infer<typeof CampaignInputSchema>;

// ---------------------------------------------------------------------------
// Body resolution
// ---------------------------------------------------------------------------

export type BodyFields = { htmlBody: string; sectionsJson: string | null };

// Resolve the three body inputs to the pair of columns actually stored. As
// everywhere else in the app, htmlBody is DERIVED from sections rather than
// accepted alongside them, so the send-authoritative body can never drift from
// the structure the builder edits.
export function resolveBody(input: CampaignBodySchemaInput): BodyFields | null {
  const provided = [input.markdown, input.sections, input.html].filter((v) => v !== undefined);
  if (provided.length === 0) return null;
  if (provided.length > 1) {
    throw new ApiError(
      400,
      "invalid_request",
      "Provide exactly one of `markdown`, `sections`, or `html`.",
    );
  }

  if (input.markdown !== undefined) {
    return sectionsToBody(markdownToSections(input.markdown));
  }
  if (input.sections !== undefined) {
    return sectionsToBody(input.sections);
  }
  // `html` keeps the legacy shape: stored as-is (sanitized), no sections.
  return { htmlBody: sanitizeHtml(input.html ?? ""), sectionsJson: null };
}

type CampaignBodySchemaInput = z.infer<typeof CampaignBodySchema>;

function sectionsToBody(sections: CampaignSection[]): BodyFields {
  const htmlBody = serializeSections(sections);
  if (htmlBody.length > MAX_SERIALIZED_BODY_CHARS) {
    throw new ApiError(400, "invalid_request", "Email content is too large");
  }
  return { htmlBody, sectionsJson: JSON.stringify(sections) };
}

// The stored body as markdown. A campaign with no sections (an `html` upload, or
// a draft written before the builder existed) is wrapped the same way the
// composer wraps it, so the caller always gets *something* editable back rather
// than an empty string.
export function campaignMarkdown(campaign: Pick<Campaign, "sectionsJson" | "htmlBody">): string {
  const sections = safeParseSections(campaign.sectionsJson) ?? htmlBodyToSections(campaign.htmlBody);
  return sectionsToMarkdown(sections);
}

// ---------------------------------------------------------------------------
// Sender / audience resolution
// ---------------------------------------------------------------------------

export type ResolvedSender = {
  senderId: string | null;
  sendingDomainId: string;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
};

// Turn whatever the caller gave us into a real From identity. Ceremony is the
// enemy here: an agent that must first list domains, list senders, and thread
// three ids through a create call will get it wrong. So `sender_id` wins,
// `from_email` resolves to the sender (or domain) that owns it, and a caller
// who says nothing gets the account's default sender.
export async function resolveSender(
  db: Db,
  accountId: string,
  input: { sender_id?: string; from_name?: string; from_email?: string; reply_to?: string },
): Promise<ResolvedSender | null> {
  if (input.sender_id) {
    const sender = await db.query.senders.findFirst({
      where: and(eq(senders.id, input.sender_id), eq(senders.accountId, accountId)),
    });
    if (!sender) throw new ApiError(404, "not_found", "Sender not found", { param: "sender_id" });
    return {
      senderId: sender.id,
      sendingDomainId: sender.sendingDomainId,
      fromName: input.from_name ?? sender.fromName,
      fromEmail: sender.fromEmail,
      replyTo: input.reply_to ?? sender.replyTo ?? null,
    };
  }

  const accountSenders = await db
    .select()
    .from(senders)
    .where(eq(senders.accountId, accountId));

  if (input.from_email) {
    const match = accountSenders.find((s) => s.fromEmail === input.from_email);
    if (match) {
      return {
        senderId: match.id,
        sendingDomainId: match.sendingDomainId,
        fromName: input.from_name ?? match.fromName,
        fromEmail: match.fromEmail,
        replyTo: input.reply_to ?? match.replyTo ?? null,
      };
    }
    // Not a saved sender: accept it if the domain part is one this account owns,
    // exactly like the composer's own validation.
    const domainPart = input.from_email.split("@")[1] ?? "";
    const domain = await db.query.sendingDomains.findFirst({
      where: and(eq(sendingDomains.accountId, accountId), eq(sendingDomains.domain, domainPart)),
    });
    if (!domain) {
      throw new ApiError(
        400,
        "invalid_request",
        `\`${input.from_email}\` is not on a sending domain this account owns.`,
        { param: "from_email" },
      );
    }
    return {
      senderId: null,
      sendingDomainId: domain.id,
      fromName: input.from_name ?? domain.fromName ?? "",
      fromEmail: input.from_email,
      replyTo: input.reply_to ?? null,
    };
  }

  const fallback = accountSenders.find((s) => s.isDefault) ?? accountSenders[0];
  if (!fallback) return null;
  return {
    senderId: fallback.id,
    sendingDomainId: fallback.sendingDomainId,
    fromName: input.from_name ?? fallback.fromName,
    fromEmail: fallback.fromEmail,
    replyTo: input.reply_to ?? fallback.replyTo ?? null,
  };
}

// Same idea for the audience: named explicitly, or inferred when there is only
// one it could possibly be.
export async function resolveAudienceId(
  db: Db,
  accountId: string,
  audienceId: string | undefined,
): Promise<string> {
  if (audienceId) {
    const audience = await db.query.audiences.findFirst({
      where: and(eq(audiences.id, audienceId), eq(audiences.accountId, accountId)),
    });
    if (!audience) {
      throw new ApiError(404, "not_found", "Audience not found", { param: "audience_id" });
    }
    return audience.id;
  }
  const all = await db.select({ id: audiences.id }).from(audiences).where(eq(audiences.accountId, accountId));
  return all.length === 1 ? all[0].id : "";
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

// Statuses a campaign's content may still be edited from. Once it is in review
// or sending, the body is what recipients are getting — editing it would mean a
// half-sent campaign whose two halves differ.
export const EDITABLE_STATUSES = new Set(["draft", "scheduled"]);

// Create a draft. Everything is optional: a campaign starts life incomplete in
// the composer too (autosave persists partial work), and the completeness a real
// send needs is enforced at send time — so a caller can write the copy first and
// pick the audience after.
export async function createCampaign(
  db: Db,
  accountId: string,
  input: CampaignInput,
): Promise<Campaign> {
  const content = resolveBody(input);
  const sender = await resolveSender(db, accountId, input);
  const audienceId = await resolveAudienceId(db, accountId, input.audience_id);

  const id = newId("cmp");
  const now = nowIso();
  // `.returning()` rather than a follow-up read: the row is ours by construction
  // here, and re-reading it by id alone would be an unscoped tenant query (the
  // repo has a guard test for exactly that shape).
  const [created] = await db
    .insert(campaigns)
    .values({
      id,
      accountId,
      audienceId,
      segmentId: input.segment_id || null,
      topicId: input.topic_id || null,
      sendingDomainId: sender?.sendingDomainId ?? "",
      senderId: sender?.senderId ?? null,
      name: input.name ?? input.subject ?? "Untitled campaign",
      subject: input.subject ?? "",
      previewText: input.preview_text ?? null,
      fromName: sender?.fromName ?? "",
      fromEmail: sender?.fromEmail ?? "",
      replyTo: sender?.replyTo ?? null,
      htmlBody: content?.htmlBody ?? "",
      sectionsJson: content?.sectionsJson ?? null,
      themeJson: input.theme ? JSON.stringify(input.theme) : null,
      footerText: input.footer_text || null,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return created;
}

// Partial update. Only fields the caller actually sent are touched — notably the
// From identity, which is left alone unless addressed, so a PATCH fixing a typo
// in the subject can't silently relocate the campaign onto the default sender.
export async function updateCampaign(
  db: Db,
  accountId: string,
  campaign: Campaign,
  input: CampaignInput,
): Promise<Campaign> {
  if (!EDITABLE_STATUSES.has(campaign.status)) {
    throw new ApiError(
      409,
      "invalid_request",
      `A campaign with status "${campaign.status}" can no longer be edited.`,
    );
  }

  const content = resolveBody(input);
  const touchesSender =
    input.sender_id !== undefined || input.from_email !== undefined || input.from_name !== undefined;
  const sender = touchesSender ? await resolveSender(db, accountId, input) : null;
  const audienceId =
    input.audience_id !== undefined
      ? await resolveAudienceId(db, accountId, input.audience_id)
      : undefined;

  const [updated] = await db
    .update(campaigns)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.preview_text !== undefined ? { previewText: input.preview_text || null } : {}),
      ...(audienceId !== undefined ? { audienceId } : {}),
      ...(input.segment_id !== undefined ? { segmentId: input.segment_id || null } : {}),
      ...(input.topic_id !== undefined ? { topicId: input.topic_id || null } : {}),
      ...(input.footer_text !== undefined ? { footerText: input.footer_text || null } : {}),
      ...(input.reply_to !== undefined ? { replyTo: input.reply_to || null } : {}),
      ...(input.theme !== undefined ? { themeJson: JSON.stringify(input.theme) } : {}),
      ...(content ?? {}),
      ...(sender
        ? {
            senderId: sender.senderId,
            sendingDomainId: sender.sendingDomainId,
            fromName: sender.fromName,
            fromEmail: sender.fromEmail,
            ...(input.reply_to === undefined ? { replyTo: sender.replyTo } : {}),
          }
        : {}),
      updatedAt: nowIso(),
    })
    .where(eq(campaigns.id, campaign.id))
    .returning();

  return updated;
}

// The fully rendered email, exactly as the send pipeline would build it: theme
// wrapper, merge tags resolved against a stand-in recipient, canonical
// compliance footer. The unsubscribe link is inert — minting a real signed token
// for a fake subscriber would put a working opt-out into a document nobody
// received.
export async function renderCampaignPreview(
  db: Db,
  account: { name: string; companyAddress: string | null },
  campaign: Campaign,
): Promise<{ subject: string; html: string; text: string }> {
  const fieldFallbacks = campaign.audienceId
    ? await getAudienceFieldFallbacks(db, campaign.audienceId)
    : null;
  return renderCampaignEmail({
    campaign,
    theme: safeParseTheme(campaign.themeJson),
    subscriber: { email: "preview@example.com", firstName: "Alex", lastName: "Rivera" },
    companyName: account.name,
    companyAddress: account.companyAddress,
    unsubscribeUrl: "#preview-unsubscribe",
    fieldFallbacks,
  });
}

// ---------------------------------------------------------------------------
// Lookup + output
// ---------------------------------------------------------------------------

export async function findCampaignOr404(db: Db, accountId: string, id: string): Promise<Campaign> {
  const campaign = await db.query.campaigns.findFirst({
    where: and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)),
  });
  if (!campaign) throw new ApiError(404, "not_found", "Campaign not found");
  return campaign;
}

// The public campaign shape. `markdown` is included on single-campaign reads
// (it costs a parse + re-render, which is wasted work on a 100-row list) and is
// what a caller edits and sends back.
export function serializeCampaign(
  campaign: Campaign,
  opts: { body?: boolean } = {},
): Record<string, unknown> {
  // Read here rather than taken as an argument: an unset APP_URL should drop the
  // link, never throw a serialization error into an otherwise fine response.
  const base_url = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const base: Record<string, unknown> = {
    id: campaign.id,
    object: "campaign",
    name: campaign.name,
    subject: campaign.subject,
    preview_text: campaign.previewText,
    status: campaign.status,
    sandbox: campaign.sandbox,
    audience_id: campaign.audienceId || null,
    segment_id: campaign.segmentId,
    topic_id: campaign.topicId,
    sender_id: campaign.senderId,
    sending_domain_id: campaign.sendingDomainId || null,
    from_name: campaign.fromName,
    from_email: campaign.fromEmail,
    reply_to: campaign.replyTo,
    footer_text: campaign.footerText,
    risk_level: campaign.riskLevel,
    risk_summary: campaign.riskSummary,
    paused_reason: campaign.pausedReason,
    scheduled_at: toIso(campaign.scheduledAt),
    sent_at: toIso(campaign.sentAt),
    created_at: toIso(campaign.createdAt),
    updated_at: toIso(campaign.updatedAt),
  };
  if (base_url) {
    // Where a human goes to look at this. The whole point of the external-editor
    // story is that the campaign shows up in Day3, so every write hands back the
    // link rather than making the caller assemble it.
    base.url = `${base_url}/campaigns/${campaign.id}`;
  }
  if (opts.body) {
    base.markdown = campaignMarkdown(campaign);
    base.sections = safeParseSections(campaign.sectionsJson) ?? [];
    base.html = campaign.htmlBody;
  }
  return base;
}
