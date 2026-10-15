import { z } from "zod";
import { route, json, parseJson } from "@/api/http";
import { requireAccount } from "@/api/context";
import { enforceRateLimit } from "@/lib/rate-limit";
import { getImportProvider } from "@/importers";
import {
  WEB_PROVIDER_CTX,
  apiKeySchema,
  parseProvider,
  providerErrorResponse,
} from "@/api/provider-import";

const bodySchema = z.object({ apiKey: apiKeySchema });

// Check a pasted provider API key and list what it can import (beehiiv
// publications, Mailchimp audiences, ...). The key is used for this one request
// and not stored; the import route receives it again when the user starts.
export const POST = route<{ params: Promise<{ provider: string }> }>(async (req, { params }) => {
  const provider = parseProvider((await params).provider);
  const { account } = await requireAccount();
  await enforceRateLimit("import", account.id);
  const { apiKey } = await parseJson(req, bodySchema);
  try {
    const sources = await getImportProvider(provider).listSources({ ...WEB_PROVIDER_CTX, apiKey });
    return json({ sources });
  } catch (err) {
    return providerErrorResponse(err);
  }
});
