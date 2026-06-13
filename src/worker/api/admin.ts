import { Hono } from "hono";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  accounts,
  campaigns,
  riskReviews,
  sendingDomains,
  subscribers,
} from "../db/schema";
import { nowIso } from "../lib/ids";
import { computeAccountHealth } from "../services/health";
import { addSuppression } from "../services/suppression";
import { PLANS, isPlanKey } from "../services/plans";
import { requireAdmin } from "./middleware";
import { parseJson } from "./validate";
import type { AppContext } from "./context";

// Admin routes are the only ones not scoped to the caller's account.
export const adminRoutes = new Hono<AppContext>();
adminRoutes.use("*", requireAdmin);

adminRoutes.get("/overview", async (c) => {
  const db = c.get("db");
  const [{ accountCount }] = await db
    .select({ accountCount: sql<number>`count(*)`.as("accountCount") })
    .from(accounts);
  const campaignCounts = await db
    .select({ status: campaigns.status, count: sql<number>`count(*)`.as("count") })
    .from(campaigns)
    .groupBy(campaigns.status);
  const [{ pausedAccounts }] = await db
    .select({ pausedAccounts: sql<number>`count(*)`.as("pausedAccounts") })
    .from(accounts)
    .where(eq(accounts.riskStatus, "paused"));

  return c.json({
    accounts: Number(accountCount),
    pausedAccounts: Number(pausedAccounts),
    campaignsByStatus: Object.fromEntries(campaignCounts.map((r) => [r.status, Number(r.count)])),
  });
});

// Campaigns needing attention: blocked, or approved/sent with medium+ risk.
adminRoutes.get("/reviews", async (c) => {
  const rows = await c
    .get("db")
    .select({
      campaign: campaigns,
      accountName: accounts.name,
      audienceCount: sql<number>`(
        SELECT count(*) FROM subscribers s
        WHERE s.audience_id = ${campaigns.audienceId} AND s.status = 'subscribed'
      )`.as("audienceCount"),
    })
    .from(campaigns)
    .innerJoin(accounts, eq(accounts.id, campaigns.accountId))
    .where(
      or(
        eq(campaigns.status, "blocked"),
        eq(campaigns.status, "pending_review"),
        inArray(campaigns.riskLevel, ["medium", "high", "blocked"]),
      ),
    )
    .orderBy(desc(campaigns.updatedAt))
    .limit(100);
  return c.json({ reviews: rows });
});

adminRoutes.post("/campaigns/:id/approve", async (c) => {
  const db = c.get("db");
  const campaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, c.req.param("id")),
  });
  if (!campaign) return c.json({ error: "Not found" }, 404);
  if (campaign.status !== "blocked" && campaign.status !== "pending_review") {
    return c.json({ error: `Cannot approve from status "${campaign.status}"` }, 409);
  }

  await db
    .update(campaigns)
    .set({ status: "approved", pausedReason: null, updatedAt: nowIso() })
    .where(eq(campaigns.id, campaign.id));
  await c.env.JOBS_QUEUE.send({
    type: "generate_campaign_recipients",
    campaignId: campaign.id,
    accountId: campaign.accountId,
  });
  return c.json({ ok: true });
});

const BlockSchema = z.object({ reason: z.string().trim().max(500).optional() });

adminRoutes.post("/campaigns/:id/block", async (c) => {
  const parsed = await parseJson(c, BlockSchema);
  if (!parsed.ok) return parsed.response;
  const db = c.get("db");
  const campaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, c.req.param("id")),
  });
  if (!campaign) return c.json({ error: "Not found" }, 404);

  await db
    .update(campaigns)
    .set({
      status: "blocked",
      pausedReason: parsed.data.reason ?? "Blocked by admin.",
      updatedAt: nowIso(),
    })
    .where(eq(campaigns.id, campaign.id));
  return c.json({ ok: true });
});

adminRoutes.get("/accounts", async (c) => {
  const rows = await c.get("db").select().from(accounts).orderBy(desc(accounts.createdAt));
  return c.json({ accounts: rows });
});

