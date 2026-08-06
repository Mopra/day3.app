import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { campaigns, sendingDomains, type Account, type Campaign } from "../db/schema";
import { HttpError } from "../api/http";
import { campaignContentError, campaignSendGateError } from "../api/campaigns";
import { nowIso } from "../lib/ids";
import { getQueue } from "../queue/producer";
import { checkSendEligibility } from "./plans";
import { releaseReservation, reserveQuota } from "./quota";
import {
  accountSandboxMode,
  SANDBOX_EXHAUSTED_MESSAGE,
  SANDBOX_MONTHLY_ALLOWANCE,
} from "./sandbox";
import { getAudienceFieldFallbacks } from "./audience-fields";
import { renderCampaignEmail } from "./render";
import { safeParseTheme } from "../lib/theme";
import { signUnsubscribeToken, unsubscribeUrl } from "./unsubscribe";
import { emailProviderFromEnv } from "../email/factory";
import { requireUnsubscribeSecret } from "../lib/env";

// The three ways a campaign leaves the composer: a test send, a submit (which
// enters the review→send pipeline immediately), and a schedule.
//
// These live here rather than in the route handlers because there are now two
// front doors to each — the app's session routes and the public v1 API that the
// MCP server drives — and "which gates ran before this email went out" is not a
// question that may have two answers. Errors are thrown as HttpError; the v1
// wrapper maps them onto public error codes.

// Mirrored in <SendTestButton>.
export const MAX_TEST_RECIPIENTS = 5;

export type TestSendResult = { sent: string[]; failed: { email: string; error: string }[] };

