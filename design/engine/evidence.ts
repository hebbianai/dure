// Optional HTML mockups: path/state parsing and token references.
// Product behavior is owned by source and its tests, not prose coverage.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { type CoverageError, type MockupEvidence, STATE_FILENAMES } from "./types.ts";

const MOCKUPS_DIR = "design/mockups";

export interface EvidenceScan {
  mockups: MockupEvidence[];
  errors: CoverageError[];
}

function walkFiles(dir: string, out: string[]) {
  if (!existsSync(dir)) return;
  // Sorted so scan order — and therefore any order-dependent diagnostics — is
  // deterministic across filesystems. Symlinks skipped: dangling links must
  // not crash the gate and linked dirs must not alias evidence.
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

const stripComments = (html: string) =>
  html.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

export function extractVars(html: string): string[] {
  const vars = new Set<string>();
  for (const m of stripComments(html).matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g)) {
    vars.add(m[1]);
  }
  return [...vars].sort();
}

export function scanEvidence(repoRoot: string): EvidenceScan {
  const errors: CoverageError[] = [];
  const mockups: MockupEvidence[] = [];
  const mockupFiles: string[] = [];
  walkFiles(join(repoRoot, MOCKUPS_DIR), mockupFiles);
  for (const file of mockupFiles) {
    const rel = relative(repoRoot, file).split("\\").join("/");
    if (!file.endsWith(".html")) continue;
    const parts = rel.split("/"); // design/mockups/<cluster>/<Name>/<state>.html
    if (parts.length !== 5) {
      errors.push({
        code: "orphan-evidence",
        message: `${rel}: mockups must live at design/mockups/<cluster>/<Name>/<state>.html`,
        file: rel,
      });
      continue;
    }
    const stateFile = parts[4].replace(/\.html$/, "");
    const state = Object.hasOwn(STATE_FILENAMES, stateFile) ? STATE_FILENAMES[stateFile] : undefined;
    if (!state) {
      errors.push({
        code: "orphan-evidence",
        message: `${rel}: unknown state filename \`${stateFile}\` (expected ${Object.keys(STATE_FILENAMES).join("/")})`,
        file: rel,
      });
      continue;
    }
    mockups.push({
      path: rel,
      surfaceLocalId: `${parts[2]}/${parts[3]}`,
      state,
      vars: extractVars(readFileSync(file, "utf8")),
    });
  }

  return { mockups, errors };
}
