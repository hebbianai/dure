#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { waitForHostResources } from "./lib/host-resource-admission.mjs";
import { ensureHeadroom } from "./lib/build-storage-admission.mjs";
import { exposeBuildStorageReservation } from "./lib/build-storage-reservation.mjs";
import {
  BUILD_STORAGE_BUDGETS,
  buildStorageBudget,
} from "./lib/disk-space.mjs";

export function parseBuildStorageCommand(arguments_) {
  const separator = arguments_.indexOf("--");
  if (separator !== 1 || arguments_.length < 3) {
    throw new Error(
      `usage: run-with-build-storage.mjs <${Object.keys(BUILD_STORAGE_BUDGETS).join("|")}> -- <command> [args...]`,
    );
  }
  const kind = arguments_[0];
  buildStorageBudget(kind);
  return { kind, command: arguments_[2], args: arguments_.slice(3) };
}

export function runWithBuildStorage(
  arguments_,
  {
    admit = ensureHeadroom,
    run = spawnSync,
    cwd = process.cwd(),
    environment = process.env,
  } = {},
) {
  const command = parseBuildStorageCommand(arguments_);
  const disposableRunnerPolicy =
    environment.RUNNER_ENVIRONMENT === "github-hosted"
      ? { floorBytes: 0, goalBytes: 0 }
      : {};
  const headroom = admit({
    cwd,
    ...disposableRunnerPolicy,
    label: `${command.kind} build`,
    requestedBytes: buildStorageBudget(command.kind),
  });
  if (!headroom.ok) throw new Error(headroom.message);
  const invocation =
    process.platform === "win32" && command.command === "corepack"
      ? {
          command: environment.ComSpec || environment.COMSPEC || "cmd.exe",
          args: ["/d", "/s", "/c", command.command, ...command.args],
        }
      : command;
  const childEnvironment = { ...environment };
  exposeBuildStorageReservation(headroom.reservation, childEnvironment);
  try {
    const result = run(invocation.command, invocation.args, {
      cwd,
      env: childEnvironment,
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.signal) {
      throw new Error(
        `${invocation.command} exited from signal ${result.signal}`,
      );
    }
    return result.status ?? 1;
  } finally {
    headroom.reservation?.release();
  }
}

export async function runBuildStorageCli(
  arguments_,
  {
    execute = runWithBuildStorage,
    waitForResources = waitForHostResources,
  } = {},
) {
  const { kind } = parseBuildStorageCommand(arguments_);
  await waitForResources({ label: `${kind} build` });
  return execute(arguments_);
}

async function main() {
  try {
    process.exitCode = await runBuildStorageCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
