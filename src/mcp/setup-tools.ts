import { eq } from "drizzle-orm";
import { z } from "zod";
import { ApiError } from "../api/v1/errors";
import { ContactInputSchema, writeContacts } from "../api/v1/contacts";
import { findAudience } from "../api/finders";
import { accounts, audiences, type SendingDomain } from "../db/schema";
import { newId, nowIso } from "../lib/ids";
import { parseDnsRecords } from "../lib/domain";
import { formsBaseUrl, hostedFormUrl } from "../lib/public-url";
import { computeOnboardingState } from "../services/onboarding";
import { addSendingDomain, recheckSendingDomain } from "../services/domain-setup";
import { createSignupForm, CreateFormSchema } from "../services/form-setup";
import type { McpContext } from "./auth";
import type { Tool } from "./protocol";

// Workspace setup over MCP, so an agent can take a fresh workspace (including
// one it just signed itself up for) to "ready to send" without the app.
//
// Each tool is a thin adapter over the service the app's own route calls. None
// of them sends mail, so none is scoped (api/v1/scopes.ts): the base grant
// already writes contacts and drafts, and this is the same kind of write.

type Ctx = McpContext;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue.path.join(".");
    throw new ApiError(400, "invalid_request", `${path ? `${path}: ` : ""}${issue.message}`);
  }
  return parsed.data;
}

function serializeDomain(d: SendingDomain) {
  return {
    id: d.id,
    domain: d.domain,
    verified: d.verificationStatus === "verified" || d.adminOverrideVerified,
    verification_status: d.verificationStatus,
    // The records to publish at the domain's DNS host. Adding them is the one
    // setup step that happens outside Day3; relay them to the human verbatim.
    dns_records: parseDnsRecords(d.dnsRecordsJson).map((r) => ({
      type: r.type,
      name: r.name,
      value: r.value,
      ...(r.priority !== undefined ? { priority: r.priority } : {}),
      required: r.required,
      purpose: r.description ?? null,
    })),
  };
}

