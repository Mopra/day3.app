import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { enforceRateLimit } from "@/lib/rate-limit";
import { MAX_TEST_RECIPIENTS } from "@/services/campaign-send";
import { findAutomationOr404, sendAutomationNodeTest } from "@/services/automations";

const TestEmailSchema = z.object({
  to: z.array(z.email().toLowerCase()).min(1).max(MAX_TEST_RECIPIENTS),
});

// POST /api/automations/{id}/nodes/{nodeKey}/test-email {to}: "send me this
// step". Same limiter, gates and sandbox metering as a campaign test send.
export const POST = route<{ params: Promise<{ id: string; nodeKey: string }> }>(
  async (req, { params }) => {
    const { id, nodeKey } = await params;
    const { db, account } = await requireAccount();
    const body = await parseJson(req, TestEmailSchema);
    const toEmails = [...new Set(body.to)];
    if (toEmails.length === 0) throw new HttpError(400, "Provide at least one recipient");

    // Charged once per recipient, like the campaign test route.
    for (let i = 0; i < toEmails.length; i++) {
      await enforceRateLimit("test_email", account.id);
    }

    const automation = await findAutomationOr404(db, account.id, id);
    const result = await sendAutomationNodeTest(db, account, automation, nodeKey, toEmails);
    return json({ ok: result.failed.length === 0, ...result });
  },
);
