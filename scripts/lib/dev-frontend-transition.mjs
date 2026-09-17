import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { appControlDirectory } from "../../cli/lib/app-control-location.mjs";
import {
  DEV_DEPLOY_HMR_STATUS_PATH,
  devDeployHmrStatusReady,
} from "./dev-deploy-lock.mjs";

const STATUS_POLL_MS = 100;
const REQUEST_TIMEOUT_MS = 1_000;
const TRANSITION_TIMEOUT_MS = 10_000;
const CONTROL_DESCRIPTOR_WAIT_MS = 1_000;

function failure(reason) {
  return { status: "failed", reason };
}

function parseControlDescriptor(source, channel) {
  const descriptor = JSON.parse(source);
  if (
    descriptor?.schemaVersion !== 1 ||
    !Number.isSafeInteger(descriptor.apiVersion) ||
    descriptor.apiVersion < 1 ||
    !Number.isSafeInteger(descriptor.port) ||
    descriptor.port < 1 ||
    descriptor.port > 65_535 ||
    typeof descriptor.token !== "string" ||
    descriptor.token.length === 0 ||
    descriptor.token.length > 4_096 ||
    descriptor.channel !== channel ||
    typeof descriptor.generation !== "string" ||
    descriptor.generation.length === 0 ||
    descriptor.generation.length > 256 ||
    !Number.isSafeInteger(descriptor.processId) ||
    descriptor.processId < 1 ||
    !Number.isSafeInteger(descriptor.startedAtUnixMs) ||
    descriptor.startedAtUnixMs < 1
  ) {
    throw new Error("invalid app control descriptor");
  }
  return {
    schemaVersion: 1,
    apiVersion: descriptor.apiVersion,
    port: descriptor.port,
    token: descriptor.token,
    channel: descriptor.channel,
    generation: descriptor.generation,
    processId: descriptor.processId,
    startedAtUnixMs: descriptor.startedAtUnixMs,
  };
}

function sameControlDescriptor(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}

function readControlDescriptor(pathname, channel) {
  try {
    return parseControlDescriptor(readFileSync(pathname, "utf8"), channel);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function requestSignal(deadlineMs, nowMs) {
  return AbortSignal.timeout(
    Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadlineMs - nowMs)),
  );
}

function validReloadAcknowledgement(value) {
  return (
    value?.ok === true &&
    Array.isArray(value.reloaded) &&
    value.reloaded.every(
      (label) =>
        typeof label === "string" && label.length > 0 && label.length <= 256,
    ) &&
    new Set(value.reloaded).size === value.reloaded.length
  );
}

function currentGenerationReady(
  status,
  lockRecord,
  {
    deployedAtMs,
    sourceMutationStartedAtMs,
    nowMs,
    requireSuppressedUpdate,
  },
) {
  return (
    Number.isSafeInteger(status?.suppressedCount) &&
    status.suppressedCount >= 0 &&
    (!requireSuppressedUpdate ||
      (status.suppressedCount > 0 &&
        Number.isSafeInteger(status.lastSuppressedAtUnixMs) &&
        status.lastSuppressedAtUnixMs >= sourceMutationStartedAtMs)) &&
    devDeployHmrStatusReady(status, lockRecord, { deployedAtMs, nowMs })
  );
}

/**
 * Complete one frontend-only checkout transition behind the existing deploy
 * lease. This is deployment mechanics, not product verification: authenticated
 * status GETs only locate Vite's bounded quiet boundary, and the Control-scoped
 * reload mutation is attempted exactly once.
 */
export async function dispatchCoordinatedFrontendTransition({
  origin,
  channel,
  deployedAtMs,
  sourceMutationStartedAtMs,
  lockRecord,
  requireSuppressedUpdate = true,
  now = Date.now,
  timeoutMs = TRANSITION_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  const deadlineMs = now() + timeoutMs;
  const descriptorDeadlineMs = Math.min(
    deadlineMs,
    now() + CONTROL_DESCRIPTOR_WAIT_MS,
  );
  const descriptorPath = join(
    appControlDirectory({ ...process.env, DURE_APP_CHANNEL: channel }),
    "server.json",
  );
  let initialDescriptor;
  while (!initialDescriptor && now() < descriptorDeadlineMs) {
    try {
      initialDescriptor = readControlDescriptor(descriptorPath, channel);
    } catch (error) {
      return failure(`app control descriptor is unavailable: ${error.message}`);
    }
    if (!initialDescriptor) {
      await wait(
        Math.min(STATUS_POLL_MS, Math.max(1, descriptorDeadlineMs - now())),
      );
    }
  }
  if (!initialDescriptor) {
    return failure("app control descriptor did not become available");
  }

  const headers = { Authorization: `Bearer ${lockRecord.token}` };
  let reason = requireSuppressedUpdate
    ? "Vite did not observe a source update for the current deploy generation"
    : "Vite deploy fence has not reached its quiet boundary";
  let status;
  while (now() < deadlineMs) {
    try {
      const response = await fetchImpl(
        `${origin}${DEV_DEPLOY_HMR_STATUS_PATH}`,
        {
          cache: "no-store",
          headers,
          signal: requestSignal(deadlineMs, now()),
        },
      );
      if (!response.ok) {
        reason = `Vite deploy fence rejected status: HTTP ${response.status}`;
      } else {
        status = await response.json();
        if (
          currentGenerationReady(status, lockRecord, {
            deployedAtMs,
            sourceMutationStartedAtMs,
            nowMs: now(),
            requireSuppressedUpdate,
          })
        ) {
          break;
        }
      }
    } catch (error) {
      reason = `Vite deploy fence is unavailable: ${error.message}`;
    }
    await wait(Math.min(STATUS_POLL_MS, Math.max(1, deadlineMs - now())));
  }
  if (
    !currentGenerationReady(status, lockRecord, {
      deployedAtMs,
      sourceMutationStartedAtMs,
      nowMs: now(),
      requireSuppressedUpdate,
    })
  ) {
    return failure(reason);
  }

  let currentDescriptor;
  try {
    currentDescriptor = readControlDescriptor(descriptorPath, channel);
  } catch (error) {
    return failure(
      `app control descriptor changed before reload: ${error.message}`,
    );
  }
  if (
    !currentDescriptor ||
    !sameControlDescriptor(initialDescriptor, currentDescriptor)
  ) {
    return failure("app control descriptor changed before reload");
  }

  let response;
  try {
    response = await fetchImpl(
      `http://127.0.0.1:${currentDescriptor.port}/webview/reload`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${currentDescriptor.token}` },
        signal: requestSignal(deadlineMs, now()),
      },
    );
  } catch (error) {
    return failure(`WebView transition did not acknowledge: ${error.message}`);
  }
  if (!response.ok) {
    return failure(`WebView transition was rejected: HTTP ${response.status}`);
  }
  let acknowledgement;
  try {
    acknowledgement = await response.json();
  } catch (error) {
    return failure(
      `WebView transition acknowledgement is invalid: ${error.message}`,
    );
  }
  if (!validReloadAcknowledgement(acknowledgement)) {
    return failure("WebView transition acknowledgement is invalid");
  }
  return {
    status: "dispatched",
    suppressedUpdates: status.suppressedCount,
    reloaded: acknowledgement.reloaded,
  };
}
