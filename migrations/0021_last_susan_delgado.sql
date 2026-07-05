CREATE TABLE "segments" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"audience_id" text NOT NULL,
	"name" text NOT NULL,
	"filter_json" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topic_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"topic_id" text NOT NULL,
	"subscriber_id" text NOT NULL,
	"subscribed" boolean NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "topics" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"audience_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_subscribed" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "segment_id" text;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "topic_id" text;--> statement-breakpoint
CREATE INDEX "idx_segments_account_audience" ON "segments" USING btree ("account_id","audience_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_topic_subscriptions_topic_subscriber" ON "topic_subscriptions" USING btree ("topic_id","subscriber_id");--> statement-breakpoint
CREATE INDEX "idx_topic_subscriptions_subscriber" ON "topic_subscriptions" USING btree ("subscriber_id");--> statement-breakpoint
CREATE INDEX "idx_topics_account_audience" ON "topics" USING btree ("account_id","audience_id");