adminRoutes.get("/accounts/:id", async (c) => {
  const db = c.get("db");
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, c.req.param("id")),
  });
  if (!account) return c.json({ error: "Not found" }, 404);

  const health = await computeAccountHealth(db, account.id);
  const accountCampaigns = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.accountId, account.id))
    .orderBy(desc(campaigns.createdAt))
    .limit(50);
  const [{ subscriberCount }] = await db
    .select({ subscriberCount: sql<number>`count(*)`.as("subscriberCount") })
    .from(subscribers)
    .where(eq(subscribers.accountId, account.id));
  const reviews = await db
    .select()
    .from(riskReviews)
    .where(eq(riskReviews.accountId, account.id))
    .orderBy(desc(riskReviews.createdAt))
    .limit(20);

  return c.json({
    account,
    health,
    campaigns: accountCampaigns,
    subscriberCount: Number(subscriberCount),
    riskReviews: reviews,
  });
});

const PauseAccountSchema = z.object({ reason: z.string().trim().min(1).max(500) });

adminRoutes.post("/accounts/:id/pause", async (c) => {
  const parsed = await parseJson(c, PauseAccountSchema);
  if (!parsed.ok) return parsed.response;
  const db = c.get("db");
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, c.req.param("id")),
  });
  if (!account) return c.json({ error: "Not found" }, 404);

  await db
    .update(accounts)
    .set({
      sendingEnabled: 0,
      riskStatus: "paused",
      pausedReason: parsed.data.reason,
      updatedAt: nowIso(),
    })
    .where(eq(accounts.id, account.id));
  return c.json({ ok: true });
});

adminRoutes.post("/accounts/:id/resume", async (c) => {
  const db = c.get("db");
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, c.req.param("id")),
  });
  if (!account) return c.json({ error: "Not found" }, 404);

  const plan = isPlanKey(account.plan) ? PLANS[account.plan] : PLANS.none;
  await db
    .update(accounts)
    .set({
      riskStatus: "normal",
      pausedReason: null,
      sendingEnabled:
        plan.sendingEnabled && account.subscriptionStatus === "active" ? 1 : 0,
      updatedAt: nowIso(),
    })
    .where(eq(accounts.id, account.id));
  return c.json({ ok: true });
});

adminRoutes.post("/domains/:id/override-verify", async (c) => {
  const db = c.get("db");
  const domain = await db.query.sendingDomains.findFirst({
    where: eq(sendingDomains.id, c.req.param("id")),
  });
  if (!domain) return c.json({ error: "Not found" }, 404);

  await db
    .update(sendingDomains)
    .set({ adminOverrideVerified: 1, updatedAt: nowIso() })
    .where(eq(sendingDomains.id, domain.id));
  return c.json({ ok: true });
});

// Lets the admin see (and verify) any account's domains from the account page.
adminRoutes.get("/accounts/:id/domains", async (c) => {
  const rows = await c
    .get("db")
    .select()
    .from(sendingDomains)
    .where(eq(sendingDomains.accountId, c.req.param("id")))
    .orderBy(desc(sendingDomains.createdAt));
  return c.json({ domains: rows });
});

const SuppressSchema = z.object({ email: z.email().toLowerCase(), accountId: z.string().min(1) });

// Manual suppression for bounce/complaint handling when provider events are
// not available.
adminRoutes.post("/suppress", async (c) => {
  const parsed = await parseJson(c, SuppressSchema);
  if (!parsed.ok) return parsed.response;
  await addSuppression(c.get("db"), {
    accountId: parsed.data.accountId,
    email: parsed.data.email,
    reason: "manual",
    source: "admin",
  });
  const now = nowIso();
  await c
    .get("db")
    .update(subscribers)
    .set({ status: "suppressed", updatedAt: now })
    .where(
      and(
        eq(subscribers.accountId, parsed.data.accountId),
        eq(subscribers.email, parsed.data.email),
      ),
    );
  return c.json({ ok: true });
});
