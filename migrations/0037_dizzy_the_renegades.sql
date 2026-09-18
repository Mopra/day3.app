ALTER TABLE "accounts" ADD COLUMN "onboarding_path" text;--> statement-breakpoint
ALTER TABLE "audiences" ADD COLUMN "seeded_team" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sending_domains" ADD COLUMN "shared" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sending_domains" ADD COLUMN "shared_disabled_at" timestamp with time zone;