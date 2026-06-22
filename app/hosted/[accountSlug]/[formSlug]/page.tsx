import { notFound } from "next/navigation";
import { getDb } from "@/db/client";
import { loadPublicFormBySlugs } from "@/services/public-form";
import { PublicFormView } from "@/components/public-form-view";

// Pretty share URL (go.day3.app/<account-slug>/<form-slug>). Renders the same
// form as the stable /f/<id> page; this URL is for humans (bios, social, email),
// while embeds use the rename-proof id URL. The proxy rewrites the forms host's
// /<a>/<b> here.
export const dynamic = "force-dynamic";

type SearchParams = Promise<{ state?: string; reason?: string; embed?: string }>;

export default async function PrettyFormPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountSlug: string; formSlug: string }>;
  searchParams: SearchParams;
}) {
  const { accountSlug, formSlug } = await params;
  const { state, reason, embed } = await searchParams;
  const data = await loadPublicFormBySlugs(getDb(), accountSlug, formSlug);
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
