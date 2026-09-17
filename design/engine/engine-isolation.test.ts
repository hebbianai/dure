// Isolation contract: non-test engine sources never
// import from src/ — the product is read as data, and product code consumes only
// the generated design-coverage.json. Test files may import src (contract tests).

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const engineDir = fileURLToPath(new URL(".", import.meta.url));

describe("engine isolation", () => {
  it("no src/ module imports from design/ — product code consumes only the generated JSON", () => {
    // Reverse direction of the engine→src ban: without it, a src import of
    // design/engine types would make engine edits silently skip the frontend
    // typecheck (design/** classifies to the lightweight design-coverage gate).
    const srcDir = fileURLToPath(new URL("../../src", import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const text = readFileSync(full, "utf8");
          for (const match of text.matchAll(
            /(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)"([^"]+)"/g,
          )) {
            if (/(^|\/)design\/(engine|mockups|specs)\b/.test(match[1])) {
              offenders.push(`${full}: ${match[1]}`);
            }
          }
        }
      }
    };
    walk(srcDir);
    expect(offenders).toEqual([]);
  });

  it("no non-test engine module imports from src/ or uses the @ alias", () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(engineDir)) {
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      const raw = readFileSync(join(engineDir, entry), "utf8");
      // Comments stripped so documentation examples cannot false-positive.
      const text = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      // All import forms: static `from`, bare side-effect imports, dynamic
      // import("..."), and require("...").
      for (const match of text.matchAll(/(?:\bfrom\s+|\bimport\s+|\bimport\s*\(\s*|\brequire\s*\(\s*)"([^"]+)"/g)) {
        const spec = match[1];
        if (spec.startsWith("@/") || spec.includes("/src/") || /^\.\.\/\.\.\/src\b/.test(spec)) {
          offenders.push(`${entry}: ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
