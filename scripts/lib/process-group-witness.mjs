import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { observeProcessGroupId } from "./process-identity.mjs";
import { awaitWindowsJobBinding } from "./windows-process-job.mjs";
import {
  PROCESS_GROUP_WITNESS_CONTROL_TIMEOUT_MS,
  PROCESS_GROUP_WITNESS_PROTOCOL_VERSION,
  requireProcessGroupSupport,
} from "./process-group-authority.mjs";

// A fresh Node process can take longer than one second to be scheduled while a
// build is saturating the machine. This remains well inside the outer launch
// handshake deadline and is paid only when startup is actually slow.
const WITNESS_START_TIMEOUT_MS = 5_000;
const witnessPath = fileURLToPath(
  new URL("../run-process-group-witness.mjs", import.meta.url),
);

function processExit(child) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (error) => {
      cleanup();
      const failure = new Error(
        `process group witness failed to spawn: ${error?.code ?? error?.message ?? "unknown error"}`,
        { cause: error },
      );
      failure.code = "DEV_PROCESS_GROUP_WITNESS_START_FAILED";
      reject(failure);
    };
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function waitForMessage(child, expectedType, groupId) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      cleanup();
      if (
        !message ||
        typeof message !== "object" ||
        Array.isArray(message) ||
        message.protocolVersion !== PROCESS_GROUP_WITNESS_PROTOCOL_VERSION ||
        message.type !== expectedType ||
        message.groupId !== groupId
      ) {
        reject(new Error("invalid process group witness response"));
        return;
      }
      resolve(message);
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error("process group witness disconnected"));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("disconnect", onDisconnect);
    };
    child.once("message", onMessage);
    child.once("disconnect", onDisconnect);
  });
}

function withTimeout(operation, label, timeoutMs) {
  let timeout;
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(`${label} timed out`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
}

export function waitForProcessGroupWitnessReadiness(operation) {
  return withTimeout(
    operation,
    "process group witness readiness",
    WITNESS_START_TIMEOUT_MS,
  );
}

export async function spawnProcessGroupWitness() {
  if (process.platform === "win32") return awaitWindowsJobBinding();
  requireProcessGroupSupport();
  const groupId = process.pid;
  if (await observeProcessGroupId(process.pid) !== groupId) {
    throw new Error("development wrapper is not its process group leader");
  }
  const child = spawn(process.execPath, [witnessPath, String(groupId)], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const exited = processExit(child);
  const ready = waitForMessage(
    child,
    "process_group_witness_ready",
    groupId,
  );
  const outcome = exited.then(({ code, signal }) => {
    throw new Error(
      signal
        ? `process group witness exited from signal ${signal}`
        : `process group witness exited with code ${code ?? 1}`,
    );
  });
  let message;
  try {
    message = await waitForProcessGroupWitnessReadiness(
      Promise.race([ready, outcome]),
    );
  } catch (error) {
    if (child.connected) child.disconnect();
    throw error;
  }

  let retained = false;
  return {
    pid: message.pid,
    async retain() {
      if (retained) return;
      const acknowledgement = waitForMessage(
        child,
        "process_group_witness_retained",
        groupId,
      );
      await new Promise((resolve, reject) => {
        child.send(
          {
            protocolVersion: PROCESS_GROUP_WITNESS_PROTOCOL_VERSION,
            type: "process_group_witness_retain",
            groupId,
          },
          (error) => (error ? reject(error) : resolve()),
        );
      });
      await withTimeout(
        Promise.race([acknowledgement, outcome]),
        "process group witness activation",
        PROCESS_GROUP_WITNESS_CONTROL_TIMEOUT_MS,
      );
      retained = true;
    },
    async retire() {
      if (!child.connected) return;
      if (!retained) {
        child.disconnect();
        return;
      }
      const acknowledgement = waitForMessage(
        child,
        "process_group_witness_retiring",
        groupId,
      );
      await new Promise((resolve, reject) => {
        child.send(
          {
            protocolVersion: PROCESS_GROUP_WITNESS_PROTOCOL_VERSION,
            type: "process_group_witness_retire",
            groupId,
          },
          (error) => (error ? reject(error) : resolve()),
        );
      });
      await withTimeout(
        Promise.race([acknowledgement, outcome]),
        "process group witness retirement",
        PROCESS_GROUP_WITNESS_CONTROL_TIMEOUT_MS,
      );
      child.disconnect();
      child.unref();
    },
  };
}
