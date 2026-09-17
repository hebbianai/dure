// Token-axis inventory scanner. css-tree parse of the
// token source with scope attribution (duplicate :root/.dark blocks and @theme
// inline make regex infeasible), plus runtime-token enumeration from the theme
// module read as data, plus the DESIGN.md documentation table.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type {
  CoverageError,
  DocumentedToken,
  TokenDeclaration,
  TokenInventory,
  TokenScope,
} from "./types.ts";

const TOKEN_SOURCE = "src/index.css";
const RUNTIME_THEME_MODULE = "src/lib/theme/themeStyle.ts";
const TOKEN_DOC = "DESIGN.md";

interface CssTreeNode {
  type: string;
  name?: string;
  property?: string;
  value?: unknown;
  prelude?: unknown;
}

interface CssTreeModule {
  parse(text: string, options?: Record<string, unknown>): unknown;
  generate(node: unknown): string;
  walk(
    ast: unknown,
    handler: (this: { rule: CssTreeNode | null; atrule: CssTreeNode | null }, node: CssTreeNode) => void,
  ): void;
}

function classifyScope(
  atrule: CssTreeNode | null,
  preludeText: string | null,
): TokenScope {
  if (atrule?.name === "theme") return "theme-inline";
  if (preludeText === null) return "other";
  if (/\.dark\b/.test(preludeText)) return "dark";
  if (/:root\b/.test(preludeText)) return "root";
  return "other";
}

export async function scanTokenDeclarations(
  repoRoot: string,
): Promise<{ declarations: TokenDeclaration[]; scanErrors: CoverageError[] }> {
  // Lazy import: keeps css-tree out of any static import closure that a CLI
  // consumer might pull in (AGENTS.md classify-job rule).
  const csstree = (await import("css-tree")) as unknown as CssTreeModule;
  const text = readFileSync(join(repoRoot, TOKEN_SOURCE), "utf8");
  const ast = csstree.parse(text, { positions: false });
  const declarations: TokenDeclaration[] = [];
  const scanErrors: CoverageError[] = [];
  csstree.walk(ast, function walker(node) {
    // css-tree recovers from unparseable regions by swallowing them into Raw
    // nodes. If a swallowed region looks like it holds custom-property
    // declarations, the inventory silently shrank — fail closed.
    if (node.type === "Raw") {
      const raw = csstree.generate(node);
      if (/--[\w-]+\s*:/.test(raw) && /[;{}]/.test(raw)) {
        scanErrors.push({
          code: "scan-error",
          message: `${TOKEN_SOURCE}: css-tree error recovery swallowed a region containing custom-property declarations (${raw.slice(0, 80)}…) — token inventory would silently shrink`,
          file: TOKEN_SOURCE,
        });
      }
      return;
    }
    if (node.type !== "Declaration") return;
    const property = node.property ?? "";
    if (!property.startsWith("--")) return;
    const preludeText = this.rule?.prelude ? csstree.generate(this.rule.prelude) : null;
    declarations.push({
      name: property,
      scope: classifyScope(this.atrule, preludeText),
      value: csstree.generate(node.value).trim(),
    });
  });
  return { declarations, scanErrors };
}

/** Exact `--token` string literals in the runtime theme module, read as data. */
export function scanRuntimeTokenNames(repoRoot: string): string[] {
  const file = join(repoRoot, RUNTIME_THEME_MODULE);
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ES2022,
    false,
    ts.ScriptKind.TS,
  );
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      /^--[a-z0-9][a-z0-9-]*$/i.test(node.text)
    ) {
      names.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...names].sort();
}

export async function scanTokens(repoRoot: string): Promise<TokenInventory> {
  const { declarations, scanErrors } = await scanTokenDeclarations(repoRoot);
  const names = [...new Set(declarations.map((d) => d.name))].sort();
  return { names, declarations, runtimeNames: scanRuntimeTokenNames(repoRoot), scanErrors };
}

/**
 * Documentation rows from DESIGN.md: markdown table rows whose second code span
 * is the token name, followed by light and dark value code spans.
 */
export function scanDocumentedTokens(repoRoot: string): DocumentedToken[] {
  const text = readFileSync(join(repoRoot, TOKEN_DOC), "utf8");
  const documented: DocumentedToken[] = [];
  for (const line of text.split("\n")) {
    if (!line.trimStart().startsWith("|")) continue;
    const spans = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const nameIndex = spans.findIndex((s) => s.startsWith("--"));
    if (nameIndex === -1) continue;
    documented.push({
      name: spans[nameIndex],
      light: spans[nameIndex + 1] ?? null,
      dark: spans[nameIndex + 2] ?? null,
    });
  }
  return documented;
}
