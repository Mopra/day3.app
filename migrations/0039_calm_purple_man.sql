CREATE TABLE "blocked_domains" (
	"domain" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"source_account_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sending_domains" ADD COLUMN "blocked_at" timestamp with time zone;