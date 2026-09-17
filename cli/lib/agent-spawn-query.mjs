import { isProviderModelSelection, isProviderEffortSelection } from "./contracts/provider-launch-selection.mjs";
import { createHash } from "node:crypto";
import { backendRequestFailure } from "./backend-request-failure.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { validProjectId, validProjectPath } from "./project-contract.mjs";
import { validWorktree, selectedCheckoutReference, checkoutRegistrationMatches } from "./contracts/agent-spawn-worktree.mjs";

export const AGENT_SPAWN_QUERY_SCHEMA_VERSION = 1;
export const DEFAULT_AGENT_SPAWN_DEADLINE_MS = 2_500;
export const DEFAULT_AGENT_SPAWN_APPLY_DEADLINE_MS = 185_000;
// Preview and status are reads; apply provisions a worktree and launches a
// provider, and its default must sit under its own cap (e4174111b raised the
// default above the single 60s cap, refusing every apply before transport).
export const MAX_AGENT_SPAWN_DEADLINE_MS = 60_000;
export const MAX_AGENT_SPAWN_APPLY_DEADLINE_MS = 300_000;
export const MAX_AGENT_SPAWN_OUTPUT_BYTES = 256 * 1024;
export const AGENT_SPAWN_PRESENTATION_PROJECT_CAPABILITY =
  "agent_spawn.presentation_project.v1";

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PROVIDER_CONVERSATION_REF = /^[A-Za-z0-9._:/-]{1,160}$/;
const AGENT_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const SHA256 = /^sha256:[a-f0-9]{64}$/;
const ROOT_ID = /^root_[a-f0-9]{32}$/;
const REPOSITORY_ID = /^repo_[a-f0-9]{32}$/;
const MAX_SETUP_COMMAND_BYTES = 4 * 1024;
const NATIVE_STAGES = ["worktree", "runtime_launch", "prompt_delivery"];
const STRUCTURED_STAGES = [
  "worktree",
  "structured_launch",
  "structured_prompt_delivery",
];
const STAGES = [...NATIVE_STAGES, ...STRUCTURED_STAGES.slice(1)];
const STATES = [
  "applying",
  "ready_to_succeed",
  "inspect_before_retry",
  "retry_required",
  "prompt_delivery_uncertain",
  "succeeded",
  "failed",
  "manual_intervention_required",
];
const PERMISSION_MODES = ["default", "auto_edit", "skip_permissions"];
const PERMISSION_OVERRIDES = [
  "require_approvals",
  "auto_edit",
  "bypass_approvals",
];

function plannedStages(plan) {
  const launch = normalizedLaunch(plan);
  const stages = launch?.interactionProfile === "structured_protocol"
    ? STRUCTURED_STAGES
    : NATIVE_STAGES;
  return plan.request.promptDigest === null ? stages.slice(0, 2) : stages;
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value, keys) {
  return (
    record(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort())
  );
}

/** Exact key set, plus optional keys that may be absent. Used where the
 *  backend adds evidence a reader must tolerate but need not require — a
 *  strict set there would reject exactly the failed receipts an operator is
 *  trying to read. */
function onlyKeysWithOptional(value, keys, optional) {
  return (
    record(value) &&
    onlyKeys(
      value,
      [...keys, ...optional.filter((key) => key in value)],
    )
  );
}

/** One bounded line of free-form evidence (never a token). */
function errorDetail(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value)
  );
}

function safeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalJson(value[key])]),
  );
}


function validRequestFields(value, options) {
  return (
    record(value) &&
    value.schemaVersion === AGENT_SPAWN_QUERY_SCHEMA_VERSION &&
    typeof value.idempotencyKey === "string" &&
    TOKEN.test(value.idempotencyKey) &&
    typeof value.providerId === "string" &&
    TOKEN.test(value.providerId) &&
    typeof value.agentName === "string" &&
    AGENT_NAME.test(value.agentName) &&
    validWorktree(value.worktree, options) &&
    PERMISSION_MODES.includes(value.permissionMode) &&
    (value.promptDigest === null || SHA256.test(value.promptDigest)) &&
    validExecutionProfile(value.executionProfile, { allowMissing: true }) &&
    validSetupCommand(value.setupCommand) &&
    (value.model === undefined ||
      (typeof value.model === "string" && isProviderModelSelection(value.model))) &&
    (value.effort === undefined ||
      (typeof value.effort === "string" && isProviderEffortSelection(value.effort))) &&
    (value.setupCommand === undefined || value.worktree.kind === "dedicated")
  );
}

export function validExecutionProfile(value, { allowMissing = false } = {}) {
  if (value === undefined) return allowMissing;
  if (onlyKeys(value, ["kind"]) && value.kind === "provider_default") {
    return true;
  }
  return (
    onlyKeys(value, ["kind", "reference_id", "credential_generation"]) &&
    value.kind === "credential_reference" &&
    typeof value.reference_id === "string" &&
    TOKEN.test(value.reference_id) &&
    typeof value.credential_generation === "string" &&
    TOKEN.test(value.credential_generation)
  );
}

function normalizedExecutionProfile(value) {
  return value ?? { kind: "provider_default" };
}

function validSetupCommand(value) {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.trim().length > 0 &&
      Buffer.byteLength(value, "utf8") <= MAX_SETUP_COMMAND_BYTES &&
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return (
          (codePoint <= 0x1f && character !== "\n" && character !== "\t") ||
          (codePoint >= 0x7f && codePoint <= 0x9f)
        );
      }))
  );
}

