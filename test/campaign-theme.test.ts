import { describe, expect, it } from "vitest";
import {
  CampaignThemeSchema,
  DEFAULT_THEME,
  MAX_BORDER_WIDTH,
  MAX_RADIUS,
  isThemeColor,
  resolveTheme,
  safeParseTheme,
  themeCanvasVars,
} from "../src/lib/theme";
import { renderCampaignEmail, wrapEmailDocument } from "../src/services/render";

describe("campaign theme model", () => {
  it("accepts plain colors and bounded radii", () => {
    const parsed = CampaignThemeSchema.safeParse({
      pageBg: "#fafafa",
      contentBg: "rgb(255,255,255)",
      textColor: "black",
      sectionRadius: 16,
      borderWidth: 2,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a color that could break out of an inline style", () => {
    // A value carrying a quote/semicolon/brace must never validate — it would let a
    // theme value escape the wrapper's style="…" attribute.
    expect(isThemeColor('red;} body{display:none')).toBe(false);
    expect(isThemeColor('#fff" onload="x')).toBe(false);
    expect(isThemeColor("url(http://evil)")).toBe(false);
    expect(CampaignThemeSchema.safeParse({ pageBg: "red; }" }).success).toBe(false);
  });

  it("rejects radii / border widths outside the allowed range", () => {
    expect(CampaignThemeSchema.safeParse({ sectionRadius: MAX_RADIUS + 1 }).success).toBe(false);
    expect(CampaignThemeSchema.safeParse({ imageRadius: -1 }).success).toBe(false);
    expect(CampaignThemeSchema.safeParse({ borderWidth: MAX_BORDER_WIDTH + 1 }).success).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(CampaignThemeSchema.safeParse({ evil: "x" }).success).toBe(false);
  });

  it("resolveTheme fills unset fields from the defaults", () => {
    const t = resolveTheme({ textColor: "#222222" });
    expect(t.textColor).toBe("#222222");
    expect(t.pageBg).toBe(DEFAULT_THEME.pageBg);
    expect(t.sectionRadius).toBe(DEFAULT_THEME.sectionRadius);
  });

  it("resolveTheme(null) is the default theme", () => {
    expect(resolveTheme(null)).toEqual(DEFAULT_THEME);
  });

  it("safeParseTheme tolerates null / junk / invalid blobs", () => {
    expect(safeParseTheme(null)).toBeNull();
    expect(safeParseTheme("not json")).toBeNull();
    expect(safeParseTheme(JSON.stringify({ pageBg: "red; }" }))).toBeNull();
    expect(safeParseTheme(JSON.stringify({ pageBg: "#000000" }))).toEqual({ pageBg: "#000000" });
  });

  it("themeCanvasVars exposes every control as a CSS custom property", () => {
    const vars = themeCanvasVars(DEFAULT_THEME);
    expect(vars["--d3-page-bg"]).toBe(DEFAULT_THEME.pageBg);
    expect(vars["--d3-text"]).toBe(DEFAULT_THEME.textColor);
    expect(vars["--d3-img-radius"]).toBe(`${DEFAULT_THEME.imageRadius}px`);
    expect(vars["--d3-border-width"]).toBe(`${DEFAULT_THEME.borderWidth}px`);
  });

  it("re-scopes surface tokens to the content background so hover/active states stay legible", () => {
    const vars = themeCanvasVars(DEFAULT_THEME);
    // Foregrounds pin to the theme text; surfaces derive from the content bg so a
    // button's hover fill keeps contrast with that text (no dark-on-dark on hover).
    expect(vars["--foreground"]).toBe(DEFAULT_THEME.textColor);
    expect(vars["--popover-foreground"]).toBe(DEFAULT_THEME.textColor);
    expect(vars["--accent-foreground"]).toBe(DEFAULT_THEME.textColor);
    expect(vars["--background"]).toBe(DEFAULT_THEME.contentBg);
    expect(vars["--popover"]).toBe(DEFAULT_THEME.contentBg);
    expect(vars["--muted"]).toContain(DEFAULT_THEME.contentBg);
    expect(vars["--accent"]).toContain(DEFAULT_THEME.contentBg);
  });
});

describe("themed email document", () => {
  it("wraps the body in a full document carrying the theme", () => {
    const theme = resolveTheme({
      pageBg: "#101010",
      contentBg: "#222222",
      textColor: "#eeeeee",
      headingColor: "#ffffff",
      linkColor: "#33aaff",
      borderColor: "#444444",
      borderWidth: 2,
      imageRadius: 8,
      sectionRadius: 20,
    });
    const doc = wrapEmailDocument("<p>Hello</p>", theme);
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("<p>Hello</p>");
    // Page + content backgrounds, link/heading colors, and the radii all appear.
    expect(doc).toContain("background:#101010");
    expect(doc).toContain("background:#222222");
    expect(doc).toContain("color:#33aaff");
    expect(doc).toContain("color:#ffffff");
    expect(doc).toContain("border-radius:20px");
    expect(doc).toContain("border-radius:8px");
    expect(doc).toContain("2px solid #444444");
    // The class hooks the <style> targets the sanitized body through.
    expect(doc).toContain('class="d3-body"');
  });

  it("rounds opted-in callouts to the section radius via the d3-quote-round hook", () => {
    const doc = wrapEmailDocument("<p>x</p>", resolveTheme({ sectionRadius: 14 }));
    // A rounded quote's table opts into separate borders so the radius clips its cell.
    expect(doc).toContain(".d3-body table.d3-quote-round{border-collapse:separate;border-spacing:0;}");
    expect(doc).toContain(".d3-body td.d3-quote-round{border-radius:14px;}");
  });

  it("includes a responsive @media rule that stacks multi-column cells on mobile", () => {
    const doc = wrapEmailDocument("<p>x</p>", resolveTheme({}));
    // Below the card width, the serializer's `d3-col` cells become full-width blocks
    // so 2/3-column sections, button rows, and side-by-side cards collapse to a single
    // column on phones; stacked column images fill the new width.
    expect(doc).toContain("@media only screen and (max-width:600px)");
    expect(doc).toContain(".d3-col{display:block!important;width:100%!important;");
    expect(doc).toContain(".d3-col img{width:100%!important;height:auto!important;}");
  });

  it("omits the card border when width is 0", () => {
    const doc = wrapEmailDocument(
      "<p>x</p>",
      resolveTheme({ borderWidth: 0, contentBg: "#ffffff", sectionRadius: 12 }),
    );
    // The card's inline style runs straight from background to border-radius with no
    // `border:` declaration in between. (The `hr` rule still uses "solid", so we
    // assert on the card style segment rather than the absence of "solid".)
    expect(doc).toContain("background:#ffffff;border-radius:12px");
    const withBorder = wrapEmailDocument(
      "<p>x</p>",
      resolveTheme({ borderWidth: 2, borderColor: "#444444" }),
    );
    expect(withBorder).toContain("border:2px solid #444444;");
  });
});

describe("renderCampaignEmail with a theme", () => {
  const base = {
    campaign: {
      subject: "Hi",
      htmlBody: "<h1>Title</h1><p>Body</p>",
      textBody: null,
    },
    subscriber: { email: "a@x.co", firstName: "A", lastName: null },
    companyName: "Co",
    companyAddress: "1 St",
    unsubscribeUrl: "https://app.test/u?t=1",
  };

  it("applies a provided theme to the delivered HTML", () => {
    const out = renderCampaignEmail({
      ...base,
      theme: { contentBg: "#abcdef", linkColor: "#ff0000" },
    });
    expect(out.html).toContain("background:#abcdef");
    expect(out.html).toContain("color:#ff0000");
    // The body + footer still render inside the wrapper.
    expect(out.html).toContain("Body");
    expect(out.html).toContain("1 St");
    expect(out.html).toContain("https://app.test/u?t=1");
  });

  it("falls back to the default theme when none is given", () => {
    const out = renderCampaignEmail(base);
    expect(out.html).toContain(`background:${DEFAULT_THEME.pageBg}`);
    expect(out.html).toContain(`background:${DEFAULT_THEME.contentBg}`);
  });
});
