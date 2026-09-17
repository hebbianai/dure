// Source inventory, optional mockup validation and token-value judgment.
// Mechanical, local and offline; screen prose is not a verification input.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { tokenValuesEquivalent } from "./color.ts";
import type { EvidenceScan } from "./evidence.ts";
import type { SurfaceScan } from "./surface-scanner.ts";
import {
  type CoverageError,
  type CoverageItem,
  type DocumentedToken,
  type MockupEvidence,
  type Overrides,
  type SurfaceCandidate,
  type TokenInventory,
} from "./types.ts";

const OVERRIDES_FILE = "design/inventory.overrides.yaml";

function closeMatchHint(key: string, allowed: Iterable<string>): string {
  for (const candidate of allowed) {
    if (
      candidate.startsWith(key) ||
      key.startsWith(candidate) ||
      candidate.replace(/s$/, "") === key.replace(/s$/, "")
    ) {
      return ` (did you mean \`${candidate}\`?)`;
    }
  }
  return "";
}

export function loadOverrides(repoRoot: string): { overrides: Overrides; errors: CoverageError[] } {
  const empty: Overrides = {
    schemaVersion: 1,
    surface: { exclude: {}, merge: {}, renamedFrom: {} },
    token: { exclude: {} },
  };
  const file = join(repoRoot, OVERRIDES_FILE);
  if (!existsSync(file)) return { overrides: empty, errors: [] };
  const errors: CoverageError[] = [];
  let data: Record<string, unknown>;
  try {
    data = (parseYaml(readFileSync(file, "utf8")) ?? {}) as Record<string, unknown>;
  } catch (cause) {
    return {
      overrides: empty,
      errors: [{ code: "invalid-overrides", message: `${OVERRIDES_FILE}: not valid YAML (${cause})` }],
    };
  }
  const allowedTop = new Set(["schemaVersion", "surface", "token"]);
  for (const key of Object.keys(data)) {
    if (!allowedTop.has(key) && !key.startsWith("x-")) {
      errors.push({
        code: "invalid-overrides",
        message: `${OVERRIDES_FILE}: unknown key \`${key}\`${closeMatchHint(key, allowedTop)} (axis-namespaced keys only)`,
      });
    }
  }
  const surface = (data.surface ?? {}) as Record<string, unknown>;
  const token = (data.token ?? {}) as Record<string, unknown>;
  for (const [axisName, axisData, allowed] of [
    ["surface", surface, new Set(["exclude", "merge", "renamedFrom"])],
    ["token", token, new Set(["exclude"])],
  ] as const) {
    for (const key of Object.keys(axisData)) {
      if (!allowed.has(key) && !key.startsWith("x-")) {
        errors.push({
          code: "invalid-overrides",
          message: `${OVERRIDES_FILE}: unknown ${axisName} key \`${key}\`${closeMatchHint(key, allowed)}`,
        });
      }
    }
  }
  // Entry keys inside each section must carry the section's own axis prefix —
  // a typo'd or wrong-axis id would otherwise be dead configuration.
  const requirePrefix = (section: Record<string, unknown>, sectionName: string, prefix: string) => {
    for (const key of Object.keys(section)) {
      if (!key.startsWith(prefix)) {
        errors.push({
          code: "invalid-overrides",
          message: `${OVERRIDES_FILE}: ${sectionName} entry \`${key}\` must start with \`${prefix}\``,
        });
      }
    }
  };
  const surfaceExclude = (surface.exclude ?? {}) as Record<string, string>;
  const surfaceMerge = (surface.merge ?? {}) as Record<string, { members: string[] }>;
  const surfaceRenamed = (surface.renamedFrom ?? {}) as Record<string, string>;
  const tokenExclude = (token.exclude ?? {}) as Record<string, string>;
  requirePrefix(surfaceExclude, "surface.exclude", "surface:");
  requirePrefix(surfaceMerge, "surface.merge", "surface:");
  requirePrefix(surfaceRenamed, "surface.renamedFrom", "surface:");
  requirePrefix(tokenExclude, "token.exclude", "token:");
  return {
    overrides: {
      schemaVersion: (data.schemaVersion as number) ?? 1,
      surface: { exclude: surfaceExclude, merge: surfaceMerge, renamedFrom: surfaceRenamed },
      token: { exclude: tokenExclude },
    },
    errors,
  };
}

export interface Judgment {
  surfaces: SurfaceCandidate[];
  mockups: MockupEvidence[];
  tokenItems: CoverageItem[];
  excluded: { id: string; reason: string }[];
  errors: CoverageError[];
}

