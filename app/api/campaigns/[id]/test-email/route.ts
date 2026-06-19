import { clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findCampaign } from "@/api/finders";
import { signUnsubscribeToken, unsubscribeUrl } from "@/services/unsubscribe";
import { renderCampaignEmail } from "@/services/render";
import { emailProviderFromEnv } from "@/email/factory";
import { requireUnsubscribeSecret } from "@/lib/env";
import { enforceRateLimit } from "@/lib/rate-limit";

const TestEmailSchema = z.object({ toEmail: z.email().toLowerCase() });

// Test sends are allowed before billing, but only to the requesting user's own
// primary email address.
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account, auth } = await requireAccount();
  await enforceRateLimit("test_email", account.id);
  const campaign = await findCampaign(db, account.id, id);
  if (!campaign) throw new HttpError(404, "Not found");

  const { toEmail } = await parseJson(req, TestEmailSchema);

  const clerk = await clerkClient();
  const user = await clerk.users.getUser(auth.userId);
  const ownEmail = user.emailAddresses
    .find((e) => e.id === user.primaryEmailAddressId)
    ?.emailAddress.toLowerCase();
  if (!ownEmail || toEmail !== ownEmail) {
    throw new HttpError(403, "Test emails can only be sent to your own email address");
  }

  const token = await signUnsubscribeToken(
    { accountId: account.id, subscriberId: "test", email: toEmail, campaignId: campaign.id },
    requireUnsubscribeSecret(),
  );
  const rendered = renderCampaignEmail({
    campaign,
    subscriber: { email: toEmail, firstName: "Test", lastName: "Recipient" },
    companyName: account.name,
    companyAddress: account.companyAddress,
    unsubscribeUrl: unsubscribeUrl(process.env.APP_URL ?? "", token),
  });

  const result = await emailProviderFromEnv().send({
    accountId: account.id,
    campaignId: campaign.id,
    fromEmail: campaign.fromEmail,
    fromName: campaign.fromName,
    toEmail,
    subject: `[Test] ${rendered.subject}`,
    html: rendered.html,
    text: rendered.text,
  });

  if (result.status !== "sent") {
    throw new HttpError(502, result.error ?? "Send failed");
  }
  return json({ ok: true, messageId: result.messageId });
});
