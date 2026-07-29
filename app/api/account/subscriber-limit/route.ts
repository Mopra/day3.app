import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import { maxSubscribersForPlan } from "@/lib/plans-catalog";
import { countAccountSubscribers } from "@/services/subscriber-limit";

// GET /api/account/subscriber-limit — how much subscriber headroom the account
// has left, for surfaces that need to warn *before* a bulk write rather than
// let it fail at the cap (the API keys page, ahead of an API migration).
//
// Deliberately its own endpoint rather than a field on /api/account: the app
// shell fetches that on every navigation for the plan pill, and this needs a
// count(*) over subscribers. Paid tiers are uncapped, so the count is skipped
// entirely for them.
export const GET = route(async () => {
  const { db, account } = await requireAccount();
  const cap = maxSubscribersForPlan(account.plan);

  if (cap === null) {
    return json({ plan: account.plan, cap: null, used: null, headroom: null });
  }

  // Counts every stored row, all statuses, across all audiences — the cap is
  // about stored rows, so this is the same number the write path enforces.
  const used = await countAccountSubscribers(db, account.id);
  return json({
    plan: account.plan,
    cap,
    used,
    headroom: Math.max(0, cap - used),
  });
});
