ALTER TABLE "imports" ADD COLUMN "invalid_rows" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "suppressed_rows" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "duplicate_rows" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "over_cap_rows" integer DEFAULT 0 NOT NULL;