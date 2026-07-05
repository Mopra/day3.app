import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { accounts, audiences, campaignRecipients, sendingDomains, subscribers } from "../db/schema";
import {
  personalizationFieldsUsed,
  type PersonalizableField,
} from "../services/render";
import { SectionsSchema, serializeSections, type CampaignSection } from "../lib/sections";
import { CampaignThemeSchema, type CampaignThemeInput } from "../lib/theme";
import { campaignRecipientScope } from "../services/recipient-scope";
import { segments, topics } from "../db/schema";

export const CampaignFieldsSchema = z.object({
  name: z.string().trim().min(1).max(150),
  subject: z.string().trim().min(1).max(200),
  previewText: z.string().trim().max(200).optional(),
  audienceId: z.string().min(1),
  sendingDomainId: z.string().min(1),
  // The sender picked in the composer (provenance only; fromName/fromEmail below
  // are the authoritative snapshot). Optional for backward compatibility.
  senderId: z.string().optional(),
  fromName: z.string().trim().min(1).max(100),
  fromEmail: z.email().toLowerCase(),
  // Optional Reply-To: any valid address (often support@ on a different domain),
  // or empty to omit it. Normalised to lowercase; "" is treated as "no reply-to".
  replyTo: z
    .union([z.literal(""), z.email().toLowerCase()])
    .optional(),
  htmlBody: z.string().min(1).max(500_000),
  textBody: z.string().max(500_000).optional(),
  // The section builder's structured body. When present, htmlBody is derived from
  // it server-side (see campaignBodyFields) so the two never drift.
  sections: SectionsSchema.optional(),
  // The campaign's global theme (page/content background, text/heading/link colors,
  // border, corner roundness). Stored as JSON; applied at render time, not baked into
  // htmlBody. Omitted falls back to the default look.
  theme: CampaignThemeSchema.optional(),
  // Editable footer wording only. The physical address and unsubscribe link are
  // appended canonically at send time and are not part of this. Empty/omitted
  // falls back to the default sentence.
  footerText: z.string().trim().max(2_000).optional(),
});
export type CampaignFields = z.infer<typeof CampaignFieldsSchema>;

// Loose schema for autosaving a draft: every field is optional so a draft can be
// persisted from the very first keystroke (just a title, just some body text…).
// The strict requirements a *sendable* campaign needs are enforced again at
// submit/schedule time by `campaignContentError`. Empty strings are accepted and
// stored as-is for the NOT NULL columns (they read back as "not chosen yet").
export const CampaignDraftSchema = z.object({
  name: z.string().trim().max(150).optional(),
  subject: z.string().trim().max(200).optional(),
  previewText: z.string().trim().max(200).optional(),
  audienceId: z.string().max(100).optional(),
  // Optional narrowing: send only to this saved segment ("" = everyone).
  segmentId: z.string().max(100).optional(),
  // Optional topic the campaign is sent under ("" = none).
  topicId: z.string().max(100).optional(),
  sendingDomainId: z.string().max(100).optional(),
  senderId: z.string().max(100).optional(),
  fromName: z.string().trim().max(100).optional(),
  fromEmail: z.union([z.literal(""), z.email().toLowerCase()]).optional(),
  replyTo: z.union([z.literal(""), z.email().toLowerCase()]).optional(),
  htmlBody: z.string().max(500_000).optional(),
  textBody: z.string().max(500_000).optional(),
  // The section builder's structured body. The composer sends this on every
  // autosave; htmlBody is derived from it server-side (campaignBodyFields).
  sections: SectionsSchema.optional(),
  // The composer sends the global theme on every autosave; stored as themeJson.
  theme: CampaignThemeSchema.optional(),
  footerText: z.string().trim().max(2_000).optional(),
});
export type CampaignDraft = z.infer<typeof CampaignDraftSchema>;

// The theme JSON to persist from a draft/create payload: the validated theme
// stringified, or null when the caller sent none (renders with DEFAULT_THEME).
export function campaignThemeJson(data: { theme?: CampaignThemeInput }): string | null {
  return data.theme ? JSON.stringify(data.theme) : null;
}

