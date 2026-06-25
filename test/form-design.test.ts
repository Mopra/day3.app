import { describe, expect, it } from "vitest";
import {
  DEFAULT_FORM_DESIGN,
  FormDesignSchema,
  MAX_FORM_RADIUS,
  formDesignJson,
  resolveFormDesign,
  safeParseFormDesign,
} from "../src/lib/form-design";

describe("form design model", () => {
  it("accepts plain colors, a bounded radius, and an https image", () => {
    const parsed = FormDesignSchema.safeParse({
      pageBg: "#fafafa",
      cardBg: "rgb(255,255,255)",
      headingColor: "black",
      textColor: "#4b5563",
      cornerRadius: 18,
      imageUrl: "https://assets.day3.app/acc/img.png",
      imageAlt: "Our logo",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a color that could break out of an inline style", () => {
    expect(FormDesignSchema.safeParse({ pageBg: 'red;}body{x' }).success).toBe(false);
    expect(FormDesignSchema.safeParse({ textColor: '#fff" onload="x' }).success).toBe(false);
  });

  it("rejects a non-https image URL and an out-of-range radius", () => {
    expect(FormDesignSchema.safeParse({ imageUrl: "http://x.test/a.png" }).success).toBe(false);
    expect(FormDesignSchema.safeParse({ imageUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(FormDesignSchema.safeParse({ cornerRadius: MAX_FORM_RADIUS + 1 }).success).toBe(false);
  });

  it("resolves null / legacy input to the defaults", () => {
    expect(resolveFormDesign(null)).toEqual(DEFAULT_FORM_DESIGN);
    expect(resolveFormDesign(undefined)).toEqual(DEFAULT_FORM_DESIGN);
    expect(resolveFormDesign("not json{")).toEqual(DEFAULT_FORM_DESIGN);
  });

  it("fills only the unset fields from the defaults (partial round-trip)", () => {
    const resolved = resolveFormDesign({ headingColor: "#2563eb" });
    expect(resolved.headingColor).toBe("#2563eb");
    expect(resolved.pageBg).toBe(DEFAULT_FORM_DESIGN.pageBg);
    expect(resolved.imageUrl).toBeNull();
  });

  it("normalizes an empty image URL back to null", () => {
    expect(resolveFormDesign({ imageUrl: "" }).imageUrl).toBeNull();
  });

  it("round-trips a serialized design through the stored JSON string", () => {
    const json = formDesignJson({ cardBg: "#000000", cornerRadius: 4 });
    expect(typeof json).toBe("string");
    const parsed = safeParseFormDesign(json);
    expect(parsed?.cardBg).toBe("#000000");
    expect(parsed?.cornerRadius).toBe(4);
  });

  it("serializes empty/invalid input to null so the form falls back to defaults", () => {
    expect(formDesignJson(null)).toBeNull();
    expect(formDesignJson(undefined)).toBeNull();
  });
});
