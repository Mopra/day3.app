import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import { readAiBudget } from "@/lib/ai-budget";
import { aiEnabled } from "@/services/ai";

// Lets the composer hide the AI affordances entirely when OpenRouter isn't
// configured (so users never see a button that only errors), and carries the
// per-org AI budget snapshot so the composer can show the usage meter and
// disable AI when the window/monthly budget is spent. Re-fetched after each AI
// action to keep the meter live.
export const GET = route(async () => {
  const { account } = await requireAccount();
  const enabled = aiEnabled();
  const budget = enabled ? await readAiBudget(account.id) : null;
  return json({ enabled, budget });
});
