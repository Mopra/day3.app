import { and, desc, eq, sql } from "drizzle-orm";
import type { ApiContext } from "../api/v1/auth";
import { ApiError } from "../api/v1/errors";
import { keyHasScope, parseScopes, requireScope } from "../api/v1/scopes";
import {
  CampaignInputSchema,
  campaignMarkdown,
  createCampaign,
  findCampaignOr404,
  renderCampaignPreview,
  serializeCampaign,
  updateCampaign,
} from "../api/v1/campaigns";
import { audiences, campaigns, senders, sendingDomains } from "../db/schema";
import { checkSendEligibility } from "../services/plans";
import { accountSandboxMode } from "../services/sandbox";
import {
  MAX_TEST_RECIPIENTS,
  scheduleCampaign,
  sendCampaignTest,
  submitCampaign,
} from "../services/campaign-send";
import { MARKDOWN_DIALECT_REFERENCE } from "../lib/campaign-markdown-docs";
import type { Tool } from "./protocol";

// The tool surface an AI editor sees. Each tool is a thin adapter over the same
// functions the REST API calls — the MCP server is a second front door onto v1,
// never a second implementation of it.

type Ctx = ApiContext;

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function requireId(args: Record<string, unknown>, key = "campaign_id"): string {
  const value = str(args[key]);
  if (!value) throw new ApiError(400, "invalid_request", `\`${key}\` is required`);
  return value;
}

// The writable campaign fields, shared by create and update. Kept as one object
// so the two tools present an identical vocabulary to the model — nothing is
// more confusing to an agent than a field it can set on create but not on edit.
const CAMPAIGN_FIELDS: Record<string, unknown> = {
  subject: { type: "string", description: "Subject line the recipient sees." },
  markdown: {
    type: "string",
    description:
      "The email body in Day3 Markdown (see the server instructions for the dialect). " +
      "Becomes editable blocks in the Day3 composer.",
  },
  name: { type: "string", description: "Internal name. Defaults to the subject." },
  preview_text: {
    type: "string",
    description: "Inbox preview line shown after the subject.",
  },
  audience_id: {
    type: "string",
    description: "Audience to send to. Defaults to the only audience when there is exactly one.",
  },
  segment_id: { type: "string", description: "Optional segment narrowing the audience." },
  topic_id: { type: "string", description: "Optional topic this campaign is sent under." },
  sender_id: {
    type: "string",
    description: "From identity. Defaults to the account's default sender.",
  },
  from_name: { type: "string", description: "Override the sender's display name." },
  reply_to: { type: "string", description: "Optional Reply-To address." },
  footer_text: {
    type: "string",
    description:
      "Footer wording. The postal address and unsubscribe link are always appended and are not editable.",
  },
};

function parseCampaignInput(args: Record<string, unknown>) {
  const { campaign_id: _ignored, ...rest } = args;
  const parsed = CampaignInputSchema.safeParse(rest);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.join(".");
    throw new ApiError(400, "invalid_request", `${path ? `${path}: ` : ""}${issue.message}`);
  }
  return parsed.data;
}

