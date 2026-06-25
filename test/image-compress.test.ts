import { describe, expect, it } from "vitest";
import {
  EMAIL_JPEG_QUALITY,
  MAX_EMAIL_IMAGE_EDGE,
  chooseEmailEncoding,
  extForEncoding,
  targetDimensions,
} from "../src/lib/image-compress";

describe("targetDimensions", () => {
  it("leaves images already within the max edge untouched", () => {
    expect(targetDimensions(600, 400)).toEqual({ width: 600, height: 400 });
    expect(targetDimensions(MAX_EMAIL_IMAGE_EDGE, 900)).toEqual({
      width: MAX_EMAIL_IMAGE_EDGE,
      height: 900,
    });
  });

  it("downscales by the longest edge, preserving aspect ratio", () => {
    // 4000x3000 (landscape) → longest edge clamped to 1600.
    expect(targetDimensions(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    // 3000x4000 (portrait) → height is the longest edge.
    expect(targetDimensions(3000, 4000)).toEqual({ width: 1200, height: 1600 });
  });

  it("never upscales a small image", () => {
    expect(targetDimensions(100, 50)).toEqual({ width: 100, height: 50 });
  });

  it("respects a custom max edge", () => {
    expect(targetDimensions(2000, 1000, 1000)).toEqual({ width: 1000, height: 500 });
  });

  it("clamps rounded dimensions to at least 1px and tolerates a zero edge", () => {
    expect(targetDimensions(1600, 1, 800)).toEqual({ width: 800, height: 1 });
    expect(targetDimensions(0, 0)).toEqual({ width: 0, height: 0 });
  });
});

describe("chooseEmailEncoding", () => {
  it("keeps transparent images as PNG so alpha isn't flattened", () => {
    expect(chooseEmailEncoding(true)).toEqual({ type: "image/png" });
  });

  it("encodes opaque (photographic) images as quality-tuned JPEG", () => {
    expect(chooseEmailEncoding(false)).toEqual({
      type: "image/jpeg",
      quality: EMAIL_JPEG_QUALITY,
    });
  });
});

describe("extForEncoding", () => {
  it("maps encodings to their file extension", () => {
    expect(extForEncoding({ type: "image/png" })).toBe("png");
    expect(extForEncoding({ type: "image/jpeg", quality: 0.82 })).toBe("jpg");
  });
});
