#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { waitForHostResources } from "./lib/host-resource-admission.mjs";
import {
  disposableRunnerAdmission,
  ensureHeadroom,
} from "./lib/build-storage-admission.mjs";
import { exposeBuildStorageReservation } from "./lib/build-storage-reservation.mjs";
import {
  BUILD_STORAGE_BUDGETS,
  buildStorageBudget,
} from "./lib/disk-space.mjs";

// Storage frees when a peer build ends or lands, so a re-check needs no
// tighter cadence; each refused attempt also runs the safe reclaim again.
const STORAGE_RETRY_INTERVAL_MS = 60_000;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function parseBuildStorageCommand(arguments_) {
  let waitMs = 0;
  let rest = arguments_;
  if (rest[0] === "--wait-minutes") {
    if (!/^\d{1,4}$/u.test(rest[1] ?? "")) {
      throw new Error("--wait-minutes takes a whole number of minutes");
    }
    waitMs = Number(rest[1]) * 60_000;
    rest = rest.slice(2);
  }
  const separator = rest.indexOf("--");
  if (separator !== 1 || rest.length < 3) {
    throw new Error(
      `usage: run-with-build-storage.mjs [--wait-minutes N] <${Object.keys(BUILD_STORAGE_BUDGETS).join("|")}> -- <command> [args...]`,
    );
  }
  const kind = rest[0];
  buildStorageBudget(kind);
  return { kind, command: rest[2], args: rest.slice(3), waitMs };
}

/** Admit once, or re-check the same admission until the wait ends. */
function admitWithin(waitMs, attempt, { label, sleep, log, now }) {
  const deadline = now() + waitMs;
  for (let refusals = 0; ; refusals += 1) {
    const headroom = attempt();
    const remaining = deadline - now();
    if (headroom.ok || remaining <= 0) return headroom;
    if (refusals === 0) log(headroom.message);
    log(
      `${label}: storage not admitted yet; checking again in ${STORAGE_RETRY_INTERVAL_MS / 1000} s ` +
        `(${Math.ceil(remaining / 60_000)} min left)`,
    );
    sleep(Math.min(STORAGE_RETRY_INTERVAL_MS, remaining));
  }
}

export function runWithBuildStorage(
  arguments_,
  {
    admit = ensureHeadroom,
    run = spawnSync,
    cwd = process.cwd(),
    environment = process.env,
    sleep = sleepSync,
    log = (line) => process.stderr.write(`${line}\n`),
    now = Date.now,
  } = {},
) {
  const command = parseBuildStorageCommand(arguments_);
  const label = `${command.kind} build`;
  const headroom = admitWithin(
    command.waitMs,
    () => admit({
      cwd,
      environment,
      label,
      buildClass: command.kind,
      requestedBytes: buildStorageBudget(command.kind),
      ...disposableRunnerAdmission(environment),
    }),
    { label, sleep, log, now },
  );
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
