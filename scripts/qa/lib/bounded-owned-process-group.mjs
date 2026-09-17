#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supervise } from "./owned-process-group.mjs";

const BOUNDED_GROUP_ERROR = "bounded_owned_process_group_error";
const BOUNDED_GROUP_ACTIVE = "bounded-owned-process-group active\n";
const CLEANUP_FAILURE_EXIT_CODE = 97;
const MAX_TIMEOUT_MS = 2_147_483_647;

export const BOUNDED_GROUP_COMPLETION = Object.freeze({
  cleanup: "verified",
  schema: "dure-qa-bounded-owned-process-group/v1",
});

export function boundedGroupPaths(controlRoot) {
  const root = path.resolve(controlRoot);
  if (!fs.lstatSync(root).isDirectory()) {
    throw new Error(`${BOUNDED_GROUP_ERROR}: control root must be a directory`);
  }
  return Object.freeze({
    active: path.join(root, "active"),
    cancellation: path.join(root, "cancel"),
    completion: path.join(root, "completion.json"),
    descriptor: path.join(root, "group.json"),
    root,
  });
}

function timeoutMilliseconds(rawSeconds) {
  const milliseconds = Number(rawSeconds) * 1_000;
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `${BOUNDED_GROUP_ERROR}: timeout must be a positive duration`,
    );
  }
  return milliseconds;
}

export async function runBoundedOwnedProcessGroup(
  controlRoot,
  rawTimeoutSeconds,
  command,
  args,
) {
  if (!command) {
    throw new Error(`${BOUNDED_GROUP_ERROR}: expected a command after --`);
  }
  const paths = boundedGroupPaths(controlRoot);
  const commandTimeoutMs = timeoutMilliseconds(rawTimeoutSeconds);
  try {
    fs.writeFileSync(paths.active, BOUNDED_GROUP_ACTIVE, {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`${BOUNDED_GROUP_ERROR}: control root is already active`);
    }
    throw error;
  }
  if (fs.existsSync(paths.completion)) {
    fs.rmSync(paths.active);
    throw new Error(`${BOUNDED_GROUP_ERROR}: completion already exists`);
  }
  const status = await supervise(paths.descriptor, command, args, {
    commandCancellationPath: paths.cancellation,
    commandTimeoutMs,
    removeDescriptorOnExit: true,
    terminateDetachedOwnedGenerations: false,
  });
  fs.writeFileSync(
    paths.completion,
    `${JSON.stringify(BOUNDED_GROUP_COMPLETION)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  fs.rmSync(paths.active);
  return status;
}

async function main() {
  const [
    operation,
    controlRoot,
    timeoutOption,
    timeout,
    separator,
    command,
    ...args
  ] = process.argv.slice(2);
  if (
    operation !== "run" ||
    !controlRoot ||
    timeoutOption !== "--timeout-seconds" ||
    separator !== "--" ||
    !command
  ) {
    throw new Error(
      `${BOUNDED_GROUP_ERROR}: usage: run <control-root> --timeout-seconds <seconds> -- <command> [args...]`,
    );
  }
  process.exitCode = await runBoundedOwnedProcessGroup(
    controlRoot,
    timeout,
    command,
    args,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = CLEANUP_FAILURE_EXIT_CODE;
  }
}
