ALTER TABLE "imports" ADD COLUMN "unsubscribed_rows" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "source" text DEFAULT 'csv' NOT NULL;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "source_credential" text;--> statement-breakpoint
ALTER TABLE "imports" ADD COLUMN "source_cursor" text;