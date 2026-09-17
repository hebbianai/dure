#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { publishArchitectureBaseline } from "./lib/architecture-baseline-publication.mjs";
import {
  evaluateArchitectureFitness,
  planArchitectureRatchet,
} from "./lib/architecture-fitness.mjs";

const root = path.resolve(process.cwd());
const baselinePath = path.join(
  root,
  "scripts/architecture-fitness-baseline.json",
);
const baselineSource = fs.readFileSync(baselinePath, "utf8");
const currentBaseline = JSON.parse(baselineSource);
const plan = planArchitectureRatchet(root, currentBaseline);
const violations = evaluateArchitectureFitness(root, plan.baseline);

if (violations.length > 0) {
  console.error("Architecture baseline ratchet refused:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

if (plan.changes.length === 0) {
  console.log("Architecture baseline ratchet has no eligible reductions.");
  process.exit(0);
}

publishArchitectureBaseline({
  root,
  expectedSource: baselineSource,
  baseline: plan.baseline,
});

console.log("Architecture baseline ratcheted:");
for (const change of plan.changes) {
  const next = change.nextAllowed ?? "removed";
  console.log(
    `- ${change.filename}: ${change.previousAllowed} -> ${next} (current ${change.count})`,
  );
}
