import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  audiences,
  campaignRecipients,
  campaigns,
  riskReviews,
  sendingDomains,
  subscribers,
} from "../db/schema";
import { newId, nowIso } from "../lib/ids";
import { checkSendEligibility } from "../services/plans";
import { renderCampaignEmail } from "../services/render";
import { signUnsubscribeToken, unsubscribeUrl } from "../services/unsubscribe";
import { createEmailProvider } from "../email/factory";
import { SEND_BATCH_SIZE } from "../queue/messages";
import { requireAccount } from "./middleware";
import { parseJson } from "./validate";
import type { AppContext } from "./context";

export const campaignRoutes = new Hono<AppContext>();
campaignRoutes.use("*", requireAccount);

const CampaignFieldsSchema = z.object({
  name: z.string().trim().min(1).max(150),
  subject: z.string().trim().min(1).max(200),
  previewText: z.string().trim().max(200).optional(),
  audienceId: z.string().min(1),
  sendingDomainId: z.string().min(1),
  fromName: z.string().trim().min(1).max(100),
  fromEmail: z.email().toLowerCase(),
  htmlBody: z.string().min(1).max(500_000),
  textBody: z.string().max(500_000).optional(),
});

type CampaignFields = z.infer<typeof CampaignFieldsSchema>;

async function validateOwnershipAndSender(
  c: { get: (k: "db" | "account") => unknown },
  fields: CampaignFields,
): Promise<string | null> {
  const db = c.get("db") as AppContext["Variables"]["db"];
  const account = c.get("account") as AppContext["Variables"]["account"];

  const audience = await db.query.audiences.findFirst({
    where: and(eq(audiences.id, fields.audienceId), eq(audiences.accountId, account.id)),
  });
  if (!audience) return "Audience not found";

  const domain = await db.query.sendingDomains.findFirst({
    where: and(
      eq(sendingDomains.id, fields.sendingDomainId),
      eq(sendingDomains.accountId, account.id),
    ),
  });
  if (!domain) return "Sending domain not found";
  if (!fields.fromEmail.endsWith(`@${domain.domain}`)) {
    return "From email must use the selected sending domain";
  }
  return null;
}

campaignRoutes.get("/", async (c) => {
  const rows = await c
    .get("db")
    .select({
      id: campaigns.id,
      name: campaigns.name,
      subject: campaigns.subject,
      status: campaigns.status,
      riskLevel: campaigns.riskLevel,
      sentAt: campaigns.sentAt,
      createdAt: campaigns.createdAt,
      audienceName: sql<string>`(
        SELECT name FROM audiences a WHERE a.id = ${campaigns.audienceId}
      )`.as("audienceName"),
      sentCount: sql<number>`(
        SELECT count(*) FROM campaign_recipients r
        WHERE r.campaign_id = ${campaigns.id} AND r.status IN ('sent', 'delivered')
      )`.as("sentCount"),
    })
    .from(campaigns)
    .where(eq(campaigns.accountId, c.get("account").id))
    .orderBy(desc(campaigns.createdAt));
  return c.json({ campaigns: rows });
});

campaignRoutes.post("/", async (c) => {
  const parsed = await parseJson(c, CampaignFieldsSchema);
  if (!parsed.ok) return parsed.response;

  const error = await validateOwnershipAndSender(c, parsed.data);
  if (error) return c.json({ error }, 400);

  const id = newId("cmp");
  const now = nowIso();
  await c.get("db").insert(campaigns).values({
    id,
    accountId: c.get("account").id,
    audienceId: parsed.data.audienceId,
    sendingDomainId: parsed.data.sendingDomainId,
    name: parsed.data.name,
    subject: parsed.data.subject,
    previewText: parsed.data.previewText ?? null,
    fromName: parsed.data.fromName,
    fromEmail: parsed.data.fromEmail,
    htmlBody: parsed.data.htmlBody,
    textBody: parsed.data.textBody ?? null,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });
  return c.json({ id }, 201);
});

