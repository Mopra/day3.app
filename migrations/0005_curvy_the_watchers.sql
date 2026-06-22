CREATE TABLE "forms" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"audience_id" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"double_opt_in" boolean DEFAULT true NOT NULL,
	"headline" text,
	"description" text,
	"button_label" text DEFAULT 'Subscribe' NOT NULL,
	"success_message" text,
	"redirect_url" text,
	"collect_name" boolean DEFAULT false NOT NULL,
	"accent_color" text,
	"submit_count" integer DEFAULT 0 NOT NULL,
	"confirmed_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "form_id" text;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subscribers" ADD COLUMN "consent_ip" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_forms_account_slug" ON "forms" USING btree ("account_id","slug");--> statement-breakpoint
CREATE INDEX "idx_forms_account_id" ON "forms" USING btree ("account_id");--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_slug_unique" UNIQUE("slug");