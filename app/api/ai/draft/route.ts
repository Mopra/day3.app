import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { enforceRateLimit } from "@/lib/rate-limit";
import { enforceAiBudget, recordAiUsage } from "@/lib/ai-budget";
import { aiEnabled, draftEmail } from "@/services/ai";
import { AI_UPGRADE_MESSAGE, aiAllowanceForPlan, planHasAI } from "@/services/plans";

const DraftSchema = z.object({
  brief: z.string().trim().min(1, "Tell the assistant what the email is about").max(2000),
  tone: z.string().trim().max(100).optional(),
  audienceName: z.string().trim().max(150).optional(),
  fromName: z.string().trim().max(100).optional(),
});

// Drafts subject + preview text + body HTML from a one-line brief. companyName is
// taken from the server-resolved account, never the client.
export const POST = route(async (req) => {
  const { account } = await requireAccount();
  if (!aiEnabled()) throw new HttpError(503, "AI assistance isn't configured.");
  if (!planHasAI(account.plan)) throw new HttpError(403, AI_UPGRADE_MESSAGE);
  const allowance = aiAllowanceForPlan(account.plan);
  await enforceRateLimit("ai", account.id);
  await enforceAiBudget(account.id, allowance);
  const input = await parseJson(req, DraftSchema);
  try {
    const { usage, ...draft } = await draftEmail({
      brief: input.brief,
      tone: input.tone,
      audienceName: input.audienceName,
      fromName: input.fromName,
      companyName: account.name,
    });
    await recordAiUsage(account.id, usage, allowance);
    return json(draft);
  } catch (err) {
    console.error("[ai/draft] generation failed", err);
    throw new HttpError(502, "The AI assistant had trouble drafting. Please try again.");
  }
});
