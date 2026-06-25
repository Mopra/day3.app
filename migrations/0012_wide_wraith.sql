ALTER TABLE "forms" ADD COLUMN "fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "attributes" jsonb;--> statement-breakpoint
-- Backfill: forms that collected a first name keep doing so via the new `fields`
-- list (which now drives rendering), so existing forms render unchanged.
UPDATE "forms" SET "fields" = '[{"key":"first_name","label":"First name","type":"text","required":false}]'::jsonb WHERE "collect_name" = true;