import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import { computeOnboardingState } from "@/services/onboarding";

// Real, server-computed onboarding/send state for the current account. Drives
// the dashboard checklist and the actionable send-blocking messages so the UI
// reflects truth rather than guessing from partial data or a raw error.
export const GET = route(async () => {
  const { db, account } = await requireAccount();
  const onboarding = await computeOnboardingState(db, account);
  return json({ onboarding });
});
