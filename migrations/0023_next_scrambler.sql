CREATE TABLE "transactional_emails" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"api_key_id" text,
	"from_email" text NOT NULL,
	"from_name" text,
	"reply_to" text,
	"to" jsonb NOT NULL,
	"subject" text NOT NULL,
	"html_body" text,
	"text_body" text,
	"headers" jsonb,
	"tags" jsonb,
	"sandbox" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"provider" text,
	"provider_message_id" text,
	"locked_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"bounced_at" timestamp with time zone,
	"complained_at" timestamp with time zone,
	"body_pruned_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN "transactional_email_id" text;--> statement-breakpoint
CREATE INDEX "idx_transactional_emails_account_created" ON "transactional_emails" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_transactional_emails_provider_message_id" ON "transactional_emails" USING btree ("provider_message_id");--> statement-breakpoint
CREATE INDEX "idx_transactional_emails_status" ON "transactional_emails" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_email_events_transactional_email_id" ON "email_events" USING btree ("transactional_email_id");