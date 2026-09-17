import { resolve } from "node:path";
import {
  assertStoryboardOutputRoot,
  defaultStoryboardOutputRoot,
} from "./cli.mjs";

export const defaultReviewBaselineRoot = resolve(
  import.meta.dirname,
  "review-baselines",
);

function optionValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseReviewArgs(argv) {
  const options = {
    baselineRoot: defaultReviewBaselineRoot,
    locale: "en",
    ocr: false,
    outputRoot: defaultStoryboardOutputRoot,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--ocr") options.ocr = true;
    else if (argument === "--storyboard") {
      options.storyboardId = optionValue(argv, ++index, argument);
    } else if (argument === "--target") {
      options.targetId = optionValue(argv, ++index, argument);
    } else if (argument === "--locale") {
      options.locale = optionValue(argv, ++index, argument);
    } else if (argument === "--output-root") {
      options.outputRoot = resolve(optionValue(argv, ++index, argument));
    } else if (argument === "--baseline-root") {
      options.baselineRoot = resolve(optionValue(argv, ++index, argument));
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  assertStoryboardOutputRoot(options.outputRoot);
  if (!options.help) {
    if (!options.storyboardId) throw new Error("--storyboard is required");
    if (!options.targetId) throw new Error("--target is required");
  }
  return options;
}

export function reviewHelp() {
  return [
    "Review a rendered Dure storyboard",
    "",
    "Usage:",
    "  node tools/media-capture/review-storyboard.mjs --storyboard <id> --target <id> [--locale en] [--ocr]",
    "",
    "The first run writes an ignored perceptual-baseline candidate. Review its",
    "PNG keyframes before promoting that JSON into the tracked baseline folder.",
    "All render and review output stays below output/playwright/.",
  ].join("\n");
}
