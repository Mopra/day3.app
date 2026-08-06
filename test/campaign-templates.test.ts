import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "../src/services/render";
import {
  CAMPAIGN_TEMPLATES,
  TEMPLATE_SECTION_KINDS,
  campaignTemplate,
} from "../src/lib/campaign-templates";
import { SectionsSchema, serializeSections } from "../src/lib/sections";
import { CampaignThemeSchema, resolveTheme } from "../src/lib/theme";

// The campaign field limits the API enforces (src/api/campaigns.ts), asserted here so
// a template can never carry a subject the save would reject.
const MAX_SUBJECT = 200;

describe("campaign templates", () => {
  it("ships a small, uniquely-keyed set", () => {
    expect(CAMPAIGN_TEMPLATES.length).toBeGreaterThan(0);
    // Deliberately few — every section kind added to the builder means auditing each
    // template, so this ceiling is a maintenance guard, not an arbitrary limit.
    expect(CAMPAIGN_TEMPLATES.length).toBeLessThanOrEqual(8);
    const keys = CAMPAIGN_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("looks up by key and no-ops on an unknown one", () => {
    expect(campaignTemplate("product-update")?.name).toBe("Product update");
    expect(campaignTemplate("nope")).toBeUndefined();
  });

  // Invariant 1: a template is never something the API would reject on save.
  describe.each(CAMPAIGN_TEMPLATES.map((t) => [t.key, t] as const))("%s", (_key, template) => {
    it("parses under SectionsSchema", () => {
      const parsed = SectionsSchema.safeParse(template.build());
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    });

    it("has a valid theme", () => {
      const parsed = CampaignThemeSchema.safeParse(template.theme);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    });

    it("has copy that fits the campaign field limits", () => {
      expect(template.subject.trim()).not.toBe("");
      expect(template.subject.length).toBeLessThanOrEqual(MAX_SUBJECT);
      expect(template.previewText.trim()).not.toBe("");
      expect(template.name.trim()).not.toBe("");
      expect(template.description.trim()).not.toBe("");
      expect(template.structure.trim()).not.toBe("");
    });

    // Invariant 2: "what the builder produces is exactly what ships" holds for
    // template content too — the serialized body is a fixed point of sanitizeHtml,
    // so nothing in a template is silently stripped on send.
    it("serializes to a body the sanitizer leaves untouched", () => {
      const html = serializeSections(template.build());
      expect(html.trim()).not.toBe("");
      expect(sanitizeHtml(html)).toBe(html);
    });

    it("mints fresh section ids on every application", () => {
      const a = template.build();
      const b = template.build();
      const idsA = a.map((s) => s.id);
      // Unique within one build (they're React keys and sortable ids)...
      expect(new Set(idsA).size).toBe(idsA.length);
      // ...and never shared between two applications.
      const shared = idsA.filter((id) => b.some((s) => s.id === id));
      expect(shared).toEqual([]);
    });

    it("uses only the section kinds this module accounts for", () => {
      for (const section of template.build()) {
        expect(TEMPLATE_SECTION_KINDS).toContain(section.kind);
      }
    });

    // Placeholder discipline: a template shows the user *where* an image or a link
    // goes without shipping a borrowed image or a dead link if they send it as-is.
    it("carries no pre-filled image sources or button links", () => {
      for (const section of template.build()) {
        for (const image of section.images ?? []) {
          expect(image).toBeNull();
        }
        for (const b of section.buttons ?? []) {
          if (!b) continue;
          expect(b.label.trim()).not.toBe("");
          expect(b.href).toBe("");
        }
        // A social row starts empty — the editor is the prompt to fill it.
        for (const s of section.socials ?? []) {
          expect(s.url.trim()).not.toBe("");
        }
      }
    });

    // Every merge tag carries a fallback, so a template reads correctly for an
    // audience that never collected that field. company_name is exempt: it resolves
    // from the account, not from subscriber data, so it can never be empty.
    it("only uses merge tags with a fallback", () => {
      const html = serializeSections(template.build());
      const tags = html.match(/\{\{[^}]*\}\}/g) ?? [];
      for (const tag of tags) {
        if (/^\{\{\s*company_name\s*\}\}$/i.test(tag)) continue;
        expect(tag, `${tag} needs a |fallback`).toMatch(/\|/);
      }
    });

    // No dead vertical space in the unfilled state. A placeholder section is dropped
    // from the serialized body, so a template that also placed an explicit spacer beside
    // one would leave its gaps stacked up — a visible hole where the user sees a button
    // in the builder. Adjacent spacers (and hollow cells) are the signature of that.
    it("leaves no stacked gap or hollow cell where a placeholder sits", () => {
      const html = serializeSections(template.build());
      const spacer = '<table role="presentation" width="100%"><tbody><tr><td height="16">&nbsp;</td></tr></tbody></table>';
      expect(html).not.toContain(`${spacer}\n${spacer}`);
      // A section that renders to nothing visible must not survive as an empty table.
      expect(html).not.toContain('valign="top"></td>');
    });

    // An unfilled template must still be a real email — placeholder-only sections
    // (an empty image slot, an href-less button, an empty social row) serialize to
    // nothing, so at least one section has to carry actual content.
    it("reads as a real email before the user fills anything in", () => {
      const html = serializeSections(template.build());
      const textish = html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
      expect(textish.length).toBeGreaterThan(80);
    });
  });

  it("gives each template a distinct look", () => {
    // The theme is half of what makes a template feel like a choice rather than a
    // variant, so two templates should never resolve to the same styling.
    const looks = CAMPAIGN_TEMPLATES.map((t) => JSON.stringify(resolveTheme(t.theme)));
    expect(new Set(looks).size).toBe(looks.length);
  });
});
