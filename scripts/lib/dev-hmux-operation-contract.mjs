import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  parseColdBootstrapOperation,
  parseColdBootstrapOperationId,
} from "./dev-cold-bootstrap-operation.mjs";

const manifestPath = fileURLToPath(
  new URL(
    "../../hmux/protocol/standalone-create-operation-v1.json",
    import.meta.url,
  ),
);
const manifest = Object.freeze(JSON.parse(readFileSync(manifestPath, "utf8")));
const modes = Array.isArray(manifest.modes) ? manifest.modes : [];
const reconcileMode = manifest.reconcileRequestExample?.mode;
const retireMode = manifest.retireRequestExample?.mode;
const acknowledgeMode = manifest.acknowledgeRequestExample?.mode;
const createMode = modes.find(
  (mode) =>
    mode !== reconcileMode &&
    mode !== retireMode &&
    mode !== acknowledgeMode,
);
if (
  modes.length !== 4 ||
  new Set(modes).size !== 4 ||
  modes.some((mode) => typeof mode !== "string" || mode.length === 0) ||
  !modes.includes(reconcileMode) ||
  !modes.includes(retireMode) ||
  !modes.includes(acknowledgeMode) ||
  !createMode
) {
  throw new Error("invalid Hmux standalone operation mode manifest");
}

export const DEV_HMUX_STANDALONE_OPERATION_SCHEMA_VERSION =
  manifest.schemaVersion;
export const DEV_HMUX_STANDALONE_OPERATION_SUBCOMMAND = manifest.subcommand;
export const DEV_HMUX_STANDALONE_OPERATION_CAPABILITY = manifest.capability;
export const DEV_HMUX_STANDALONE_RECONCILE_CAPABILITY =
  manifest.reconcileCapability;
export const DEV_HMUX_STANDALONE_RETIRE_CAPABILITY = manifest.retireCapability;
export const DEV_HMUX_STANDALONE_ACKNOWLEDGE_CAPABILITY =
  manifest.acknowledgeCapability;
export const DEV_HMUX_STANDALONE_OPERATION_FRAME_LIMIT =
  manifest.frameLimitBytes;
export const DEV_HMUX_STANDALONE_OPERATION_MODE = Object.freeze({
  CREATE: createMode,
  RECONCILE_COMPLETED_TARGET: reconcileMode,
  RETIRE_COMPLETED_TARGET: retireMode,
  ACKNOWLEDGE_RETIRED_TARGET: acknowledgeMode,
});

function boundedIdentity(value) {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value) > 0 &&
    Buffer.byteLength(value) <= 256 &&
    !/[\0\r\n]/.test(value)
  );
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function operationId(value) {
  return parseColdBootstrapOperationId(value);
}

export function parseDevHmuxStandaloneOperationMode(value) {
  if (
    value === undefined ||
    value === DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE
  ) {
    return DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE;
  }
  if (value === DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET) {
    return value;
  }
  if (value === DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET) {
    return value;
  }
  if (value === DEV_HMUX_STANDALONE_OPERATION_MODE.ACKNOWLEDGE_RETIRED_TARGET) {
    return value;
  }
  throw new Error("invalid Hmux standalone operation mode");
}

export function parseDevHmuxStandaloneCommand(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 64 ||
    value.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length === 0 ||
        Buffer.byteLength(argument) > 4_096 ||
        argument.includes("\0"),
    )
  ) {
    throw new Error("invalid Hmux standalone operation command");
  }
  return Object.freeze([...value]);
}

export function devHmuxStandaloneCommandEnvironmentValue(command, name) {
  const prefix = `${name}=`;
  const assignment = command?.find((value) => value.startsWith(prefix));
  return assignment?.slice(prefix.length);
}

export function parseDevHmuxStandaloneOperationBinding(value) {
  if (
    !hasExactKeys(value, [
      "operationId",
      "sessionName",
      "command",
      "initialRows",
      "initialColumns",
    ]) ||
    !boundedIdentity(value.sessionName)
  ) {
    throw new Error("invalid Hmux standalone operation binding");
  }
  const operation = parseColdBootstrapOperation(value);
  return Object.freeze({
    ...operation,
    sessionName: value.sessionName,
    command: parseDevHmuxStandaloneCommand(value.command),
  });
}

function errorCode(value) {
  if (
    !boundedIdentity(value) ||
    !value.startsWith("hmux_") ||
    !/^[A-Za-z0-9._:+-]+$/.test(value)
  ) {
    throw new Error("invalid Hmux standalone operation error code");
  }
  return value;
}

export function parseDevHmuxStandaloneRetirement(value, expected) {
  const expectedOperationId = operationId(expected.operationId);
  if (
    !hasExactKeys(value, [
      "outcome",
      "schemaVersion",
      "operationId",
      "sessionName",
      "sessionId",
      "workspaceId",
    ]) ||
    value.outcome !== "retired" ||
    value.schemaVersion !== DEV_HMUX_STANDALONE_OPERATION_SCHEMA_VERSION ||
    value.operationId !== expectedOperationId ||
    value.sessionName !== expected.sessionName ||
    !boundedIdentity(value.sessionName) ||
    value.sessionId !== `standalone_${expectedOperationId}` ||
    !boundedIdentity(value.workspaceId)
  ) {
    throw new Error("invalid Hmux standalone operation retirement receipt");
  }
  return Object.freeze({
    outcome: "retired",
    schemaVersion: DEV_HMUX_STANDALONE_OPERATION_SCHEMA_VERSION,
    operationId: expectedOperationId,
    sessionName: value.sessionName,
    sessionId: value.sessionId,
    workspaceId: value.workspaceId,
  });
}

