import { notFound } from "next/navigation";
import { requireAccount } from "@/api/context";
import { listAudiences, listForms } from "@/api/lists";
import { listSendersWithDomain } from "@/api/senders";
import { getAutomationDetail } from "@/services/automations";
import { parseAutomationTab } from "@/lib/automation-types";
import { AutomationView } from "./automation-view";

// Server-rendered, see the note in ../../campaigns/page.tsx. The audiences,
// senders and forms ride along for the Settings tab, so switching to it costs no
// round trip; the detail itself carries the draft graph the canvas opens on.
export default async function AutomationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  const { db, account } = await requireAccount();
  const [detail, audiences, senders, forms] = await Promise.all([
    getAutomationDetail(db, account.id, id),
    listAudiences(db, account.id),
    listSendersWithDomain(db, account.id),
    listForms(db, account.id),
  ]);
  if (!detail) notFound();
  return (
    <AutomationView
      initialDetail={detail}
      initialTab={parseAutomationTab(Array.isArray(tab) ? tab[0] : tab)}
      audiences={audiences}
      senders={senders}
      forms={forms}
    />
  );
}