// Test sends go to addresses the caller names — themselves, a colleague, a
// rendering-check inbox — and never touch the audience. That freedom is the
// point. What they are NOT is free unlimited sending: on the free tier a test
// costs one email from the sandbox allowance, the same ledger a sandbox campaign
// or an API call draws on. Paid plans keep tests off the meter.
export async function sendCampaignTest(
  db: Db,
  account: Account,
  campaign: Campaign,
  toEmails: string[],
): Promise<TestSendResult> {
  // A risk pause means "this account sends nothing" — including previews.
  if (account.riskStatus === "paused") {
    throw new HttpError(403, account.pausedReason ?? "Sending is paused for this account.");
  }
  if (toEmails.length === 0) throw new HttpError(400, "Provide at least one recipient");
  if (toEmails.length > MAX_TEST_RECIPIENTS) {
    throw new HttpError(400, `A test send may reach at most ${MAX_TEST_RECIPIENTS} addresses`);
  }

  // Friendly pre-gates so a test fails with a clear message here, not as a raw
  // SES error per address. Lighter than the real send gate — a test needs no
  // audience or mailing address, just something to render and a verified sender.
  if (!campaign.subject.trim() || !campaign.htmlBody.trim() || !campaign.fromEmail.trim()) {
    throw new HttpError(
      400,
      "Add a subject, a From address, and some content before sending a test.",
    );
  }
  const domain = await db.query.sendingDomains.findFirst({
    where: and(
      eq(sendingDomains.id, campaign.sendingDomainId),
      eq(sendingDomains.accountId, account.id),
    ),
  });
  const domainVerified =
    domain && (domain.verificationStatus === "verified" || domain.adminOverrideVerified);
  if (!domainVerified) {
    throw new HttpError(
      400,
      "Verify your sending domain before sending a test — email can only go out from a verified domain.",
    );
  }

  // Reserve the whole test up front against the shared monthly counter, so
  // concurrent tests can't both squeeze past the last unit of allowance. What
  // doesn't actually send is given back below.
  const sandbox = accountSandboxMode(account);
  if (sandbox) {
    const granted = await reserveQuota(db, account.id, toEmails.length, SANDBOX_MONTHLY_ALLOWANCE);
    if (granted < toEmails.length) {
      await releaseReservation(db, account.id, granted);
      throw new HttpError(403, SANDBOX_EXHAUSTED_MESSAGE);
    }
  }

  const provider = emailProviderFromEnv();
  const secret = requireUnsubscribeSecret();
  // Same audience-level merge defaults a real send applies, so the test renders
  // exactly what recipients will get.
  const fieldFallbacks = campaign.audienceId
    ? await getAudienceFieldFallbacks(db, campaign.audienceId)
    : null;
  const sent: string[] = [];
  const failed: { email: string; error: string }[] = [];

  for (const toEmail of toEmails) {
    const token = await signUnsubscribeToken(
      { accountId: account.id, subscriberId: "test", email: toEmail, campaignId: campaign.id },
      secret,
    );
    const rendered = renderCampaignEmail({
      campaign,
      theme: safeParseTheme(campaign.themeJson),
      subscriber: { email: toEmail, firstName: "Test", lastName: "Recipient" },
      companyName: account.name,
      companyAddress: account.companyAddress,
      unsubscribeUrl: unsubscribeUrl(process.env.APP_URL ?? "", token),
      fieldFallbacks,
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

  // Give back the reservation for anything the provider didn't take, so a failed
  // test doesn't quietly cost a free user part of their allowance.
  if (sandbox && failed.length > 0) {
    await releaseReservation(db, account.id, failed.length);
  }

  if (sent.length === 0) throw new HttpError(502, failed[0]?.error ?? "Send failed");
  return { sent, failed };
}

// The gates every real send passes, whichever door it came through: account
// eligibility (billing / plan / risk), content completeness, then the campaign
// gates (mailing address, verified domain, someone to actually send to).
async function assertSendable(
  db: Db,
  account: Account,
  campaign: Campaign,
): Promise<{ sandbox: boolean }> {
  const eligibility = checkSendEligibility(account);
  if (!eligibility.allowed) throw new HttpError(403, eligibility.reason);

  const contentError = campaignContentError(campaign);
  if (contentError) throw new HttpError(400, contentError);

  const gateError = await campaignSendGateError(db, account.id, campaign, {
    sandbox: eligibility.sandbox,
  });
  if (gateError) throw new HttpError(gateError.includes("verified") ? 403 : 400, gateError);

  return { sandbox: eligibility.sandbox };
}

// Submit a campaign for sending. This is NOT a request for human approval:
// `pending_review` is the automated risk review, and a campaign that clears it
// goes straight on to recipient generation and delivery. Treat a successful
// call as "the email is going out".
export async function submitCampaign(
  db: Db,
  account: Account,
  campaign: Campaign,
): Promise<void> {
  if (campaign.status !== "draft" && campaign.status !== "approved") {
    throw new HttpError(409, `Campaign cannot be submitted from status "${campaign.status}"`);
  }
  const { sandbox } = await assertSendable(db, account, campaign);

  // Stamp the send mode as the campaign leaves draft. From here on the pipeline
  // reads the campaign's own flag rather than re-deriving it from the plan, so a
  // mid-flight upgrade/downgrade can't change how this send is targeted or
  // metered (and an upgrade takes effect on the *next* campaign, as expected).
  await db
    .update(campaigns)
    .set({
      status: "pending_review",
      sandbox,
      scheduledAt: null,
      pausedReason: null,
      updatedAt: nowIso(),
    })
    .where(eq(campaigns.id, campaign.id));

  await getQueue().send({
    type: "review_campaign",
    campaignId: campaign.id,
    accountId: account.id,
  });
}

export const MIN_SCHEDULE_LEAD_MS = 60_000;

// Park a campaign to send later. The 15-minute cron sweep releases it into the
// normal review→send pipeline once the time passes; the gates below are
// re-checked at that point, since the account may have changed in between.
export async function scheduleCampaign(
  db: Db,
  account: Account,
  campaign: Campaign,
  when: Date,
): Promise<string> {
  if (campaign.status !== "draft" && campaign.status !== "scheduled") {
    throw new HttpError(409, `Campaign cannot be scheduled from status "${campaign.status}"`);
  }
  if (Number.isNaN(when.getTime())) throw new HttpError(400, "Invalid schedule time");
  if (when.getTime() < Date.now() + MIN_SCHEDULE_LEAD_MS) {
    throw new HttpError(400, "Pick a time at least a minute from now");
  }

  const { sandbox } = await assertSendable(db, account, campaign);

  // The send mode is stamped here for the UI's benefit (a scheduled campaign
  // shows its Sandbox badge while it waits), but it is authoritatively
  // re-derived when the cron releases it.
  await db
    .update(campaigns)
    .set({
      status: "scheduled",
      sandbox,
      scheduledAt: when.toISOString(),
      pausedReason: null,
      updatedAt: nowIso(),
    })
    .where(eq(campaigns.id, campaign.id));

  return when.toISOString();
}
