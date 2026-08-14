import { requireAccount } from "@/api/context";
import { listAudiences, listForms } from "@/api/lists";
import { FormsView } from "./forms-view";

// Server-rendered — see the note in ../campaigns/page.tsx. The audience list comes
// along because the "new form" dialog needs somewhere to put the signups.
export default async function FormsPage() {
  const { db, account } = await requireAccount();
  const [forms, audiences] = await Promise.all([
    listForms(db, account.id),
    listAudiences(db, account.id),
  ]);
  return <FormsView initialForms={forms} initialAudiences={audiences} />;
}
