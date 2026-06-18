CREATE TABLE "dns_integrations" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider" text DEFAULT 'cloudflare' NOT NULL,
	"access_token_enc" text NOT NULL,
	"refresh_token_enc" text NOT NULL,
	"expires_at" timestamp with time zone,
	"scope" text,
	"cf_account_label" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sending_domains" ADD COLUMN "dns_zone_id" text;--> statement-breakpoint
ALTER TABLE "sending_domains" ADD COLUMN "dns_auto_configured" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sending_domains" ADD COLUMN "dns_write_error" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dns_integrations_account_provider" ON "dns_integrations" USING btree ("account_id","provider");--> statement-breakpoint
CREATE INDEX "idx_dns_integrations_account_id" ON "dns_integrations" USING btree ("account_id");