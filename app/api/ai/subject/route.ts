import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { enforceRateLimit } from "@/lib/rate-limit";
import { enforceAiBudget, recordAiUsage } from "@/lib/ai-budget";
import { aiEnabled, suggestSubjects } from "@/services/ai";
import { AI_UPGRADE_MESSAGE, planHasAI } from "@/services/plans";

const SubjectSchema = z
  .object({
    brief: z.string().trim().max(2000).optional(),
    subject: z.string().trim().max(200).optional(),
    html: z.string().max(500_000).optional(),
  })
  .refine((v) => Boolean(v.brief || v.subject || v.html), {
    message: "Provide a brief or some content to generate subjects from",
  });

// Returns { subjects: string[] } — 3-5 distinct subject-line options.
export const POST = route(async (req) => {
  const { account } = await requireAccount();
  if (!aiEnabled()) throw new HttpError(503, "AI assistance isn't configured.");
  if (!planHasAI(account.plan)) throw new HttpError(403, AI_UPGRADE_MESSAGE);
  await enforceRateLimit("ai", account.id);
  await enforceAiBudget(account.id);
  const input = await parseJson(req, SubjectSchema);
  try {
    const { subjects, usage } = await suggestSubjects({ ...input, companyName: account.name });
    await recordAiUsage(account.id, usage);
    return json({ subjects });
  } catch (err) {
    console.error("[ai/subject] generation failed", err);
    throw new HttpError(502, "The AI assistant had trouble. Please try again.");
  }
});
