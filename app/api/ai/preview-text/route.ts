import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { enforceRateLimit } from "@/lib/rate-limit";
import { enforceAiBudget, recordAiUsage } from "@/lib/ai-budget";
import { aiEnabled, writePreviewText } from "@/services/ai";
import { AI_UPGRADE_MESSAGE, planHasAI } from "@/services/plans";

const PreviewSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  html: z.string().trim().min(1).max(500_000),
});

// Returns { previewText: string } — the inbox preview snippet for the email.
export const POST = route(async (req) => {
  const { account } = await requireAccount();
  if (!aiEnabled()) throw new HttpError(503, "AI assistance isn't configured.");
  if (!planHasAI(account.plan)) throw new HttpError(403, AI_UPGRADE_MESSAGE);
  await enforceRateLimit("ai", account.id);
  await enforceAiBudget(account.id);
  const input = await parseJson(req, PreviewSchema);
  try {
    const { previewText, usage } = await writePreviewText(input);
    await recordAiUsage(account.id, usage);
    return json({ previewText });
  } catch (err) {
    console.error("[ai/preview-text] generation failed", err);
    throw new HttpError(502, "The AI assistant had trouble. Please try again.");
  }
});
