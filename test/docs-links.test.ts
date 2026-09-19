import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DOCS_ORIGIN,
  FALLBACK_HELP,
  GUIDE,
  REFERENCE,
  SITE_ORIGIN,
  docsUrl,
  helpLinksForPath,
  siteUrl,
} from "@/lib/docs-links";

// The app links out to two bodies of written help, and a dead help link is
// worse than no help link — someone clicks it exactly when they are already
// stuck. Nothing here reaches the network; these assert the things that go
// wrong silently:
//
//   1. Every reference link points at a page that really exists in the docs
//      repo, when that repo is checked out next to this one.
//   2. Every page a user can reach has help mapped to it, so a new page
//      doesn't quietly inherit the generic fallback.
//   3. Nothing in the map points back into the app, which would open a
//      same-origin route in a new tab.

const ALL_LINKS = [...Object.values(REFERENCE), ...Object.values(GUIDE)];

/**
 * The docs live in a sibling repo. It is not a dependency and CI may not have
 * it, so the page-existence check skips rather than fails when it is absent.
 */
const DOCS_REPO = path.resolve(process.cwd(), "..", "day3.app.docs", "app");
const docsRepoPresent = (() => {
  try {
    return statSync(DOCS_REPO).isDirectory();
  } catch {
    return false;
  }
})();

/** Every route the docs site publishes, as a path ("/", "/webhooks/endpoints"). */
function publishedDocsRoutes(dir: string, prefix = ""): string[] {
  const routes: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "page.mdx") routes.push(prefix === "" ? "/" : prefix);
    else if (entry.isDirectory() && !entry.name.startsWith("_")) {
      routes.push(...publishedDocsRoutes(path.join(dir, entry.name), `${prefix}/${entry.name}`));
    }
  }
  return routes;
}

/** Every page a signed-in user can navigate to, from app/(app)/**\/page.tsx. */
function appRoutes(): string[] {
  const root = path.resolve(process.cwd(), "app", "(app)");
  const routes: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.name === "page.tsx") routes.push(prefix === "" ? "/" : prefix);
      else if (entry.isDirectory()) walk(full, `${prefix}/${entry.name}`);
    }
  };
  walk(root, "");
  return routes;
}

describe("docs links", () => {
  it("builds absolute URLs on the right origin", () => {
    expect(docsUrl("/webhooks")).toBe(`${DOCS_ORIGIN}/webhooks`);
    expect(docsUrl("webhooks")).toBe(`${DOCS_ORIGIN}/webhooks`);
    expect(docsUrl()).toBe(`${DOCS_ORIGIN}/`);
    expect(siteUrl("/deliverability")).toBe(`${SITE_ORIGIN}/deliverability`);
  });

  it("only ever points off-origin, over https", () => {
    for (const link of ALL_LINKS) {
      // A relative href here would open an in-app route in a new tab, and an
      // http:// one would hand a user a certificate warning.
      expect(link.href, link.label).toMatch(/^https:\/\//);
      expect(link.href, link.label).not.toContain("go.day3.app");
    }
  });

  it("gives every link a label and a blurb", () => {
    for (const link of ALL_LINKS) {
      expect(link.label.trim(), link.href).not.toBe("");
      // The blurb is what makes a list of reference page titles scannable.
      expect(link.blurb.trim(), link.href).not.toBe("");
    }
  });

  it("tags reference and guide links by the domain they are on", () => {
    for (const link of Object.values(REFERENCE)) {
      expect(link.kind, link.href).toBe("reference");
      expect(link.href.startsWith(DOCS_ORIGIN), link.href).toBe(true);
    }
    for (const link of Object.values(GUIDE)) {
      expect(link.kind, link.href).toBe("guide");
      expect(link.href.startsWith(SITE_ORIGIN), link.href).toBe(true);
    }
  });

  it.skipIf(!docsRepoPresent)("points every reference link at a page that exists", () => {
    const published = new Set(publishedDocsRoutes(DOCS_REPO));
    for (const link of Object.values(REFERENCE)) {
      const route = link.href.slice(DOCS_ORIGIN.length) || "/";
      expect(published, `${link.label} -> ${link.href}`).toContain(route);
    }
  });

  it("resolves a nested route to its own entry, not the parent's", () => {
    const list = helpLinksForPath("/audiences");
    const detail = helpLinksForPath("/audiences/aud_123");
    expect(detail).not.toEqual(list);
    // Longest prefix wins, so the detail page gets Contacts rather than Audiences.
    expect(detail.map((l) => l.href)).toContain(REFERENCE.contacts.href);
  });

  it("does not let a prefix match a different route that merely starts the same", () => {
    // "/audiences" must not swallow "/audiences-archive".
    expect(helpLinksForPath("/audiences-archive")).toEqual(FALLBACK_HELP);
  });

  it("falls back rather than showing an empty popover", () => {
    expect(helpLinksForPath("/nothing-here")).toEqual(FALLBACK_HELP);
    expect(helpLinksForPath("")).toEqual(FALLBACK_HELP);
    expect(FALLBACK_HELP.length).toBeGreaterThan(0);
  });

  it("maps help onto every page a user can reach", () => {
    // Admin pages are operator-only and deliberately unmapped.
    const routes = appRoutes().filter((r) => !r.startsWith("/admin"));
    const unmapped = routes.filter((route) => {
      // Dynamic segments stand in for a real id; the map is matched on prefixes.
      const concrete = route.replace(/\[[^\]]+\]/g, "x");
      return helpLinksForPath(concrete) === FALLBACK_HELP;
    });
    expect(unmapped, "add these to ROUTE_HELP in src/lib/docs-links.ts").toEqual([]);
  });

  it("keeps each route's list short enough to read", () => {
    for (const route of appRoutes()) {
      const links = helpLinksForPath(route.replace(/\[[^\]]+\]/g, "x"));
      expect(links.length, route).toBeGreaterThan(0);
      expect(links.length, route).toBeLessThanOrEqual(3);
    }
  });

  it("routes every docs link in the app through this module", () => {
    // A docs URL written out anywhere else is one that will not be updated when
    // a page moves or a blog slug changes, and it fails silently — the link
    // just 404s for whoever was already stuck. Everything comes from
    // REFERENCE / GUIDE. Matched on the URL form, so naming the docs site in a
    // comment is still allowed.
    const FRAGILE = [/\/\/docs\.day3\.app/, /day3\.app\/blog\//];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(full);
        } else if (/\.tsx?$/.test(entry.name) && full !== SELF) {
          const src = readFileSync(full, "utf8");
          if (FRAGILE.some((re) => re.test(src))) offenders.push(path.relative(process.cwd(), full));
        }
      }
    };
    for (const root of ["src", "app"]) walk(path.resolve(process.cwd(), root));
    expect(offenders, "import from src/lib/docs-links.ts instead").toEqual([]);
  });
});

/** This module owns the one literal `docs.day3.app`, so it is exempt above. */
const SELF = path.resolve(process.cwd(), "src", "lib", "docs-links.ts");
