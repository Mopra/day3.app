import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { enforceRateLimit } from "@/lib/rate-limit";
import { enforceAiBudget, recordAiUsage } from "@/lib/ai-budget";
import { aiEnabled, rewriteText } from "@/services/ai";

const RewriteSchema = z.object({
  text: z.string().trim().min(1).max(10_000),
  action: z.enum(["improve", "shorten", "friendly", "professional", "grammar"]),
});

// Returns { text: string } — the rewritten selection.
export const POST = route(async (req) => {
  const { account } = await requireAccount();
  if (!aiEnabled()) throw new HttpError(503, "AI assistance isn't configured.");
  await enforceRateLimit("ai", account.id);
  await enforceAiBudget(account.id);
  const input = await parseJson(req, RewriteSchema);
  try {
    const { text, usage } = await rewriteText(input);
    await recordAiUsage(account.id, usage);
    return json({ text });
  } catch (err) {
    console.error("[ai/rewrite] generation failed", err);
    throw new HttpError(502, "The AI assistant had trouble. Please try again.");
  }
});