export function parseDevHmuxStandaloneAcknowledgement(value, expected) {
  const expectedOperationId = operationId(expected.operationId);
  if (
    !hasExactKeys(value, ["outcome", "schemaVersion", "operationId"]) ||
    value.outcome !== "acknowledged" ||
    value.schemaVersion !== DEV_HMUX_STANDALONE_OPERATION_SCHEMA_VERSION ||
    value.operationId !== expectedOperationId
  ) {
    throw new Error("invalid Hmux standalone operation acknowledgement receipt");
  }
  return Object.freeze({
    outcome: "acknowledged",
    schemaVersion: DEV_HMUX_STANDALONE_OPERATION_SCHEMA_VERSION,
    operationId: expectedOperationId,
  });
}

export function encodeDevHmuxStandaloneOperation(request) {
  if (Object.hasOwn(request, "reconcileCompletedTarget")) {
    throw new Error("invalid Hmux standalone operation mode");
  }
  const mode = parseDevHmuxStandaloneOperationMode(request.mode);
  const binding = parseDevHmuxStandaloneOperationBinding({
    operationId: request.operationId,
    sessionName: request.sessionName,
    command: request.command,
    initialRows: request.initialRows,
    initialColumns: request.initialColumns,
  });
  const payload = Buffer.from(
    JSON.stringify({
      schemaVersion: DEV_HMUX_STANDALONE_OPERATION_SCHEMA_VERSION,
      operationId: binding.operationId,
      sessionName: binding.sessionName,
      command: binding.command,
      initialRows: binding.initialRows,
      initialColumns: binding.initialColumns,
      ...(mode === DEV_HMUX_STANDALONE_OPERATION_MODE.CREATE ? {} : { mode }),
    }),
  );
  if (
    payload.length < 1 ||
    payload.length > DEV_HMUX_STANDALONE_OPERATION_FRAME_LIMIT
  ) {
    throw new Error("Hmux standalone operation request frame is invalid");
  }
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32BE(payload.length);
  payload.copy(frame, 4);
  return frame;
}

export function decodeDevHmuxStandaloneOperation(frame, expected) {
  if (!Buffer.isBuffer(frame) || frame.length < 4) {
    throw new Error("invalid Hmux standalone operation response frame");
  }
  const length = frame.readUInt32BE(0);
  if (
    length < 1 ||
    length > DEV_HMUX_STANDALONE_OPERATION_FRAME_LIMIT ||
    frame.length !== 4 + length
  ) {
    throw new Error("invalid Hmux standalone operation response frame");
  }
  let value;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(4)),
    );
  } catch (error) {
    throw new Error(
      `invalid Hmux standalone operation response JSON: ${error.message}`,
    );
  }
  const expectedOperationId = operationId(expected.operationId);
  const expectedMode = parseDevHmuxStandaloneOperationMode(expected.mode);
  if (
    value?.schemaVersion !== DEV_HMUX_STANDALONE_OPERATION_SCHEMA_VERSION ||
    value.operationId !== expectedOperationId
  ) {
    throw new Error("invalid Hmux standalone operation receipt");
  }
  if (value.outcome === "pending" || value.outcome === "refused") {
    if (
      !hasExactKeys(value, [
        "outcome",
        "schemaVersion",
        "operationId",
        "errorCode",
      ])
    ) {
      throw new Error("invalid Hmux standalone operation receipt");
    }
    return Object.freeze({
      outcome: value.outcome,
      errorCode: errorCode(value.errorCode),
    });
  }
  if (value.outcome === "retired") {
    if (
      expectedMode !==
        DEV_HMUX_STANDALONE_OPERATION_MODE.RECONCILE_COMPLETED_TARGET &&
      expectedMode !==
        DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET
    ) {
      throw new Error("invalid Hmux standalone operation receipt");
    }
    return parseDevHmuxStandaloneRetirement(value, expected);
  }
  if (value.outcome === "acknowledged") {
    if (
      expectedMode !==
      DEV_HMUX_STANDALONE_OPERATION_MODE.ACKNOWLEDGE_RETIRED_TARGET
    ) {
      throw new Error("invalid Hmux standalone operation receipt");
    }
    return parseDevHmuxStandaloneAcknowledgement(value, expected);
  }
  if (
    expectedMode ===
      DEV_HMUX_STANDALONE_OPERATION_MODE.ACKNOWLEDGE_RETIRED_TARGET ||
    expectedMode === DEV_HMUX_STANDALONE_OPERATION_MODE.RETIRE_COMPLETED_TARGET
  ) {
    throw new Error("invalid Hmux standalone operation receipt");
  }
  if (
    !hasExactKeys(value, [
      "outcome",
      "schemaVersion",
      "operationId",
      "sessionName",
      "sessionId",
      "workspaceId",
    ]) ||
    value.outcome !== "created" ||
    value.sessionName !== expected.sessionName ||
    value.sessionId !== `standalone_${expectedOperationId}` ||
    !boundedIdentity(value.sessionId) ||
    !boundedIdentity(value.workspaceId)
  ) {
    throw new Error("invalid Hmux standalone operation receipt");
  }
  return Object.freeze({
    outcome: "created",
    sessionName: value.sessionName,
    sessionId: value.sessionId,
    workspaceId: value.workspaceId,
  });
}

export function devHmuxStandaloneOperationExamples() {
  return manifest;
}
