import { apiRoute } from "@/api/v1/route";
import { apiJson } from "@/api/v1/errors";
import { findCampaignOr404, renderCampaignPreview } from "@/api/v1/campaigns";

type Params = { params: Promise<{ campaignId: string }> };

// GET /api/v1/campaigns/{id}/preview — the fully rendered email.
//
// `?format=html` returns the document itself with a text/html content type, so
// the URL can be opened in a browser (or piped into a screenshot) rather than
// dug out of a JSON string. Everything else returns JSON.
export const GET = apiRoute<Params>(async (req, { db, account }, { params }) => {
  const { campaignId } = await params;
  const campaign = await findCampaignOr404(db, account.id, campaignId);
  const rendered = await renderCampaignPreview(db, account, campaign);

  if (req.nextUrl.searchParams.get("format") === "html") {
    return new Response(rendered.html, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  return apiJson({
    object: "campaign_preview",
    campaign_id: campaign.id,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
});
