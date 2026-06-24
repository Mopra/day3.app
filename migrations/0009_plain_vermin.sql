ALTER TABLE "accounts" ALTER COLUMN "plan" SET DEFAULT 'free_org';--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "subscription_status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "monthly_email_limit" SET DEFAULT 500;--> statement-breakpoint
ALTER TABLE "accounts" ALTER COLUMN "sending_enabled" SET DEFAULT true;--> statement-breakpoint
-- Migrate existing rows into the bandwidth pricing model.
-- The old single paid plan "tiny" (10k/mo) maps to the new "10k_plan" (same limit).
UPDATE "accounts" SET "plan" = '10k_plan' WHERE "plan" = 'tiny';--> statement-breakpoint
-- The old "none" tier (limit 0, sending disabled — before or after a subscription)
-- becomes the always-active free tier: full set-up + drafts, but no sending and a
-- 0 send allowance until the org subscribes to a paid plan.
UPDATE "accounts"
SET "plan" = 'free_org',
    "subscription_status" = 'active',
    "monthly_email_limit" = 0,
    "sending_enabled" = false
WHERE "plan" = 'none';