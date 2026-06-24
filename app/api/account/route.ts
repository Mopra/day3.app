import type { NextRequest } from "next/server";
import { clerkClient } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson } from "@/api/http";
import { requireAccount } from "@/api/context";
import { accounts } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { computeAccountHealth } from "@/services/health";

export const GET = route(async () => {
  const { db, account } = await requireAccount();
  const health = await computeAccountHealth(db, account.id);
  return json({ account, health });
});

const UpdateAccountSchema = z.object({
  // The organization / company name. Clerk is the canonical source (it shows in
  // the org switcher), so we rename it there too — see PATCH below.
  name: z.string().trim().min(1).max(120).optional(),
  companyAddress: z.string().max(500).optional(),
});

export const PATCH = route(async (req: NextRequest) => {
  const { db, account } = await requireAccount();
  const data = await parseJson(req, UpdateAccountSchema);

  // Partial update: only touch the fields actually present in the request so a
  // name-only edit doesn't clear the address (and vice versa).
  const set: { name?: string; companyAddress?: string | null; updatedAt: string } = {
    updatedAt: nowIso(),
  };

  if (data.name !== undefined) {
    // Rename the Clerk organization first (the canonical name shown across the
    // workspace), then mirror it locally so the footer's {{company_name}} matches.
    const clerk = await clerkClient();
    await clerk.organizations.updateOrganization(account.clerkOrgId, { name: data.name });
    set.name = data.name;
  }
  if (data.companyAddress !== undefined) {
    set.companyAddress = data.companyAddress || null;
  }

  await db.update(accounts).set(set).where(eq(accounts.id, account.id));
  return json({ ok: true });
});
