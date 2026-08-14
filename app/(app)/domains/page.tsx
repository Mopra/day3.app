import { requireAccount } from "@/api/context";
import { listDomains } from "@/api/lists";
import { DomainsView } from "./domains-view";

// Server-rendered — see the note in ../campaigns/page.tsx.
export default async function DomainsPage() {
  const { db, account } = await requireAccount();
  return <DomainsView initialDomains={await listDomains(db, account.id)} />;
}
