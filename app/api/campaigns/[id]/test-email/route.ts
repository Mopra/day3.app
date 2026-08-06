import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findCampaign } from "@/api/finders";
import { enforceRateLimit } from "@/lib/rate-limit";
import { MAX_TEST_RECIPIENTS, sendCampaignTest } from "@/services/campaign-send";

const TestEmailSchema = z.object({
  // Legacy single-recipient shape — still accepted so stale clients keep working.
  toEmail: z.email().toLowerCase().optional(),
  toEmails: z.array(z.email().toLowerCase()).min(1).max(MAX_TEST_RECIPIENTS).optional(),
});

// The gates, quota accounting and rendering all live in services/campaign-send
// so this route and its public-API twin (POST /v1/campaigns/{id}/test) can never
// disagree about what a test send costs or checks.
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();

  const body = await parseJson(req, TestEmailSchema);
  const toEmails = [...new Set(body.toEmails ?? (body.toEmail ? [body.toEmail] : []))];
  if (toEmails.length === 0) throw new HttpError(400, "Provide at least one recipient");

  for (let i = 0; i < toEmails.length; i++) {
    await enforceRateLimit("test_email", account.id);
  }

  const campaign = await findCampaign(db, account.id, id);
  if (!campaign) throw new HttpError(404, "Not found");

  const result = await sendCampaignTest(db, account, campaign, toEmails);
  return json({ ok: result.failed.length === 0, ...result });
});
