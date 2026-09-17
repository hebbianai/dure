// Envelope assembly + baseline check.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
// Engine isolation forbids src/ imports; scripts/lib is the sanctioned shared
// layer for Git environment hygiene (AGENTS.md hook-launched verification rule).
import { withoutLocalGitOverrides } from "../../scripts/lib/git-environment.mjs";
import type { Judgment } from "./judge.ts";
import type { SurfaceScan } from "./surface-scanner.ts";
import {
  BASELINE_SCHEMA_VERSION,
  type Baseline,
  type CoverageError,
  type CoverageItem,
  ENVELOPE_SCHEMA_VERSION,
  type Envelope,
  type Overrides,
  type TokenInventory,
} from "./types.ts";

const BASELINE_FILE = "design/design-coverage-baseline.json";
/** Single path authority for every generated artifact (envelope, dashboard). */
export const GENERATED_DIR = "design/.generated";

function git(repoRoot: string, args: string[]): string {
  const result = spawnSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    env: withoutLocalGitOverrides(),
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

// Flat draft of the DTCG-shaped payload: real $type derivation and light/dark
// values, no fabricated fields. Nested group paths and DTCG mode/theming
// representation are deferred to the adapter/productization step.
export function tokensToDtcg(tokens: TokenInventory): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const light = new Map<string, string>();
  const dark = new Map<string, string>();
  const scopes = new Map<string, Set<string>>();
  for (const decl of tokens.declarations) {
    if ((decl.scope === "root" || decl.scope === "theme-inline") && !light.has(decl.name)) {
      light.set(decl.name, decl.value);
    }
    if (decl.scope === "dark" && !dark.has(decl.name)) dark.set(decl.name, decl.value);
    scopes.set(decl.name, (scopes.get(decl.name) ?? new Set()).add(decl.scope));
  }
  const typeOf = (value: string): string | null => {
    if (/^(#|oklch\(|rgb\(|hsl\()/i.test(value)) return "color";
    if (/^-?[\d.]+(px|rem|em|%)$/.test(value)) return "dimension";
    return null;
  };
  for (const name of tokens.names) {
    const value = light.get(name) ?? dark.get(name) ?? "";
    const entry: Record<string, unknown> = { $value: value };
    const type = typeOf(value);
    if (type) entry.$type = type;
    // Scopes let consumers (Token Inspector) tell the sub-ms runtime path
    // (:root/.dark) from build-time @theme tokens honestly.
    const extensions: Record<string, unknown> = {
      "app.dure.scopes": [...(scopes.get(name) ?? [])].sort(),
    };
    const darkValue = dark.get(name);
    if (darkValue !== undefined && darkValue !== value) {
      extensions["app.dure.dark"] = darkValue;
    }
    entry.$extensions = extensions;
    out[name.replace(/^--/, "")] = entry;
  }
  return out;
}

export function buildEnvelope(
  repoRoot: string,
  judgment: Judgment,
  surfaceScan: SurfaceScan,
  tokens: TokenInventory,
  overrides: Overrides,
  rawColors: Envelope["rawColors"] = { total: 0, files: {}, stale: [] },
): Envelope {
  return {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceCommit: git(repoRoot, ["rev-parse", "HEAD"]),
    dirty: git(repoRoot, ["status", "--porcelain"]).length > 0,
    axes: {
      token: { items: judgment.tokenItems },
    },
    surfaces: judgment.surfaces,
    mockups: judgment.mockups,
    aliases: overrides.surface.renamedFrom,
    anchors: surfaceScan.anchorMatches,
    excluded: judgment.excluded,
    errors: judgment.errors,
    tokensDtcg: tokensToDtcg(tokens),
    rawColors,
  };
}

export function writeEnvelope(repoRoot: string, envelope: Envelope): string {
  const dir = join(repoRoot, GENERATED_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "design-coverage.json");
  writeFileSync(file, `${JSON.stringify(envelope, null, 2)}\n`);
  return file;
}

export function allItems(envelope: Envelope): CoverageItem[] {
  return Object.values(envelope.axes).flatMap((axis) => axis.items);
}

export function loadBaseline(repoRoot: string): { baseline: Baseline; errors: CoverageError[] } {
  const file = join(repoRoot, BASELINE_FILE);
  if (!existsSync(file)) {
    return { baseline: { schemaVersion: BASELINE_SCHEMA_VERSION, uncovered: [] }, errors: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Baseline;
    if (parsed.schemaVersion !== BASELINE_SCHEMA_VERSION) {
      return {
        baseline: { schemaVersion: BASELINE_SCHEMA_VERSION, uncovered: [] },
        errors: [
          {
            code: "invalid-baseline",
            message: `${BASELINE_FILE}: unsupported schemaVersion ${parsed.schemaVersion}`,
          },
        ],
      };
    }
    // Only token debt remains. Screen/state keys are retired, not new debt.
    const keyGrammar = /^token:[^#\s]+$/;
    const errors: CoverageError[] = [];
    for (const key of parsed.uncovered) {
      if (!keyGrammar.test(key)) {
        errors.push({
          code: "invalid-baseline",
          message: `${BASELINE_FILE}: key \`${key}\` must be a token:<name> key without a state facet (fail-closed)`,
        });
      }
    }
    return { baseline: parsed, errors };
  } catch (cause) {
    return {
      baseline: { schemaVersion: BASELINE_SCHEMA_VERSION, uncovered: [] },
      errors: [{ code: "invalid-baseline", message: `${BASELINE_FILE}: unreadable (${cause})` }],
    };
  }
}

/**
 * Baseline writes are shrink-only: refuse any write that would ADD keys
 * unless `allowGrow` (--init-baseline) is explicitly passed — e.g. when a sync
 * imports pre-gate components from main during the initialization phase.
 */
export function writeBaseline(
  repoRoot: string,
  envelope: Envelope,
  options?: { allowGrow?: boolean },
): { file: string; refusedAdditions: string[] } {
  const uncovered = allItems(envelope)
    .filter((item) => item.verdict === "uncovered")
    .map((item) => item.id)
    .sort();
  const file = join(repoRoot, BASELINE_FILE);
  if (!options?.allowGrow && existsSync(file)) {
    try {
      const existing = new Set((JSON.parse(readFileSync(file, "utf8")) as Baseline).uncovered);
      const additions = uncovered.filter((key) => !existing.has(key));
      if (additions.length > 0) return { file, refusedAdditions: additions };
    } catch {
      return { file, refusedAdditions: ["<existing baseline unreadable — fix or pass --init-baseline>"] };
    }
  }
  writeFileSync(
    file,
    `${JSON.stringify({ schemaVersion: BASELINE_SCHEMA_VERSION, uncovered }, null, 2)}\n`,
  );
  return { file, refusedAdditions: [] };
}

export interface CheckResult {
  ok: boolean;
  newUncovered: string[];
  shrinkable: string[];
  errors: CoverageError[];
}

/** Gate mode: errors always fail; uncovered items fail unless baselined (shrink-only). */
export function check(envelope: Envelope, baseline: Baseline, baselineErrors: CoverageError[]): CheckResult {
  const baselineSet = new Set(baseline.uncovered);
  const items = allItems(envelope);
  const uncoveredNow = new Set(items.filter((i) => i.verdict === "uncovered").map((i) => i.id));
  const liveIds = new Set(items.map((i) => i.id));
  const newUncovered = [...uncoveredNow].filter((id) => !baselineSet.has(id)).sort();
  const shrinkable = baseline.uncovered
    .filter((id) => !uncoveredNow.has(id) || !liveIds.has(id))
    .sort();
  const errors = [...envelope.errors, ...baselineErrors];
  return { ok: errors.length === 0 && newUncovered.length === 0, newUncovered, shrinkable, errors };
}
