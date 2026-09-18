import { notFound } from "next/navigation";
import { requireAccount } from "@/api/context";
import { listForms } from "@/api/lists";
import { listSendersWithDomain } from "@/api/senders";
import { getAutomationDetail } from "@/services/automations";
import { parseAutomationTab } from "@/lib/automation-types";
import { planSandboxMode } from "@/lib/plans-catalog";
import { AutomationView } from "./automation-view";

// Server-rendered, see the note in ../../campaigns/page.tsx. The senders ride
// along for the Settings tab and the signup forms for the trigger node, so
// neither costs a round trip when it is opened; the detail itself carries the
// draft graph the canvas opens on. The account's name and mailing address ride
// along too: both are printed in every email this automation sends, so the
// Settings tab previews the footer with the real values.
export default async function AutomationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
}) {
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  const { db, account } = await requireAccount();
  const [detail, senders, forms] = await Promise.all([
    getAutomationDetail(db, account.id, id),
    listSendersWithDomain(db, account.id),
    listForms(db, account.id),
  ]);
  if (!detail) notFound();
  return (
    <AutomationView
      initialDetail={detail}
      initialTab={parseAutomationTab(Array.isArray(tab) ? tab[0] : tab)}
      senders={senders}
      forms={forms}
      companyName={account.name}
      companyAddress={account.companyAddress}
      planSandbox={planSandboxMode(account.plan)}
    />
  );
}
