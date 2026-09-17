#!/usr/bin/env node

import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomically } from "./atomic-json.mjs";
import { storyboardById } from "./compositor/catalog.mjs";
import {
  storyboardOutputPaths,
  storyboardPathsInDirectory,
} from "./compositor/output.mjs";
import { analyzeStoryboardRender } from "./compositor/review-render.mjs";
import { reviewFrameEvidence } from "./compositor/review-evidence.mjs";
import { parseReviewArgs, reviewHelp } from "./compositor/review-cli.mjs";
import { withAtomicStoryboardGeneration } from "./compositor/storyboard-generation.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function runStoryboardReview(
  options,
  {
    allowedRoot = repoRoot,
    analyzeRender = analyzeStoryboardRender,
  } = {},
) {
  const storyboard = storyboardById(options.storyboardId);
  if (!Object.hasOwn(storyboard.copy, options.locale)) {
    throw new Error(`unknown locale ${options.locale} for ${storyboard.id}`);
  }
  const target = storyboard.targets.find(({ id }) => id === options.targetId);
  if (!target) throw new Error(`unknown target ${options.targetId} for ${storyboard.id}`);
  const paths = storyboardOutputPaths({
    outputRoot: options.outputRoot,
    storyboardId: storyboard.id,
    locale: options.locale,
    target,
  });
  const baselinePath = resolve(
    options.baselineRoot,
    `${storyboard.id}.${target.id}.${options.locale}.json`,
  );
  const generation = await withAtomicStoryboardGeneration(
    {
      allowedRoot,
      outputParent: resolve(options.outputRoot, storyboard.id, options.locale),
      targetId: target.id,
      seedExisting: true,
    },
    async ({ stagingDirectory }) => {
      const stagingPaths = storyboardPathsInDirectory({
        directory: stagingDirectory,
        storyboardId: storyboard.id,
        locale: options.locale,
        target,
      });
      const reviewDirectory = resolve(stagingDirectory, "review");
      try {
        await rm(reviewDirectory, { recursive: true, force: true });
        await mkdir(reviewDirectory, { mode: 0o700 });
        const [plan, baseline] = await Promise.all([
          readOptionalJson(stagingPaths.plan),
          readOptionalJson(baselinePath),
        ]);
        if (!plan) throw new Error(`render plan not found: ${paths.plan}`);
        const analysis = await analyzeRender({
          plan,
          mediaPath: stagingPaths.media,
          reviewDirectory,
          baseline,
          tesseractBinary: options.ocr
            ? process.env.DURE_MEDIA_TESSERACT_BIN || "tesseract"
            : null,
        });
        const candidatePath = resolve(
          reviewDirectory,
          "baseline-candidate.json",
        );
        await writeJsonAtomically(candidatePath, analysis.candidate, {
          allowedRoot,
        });
        let evidencePath = null;
        if (analysis.evidence) {
          evidencePath = resolve(reviewDirectory, "review-evidence.json");
          await writeJsonAtomically(evidencePath, analysis.evidence, {
            allowedRoot,
          });
        }
        return {
          status: baseline ? "approved-baseline-pass" : "baseline-candidate",
          baselinePath,
          candidatePath: resolve(paths.directory, "review", "baseline-candidate.json"),
          evidencePath: evidencePath
            ? resolve(paths.directory, "review", "review-evidence.json")
            : null,
          keyframes: analysis.frames.map(reviewFrameEvidence),
          blankFrameScan: analysis.blankFrameScan,
        };
      } catch (reviewError) {
        await rm(reviewDirectory, { recursive: true, force: true });
        return { reviewError };
      }
    },
  );
  if (generation.value.reviewError) throw generation.value.reviewError;
  return generation.value;
}

async function main() {
  const options = parseReviewArgs(process.argv.slice(2));
  if (options.help) {
    console.log(reviewHelp());
    return;
  }
  console.log(JSON.stringify(await runStoryboardReview(options), null, 2));
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
