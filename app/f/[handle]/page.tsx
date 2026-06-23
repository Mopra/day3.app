import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { loadPublicFormById } from "@/services/public-form";
import { PublicFormView } from "@/components/public-form-view";

// Stable hosted form page at /f/<id> (go.day3.app/f/<id>) — the canonical render,
// the iframe embed target (?embed=1), and the result page the submit/confirm
// endpoints redirect to (?state=...). Public + unauthenticated (see proxy.ts).
// The id URL is rename-proof, so it's what embeds use.
//
// The dynamic segment is named [handle] (not [id]) so it can coexist with the
// sibling pretty route /f/[handle]/[formSlug] — Next requires the first dynamic
// segment to share a name across routes at the same level. Here `handle` is the
// form id.
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ state?: string; reason?: string; embed?: string }>;

export default async function HostedFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: SearchParams;
}) {
  const { handle } = await params;
  const { state, reason, embed } = await searchParams;
  const data = await loadPublicFormById(getDb(), handle);
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
