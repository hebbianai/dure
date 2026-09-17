#!/usr/bin/env node

import {
  checkpointWorktree,
  releaseWorktreeCheckpoint,
  restoreWorktree,
  WorktreeWipError,
} from "./lib/worktree-wip.mjs";

function usage() {
  return [
    "usage:",
    "  node scripts/worktree-wip.mjs checkpoint [--json]",
    "  node scripts/worktree-wip.mjs restore <refs/hebbian-wip/...> [--json]",
    "  node scripts/worktree-wip.mjs release <refs/hebbian-wip/...> [--json]",
  ].join("\n");
}

function parseArguments(argv) {
  const json = argv.includes("--json");
  const positional = argv.filter(
    (argument) => argument !== "--json" && argument !== "--",
  );
  const [command, ref, ...extra] = positional;
  if (
    !["checkpoint", "restore", "release"].includes(command) ||
    extra.length > 0 ||
    (command === "checkpoint" && ref) ||
    (command !== "checkpoint" && !ref)
  ) {
    throw new WorktreeWipError("worktree_wip_usage", usage());
  }
  return { command, json, ref };
}

function printResult(options, result) {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (options.command === "checkpoint" && result === null) {
    process.stdout.write("worktree WIP: worktree is clean\n");
    return;
  }
  process.stdout.write(
    `worktree WIP ${options.command}: ref=${result.ref} object=${result.object}\n`,
  );
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result =
    options.command === "checkpoint"
      ? checkpointWorktree()
      : options.command === "restore"
        ? restoreWorktree(process.cwd(), options.ref)
        : releaseWorktreeCheckpoint(process.cwd(), options.ref);
  printResult(options, result);
} catch (error) {
  const message =
    error instanceof Error ? error.message : `worktree_wip_failed: ${error}`;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