export const TOOLS: Tool<Ctx>[] = [
  {
    name: "day3_context",
    title: "Get Day3 workspace context",
    description:
      "Everything needed before writing an email: the workspace's audiences, senders, verified " +
      "sending domains, plan and sending status, and what this API key is allowed to do. " +
      "Call this first — the ids it returns are the ones the other tools take.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    handler: async (_args, { db, account, apiKey }) => {
      const [audienceRows, senderRows, domainRows] = await Promise.all([
        db
          .select({
            id: audiences.id,
            name: audiences.name,
            subscribers: sql<number>`(
              SELECT count(*)::int FROM subscribers s
              WHERE s.audience_id = audiences.id AND s.status = 'subscribed'
            )`.as("subscribers"),
          })
          .from(audiences)
          .where(eq(audiences.accountId, account.id)),
        db.select().from(senders).where(eq(senders.accountId, account.id)),
        db.select().from(sendingDomains).where(eq(sendingDomains.accountId, account.id)),
      ]);

      const eligibility = checkSendEligibility(account);
      return {
        workspace: {
          name: account.name,
          plan: account.plan,
          can_send: eligibility.allowed,
          send_blocked_reason: eligibility.allowed ? null : eligibility.reason,
          // On the free tier a send is real but reaches only the org's own
          // members. Saying so up front stops an agent reporting "sent to 1,200
          // subscribers" when four teammates got it.
          sandbox: accountSandboxMode(account),
          has_mailing_address: Boolean(account.companyAddress?.trim()),
        },
        api_key: {
          name: apiKey.name,
          scopes: parseScopes(apiKey.scopes),
          can_send_campaigns: keyHasScope(apiKey, "campaigns:send"),
        },
        audiences: audienceRows.map((a) => ({
          id: a.id,
          name: a.name,
          subscribers: Number(a.subscribers),
        })),
        senders: senderRows.map((s) => ({
          id: s.id,
          from_name: s.fromName,
          from_email: s.fromEmail,
          is_default: s.isDefault,
        })),
        sending_domains: domainRows.map((d) => ({
          id: d.id,
          domain: d.domain,
          verified: d.verificationStatus === "verified" || d.adminOverrideVerified,
        })),
      };
    },
  },

  {
    name: "day3_list_campaigns",
    title: "List campaigns",
    description: "List campaigns newest first, optionally filtered by status.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          description: "Filter by status, e.g. draft, scheduled, sending, sent.",
        },
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 20." },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { db, account }) => {
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
      const filters = [eq(campaigns.accountId, account.id)];
      const status = str(args.status);
      if (status) filters.push(eq(campaigns.status, status as never));
      const rows = await db
        .select()
        .from(campaigns)
        .where(and(...filters))
        .orderBy(desc(campaigns.createdAt))
        .limit(limit);
      return { campaigns: rows.map((c) => serializeCampaign(c)) };
    },
  },

  {
    name: "day3_get_campaign",
    title: "Get a campaign",
    description:
      "Read a campaign including its body as Day3 Markdown. Use this before editing, so changes " +
      "made in the Day3 composer since you last wrote are picked up rather than overwritten.",
    inputSchema: {
      type: "object",
      properties: { campaign_id: { type: "string" } },
      required: ["campaign_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { db, account }) => {
      const campaign = await findCampaignOr404(db, account.id, requireId(args));
      return serializeCampaign(campaign, { body: true });
    },
  },

  {
    name: "day3_create_campaign",
    title: "Create a campaign draft",
    description:
      "Create a draft campaign in Day3 from Day3 Markdown. Returns the campaign's id and a URL " +
      "where a human can open it in the composer. Creating a draft never sends anything.",
    inputSchema: {
      type: "object",
      properties: CAMPAIGN_FIELDS,
      required: ["subject", "markdown"],
      additionalProperties: false,
    },
    handler: async (args, { db, account }) => {
      const created = await createCampaign(db, account.id, parseCampaignInput(args));
      return serializeCampaign(created, { body: true });
    },
  },

  {
    name: "day3_update_campaign",
    title: "Update a campaign draft",
    description:
      "Update fields on a draft or scheduled campaign. Only the fields you pass are changed. " +
      "Passing `markdown` replaces the whole body.",
    inputSchema: {
      type: "object",
      properties: { campaign_id: { type: "string" }, ...CAMPAIGN_FIELDS },
      required: ["campaign_id"],
      additionalProperties: false,
    },
    handler: async (args, { db, account }) => {
      const campaign = await findCampaignOr404(db, account.id, requireId(args));
      const updated = await updateCampaign(db, account.id, campaign, parseCampaignInput(args));
      return serializeCampaign(updated, { body: true });
    },
  },

  {
    name: "day3_preview_campaign",
    title: "Preview a campaign",
    description:
      "Render the campaign exactly as it will arrive — theme, merge tags and compliance footer " +
      "included. Returns the plain-text rendering plus a URL that opens the HTML in a browser. " +
      "Set include_html to also get the raw HTML document (large).",
    inputSchema: {
      type: "object",
      properties: {
        campaign_id: { type: "string" },
        include_html: { type: "boolean", description: "Default false." },
      },
      required: ["campaign_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { db, account }) => {
      const campaign = await findCampaignOr404(db, account.id, requireId(args));
      const rendered = await renderCampaignPreview(db, account, campaign);
      const base = (process.env.APP_URL ?? "").replace(/\/$/, "");
      return {
        campaign_id: campaign.id,
        subject: rendered.subject,
        text: rendered.text,
        html_bytes: rendered.html.length,
        ...(args.include_html === true ? { html: rendered.html } : {}),
        ...(base ? { url: `${base}/campaigns/${campaign.id}` } : {}),
        markdown: campaignMarkdown(campaign),
      };
    },
  },

  {
    name: "day3_send_test",
    title: "Send a test email",
    description:
      `Send the campaign to up to ${MAX_TEST_RECIPIENTS} addresses you name, for checking how it ` +
      "renders. Never touches the audience. This is the safe way to look at a real email — " +
      "prefer it over sending.",
    inputSchema: {
      type: "object",
      properties: {
        campaign_id: { type: "string" },
        to: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_TEST_RECIPIENTS,
          description: "Email addresses to send the test to.",
        },
      },
      required: ["campaign_id", "to"],
      additionalProperties: false,
    },
    handler: async (args, { db, account }) => {
      const campaign = await findCampaignOr404(db, account.id, requireId(args));
      const raw = Array.isArray(args.to) ? args.to : [args.to];
      const to = [...new Set(raw.filter((v): v is string => typeof v === "string").map((e) => e.trim().toLowerCase()))];
      const result = await sendCampaignTest(db, account, campaign, to);
      return { campaign_id: campaign.id, ...result };
    },
  },

  {
    name: "day3_send_campaign",
    title: "Send a campaign to its audience",
    description:
      "Send the campaign to its whole audience, now. This is irreversible: it starts the " +
      "automated risk review and, if that passes, delivery begins immediately — there is no " +
      "further confirmation step. Requires an API key with the `campaigns:send` scope. " +
      "Confirm with the user before calling this.",
    inputSchema: {
      type: "object",
      properties: { campaign_id: { type: "string" } },
      required: ["campaign_id"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true, idempotentHint: false },
    handler: async (args, { db, account, apiKey }) => {
      requireScope(apiKey, "campaigns:send");
      const campaign = await findCampaignOr404(db, account.id, requireId(args));
      await submitCampaign(db, account, campaign);
      const updated = await findCampaignOr404(db, account.id, campaign.id);
      return serializeCampaign(updated);
    },
  },

  {
    name: "day3_schedule_campaign",
    title: "Schedule a campaign",
    description:
      "Schedule the campaign to send to its whole audience at a future time. Same consequences " +
      "as sending, just later. Requires the `campaigns:send` scope.",
    inputSchema: {
      type: "object",
      properties: {
        campaign_id: { type: "string" },
        send_at: { type: "string", description: "ISO-8601 timestamp, at least a minute ahead." },
      },
      required: ["campaign_id", "send_at"],
      additionalProperties: false,
    },
    annotations: { destructiveHint: true },
    handler: async (args, { db, account, apiKey }) => {
      requireScope(apiKey, "campaigns:send");
      const campaign = await findCampaignOr404(db, account.id, requireId(args));
      const sendAt = str(args.send_at);
      if (!sendAt) throw new ApiError(400, "invalid_request", "`send_at` is required");
      await scheduleCampaign(db, account, campaign, new Date(sendAt));
      const updated = await findCampaignOr404(db, account.id, campaign.id);
      return serializeCampaign(updated);
    },
  },
];

// Sent once at initialize rather than repeated across nine tool descriptions:
// the dialect is the thing a model has to get right, and it would otherwise cost
// tokens on every tools/list.
export const SERVER_INSTRUCTIONS = `Day3 is an email marketing platform. This server lets you write campaign emails
here and have them appear as editable drafts in the user's Day3 workspace.

Start with day3_context to learn the workspace's audiences, senders and whether
sending is possible at all.

Campaign bodies are written in Day3 Markdown:

${MARKDOWN_DIALECT_REFERENCE}

SENDING. day3_create_campaign and day3_update_campaign are safe — they only ever
produce a draft in the workspace. day3_send_test mails addresses the user names,
and is the right way to check an email. day3_send_campaign and
day3_schedule_campaign mail the entire audience and cannot be undone; they need
an API key that was explicitly created with the campaigns:send scope. Always
confirm with the user before either, and report back the URL of the draft so
they can look at it in Day3 themselves.`;
