import { isDureDomainIdV1 } from "./protocol-identity.mjs";

/** Wire contract for the backend-owned `dispatch.stop.*` journal. The app and
 * the CLI both read receipts through this one parser and projection. */

const PLAN_TOKEN = /^sha256:[a-f0-9]{64}$/;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function hasOnlyKeys(value, allowed) {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function positiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function stateStatus(value) {
  const state = record(value);
  if (!state) return undefined;
  const status = state.status;
  if (status === "planned" || status === "superseded") {
    return hasOnlyKeys(state, ["status"]) ? status : undefined;
  }
  if (status === "authorized") {
    return hasOnlyKeys(state, ["status", "runtimeCloseOperationId"]) &&
      isDureDomainIdV1(state.runtimeCloseOperationId)
      ? status
      : undefined;
  }
  if (status === "workspace_preserved" || status === "source_retained" || status === "workspace_replaced") {
    return hasOnlyKeys(state, ["status", "runtime"]) && record(state.runtime) ? status : undefined;
  }
  return status === "succeeded" &&
    hasOnlyKeys(state, ["status", "runtime", "workspace"]) &&
    record(state.runtime) &&
    record(state.workspace)
    ? status
    : undefined;
}

function workspaceDisposition(plan) {
  if (plan.workspaceDisposition === "preserve" && plan.ownedCheckout === undefined) return "preserve";
  return plan.workspaceDisposition === undefined && record(plan.ownedCheckout) ? "remove_owned" : undefined;
}

function dispositionAllowsStatus(disposition, status) {
  if (status === "planned" || status === "superseded" || status === "authorized" || status === "source_retained") {
    return true;
  }
  return disposition === "preserve"
    ? status === "workspace_preserved"
    : status === "succeeded" || status === "workspace_replaced";
}

/** Normalizes the durable stop wire receipt once at the backend boundary.
 * Returns null for an absent receipt and undefined for a contract violation. */
export function parseCanonicalAgentStopResultV1(value, expectedSpawnOperationId) {
  const result = record(value);
  if (!result || !hasOnlyKeys(result, ["schemaVersion", "receipt"]) || result.schemaVersion !== 1) {
    return undefined;
  }
  if (result.receipt === null) return null;
  const receipt = record(result.receipt);
  const plan = record(receipt?.plan);
  const spawn = record(plan?.spawn);
  const status = stateStatus(receipt?.state);
  const disposition = plan ? workspaceDisposition(plan) : undefined;
  if (
    !receipt ||
    !plan ||
    !spawn ||
    !status ||
    !disposition ||
    !hasOnlyKeys(receipt, ["plan", "state", "journalRevision", "createdAtMs", "updatedAtMs"]) ||
    plan.schemaVersion !== 1 ||
    spawn.operationId !== expectedSpawnOperationId ||
    !isDureDomainIdV1(expectedSpawnOperationId) ||
    !isDureDomainIdV1(plan.operationId) ||
    !isDureDomainIdV1(plan.agentId) ||
    typeof plan.planToken !== "string" ||
    !PLAN_TOKEN.test(plan.planToken) ||
    !positiveInteger(receipt.journalRevision) ||
    !Number.isSafeInteger(receipt.createdAtMs) ||
    !Number.isSafeInteger(receipt.updatedAtMs) ||
    !dispositionAllowsStatus(disposition, status)
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    operationId: plan.operationId,
    spawnOperationId: expectedSpawnOperationId,
    agentId: plan.agentId,
    planToken: plan.planToken,
    journalRevision: receipt.journalRevision,
    workspaceDisposition: disposition,
    status,
  };
}

/** Reduces one backend-owned receipt to the only presentation action it permits. */
export function projectCanonicalAgentStopV1(receipt) {
  if (!receipt) return { kind: "absent" };
  switch (receipt.status) {
    case "planned":
      return { kind: "pending_confirmation", receipt };
    case "authorized":
      return { kind: "resume_apply", receipt };
    case "workspace_preserved":
    case "succeeded":
    case "workspace_replaced":
      return { kind: "forget_presentation", receipt };
    case "superseded":
    case "source_retained":
      return { kind: "source_retained", receipt };
  }
}

/** The journal revision `dispatch.stop.apply` must fence, or null when the
 * receipt cannot be applied. */
export function canonicalAgentStopApplyRevisionV1(receipt) {
  if (receipt.status === "planned") return receipt.journalRevision;
  if (receipt.status === "authorized" && receipt.journalRevision > 1) return receipt.journalRevision - 1;
  return null;
}
