// Raw-color budget: count color
// literals outside the token system, allowlist the known-legitimate cases, and
// fail the gate only on regression — the absolute number is dashboard signal.
//
// Gate-surface invariant: budget REGRESSIONS gate only paths the push-gate
// classifier routes to the design-coverage scope (src/components/** today) —
// otherwise a regression in, say, src/lib/ would land green through the
// frontend-only gate and then poison the design gate for unrelated agents.
// Everything else scanned under src/ is report-only dashboard signal. A
// contract test in scripts/push-gate-scope.test.mjs pins this correspondence.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import type { CoverageError } from "./types.ts";

const SCAN_ROOT = "src";
const ALLOWLIST_FILE = "design/raw-color-allowlist.json";
/** Must stay aligned with DESIGN_DENOMINATOR_PREFIXES in scripts/lib/push-gate-scope.mjs. */
export const GATE_ENFORCED_PREFIXES = ["src/components/"];
// The token source and the color-math/theme layer legitimately hold color
// literals; tests hold fixtures. Everything else in src/ should reach color
// through var(--token) or the theme engine.
const EXCLUDED_PREFIXES = ["src/index.css", "src/lib/theme/", "src/generated/"];
const EXCLUDED_PATTERNS = [/\.test\.[jt]sx?$/, /\.d\.ts$/];
const SCANNED_EXTENSIONS = /\.(?:ts|tsx|css)$/;

// Exact-length hex colors (3/4/6/8 digits, not part of a longer word) and
// color-function calls. Length anchoring keeps anchors like "#empty-state"
// and most hex-shaped words out; the allowlist absorbs the rest.
const HEX_COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const COLOR_FUNCTION = /\b(?:rgba?|hsla?|oklch|oklab)\(/g;

/**
 * ts/tsx counting walks the real AST and inspects only string-ish literal
 * text (string literals, template parts, JSX text): comments are naturally
 * excluded, mid-string "//" cannot hide anything, and no hand-rolled lexer
 * has to understand JSX-text apostrophes. Raw color literals in code always
 * live inside such literals (style values, arbitrary Tailwind classes).
 */
function countTsRawColors(text: string): number {
  const source = ts.createSourceFile("scan.tsx", text, ts.ScriptTarget.ES2022, false, ts.ScriptKind.TSX);
  let count = 0;
  const countIn = (value: string) => {
    count += [...value.matchAll(HEX_COLOR)].length;
    count += [...value.matchAll(COLOR_FUNCTION)].length;
  };
  const visit = (node: ts.Node) => {
    // A literal JSX placeholder is display copy (e.g. issue number "#123").
    // Expressions still recurse: nested painting values must remain visible.
    if (
      ts.isJsxAttribute(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "placeholder" &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      return;
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isJsxText(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      countIn(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

/** CSS has no line comments — strip only block comments (fixes url(//cdn…)). */
const stripCssComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));

export interface RawColorScan {
  total: number;
  files: Record<string, number>;
  regressions: CoverageError[];
  /** allowlist rot: allowance above the actual count (report-only) */
  stale: { file: string; allowed: number; actual: number }[];
}

interface Allowlist {
  schemaVersion: number;
  files: Record<string, number>;
}

function walk(dir: string, out: string[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    // Symlinks are skipped entirely: a dangling link must not crash the gate
    // and a linked directory must not alias content past the exclusions.
    if (entry.isSymbolicLink()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

export function countRawColors(text: string, kind: "ts" | "css" = "ts"): number {
  if (kind === "ts") return countTsRawColors(text);
  const stripped = stripCssComments(text);
  const hex = [...stripped.matchAll(HEX_COLOR)].length;
  const fn = [...stripped.matchAll(COLOR_FUNCTION)].length;
  return hex + fn;
}

export function loadAllowlist(repoRoot: string): { allowlist: Allowlist; errors: CoverageError[] } {
  const file = join(repoRoot, ALLOWLIST_FILE);
  if (!existsSync(file)) return { allowlist: { schemaVersion: 1, files: {} }, errors: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Allowlist;
    if (parsed.schemaVersion !== 1) {
      return {
        allowlist: { schemaVersion: 1, files: {} },
        errors: [
          {
            code: "scan-error",
            message: `${ALLOWLIST_FILE}: unsupported schemaVersion ${parsed.schemaVersion}`,
          },
        ],
      };
    }
    return { allowlist: parsed, errors: [] };
  } catch (cause) {
    return {
      allowlist: { schemaVersion: 1, files: {} },
      errors: [{ code: "scan-error", message: `${ALLOWLIST_FILE}: unreadable (${cause})` }],
    };
  }
}

export const isGateEnforcedPath = (rel: string) =>
  GATE_ENFORCED_PREFIXES.some((prefix) => rel.startsWith(prefix));

export function scanRawColors(repoRoot: string): RawColorScan {
  const { allowlist, errors } = loadAllowlist(repoRoot);
  const files: Record<string, number> = {};
  const paths: string[] = [];
  const scanRoot = join(repoRoot, SCAN_ROOT);
  if (existsSync(scanRoot)) walk(scanRoot, paths);
  let total = 0;
  const regressions: CoverageError[] = [...errors];
  for (const full of paths) {
    const rel = relative(repoRoot, full).split("\\").join("/");
    if (!SCANNED_EXTENSIONS.test(rel)) continue;
    if (EXCLUDED_PREFIXES.some((prefix) => rel === prefix || rel.startsWith(prefix))) continue;
    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(rel))) continue;
    const count = countRawColors(readFileSync(full, "utf8"), rel.endsWith(".css") ? "css" : "ts");
    if (count === 0) continue;
    files[rel] = count;
    total += count;
    if (!isGateEnforcedPath(rel)) continue; // report-only outside the gated denominator
    const allowed = allowlist.files[rel] ?? 0;
    if (count > allowed) {
      regressions.push({
        code: "raw-color-regression",
        message: `${rel}: ${count} raw color literal(s), allowlist permits ${allowed} — use var(--token) or extend design/raw-color-allowlist.json with a reviewed reason`,
        file: rel,
      });
    }
  }
  const stale = Object.entries(allowlist.files)
    .map(([file, allowed]) => ({ file, allowed, actual: files[file] ?? 0 }))
    .filter((entry) => entry.actual < entry.allowed)
    .sort((a, b) => a.file.localeCompare(b.file));
  return { total, files, regressions, stale };
}
