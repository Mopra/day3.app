CREATE TABLE "content_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"risk_level" text NOT NULL,
	"risk_score" integer NOT NULL,
	"categories_json" text NOT NULL,
	"summary" text NOT NULL,
	"guidance_json" text,
	"raw_response_json" text,
	"subject" text NOT NULL,
	"from_email" text NOT NULL,
	"from_name" text,
	"blocked_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "daily_sent_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "daily_sent_date" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "ramp_lifted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_content_reviews_account_fingerprint" ON "content_reviews" USING btree ("account_id","fingerprint");--> statement-breakpoint
CREATE INDEX "idx_content_reviews_account_created" ON "content_reviews" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_content_reviews_level_created" ON "content_reviews" USING btree ("risk_level","created_at");