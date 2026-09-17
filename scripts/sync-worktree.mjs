#!/usr/bin/env node

import { syncWorktree, WorktreeWipError } from "./lib/worktree-wip.mjs";

function usage() {
  return [
    "usage: node scripts/sync-worktree.mjs [options]",
    "",
    "options:",
    "  --remote <name>    fetch remote (default: origin)",
    "  --branch <name>    fetch branch (default: main)",
    "  --target <rev>     rebase target (default: <remote>/<branch>)",
    "  --no-fetch         skip fetch (intended for local/test targets)",
    "  --json             emit machine-readable output",
  ].join("\n");
}

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value) {
    throw new WorktreeWipError(
      "worktree_sync_usage",
      `${option} requires a value\n${usage()}`,
    );
  }
  return value;
}

function parseArguments(argv) {
  const options = {
    branch: "main",
    fetch: true,
    json: false,
    remote: "origin",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--remote") {
      options.remote = takeValue(argv, index, argument);
      index += 1;
    } else if (argument === "--branch") {
      options.branch = takeValue(argv, index, argument);
      index += 1;
    } else if (argument === "--target") {
      options.target = takeValue(argv, index, argument);
      index += 1;
    } else if (argument === "--no-fetch") {
      options.fetch = false;
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--help" || argument === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new WorktreeWipError(
        "worktree_sync_usage",
        `unknown argument: ${argument}\n${usage()}`,
      );
    }
  }
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result = await syncWorktree(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    process.stdout.write(
      `worktree sync complete: head=${result.head} target=${result.target}\n`,
    );
  }
} catch (error) {
  const message =
    error instanceof Error ? error.message : `worktree_sync_failed: ${error}`;
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
