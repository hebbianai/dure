import { isDureDomainIdV1 } from "./protocol-identity.mjs";

/** Transport-neutral runtime envelopes, shared by the desktop adapter and CLI.
 * Consumers decode the authority fields their projection needs. This contract
 * carries no admission, replacement, or replay policy. */
function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Retained policy observations are read-only, never cleanup or wake authority. */
export function parseAgentRuntimeIdleInspection(value) {
  const nullableTime = (time) => time === null || (Number.isSafeInteger(time) && time >= 0);
  const nullableReason = (reason) => reason === null || typeof reason === "string";
  return record(value) && value.schemaVersion === 1 &&
    (value.policyRevision === undefined || nullableTime(value.policyRevision)) &&
    ["enabled", "disabled", "invalid"].includes(value.configuration) &&
    (value.configuration === "enabled"
      ? Number.isSafeInteger(value.afterMs) && value.afterMs >= 1_000 && value.afterMs <= 2_592_000_000
      : value.afterMs === null) &&
    nullableTime(value.observedAtMs) && value.observedAtMs <= 8_640_000_000_000_000 &&
    typeof value.partial === "boolean" &&
    nullableReason(value.reasonCode) && Array.isArray(value.agents) && value.agents.length <= 64 &&
    value.agents.every((agent) => record(agent) && isDureDomainIdV1(agent.agentId) &&
      typeof agent.state === "string" && nullableTime(agent.observedIdleMs) && nullableReason(agent.reasonCode))
    ? { ...value, ...(value.reclamation === undefined ? {} : {
        reclamation: parseRuntimeReclamation(value.reclamation) ?? {
          schemaVersion: 1, state: "unavailable", observedAtMs: null,
          scope: "latest_runtime_transition_admissions", scanned: 0, limit: 64,
          partial: true, reasonCode: "runtime_reclamation_response_invalid", entries: [],
        },
      }) } : undefined;
}

/** A read-only outcome projection, never a wake/stop fence. Unknown optional
 * evidence cannot invalidate policy observations or authorize success. */
export function parseRuntimeReclamation(value) {
  const time = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 8_640_000_000_000_000;
  const code = (v) => typeof v === "string" && /^[a-z][a-z0-9_]{0,159}$/.test(v);
  if (!record(value) || value.schemaVersion !== 1 ||
      !["available", "unavailable"].includes(value.state) ||
      value.scope !== "latest_runtime_transition_admissions" || value.limit !== 64 ||
      !(value.observedAtMs === null || time(value.observedAtMs)) ||
      !Number.isSafeInteger(value.scanned) || value.scanned < 0 || value.scanned > 64 ||
      typeof value.partial !== "boolean" || !(value.reasonCode === null || code(value.reasonCode)) ||
      !Array.isArray(value.entries) || value.entries.length > value.scanned ||
      (value.state === "unavailable" && (value.entries.length !== 0 || value.reasonCode === null)) ||
      (value.state === "available" && (value.observedAtMs === null || value.reasonCode !== null))) return undefined;
  const entries = value.entries.map((entry) => {
    if (!record(entry) || !isDureDomainIdV1(entry.agentId) || !isDureDomainIdV1(entry.providerId) ||
        !isDureDomainIdV1(entry.operationId) || !Number.isSafeInteger(entry.journalRevision) || entry.journalRevision < 1 ||
        !code(entry.stage) || !code(entry.stopState) || !code(entry.wakeState) ||
        !(entry.sourceSessionId === null || isDureDomainIdV1(entry.sourceSessionId)) ||
        !time(entry.requestedAtMs) || !time(entry.updatedAtMs) || entry.updatedAtMs < entry.requestedAtMs ||
        !(entry.reasonCode === null || code(entry.reasonCode))) return undefined;
    return entry;
  });
  return entries.every(Boolean) && new Set(entries.map((e) => e.operationId)).size === entries.length
    ? { ...value, entries } : undefined;
}