async function findCampaign(c: { get: (k: "db" | "account") => unknown }, id: string) {
  const db = c.get("db") as AppContext["Variables"]["db"];
  const account = c.get("account") as AppContext["Variables"]["account"];
  return db.query.campaigns.findFirst({
    where: and(eq(campaigns.id, id), eq(campaigns.accountId, account.id)),
  });
}

async function campaignStats(db: AppContext["Variables"]["db"], campaignId: string) {
  const rows = await db
    .select({ status: campaignRecipients.status, count: sql<number>`count(*)`.as("count") })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignId))
    .groupBy(campaignRecipients.status);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
  const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
  return { total, ...byStatus };
}

campaignRoutes.get("/:id", async (c) => {
  const campaign = await findCampaign(c, c.req.param("id"));
  if (!campaign) return c.json({ error: "Not found" }, 404);
  const db = c.get("db");
  const review = await db.query.riskReviews.findFirst({
    where: eq(riskReviews.campaignId, campaign.id),
  });
  return c.json({
    campaign,
    riskReview: review ?? null,
    stats: await campaignStats(db, campaign.id),
  });
});

campaignRoutes.patch("/:id", async (c) => {
  const campaign = await findCampaign(c, c.req.param("id"));
  if (!campaign) return c.json({ error: "Not found" }, 404);
  if (campaign.status !== "draft") {
    return c.json({ error: "Only draft campaigns can be edited" }, 409);
  }

  const parsed = await parseJson(c, CampaignFieldsSchema);
  if (!parsed.ok) return parsed.response;
  const error = await validateOwnershipAndSender(c, parsed.data);
  if (error) return c.json({ error }, 400);

  await c
    .get("db")
    .update(campaigns)
    .set({
      name: parsed.data.name,
      subject: parsed.data.subject,
      previewText: parsed.data.previewText ?? null,
      audienceId: parsed.data.audienceId,
      sendingDomainId: parsed.data.sendingDomainId,
      fromName: parsed.data.fromName,
      fromEmail: parsed.data.fromEmail,
      htmlBody: parsed.data.htmlBody,
      textBody: parsed.data.textBody ?? null,
      updatedAt: nowIso(),
    })
    .where(eq(campaigns.id, campaign.id));
  return c.json({ ok: true });
});

const TestEmailSchema = z.object({ toEmail: z.email().toLowerCase() });

// Test sends are allowed before billing, but only to the requesting user's
// own primary email address.
campaignRoutes.post("/:id/test-email", async (c) => {
  const campaign = await findCampaign(c, c.req.param("id"));
  if (!campaign) return c.json({ error: "Not found" }, 404);

  const parsed = await parseJson(c, TestEmailSchema);
  if (!parsed.ok) return parsed.response;

  const user = await c.get("clerk").users.getUser(c.get("auth").userId);
  const ownEmail = user.emailAddresses
    .find((e) => e.id === user.primaryEmailAddressId)
    ?.emailAddress.toLowerCase();
  if (!ownEmail || parsed.data.toEmail !== ownEmail) {
    return c.json({ error: "Test emails can only be sent to your own email address" }, 403);
  }

  const account = c.get("account");
  const token = await signUnsubscribeToken(
    {
      accountId: account.id,
      subscriberId: "test",
      email: parsed.data.toEmail,
      campaignId: campaign.id,
    },
    c.env.UNSUBSCRIBE_SECRET,
  );
  const rendered = renderCampaignEmail({
    campaign,
    subscriber: { email: parsed.data.toEmail, firstName: "Test", lastName: "Recipient" },
    companyName: account.name,
    companyAddress: account.companyAddress,
    unsubscribeUrl: unsubscribeUrl(c.env.APP_URL, token),
  });

  const result = await createEmailProvider(c.env).send({
    accountId: account.id,
    campaignId: campaign.id,
    fromEmail: campaign.fromEmail,
    fromName: campaign.fromName,
    toEmail: parsed.data.toEmail,
    subject: `[Test] ${rendered.subject}`,
    html: rendered.html,
    text: rendered.text,
  });

  if (result.status !== "sent") {
    return c.json({ error: result.error ?? "Send failed" }, 502);
  }
  return c.json({ ok: true, messageId: result.messageId });
});

