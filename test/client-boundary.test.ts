import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, posix, sep } from "node:path";

// A server component may RENDER a component from a `"use client"` module, but it
// may not CALL a plain function exported from one: the compiler replaces every
// export of a client module with a client reference, so the call throws at render
// ("Attempted to call parseTab() from the server but parseTab is on the client").
// Nothing catches this earlier — it typechecks, it lints, and it builds; the page
// simply 500s on every request, which is how a released automations detail page
// spent a deploy showing the error boundary instead of the canvas.
//
// So the boundary is checked statically here. The rule: from a non-client module,
// a named import out of a client module must be a `type`, or a component (the
// convention being an Uppercase name). A helper both sides need moves to a plain
// module (lib/automation-types.ts is the automations one).

const ROOTS = ["app", "src"];

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") tsFiles(p, out);
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(p.split(sep).join("/"));
    }
  }
  return out;
}

// Matches `import { a, type B } from "..."`, skipping `import type { … }` (types
// are erased, so they never reach the boundary) and side-effect/default imports.
const NAMED_IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;

describe("server/client boundary", () => {
  it("no server module calls a function exported from a client module", () => {
    const files = ROOTS.flatMap((r) => tsFiles(r));
    const isClient = new Map<string, boolean>();
    for (const f of files) {
      isClient.set(f, /^\s*["']use client["']/.test(readFileSync(f, "utf8")));
    }

    // "@/x" → src/x; "./x" → relative to the importer. Only resolves to files we
    // already know about, so node_modules and non-source specifiers drop out.
    const resolve = (spec: string, from: string): string | null => {
      let base: string;
      if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
      else if (spec.startsWith(".")) base = posix.normalize(posix.join(posix.dirname(from), spec));
      else return null;
      for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
        if (isClient.has(base + ext)) return base + ext;
      }
      return null;
    };

    const offenders: string[] = [];
    for (const file of files) {
      if (isClient.get(file)) continue;
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(NAMED_IMPORT)) {
        if (m[1]) continue; // `import type { … }`
        const target = resolve(m[3], file);
        if (!target || !isClient.get(target)) continue;
        for (const raw of m[2].split(",")) {
          const name = raw.trim();
          if (!name || name.startsWith("type ")) continue;
          const local = (name.split(/\s+as\s+/).pop() ?? name).trim();
          // Uppercase = a component, which a server module is allowed to render.
          if (/^[a-z]/.test(local)) {
            offenders.push(`${file} imports value '${local}' from client module ${target}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
