ALTER TABLE "content_reviews" ADD COLUMN "ai_review" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "content_reviews" ADD COLUMN "trust_tier" text;--> statement-breakpoint
CREATE INDEX "idx_content_reviews_account_updated" ON "content_reviews" USING btree ("account_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_transactional_emails_account_status" ON "transactional_emails" USING btree ("account_id","status");--> statement-breakpoint
-- Backfill ai_review from what the AI pass left behind. A failed model call was
-- stored as {"aiError": ...}; any other raw response is a real verdict; rows
-- with no raw response were deterministic-only and keep the 'off' default.
UPDATE "content_reviews" SET "ai_review" = 'failed'
  WHERE "raw_response_json" IS NOT NULL AND "raw_response_json" LIKE '%"aiError"%';--> statement-breakpoint
UPDATE "content_reviews" SET "ai_review" = 'reviewed'
  WHERE "raw_response_json" IS NOT NULL AND "raw_response_json" NOT LIKE '%"aiError"%';
