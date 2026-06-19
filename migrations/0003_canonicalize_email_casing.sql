-- Backfill: canonicalize stored emails to trimmed + lowercased form so the
-- (audience_id, email) / (campaign_id, email) / (account_id, email, reason)
-- unique indexes behave case-insensitively and suppression lookups match.
--
-- Existing rows may already contain canonical near-duplicates of a mixed-case
-- value (e.g. "Mixed.Case@x.com" alongside "mixed.case@x.com"). Lowercasing in
-- place would violate the unique indexes, so we first delete the losing rows
-- (keep the lexicographically-smallest id per canonical key) and only then
-- rewrite the survivors to their canonical form.

-- subscribers: unique (audience_id, email)
DELETE FROM "subscribers" s
USING "subscribers" keep
WHERE s."audience_id" = keep."audience_id"
  AND lower(btrim(s."email")) = lower(btrim(keep."email"))
  AND s."id" > keep."id";
--> statement-breakpoint
UPDATE "subscribers"
SET "email" = lower(btrim("email"))
WHERE "email" <> lower(btrim("email"));
--> statement-breakpoint

-- campaign_recipients: unique (campaign_id, email)
DELETE FROM "campaign_recipients" r
USING "campaign_recipients" keep
WHERE r."campaign_id" = keep."campaign_id"
  AND lower(btrim(r."email")) = lower(btrim(keep."email"))
  AND r."id" > keep."id";
--> statement-breakpoint
UPDATE "campaign_recipients"
SET "email" = lower(btrim("email"))
WHERE "email" <> lower(btrim("email"));
--> statement-breakpoint

-- suppression_entries: unique (account_id, email, reason). NULL account_id is a
-- distinct key in Postgres, so the dedupe pairs only same-account (or both-NULL
-- via IS NOT DISTINCT FROM) rows.
DELETE FROM "suppression_entries" e
USING "suppression_entries" keep
WHERE e."account_id" IS NOT DISTINCT FROM keep."account_id"
  AND e."reason" = keep."reason"
  AND lower(btrim(e."email")) = lower(btrim(keep."email"))
  AND e."id" > keep."id";
--> statement-breakpoint
UPDATE "suppression_entries"
SET "email" = lower(btrim("email"))
WHERE "email" <> lower(btrim("email"));