campaignRoutes.post("/:id/submit", async (c) => {
  const campaign = await findCampaign(c, c.req.param("id"));
  if (!campaign) return c.json({ error: "Not found" }, 404);

  const account = c.get("account");
  const db = c.get("db");

  const eligibility = checkSendEligibility(account);
  if (!eligibility.allowed) return c.json({ error: eligibility.reason }, 403);

  if (campaign.status !== "draft" && campaign.status !== "approved") {
    return c.json({ error: `Campaign cannot be submitted from status "${campaign.status}"` }, 409);
  }

  const domain = await db.query.sendingDomains.findFirst({
    where: eq(sendingDomains.id, campaign.sendingDomainId),
  });
  const domainVerified =
    domain && (domain.verificationStatus === "verified" || domain.adminOverrideVerified === 1);
  if (!domainVerified) {
    return c.json({ error: "Sending domain is not verified" }, 403);
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)`.as("count") })
    .from(subscribers)
    .where(
      and(
        eq(subscribers.audienceId, campaign.audienceId),
        eq(subscribers.status, "subscribed"),
      ),
    );
  if (Number(count) === 0) {
    return c.json({ error: "The audience has no subscribed recipients" }, 400);
  }

  await db
    .update(campaigns)
    .set({ status: "pending_review", pausedReason: null, updatedAt: nowIso() })
    .where(eq(campaigns.id, campaign.id));

  await c.env.JOBS_QUEUE.send({
    type: "review_campaign",
    campaignId: campaign.id,
    accountId: account.id,
  });

  return c.json({ ok: true });
});

campaignRoutes.post("/:id/pause", async (c) => {
  const campaign = await findCampaign(c, c.req.param("id"));
  if (!campaign) return c.json({ error: "Not found" }, 404);
  if (campaign.status !== "sending") {
    return c.json({ error: "Only a sending campaign can be paused" }, 409);
  }
  await c
    .get("db")
    .update(campaigns)
    .set({ status: "paused", pausedReason: "Paused by user.", updatedAt: nowIso() })
    .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "sending")));
  return c.json({ ok: true });
});

campaignRoutes.post("/:id/resume", async (c) => {
  const campaign = await findCampaign(c, c.req.param("id"));
  if (!campaign) return c.json({ error: "Not found" }, 404);
  if (campaign.status !== "paused") {
    return c.json({ error: "Only a paused campaign can be resumed" }, 409);
  }

  const eligibility = checkSendEligibility(c.get("account"));
  if (!eligibility.allowed) return c.json({ error: eligibility.reason }, 403);

  await c
    .get("db")
    .update(campaigns)
    .set({ status: "sending", pausedReason: null, updatedAt: nowIso() })
    .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "paused")));

  await c.env.JOBS_QUEUE.send({
    type: "send_campaign_batch",
    campaignId: campaign.id,
    accountId: c.get("account").id,
    batchSize: SEND_BATCH_SIZE,
  });
  return c.json({ ok: true });
});

campaignRoutes.get("/:id/stats", async (c) => {
  const campaign = await findCampaign(c, c.req.param("id"));
  if (!campaign) return c.json({ error: "Not found" }, 404);
  return c.json({ stats: await campaignStats(c.get("db"), campaign.id) });
});

const ListRecipientsSchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

campaignRoutes.get("/:id/recipients", async (c) => {
  const campaign = await findCampaign(c, c.req.param("id"));
  if (!campaign) return c.json({ error: "Not found" }, 404);

  const query = ListRecipientsSchema.safeParse(c.req.query());
  if (!query.success) return c.json({ error: "Invalid query" }, 400);

  const filters = [eq(campaignRecipients.campaignId, campaign.id)];
  if (query.data.status) {
    filters.push(eq(campaignRecipients.status, query.data.status as never));
  }
  const rows = await c
    .get("db")
    .select()
    .from(campaignRecipients)
    .where(and(...filters))
    .orderBy(desc(campaignRecipients.updatedAt))
    .limit(query.data.limit)
    .offset(query.data.offset);
  return c.json({ recipients: rows });
});
