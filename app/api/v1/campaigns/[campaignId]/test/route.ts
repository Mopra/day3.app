import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { apiJson } from "@/api/v1/errors";
import { findCampaignOr404 } from "@/api/v1/campaigns";
import { MAX_TEST_RECIPIENTS, sendCampaignTest } from "@/services/campaign-send";

type Params = { params: Promise<{ campaignId: string }> };

const TestSchema = z.object({
  to: z.union([z.email(), z.array(z.email()).min(1).max(MAX_TEST_RECIPIENTS)]),
});

// POST /api/v1/campaigns/{id}/test — send the campaign to named addresses.
//
// Deliberately NOT behind the `campaigns:send` scope. A test reaches only the
// addresses in this request, never the audience, and iterating on an email is
// the main thing an external editor is for — putting it behind the same gate as
// "mail the whole list" would make the safe path as hard as the dangerous one.
export const POST = apiRoute<Params>(async (req, { db, account }, { params }) => {
  const { campaignId } = await params;
  const campaign = await findCampaignOr404(db, account.id, campaignId);
  const body = await readJson(req, TestSchema);
  const toEmails = [...new Set((Array.isArray(body.to) ? body.to : [body.to]).map((e) => e.toLowerCase()))];

  const result = await sendCampaignTest(db, account, campaign, toEmails);
  return apiJson({
    object: "campaign_test",
    campaign_id: campaign.id,
    sent: result.sent,
    failed: result.failed,
  });
});
