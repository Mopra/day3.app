import { describe, expect, it } from "vitest";
import { mergeTagParts, unwrapMergeTags } from "../src/components/ui/merge-tag-node";

describe("merge tag chips", () => {
  it("labels built-in and custom tags, with their fallback", () => {
    expect(mergeTagParts("{{first_name|there}}")).toEqual({ label: "First name", fallback: "there" });
    expect(mergeTagParts("{{ email }}")).toEqual({ label: "Email", fallback: "" });
    expect(mergeTagParts("{{plan_tier|free}}")).toEqual({ label: "Plan tier", fallback: "free" });
  });

  it("unwraps chips back to the exact token text the body held before", () => {
    const html =
      '<p>Hi <strong><span data-d3-tag="">{{first_name|there}}</span></strong>, ' +
      'from <span data-d3-tag="">{{ company_name }}</span> &amp; co.</p>';
    expect(unwrapMergeTags(html)).toBe(
      "<p>Hi <strong>{{first_name|there}}</strong>, from {{ company_name }} &amp; co.</p>",
    );
  });

  it("leaves HTML without chips untouched", () => {
    const html = '<p>Plain <span>span</span> and {{email}}</p>';
    expect(unwrapMergeTags(html)).toBe(html);
  });
});