export const SETUP_TOOLS: Tool<Ctx>[] = [
  {
    name: "day3_setup_status",
    title: "Get workspace setup status",
    description:
      "What this workspace still needs before it can email real subscribers, in order, with the " +
      "tool that does each step. Call it after connecting to a new workspace, and again after each step.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    handler: async (_args, { db, account }) => {
      const s = await computeOnboardingState(db, account);
      const next: string[] = [];
      if (!s.hasMailingAddress) {
        next.push("Set the business mailing address every email footer must carry (day3_set_mailing_address).");
      }
      if (!s.hasVerifiedDomain) {
        next.push(
          "Add the domain to send from and publish its DNS records (day3_add_domain, then day3_check_domain). " +
            "Until then the workspace can only send test emails to its own members from Day3's shared domain.",
        );
      }
      if (!s.hasOwnSubscribers) {
        next.push(
          "Get subscribers: import existing ones (day3_create_audience, day3_add_contacts, only people " +
            "who opted in) or start a list with a signup form (day3_create_form).",
        );
      }
      if (!s.billingActive) {
        next.push(
          "Mailing anyone outside the team needs a paid plan, which a human picks at " +
            "https://go.day3.app/billing. Drafting and test sends work without one.",
        );
      }
      if (!s.hasCampaign) next.push("Write the first email (day3_create_campaign) and send yourself a test (day3_send_test).");
      return {
        ready_to_send_to_subscribers: s.canSend && !s.sandbox && s.hasVerifiedDomain && s.hasOwnSubscribers,
        sandbox: s.sandbox,
        send_blocked_reason: s.sendBlockedReason,
        done: {
          mailing_address: s.hasMailingAddress,
          verified_domain: s.hasVerifiedDomain,
          own_subscribers: s.hasOwnSubscribers,
          paid_plan: s.billingActive,
          first_campaign: s.hasCampaign,
          first_send: s.hasSentCampaign,
        },
        next_steps: next,
      };
    },
  },

  {
    name: "day3_set_mailing_address",
    title: "Set the business mailing address",
    description:
      "Set the physical mailing address printed in every email footer. Anti-spam law requires it, so " +
      "Day3 will not send without one. Use the real business address the human gives you; never invent one.",
    inputSchema: {
      type: "object",
      properties: { address: { type: "string", description: "Full postal address, one line." } },
      required: ["address"],
      additionalProperties: false,
    },
    handler: async (args, { db, account }) => {
      const address = parse(z.string().trim().min(5).max(500), args.address);
      await db
        .update(accounts)
        .set({ companyAddress: address, updatedAt: nowIso() })
        .where(eq(accounts.id, account.id));
      return { mailing_address: address };
    },
  },

  {
    name: "day3_add_domain",
    title: "Add a sending domain",
    description:
      "Add the domain this workspace sends from (a subdomain like mail.example.com is best) and " +
      "create its first sender. Returns the DNS records the human must add at their DNS host. " +
      "Then call day3_check_domain to see when they resolve.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "e.g. mail.example.com" },
        from_name: { type: "string", description: "Display name recipients see, e.g. Acme." },
        from_email: { type: "string", description: "Address on that domain, e.g. hello@mail.example.com." },
      },
      required: ["domain", "from_name", "from_email"],
      additionalProperties: false,
    },
    handler: async (args, { db, account }) => {
      const row = await addSendingDomain(db, account.id, {
        domain: parse(z.string().trim().toLowerCase(), args.domain),
        fromName: parse(z.string().trim().min(1).max(100), args.from_name),
        fromEmail: parse(z.email().toLowerCase(), args.from_email),
      });
      return serializeDomain(row);
    },
  },

  {
    name: "day3_check_domain",
    title: "Check a sending domain",
    description:
      "Re-check whether a domain's DNS records are live and the domain is verified. DNS can take " +
      "minutes to hours; Day3 also keeps checking on its own, so there is no need to poll quickly.",
    inputSchema: {
      type: "object",
      properties: { domain_id: { type: "string" } },
      required: ["domain_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    handler: async (args, { db, account }) => {
      const id = parse(z.string().min(1), args.domain_id);
      const result = await recheckSendingDomain(db, account.id, id);
      if (!result.domain) throw new ApiError(404, "not_found", "Domain not found");
      return {
        ...serializeDomain(result.domain),
        records_live: result.dns.records,
        dns_host: result.registrar ?? null,
      };
    },
  },

  {
    name: "day3_create_audience",
    title: "Create an audience",
    description: "Create a list of contacts that campaigns are sent to.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    handler: async (args, { db, account }) => {
      const name = parse(z.string().trim().min(1).max(100), args.name);
      const now = nowIso();
      const id = newId("aud");
      await db.insert(audiences).values({ id, accountId: account.id, name, createdAt: now, updatedAt: now });
      return { id, name };
    },
  },

  {
    name: "day3_add_contacts",
    title: "Add contacts to an audience",
    description:
      "Add or update up to 500 contacts in an audience. Only add people who agreed to hear from " +
      "this sender: mailing a bought or scraped list gets the workspace paused. Status may be " +
      "subscribed (default) or unsubscribed, to carry over opt-outs from a previous tool.",
    inputSchema: {
      type: "object",
      properties: {
        audience_id: { type: "string" },
        contacts: {
          type: "array",
          maxItems: 500,
          items: {
            type: "object",
            properties: {
              email: { type: "string" },
              first_name: { type: "string" },
              last_name: { type: "string" },
              attributes: { type: "object", additionalProperties: { type: "string" } },
              status: { type: "string", enum: ["subscribed", "unsubscribed"] },
            },
            required: ["email"],
          },
        },
      },
      required: ["audience_id", "contacts"],
      additionalProperties: false,
    },
    handler: async (args, { db, account }) => {
      const audienceId = parse(z.string().min(1), args.audience_id);
      const audience = await findAudience(db, account.id, audienceId);
      if (!audience) throw new ApiError(404, "not_found", "Audience not found");
      const inputs = parse(z.array(ContactInputSchema).min(1).max(500), args.contacts);
      const { results } = await writeContacts(db, account, audience.id, inputs, { upsert: true });
      const failed = results
        .map((r, i) => (r.status === "failed" ? { email: inputs[i].email, error: r.message } : null))
        .filter((r) => r !== null);
      return {
        audience_id: audience.id,
        created: results.filter((r) => r.status === "created").length,
        updated: results.filter((r) => r.status === "updated").length,
        failed,
      };
    },
  },

  {
    name: "day3_create_form",
    title: "Create a signup form",
    description:
      "Create a hosted signup form that adds people to an audience, and return its public URL to " +
      "share or link from a website. Double opt-in is on by default: new signups confirm by email first.",
    inputSchema: {
      type: "object",
      properties: {
        audience_id: { type: "string" },
        name: { type: "string", description: "Internal name." },
        headline: { type: "string", description: "Shown at the top of the form." },
        description: { type: "string" },
        button_label: { type: "string", description: "Default Subscribe." },
        success_message: { type: "string" },
        collect_name: { type: "boolean", description: "Ask for a first name too." },
      },
      required: ["audience_id", "name"],
      additionalProperties: false,
    },
    handler: async (args, { db, account }) => {
      const input = parse(CreateFormSchema, {
        audienceId: args.audience_id,
        name: args.name,
        headline: args.headline,
        description: args.description,
        buttonLabel: args.button_label,
        successMessage: args.success_message,
        collectName: args.collect_name,
      });
      const form = await createSignupForm(db, account, input);
      return { id: form.id, slug: form.slug, url: hostedFormUrl(formsBaseUrl(), form.id) };
    },
  },
];
