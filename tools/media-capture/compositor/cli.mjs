import { relative, resolve } from "node:path";
import {
  transientOutputRoot,
} from "../paths.mjs";

export const defaultStoryboardOutputRoot = resolve(
  transientOutputRoot,
  "storyboards",
);

export function assertStoryboardOutputRoot(outputRoot) {
  const pathFromDefault = relative(defaultStoryboardOutputRoot, outputRoot);
  if (
    pathFromDefault === ".." ||
    pathFromDefault.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    resolve(defaultStoryboardOutputRoot, pathFromDefault) !== resolve(outputRoot)
  ) {
    throw new Error(
      "--output-root must stay within output/playwright/storyboards",
    );
  }
}

export function assertStoryboardCaptureRoot(captureRoot) {
  const pathFromDefault = relative(transientOutputRoot, captureRoot);
  if (
    pathFromDefault === ".." ||
    pathFromDefault.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    resolve(transientOutputRoot, pathFromDefault) !== resolve(captureRoot)
  ) {
    throw new Error(
      "--capture-root must stay within output/playwright",
    );
  }
}

function optionValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseStoryboardArgs(argv) {
  const options = {
    captureRoot: transientOutputRoot,
    locale: "en",
    list: false,
    outputRoot: defaultStoryboardOutputRoot,
    render: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--list") options.list = true;
    else if (argument === "--render") options.render = true;
    else if (argument === "--storyboard") {
      options.storyboardId = optionValue(argv, ++index, argument);
    } else if (argument === "--target") {
      options.targetId = optionValue(argv, ++index, argument);
    } else if (argument === "--locale") {
      options.locale = optionValue(argv, ++index, argument);
    } else if (argument === "--capture-root") {
      options.captureRoot = resolve(optionValue(argv, ++index, argument));
    } else if (argument === "--output-root") {
      options.outputRoot = resolve(optionValue(argv, ++index, argument));
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  assertStoryboardCaptureRoot(options.captureRoot);
  assertStoryboardOutputRoot(options.outputRoot);
  if (!options.list && !options.help) {
    if (!options.storyboardId) throw new Error("--storyboard is required");
    if (!options.targetId) throw new Error("--target is required");
  }
  return options;
}

export function storyboardHelp() {
  return [
    "Dure product media storyboard compositor",
    "",
    "Usage:",
    "  node tools/media-capture/storyboard.mjs --list",
    "  node tools/media-capture/storyboard.mjs --storyboard <id> --target <id> [--locale en] [--render]",
    "",
    "Options:",
    "  --render               render through the isolated Remotion adapter",
    "  --capture-root <path>  captured source root (default: output/playwright)",
    "  --output-root <path>   transient output root (default: output/playwright/storyboards)",
    "  --locale <locale>      localized overlay copy (default: en)",
  ].join("\n");
}
