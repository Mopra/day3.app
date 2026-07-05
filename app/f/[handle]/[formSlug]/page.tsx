import { notFound } from "next/navigation";
import { loadPublicFormBySlugs } from "@/services/public-form";
import { PublicFormView } from "@/components/public-form-view";

// Pretty share URL: /f/<account-slug>/<form-slug> (go.day3.app/f/acme/newsletter).
// Renders the same form as the stable /f/<id> page; this URL is for humans (bios,
// social, email), while embeds use the rename-proof id URL.
//
// The first dynamic segment is [handle] to match the sibling /f/[handle] route
// (Next requires a shared name at the same level); here `handle` is the account
// slug. Reading searchParams keeps this dynamic without force-dynamic.

type SearchParams = Promise<{ state?: string; reason?: string; embed?: string }>;

export default async function PrettyFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string; formSlug: string }>;
  searchParams: SearchParams;
}) {
  const { handle, formSlug } = await params;
  const { state, reason, embed } = await searchParams;
  const data = await loadPublicFormBySlugs(handle, formSlug);
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
