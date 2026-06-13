// App-owned Env declaration. Runtime types (D1Database, R2Bucket, Queue,
// Fetcher, ...) come from the generated worker-configuration.d.ts
// (`npm run cf-typegen`). Bindings must match wrangler.jsonc; secrets are
// provided via .dev.vars locally and `wrangler secret put` in production.
interface Env {
  // Bindings
  DB: D1Database;
  IMPORTS_BUCKET: R2Bucket;
  JOBS_QUEUE: Queue<import("./queue/messages").QueueMessage>;
  ASSETS: Fetcher;
  EMAIL?: import("./email/cloudflare").CloudflareEmailBinding;

  // Vars (wrangler.jsonc)
  APP_URL: string;
  AI_REVIEW_MODE?: string;
  EMAIL_PROVIDER?: string;

  // Secrets (.dev.vars / wrangler secret)
  CLERK_PUBLISHABLE_KEY: string;
  CLERK_SECRET_KEY: string;
  CLERK_WEBHOOK_SIGNING_SECRET?: string;
  UNSUBSCRIBE_SECRET: string;
  ADMIN_EMAILS?: string;
  CF_EMAIL_WEBHOOK_SECRET?: string;
}
