import { requireAccount } from "@/api/context";
import { listDomains } from "@/api/lists";
import { listSendersWithDomain } from "@/api/senders";
import { SendersView } from "./senders-view";

// Server-rendered — see the note in ../campaigns/page.tsx. Both reads go out
// together; the page needs the domain list to know which senders can actually send.
export default async function SendersPage() {
  const { db, account } = await requireAccount();
  const [senders, domains] = await Promise.all([
    listSendersWithDomain(db, account.id),
    listDomains(db, account.id),
  ]);
  return <SendersView initialSenders={senders} initialDomains={domains} />;
}
