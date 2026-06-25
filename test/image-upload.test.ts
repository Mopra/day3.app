import { describe, expect, it } from "vitest";
import { MAX_IMAGE_BYTES, sniffImageType, validateImageUpload } from "../src/lib/image-upload";

function buf(bytes: number[]): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00];
const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const WEBP = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0];

describe("sniffImageType", () => {
  it("identifies png / jpeg / gif / webp by magic bytes", () => {
    expect(sniffImageType(buf(PNG))).toEqual({ ext: "png", contentType: "image/png" });
    expect(sniffImageType(buf(JPEG))).toEqual({ ext: "jpg", contentType: "image/jpeg" });
    expect(sniffImageType(buf(GIF))).toEqual({ ext: "gif", contentType: "image/gif" });
    expect(sniffImageType(buf(WEBP))).toEqual({ ext: "webp", contentType: "image/webp" });
  });

  it("returns null for non-image bytes (e.g. an SVG/script or text payload)", () => {
    expect(sniffImageType(buf([0x3c, 0x73, 0x76, 0x67]))).toBeNull(); // "<svg"
    expect(sniffImageType(buf([0x68, 0x69]))).toBeNull(); // "hi"
    expect(sniffImageType(new ArrayBuffer(0))).toBeNull();
  });

  it("does not mistake a RIFF container that isn't WEBP (e.g. WAV) for an image", () => {
    const riffWav = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]; // "WAVE"
    expect(sniffImageType(buf(riffWav))).toBeNull();
  });
});

describe("validateImageUpload", () => {
  const ok = { name: "photo.png", size: 1_000, type: "image/png" };

  it("accepts a well-formed image upload", () => {
    expect(validateImageUpload(ok)).toBeNull();
  });

  it("accepts an empty content-type (some clients omit it; the byte sniff is authoritative)", () => {
    expect(validateImageUpload({ ...ok, type: "" })).toBeNull();
  });

  it("rejects a missing filename", () => {
    expect(validateImageUpload({ ...ok, name: "  " })?.status).toBe(400);
  });

  it("rejects a disallowed content-type (svg, pdf)", () => {
    expect(validateImageUpload({ ...ok, type: "image/svg+xml" })?.status).toBe(400);
    expect(validateImageUpload({ ...ok, type: "application/pdf" })?.status).toBe(400);
  });

  it("rejects an empty file", () => {
    expect(validateImageUpload({ ...ok, size: 0 })?.status).toBe(400);
  });

  it("rejects a file over the 5 MB cap with 413", () => {
    expect(validateImageUpload({ ...ok, size: MAX_IMAGE_BYTES + 1 })?.status).toBe(413);
  });
});
