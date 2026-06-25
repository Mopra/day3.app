import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { newId } from "@/lib/ids";
import { enforceRateLimit } from "@/lib/rate-limit";
import { validateImageUpload, sniffImageType } from "@/lib/image-upload";
import { putCampaignAsset } from "@/lib/supabase-storage";

// Uploads an image for a campaign's image sections. Stores it in the public
// campaign-assets bucket under an account-scoped, unguessable key and returns its
// absolute public URL — the value embedded as <img src> in the email. Available on
// every plan: composing/drafting (images included) is never gated; only *sending*
// is (see plans-catalog.ts). The key is account-scoped, but the bucket is public,
// so the URL is a capability — anyone with the link can fetch the image (as a mail
// client must). The random id makes keys unguessable / non-enumerable.
export const POST = route(async (req) => {
  const { account } = await requireAccount();
  await enforceRateLimit("campaign_asset", account.id);

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    throw new HttpError(400, "Upload an image in the 'file' field");
  }
  // Validate filename/content-type/size before reading the body or touching storage.
  const uploadError = validateImageUpload(file);
  if (uploadError) throw new HttpError(uploadError.status, uploadError.message);

  const bytes = await file.arrayBuffer();
  // The declared content-type is attacker-controlled — confirm the real bytes are a
  // supported image (and derive the extension from them, not the filename).
  const format = sniffImageType(bytes);
  if (!format) {
    throw new HttpError(400, "That file isn't a supported image (PNG, JPEG, GIF, or WebP)");
  }

  const key = `${account.id}/${newId("img")}.${format.ext}`;
  const url = await putCampaignAsset(key, bytes, format.contentType);
  return json({ url }, 201);
});
