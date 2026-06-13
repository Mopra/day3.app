CREATE TABLE `account_users` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`clerk_user_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_account_users_account_user` ON `account_users` (`account_id`,`clerk_user_id`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`clerk_org_id` text NOT NULL,
	`name` text NOT NULL,
	`plan` text DEFAULT 'none' NOT NULL,
	`subscription_status` text DEFAULT 'inactive' NOT NULL,
	`monthly_email_limit` integer DEFAULT 0 NOT NULL,
	`monthly_email_sent_count` integer DEFAULT 0 NOT NULL,
	`current_period_start` text,
	`current_period_end` text,
	`sending_enabled` integer DEFAULT 0 NOT NULL,
	`risk_status` text DEFAULT 'normal' NOT NULL,
	`paused_reason` text,
	`company_address` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_clerk_org_id_unique` ON `accounts` (`clerk_org_id`);--> statement-breakpoint
CREATE INDEX `idx_accounts_clerk_org_id` ON `accounts` (`clerk_org_id`);--> statement-breakpoint
CREATE TABLE `audiences` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audiences_account_id` ON `audiences` (`account_id`);--> statement-breakpoint
CREATE TABLE `campaign_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`account_id` text NOT NULL,
	`subscriber_id` text,
	`email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`locked_at` text,
	`sent_at` text,
	`delivered_at` text,
	`opened_at` text,
	`clicked_at` text,
	`bounced_at` text,
	`complained_at` text,
	`unsubscribed_at` text,
	`provider` text DEFAULT 'cloudflare' NOT NULL,
	`provider_message_id` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_campaign_recipients_campaign_email` ON `campaign_recipients` (`campaign_id`,`email`);--> statement-breakpoint
CREATE INDEX `idx_campaign_recipients_campaign_status` ON `campaign_recipients` (`campaign_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_campaign_recipients_account_status` ON `campaign_recipients` (`account_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_campaign_recipients_provider_message_id` ON `campaign_recipients` (`provider_message_id`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`audience_id` text NOT NULL,
	`sending_domain_id` text NOT NULL,
	`name` text NOT NULL,
	`subject` text NOT NULL,
	`preview_text` text,
	`from_name` text NOT NULL,
	`from_email` text NOT NULL,
	`html_body` text NOT NULL,
	`text_body` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`risk_level` text,
	`risk_score` integer,
	`risk_summary` text,
	`risk_categories_json` text,
	`paused_reason` text,
	`scheduled_at` text,
	`sent_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_campaigns_account_status` ON `campaigns` (`account_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_campaigns_account_created` ON `campaigns` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `email_events` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`campaign_id` text,
	`campaign_recipient_id` text,
	`event_type` text NOT NULL,
	`email` text,
	`provider` text DEFAULT 'cloudflare' NOT NULL,
	`provider_message_id` text,
	`payload_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_email_events_campaign_id` ON `email_events` (`campaign_id`);--> statement-breakpoint
CREATE INDEX `idx_email_events_provider_message_id` ON `email_events` (`provider_message_id`);--> statement-breakpoint
CREATE TABLE `imports` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`audience_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`filename` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`total_rows` integer DEFAULT 0 NOT NULL,
	`imported_rows` integer DEFAULT 0 NOT NULL,
	`skipped_rows` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_imports_account_status` ON `imports` (`account_id`,`status`);--> statement-breakpoint
CREATE TABLE `job_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_type` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`status` text NOT NULL,
	`error` text,
	`payload_json` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `risk_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`risk_level` text NOT NULL,
	`risk_score` integer NOT NULL,
	`categories_json` text NOT NULL,
	`summary` text NOT NULL,
	`recommended_action` text NOT NULL,
	`raw_response_json` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sending_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`domain` text NOT NULL,
	`from_name` text,
	`from_email` text,
	`provider` text DEFAULT 'cloudflare' NOT NULL,
	`provider_identity_id` text,
	`verification_status` text DEFAULT 'pending' NOT NULL,
	`dkim_status` text DEFAULT 'pending' NOT NULL,
	`dns_records_json` text,
	`admin_override_verified` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_sending_domains_account_domain` ON `sending_domains` (`account_id`,`domain`);--> statement-breakpoint
CREATE INDEX `idx_sending_domains_account_id` ON `sending_domains` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_sending_domains_account_status` ON `sending_domains` (`account_id`,`verification_status`);--> statement-breakpoint
CREATE TABLE `subscribers` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`audience_id` text NOT NULL,
	`email` text NOT NULL,
	`first_name` text,
	`last_name` text,
	`status` text DEFAULT 'subscribed' NOT NULL,
	`source` text,
	`imported_at` text,
	`unsubscribed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_subscribers_audience_email` ON `subscribers` (`audience_id`,`email`);--> statement-breakpoint
CREATE INDEX `idx_subscribers_account_audience` ON `subscribers` (`account_id`,`audience_id`);--> statement-breakpoint
CREATE INDEX `idx_subscribers_audience_status` ON `subscribers` (`audience_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_subscribers_email` ON `subscribers` (`email`);--> statement-breakpoint
CREATE TABLE `suppression_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`email` text NOT NULL,
	`scope` text DEFAULT 'account' NOT NULL,
	`reason` text NOT NULL,
	`source` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_suppression_account_email_reason` ON `suppression_entries` (`account_id`,`email`,`reason`);--> statement-breakpoint
CREATE INDEX `idx_suppression_entries_account_email` ON `suppression_entries` (`account_id`,`email`);