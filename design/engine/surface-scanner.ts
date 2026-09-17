// Surface-axis inventory scanner. Reads the product
// tree as data via the repo's own TypeScript compiler API — no type checker, no
// imports from src/ (enforced by engine-isolation.test.ts).

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { SURFACE_ANCHORS, type SurfaceAnchor } from "./anchors.ts";
import type { CoverageError, SurfaceCandidate } from "./types.ts";

const COMPONENT_ROOT = "src/components";

const isComponentName = (name: string) =>
  /^[A-Z][A-Za-z0-9]*$/.test(name) && /[a-z]/.test(name);

function walkTsx(dir: string, out: string[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isSymbolicLink()) continue; // dangling links must not crash the gate
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsx(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) {
      out.push(full);
    }
  }
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.ES2022,
    false,
    ts.ScriptKind.TSX,
  );
}

const hasExportModifier = (node: ts.HasModifiers) =>
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

/** Exported PascalCase value identifiers in one file (type-only exports skipped). */
export function exportedComponentNames(source: ts.SourceFile): string[] {
  const names = new Set<string>();
  for (const stmt of source.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      if (isComponentName(stmt.name.text)) names.add(stmt.name.text);
    } else if (ts.isClassDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      // React error boundaries must be classes — a PascalCase exported class is
      // a surface candidate like any function component (AppErrorBoundary).
      if (isComponentName(stmt.name.text)) names.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && isComponentName(decl.name.text)) {
          names.add(decl.name.text);
        }
      }
    } else if (
      ts.isExportDeclaration(stmt) &&
      !stmt.isTypeOnly &&
      stmt.exportClause &&
      ts.isNamedExports(stmt.exportClause)
    ) {
      for (const el of stmt.exportClause.elements) {
        if (!el.isTypeOnly && isComponentName(el.name.text)) names.add(el.name.text);
      }
    }
  }
  return [...names];
}

function importSpecifiers(source: ts.SourceFile): string[] {
  const specs: string[] = [];
  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      specs.push(stmt.moduleSpecifier.text);
    }
  }
  return specs;
}

/**
 * What a registry file references: statically imported component names plus
 * dynamically imported component module paths (React.lazy registries use
 * `import("@/components/...")`, which is a CallExpression, not an import decl).
 */
function registryReferences(source: ts.SourceFile): { names: string[]; modules: string[] } {
  const names: string[] = [];
  const modules: string[] = [];
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const module = stmt.moduleSpecifier.text;
    if (!module.startsWith("@/components/") && !module.startsWith("./") && !module.startsWith("../")) {
      continue;
    }
    const clause = stmt.importClause;
    if (!clause) continue;
    if (clause.name && isComponentName(clause.name.text)) names.push(clause.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) {
        if (isComponentName(el.name.text)) names.push(el.name.text);
      }
    }
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text.startsWith("@/components/")
    ) {
      modules.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { names, modules };
}

function matchImportAnchors(specs: string[]): SurfaceAnchor[] {
  return SURFACE_ANCHORS.filter((a) => {
    if (a.ruleType !== "import-of") return false;
    if (a.params.module) return specs.includes(a.params.module);
    if (a.params.modulePrefix) {
      const prefix = a.params.modulePrefix;
      return specs.some((s) => s === prefix || s.startsWith(`${prefix}/`) || s.startsWith(`@${prefix}`));
    }
    return false;
  });
}

export interface SurfaceScan {
  candidates: SurfaceCandidate[];
  errors: CoverageError[];
  /** anchorId → match count, for dead-anchor reporting */
  anchorMatches: Record<string, number>;
}

export function scanSurfaces(repoRoot: string): SurfaceScan {
  const componentDir = join(repoRoot, COMPONENT_ROOT);
  const files: string[] = [];
  walkTsx(componentDir, files);

  const anchorMatches: Record<string, number> = {};
  for (const a of SURFACE_ANCHORS) anchorMatches[a.anchorId] = 0;

  // registry-file anchors: from the registry's imports, name → kind (static) and
  // component-module file prefix → kind (dynamic import() registries)
  const registryKinds = new Map<string, { anchorId: string; surfaceKind: string }>();
  const registryModuleKinds = new Map<string, { anchorId: string; surfaceKind: string }>();
  for (const a of SURFACE_ANCHORS) {
    if (a.ruleType !== "registry-file") continue;
    const file = join(repoRoot, a.params.file);
    let source: ts.SourceFile;
    try {
      source = parse(file);
    } catch {
      continue; // dead anchor: reported as 0 matches
    }
    const refs = registryReferences(source);
    for (const name of refs.names) {
      registryKinds.set(name, { anchorId: a.anchorId, surfaceKind: a.surfaceKind });
    }
    for (const module of refs.modules) {
      const filePrefix = module.replace(/^@\//, "src/");
      registryModuleKinds.set(filePrefix, { anchorId: a.anchorId, surfaceKind: a.surfaceKind });
    }
  }

  const byId = new Map<string, SurfaceCandidate>();
  const errors: CoverageError[] = [];

  for (const file of files) {
    const rel = relative(repoRoot, file).split("\\").join("/");
    const relToComponents = relative(componentDir, file).split("\\").join("/");
    const cluster = relToComponents.includes("/") ? relToComponents.split("/")[0] : "root";
    const source = parse(file);
    const specs = importSpecifiers(source);
    const importAnchors = matchImportAnchors(specs);
    for (const a of importAnchors) anchorMatches[a.anchorId] += 1;

    const fileRegistry = registryModuleKinds.get(rel.replace(/\.tsx$/, ""));
    for (const name of exportedComponentNames(source)) {
      const id = `surface:${cluster}/${name}`;
      const registry = registryKinds.get(name) ?? fileRegistry;
      const anchors = [
        "domain-cluster",
        ...importAnchors.map((a) => a.anchorId),
        ...(registry ? [registry.anchorId] : []),
      ];
      const surfaceKind = registry?.surfaceKind ?? importAnchors[0]?.surfaceKind ?? "component";
      const existing = byId.get(id);
      if (existing && existing.file !== rel) {
        errors.push({
          code: "id-collision",
          message: `${id} is exported by both ${existing.file} and ${rel}; curate via design/inventory.overrides.yaml`,
          file: rel,
        });
        continue;
      }
      if (registry) anchorMatches[registry.anchorId] += 1;
      anchorMatches["domain-cluster"] += 1;
      byId.set(id, { id, cluster, name, file: rel, anchors, surfaceKind });
    }
  }

  return {
    candidates: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    errors,
    anchorMatches,
  };
}
