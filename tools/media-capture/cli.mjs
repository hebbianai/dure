import { resolve } from "node:path";
import { defaultOutputRoot, repoRoot, assertSafeOutputRoot } from "./paths.mjs";

const FORMATS = new Set(["all", "gif", "png", "webm"]);
const PROVIDER_SOURCES = new Set(["live", "fixture"]);

function optionValue(argv, index, option) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseCaptureArgs(argv) {
  const options = {
    format: "all",
    outputRoot: defaultOutputRoot,
    headed: false,
    list: false,
    allScenarios: false,
    providerSource: "live",
    requireLiveProviders: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--list") {
      options.list = true;
    } else if (arg === "--all-scenarios") {
      options.allScenarios = true;
    } else if (arg === "--headed") {
      options.headed = true;
    } else if (arg === "--require-live-providers") {
      options.requireLiveProviders = true;
    } else if (arg === "--scenario") {
      options.scenarioId = optionValue(argv, ++index, arg);
    } else if (arg === "--format") {
      options.format = optionValue(argv, ++index, arg);
    } else if (arg === "--provider-source") {
      options.providerSource = optionValue(argv, ++index, arg);
    } else if (arg === "--output") {
      options.outputRoot = resolve(repoRoot, optionValue(argv, ++index, arg));
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!FORMATS.has(options.format)) {
    throw new Error("--format must be one of: all, gif, png, webm");
  }
  if (!PROVIDER_SOURCES.has(options.providerSource)) {
    throw new Error("--provider-source must be one of: live, fixture");
  }
  if (options.requireLiveProviders && options.providerSource !== "live") {
    throw new Error("--require-live-providers cannot be used with fixture source");
  }
  if (options.allScenarios && options.scenarioId) {
    throw new Error("--all-scenarios cannot be used with --scenario");
  }
  assertSafeOutputRoot(options.outputRoot);
  return options;
}

export function captureHelp() {
  return [
    "Dure README and Mintlify media capture",
    "",
    "Usage:",
    "  node tools/media-capture/capture.mjs --list",
    "  node tools/media-capture/capture.mjs --scenario <id> [--format all|gif|png|webm]",
    "  node tools/media-capture/capture.mjs --all-scenarios [--format all|gif|png|webm]",
    "",
    "Options:",
    "  --provider-source <live|fixture>  live CLIs by default; fixtures are fallback-only",
    "  --all-scenarios                  refresh the complete media catalog from this checkout",
    "                                   with --format gif, select only declared GIF recipes",
    "  --require-live-providers         fail instead of falling back when a live CLI is unavailable",
    "  --output <path>                  transient root (default: output/playwright/media)",
    "  --headed                        show Chromium while recording",
  ].join("\n");
}