// Resolves the body fields to persist from a draft/create payload. When the client
// sends the structured `sections`, htmlBody is *derived* from it server-side — so
// the stored, send-authoritative body can never drift from the sections and is
// always email-safe by construction (serializeSections emits only allowlisted
// markup). Without sections (a legacy/non-composer caller) the flat htmlBody is used
// as-is and the sections column is cleared.
export function campaignBodyFields(data: {
  htmlBody?: string;
  sections?: CampaignSection[];
}): { htmlBody: string; sectionsJson: string | null } {
  if (data.sections) {
    return {
      htmlBody: serializeSections(data.sections),
      sectionsJson: JSON.stringify(data.sections),
    };
  }
  return { htmlBody: data.htmlBody ?? "", sectionsJson: null };
}

// Validates only the fields a draft actually provides: the audience/domain must
// belong to the account if chosen, and a from address (if set alongside a domain)
// must align with it. Unset fields are simply skipped — a draft can be incomplete.
export async function validateDraftOwnership(
  db: Db,
  accountId: string,
  fields: CampaignDraft,
): Promise<string | null> {
  if (fields.audienceId) {
    const audience = await db.query.audiences.findFirst({
      where: and(eq(audiences.id, fields.audienceId), eq(audiences.accountId, accountId)),
    });
    if (!audience) return "Audience not found";
  }
  // A chosen segment/topic must belong to the account AND the chosen audience —
  // a segment saved on audience A must not scope a send to audience B.
  if (fields.segmentId) {
    const segment = await db.query.segments.findFirst({
      where: and(eq(segments.id, fields.segmentId), eq(segments.accountId, accountId)),
    });
    if (!segment || (fields.audienceId && segment.audienceId !== fields.audienceId)) {
      return "Segment not found on this audience";
    }
  }
  if (fields.topicId) {
    const topic = await db.query.topics.findFirst({
      where: and(eq(topics.id, fields.topicId), eq(topics.accountId, accountId)),
    });
    if (!topic || (fields.audienceId && topic.audienceId !== fields.audienceId)) {
      return "Topic not found on this audience";
    }
  }
  if (fields.sendingDomainId) {
    const domain = await db.query.sendingDomains.findFirst({
      where: and(
        eq(sendingDomains.id, fields.sendingDomainId),
        eq(sendingDomains.accountId, accountId),
      ),
    });
    if (!domain) return "Sending domain not found";
    if (fields.fromEmail && !fields.fromEmail.endsWith(`@${domain.domain}`)) {
      return "From email must use the selected sending domain";
    }
  }
  return null;
}

// A draft can be saved incomplete (autosave persists partial work). Before a
// campaign can be sent or scheduled, confirm every field a real email needs is
// present. Returns a user-facing error string, or null when it's send-ready.
export function campaignContentError(campaign: {
  subject: string;
  fromName: string;
  fromEmail: string;
  htmlBody: string;
  audienceId: string;
  sendingDomainId: string;
}): string | null {
  if (!campaign.audienceId) return "Choose an audience to send to";
  if (!campaign.sendingDomainId) return "Choose a sending domain";
  if (!campaign.fromName.trim()) return "Add a From name";
  if (!campaign.fromEmail.trim()) return "Add a From email";
  if (!campaign.subject.trim()) return "Add a subject line";
  if (!campaign.htmlBody.trim()) return "Write some email content";
  return null;
}

