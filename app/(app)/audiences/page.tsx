import { requireAccount } from "@/api/context";
import { listAudiences } from "@/api/lists";
import { AudiencesView } from "./audiences-view";

// Server-rendered. See the note in ../campaigns/page.tsx for why the read lives
// here rather than in a mount effect.
export default async function AudiencesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const { db, account } = await requireAccount();
  const audiences = await listAudiences(db, account.id);
  return (
    <AudiencesView
      initialAudiences={audiences}
      initialTab={tab === "suppressions" ? "suppressions" : "audiences"}
    />
  );
}
