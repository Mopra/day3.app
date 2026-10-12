"use client";

import Link from "next/link";
import { PLANS, firstSendingPlan } from "@/lib/plans-catalog";

// The "who actually gets this" notes under the send-confirmation count. Shared
// by the campaign detail page's dialog and the CampaignActions dialog on
// /campaigns/new, which are the two send moments and must say the same thing.
//
// - Free (sandbox): only teammates receive it, and the people left out are the
//   moment a free user most wants to pay, so name the number and the price.
// - Young paid workspace: the new-account ramp spreads a big send over days;
//   say so before the click rather than pausing part-way with no warning.
//
// `audienceSubscribed` is the audience's subscribed count, which ignores segment
// and topic scoping and suppressions, so the numbers are only quoted for a
// whole-list send.
export function SendReachNotices({
  campaignId,
  scoped,
  sandboxRecipients,
  audienceSubscribed,
  rampRemaining,
}: {
  campaignId: string;
  scoped: boolean;
  sandboxRecipients: number | null;
  audienceSubscribed: number | null;
  rampRemaining: number | null;
}) {
  if (sandboxRecipients !== null) {
    const leftOut =
      audienceSubscribed !== null ? audienceSubscribed - sandboxRecipients : 0;
    return (
      <>
        <p className="text-sm text-muted-foreground">
          Test mode: only people on your team get this, even if the list is bigger.
        </p>
        {leftOut > 0 && (
          <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <p className="text-muted-foreground">
              {scoped ? (
                "Everyone else on this list won't get it."
              ) : (
                <>
                  <strong className="text-foreground">
                    {leftOut.toLocaleString()} {leftOut === 1 ? "subscriber" : "subscribers"}
                  </strong>{" "}
                  on this list won&apos;t get it.
                </>
              )}{" "}
              Plans start at ${PLANS[firstSendingPlan()].monthlyPriceUsd}/mo and send to everyone.
            </p>
            <Link
              href={`/billing?next=${encodeURIComponent(`/campaigns/${campaignId}`)}`}
              className="mt-2 inline-block font-medium underline underline-offset-4"
            >
              Choose a plan
            </Link>
          </div>
        )}
      </>
    );
  }

  if (
    !scoped &&
    rampRemaining !== null &&
    audienceSubscribed !== null &&
    audienceSubscribed > rampRemaining
  ) {
    return (
      <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-muted-foreground">
        New workspaces warm up their sending over the first two weeks. About{" "}
        <strong className="text-foreground">{rampRemaining.toLocaleString()}</strong> of these
        go out today, and the campaign picks up again on its own each day until the rest are
        sent.
      </p>
    );
  }
  return null;
}
