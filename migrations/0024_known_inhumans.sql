-- job_logs had no index but its primary key, while /api/health reads "newest row
-- for this job_type" on every probe (cron's dailyChecksDue marker uses the same
-- shape). IF NOT EXISTS because these were applied to production ahead of this
-- migration, during the 2026-08-04 health-probe incident.
CREATE INDEX IF NOT EXISTS "idx_job_logs_type_created" ON "job_logs" USING btree ("job_type","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_job_logs_status_created" ON "job_logs" USING btree ("status","created_at");
