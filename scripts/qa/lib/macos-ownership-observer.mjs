import { spawn } from "node:child_process";
import path from "node:path";
import { parseMacosProcessIdentity } from "../../lib/process-identity.mjs";
import { formatProcessStartMarkerV1FromUnixSeconds } from "./owned-process-persistence-v1.mjs";
import { qaEnvironmentValue } from "./qa-environment.mjs";

const OWNED_PROCESS_GROUP_ERROR = "owned_process_group_error";
const PROCESS_MARKER_TOOL_SUFFIX = ".process-marker-v3";
const STARTUP_HANDSHAKE_WAIT_MS = 30_000;
const OBSERVER_FRAME_LIMIT = 64 * 1024;
const OBSERVER_DIAGNOSTIC_LIMIT = 4_096;

function boundedDiagnostic(value, fallback = "none") {
  const rendered = String(value ?? "").trim().replaceAll(/\s+/gu, " ");
  return (rendered || fallback).slice(0, 256);
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 1) {
    throw new Error(`${OWNED_PROCESS_GROUP_ERROR}: invalid ${name}`);
  }
  return parsed;
}

function processTableId(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${OWNED_PROCESS_GROUP_ERROR}: invalid ${name}`);
  }
  return parsed;
}

function macosKernelStartMarker(bootSession, uniqueId, name) {
  const identity = parseMacosProcessIdentity(
    `kernel-start-v3:macos:${bootSession}:${uniqueId}`,
  );
  if (!identity || identity.processIdentity.length > 512) {
    throw new Error(`${OWNED_PROCESS_GROUP_ERROR}: invalid ${name}`);
  }
  return identity.processIdentity;
}

function macosIdentity(marker) {
  const identity = parseMacosProcessIdentity(marker);
  if (!identity) {
    throw new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: invalid macOS observer generation`,
    );
  }
  return identity;
}

export function macosProcessMarkerToolPath(descriptorPath) {
  return `${path.resolve(descriptorPath)}${PROCESS_MARKER_TOOL_SUFFIX}`;
}

function startMarkerFromEpochSeconds(rawSeconds) {
  const startSeconds = Number(rawSeconds);
  try {
    return formatProcessStartMarkerV1FromUnixSeconds(startSeconds);
  } catch {
    throw new Error("ownership observer reported an invalid start time");
  }
}