function applySurfaceOverrides(
  candidates: SurfaceCandidate[],
  overrides: Overrides,
  errors: CoverageError[],
): { surfaces: SurfaceCandidate[]; excluded: { id: string; reason: string }[] } {
  const excluded: { id: string; reason: string }[] = [];
  const memberOf = new Map<string, string>();
  for (const [curatedId, def] of Object.entries(overrides.surface.merge)) {
    for (const member of def.members ?? []) memberOf.set(member, curatedId);
  }
  for (const alias of Object.keys(overrides.surface.renamedFrom)) {
    if (candidates.some((c) => c.id === alias)) {
      errors.push({
        code: "invalid-overrides",
        message: `renamedFrom alias \`${alias}\` collides with a live inventory id`,
      });
    }
  }
  const byId = new Map<string, SurfaceCandidate>();
  for (const candidate of candidates) {
    const reason = overrides.surface.exclude[candidate.id];
    if (reason !== undefined) {
      excluded.push({ id: candidate.id, reason });
      continue;
    }
    const curatedId = memberOf.get(candidate.id);
    if (curatedId) {
      if (!byId.has(curatedId)) {
        byId.set(curatedId, { ...candidate, id: curatedId, name: curatedId.split("/").pop() ?? candidate.name });
      }
      continue;
    }
    byId.set(candidate.id, candidate);
  }
  return { surfaces: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)), excluded };
}

export function judge(
  surfaceScan: SurfaceScan,
  tokens: TokenInventory,
  documented: DocumentedToken[],
  evidence: EvidenceScan,
  overrides: Overrides,
): Judgment {
  const errors: CoverageError[] = [...surfaceScan.errors, ...evidence.errors, ...(tokens.scanErrors ?? [])];
  const { surfaces, excluded } = applySurfaceOverrides(surfaceScan.candidates, overrides, errors);
  const surfaceIds = new Set(surfaces.map((s) => s.id));
  const resolvableVars = new Set([...tokens.names, ...tokens.runtimeNames]);

  for (const mockup of evidence.mockups) {
    const id = `surface:${mockup.surfaceLocalId}`;
    if (!surfaceIds.has(id)) {
      errors.push({
        code: "orphan-evidence",
        message: `${mockup.path}: no inventory id \`${id}\` (typo or rename residue)`,
        file: mockup.path,
      });
      continue;
    }
    for (const varName of mockup.vars) {
      if (!resolvableVars.has(varName)) {
        errors.push({
          code: "unresolved-var",
          message: `${mockup.path}: var(${varName}) does not resolve against the token inventory`,
          file: mockup.path,
        });
      }
    }
  }

  const documentedByName = new Map(documented.map((d) => [d.name, d]));
  const declared = new Map<string, { root?: string; dark?: string }>();
  for (const decl of tokens.declarations) {
    const entry = declared.get(decl.name) ?? {};
    // @theme-inline tokens are the light-scope definition for single-scope
    // build-time tokens — without this, a documented value for them could
    // never be compared and the doc row would pass vacuously.
    if ((decl.scope === "root" || decl.scope === "theme-inline") && entry.root === undefined) {
      entry.root = decl.value;
    }
    if (decl.scope === "dark" && entry.dark === undefined) entry.dark = decl.value;
    declared.set(decl.name, entry);
  }

  const tokenItems: CoverageItem[] = [];
  for (const name of tokens.names) {
    const excludeReason = overrides.token.exclude[`token:${name}`];
    if (excludeReason !== undefined) {
      excluded.push({ id: `token:${name}`, reason: excludeReason });
      continue;
    }
    const doc = documentedByName.get(name);
    const decl = declared.get(name) ?? {};
    let covered = false;
    let drift: string | null = null;
    if (doc) {
      // A documented value with no matching declaration scope is drift, not a
      // vacuous pass.
      const lightOk =
        doc.light === null ? true : decl.root !== undefined && tokenValuesEquivalent(doc.light, decl.root);
      const darkOk =
        doc.dark === null ? true : decl.dark !== undefined && tokenValuesEquivalent(doc.dark, decl.dark);
      covered = lightOk && darkOk;
      if (!lightOk) {
        drift =
          decl.root === undefined
            ? `documented light \`${doc.light}\` but no :root/@theme declaration`
            : `documented light \`${doc.light}\` != defined \`${decl.root}\``;
      } else if (!darkOk) {
        drift =
          decl.dark === undefined
            ? `documented dark \`${doc.dark}\` but no .dark declaration`
            : `documented dark \`${doc.dark}\` != defined \`${decl.dark}\``;
      }
    }
    tokenItems.push({
      id: `token:${name}`,
      axis: "token",
      verdict: covered ? "covered" : "uncovered",
      evidence: doc ? [{ kind: "spec", tier: "gating", path: "DESIGN.md" }] : [],
      detail: drift ? { drift } : { documented: doc !== undefined },
    });
  }

  return { surfaces, mockups: evidence.mockups, tokenItems, excluded, errors };
}
