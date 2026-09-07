CREATE TABLE "automation_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"automation_version_id" text NOT NULL,
	"from_node_key" text NOT NULL,
	"port" text NOT NULL,
	"to_node_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_enrollments" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"automation_id" text NOT NULL,
	"automation_version_id" text NOT NULL,
	"subscriber_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reentry_mode" text DEFAULT 'once' NOT NULL,
	"current_node_key" text,
	"next_run_at" timestamp with time zone,
	"locked_at" timestamp with time zone,
	"visit_count" integer DEFAULT 0 NOT NULL,
	"send_count" integer DEFAULT 0 NOT NULL,
	"sandbox" boolean DEFAULT false NOT NULL,
	"hold_reason" text,
	"held_since" timestamp with time zone,
	"entered_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"exited_at" timestamp with time zone,
	"exit_reason" text,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_nodes" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"automation_version_id" text NOT NULL,
	"key" text NOT NULL,
	"kind" text NOT NULL,
	"config_json" text DEFAULT '{}' NOT NULL,
	"label" text,
	"canvas_x" integer DEFAULT 0 NOT NULL,
	"canvas_y" integer DEFAULT 0 NOT NULL,
	"risk_level" text,
	"risk_summary" text,
	"risk_guidance_json" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"automation_id" text NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"audience_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"trigger_kind" text NOT NULL,
	"trigger_segment_id" text,
	"trigger_topic_id" text,
	"trigger_form_id" text,
	"entry_filter_json" text,
	"exit_filter_json" text,
	"reentry" text DEFAULT 'once' NOT NULL,
	"sender_id" text,
	"sending_domain_id" text,
	"from_name" text,
	"from_email" text,
	"reply_to" text,
	"theme_json" text,
	"footer_text" text,
	"topic_id" text,
	"send_window_json" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"sandbox" boolean DEFAULT false NOT NULL,
	"live_version_id" text,
	"draft_version_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaign_recipients" ALTER COLUMN "campaign_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD COLUMN "automation_id" text;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD COLUMN "automation_enrollment_id" text;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD COLUMN "automation_node_key" text;--> statement-breakpoint
ALTER TABLE "campaign_recipients" ADD COLUMN "visit_no" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN "automation_id" text;--> statement-breakpoint
ALTER TABLE "email_events" ADD COLUMN "automation_node_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_automation_edges_version_from_port" ON "automation_edges" USING btree ("automation_version_id","from_node_key","port");--> statement-breakpoint
CREATE INDEX "idx_automation_edges_version" ON "automation_edges" USING btree ("automation_version_id");--> statement-breakpoint
CREATE INDEX "idx_automation_enrollments_due" ON "automation_enrollments" USING btree ("account_id","next_run_at") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_automation_enrollments_next_run" ON "automation_enrollments" USING btree ("next_run_at") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "idx_automation_enrollments_locked" ON "automation_enrollments" USING btree ("locked_at") WHERE status = 'sending';--> statement-breakpoint
CREATE INDEX "idx_automation_enrollments_automation_status" ON "automation_enrollments" USING btree ("automation_id","status");--> statement-breakpoint
CREATE INDEX "idx_automation_enrollments_subscriber" ON "automation_enrollments" USING btree ("subscriber_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_automation_enrollments_once" ON "automation_enrollments" USING btree ("automation_id","subscriber_id") WHERE reentry_mode = 'once';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_automation_enrollments_one_at_a_time" ON "automation_enrollments" USING btree ("automation_id","subscriber_id") WHERE reentry_mode = 'once_at_a_time' and status in ('active', 'sending');--> statement-breakpoint
CREATE UNIQUE INDEX "uq_automation_nodes_version_key" ON "automation_nodes" USING btree ("automation_version_id","key");--> statement-breakpoint
CREATE INDEX "idx_automation_nodes_account" ON "automation_nodes" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_automation_versions_automation_version" ON "automation_versions" USING btree ("automation_id","version");--> statement-breakpoint
CREATE INDEX "idx_automation_versions_account" ON "automation_versions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "idx_automations_account_status" ON "automations" USING btree ("account_id","status");--> statement-breakpoint
CREATE INDEX "idx_automations_account_audience" ON "automations" USING btree ("account_id","audience_id");--> statement-breakpoint
CREATE INDEX "idx_automations_audience_trigger" ON "automations" USING btree ("audience_id","trigger_kind","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_campaign_recipients_enrollment_node" ON "campaign_recipients" USING btree ("automation_enrollment_id","automation_node_key","visit_no") WHERE automation_enrollment_id is not null;--> statement-breakpoint
CREATE INDEX "idx_campaign_recipients_automation_node" ON "campaign_recipients" USING btree ("automation_id","automation_node_key");--> statement-breakpoint
CREATE INDEX "idx_campaign_recipients_automation_status" ON "campaign_recipients" USING btree ("automation_id","status");--> statement-breakpoint
CREATE INDEX "idx_email_events_automation_created" ON "email_events" USING btree ("automation_id","created_at");