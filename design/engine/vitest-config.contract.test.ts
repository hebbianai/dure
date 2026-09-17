// Gate-selection contract (hebbian-frontend-i13o.10): this vitest config is
// the sole test selector for the design-coverage gate.
// Narrowing its include glob would drop engine tests while the gate stays
// green, so prove every design/engine/**/*.test.ts on disk matches include.

import { readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import config from "./vitest.config.ts";

const engineDir = fileURLToPath(new URL(".", import.meta.url));

// Minimal matcher for the only glob syntax this config may use: `**` (any
// number of directories) and `*` (one path segment). Any other syntax fails
// closed — extend the matcher in the same change that introduces it.
function globToRegExp(pattern: string): RegExp {
  if (!/^[A-Za-z0-9._\-*/]+$/.test(pattern) || /\*{3,}/.test(pattern)) {
    throw new Error(`unsupported glob syntax in vitest config: ${pattern}`);
  }
  let source = "";
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith("**/", i)) {
      source += "(?:[^/]+/)*"; // zero or more directories, like picomatch
      i += 3;
    } else if (pattern.slice(i) === "**") {
      source += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      source += "[^/]*";
      i += 1;
    } else {
      source += pattern[i].replace(/[.$+^(){}[\]|\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${source}$`);
}

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTestFiles(full));
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

describe("vitest config test selection", () => {
  it("include globs cover every engine *.test.ts on disk", () => {
    // Fail closed on shape drift: a function-form defineConfig or a removed
    // root would silently change what the gate selects.
    expect(typeof config.root).toBe("string");
    const root = resolve(config.root as string);
    const include = config.test?.include;
    expect(Array.isArray(include) && include.length > 0).toBe(true);
    const includeRes = (include as string[]).map(globToRegExp);
    const excludeRes = (config.test?.exclude ?? []).map(globToRegExp);

    const files = listTestFiles(engineDir);
    expect(files.length).toBeGreaterThan(0);

    const uncovered = files
      .map((file) => relative(root, file).split(sep).join("/"))
      .filter(
        (rel) =>
          rel.startsWith("..") || // configured root no longer contains engineDir
          !includeRes.some((re) => re.test(rel)) ||
          excludeRes.some((re) => re.test(rel)),
      );
    expect(uncovered).toEqual([]);
  });
});
