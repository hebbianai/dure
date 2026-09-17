import { createHash, randomBytes } from "node:crypto";

const OPERATION_ID = /^[a-f0-9]{64}$/;
export const V4_COLD_BOOTSTRAP_TERMINAL_SIZE = Object.freeze({
  initialRows: 24,
  initialColumns: 80,
});
const DEFAULT_COLD_BOOTSTRAP_TERMINAL_SIZE =
  V4_COLD_BOOTSTRAP_TERMINAL_SIZE;

function createColdBootstrapOperationId() {
  return randomBytes(32).toString("hex");
}

export function parseColdBootstrapOperationId(value) {
  if (typeof value !== "string" || !OPERATION_ID.test(value)) {
    throw new Error("cold-bootstrap operation ID is invalid");
  }
  return value;
}

function parseTerminalDimension(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`cold-bootstrap ${label} is invalid`);
  }
  return value;
}

export function parseColdBootstrapOperation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cold-bootstrap operation is invalid");
  }
  return Object.freeze({
    operationId: parseColdBootstrapOperationId(value.operationId),
    initialRows: parseTerminalDimension(value.initialRows, "initial rows"),
    initialColumns: parseTerminalDimension(
      value.initialColumns,
      "initial columns",
    ),
  });
}

export function createColdBootstrapOperation() {
  return Object.freeze({
    operationId: createColdBootstrapOperationId(),
    ...DEFAULT_COLD_BOOTSTRAP_TERMINAL_SIZE,
  });
}

export function coldBootstrapSessionName({ root, channel, operationId }) {
  const canonicalOperationId = parseColdBootstrapOperationId(operationId);
  const suffix = createHash("sha256")
    .update(`${root}\0${channel}\0${canonicalOperationId}`)
    .digest("hex")
    .slice(0, 16);
  return `dure-dev-${suffix}`;
}
