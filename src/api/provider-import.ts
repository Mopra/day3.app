import { z } from "zod";
import { HttpError } from "@/api/http";
import { ImportProviderError, isProviderId, type ProviderId } from "@/importers";
import type { ProviderContext } from "@/importers/types";

// Shared by the two web routes of "Import from another provider". The web tier
// talks to the provider only to check the key and list what can be imported; the
// import itself runs on the worker.

// A user is waiting on a dialog: one retry, and never a long sleep. A key that is
// rate limited right now fails with the provider's rate-limit message instead.
export const WEB_PROVIDER_CTX: Omit<ProviderContext, "apiKey"> = { maxAttempts: 2, maxWaitMs: 3000 };

export const apiKeySchema = z
  .string()
  .trim()
  .min(8, "Paste the full API key")
  .max(500, "That does not look like an API key")
  // Keys are opaque tokens; whitespace or control characters mean a bad paste,
  // and must never reach a request header.
  .regex(/^[\x21-\x7e]+$/, "That does not look like an API key");

export function parseProvider(value: string): ProviderId {
  if (!isProviderId(value)) throw new HttpError(404, "Unknown provider");
  return value;
}

// An ImportProviderError becomes a JSON error with a `code`, so the dialog can
// tell "wrong key" from "your plan has no API access" and offer the CSV route.
export function providerErrorResponse(err: unknown): Response {
  if (!(err instanceof ImportProviderError)) throw err;
  const status =
    err.code === "rate_limited" ? 429 : err.code === "upstream" ? 502 : 422;
  return Response.json({ error: err.message, code: err.code }, { status });
}