function validNormalizedRequest(value) {
  const setupKeys = value?.setupCommand === undefined ? [] : ["setupCommand"];
  const executionProfileKeys = value?.executionProfile === undefined
    ? []
    : ["executionProfile"];
  const providerConversationKeys = value?.providerConversationRef === undefined
    ? []
    : ["providerConversationRef"];
  const modelKeys = value?.model === undefined ? [] : ["model"];
  const effortKeys = value?.effort === undefined ? [] : ["effort"];
  const interactionKeys = value?.interactionPreference === undefined
    ? []
    : ["interactionPreference"];
  return (
    onlyKeys(value, [
      "schemaVersion",
      "idempotencyKey",
      "projectId",
      "providerId",
      "agentName",
      "worktree",
      ...providerConversationKeys,
      "permissionMode",
      "promptDigest",
      ...executionProfileKeys,
      ...setupKeys,
      ...modelKeys,
      ...effortKeys,
      ...interactionKeys,
    ]) &&
    validRequestFields(value) &&
    (value.interactionPreference === undefined ||
      value.interactionPreference === "native_cli") &&
    (value.providerConversationRef === undefined ||
      value.providerConversationRef === null ||
      (typeof value.providerConversationRef === "string" &&
        PROVIDER_CONVERSATION_REF.test(value.providerConversationRef))) &&
    validProjectId(value.projectId)
  );
}

function validPreviewRequest(value) {
  if (!record(value)) return false;
  const hasProjectId = value.projectId !== undefined;
  const hasProjectPath = value.projectPath !== undefined;
  const selector = hasProjectId ? "projectId" : "projectPath";
  const setupKeys = value.setupCommand === undefined ? [] : ["setupCommand"];
  const overrideKeys = value.permissionOverride === undefined
    ? []
    : ["permissionOverride"];
  const presentationKeys = value.includePresentationProject === undefined
    ? []
    : ["includePresentationProject"];
  return (
    hasProjectId !== hasProjectPath &&
    onlyKeys(value, [
      "schemaVersion",
      "idempotencyKey",
      selector,
      "providerId",
      "agentName",
      "worktree",
      ...overrideKeys,
      ...presentationKeys,
      "promptDigest",
      ...setupKeys,
    ]) &&
    value.schemaVersion === AGENT_SPAWN_QUERY_SCHEMA_VERSION &&
    typeof value.idempotencyKey === "string" &&
    TOKEN.test(value.idempotencyKey) &&
    typeof value.providerId === "string" &&
    TOKEN.test(value.providerId) &&
    typeof value.agentName === "string" &&
    AGENT_NAME.test(value.agentName) &&
    validWorktree(value.worktree, { allowUnresolvedBase: true }) &&
    (value.permissionOverride === undefined ||
      PERMISSION_OVERRIDES.includes(value.permissionOverride)) &&
    (value.includePresentationProject === undefined ||
      value.includePresentationProject === true) &&
    (value.promptDigest === null || SHA256.test(value.promptDigest)) &&
    validSetupCommand(value.setupCommand) &&
    (value.setupCommand === undefined || value.worktree.kind === "dedicated") &&
    (hasProjectId
      ? validProjectId(value.projectId)
      : validProjectPath(value.projectPath))
  );
}

function validProviderLaunchDefaultsResolution(value) {
  return (
    onlyKeys(value, [
      "schemaVersion",
      "revision",
      "fingerprint",
      "permissionOverride",
    ]) &&
    value.schemaVersion === 1 &&
    safeInteger(value.revision) &&
    SHA256.test(value.fingerprint) &&
    (value.permissionOverride === null ||
      PERMISSION_OVERRIDES.includes(value.permissionOverride))
  );
}

function validRuntimePlan(value) {
  return (
    onlyKeys(value, ["runtimeKindId", "requiredCapabilities"]) &&
    typeof value.runtimeKindId === "string" &&
    TOKEN.test(value.runtimeKindId) &&
    Array.isArray(value.requiredCapabilities) &&
    value.requiredCapabilities.length > 0 &&
    value.requiredCapabilities.length <= 32 &&
    value.requiredCapabilities.every(
      (item, index, values) =>
        typeof item === "string" &&
        TOKEN.test(item) &&
        (index === 0 || values[index - 1] < item),
    )
  );
}

function validCanonicalLaunch(value) {
  if (
    onlyKeys(value, ["interactionProfile"]) &&
    value.interactionProfile === "structured_protocol"
  ) {
    return true;
  }
  return (
    onlyKeys(value, ["interactionProfile", "sessionId", "runtime"]) &&
    value.interactionProfile === "native_cli" &&
    typeof value.sessionId === "string" &&
    TOKEN.test(value.sessionId) &&
    validRuntimePlan(value.runtime)
  );
}

function normalizedLaunch(value) {
  if (!record(value)) return null;
  const hasCanonical = value.launch !== undefined;
  const hasLegacySession = value.sessionId !== undefined;
  const hasLegacyRuntime = value.runtime !== undefined;
  if (hasCanonical) {
    return !hasLegacySession && !hasLegacyRuntime && validCanonicalLaunch(value.launch)
      ? value.launch
      : null;
  }
  return hasLegacySession && hasLegacyRuntime &&
      typeof value.sessionId === "string" &&
      TOKEN.test(value.sessionId) && validRuntimePlan(value.runtime)
    ? {
        interactionProfile: "native_cli",
        sessionId: value.sessionId,
        runtime: value.runtime,
      }
    : null;
}

function validPlan(value) {
  const defaultsKeys = value?.providerLaunchDefaults === undefined
    ? []
    : ["providerLaunchDefaults"];
  const launch = normalizedLaunch(value);
  const launchKeys = value?.launch === undefined
    ? ["sessionId", "runtime"]
    : ["launch"];
  return (
    onlyKeys(value, [
      "schemaVersion",
      "operationId",
      "authority",
      "request",
      "agentId",
      "workspaceId",
      ...launchKeys,
      ...defaultsKeys,
      "planToken",
    ]) &&
    value.schemaVersion === AGENT_SPAWN_QUERY_SCHEMA_VERSION &&
    TOKEN.test(value.operationId) &&
    onlyKeys(value.authority, [
      "backendId",
      "backendGeneration",
      "projectId",
      "rootId",
      "repositoryId",
    ]) &&
    TOKEN.test(value.authority.backendId) &&
    TOKEN.test(value.authority.backendGeneration) &&
    validProjectId(value.authority.projectId) &&
    ROOT_ID.test(value.authority.rootId) &&
    REPOSITORY_ID.test(value.authority.repositoryId) &&
    validNormalizedRequest(value.request) &&
    value.request.projectId === value.authority.projectId &&
    TOKEN.test(value.agentId) &&
    TOKEN.test(value.workspaceId) &&
    launch !== null &&
    (value.providerLaunchDefaults === undefined ||
      validProviderLaunchDefaultsResolution(value.providerLaunchDefaults)) &&
    SHA256.test(value.planToken)
  );
}

