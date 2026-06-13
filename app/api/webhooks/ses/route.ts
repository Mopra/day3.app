import type { NextRequest } from "next/server";

// SES/SNS bounce + complaint ingestion. Wired in Phase 5: verify the SNS
// message signature (against the AWS signing cert), handle SubscriptionConfirmation
// vs Notification, then apply the same DB effects the old cloudflare-email webhook
// did — update recipient/subscriber status, add a suppression entry, and recompute
// account health (see the reference handler in git 0356371:src/worker/api/webhooks.ts).
export async function POST(_req: NextRequest) {
  return new Response("SES/SNS webhook not yet wired (Phase 5)", { status: 501 });
}
