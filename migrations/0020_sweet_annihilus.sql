CREATE TABLE "audience_fields" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"audience_id" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"type" text DEFAULT 'text' NOT NULL,
	"fallback" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_audience_fields_audience_key" ON "audience_fields" USING btree ("audience_id","key");--> statement-breakpoint
CREATE INDEX "idx_audience_fields_account_audience" ON "audience_fields" USING btree ("account_id","audience_id");