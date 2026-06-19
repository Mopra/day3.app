ALTER TABLE "sending_domains" ADD COLUMN "mail_from_domain" text;--> statement-breakpoint
ALTER TABLE "sending_domains" ADD COLUMN "mail_from_status" text DEFAULT 'pending' NOT NULL;
