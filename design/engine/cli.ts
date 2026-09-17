// pnpm design:coverage — CLI entry.
// Flags: --json (print envelope), --check (gate mode), --write-baseline (init/refresh
// the shrink-only baseline; shrink-only discipline is enforced by review + gate, this
// flag is for initialization and explicit shrink commits).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDashboardHtml, mockupFreshness } from "./dashboard.ts";
import {
  GENERATED_DIR,
  buildEnvelope,
  check,
  loadBaseline,
  writeBaseline,
  writeEnvelope,
} from "./envelope.ts";
import { scanEvidence } from "./evidence.ts";
import { judge, loadOverrides } from "./judge.ts";
import { scanRawColors } from "./raw-color-scanner.ts";
import { scanSurfaces } from "./surface-scanner.ts";
import { scanDocumentedTokens, scanTokens } from "./token-scanner.ts";
import type { CoverageItem, Envelope } from "./types.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

function pct(items: CoverageItem[]): string {
  if (items.length === 0) return "n/a";
  const covered = items.filter((i) => i.verdict === "covered").length;
  return `${covered}/${items.length} (${Math.round((covered / items.length) * 100)}%)`;
}

function report(envelope: Envelope): string {
  const lines: string[] = [];
  lines.push("design inventory and token checks");
  lines.push(`  source surfaces: ${envelope.surfaces.length}`);
  lines.push(`  optional mockups: ${envelope.mockups.length}`);
  for (const [axis, { items }] of Object.entries(envelope.axes)) {
    lines.push(`  ${axis}: ${pct(items)}`);
  }
  const clusters = new Map<string, number>();
  for (const surface of envelope.surfaces) {
    clusters.set(surface.cluster, (clusters.get(surface.cluster) ?? 0) + 1);
  }
  lines.push("  source clusters:");
  for (const [cluster, count] of [...clusters.entries()].sort()) {
    lines.push(`    ${cluster}: ${count}`);
  }
  lines.push(`  raw colors outside the token system: ${envelope.rawColors.total}`);
  if (envelope.rawColors.stale.length > 0) {
    lines.push(
      `  raw-color allowlist rot (${envelope.rawColors.stale.length}): shrink design/raw-color-allowlist.json — ${envelope.rawColors.stale
        .map((s) => `${s.file} ${s.actual}/${s.allowed}`)
        .join(", ")}`,
    );
  }
  const dead = Object.entries(envelope.anchors).filter(([, n]) => n === 0);
  if (dead.length > 0) {
    lines.push(`  dead anchors (0 matches): ${dead.map(([id]) => id).join(", ")}`);
  }
  const drifted = envelope.axes.token.items.filter((i) => i.detail.drift);
  if (drifted.length > 0) {
    lines.push(`  token drift (${drifted.length}):`);
    for (const item of drifted) lines.push(`    ${item.id}: ${item.detail.drift}`);
  }
  if (envelope.errors.length > 0) {
    lines.push(`  errors (${envelope.errors.length}):`);
    for (const err of envelope.errors) lines.push(`    [${err.code}] ${err.message}`);
  }
  return lines.join("\n");
}

const KNOWN_FLAGS = new Set(["--json", "--check", "--write-baseline", "--init-baseline"]);

async function main() {
  // pnpm forwards the `--` separator itself; it is not a flag.
  const args = new Set(process.argv.slice(2).filter((a) => a !== "--"));
  const unknown = [...args].filter((a) => !KNOWN_FLAGS.has(a));
  if (unknown.length > 0) {
    console.error(`unknown flag(s): ${unknown.join(", ")} (known: ${[...KNOWN_FLAGS].join(", ")})`);
    process.exit(2);
  }
  const wantsBaselineWrite = args.has("--write-baseline") || args.has("--init-baseline");
  if (args.has("--check") && wantsBaselineWrite) {
    // Conflicting intents: one absorbs regressions into the baseline, the
    // other enforces them.
    console.error("--check cannot be combined with --write-baseline/--init-baseline");
    process.exit(2);
  }

  const surfaceScan = scanSurfaces(repoRoot);
  const tokens = await scanTokens(repoRoot);
  const documented = scanDocumentedTokens(repoRoot);
  const evidence = scanEvidence(repoRoot);
  const { overrides, errors: overridesErrors } = loadOverrides(repoRoot);
  const judgment = judge(surfaceScan, tokens, documented, evidence, overrides);
  judgment.errors.push(...overridesErrors);
  const rawColors = scanRawColors(repoRoot);
  judgment.errors.push(...rawColors.regressions);
  const envelope = buildEnvelope(repoRoot, judgment, surfaceScan, tokens, overrides, {
    total: rawColors.total,
    files: rawColors.files,
    stale: rawColors.stale,
  });
  writeEnvelope(repoRoot, envelope);

  if (wantsBaselineWrite) {
    const { file, refusedAdditions } = writeBaseline(repoRoot, envelope, {
      allowGrow: args.has("--init-baseline"),
    });
    if (refusedAdditions.length > 0) {
      console.error("baseline is shrink-only — add evidence, not baseline entries. Refused additions:");
      for (const key of refusedAdditions) console.error(`  ${key}`);
      console.error("(pass --init-baseline only for initialization-phase denominator growth)");
      process.exit(1);
    }
    console.log(`baseline written: ${file}`);
    return;
  }

  // --json selects the output format only; --check always evaluates the gate.
  const { baseline, errors: baselineErrors } = loadBaseline(repoRoot);
  const result = check(envelope, baseline, baselineErrors);
  const dashboard = buildDashboardHtml(
    envelope,
    result,
    mockupFreshness(repoRoot, judgment.mockups),
  );
  const dashboardDir = join(repoRoot, GENERATED_DIR);
  mkdirSync(dashboardDir, { recursive: true });
  writeFileSync(join(dashboardDir, "coverage-dashboard.html"), dashboard);
  if (args.has("--json")) {
    console.log(JSON.stringify(envelope, null, 2));
  } else {
    console.log(report(envelope));
    if (result.shrinkable.length > 0) {
      console.log(
        `  baseline shrinkable (${result.shrinkable.length}): now covered or gone — remove from design/design-coverage-baseline.json`,
      );
    }
  }
  if (args.has("--check")) {
    if (result.newUncovered.length > 0) {
      console.error(`new uncovered tokens (update the token contract, not baseline entries):`);
      for (const id of result.newUncovered) console.error(`  ${id}`);
    }
    for (const err of result.errors) console.error(`[${err.code}] ${err.message}`);
    if (!result.ok) process.exit(1);
  }
}

await main();
