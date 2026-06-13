import { Hono } from "hono";
import { requireAuth } from "./middleware";
import { accountRoutes } from "./accounts";
import { domainRoutes } from "./domains";
import { audienceRoutes } from "./audiences";
import { subscriberRoutes } from "./subscribers";
import { campaignRoutes } from "./campaigns";
import { adminRoutes } from "./admin";
import { webhookRoutes } from "./webhooks";
import { publicRoutes } from "./public";
import type { AppContext } from "./context";

export const api = new Hono<AppContext>().basePath("/api");

// Public: no auth.
api.route("/webhooks", webhookRoutes);
api.route("/public", publicRoutes);

// Everything else requires a Clerk session.
api.use("*", requireAuth);
api.route("/account", accountRoutes);
api.route("/domains", domainRoutes);
api.route("/audiences", audienceRoutes);
api.route("/subscribers", subscriberRoutes);
api.route("/campaigns", campaignRoutes);
api.route("/admin", adminRoutes);

api.notFound((c) => c.json({ error: "Not found" }, 404));
api.onError((err, c) => {
  console.error("[api] unhandled error", err);
  return c.json({ error: "Internal error" }, 500);
});
