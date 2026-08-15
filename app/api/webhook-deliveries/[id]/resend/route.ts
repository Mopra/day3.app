import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { serializeDelivery } from "@/api/webhook-serialize";
import { requireOrgAdmin } from "../../../webhook-endpoints/route";
import { resendDelivery } from "@/services/webhooks";
import { enqueueBestEffort } from "@/queue/enqueue";

type Ctx = { params: Promise<{ id: string }> };

// POST /api/webhook-deliveries/[id]/resend — re-attempt a finished delivery.
// The stored payload is re-sent verbatim, so the receiver sees the original
// event with a signature that still verifies over the original body (only the
// timestamp and signature headers are new).
//
// This is the manual counterpart to the retry schedule: after six attempts over
// ~7 hours a delivery is terminal, and the fix ("our endpoint was misconfigured,
// we've deployed") is something only a human knows about.
export const POST = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const ctx = await requireAccount();
  requireOrgAdmin(ctx);

  const delivery = await resendDelivery(ctx.db, ctx.account.id, id);
  // Absent, or still in flight — resendDelivery only matches terminal rows, so
  // a pending/delivering row lands here rather than racing the attempt running.
  if (!delivery) throw new HttpError(404, "No finished delivery with that id");

  await enqueueBestEffort({
    type: "deliver_webhook",
    deliveryId: delivery.id,
    accountId: ctx.account.id,
  });
  return json({ delivery: serializeDelivery(delivery) });
});