export function agentRuntimeIdleConfigureBody({ command, afterMs, expectedRevision }) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
      expectedRevision >= Number.MAX_SAFE_INTEGER) return undefined;
  if (command === "disable" && afterMs === undefined) {
    return { schemaVersion: 1, expectedRevision, policy: { mode: "disabled" } };
  }
  const milliseconds = Number(afterMs);
  if (command !== "set" || String(milliseconds) !== afterMs ||
      !Number.isSafeInteger(milliseconds) || milliseconds < 1_000 || milliseconds > 2_592_000_000) {
    return undefined;
  }
  return { schemaVersion: 1, expectedRevision, policy: { mode: "enabled", afterMs: milliseconds } };
}

export function hasRequiredRuntimeFields(value, keys, ...presentOptional) {
  // Additive response fields do not change the identity or values we consume.
  return [...keys, ...presentOptional].every((key) => Object.hasOwn(value, key));
}

function receiptEnvelope(value, agentId) {
  return (
    record(value) &&
    value.schemaVersion === 1 &&
    value.agentId === agentId &&
    Number.isSafeInteger(value.selectionRevision) &&
    value.selectionRevision > 0
  );
}

export function parseAgentRuntimeTransitionEnvelope(value, agentId) {
  return record(value) &&
    value.schemaVersion === 1 &&
    hasRequiredRuntimeFields(value, ["schemaVersion", "receipt"]) &&
    receiptEnvelope(value.receipt, agentId)
    ? value
    : undefined;
}

export function parseAgentRuntimeInspectionEnvelope(value, agentId) {
  if (!record(value) || value.schemaVersion !== 1) return undefined;
  const context = value.projectionContext;
  if (value.state !== "unmanaged" &&
      !(value.state === "closed" && !Object.hasOwn(value, "source"))) {
    if (!validProjectionContext(context, agentId)) return undefined;
  }
  if (value.state === "stable") {
    return hasRequiredRuntimeFields(value, [
      "state", "schemaVersion", "receipt", "projectionContext",
    ]) && receiptEnvelope(value.receipt, agentId) &&
      context.agent.providerId === value.receipt.providerId
      ? value
      : undefined;
  }
  if (value.agentId !== agentId) return undefined;
  const identity = ["state", "schemaVersion", "agentId"];
  switch (value.state) {
    case "unmanaged":
      return hasRequiredRuntimeFields(value, identity) ? value : undefined;
    case "closed": {
      const fields = [...identity, "operationId", "stage"];
      const hasSource = Object.hasOwn(value, "source");
      return hasSource === Object.hasOwn(value, "projectionContext") &&
        hasRequiredRuntimeFields(value, fields)
        ? value
        : undefined;
    }
    case "transitioning":
      return hasRequiredRuntimeFields(value, [
        ...identity, "projectionContext", "operationId", "stage", "journalRevision",
        "targetInteractionProfile", "targetExecutionProfile",
      ], ...(value.targetFailure === undefined ? [] : ["targetFailure"]))
        ? value
        : undefined;
    default:
      return undefined;
  }
}

/** Unknown additive observations remain readable. Only a complete, known
 * deferred stop boundary can supply an actionable wake fence. */
export function agentRuntimeWakeTarget(value) {
  return record(value) && value.schemaVersion === 1 && value.state === "transitioning" &&
    value.stage === "source_stopped" && record(value.deferredTarget) &&
    value.deferredTarget.state === "waiting" && isDureDomainIdV1(value.operationId) &&
    Number.isSafeInteger(value.journalRevision) && value.journalRevision > 0
    ? { operationId: value.operationId, expectedJournalRevision: value.journalRevision }
    : undefined;
}

/** Parse destructive lifecycle input once, shared by CLI and desktop. Only
 * explicit journal/source fences are serialized, never observation metadata. */
