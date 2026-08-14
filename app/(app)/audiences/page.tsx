import { requireAccount } from "@/api/context";
import { listAudiences } from "@/api/lists";
import { computeOnboardingState } from "@/services/onboarding";
import { AudiencesView } from "./audiences-view";

// Server-rendered — see the note in ../campaigns/page.tsx for why the read lives
// here rather than in a mount effect.
export default async function AudiencesPage() {
  const { db, account } = await requireAccount();
  const [audiences, onboarding] = await Promise.all([
    listAudiences(db, account.id),
    computeOnboardingState(db, account),
  ]);
  return <AudiencesView initialAudiences={audiences} onboarding={onboarding} />;
}
