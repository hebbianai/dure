#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  observeProcessMembers,
  processLivenessFromObservation,
  processMemberFromObservation,
  signalProcessGeneration,
} from "../../lib/process-identity.mjs";
import { qaEnvironmentValue } from "./qa-environment.mjs";

const GUARD_SCHEMA_VERSION = 2;
const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_CLEANUP_GRACE_MS = 60_000;
const DEFAULT_KILL_GRACE_MS = 3_000;
const MAX_CLEANUP_GRACE_MS = 120_000;
const LAUNCH_OWNER_GUARD_ERROR = "launch_owner_guard_error";
const RUNNER_TIMEOUT_CANCELLATION = "timeout\n";

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedMilliseconds(value, fallback, minimum, maximum, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(
      `${LAUNCH_OWNER_GUARD_ERROR}: ${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function optionalSeconds(value, name) {
  if (value === undefined || value === "") return undefined;
  const milliseconds = Number(value) * 1_000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new Error(
      `${LAUNCH_OWNER_GUARD_ERROR}: ${name} must be a positive duration`,
    );
  }
  return milliseconds;
}

function observedProcessGeneration(pid, observation) {
  const observed = processMemberFromObservation(pid, observation);
  if (observed.status !== "present") {
    throw new Error(
      `${LAUNCH_OWNER_GUARD_ERROR}: process has no exact generation`,
    );
  }
  const { groupId, parentPid, processIdentity } = observed.member;
  return {
    groupId,
    parentPid,
    pid,
    processIdentity,
  };
}

function sameGeneration(left, right) {
  return (
    left?.pid === right?.pid &&
    left?.processIdentity === right?.processIdentity
  );
}

function writeGuardDescriptor(destination, descriptor) {
  const temporary = `${destination}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(descriptor)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  try {
    fs.linkSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writeTimeoutCancellation(destination) {
  try {
    fs.writeFileSync(destination, RUNNER_TIMEOUT_CANCELLATION, {
      flag: "wx",
      mode: 0o600,
    });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

export async function guardLaunchOwner(
  descriptorPath,
  runnerPid,
  stopPath,
  environment = process.env,
  {
    currentParentPid = () => process.ppid,
    currentPid = () => process.pid,
    fileExists = fs.existsSync,
    now = Date.now,
    observeMembers = observeProcessMembers,
    publishDescriptor = writeGuardDescriptor,
    signalGeneration = signalProcessGeneration,
    publishTimeoutCancellation = writeTimeoutCancellation,
    wait = sleep,
  } = {},
) {
  const resolvedDescriptorPath = path.resolve(descriptorPath);
  const resolvedStopPath = path.resolve(stopPath);
  if (!Number.isSafeInteger(runnerPid) || runnerPid <= 1) {
    throw new Error(`${LAUNCH_OWNER_GUARD_ERROR}: invalid runner pid`);
  }
  const pollIntervalMs = boundedMilliseconds(
    qaEnvironmentValue(environment, "LAUNCH_OWNER_POLL_MS"),
    DEFAULT_POLL_INTERVAL_MS,
    10,
    1_000,
    "DURE_QA_LAUNCH_OWNER_POLL_MS",
  );
  const cleanupGraceMs = boundedMilliseconds(
    qaEnvironmentValue(environment, "LAUNCH_OWNER_CLEANUP_GRACE_MS"),
    DEFAULT_CLEANUP_GRACE_MS,
    100,
    MAX_CLEANUP_GRACE_MS,
    "DURE_QA_LAUNCH_OWNER_CLEANUP_GRACE_MS",
  );
  const killGraceMs = boundedMilliseconds(
    qaEnvironmentValue(environment, "LAUNCH_OWNER_KILL_GRACE_MS"),
    DEFAULT_KILL_GRACE_MS,
    100,
    10_000,
    "DURE_QA_LAUNCH_OWNER_KILL_GRACE_MS",
  );
  const configuredCancellationPath = qaEnvironmentValue(
    environment,
    "RUNNER_CANCEL_FILE",
  );
  const cancellationPath = configuredCancellationPath
    ? path.resolve(configuredCancellationPath)
    : undefined;
  const runnerTimeoutMs = optionalSeconds(
    qaEnvironmentValue(environment, "RUNNER_TIMEOUT_SECONDS"),
    "DURE_QA_RUNNER_TIMEOUT_SECONDS",
  );
  if (runnerTimeoutMs !== undefined && !cancellationPath) {
    throw new Error(
      `${LAUNCH_OWNER_GUARD_ERROR}: runner timeout requires DURE_QA_RUNNER_CANCEL_FILE`,
    );
  }
  if (
    cancellationPath === resolvedDescriptorPath ||
    cancellationPath === resolvedStopPath
  ) {
    throw new Error(
      `${LAUNCH_OWNER_GUARD_ERROR}: runner cancellation path must be distinct`,
    );
  }
  const runnerDeadline =
    runnerTimeoutMs === undefined ? undefined : now() + runnerTimeoutMs;
  const injectedOwnerFailure = qaEnvironmentValue(environment, "TEST_MODE")
    ? qaEnvironmentValue(
        environment,
        "TEST_LAUNCH_OWNER_FAILURE_MARKER",
      )
    : undefined;
  if (currentParentPid() !== runnerPid) {
    throw new Error(
      `${LAUNCH_OWNER_GUARD_ERROR}: guard is not a child of the runner`,
    );
  }

  const runner = observedProcessGeneration(
    runnerPid,
    await observeMembers({ kind: "point", pids: [runnerPid] }),
  );
  if (runner.parentPid <= 1) {
    throw new Error(
      `${LAUNCH_OWNER_GUARD_ERROR}: runner has no live launch owner`,
    );
  }
  const guardPid = currentPid();
  const ownership = await observeMembers({
    kind: "point",
    pids: [runnerPid, runner.parentPid, guardPid],
  });
  const observedLaunchOwner = observedProcessGeneration(
    runner.parentPid,
    ownership,
  );
  const observedRunner = observedProcessGeneration(runnerPid, ownership);
  const guard = observedProcessGeneration(
    guardPid,
    ownership,
  );
  const confirmation = await observeMembers({
    kind: "point",
    pids: [runner.parentPid, runnerPid],
  });
  const launchOwner = observedProcessGeneration(
    runner.parentPid,
    confirmation,
  );
  const confirmedRunner = observedProcessGeneration(runnerPid, confirmation);
  if (
    currentParentPid() !== runnerPid ||
    guard.parentPid !== runnerPid ||
    !sameGeneration(runner, observedRunner) ||
    !sameGeneration(observedRunner, confirmedRunner) ||
    !sameGeneration(observedLaunchOwner, launchOwner) ||
    confirmedRunner.parentPid !== launchOwner.pid
  ) {
    throw new Error(
      `${LAUNCH_OWNER_GUARD_ERROR}: launch ownership changed before publication`,
    );
  }

  const descriptor = {
    guard,
    launchOwner,
    runner: confirmedRunner,
    schemaVersion: GUARD_SCHEMA_VERSION,
  };
  publishDescriptor(resolvedDescriptorPath, descriptor);
  const observeLiveness = async () => {
    const observation = await observeMembers({
      kind: "point",
      pids: [launchOwner.pid, confirmedRunner.pid],
    });
    const launchOwnerState = processLivenessFromObservation(
      launchOwner,
      observation,
    );
    const runnerState = processLivenessFromObservation(
      confirmedRunner,
      observation,
    );
    if (launchOwnerState === "unknown" || runnerState === "unknown") {
      throw new Error(
        `${LAUNCH_OWNER_GUARD_ERROR}: process identity observation is incomplete`,
      );
    }
    return {
      launchOwnerIsLive: launchOwnerState === "active",
      runnerIsLive: runnerState === "active",
    };
  };
  let runnerHupAttempted = false;
  const signalRunnerHup = async () => {
    runnerHupAttempted = true;
    return signalGeneration(confirmedRunner, "SIGHUP");
  };

  try {
    while (!fileExists(resolvedStopPath)) {
      const liveness = await observeLiveness();
      if (!liveness.runnerIsLive) return descriptor;
      if (
        (injectedOwnerFailure && fileExists(injectedOwnerFailure)) ||
        !liveness.launchOwnerIsLive ||
        (cancellationPath && fileExists(cancellationPath))
      ) {
        break;
      }
      if (runnerDeadline !== undefined && now() >= runnerDeadline) {
        publishTimeoutCancellation(cancellationPath);
        break;
      }
      const remainingMs =
        runnerDeadline === undefined ? pollIntervalMs : runnerDeadline - now();
      await wait(Math.max(1, Math.min(pollIntervalMs, remainingMs)));
    }
    if (fileExists(resolvedStopPath)) return descriptor;

    if (!(await signalRunnerHup())) return descriptor;
    const cleanupDeadline = now() + cleanupGraceMs;
    while (
      !fileExists(resolvedStopPath) &&
      now() < cleanupDeadline
    ) {
      if (!(await observeLiveness()).runnerIsLive) return descriptor;
      await wait(pollIntervalMs);
    }
    if (
      fileExists(resolvedStopPath) ||
      !(await observeLiveness()).runnerIsLive
    ) {
      return descriptor;
    }

    if (!(await signalGeneration(confirmedRunner, "SIGKILL"))) {
      return descriptor;
    }
    // A saturated identity observation can consume the wall-clock grace. Keep
    // observing until the minimum evidence count is reached; this can extend
    // the grace but cannot shorten it.
    const MIN_KILL_OBSERVATIONS = 3;
    const killDeadline = now() + killGraceMs;
    let killObservations = 0;
    let live = (await observeLiveness()).runnerIsLive;
    while (
      live &&
      (now() < killDeadline || killObservations < MIN_KILL_OBSERVATIONS)
    ) {
      await wait(pollIntervalMs);
      live = (await observeLiveness()).runnerIsLive;
      killObservations += 1;
    }
    if (live) {
      throw new Error(
        `${LAUNCH_OWNER_GUARD_ERROR}: exact runner generation survived SIGKILL`,
      );
    }
    return descriptor;
  } catch (error) {
    if (!runnerHupAttempted) {
      try {
        await signalRunnerHup();
      } catch (cancellationError) {
        throw new AggregateError(
          [error, cancellationError],
          `${LAUNCH_OWNER_GUARD_ERROR}: guard failure and runner cancellation both failed`,
        );
      }
    }
    throw error;
  }
}

async function main() {
  const [operation, descriptorPath, rawRunnerPid, stopPath] =
    process.argv.slice(2);
  if (operation !== "guard" || !descriptorPath || !stopPath) {
    throw new Error(
      `${LAUNCH_OWNER_GUARD_ERROR}: usage: guard <descriptor> <runner-pid> <stop-marker>`,
    );
  }
  const runnerPid = Number(rawRunnerPid);
  await guardLaunchOwner(descriptorPath, runnerPid, stopPath);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 97;
  }
}
