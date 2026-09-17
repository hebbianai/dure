#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomically } from "./atomic-json.mjs";
import { MEDIA_STORYBOARDS, storyboardById } from "./compositor/catalog.mjs";
import {
  parseStoryboardArgs,
  storyboardHelp,
} from "./compositor/cli.mjs";
import { compileStoryboard } from "./compositor/compile.mjs";
import {
  storyboardPathsInDirectory,
  storyboardOutputPaths,
} from "./compositor/output.mjs";
import { remotionPropsFromRenderPlan } from "./compositor/remotion-props.mjs";
import { withAtomicStoryboardGeneration } from "./compositor/storyboard-generation.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

export function listStoryboards() {
  return MEDIA_STORYBOARDS.map((storyboard) => ({
    id: storyboard.id,
    title: storyboard.title,
    locales: Object.keys(storyboard.copy),
    sources: storyboard.sources,
    targets: storyboard.targets,
  }));
}

export async function runStoryboard(options, progress = () => {}) {
  const storyboard = storyboardById(options.storyboardId);
  const plan = await compileStoryboard({
    storyboard,
    locale: options.locale,
    targetId: options.targetId,
    captureRoot: options.captureRoot,
  });
  const paths = storyboardOutputPaths({
    outputRoot: options.outputRoot,
    storyboardId: storyboard.id,
    locale: options.locale,
    target: plan.target,
  });
  if (!options.render) {
    return { plan, paths, render: null };
  }
  const [{ renderStoryboardWithRemotion }, remotionPlan] = await Promise.all([
    import("./compositor/remotion/render.mjs"),
    Promise.resolve(remotionPropsFromRenderPlan(plan)),
  ]);
  const generation = await withAtomicStoryboardGeneration({
    allowedRoot: repoRoot,
    outputParent: resolve(options.outputRoot, storyboard.id, options.locale),
    targetId: plan.target.id,
  }, async ({ stagingDirectory }) => {
    const stagingPaths = storyboardPathsInDirectory({
      directory: stagingDirectory,
      storyboardId: storyboard.id,
      locale: options.locale,
      target: plan.target,
    });
    await writeJsonAtomically(stagingPaths.plan, plan, { allowedRoot: repoRoot });
    return renderStoryboardWithRemotion({
      plan: remotionPlan,
      captureRoot: options.captureRoot,
      outputPath: stagingPaths.media,
      publishedOutputPath: paths.media,
      progress,
    });
  });
  return { plan, paths, render: generation.value };
}

async function main() {
  const options = parseStoryboardArgs(process.argv.slice(2));
  if (options.help) {
    console.log(storyboardHelp());
    return;
  }
  if (options.list) {
    console.log(JSON.stringify(listStoryboards(), null, 2));
    return;
  }
  const result = await runStoryboard(options, (message) =>
    console.error(`[storyboard] ${message}`),
  );
  console.log(JSON.stringify(result, null, 2));
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
