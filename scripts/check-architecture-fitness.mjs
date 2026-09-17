#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import {
  evaluateArchitectureFitness,
  godFileGrowthViolations,
  readArchitectureBaseline,
  scanArchitecture,
} from "./lib/architecture-fitness.mjs";
import {
  architectureFitnessBaseSha,
  readGodFileLinesAtRevision,
} from "./lib/architecture-fitness-base.mjs";
import { orphanModuleViolations } from "./lib/orphan-modules.mjs";
import { productMediaBoundaryViolations } from "./lib/product-media-boundary.mjs";

const root = path.resolve(process.cwd());
if (process.argv.includes("--print-current")) {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, ...scanArchitecture(root) }, null, 2)}\n`,
  );
  process.exit(0);
}

const current = scanArchitecture(root);
const baseSha = architectureFitnessBaseSha();
const baseGodFileLines = baseSha
  ? readGodFileLinesAtRevision(
      root,
      baseSha,
      Object.keys(current.godFileLines),
    )
  : null;
const violations = [
  ...productMediaBoundaryViolations(root),
  ...orphanModuleViolations(root),
  ...evaluateArchitectureFitness(
    root,
    readArchitectureBaseline(root),
    current,
  ),
  ...(baseGodFileLines
    ? godFileGrowthViolations(current.godFileLines, baseGodFileLines)
    : []),
];
if (violations.length > 0) {
  console.error("Architecture fitness gate failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}
console.log("Architecture fitness gate passed.");
