import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import { readAiBudget } from "@/lib/ai-budget";
import { aiEnabled } from "@/services/ai";
import { aiAllowanceForPlan, planHasAI } from "@/services/plans";

// Lets the composer decide what AI affordance to show:
//   - `configured` false → OpenRouter isn't set up; hide AI entirely.
//   - `planAi` false → AI exists but the account's tier doesn't include it (only
//     the free tier now); show an "unlock AI" button instead of the AI controls.
//   - otherwise → show the AI controls, plus the budget meter (disabled when the
//     window/monthly budget is spent). The meter's size is the plan's allowance,
//     so a starter tier sees a smaller — but real — meter.
// `enabled` stays true only when AI is both configured AND available on the plan,
// so existing `enabled` checks keep working. Re-fetched after each AI action.
export const GET = route(async () => {
  const { account } = await requireAccount();
  const configured = aiEnabled();
  const planAi = planHasAI(account.plan);
  const enabled = configured && planAi;
  const budget = enabled ? await readAiBudget(account.id, aiAllowanceForPlan(account.plan)) : null;
  return json({ enabled, configured, planAi, budget });
});
