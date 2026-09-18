ALTER TABLE "campaigns" ADD COLUMN "reputation_flagged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "deleted_at" timestamp with time zone;