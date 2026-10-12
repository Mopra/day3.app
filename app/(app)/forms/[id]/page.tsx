import { redirect } from "next/navigation";
import { requireAccount } from "@/api/context";
import { findForm } from "@/api/finders";
import { readFormDetail } from "@/api/form-detail";
import { FormDetailView } from "./form-detail-view";

// Read on the server, so a new form opens straight into its editor instead of a
// skeleton. GET /api/forms/[id] shares readFormDetail for the post-save refresh.
export default async function FormDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const form = await findForm(db, account.id, id);
  if (!form) redirect("/forms");
  return <FormDetailView key={id} initial={await readFormDetail(db, account, form)} />;
}
