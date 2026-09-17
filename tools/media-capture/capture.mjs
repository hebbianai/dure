#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureHelp, parseCaptureArgs } from "./cli.mjs";
import { captureScenario } from "./runtime/browser-capture.mjs";
import { captureProofNeedsNativeTauri } from "./runtime/capture-proof.mjs";
import {
  MEDIA_CAPTURE_SCENARIOS,
  scenarioById,
} from "./scenarios.mjs";

export { captureHelp, parseCaptureArgs } from "./cli.mjs";

function listScenarios() {
  return MEDIA_CAPTURE_SCENARIOS.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    durationMs: scenario.durationMs,
    stillAtMs: scenario.stillAtMs,
    captureProof: scenario.captureProof ?? null,
    readmeGif: scenario.readmeGif ?? null,
    publicWebm: scenario.publicWebm ?? null,
    captureStage: scenario.captureStage,
    viewport: scenario.viewport,
  }));
}

export function selectCaptureScenarios(options) {
  if (!options.allScenarios) return [scenarioById(options.scenarioId)];
  return options.format === "gif"
    ? MEDIA_CAPTURE_SCENARIOS.filter((scenario) => scenario.readmeGif)
    : MEDIA_CAPTURE_SCENARIOS.filter(
        (scenario) => !captureProofNeedsNativeTauri(scenario),
      );
}

async function main() {
  const options = parseCaptureArgs(process.argv.slice(2));
  if (options.help) {
    console.log(captureHelp());
    return;
  }
  if (options.list) {
    console.log(JSON.stringify(listScenarios(), null, 2));
    return;
  }
  if (!options.scenarioId && !options.allScenarios) {
    throw new Error("--scenario or --all-scenarios is required unless --list is used");
  }
  const scenarios = selectCaptureScenarios(options);
  if (!scenarios[0]) {
    throw new Error(
      options.allScenarios
        ? "no scenarios declare a readmeGif recipe"
        : `unknown scenario ${options.scenarioId}; use --list to inspect available scenarios`,
    );
  }
  const results = [];
  let catalogBuild;
  for (const scenario of scenarios) {
    const result = await captureScenario(
      { ...options, expectedApplicationBuild: catalogBuild },
      scenario,
    );
    catalogBuild ??= result.applicationBuild;
    results.push(result);
  }
  console.log(
    JSON.stringify(options.allScenarios ? results : results[0], null, 2),
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}
