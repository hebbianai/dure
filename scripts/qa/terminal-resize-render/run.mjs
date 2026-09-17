#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { selectedProviders } from "./profiles.mjs";
import { captureSnapshotSeed } from "./snapshot-seed.mjs";

export function parseArguments(argv) {
  const options = { provider: "all" };
  const args = [...argv];
  while (args.length > 0) {
    const argument = args.shift();
    if (argument === "--") continue;
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--provider") options.provider = requiredValue(args, argument);
    else if (argument === "--session") options.session = requiredValue(args, argument);
    else if (argument === "--workspace") options.workspace = requiredValue(args, argument);
    else if (argument === "--discovery-root")
      options.discoveryRoot = requiredValue(args, argument);
    else throw new Error(`unexpected argument: ${argument}`);
  }
  options.providers = selectedProviders(options.provider);
  if (options.workspace && !options.session) {
    throw new Error("--workspace requires --session");
  }
  if (options.discoveryRoot && !path.isAbsolute(options.discoveryRoot)) {
    throw new Error("--discovery-root must be absolute");
  }
  return options;
}

export const HELP = `Usage:
  sh scripts/qa/terminal-resize-render-smoke.sh --provider <configured-provider|all>
  sh scripts/qa/terminal-resize-render-smoke.sh --provider claude \\
    --session <hmux-session-id> --workspace <hmux-workspace-id>

The optional session is copied with the read-only Hmux snapshot command. The
isolated renderer run requires HEBBIAN_QA_ALLOW_FOCUS_STEAL=1 and still skips
while the desktop is active.`;

function requiredValue(args, flag) {
  const value = args.shift();
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function runTerminalResizeRender(options, spawn = spawnSync) {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  let seedRoot;
  let seedPath;
  try {
    if (options.session) {
      const snapshot = captureSnapshotSeed({
        target: options.session,
        workspace: options.workspace,
        discoveryRoot: options.discoveryRoot,
      });
      seedRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), "dure-terminal-resize-seed."),
      );
      fs.chmodSync(seedRoot, 0o700);
      seedPath = path.join(seedRoot, "snapshot.json");
      fs.writeFileSync(seedPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
    }

    for (const provider of options.providers) {
      const environment = {
        ...process.env,
        DURE_QA_TERMINAL_PROVIDER: provider,
      };
      delete environment.DURE_QA_TERMINAL_SNAPSHOT_PATH;
      delete environment.DURE_QA_TERMINAL_SNAPSHOT_ROOT;
      if (seedRoot && seedPath) {
        environment.DURE_QA_TERMINAL_SNAPSHOT_ROOT = seedRoot;
        environment.DURE_QA_TERMINAL_SNAPSHOT_PATH = seedPath;
      }
      const result = spawn(
        "sh",
        ["scripts/qa/terminal-resize-render/smoke.sh"],
        { cwd: repositoryRoot, env: environment, stdio: "inherit" },
      );
      if (result.error) throw result.error;
      if (result.status !== 0) return result.status ?? 1;
    }
    return 0;
  } finally {
    if (seedRoot) fs.rmSync(seedRoot, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  process.exitCode = runTerminalResizeRender(options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