function validProviderRuntimeFence(value) {
  return (
    onlyKeys(value, ["runtimeGeneration", "providerEpoch"]) &&
    typeof value.runtimeGeneration === "string" &&
    TOKEN.test(value.runtimeGeneration) &&
    typeof value.providerEpoch === "string" &&
    TOKEN.test(value.providerEpoch)
  );
}

function validInteractionBinding(value) {
  return (
    onlyKeys(value, [
      "schemaVersion",
      "interactionSessionId",
      "agentId",
      "providerId",
      "executionProfile",
      "providerConversationRef",
      "runtime",
      "timelineEpoch",
      "bindingRevision",
      "historyComplete",
      "createdAtMs",
      "updatedAtMs",
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.interactionSessionId === "string" &&
    TOKEN.test(value.interactionSessionId) &&
    typeof value.agentId === "string" &&
    TOKEN.test(value.agentId) &&
    typeof value.providerId === "string" &&
    TOKEN.test(value.providerId) &&
    validExecutionProfile(value.executionProfile) &&
    (value.providerConversationRef === null ||
      (typeof value.providerConversationRef === "string" &&
        PROVIDER_CONVERSATION_REF.test(value.providerConversationRef))) &&
    validProviderRuntimeFence(value.runtime) &&
    typeof value.timelineEpoch === "string" &&
    TOKEN.test(value.timelineEpoch) &&
    Number.isSafeInteger(value.bindingRevision) &&
    value.bindingRevision >= 1 &&
    typeof value.historyComplete === "boolean" &&
    safeInteger(value.createdAtMs) &&
    safeInteger(value.updatedAtMs) &&
    value.updatedAtMs >= value.createdAtMs
  );
}

function validStageInputs(value) {
  if (!record(value) || !STAGES.includes(value.stage)) return false;
  if (value.stage === "worktree") {
    return (
      onlyKeys(value, [
        "stage",
        "workspace_id",
        "project_root_id",
        "repository_id",
        "policy",
      ]) &&
      TOKEN.test(value.workspace_id) &&
      ROOT_ID.test(value.project_root_id) &&
      REPOSITORY_ID.test(value.repository_id) &&
      validWorktree(value.policy)
    );
  }
  if (value.stage === "runtime_launch") {
    const providerConversationKeys = value.provider_conversation_ref === undefined
      ? []
      : ["provider_conversation_ref"];
    const setupKeys = value.setup_command === undefined ? [] : ["setup_command"];
    const modelKeys = value.model === undefined ? [] : ["model"];
    const effortKeys = value.effort === undefined ? [] : ["effort"];
    return (
      onlyKeys(value, [
        "stage",
        "agent_id",
        "workspace_id",
        "session_id",
        "runtime_kind_id",
        "provider_id",
        ...providerConversationKeys,
        "permission_mode",
        ...setupKeys,
        ...modelKeys,
        ...effortKeys,
      ]) &&
      TOKEN.test(value.agent_id) &&
      TOKEN.test(value.workspace_id) &&
      TOKEN.test(value.session_id) &&
      TOKEN.test(value.runtime_kind_id) &&
      TOKEN.test(value.provider_id) &&
      (value.provider_conversation_ref === undefined ||
        value.provider_conversation_ref === null ||
        (typeof value.provider_conversation_ref === "string" &&
          PROVIDER_CONVERSATION_REF.test(value.provider_conversation_ref))) &&
      PERMISSION_MODES.includes(value.permission_mode) &&
      validSetupCommand(value.setup_command) &&
      (value.model === undefined ||
        (typeof value.model === "string" && isProviderModelSelection(value.model))) &&
      (value.effort === undefined ||
        (typeof value.effort === "string" && isProviderEffortSelection(value.effort)))
    );
  }
  if (value.stage === "structured_launch") {
    const providerConversationKeys = value.provider_conversation_ref === undefined
      ? []
      : ["provider_conversation_ref"];
    return (
      onlyKeys(value, [
        "stage",
        "agent_id",
        "workspace_id",
        "provider_id",
        "execution_profile",
        ...providerConversationKeys,
      ]) &&
      TOKEN.test(value.agent_id) &&
      TOKEN.test(value.workspace_id) &&
      TOKEN.test(value.provider_id) &&
      (value.provider_conversation_ref === undefined ||
        value.provider_conversation_ref === null ||
        (typeof value.provider_conversation_ref === "string" &&
          PROVIDER_CONVERSATION_REF.test(value.provider_conversation_ref))) &&
      validExecutionProfile(value.execution_profile)
    );
  }
  if (value.stage === "structured_prompt_delivery") {
    return (
      onlyKeys(value, [
        "stage",
        "interaction_session_id",
        "runtime",
        "turn_id",
        "client_message_id",
        "prompt_digest",
      ]) &&
      TOKEN.test(value.interaction_session_id) &&
      validProviderRuntimeFence(value.runtime) &&
      TOKEN.test(value.turn_id) &&
      TOKEN.test(value.client_message_id) &&
      SHA256.test(value.prompt_digest)
    );
  }
  return (
    onlyKeys(value, ["stage", "session_id", "prompt_digest"]) &&
    TOKEN.test(value.session_id) &&
    SHA256.test(value.prompt_digest)
  );
}

function validStageEvidence(value) {
  if (!record(value) || !STAGES.includes(value.stage)) return false;
  if (value.stage === "worktree") {
    const hasLease = value.lease !== undefined;
    return (
      onlyKeys(value, [
        "stage",
        "workspace_id",
        "disposition",
        ...(hasLease ? ["lease"] : []),
      ]) &&
      TOKEN.test(value.workspace_id) &&
      ["created_dure_owned", "adopted_existing"].includes(value.disposition) &&
      (!hasLease || validWorkspaceLease(value.lease, value.workspace_id))
    );
  }
  if (value.stage === "runtime_launch") {
    const launchKey = value.launch_idempotency_key === undefined
      ? []
      : ["launch_idempotency_key"];
    const launchPromptKey = value.initial_prompt_accepted === undefined
      ? []
      : ["initial_prompt_accepted"];
    return (
      onlyKeys(value, [
        "stage",
        "session",
        ...launchKey,
        ...launchPromptKey,
      ]) &&
      validRuntimeSession(value.session) &&
      (value.launch_idempotency_key === undefined ||
        TOKEN.test(value.launch_idempotency_key)) &&
      (value.initial_prompt_accepted === undefined ||
        typeof value.initial_prompt_accepted === "boolean")
    );
  }
  if (value.stage === "structured_launch") {
    return (
      onlyKeys(value, ["stage", "binding"]) &&
      validInteractionBinding(value.binding)
    );
  }
  if (value.stage === "structured_prompt_delivery") {
    return (
      onlyKeys(value, [
        "stage",
        "interaction_session_id",
        "runtime",
        "turn_id",
        "client_message_id",
      ]) &&
      TOKEN.test(value.interaction_session_id) &&
      validProviderRuntimeFence(value.runtime) &&
      TOKEN.test(value.turn_id) &&
      TOKEN.test(value.client_message_id)
    );
  }
  return (
    onlyKeys(value, ["stage", "session_id", "delivery_id"]) &&
    TOKEN.test(value.session_id) &&
    TOKEN.test(value.delivery_id)
  );
}

function worktreeDirectoryName(branch) {
  const trimmed = branch.trim().replace(/\/+$/u, "");
  const last = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  const sanitize = (value) =>
    [...value]
      .map((character) =>
        /[\p{Alphabetic}\p{N}_-]/u.test(character) ? character : "-"
      )
      .join("");
  return sanitize(last) || sanitize(trimmed);
}

function validWorkspaceLease(value, workspaceId, branch) {
  return (
    onlyKeys(value, ["lease_id", "directory_name", "retirement_id"]) &&
    value.lease_id === `workspace-lease:${workspaceId}` &&
    value.retirement_id === `workspace-retire:${workspaceId}` &&
    typeof value.directory_name === "string" &&
    value.directory_name.length > 0 &&
    Buffer.byteLength(value.directory_name, "utf8") <= 256 &&
    value.directory_name !== "." &&
    value.directory_name !== ".." &&
    !/[\/\u0000-\u001f\u007f]/u.test(value.directory_name) &&
    (branch === undefined ||
      value.directory_name === worktreeDirectoryName(branch))
  );
}

function validRuntimeSession(value) {
  return (
    onlyKeys(value, [
      "sessionId",
      "workspaceId",
      "providerId",
      "runnerPrincipal",
      "runnerInstance",
      "channelEpoch",
      "hostInstanceId",
      "terminalEpoch",
    ]) &&
    TOKEN.test(value.sessionId) &&
    TOKEN.test(value.workspaceId) &&
    TOKEN.test(value.providerId) &&
    TOKEN.test(value.runnerPrincipal) &&
    TOKEN.test(value.runnerInstance) &&
    TOKEN.test(value.channelEpoch) &&
    TOKEN.test(value.hostInstanceId) &&
    TOKEN.test(value.terminalEpoch)
  );
}

function completedStructuredBinding(completed) {
  return completed.find((item) => item.evidence.stage === "structured_launch")
    ?.evidence.binding ?? null;
}

function completedRuntimeSession(completed) {
  return completed.find((item) => item.evidence.stage === "runtime_launch")
    ?.evidence.session ?? null;
}

function structuredPromptIdentity(operationId) {
  const token = createHash("sha256")
    .update(`dure.agent_spawn.structured-prompt/v1\0${operationId}`)
    .digest("hex")
    .slice(0, 24);
  return {
    turnId: `spawn-turn-${token}`,
    clientMessageId: `spawn-message-${token}`,
  };
}

function stageInputsMatchPlan(inputs, plan, completed) {
  const launch = normalizedLaunch(plan);
  if (inputs.stage === "worktree") {
    return (
      inputs.workspace_id === plan.workspaceId &&
      inputs.project_root_id === plan.authority.rootId &&
      inputs.repository_id === plan.authority.repositoryId &&
      JSON.stringify(canonicalJson(inputs.policy)) ===
        JSON.stringify(canonicalJson(plan.request.worktree))
    );
  }
  if (inputs.stage === "runtime_launch") {
    return (
      launch?.interactionProfile === "native_cli" &&
      inputs.agent_id === plan.agentId &&
      inputs.workspace_id === plan.workspaceId &&
      inputs.session_id === launch.sessionId &&
      inputs.runtime_kind_id === launch.runtime.runtimeKindId &&
      inputs.provider_id === plan.request.providerId &&
      (inputs.provider_conversation_ref ?? null) ===
        (plan.request.providerConversationRef ?? null) &&
      inputs.permission_mode === plan.request.permissionMode &&
      inputs.model === plan.request.model &&
      inputs.effort === plan.request.effort &&
      inputs.setup_command === plan.request.setupCommand
    );
  }
  if (inputs.stage === "structured_launch") {
    return (
      launch?.interactionProfile === "structured_protocol" &&
      inputs.agent_id === plan.agentId &&
      inputs.workspace_id === plan.workspaceId &&
      inputs.provider_id === plan.request.providerId &&
      (inputs.provider_conversation_ref ?? null) ===
        (plan.request.providerConversationRef ?? null) &&
      JSON.stringify(canonicalJson(inputs.execution_profile)) ===
        JSON.stringify(canonicalJson(normalizedExecutionProfile(
          plan.request.executionProfile,
        )))
    );
  }
  if (inputs.stage === "structured_prompt_delivery") {
    const binding = completedStructuredBinding(completed);
    const identity = structuredPromptIdentity(plan.operationId);
    return (
      launch?.interactionProfile === "structured_protocol" &&
      plan.request.promptDigest !== null &&
      binding !== null &&
      inputs.interaction_session_id === binding.interactionSessionId &&
      JSON.stringify(canonicalJson(inputs.runtime)) ===
        JSON.stringify(canonicalJson(binding.runtime)) &&
      inputs.turn_id === identity.turnId &&
      inputs.client_message_id === identity.clientMessageId &&
      inputs.prompt_digest === plan.request.promptDigest
    );
  }
  return (
    launch?.interactionProfile === "native_cli" &&
    plan.request.promptDigest !== null &&
    inputs.session_id === completedRuntimeSession(completed)?.sessionId &&
    inputs.prompt_digest === plan.request.promptDigest
  );
}

function stageEvidenceMatchesPlan(evidence, inputs, plan) {
  const launch = normalizedLaunch(plan);
  if (evidence.stage === "worktree") {
    return workspaceProjection(plan, evidence) !== null;
  }
  if (evidence.stage === "runtime_launch") {
    const preparedLaunchIdempotencyKey = `spawn-runtime:${plan.operationId}`;
    const effectiveLaunchIdempotencyKey = evidence.launch_idempotency_key ??
      (evidence.session.sessionId === launch?.sessionId
        ? preparedLaunchIdempotencyKey
        : null);
    return (
      launch?.interactionProfile === "native_cli" &&
      effectiveLaunchIdempotencyKey !== null &&
      (evidence.session.sessionId === launch.sessionId) ===
        (effectiveLaunchIdempotencyKey === preparedLaunchIdempotencyKey) &&
      evidence.session.workspaceId === plan.workspaceId &&
      evidence.session.providerId === plan.request.providerId &&
      (evidence.initial_prompt_accepted !== true ||
        plan.request.promptDigest !== null)
    );
  }
  if (evidence.stage === "structured_launch") {
    return (
      launch?.interactionProfile === "structured_protocol" &&
      evidence.binding.agentId === plan.agentId &&
      evidence.binding.providerId === plan.request.providerId &&
      JSON.stringify(canonicalJson(evidence.binding.executionProfile)) ===
        JSON.stringify(canonicalJson(normalizedExecutionProfile(
          plan.request.executionProfile,
        )))
    );
  }
  if (evidence.stage === "structured_prompt_delivery") {
    return (
      launch?.interactionProfile === "structured_protocol" &&
      plan.request.promptDigest !== null &&
      evidence.interaction_session_id === inputs.interaction_session_id &&
      JSON.stringify(canonicalJson(evidence.runtime)) ===
        JSON.stringify(canonicalJson(inputs.runtime)) &&
      evidence.turn_id === inputs.turn_id &&
      evidence.client_message_id === inputs.client_message_id
    );
  }
  return (
    launch?.interactionProfile === "native_cli" &&
    plan.request.promptDigest !== null &&
    evidence.session_id === inputs.session_id
  );
}

function workspaceProjection(plan, evidence) {
  if (evidence.workspace_id !== plan.workspaceId) return null;
  if (plan.request.worktree.kind === "existing_checkout") {
    return evidence.disposition === "adopted_existing" && evidence.lease === undefined
      ? { kind: "existing_checkout", branch: plan.request.worktree.branch,
          rootPath: plan.request.worktree.instance.canonicalPath }
      : null;
  }
  if (plan.request.worktree.kind === "project_root") {
    return evidence.disposition === "adopted_existing" &&
      evidence.lease === undefined
      ? { kind: "project_root" }
      : null;
  }
  const branch = plan.request.worktree.branch;
  return evidence.disposition === "created_dure_owned" &&
    validWorkspaceLease(evidence.lease, plan.workspaceId, branch)
    ? {
        kind: "dedicated",
        branch,
        directoryName: evidence.lease.directory_name,
      }
    : null;
}

export function agentSpawnWorkspaceProjection(plan, evidence) {
  return agentSpawnLaunchProjection(plan, evidence)?.workspace ?? null;
}

export function agentSpawnLaunchProjection(plan, evidence) {
  if (
    !validPlan(plan) ||
    !validStageEvidence(evidence) ||
    evidence.stage !== "worktree"
  ) {
    return null;
  }
  const workspace = workspaceProjection(plan, evidence);
  const launch = normalizedLaunch(plan);
  return workspace === null || launch === null ? null : { launch, workspace };
}

function validRecovery(value, plan, completed) {
  if (!record(value)) return false;
  const expectedStage = plannedStages(plan)[completed.length];
  if (value.kind === "continue") {
    return (
      onlyKeys(value, ["kind", "stage", "next_attempt"]) &&
      value.stage === expectedStage &&
      Number.isSafeInteger(value.next_attempt) &&
      value.next_attempt >= 1
    );
  }
  if (value.kind === "finish" || value.kind === "none") {
    return onlyKeys(value, ["kind"]);
  }
  if (value.kind === "inspect_before_retry") {
    return (
      onlyKeys(value, ["kind", "attempt", "inputs"]) &&
      Number.isSafeInteger(value.attempt) &&
      value.attempt >= 1 &&
      validStageInputs(value.inputs) &&
      value.inputs.stage === expectedStage &&
      stageInputsMatchPlan(value.inputs, plan, completed)
    );
  }
  if (value.kind === "retry_required") {
    return (
      onlyKeysWithOptional(
        value,
        ["kind", "stage", "failed_attempt", "error_code", "inputs"],
        ["error_detail"],
      ) &&
      value.stage === expectedStage &&
      Number.isSafeInteger(value.failed_attempt) &&
      value.failed_attempt >= 1 &&
      TOKEN.test(value.error_code) &&
      (value.error_detail === undefined || errorDetail(value.error_detail)) &&
      validStageInputs(value.inputs) &&
      value.inputs.stage === value.stage &&
      stageInputsMatchPlan(value.inputs, plan, completed)
    );
  }
  if (value.kind === "do_not_replay_prompt") {
    return (
      onlyKeysWithOptional(
        value,
        ["kind", "attempt", "inputs", "error_code"],
        ["error_detail"],
      ) &&
      Number.isSafeInteger(value.attempt) &&
      value.attempt >= 1 &&
      validStageInputs(value.inputs) &&
      value.inputs.stage === "prompt_delivery" &&
      value.inputs.stage === expectedStage &&
      stageInputsMatchPlan(value.inputs, plan, completed) &&
      (value.error_code === null || TOKEN.test(value.error_code)) &&
      (value.error_detail === undefined || errorDetail(value.error_detail))
    );
  }
  return false;
}

function validCompletedStage(item, index, completed, plan) {
  const stages = plannedStages(plan);
  return (
    onlyKeys(item, ["stage", "attempt", "inputs", "evidence"]) &&
    item.stage === stages[index] &&
    Number.isSafeInteger(item.attempt) &&
    item.attempt >= 1 &&
    validStageInputs(item.inputs) &&
    validStageEvidence(item.evidence) &&
    item.inputs.stage === item.stage &&
    item.evidence.stage === item.stage &&
    stageInputsMatchPlan(item.inputs, plan, completed.slice(0, index)) &&
    stageEvidenceMatchesPlan(item.evidence, item.inputs, plan) &&
    (index === 0 || completed[index - 1].stage !== item.stage)
  );
}

function validProgress(value) {
  const complete = value.completed.length === plannedStages(value.plan).length;
  const recovery = value.recovery.kind;
  if (value.state === "applying") return recovery === "continue" && !complete;
  if (value.state === "ready_to_succeed") return recovery === "finish" && complete;
  if (value.state === "inspect_before_retry") {
    return recovery === "inspect_before_retry" && !complete;
  }
  if (value.state === "retry_required") {
    return recovery === "retry_required" && !complete;
  }
  if (value.state === "prompt_delivery_uncertain") {
    return recovery === "do_not_replay_prompt" && !complete;
  }
  if (value.state === "succeeded") return recovery === "none" && complete;
  return recovery === "none" && !complete;
}

function validReceipt(value) {
  return (
    onlyKeysWithOptional(value, [
      "schemaVersion",
      "operationId",
      "plan",
      "state",
      "lastSequence",
      "completed",
      "recovery",
      "terminalCode",
      "createdAtMs",
      "updatedAtMs",
    ], ["checkoutRegistration"]) &&
    value.schemaVersion === AGENT_SPAWN_QUERY_SCHEMA_VERSION &&
    TOKEN.test(value.operationId) &&
    validPlan(value.plan) &&
    (value.plan.request.worktree.kind !== "existing_checkout" ||
      (value.completed?.length === 0 && value.checkoutRegistration === undefined) ||
      checkoutRegistrationMatches(value.plan.request.worktree, value.checkoutRegistration)) &&
    value.plan.operationId === value.operationId &&
    STATES.includes(value.state) &&
    Number.isSafeInteger(value.lastSequence) &&
    value.lastSequence >= 1 &&
    Array.isArray(value.completed) &&
    value.completed.length <= plannedStages(value.plan).length &&
    value.completed.every((item, index, completed) =>
      validCompletedStage(item, index, completed, value.plan)
    ) &&
    validRecovery(value.recovery, value.plan, value.completed) &&
    validProgress(value) &&
    (["failed", "manual_intervention_required"].includes(value.state)
      ? TOKEN.test(value.terminalCode)
      : value.terminalCode === null) &&
    safeInteger(value.createdAtMs) &&
    safeInteger(value.updatedAtMs) &&
    value.updatedAtMs >= value.createdAtMs
  );
}

function normalizedExpectedPreviewRequest(expectedRequest, projectId) {
  const normalized = { ...expectedRequest };
  delete normalized.includePresentationProject;
  if (normalized.projectPath !== undefined) {
    normalized.projectId = projectId;
    delete normalized.projectPath;
  }
  return normalized;
}

function previewRequestMatches(plan, expectedRequest) {
  const actual = plan.request;
  const resolution = plan.providerLaunchDefaults;
  if (!validProviderLaunchDefaultsResolution(resolution)) return false;
  const expectedOverride = expectedRequest.permissionOverride ?? null;
  if (resolution.permissionOverride !== expectedOverride) return false;
  const normalized = normalizedExpectedPreviewRequest(
    expectedRequest,
    actual.projectId,
  );
  const expected = {
    ...normalized,
    worktree: { ...normalized.worktree },
    executionProfile: { kind: "provider_default" },
    providerConversationRef: null,
    permissionMode:
      expectedOverride === "require_approvals"
        ? "default"
        : expectedOverride === "auto_edit"
          ? "auto_edit"
          : expectedOverride === "bypass_approvals"
            ? "skip_permissions"
            : actual.permissionMode,
  };
  delete expected.permissionOverride;
  if (expected.worktree?.kind === "existing_checkout" && actual.worktree?.kind === "existing_checkout") {
    if (JSON.stringify(canonicalJson(expected.worktree.reference)) !==
        JSON.stringify(canonicalJson(selectedCheckoutReference(actual.worktree)))) return false;
    expected.worktree = actual.worktree;
  }
  if (
    expected.worktree?.kind === "dedicated" &&
    expected.worktree.base_commit_sha === undefined &&
    actual.worktree?.kind === "dedicated"
  ) {
    expected.worktree = {
      ...expected.worktree,
      base_commit_sha: actual.worktree.base_commit_sha,
    };
  }
  return (
    JSON.stringify(canonicalJson({
      ...actual,
      executionProfile: normalizedExecutionProfile(actual.executionProfile),
    })) ===
    JSON.stringify(canonicalJson(expected))
  );
}

function parsedPresentationProject(value, plan) {
  if (
    !onlyKeys(value, ["projectId", "rootId", "repositoryId", "root"]) ||
    value.projectId !== plan.authority.projectId ||
    value.rootId !== plan.authority.rootId ||
    value.repositoryId !== plan.authority.repositoryId ||
    !validProjectPath(value.root)
  ) {
    return null;
  }
  return {
    projectId: value.projectId,
    rootId: value.rootId,
    repositoryId: value.repositoryId,
    root: value.root,
  };
}

function backendPayload(value, action, expectedRequest) {
  const expectsPresentationProject =
    action === "preview" && expectedRequest.includePresentationProject === true;
  if (
    !onlyKeys(value, [
      "schemaVersion",
      "receipt",
      ...(expectsPresentationProject ? ["presentationProject"] : []),
    ]) ||
    value.schemaVersion !== 1
  ) {
    return { error: "backend_agent_spawn_payload_invalid" };
  }
  if (action === "status" && value.receipt === null) return { receipt: null };
  if (!validReceipt(value.receipt)) {
    return { error: "backend_agent_spawn_payload_invalid" };
  }
  if (
    action === "preview" &&
    !previewRequestMatches(value.receipt.plan, expectedRequest)
  ) {
    return { error: "backend_agent_spawn_identity_mismatch" };
  }
  if (
    action === "apply" &&
    (value.receipt.operationId !== expectedRequest.operationId ||
      value.receipt.plan.planToken !== expectedRequest.planToken)
  ) {
    return { error: "backend_agent_spawn_identity_mismatch" };
  }
  if (action === "status" &&
      ((expectedRequest.operationId !== undefined && value.receipt.operationId !== expectedRequest.operationId) ||
       (expectedRequest.idempotencyKey !== undefined && value.receipt.plan.request.idempotencyKey !== expectedRequest.idempotencyKey))) {
    return { error: "backend_agent_spawn_identity_mismatch" };
  }
  const presentationProject = expectsPresentationProject
    ? parsedPresentationProject(value.presentationProject, value.receipt.plan)
    : null;
  if (expectsPresentationProject && presentationProject === null) {
    return { error: "backend_agent_spawn_payload_invalid" };
  }
  return {
    receipt: value.receipt,
    ...(presentationProject ? { presentationProject } : {}),
  };
}

function errorReport(action, code, observedAtMs, durationMs, details = {}) {
  const { deadlineMs = DEFAULT_AGENT_SPAWN_DEADLINE_MS, ...error } = details;
  return {
    schemaVersion: AGENT_SPAWN_QUERY_SCHEMA_VERSION,
    apiVersion: "dure.agent-spawn/v1",
    kind: "dure.agent_spawn.error",
    action,
    complete: false,
    observedAtMs,
    durationMs,
    source: { kind: "backend_profile", appDaemonRequired: false },
    limits: {
      deadlineMs,
      maxOutputBytes: MAX_AGENT_SPAWN_OUTPUT_BYTES,
    },
    error: { code, ...error },
  };
}

function backendErrorReport(action, error, profile, startedAt, deadlineMs) {
  const observedAtMs = Date.now();
  const { code, ...detail } = backendRequestFailure(error, profile);
  // Only typed executable-resolution evidence carries setup advice. Arbitrary
  // backend text stays private and an unknown lookup never implies absence.
  if (detail.remoteCode === "agent_spawn_provider_unavailable") {
    const guidance = {
      provider_executable_not_found: "Provider executable not found on the execution host. Install the selected provider there or fix PATH, then retry this request.",
      provider_executable_not_executable: "The provider executable cannot run. Check its path and execute permissions on the execution host, then retry this request.",
      provider_executable_lookup_failed: "Dure could not inspect the provider executable on the execution host. Check path and access permissions, then retry this request.",
      provider_executable_path_missing: "PATH is unavailable on the execution host. Restore PATH, then retry this request.",
    }[detail.reasonCode];
    if (typeof guidance === "string") detail.message = guidance;
  }
  return errorReport(
    action,
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

function promptDigest(prompt) {
  return typeof prompt === "string" && prompt.length > 0
    ? `sha256:${createHash("sha256").update(prompt).digest("hex")}`
    : null;
}

function validPromptHint(prompt) {
  return (
    prompt === undefined ||
    (typeof prompt === "string" &&
      prompt.length > 0 &&
      Buffer.byteLength(prompt, "utf8") <= 16 * 1024 &&
      ![...prompt].some((character) => {
        const codePoint = character.codePointAt(0);
        return (
          ((codePoint <= 0x1f && character !== "\n" && character !== "\t") ||
            (codePoint >= 0x7f && codePoint <= 0x9f))
        );
      }))
  );
}

function previewRequest(options) {
  return {
    schemaVersion: AGENT_SPAWN_QUERY_SCHEMA_VERSION,
    idempotencyKey: options.idempotencyKey,
    ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
    ...(options.projectPath === undefined
      ? {}
      : { projectPath: options.projectPath }),
    providerId: options.providerId,
    agentName: options.agentName,
    worktree: options.worktree,
    ...(options.permissionOverride === undefined
      ? {}
      : { permissionOverride: options.permissionOverride }),
    ...(options.includePresentationProject
      ? { includePresentationProject: true }
      : {}),
    promptDigest: promptDigest(options.prompt),
    ...(options.setupCommand === undefined
      ? {}
      : { setupCommand: options.setupCommand }),
  };
}

export async function collectAgentSpawnQuery({
  action,
  projectId,
  projectPath,
  providerId,
  agentName,
  worktree,
  permissionOverride,
  includePresentationProject,
  setupCommand,
  prompt,
  operationId,
  planToken,
  expectedLastSequence,
  idempotencyKey,
  backend,
  deadlineMs,
  requestBackend = performBackendProfileRequest,
} = {}) {
  const startedAt = Date.now();
  const presentationProjectSupported =
    includePresentationProject === true &&
    backend?.profile?.expected?.capabilities?.includes(
      AGENT_SPAWN_PRESENTATION_PROJECT_CAPABILITY,
    );
  const request =
    action === "preview"
      ? previewRequest({
          projectId,
          projectPath,
          providerId,
          agentName,
          worktree,
          permissionOverride,
          includePresentationProject: presentationProjectSupported,
          setupCommand,
          prompt,
          idempotencyKey,
        })
      : action === "apply"
        ? {
            schemaVersion: AGENT_SPAWN_QUERY_SCHEMA_VERSION,
            operationId,
            planToken,
            expectedLastSequence,
            prompt: prompt ?? null,
          }
        : { operationId, idempotencyKey };
  const effectiveDeadlineMs =
    deadlineMs ??
    (action === "apply"
      ? DEFAULT_AGENT_SPAWN_APPLY_DEADLINE_MS
      : DEFAULT_AGENT_SPAWN_DEADLINE_MS);
  const maxDeadlineMs =
    action === "apply"
      ? MAX_AGENT_SPAWN_APPLY_DEADLINE_MS
      : MAX_AGENT_SPAWN_DEADLINE_MS;
  const invalid =
    !["preview", "apply", "status"].includes(action) ||
    !Number.isSafeInteger(effectiveDeadlineMs) ||
    effectiveDeadlineMs < 1 ||
    effectiveDeadlineMs > maxDeadlineMs ||
    (action === "preview" &&
      (!validPreviewRequest(request) || !validPromptHint(prompt))) ||
    (action === "apply" &&
      (!TOKEN.test(operationId ?? "") ||
        !SHA256.test(planToken ?? "") ||
        !Number.isSafeInteger(expectedLastSequence) ||
        expectedLastSequence < 1 ||
        !validPromptHint(prompt))) ||
    (action === "status" && ((operationId !== undefined) === (idempotencyKey !== undefined))) ||
    (action === "status" && operationId !== undefined && !TOKEN.test(operationId)) ||
    (action === "status" && idempotencyKey !== undefined && !TOKEN.test(idempotencyKey));
  if (invalid) {
    return errorReport(action, "agent_spawn_request_invalid", Date.now(), 0, {
      deadlineMs: effectiveDeadlineMs,
    });
  }
  const profile = backend?.profile;
  if (backend?.error || !profile) {
    return backendErrorReport(
      action,
      backend?.error,
      profile,
      startedAt,
      effectiveDeadlineMs,
    );
  }
  let response;
  try {
    response = await requestBackend(
      profile,
      {
        operation: `agent_spawn.${action}`,
        requiredCapabilities: action === "preview"
          ? [
              "agent_spawn.preview.v2",
              ...(request.includePresentationProject
                ? [AGENT_SPAWN_PRESENTATION_PROJECT_CAPABILITY]
                : []),
            ]
          : [`agent_spawn.${action}`],
        body: action === "preview"
          ? request
          : action === "apply"
            ? request
            : {
                schemaVersion: AGENT_SPAWN_QUERY_SCHEMA_VERSION,
                ...(operationId !== undefined ? { operationId } : { idempotencyKey }),
              },
      },
      {
        ...backend.transportOptions,
        deadlineMs: effectiveDeadlineMs,
        maxResponseBytes: MAX_AGENT_SPAWN_OUTPUT_BYTES,
      },
    );
  } catch (error) {
    return backendErrorReport(
      action,
      error,
      profile,
      startedAt,
      effectiveDeadlineMs,
    );
  }
  const parsed = backendPayload(response.result, action, request);
  const observedAtMs = Date.now();
  const durationMs = Math.max(0, observedAtMs - startedAt);
  if (parsed.error) {
    return errorReport(action, parsed.error, observedAtMs, durationMs, {
      deadlineMs: effectiveDeadlineMs,
      profileId: profile.id,
    });
  }
  const report = {
    schemaVersion: AGENT_SPAWN_QUERY_SCHEMA_VERSION,
    apiVersion: "dure.agent-spawn/v1",
    kind: `dure.agent_spawn.${action}`,
    action,
    complete: true,
    found: parsed.receipt !== null,
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
      deadlineMs: effectiveDeadlineMs,
      maxOutputBytes: MAX_AGENT_SPAWN_OUTPUT_BYTES,
    },
    receipt: parsed.receipt,
    ...(parsed.presentationProject
      ? { presentationProject: parsed.presentationProject }
      : {}),
  };
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_AGENT_SPAWN_OUTPUT_BYTES) {
    return errorReport(action, "backend_agent_spawn_output_limit", observedAtMs, durationMs, {
      deadlineMs: effectiveDeadlineMs,
      profileId: profile.id,
    });
  }
  return report;
}

export function agentSpawnQueryExitCode(report) {
  if (report.kind === "dure.agent_spawn.error") return 2;
  if (report.action === "apply") {
    return report.receipt?.state === "succeeded" ? 0 : 1;
  }
  return report.found ? 0 : 1;
}

export function formatAgentSpawnQuery(report) {
  if (report.kind === "dure.agent_spawn.error") {
    return `Dure agent spawn unavailable: ${report.error.remoteCode ?? report.error.code}${report.error.message ? `\n${report.error.message}` : ""}`;
  }
  if (!report.found) return "Agent spawn receipt not found.";
  const receipt = report.receipt;
  const launch = normalizedLaunch(receipt.plan);
  const lines = [
    `operation\t${receipt.operationId}`,
    `plan\t${receipt.plan.planToken}`,
    `state\t${receipt.state}`,
    `agent\t${receipt.plan.request.agentName}`,
  ];
  lines.push(
    launch?.interactionProfile === "native_cli"
      ? `session\t${launch.sessionId}`
      : "interaction\tstructured_protocol",
  );
  return lines.join("\n");
}
