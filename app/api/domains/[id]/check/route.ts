import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import { recheckSendingDomain } from "@/services/domain-setup";

// Re-check verification with SES. See services/domain-setup.ts, shared with the
// MCP setup tools.
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  return json(await recheckSendingDomain(db, account.id, id));
});
