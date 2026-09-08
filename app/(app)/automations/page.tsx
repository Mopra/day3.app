import { requireAccount } from "@/api/context";
import { listAudiences, listAutomations } from "@/api/lists";
import { AutomationsView } from "./automations-view";

// Server-rendered, see the note in ../campaigns/page.tsx. The audience list rides
// along because the "new automation" dialog needs an audience to watch, and
// because an account with no audience yet needs to be sent to make one first.
export default async function AutomationsPage() {
  const { db, account } = await requireAccount();
  const [automations, audiences] = await Promise.all([
    listAutomations(db, account.id),
    listAudiences(db, account.id),
  ]);
  return <AutomationsView initialAutomations={automations} initialAudiences={audiences} />;
}
