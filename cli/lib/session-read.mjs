import { backendRequestFailure } from "./backend-request-failure.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import {
  DEFAULT_SESSION_READ_DEADLINE_MS,
  MAX_SESSION_READ_DEADLINE_MS,
  MAX_SESSION_READ_LINES,
  MAX_SESSION_READ_OUTPUT_BYTES,
} from "./session-read-limits.mjs";
export {
  DEFAULT_SESSION_READ_DEADLINE_MS,
  MAX_SESSION_READ_DEADLINE_MS,
  MAX_SESSION_READ_LINES,
  MAX_SESSION_READ_OUTPUT_BYTES,
} from "./session-read-limits.mjs";

export const SESSION_READ_SCHEMA_VERSION = 1;
const MAX_SESSION_READ_TRANSPORT_BYTES =
  MAX_SESSION_READ_OUTPUT_BYTES + 64 * 1024;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const IDENTITY = /^[A-Za-z0-9._:/-]{1,160}$/;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return (
    record(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function identity(value) {
  return typeof value === "string" && IDENTITY.test(value);
}

function validPayload(value, sessionId, workspaceId, maximumLines) {
  return (
    exactKeys(value, [
      "schemaVersion",
      "sessionId",
      "workspaceId",
      "sequenceThrough",
      "lines",
    ]) &&
    value.schemaVersion === SESSION_READ_SCHEMA_VERSION &&
    value.sessionId === sessionId &&
    value.workspaceId === workspaceId &&
    typeof value.sequenceThrough === "string" &&
    value.sequenceThrough.length <= 32 &&
    DECIMAL.test(value.sequenceThrough) &&
    Array.isArray(value.lines) &&
    value.lines.length <= maximumLines &&
    value.lines.every((line) => typeof line === "string")
  );
}

function errorReport(code, observedAtMs, durationMs, details = {}) {
  const { deadlineMs = DEFAULT_SESSION_READ_DEADLINE_MS, ...error } = details;
  return {
    schemaVersion: SESSION_READ_SCHEMA_VERSION,
    apiVersion: "dure.sessions/v1",
    kind: "dure.sessions.error",
    action: "read",
    complete: false,
    observedAtMs,
    durationMs,
    source: { kind: "backend_profile", appDaemonRequired: false },
    limits: {
      deadlineMs,
      maxLines: MAX_SESSION_READ_LINES,
      maxOutputBytes: MAX_SESSION_READ_OUTPUT_BYTES,
    },
    error: { code, ...error },
  };
}

function backendErrorReport(error, profile, startedAt, deadlineMs) {
  const observedAtMs = Date.now();
  const { code, ...detail } = backendRequestFailure(error, profile);
  return errorReport(
    code,
    observedAtMs,
    Math.max(0, observedAtMs - startedAt),
    {
      deadlineMs,
      ...(profile ? { profileId: profile.id } : {}),
      ...detail,
    },
  );
}

export async function collectSessionRead({
  backend,
  deadlineMs = DEFAULT_SESSION_READ_DEADLINE_MS,
  lines = 20,
  requestBackend = performBackendProfileRequest,
  sessionId,
  signal,
  workspaceId,
} = {}) {
  const startedAt = Date.now();
  if (
    !identity(sessionId) ||
    !identity(workspaceId) ||
    !Number.isSafeInteger(lines) ||
    lines < 1 ||
    lines > MAX_SESSION_READ_LINES ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > MAX_SESSION_READ_DEADLINE_MS
  ) {
    return errorReport("dure_session_read_invalid", Date.now(), 0, {
      deadlineMs,
    });
  }
  const profile = backend?.profile;
  if (backend?.error || !profile) {
    return backendErrorReport(backend?.error, profile, startedAt, deadlineMs);
  }

  let response;
  try {
    response = await requestBackend(
      profile,
      {
        operation: "sessions.read",
        requiredCapabilities: ["sessions.read"],
        body: {
          schemaVersion: SESSION_READ_SCHEMA_VERSION,
          sessionId,
          workspaceId,
          lines,
        },
      },
      {
        ...backend.transportOptions,
        deadlineMs,
        maxResponseBytes: MAX_SESSION_READ_TRANSPORT_BYTES,
        signal,
      },
    );
  } catch (error) {
    return backendErrorReport(error, profile, startedAt, deadlineMs);
  }

  const observedAtMs = Date.now();
  const durationMs = Math.max(0, observedAtMs - startedAt);
  if (!validPayload(response.result, sessionId, workspaceId, lines)) {
    return errorReport(
      "dure_session_backend_payload_invalid",
      observedAtMs,
      durationMs,
      { deadlineMs, profileId: profile.id },
    );
  }
  const report = {
    schemaVersion: SESSION_READ_SCHEMA_VERSION,
    apiVersion: "dure.sessions/v1",
    kind: "dure.sessions.read",
    action: "read",
    complete: true,
    observedAtMs,
    durationMs,
    source: {
      kind: "backend_profile",
      appDaemonRequired: false,
      profileId: profile.id,
      transport: profile.transport.kind,
      backend: response.backend,
    },
    limits: {
      deadlineMs,
      maxLines: MAX_SESSION_READ_LINES,
      maxOutputBytes: MAX_SESSION_READ_OUTPUT_BYTES,
    },
    sessionId,
    workspaceId,
    sequenceThrough: response.result.sequenceThrough,
    lines: response.result.lines,
  };
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_SESSION_READ_OUTPUT_BYTES) {
    return errorReport(
      "dure_session_read_output_limit",
      observedAtMs,
      durationMs,
      { deadlineMs, profileId: profile.id },
    );
  }
  return report;
}

export function sessionReadExitCode(report) {
  return report.kind === "dure.sessions.read" ? 0 : 2;
}

export function formatSessionRead(report) {
  return report.kind === "dure.sessions.read"
    ? report.lines.join("\n")
    : `Dure session read unavailable: ${report.error.code}`;
}
