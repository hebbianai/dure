import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspectAppRuntime } from "../../cli/lib/runtime-diagnostics.mjs";
import { appControlDirectory } from "../../cli/lib/app-control-location.mjs";
import { worktreeDevIdentity } from "./app-channel.mjs";
import { appRootUnder } from "./dure-home.mjs";
import { ownedAppPid } from "./dev-chain-recovery.mjs";
import { observeDevLaunchRestartAuthority } from "./dev-launch-client.mjs";
import {
  parseDevLaunchIdentity,
  sameDevLaunchIdentity,
} from "./dev-launch-contract.mjs";
import { readProcessCwd } from "./unix-process-tools.mjs";
import { processIdentity } from "./process-identity.mjs";

const APP_RUNTIME_POLL_MS = 250;
const APP_RUNTIME_PROBE_TIMEOUT_MS = 2_500;
const TARGET_HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function appDescriptorPath(channel, runtime = {}) {
  // An explicit test HOME stays isolated unless its caller also selects an
  // app environment. Supervisor authority continues to use HOME, not DURE_HOME.
  const environment =
    runtime.environment ?? (runtime.home === undefined ? process.env : {});
  return join(
    appControlDirectory({
      DURE_APP_CHANNEL: channel,
      DURE_HOME:
        environment.DURE_HOME ||
        appRootUnder(runtime.home ?? (environment.HOME || homedir())),
    }),
    "server.json",
  );
}

export function targetAppBuildId(root, targetHead) {
  if (!TARGET_HEAD.test(targetHead ?? "")) {
    throw new Error("target app build requires an exact commit");
  }
  let version;
  try {
    version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  } catch {
    throw new Error("target app build requires package.json");
  }
  if (!PACKAGE_VERSION.test(version ?? "")) {
    throw new Error("target app build requires a valid package version");
  }
  return `${version}+${targetHead.slice(0, 12)}`;
}

function pendingRuntime({
  channel,
  expectedBuildId,
  expectedLaunch,
  observedAtMs,
  reason,
  targetHead,
}) {
  return {
    state: "starting",
    channel,
    targetHead,
    buildId: expectedBuildId,
    launch: expectedLaunch,
    observedAtMs,
    reason,
  };
}

/** Wait for the app server owned by one exact dev-launch replacement.
 * The authenticated server descriptor is the runtime boundary; stale files
 * and an older live app remain observations, never deployment success. */
export async function awaitAppRuntimeReady(
  {
    root,
    channel = worktreeDevIdentity(root).channel,
    targetHead,
    expectedBuildId = targetAppBuildId(root, targetHead),
    expectedLaunch,
    notBeforeMs,
    timeoutMs,
    pollMs = APP_RUNTIME_POLL_MS,
  },
  runtime = {},
) {
  const launch = parseDevLaunchIdentity(
    expectedLaunch,
    "app runtime launch",
  );
  if (
    !Number.isSafeInteger(notBeforeMs) ||
    notBeforeMs < 0 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 1
  ) {
    throw new Error("app runtime readiness bounds are invalid");
  }
  const now = runtime.now ?? Date.now;
  const wait = runtime.wait ?? delay;
  const inspect = runtime.inspect ?? inspectAppRuntime;
  const identify = runtime.processIdentity ?? processIdentity;
  const observeParent =
    runtime.observeParent ?? observeDevLaunchRestartAuthority;
  const descriptorPath = appDescriptorPath(channel, runtime);
  const deadline = now() + timeoutMs;
  let reason = "app_runtime_descriptor_unavailable";

  for (;;) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) break;
    try {
      const parent = await observeParent({
        root,
        channel,
        home: runtime.home,
        timeoutMs: Math.min(remainingMs, APP_RUNTIME_PROBE_TIMEOUT_MS),
      });
      if (!sameDevLaunchIdentity(parent.launch, launch)) {
        reason = "app_runtime_launch_not_active";
      } else {
        const observed = await inspect({
          descriptorPath,
          timeoutMs: Math.min(remainingMs, APP_RUNTIME_PROBE_TIMEOUT_MS),
        });
        if (observed.state !== "running") {
          reason = `app_runtime_${observed.state}`;
        } else if (
          observed.channel !== channel ||
          observed.buildId !== expectedBuildId ||
          observed.startedAtUnixMs < notBeforeMs
        ) {
          reason = "app_runtime_stale_descriptor";
        } else if (
          observed.compatibility?.state !== "available" ||
          observed.compatibility.mode !== "current"
        ) {
          reason = "app_runtime_compatibility_pending";
        } else {
          const identity = identify(observed.processId);
          if (identity) {
            return {
              state: "ready",
              channel,
              targetHead,
              pid: observed.processId,
              processIdentity: identity,
              buildId: observed.buildId,
              generation: observed.generation,
              startedAtUnixMs: observed.startedAtUnixMs,
              observedAtMs: now(),
              launch,
              compatibility: {
                state: observed.compatibility.state,
                mode: observed.compatibility.mode,
              },
            };
          }
          reason = "app_runtime_process_unavailable";
        }
      }
    } catch (error) {
      reason = `app_runtime_probe_failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }

    const remainingAfterProbe = deadline - now();
    if (remainingAfterProbe <= 0) break;
    await wait(Math.min(pollMs, remainingAfterProbe));
  }

  return pendingRuntime({
    channel,
    expectedBuildId,
    expectedLaunch: launch,
    observedAtMs: now(),
    reason,
    targetHead,
  });
}

export function appPidFor(root) {
  try {
    // Linux comm is only a basename; classification requires the debug path.
    const commandField = process.platform === "linux" ? "args" : "comm";
    const rows = execFileSync("/bin/ps", ["-Ao", `pid=,${commandField}=`], {
      encoding: "utf8",
      timeout: 10_000,
    });
    const processes = [];
    for (const line of rows.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      if (match) processes.push({ pid: Number(match[1]), command: match[2] });
    }
    return ownedAppPid(processes, root, readProcessCwd);
  } catch {}
  return null;
}

/** A point-in-time runtime observation for status and ownership fencing. */
export function appRuntimeObservation(root, nowMs = Date.now(), runtime = {}) {
  const pid = (runtime.appPid ?? appPidFor)(root);
  if (pid === null) return undefined;
  const identity = (runtime.processIdentity ?? processIdentity)(pid);
  let buildId;
  let generation;
  try {
    const { channel } = worktreeDevIdentity(root);
    const descriptor = JSON.parse(
      readFileSync(
        appDescriptorPath(channel, runtime),
        "utf8",
      ),
    );
    if (
      descriptor.processId === pid &&
      typeof descriptor.buildId === "string" &&
      descriptor.buildId.length > 0 &&
      descriptor.buildId.length <= 256
    ) {
      buildId = descriptor.buildId;
    }
    if (
      descriptor.processId === pid &&
      typeof descriptor.generation === "string" &&
      descriptor.generation.length > 0 &&
      descriptor.generation.length <= 256
    ) {
      generation = descriptor.generation;
    }
  } catch {
    // Process identity remains useful while the optional descriptor rotates.
  }
  return identity
    ? {
        pid,
        processIdentity: identity,
        observedAtMs: nowMs,
        ...(buildId ? { buildId } : {}),
        ...(generation ? { generation } : {}),
      }
    : undefined;
}