// Campaign-level send gates shared by the submit route, the schedule route, and
// the cron release of due scheduled campaigns: the account must have a physical
// mailing address (legally required in every email), the sending domain must be
// verified (or admin-overridden), and the audience must have at least one
// subscribed recipient. Returns an error string or null. (Account-level
// eligibility — billing/plan/health — is checked separately by the caller.)
export async function campaignSendGateError(
  db: Db,
  accountId: string,
  campaign: {
    sendingDomainId: string;
    audienceId: string;
    segmentId?: string | null;
    topicId?: string | null;
  },
): Promise<string | null> {
  // CAN-SPAM (and equivalents) require a valid physical postal address in every
  // marketing email. The footer renders {{company_address}} from the account, so
  // a blank address ships a non-compliant email — and repeated complaints over
  // missing footers are a fast path to SES suspension. Refuse to send until set.
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, accountId),
  });
  if (!account?.companyAddress?.trim()) {
    return "Add your business mailing address in Settings before sending — it's legally required in every email.";
  }

  const domain = await db.query.sendingDomains.findFirst({
    where: and(
      eq(sendingDomains.id, campaign.sendingDomainId),
      eq(sendingDomains.accountId, accountId),
    ),
  });
  const domainVerified =
    domain && (domain.verificationStatus === "verified" || domain.adminOverrideVerified);
  if (!domainVerified) return "Sending domain is not verified";

  // Count with the same segment/topic narrowing recipient generation applies,
  // so "no recipients" is caught here — before review/scheduling — not at send.
  const scope = await campaignRecipientScope(db, { accountId, ...campaign });
  if (scope.error) return scope.error;

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)`.as("count") })
    .from(subscribers)
    .where(
      and(
        eq(subscribers.audienceId, campaign.audienceId),
        eq(subscribers.status, "subscribed"),
        ...scope.conditions,
      ),
    );
  if (Number(count) === 0) {
    return campaign.segmentId
      ? "No subscribed contacts match the chosen segment"
      : campaign.topicId
        ? "Every subscribed contact has opted out of the chosen topic"
        : "The audience has no subscribed recipients";
  }

  return null;
}

export type PersonalizationGap = {
  field: PersonalizableField;
  // The fallback recipients will see when the field is empty (null = blank).
  fallback: string | null;
  missing: number;
  total: number;
};

// Pre-send personalization check. The merge fallback means an empty {{first_name}}
// never renders broken, but a sender may not want a generic greeting going to a
// large slice of the list — so we count how many subscribed recipients are missing
// each field the campaign actually uses, and let the UI surface it. Returns one
// entry per used field that at least one recipient is missing; [] when there's
// nothing to flag. Scoped by account (hard rule: every query is account-scoped).
export async function campaignPersonalizationGaps(
  db: Db,
  accountId: string,
  campaign: {
    subject: string;
    htmlBody: string;
    previewText: string | null;
    footerText: string | null;
    audienceId: string;
    segmentId?: string | null;
    topicId?: string | null;
  },
): Promise<PersonalizationGap[]> {
  const used = personalizationFieldsUsed(
    campaign.subject,
    campaign.htmlBody,
    campaign.previewText,
    campaign.footerText,
  );
  if (used.length === 0 || !campaign.audienceId) return [];

  // Count over the campaign's actual send scope (segment/topic narrowing), so
  // "312 of 1,200 have no first name" reflects who will really receive it. A
  // dangling reference degrades to no warning — the send gate reports it.
  const scope = await campaignRecipientScope(db, { accountId, ...campaign });
  if (scope.error) return [];

  // One pass over the audience's subscribed members, counting blanks per field
  // with FILTER aggregates. Mirrors the recipient-generation eligibility (status
  // = 'subscribed'); suppression isn't applied here — this is an estimate to
  // inform the sender, not the exact send list.
  const [counts] = await db
    .select({
      total: sql<number>`count(*)`,
      missingFirst: sql<number>`count(*) filter (where ${subscribers.firstName} is null or ${subscribers.firstName} = '')`,
      missingLast: sql<number>`count(*) filter (where ${subscribers.lastName} is null or ${subscribers.lastName} = '')`,
    })
    .from(subscribers)
    .where(
      and(
        eq(subscribers.accountId, accountId),
        eq(subscribers.audienceId, campaign.audienceId),
        eq(subscribers.status, "subscribed"),
        ...scope.conditions,
      ),
    );

  const total = Number(counts?.total ?? 0);
  if (total === 0) return [];
  const missingByField: Record<PersonalizableField, number> = {
    first_name: Number(counts?.missingFirst ?? 0),
    last_name: Number(counts?.missingLast ?? 0),
  };
  return used
    .map((u) => ({ field: u.field, fallback: u.fallback, missing: missingByField[u.field], total }))
    .filter((g) => g.missing > 0);
}

export async function campaignStats(db: Db, campaignId: string) {
  const rows = await db
    .select({ status: campaignRecipients.status, count: sql<number>`count(*)`.as("count") })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignId))
    .groupBy(campaignRecipients.status);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
  const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
  // Breakdown of why recipients did not receive the email, grouped by the stored
  // error. Lets the campaign UI distinguish suppressed (status=skipped, e.g.
  // "suppressed"/provider suppression) from hard-failed (status=failed, e.g. a
  // bad address or provider error) instead of showing a bare count.
  const reasonRows = await db
    .select({
      status: campaignRecipients.status,
      reason: campaignRecipients.error,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, campaignId),
        inArray(campaignRecipients.status, ["skipped", "failed"]),
      ),
    )
    .groupBy(campaignRecipients.status, campaignRecipients.error);
  const undeliverable = reasonRows.map((r) => ({
    status: r.status,
    reason: r.reason ?? "unknown",
    count: Number(r.count),
  }));
  return { total, ...byStatus, undeliverable };
}
