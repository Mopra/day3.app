CREATE TABLE "senders" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"sending_domain_id" text NOT NULL,
	"from_name" text NOT NULL,
	"from_email" text NOT NULL,
	"reply_to" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "sender_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_senders_account_email" ON "senders" USING btree ("account_id","from_email");--> statement-breakpoint
CREATE INDEX "idx_senders_account_id" ON "senders" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_senders_domain_id" ON "senders" USING btree ("sending_domain_id");--> statement-breakpoint
-- Backfill: every existing domain with a From identity becomes a default sender,
-- so accounts keep working without re-entering their From details.
INSERT INTO "senders"
	(id, account_id, sending_domain_id, from_name, from_email, is_default, created_at, updated_at)
SELECT 'snd_' || replace(gen_random_uuid()::text, '-', ''),
	account_id, id, from_name, from_email, true, created_at, updated_at
FROM "sending_domains"
WHERE from_name IS NOT NULL AND from_email IS NOT NULL
ON CONFLICT DO NOTHING;