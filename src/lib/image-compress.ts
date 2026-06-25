// Client-side image preparation for campaign uploads. Oversized photos hurt email
// deliverability and load time, so before an image is uploaded we downscale it to a
// sane maximum edge and re-encode it: photos to JPEG (far smaller), anything with
// real transparency (logos on a transparent background) to PNG so we never bake a
// black/white box behind it. The pure helpers (targetDimensions / chooseEmailEncoding)
// hold the rules and are unit-tested; the DOM glue (compressImageForEmail,
// canvasHasTransparency) uses <canvas> and only runs in the browser.

// Email bodies render at ~600px; cap the longest edge at 1600 so a 2x/retina image
// still looks crisp while a phone-camera 4000px upload gets shrunk an order of
// magnitude. Never upscale below this.
export const MAX_EMAIL_IMAGE_EDGE = 1600;

// JPEG quality for photographic content. 0.82 is visually lossless for email at the
// sizes we render while cutting file size dramatically vs. PNG or quality 1.0.
export const EMAIL_JPEG_QUALITY = 0.82;

export type EmailEncoding =
  | { type: "image/png" }
  | { type: "image/jpeg"; quality: number };

// Pure: fit (width × height) within maxEdge on its longest side without upscaling.
// Returns whole-pixel dimensions.
export function targetDimensions(
  width: number,
  height: number,
  maxEdge = MAX_EMAIL_IMAGE_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

// Pure: pick the email-safe output encoding. Transparency must stay PNG (JPEG has no
// alpha channel and would flatten it onto a solid color); everything else becomes a
// quality-tuned JPEG.
export function chooseEmailEncoding(hasAlpha: boolean): EmailEncoding {
  if (hasAlpha) return { type: "image/png" };
  return { type: "image/jpeg", quality: EMAIL_JPEG_QUALITY };
}

// The file extension that matches an encoding's content-type. The server re-derives
// the real extension from the sniffed bytes, but the File still needs a sensible name.
export function extForEncoding(encoding: EmailEncoding): "png" | "jpg" {
  return encoding.type === "image/png" ? "png" : "jpg";
}

function renameWithExt(name: string, ext: string): string {
  const base = (name ?? "").replace(/\.[^./\\]+$/, "").trim();
  return `${base || "image"}.${ext}`;
}

// Whether any pixel in the drawn canvas is non-opaque. Early-exits on the first
// transparent pixel. Throws only if the canvas is tainted (cross-origin) — our
// sources (local File / CORS-enabled Supabase objects) are not, so callers can let it
// propagate to their fallback.
export function canvasHasTransparency(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): boolean {
  const { data } = ctx.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

// Downscale + re-encode an uploaded image so the resulting email stays light. Returns
// the original file unchanged when it can't help or shouldn't touch it:
//   - animated GIFs (a canvas redraw would flatten them to one frame)
//   - environments without <canvas>/createImageBitmap
//   - already-small images where re-encoding wouldn't save bytes
// Callers should still wrap this in a catch and fall back to the original file.
export async function compressImageForEmail(file: File): Promise<File> {
  if (file.type === "image/gif") return file;
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") {
    return file;
  }

  const bitmap = await createImageBitmap(file);
  try {
    const { width, height } = targetDimensions(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);

    const encoding = chooseEmailEncoding(canvasHasTransparency(ctx, width, height));
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(
        resolve,
        encoding.type,
        encoding.type === "image/jpeg" ? encoding.quality : undefined,
      ),
    );
    if (!blob) return file;

    // If we neither shrank the dimensions nor saved bytes, the original is already
    // well-optimized — keep it rather than throwing away quality for nothing.
    const downscaled = width !== bitmap.width || height !== bitmap.height;
    if (!downscaled && blob.size >= file.size) return file;

    return new File([blob], renameWithExt(file.name, extForEncoding(encoding)), {
      type: encoding.type,
    });
  } finally {
    bitmap.close();
  }
}
