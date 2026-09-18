ALTER TABLE "subscribers" ADD COLUMN "confirmation_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "confirmation_send_count" integer DEFAULT 0 NOT NULL;