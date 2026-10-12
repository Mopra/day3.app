import type { NextRequest } from "next/server";
import { route, json, parseJson } from "@/api/http";
import { requireAccount } from "@/api/context";
import { listDomains } from "@/api/lists";
import { addSendingDomain, CreateDomainSchema } from "@/services/domain-setup";

export const GET = route(async () => {
  const { db, account } = await requireAccount();
  return json({ domains: await listDomains(db, account.id) });
});

// Add a sending domain. The ban, ownership and SES steps live in
// services/domain-setup.ts, shared with the MCP setup tools.
export const POST = route(async (req: NextRequest) => {
  const { db, account } = await requireAccount();
  const input = await parseJson(req, CreateDomainSchema);
  return json({ domain: await addSendingDomain(db, account.id, input) }, 201);
});
