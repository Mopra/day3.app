import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Static guard for the core multi-tenant invariant:
//   "Every query is scoped by account_id."
//
// It scans first-party source for direct `db.query.<table>.findFirst/findMany`
// reads against a TENANT table and fails if the call's options object does not
// constrain on accountId. The intent is to stop a cross-tenant leak from
// shipping silently as new routes are added — if you add a scoped read, route it
// through src/api/finders.ts (or include an accountId predicate inline).

// Tables that carry a not-null account_id (the tenant boundary). suppression_entries
// is intentionally excluded: its account_id is nullable (global suppressions).
const TENANT_TABLES = [
  "accountUsers",
  "sendingDomains",
  "dnsIntegrations",
  "audiences",
  "subscribers",
  "imports",
  "campaigns",
  "campaignRecipients",
  "emailEvents",
  "riskReviews",
];

// Code paths that legitimately query without an account scope:
//   - admin/* routes operate across accounts (the documented exception)
//   - webhooks/* and public/* resolve the tenant from a verified payload/token
//   - services/* are lower-level helpers invoked with an already-scoped id or by
//     the cross-account worker/admin paths; route handlers remain the gate
//   - finders.ts is the centralized scoped lookup itself
const ALLOWLIST = [
  join("app", "api", "admin"),
  join("app", "api", "webhooks"),
  join("app", "api", "public"),
  join("src", "services"),
  join("src", "queue"),
  join("worker"),
  join("scripts"),
];

const ROOTS = [join("app", "api"), join("src")];

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
      out.push(full);
    }
  }
}

function isAllowlisted(file: string): boolean {
  const rel = relative(process.cwd(), file);
  return ALLOWLIST.some((prefix) => rel === prefix || rel.startsWith(prefix + sep));
}

// Match `db.query.<table>.findFirst(` / `.findMany(` and capture the balanced
// argument list so we can check it for an accountId constraint.
function unscopedReads(source: string): string[] {
  const violations: string[] = [];
  const callRe = new RegExp(
    `\\bdb\\.query\\.(${TENANT_TABLES.join("|")})\\.(findFirst|findMany)\\s*\\(`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source)) !== null) {
    const table = m[1];
    // Walk the balanced parens of the call to extract its arguments.
    let depth = 0;
    let i = callRe.lastIndex - 1;
    let start = -1;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(") {
        if (depth === 0) start = i + 1;
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    const args = start >= 0 ? source.slice(start, i) : "";
    if (!/accountId/.test(args)) {
      violations.push(`${table}.${m[2]}`);
    }
  }
  return violations;
}

describe("tenant-scoping guard", () => {
  const files: string[] = [];
  for (const root of ROOTS) walk(join(process.cwd(), root), files);

  it("scans a non-trivial number of source files", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("flags no direct db.query on tenant tables without an accountId filter", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (isAllowlisted(file)) continue;
      const source = readFileSync(file, "utf8");
      const bad = unscopedReads(source);
      if (bad.length > 0) {
        offenders.push(`${relative(process.cwd(), file)}: ${bad.join(", ")}`);
      }
    }
    expect(offenders, `Unscoped tenant reads found:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("would catch a regression (self-test of the detector)", () => {
    const leak = `await db.query.campaigns.findFirst({ where: eq(campaigns.id, id) });`;
    expect(unscopedReads(leak)).toEqual(["campaigns.findFirst"]);
    const safe = `await db.query.campaigns.findFirst({ where: and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)) });`;
    expect(unscopedReads(safe)).toEqual([]);
  });
});
