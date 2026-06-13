import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { sendingDomains } from "../db/schema";
import { newId, nowIso } from "../lib/ids";
import { requireAccount } from "./middleware";
import { parseJson } from "./validate";
import type { AppContext } from "./context";

export const domainRoutes = new Hono<AppContext>();
domainRoutes.use("*", requireAccount);

domainRoutes.get("/", async (c) => {
  const rows = await c
    .get("db")
    .select()
    .from(sendingDomains)
    .where(eq(sendingDomains.accountId, c.get("account").id))
    .orderBy(desc(sendingDomains.createdAt));
  return c.json({ domains: rows });
});

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

const CreateDomainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(DOMAIN_RE, "Enter a valid domain like updates.example.com"),
  fromName: z.string().trim().min(1).max(100),
  fromEmail: z.email().toLowerCase(),
});

domainRoutes.post("/", async (c) => {
  const parsed = await parseJson(c, CreateDomainSchema);
  if (!parsed.ok) return parsed.response;
  const { domain, fromName, fromEmail } = parsed.data;

  if (!fromEmail.endsWith(`@${domain}`)) {
    return c.json({ error: "From email must use the sending domain" }, 400);
  }

  const account = c.get("account");
  const id = newId("dom");
  const now = nowIso();
  try {
    await c.get("db").insert(sendingDomains).values({
      id,
      accountId: account.id,
      domain,
      fromName,
      fromEmail,
      provider: "cloudflare",
      verificationStatus: "pending",
      dkimStatus: "pending",
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    return c.json({ error: "That domain is already added" }, 409);
  }
  const row = await c.get("db").query.sendingDomains.findFirst({
    where: eq(sendingDomains.id, id),
  });
  return c.json({ domain: row }, 201);
});

// Re-check verification with the provider. Cloudflare Email Service domain
// onboarding is not automated in the MVP — domains are verified via wrangler
// (`wrangler email sending enable <domain>`) or by admin override.
domainRoutes.post("/:id/check", async (c) => {
  const row = await c.get("db").query.sendingDomains.findFirst({
    where: and(
      eq(sendingDomains.id, c.req.param("id")),
      eq(sendingDomains.accountId, c.get("account").id),
    ),
  });
  if (!row) return c.json({ error: "Not found" }, 404);
  return c.json({ domain: row });
});
