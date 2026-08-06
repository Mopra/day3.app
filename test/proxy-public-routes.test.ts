import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Static guard for the auth boundary in proxy.ts.
//
// Routes authenticated with a bearer API key have no Clerk session — the caller
// is a script, or an AI editor speaking MCP. If such a route is missing from
// proxy.ts's public matcher, clerkMiddleware's auth.protect() answers every
// request with a 404, and the endpoint looks like it was never deployed. That
// failure is invisible in tests (which call the handler directly) and invisible
// in the build output (the route is listed), so it can only be caught here.
//
// This shipped once, on /api/mcp. Hence the guard.

const API_ROOT = join("app", "api");

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (entry === "route.ts") out.push(full);
  }
  return out;
}

// app/api/v1/campaigns/[campaignId]/route.ts → /api/v1/campaigns/sample
function urlPath(file: string): string {
  return (
    "/" +
    file
      .replace(/route\.ts$/, "")
      .split(sep)
      .filter(Boolean)
      .slice(1) // drop the leading "app"
      .map((seg) => (seg.startsWith("[") ? "sample" : seg))
      .join("/")
  );
}

// The literals inside createRouteMatcher([...]) in proxy.ts.
function publicPatterns(): string[] {
  const source = readFileSync("proxy.ts", "utf8");
  const block = /createRouteMatcher\(\[([\s\S]*?)\]\)/.exec(source);
  if (!block) throw new Error("Could not find createRouteMatcher([...]) in proxy.ts");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

// Clerk patterns are path-to-regexp; the ones this app uses are plain segments
// plus a trailing `(.*)`, which converts directly.
function toRegExp(pattern: string): RegExp {
  const body = pattern
    .split("(.*)")
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

describe("proxy public routes", () => {
  const patterns = publicPatterns().map(toRegExp);
  // Two ways in: the v1 wrapper (which calls requireApiKey for you) or a direct
  // call, as the MCP endpoint makes.
  const bearerRoutes = routeFiles(API_ROOT).filter((f) => {
    const source = readFileSync(f, "utf8");
    return source.includes("requireApiKey") || /\bapiRoute\b/.test(source);
  });

  it("finds the bearer-authenticated routes", () => {
    // A sanity check on the scan itself: if this hits zero the assertions below
    // would pass vacuously.
    expect(bearerRoutes.length).toBeGreaterThan(5);
  });

  it.each(bearerRoutes)("%s is reachable without a Clerk session", (file) => {
    const path = urlPath(file);
    const matched = patterns.some((re) => re.test(path));
    expect(
      matched,
      `${path} authenticates with an API key but is not in proxy.ts's public matcher — ` +
        "clerkMiddleware will 404 it in production.",
    ).toBe(true);
  });
});
