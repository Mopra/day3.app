import { redirect } from "next/navigation";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import {
  audienceStatusCounts,
  listAudienceFieldRows,
  listAudienceImports,
  listSegmentRows,
  listSubscriberPage,
  listTopicRows,
} from "@/api/audience-detail";
import { AudienceDetailView, type AudienceTabKey } from "./audience-detail-view";

// Must match the view's page size, so "Load more" continues where this left off.
const FIRST_PAGE = 50;

// Read on the server: the page used to open blank and fire six requests from a
// mount effect. A new audience lands here straight from onboarding's "Import a
// CSV", so this is a first-week page and the first frame should be the real one.
export default async function AudienceDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) redirect("/audiences");
  const [counts, page, imports, fields, segments, topics] = await Promise.all([
    audienceStatusCounts(db, audience.id),
    listSubscriberPage(db, audience.id, [], FIRST_PAGE, 0),
    listAudienceImports(db, audience.id),
    listAudienceFieldRows(db, account.id, audience.id),
    listSegmentRows(db, account.id, audience.id),
    listTopicRows(db, account.id, audience.id),
  ]);
  const initialTab: AudienceTabKey =
    tab === "fields" || tab === "segments" || tab === "topics" ? tab : "contacts";
  return (
    <AudienceDetailView
      key={id}
      initial={{
        audience,
        counts,
        subscribers: page.subscribers,
        total: page.total,
        imports,
        fields,
        segments,
        topics,
        tab: initialTab,
      }}
    />
  );
}
