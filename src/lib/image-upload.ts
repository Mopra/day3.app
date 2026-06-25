// Validation for campaign image uploads. Pure (no I/O) so the rules are unit-
// tested and shared, mirroring lib/csv.ts. The route does edge validation
// (validateImageUpload) before touching storage, then confirms the bytes really
// are an image of the claimed kind (sniffImageType) — a declared content-type is
// attacker-controlled, so the magic-byte check is the authoritative one.

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// The raster formats every mail client renders. SVG is deliberately excluded: it
// can carry script/foreignObject and is widely blocked by mail clients anyway.
export type ImageFormat = { ext: "png" | "jpg" | "gif" | "webp"; contentType: string };

const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export type ImageUploadError = { status: 400 | 413; message: string };

// Edge validation for an uploaded image File, before it is read or stored. Returns
// an error object on rejection, or null when the upload looks acceptable (the
// byte-level format check happens separately via sniffImageType).
export function validateImageUpload(file: { name: string; size: number; type: string }): ImageUploadError | null {
  const name = (file.name ?? "").trim();
  if (!name) {
    return { status: 400, message: "The uploaded file is missing a filename" };
  }
  const contentType = (file.type ?? "").split(";")[0].trim().toLowerCase();
  if (contentType && !ALLOWED_IMAGE_CONTENT_TYPES.has(contentType)) {
    return { status: 400, message: "Image must be a PNG, JPEG, GIF, or WebP" };
  }
  if (file.size <= 0) {
    return { status: 400, message: "The uploaded file is empty" };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { status: 413, message: "Image too large (max 5 MB)" };
  }
  return null;
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((b, i) => bytes[offset + i] === b);
}

// Identifies the real image format from the file's leading bytes, returning the
// canonical extension + content-type, or null if the bytes are not a supported
// image. This is what guards against a renamed/relabeled file (e.g. a script sent
// as image/png) reaching the public bucket.
export function sniffImageType(buffer: ArrayBuffer): ImageFormat | null {
  const bytes = new Uint8Array(buffer);
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { ext: "png", contentType: "image/png" };
  }
  // JPEG: FF D8 FF
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    return { ext: "jpg", contentType: "image/jpeg" };
  }
  // GIF: "GIF87a" / "GIF89a"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return { ext: "gif", contentType: "image/gif" };
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    return { ext: "webp", contentType: "image/webp" };
  }
  return null;
}
