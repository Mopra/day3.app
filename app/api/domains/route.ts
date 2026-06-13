import type { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { sendingDomains } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";

export const GET = route(async () => {
  const { db, account } = await requireAccount();
  const rows = await db
    .select()
    .from(sendingDomains)
    .where(eq(sendingDomains.accountId, account.id))
    .orderBy(desc(sendingDomains.createdAt));
  return json({ domains: rows });
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

export const POST = route(async (req: NextRequest) => {
  const { db, account } = await requireAccount();
  const { domain, fromName, fromEmail } = await parseJson(req, CreateDomainSchema);

  if (!fromEmail.endsWith(`@${domain}`)) {
    throw new HttpError(400, "From email must use the sending domain");
  }

  const id = newId("dom");
  const now = nowIso();
  try {
    await db.insert(sendingDomains).values({
      id,
      accountId: account.id,
      domain,
      fromName,
      fromEmail,
      provider: "ses",
      verificationStatus: "pending",
      dkimStatus: "pending",
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    throw new HttpError(409, "That domain is already added");
  }
  const row = await db.query.sendingDomains.findFirst({ where: eq(sendingDomains.id, id) });
  return json({ domain: row }, 201);
});
