import { requireAccount } from "@/api/context";
import { findDomain } from "@/api/finders";
import { DomainDetailView } from "./domain-detail-view";

// Read on the server, so "Set up my domain" lands on the DNS records rather than a
// skeleton. A domain that is not in this workspace renders the view's not-found
// state, which links back to Sending.
export default async function DomainDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const domain = await findDomain(db, account.id, id);
  return <DomainDetailView key={id} initialDomain={domain ?? null} />;
}