export function agentRuntimeHibernateBody({ agentId, expectedSourceRevision }) {
  return isDureDomainIdV1(agentId) && Number.isSafeInteger(expectedSourceRevision) &&
    expectedSourceRevision > 0
    ? { schemaVersion: 1, agentId, expectedSourceRevision }
    : undefined;
}

export function agentRuntimeWakeBody({
  agentId, operationId, expectedJournalRevision, expectedProviderConversationRef,
}) {
  return isDureDomainIdV1(agentId) && isDureDomainIdV1(operationId) &&
    Number.isSafeInteger(expectedJournalRevision) && expectedJournalRevision > 0 &&
    (expectedProviderConversationRef === undefined ||
      (typeof expectedProviderConversationRef === "string" &&
        expectedProviderConversationRef.trim().length > 0 &&
        expectedProviderConversationRef.trim() === expectedProviderConversationRef))
    ? { schemaVersion: 1, agentId, operationId, expectedJournalRevision,
        ...(expectedProviderConversationRef === undefined ? {} : { expectedProviderConversationRef }) }
    : undefined;
}

/** Parse the service's complete relation once, at the transport boundary.
 * Paths are observations; the client never reconstructs their ownership. */
function validProjectionContext(context, agentId) {
  if (!record(context)) return false;
  const { identity, agent, workspace, project } = context;
  const path = (value) => typeof value === "string" && value.length > 0;
  return context.schemaVersion === 1 &&
    hasRequiredRuntimeFields(context, ["schemaVersion", "identity", "agent", "workspace", "project"]) &&
    record(identity) && record(agent) && record(workspace) && record(project) &&
    ((identity.kind === "registered" && hasRequiredRuntimeFields(identity, ["kind"])) ||
      (identity.kind === "checkpoint_bootstrap" &&
        hasRequiredRuntimeFields(identity, ["kind", "runtimeWorkspaceId"]) &&
        isDureDomainIdV1(identity.runtimeWorkspaceId))) &&
    hasRequiredRuntimeFields(agent, ["agentId", "workspaceId", "providerId"]) &&
    hasRequiredRuntimeFields(workspace, ["workspaceId", "projectId", "rootPath"]) &&
    hasRequiredRuntimeFields(project, ["projectId", "rootPath"]) &&
    isDureDomainIdV1(agentId) && agent.agentId === agentId &&
    isDureDomainIdV1(agent.providerId) &&
    isDureDomainIdV1(agent.workspaceId) && workspace.workspaceId === agent.workspaceId &&
    isDureDomainIdV1(workspace.projectId) && project.projectId === workspace.projectId &&
    path(workspace.rootPath) && path(project.rootPath);
}

/** Serialize an intent, not an observation-derived recovery plan. Omitted
 * targets inherit backend selection; explicit null model/effort reset it. */
export function agentRuntimeTransitionBody({
  agentId,
  targetInteractionProfile,
  expectedSourceRevision,
  sourceStopPolicy = "preserve",
  targetExecutionProfile,
  targetLaunchSelection,
}) {
  return {
    schemaVersion: 1,
    agentId,
    targetInteractionProfile,
    ...(expectedSourceRevision === undefined ? {} : { expectedSourceRevision }),
    ...(sourceStopPolicy === "preserve" ? {} : { sourceStopPolicy }),
    ...(targetExecutionProfile === undefined ? {} : { targetExecutionProfile }),
    ...(targetLaunchSelection === undefined
      ? {}
      : { targetLaunchSelection: runtimeLaunchSelectionBody(targetLaunchSelection) }),
  };
}

export function runtimeLaunchSelectionBody(selection) {
  return {
    ...(selection.model === null ? {} : { model: selection.model }),
    ...(selection.effort === null ? {} : { effort: selection.effort }),
    ...(selection.permissionMode === undefined
      ? {}
      : { permissionMode: selection.permissionMode }),
  };
}