export function startMacosOwnershipObserver(
  descriptor,
  known,
  {
    admit,
    environment = process.env,
    fail,
    seal = () => {},
    spawnObserver = spawn,
  },
) {
  const leaderIdentity = macosIdentity(
    descriptor.leaderKernelStartMarker,
  );
  const observer = spawnObserver(
    macosProcessMarkerToolPath(descriptor.descriptorPath),
    [
      "watch",
      String(descriptor.leaderPid),
      leaderIdentity.bootSession,
      leaderIdentity.uniqueId,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  let ready = false;
  let stopped = false;
  let terminalFailure;
  let nextBarrier = 1;
  const barriers = new Map();
  let injectedRuntimeExitTimer;
  const knownIdentities = new Map(
    [...known].map(([pid, record]) => [pid, record.kernelStartMarker]),
  );
  let settleReady;
  const readiness = new Promise((resolve, reject) => {
    settleReady = { reject, resolve };
  });
  const observerFailure = (message) => {
    if (terminalFailure) return;
    clearTimeout(injectedRuntimeExitTimer);
    terminalFailure = new Error(
      `${OWNED_PROCESS_GROUP_ERROR}: ${message}; stderr=${boundedDiagnostic(
        stderr,
      )}`,
    );
    clearTimeout(readinessTimer);
    if (!ready) settleReady.reject(terminalFailure);
    for (const { reject } of barriers.values()) reject(terminalFailure);
    barriers.clear();
    if (!observer.stdin.destroyed) observer.stdin.destroy();
    fail(terminalFailure);
  };
  const readinessTimer = setTimeout(() => {
    observerFailure("ownership observer timed out");
  }, STARTUP_HANDSHAKE_WAIT_MS);
  const processLine = (line) => {
    const fields = line.trim().split(/\s+/u);
    if (fields[0] === "R" && fields[1] === "1" && fields.length === 2) {
      if (ready) throw new Error("ownership observer repeated readiness");
      ready = true;
      clearTimeout(readinessTimer);
      settleReady.resolve();
      return;
    }
    if (fields[0] === "B" && fields.length === 2) {
      const barrier = barriers.get(fields[1]);
      if (!barrier) {
        throw new Error("ownership observer returned an unknown barrier");
      }
      barriers.delete(fields[1]);
      barrier.resolve();
      if (
        fields[1] === "1" &&
        environment.NODE_ENV === "test" &&
        qaEnvironmentValue(
          environment,
          "TEST_NATIVE_OWNERSHIP_OBSERVER_RUNTIME_EXIT",
        ) === "1"
      ) {
        // Exit only after the command-admission barrier. This exercises the
        // real child-process failure path rather than merely marking the JS
        // ledger unhealthy before a command can start.
        injectedRuntimeExitTimer = setTimeout(() => {
          if (!stopped && !terminalFailure) observer.kill("SIGTERM");
        }, 10);
      }
      return;
    }
    if (fields[0] === "S" && fields.length === 5) {
      const pid = positiveInteger(fields[1], "observer process pid");
      const parentPid = positiveInteger(
        fields[3],
        "observer parent process pid",
      );
      const kernelStartMarker = macosKernelStartMarker(
        leaderIdentity.bootSession,
        fields[2],
        "observer process generation",
      );
      const parentKernelStartMarker = macosKernelStartMarker(
        leaderIdentity.bootSession,
        fields[4],
        "observer parent generation",
      );
      const observedParent = knownIdentities.get(parentPid);
      if (observedParent !== parentKernelStartMarker) {
        throw new Error(
          `ownership observer reported an unowned parent generation ` +
            `(pid=${parentPid}, expected=${parentKernelStartMarker}, ` +
            `observed=${observedParent ?? "absent"})`,
        );
      }
      seal({
        kernelStartMarker,
        parentKernelStartMarker,
        parentPid,
        pid,
      });
      knownIdentities.set(pid, kernelStartMarker);
      return;
    }
    if (
      fields[0] !== "P" ||
      (fields.length !== 9 && fields.length !== 10)
    ) {
      throw new Error("ownership observer returned a malformed frame");
    }
    const pid = positiveInteger(fields[1], "observer process pid");
    const parentPid = positiveInteger(fields[3], "observer parent process pid");
    const expectedKernelMarker = macosKernelStartMarker(
      leaderIdentity.bootSession,
      fields[2],
      "observer process generation",
    );
    const expectedParentKernelMarker = macosKernelStartMarker(
      leaderIdentity.bootSession,
      fields[4],
      "observer parent generation",
    );
    const observedParent = knownIdentities.get(parentPid);
    if (observedParent !== expectedParentKernelMarker) {
      throw new Error(
        `ownership observer reported an unowned parent generation ` +
          `(pid=${parentPid}, expected=${expectedParentKernelMarker}, ` +
          `observed=${observedParent ?? "absent"})`,
      );
    }
    admit({
      groupId: processTableId(fields[6], "observer process group"),
      kernelStartMarker: expectedKernelMarker,
      parentPid: processTableId(fields[5], "observer process parent"),
      pid,
      sessionId: processTableId(fields[7], "observer process session"),
      startMarker: startMarkerFromEpochSeconds(fields[8]),
    });
    knownIdentities.set(pid, expectedKernelMarker);
  };

  observer.stdout.setEncoding("utf8");
  observer.stdout.on("data", (chunk) => {
    if (stopped || terminalFailure) return;
    stdout += chunk;
    if (stdout.length > OBSERVER_FRAME_LIMIT) {
      observerFailure("ownership observer frame limit exceeded");
      return;
    }
    try {
      for (;;) {
        const newline = stdout.indexOf("\n");
        if (newline === -1) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);
        processLine(line);
      }
    } catch (error) {
      observerFailure(error instanceof Error ? error.message : String(error));
    }
  });
  observer.stderr.setEncoding("utf8");
  observer.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-OBSERVER_DIAGNOSTIC_LIMIT);
  });
  observer.stdin.on("error", (error) => {
    observerFailure(`ownership observer input failed: ${error.message}`);
  });
  observer.once("error", (error) => {
    observerFailure(`ownership observer failed to start: ${error.message}`);
  });
  observer.once("close", (status, signal) => {
    if (stopped && status === 0 && signal === null) return;
    observerFailure(
      `ownership observer exited status=${status ?? "none"} signal=${
        signal ?? "none"
      }`,
    );
  });

  const barrier = async () => {
    if (terminalFailure) throw terminalFailure;
    if (stopped) {
      throw new Error(
        `${OWNED_PROCESS_GROUP_ERROR}: ownership observer is already stopped`,
      );
    }
    const token = String(nextBarrier++);
    const completion = new Promise((resolve, reject) => {
      barriers.set(token, { reject, resolve });
    });
    try {
      observer.stdin.write(`barrier ${token}\n`, (error) => {
        if (error) {
          observerFailure(
            `ownership observer barrier write failed: ${error.message}`,
          );
        }
      });
    } catch (error) {
      observerFailure(
        `ownership observer barrier write failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await completion;
    if (terminalFailure) throw terminalFailure;
  };

  return {
    barrier,
    async ready() {
      await readiness;
      if (terminalFailure) throw terminalFailure;
    },
    async stop() {
      clearTimeout(injectedRuntimeExitTimer);
      if (terminalFailure) throw terminalFailure;
      if (stopped) return;
      await barrier();
      stopped = true;
      const exited = new Promise((resolve, reject) => {
        observer.once("close", resolve);
        observer.once("error", reject);
      });
      observer.stdin.end("stop\n");
      await exited;
      if (terminalFailure) throw terminalFailure;
      if (stdout.length !== 0) {
        throw new Error(
          `${OWNED_PROCESS_GROUP_ERROR}: ownership observer left a partial frame`,
        );
      }
    },
  };
}
