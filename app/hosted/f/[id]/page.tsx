import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { loadPublicFormById } from "@/services/public-form";
import { PublicFormView } from "@/components/public-form-view";

// Stable hosted form page (go.day3.app/f/<id>) — the canonical render, the iframe
// embed target (?embed=1), and the result page the submit/confirm endpoints
// redirect to (?state=...). Public + unauthenticated. The proxy rewrites the
// forms host's /f/<id> here; in dev it's reachable directly at /hosted/f/<id>.
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ state?: string; reason?: string; embed?: string }>;

export default async function HostedFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const { state, reason, embed } = await searchParams;
  const data = await loadPublicFormById(getDb(), id);
  if (!data) notFound();

  const isResultState = !!state && state !== "default";
  const effectiveState = data.form.status !== "active" && !isResultState ? "unavailable" : state;

  return (
    <PublicFormView
      form={data.form}
      companyName={data.companyName}
      state={effectiveState}
      reason={reason}
      embed={embed === "1" || embed === "true"}
    />
  );
}
