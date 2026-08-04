-- Widen the SNS event-dedupe key to include the recipient address: one
-- transactional message can have up to 50 recipients and SES emits a separate
-- notification per affected address, all sharing one messageId.
--
-- IF EXISTS / IF NOT EXISTS deliberately: this index was created by migration
-- 0002 but is ABSENT from the live database (verified 2026-08-04), so a bare
-- DROP aborts the whole migration transaction and blocks every later migration.
-- Written to converge whether or not the old index is present.
DROP INDEX IF EXISTS "uq_email_events_provider_message_event";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_email_events_provider_message_event" ON "email_events" USING btree ("provider_message_id","event_type","email");
