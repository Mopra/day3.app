import { requireAccount } from "@/api/context";
import { listDomains } from "@/api/lists";
import { listSendersWithDomain } from "@/api/senders";
import { SendingView } from "./sending-view";

// Server-rendered — see the note in ../campaigns/page.tsx. Domains and senders
// are one setup job (a sender is an address on a verified domain), so they share
// a page; both reads go out together and the view switches between them.
export default async function SendingPage() {
  const { db, account } = await requireAccount();
  const [domains, senders] = await Promise.all([
    listDomains(db, account.id),
    listSendersWithDomain(db, account.id),
  ]);
  return <SendingView initialDomains={domains} initialSenders={senders} />;
}
