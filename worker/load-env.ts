// Imported first by worker/index.ts so the worker's env is populated before any
// other module evaluates. On the VPS, real exported env vars always win (dotenv
// never overrides already-set values); .env.worker is the local-dev convenience.
import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.worker" });
loadEnv();
