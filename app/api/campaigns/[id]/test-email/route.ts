import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findCampaign } from "@/api/finders";
import { signUnsubscribeToken, unsubscribeUrl } from "@/services/unsubscribe";
import { renderCampaignEmail } from "@/services/render";
import { emailProviderFromEnv } from "@/email/factory";
import { requireUnsubscribeSecret } from "@/lib/env";
import { enforceRateLimit } from "@/lib/rate-limit";

// Mirrored in <SendTestButton>.
const MAX_TEST_RECIPIENTS = 5;

const TestEmailSchema = z.object({
  // Legacy single-recipient shape — still accepted so stale clients keep working.
  toEmail: z.email().toLowerCase().optional(),
  toEmails: z.array(z.email().toLowerCase()).min(1).max(MAX_TEST_RECIPIENTS).optional(),
});

// Test sends are allowed before billing, to any addresses the user types in
// (themselves, a colleague, a rendering-check inbox). Abuse is bounded by the
// per-request recipient cap and by charging the rate limiter once per
// recipient, so a 5-address test costs the same window budget as 5 singles.
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

  const provider = emailProviderFromEnv();
  const secret = requireUnsubscribeSecret();
  const sent: string[] = [];
  const failed: { email: string; error: string }[] = [];

  for (const toEmail of toEmails) {
    const token = await signUnsubscribeToken(
      { accountId: account.id, subscriberId: "test", email: toEmail, campaignId: campaign.id },
      secret,
    );
    const rendered = renderCampaignEmail({
      campaign,
      subscriber: { email: toEmail, firstName: "Test", lastName: "Recipient" },
      companyName: account.name,
      companyAddress: account.companyAddress,
      unsubscribeUrl: unsubscribeUrl(process.env.APP_URL ?? "", token),
    });

    const result = await provider.send({
      accountId: account.id,
      campaignId: campaign.id,
      fromEmail: campaign.fromEmail,
      fromName: campaign.fromName,
      toEmail,
      subject: `[Test] ${rendered.subject}`,
      html: rendered.html,
      text: rendered.text,
    });

    if (result.status === "sent") sent.push(toEmail);
    else failed.push({ email: toEmail, error: result.error ?? "Send failed" });
  }

  if (sent.length === 0) throw new HttpError(502, failed[0]?.error ?? "Send failed");
  return json({ ok: failed.length === 0, sent, failed });
});
