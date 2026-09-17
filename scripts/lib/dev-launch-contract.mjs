import { createHash, randomBytes } from "node:crypto";
import {
  PROCESS_GROUP_WITNESS_CONTROL_TIMEOUT_MS,
  parseProcessGroupAuthority,
  sameProcessGroupAuthority,
} from "./process-group-authority.mjs";

export const DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION = 1;
export const DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION = 2;
export const DEV_LAUNCH_PARENT_HANDOFF_PROTOCOL_VERSION = 3;
const LEGACY_DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION = 1;
export const DEV_LAUNCH_SUPERVISOR_DESCRIPTOR_FILE =
  "dev-launch-supervisor-v1.json";
export const DEV_LAUNCH_PARENT_HANDOFF_ENV =
  "DURE_DEV_LAUNCH_PARENT_HANDOFF";
export const DEV_LAUNCH_COLD_BOOTSTRAP_REQUIRED =
  "DEV_LAUNCH_COLD_BOOTSTRAP_REQUIRED";
export const DEV_LAUNCH_FRONTEND_PROTOCOL_VERSION = 1;
export const DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY =
  "frontend_authority_v1";
export const DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY =
  "process_group_authority_v1";
export const DEV_LAUNCH_FRONTEND_GENERATION_ENV =
  "DURE_DEV_FRONTEND_GENERATION";
export const DEV_LAUNCH_CHILD_GENERATION_ENV = "DURE_DEV_LAUNCH_GENERATION";
export const DEV_LAUNCH_FRONTEND_READY_PATH =
  "/__dure_dev_frontend_authority";

const MAX_FRAME_BYTES = 64 * 1024;
const DEFAULT_CONNECTION_TIMEOUT_MS = 20_000;
const RESTART_STATUS_POLL_MS = 100;
const RESTART_STATUS_REQUEST_TIMEOUT_MS = 5_000;
const MAX_STATUS_CONNECTION_FAILURES = 3;
const MAX_RESTART_TRANSACTIONS = 16;
const TERMINAL_ACK_CONNECTION_TIMEOUT_MS = 250;
const TERMINAL_RETENTION_GRACE_MS =
  RESTART_STATUS_REQUEST_TIMEOUT_MS * MAX_STATUS_CONNECTION_FAILURES +
  RESTART_STATUS_POLL_MS * MAX_STATUS_CONNECTION_FAILURES;
const CHILD_IDENTITY_TIMEOUT_MS = 1_000;
// Frontend activation acknowledges only after the nested witness is retained.
const FRONTEND_ACTIVATION_TIMEOUT_MS =
  PROCESS_GROUP_WITNESS_CONTROL_TIMEOUT_MS + CHILD_IDENTITY_TIMEOUT_MS;
const CHILD_STOP_TIMEOUT_MS = 12_000;
const CHILD_KILL_TIMEOUT_MS = 5_000;
const DEFAULT_PARENT_RELOAD_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_RESTART_SETTLEMENT_TIMEOUT_MS =
  DEFAULT_PARENT_RELOAD_TIMEOUT_MS;
const RESTART_SETTLEMENT_RECOVERY_MS =
  CHILD_STOP_TIMEOUT_MS +
  CHILD_KILL_TIMEOUT_MS +
  TERMINAL_RETENTION_GRACE_MS;
export const DEV_LAUNCH_SUPERVISOR_AUTHORITY_UNAVAILABLE =
  "DEV_LAUNCH_SUPERVISOR_AUTHORITY_UNAVAILABLE";
const PARENT_RELOAD_CAPABILITY = "parent_reload";

function randomIdentity() {
  return randomBytes(32).toString("hex");
}

function parseDevLaunchIdentity(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid dev launch supervisor ${label}`);
  }
  if (
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.processIdentity !== "string" ||
    value.processIdentity.length === 0 ||
    !/^[a-f0-9]{64}$/.test(value.generation)
  ) {
    throw new Error(`invalid dev launch supervisor ${label}`);
  }
  const processGroup = value.processGroup === undefined
    ? undefined
    : parseProcessGroupAuthority(value.processGroup, { leaderPid: value.pid });
  return {
    pid: value.pid,
    processIdentity: value.processIdentity,
    generation: value.generation,
    ...(processGroup ? { processGroup } : {}),
  };
}

function parseDevLaunchGeneration(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`invalid dev launch supervisor ${label}`);
  }
  return value;
}

export function parseDevLaunchHmuxProviderIdentity(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid dev launch Hmux provider identity");
  }
  if (value.sessionId === undefined && value.workspaceId === undefined) {
    return undefined;
  }
  if (
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    value.sessionId.length > 256 ||
    /[\0\r\n]/.test(value.sessionId) ||
    typeof value.workspaceId !== "string" ||
    value.workspaceId.length === 0 ||
    value.workspaceId.length > 256 ||
    /[\0\r\n]/.test(value.workspaceId)
  ) {
    throw new Error("invalid dev launch Hmux provider identity");
  }
  return {
    sessionId: value.sessionId,
    workspaceId: value.workspaceId,
  };
}

function parseDevLaunchStartupFailure(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.type !== "startup_failure" ||
    typeof value.reason !== "string" ||
    value.reason.length === 0 ||
    value.reason.length > 4_096 ||
    value.reason.includes("\0") ||
    !Number.isSafeInteger(value.failedAtMs) ||
    value.failedAtMs <= 0
  ) {
    throw new Error("invalid dev launch startup failure");
  }
  const hmux = parseDevLaunchHmuxProviderIdentity(value.hmux);
  if (!hmux) throw new Error("dev launch startup failure has no Hmux identity");
  return {
    type: "startup_failure",
    hmux,
    reason: value.reason,
    failedAtMs: value.failedAtMs,
  };
}

export function parseDevLaunchFrontendReady(
  value,
  { generation, channel } = {},
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION ||
    value.protocolVersion !== DEV_LAUNCH_FRONTEND_PROTOCOL_VERSION ||
    value.type !== "frontend_ready" ||
    (channel !== undefined && value.channel !== channel)
  ) {
    throw new Error("invalid dev launch frontend readiness");
  }
  const parsedGeneration = parseDevLaunchGeneration(
    value.generation,
    "frontend readiness generation",
  );
  if (generation !== undefined && parsedGeneration !== generation) {
    throw new Error("dev launch frontend readiness generation does not match");
  }
  return {
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    protocolVersion: DEV_LAUNCH_FRONTEND_PROTOCOL_VERSION,
    type: "frontend_ready",
    generation: parsedGeneration,
    ...(channel === undefined ? {} : { channel }),
  };
}

export function parseDevLaunchFrontendUnavailable(
  value,
  { generation, channel },
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION ||
    value.protocolVersion !== DEV_LAUNCH_FRONTEND_PROTOCOL_VERSION ||
    value.type !== "frontend_unavailable" ||
    value.reason !== "port_conflict" ||
    value.channel !== channel
  ) {
    throw new Error("invalid dev launch frontend unavailability");
  }
  const parsedGeneration = parseDevLaunchGeneration(
    value.generation,
    "frontend unavailability generation",
  );
  if (parsedGeneration !== generation) {
    throw new Error("dev launch frontend unavailability generation does not match");
  }
  return {
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    protocolVersion: DEV_LAUNCH_FRONTEND_PROTOCOL_VERSION,
    type: "frontend_unavailable",
    reason: "port_conflict",
    channel,
    generation: parsedGeneration,
  };
}

export function parseDevLaunchFrontendActivation(
  value,
  { type, generation, channel },
) {
  if (
    (type !== "frontend_activate" && type !== "frontend_activated") ||
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION ||
    value.type !== type ||
    value.channel !== channel
  ) {
    throw new Error("invalid dev launch frontend activation");
  }
  const parsedGeneration = parseDevLaunchGeneration(
    value.generation,
    "frontend activation generation",
  );
  if (parsedGeneration !== generation) {
    throw new Error("dev launch frontend activation generation does not match");
  }
  return {
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    type,
    channel,
    generation: parsedGeneration,
  };
}

export function parseDevLaunchChildActivation(
  value,
  { generation, channel },
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION ||
    value.type !== "launch_activate" ||
    value.channel !== channel
  ) {
    throw new Error("invalid dev launch child activation");
  }
  const parsedGeneration = parseDevLaunchGeneration(
    value.generation,
    "child activation generation",
  );
  if (parsedGeneration !== generation) {
    throw new Error("dev launch child activation generation does not match");
  }
  return {
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    type: "launch_activate",
    channel,
    generation: parsedGeneration,
  };
}

export function parseDevLaunchChildReady(
  value,
  { generation, channel },
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION ||
    value.type !== "launch_candidate_ready" ||
    value.channel !== channel
  ) {
    throw new Error("invalid dev launch child readiness");
  }
  const parsedGeneration = parseDevLaunchGeneration(
    value.generation,
    "child readiness generation",
  );
  if (parsedGeneration !== generation) {
    throw new Error("dev launch child readiness generation does not match");
  }
  return {
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    type: "launch_candidate_ready",
    channel,
    generation: parsedGeneration,
  };
}

export function parseDevLaunchChildActivationFailure(
  value,
  { generation, channel },
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION ||
    value.type !== "launch_activation_failed" ||
    value.channel !== channel
  ) {
    throw new Error("invalid dev launch child activation failure");
  }
  const parsedGeneration = parseDevLaunchGeneration(
    value.generation,
    "child activation failure generation",
  );
  if (parsedGeneration !== generation) {
    throw new Error(
      "dev launch child activation failure generation does not match",
    );
  }
  return {
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    type: "launch_activation_failed",
    channel,
    generation: parsedGeneration,
  };
}

export function parseDevLaunchV2Envelope(
  value,
  { type, worktreeRoot, channel },
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION ||
    value.protocolVersion !== DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION ||
    value.type !== type ||
    value.worktreeRoot !== worktreeRoot ||
    value.channel !== channel
  ) {
    throw new Error(`invalid dev launch ${type} envelope`);
  }
  return value;
}

export function parseDevLaunchRestartReceipt(
  value,
  { worktreeRoot, channel, protocolVersion: expectedProtocolVersion },
) {
  const protocolVersion =
    value?.protocolVersion ?? LEGACY_DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION ||
    (protocolVersion !== LEGACY_DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION &&
      protocolVersion !== DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION) ||
    (expectedProtocolVersion !== undefined &&
      protocolVersion !== expectedProtocolVersion) ||
    value.type !== "restart_receipt" ||
    value.worktreeRoot !== worktreeRoot ||
    value.channel !== channel ||
    !Number.isSafeInteger(value.restartedAtMs) ||
    value.restartedAtMs <= 0
  ) {
    throw new Error("invalid dev launch restart_receipt envelope");
  }
  return {
    ...value,
    protocolVersion,
    requestId: parseDevLaunchGeneration(value.requestId, "restart request id"),
    supervisor: parseDevLaunchIdentity(
      value.supervisor,
      "restart supervisor",
    ),
    previousLaunch: parseDevLaunchIdentity(
      value.previousLaunch,
      "restart previous launch",
    ),
    launch: parseDevLaunchIdentity(value.launch, "restart launch"),
    ...(value.previousFrontend === undefined
      ? {}
      : {
          previousFrontend: parseDevLaunchIdentity(
            value.previousFrontend,
            "restart previous frontend",
          ),
        }),
    ...(value.frontend === undefined
      ? {}
      : {
          frontend: parseDevLaunchIdentity(
            value.frontend,
            "restart frontend",
          ),
        }),
  };
}

function exactParentHandoff(value, { channel, worktreeRoot }) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION ||
    value.protocolVersion !== DEV_LAUNCH_PARENT_HANDOFF_PROTOCOL_VERSION ||
    value.type !== "parent_handoff" ||
    value.worktreeRoot !== worktreeRoot ||
    value.channel !== channel ||
    !/^[a-f0-9]{64}$/.test(value.requestId) ||
    !/^[a-f0-9]{64}$/.test(value.capability) ||
    (value.phase !== "retiring" && value.phase !== "exec_pending") ||
    !Number.isSafeInteger(value.committedAtMs) ||
    value.committedAtMs <= 0
  ) {
    throw new Error("invalid dev launch parent handoff");
  }
  const previousFrontend = value.previousFrontend === undefined
    ? undefined
    : parseDevLaunchIdentity(
        value.previousFrontend,
        "handoff previous frontend identity",
      );
  return {
    ...value,
    previousSupervisor: parseDevLaunchIdentity(
      value.previousSupervisor,
      "handoff predecessor identity",
    ),
    previousLaunch: parseDevLaunchIdentity(
      value.previousLaunch,
      "handoff previous launch identity",
    ),
    ...(previousFrontend ? { previousFrontend } : {}),
    targetSupervisorGeneration: parseDevLaunchGeneration(
      value.targetSupervisorGeneration,
      "handoff target generation",
    ),
    targetSourceGeneration: parseDevLaunchGeneration(
      value.targetSourceGeneration,
      "handoff target source generation",
    ),
  };
}

export function parseDevLaunchParentHandoff(
  serialized,
  { channel, worktreeRoot },
) {
  if (serialized === undefined) return undefined;
  if (typeof serialized !== "string" || serialized.length > MAX_FRAME_BYTES) {
    throw new Error("invalid dev launch parent handoff environment");
  }
  let value;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`invalid dev launch parent handoff JSON: ${error.message}`);
  }
  return exactParentHandoff(value, { channel, worktreeRoot });
}

function exactDescriptor(value, { channel, worktreeRoot }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid dev launch supervisor descriptor");
  }
  if (value.schemaVersion !== DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION) {
    throw new Error("unsupported dev launch supervisor schemaVersion");
  }
  // Both versions share one descriptor path so rollout cannot create a second
  // supervisor. A legacy owner remains the one-shot authority until restart.
  const protocolVersion =
    value.protocolVersion ?? LEGACY_DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION;
  if (
    protocolVersion !== LEGACY_DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION &&
    protocolVersion !== DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION
  ) {
    throw new Error("unsupported dev launch supervisor protocolVersion");
  }
  if (value.channel !== channel || value.worktreeRoot !== worktreeRoot) {
    throw new Error(
      "dev launch supervisor descriptor does not match worktree and channel",
    );
  }
  if (
    typeof value.socketPath !== "string" ||
    value.socketPath.length === 0 ||
    !/^[a-f0-9]{64}$/.test(value.capability)
  ) {
    throw new Error("invalid dev launch supervisor endpoint authority");
  }
  const supervisor = parseDevLaunchIdentity(
    value.supervisor,
    "process identity",
  );
  const state = value.state ?? "ready";
  if (state !== "preparing" && state !== "ready" && state !== "handoff") {
    throw new Error("invalid dev launch supervisor state");
  }
  let launch = null;
  if (state === "handoff") {
    if (value.launch !== null) {
      throw new Error("handoff dev launch supervisor has a launch identity");
    }
  } else if (value.launch !== null) {
    launch = parseDevLaunchIdentity(value.launch, "launch identity");
  } else if (state === "ready") {
    throw new Error("ready dev launch supervisor has no launch identity");
  }
  const capabilities = value.capabilities ?? [];
  if (
    !Array.isArray(capabilities) ||
    capabilities.some((capability) => typeof capability !== "string")
  ) {
    throw new Error("invalid dev launch supervisor capabilities");
  }
  const sourceGeneration = value.sourceGeneration === undefined
    ? undefined
    : parseDevLaunchGeneration(value.sourceGeneration, "source generation");
  const startupFailure = value.startupFailure === undefined
    ? undefined
    : parseDevLaunchStartupFailure(value.startupFailure);
  if (
    startupFailure &&
    (state !== "preparing" || sourceGeneration === undefined)
  ) {
    throw new Error(
      "dev launch startup failure requires a preparing source generation",
    );
  }
  const frontend = value.frontend === undefined
    ? undefined
    : value.frontend === null
      ? null
      : parseDevLaunchIdentity(value.frontend, "frontend identity");
  const candidateLaunch = value.candidateLaunch === undefined
    ? undefined
    : parseDevLaunchIdentity(value.candidateLaunch, "candidate launch identity");
  if (
    candidateLaunch &&
    state !== "preparing" &&
    state !== "handoff"
  ) {
    throw new Error(
      "only a preparing or handoff dev launch supervisor has a candidate launch",
    );
  }
  const candidateFrontend = value.candidateFrontend === undefined
    ? undefined
    : parseDevLaunchIdentity(
        value.candidateFrontend,
        "candidate frontend identity",
      );
  if (candidateFrontend && state !== "preparing") {
    throw new Error("only a preparing dev launch supervisor has a candidate frontend");
  }
  if (
    capabilities.includes(DEV_LAUNCH_FRONTEND_AUTHORITY_CAPABILITY) &&
    (state === "ready" || state === "handoff") &&
    !frontend
  ) {
    throw new Error(`${state} dev launch supervisor has no frontend identity`);
  }
  const handoff =
    state === "handoff"
      ? exactParentHandoff(value.handoff, { channel, worktreeRoot })
      : undefined;
  const processGroupIdentities = descriptorOwnedLaunchIdentities({
    state,
    launch,
    frontend,
    candidateLaunch,
    candidateFrontend,
    handoff,
  });
  const hasProcessGroupCapability = capabilities.includes(
    DEV_LAUNCH_PROCESS_GROUP_AUTHORITY_CAPABILITY,
  );
  const allIdentitiesHaveProcessGroup = processGroupIdentities.every(
    (identity) => identity.processGroup,
  );
  if (
    hasProcessGroupCapability &&
    !(processGroupIdentities.length > 0 && allIdentitiesHaveProcessGroup)
  ) {
    throw new Error("dev launch process group authority is missing");
  }
  if (
    processGroupIdentities.length > 0 &&
    allIdentitiesHaveProcessGroup &&
    !hasProcessGroupCapability
  ) {
    throw new Error("dev launch process group capability is missing");
  }
  if (
    handoff &&
    (!sameDevLaunchIdentity(handoff.previousSupervisor, value.supervisor) ||
      handoff.capability !== redactDevLaunchCapability(value.capability))
  ) {
    throw new Error("dev launch parent handoff does not match its descriptor");
  }
  if (
    handoff &&
    (frontend
      ? !sameDevLaunchIdentity(handoff.previousFrontend, frontend)
      : handoff.previousFrontend !== undefined)
  ) {
    throw new Error("dev launch parent handoff frontend does not match its descriptor");
  }
  const processRoles = [
    supervisor,
    ...processGroupIdentities,
  ];
  const physicalProcesses = processRoles.flatMap((identity) => [
    identity,
    ...(identity.processGroup ? [identity.processGroup.witness] : []),
  ]);
  for (
    let leftIndex = 0;
    leftIndex < physicalProcesses.length;
    leftIndex += 1
  ) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < physicalProcesses.length;
      rightIndex += 1
    ) {
      if (
        sameDevLaunchProcess(
          physicalProcesses[leftIndex],
          physicalProcesses[rightIndex],
        )
      ) {
        throw new Error("dev launch process identity occupies multiple roles");
      }
    }
  }
  for (let leftIndex = 0; leftIndex < processRoles.length; leftIndex += 1) {
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < processRoles.length;
      rightIndex += 1
    ) {
      if (
        processRoles[leftIndex].processGroup &&
        processRoles[rightIndex].processGroup &&
        processRoles[leftIndex].processGroup.id ===
          processRoles[rightIndex].processGroup.id
      ) {
        throw new Error("dev launch process group occupies multiple roles");
      }
    }
  }
  return {
    ...value,
    protocolVersion,
    state,
    capabilities,
    supervisor,
    launch,
    ...(frontend !== undefined ? { frontend } : {}),
    ...(candidateLaunch ? { candidateLaunch } : {}),
    ...(candidateFrontend ? { candidateFrontend } : {}),
    ...(sourceGeneration ? { sourceGeneration } : {}),
    ...(startupFailure ? { startupFailure } : {}),
    ...(handoff ? { handoff } : {}),
  };
}

function descriptorOwnedLaunchIdentities(descriptor) {
  return [
    descriptor.state === "handoff"
      ? descriptor.handoff?.previousLaunch
      : descriptor.launch,
    descriptor.frontend,
    descriptor.candidateLaunch,
    descriptor.candidateFrontend,
  ].filter(Boolean);
}

function sameDevLaunchGeneration(left, right) {
  return (
    Boolean(left) &&
    Boolean(right) &&
    left?.pid === right?.pid &&
    left?.processIdentity === right?.processIdentity &&
    left?.generation === right?.generation
  );
}

function sameDevLaunchIdentity(left, right) {
  return (
    sameDevLaunchGeneration(left, right) &&
    (left.processGroup === undefined && right.processGroup === undefined
      ? true
      : sameProcessGroupAuthority(left.processGroup, right.processGroup))
  );
}

function sameDevLaunchProcess(left, right) {
  return (
    Boolean(left) &&
    Boolean(right) &&
    left.pid === right.pid &&
    left.processIdentity === right.processIdentity
  );
}

function sameOptionalDevLaunchIdentity(left, right) {
  return left === undefined && right === undefined
    ? true
    : left === null && right === null
      ? true
      : sameDevLaunchIdentity(left, right);
}

function sameOptionalDevLaunchGeneration(left, right) {
  return left === undefined && right === undefined
    ? true
    : left === null && right === null
      ? true
      : sameDevLaunchGeneration(left, right);
}

function parentReloadReceiptFromDescriptor(descriptor, request, predecessor) {
  const activation = descriptor.activation;
  if (
    descriptor.state !== "ready" ||
    descriptor.sourceGeneration !== request.targetSourceGeneration ||
    descriptor.supervisor.generation !== request.targetSupervisorGeneration ||
    descriptor.supervisor.pid !== predecessor.supervisor.pid ||
    descriptor.supervisor.processIdentity !==
      predecessor.supervisor.processIdentity ||
    descriptor.supervisor.generation === predecessor.supervisor.generation ||
    !activation ||
    activation.type !== "parent_reload" ||
    activation.requestId !== request.requestId ||
    activation.sourceGeneration !== request.targetSourceGeneration ||
    !sameDevLaunchIdentity(
      activation.previousSupervisor,
      predecessor.supervisor,
    ) ||
    !sameDevLaunchIdentity(activation.previousLaunch, predecessor.launch) ||
    !sameDevLaunchIdentity(activation.launch, descriptor.launch) ||
    !sameOptionalDevLaunchIdentity(
      activation.previousFrontend,
      predecessor.frontend,
    ) ||
    !sameOptionalDevLaunchIdentity(activation.frontend, descriptor.frontend) ||
    !Number.isSafeInteger(activation.activatedAtMs) ||
    activation.activatedAtMs <= 0
  ) {
    return null;
  }
  return {
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
    type: "parent_reload_receipt",
    requestId: request.requestId,
    worktreeRoot: descriptor.worktreeRoot,
    channel: descriptor.channel,
    previousSupervisor: activation.previousSupervisor,
    previousLaunch: activation.previousLaunch,
    ...(activation.previousFrontend
      ? { previousFrontend: activation.previousFrontend }
      : {}),
    supervisor: descriptor.supervisor,
    launch: activation.launch,
    ...(activation.frontend ? { frontend: activation.frontend } : {}),
    sourceGeneration: activation.sourceGeneration,
    activatedAtMs: activation.activatedAtMs,
  };
}

function isPreparingParentReloadSuccessor(descriptor, request, predecessor) {
  const activation = descriptor.activation;
  return (
    descriptor.state === "preparing" &&
    descriptor.sourceGeneration === request.targetSourceGeneration &&
    descriptor.supervisor.pid === predecessor.supervisor.pid &&
    descriptor.supervisor.processIdentity ===
      predecessor.supervisor.processIdentity &&
    descriptor.supervisor.generation === request.targetSupervisorGeneration &&
    activation?.type === "parent_reload" &&
    activation.requestId === request.requestId &&
    activation.sourceGeneration === request.targetSourceGeneration &&
    sameDevLaunchIdentity(
      activation.previousSupervisor,
      predecessor.supervisor,
    ) &&
    sameDevLaunchIdentity(activation.previousLaunch, predecessor.launch) &&
    sameOptionalDevLaunchIdentity(
      activation.previousFrontend,
      predecessor.frontend,
    ) &&
    activation.launch === undefined &&
    activation.activatedAtMs === undefined
  );
}

function responseProtocolMatches(
  response,
  protocolVersion = DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
) {
  return (
    response?.schemaVersion === DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION &&
    (response.protocolVersion ?? LEGACY_DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION) ===
      protocolVersion
  );
}

function parentGenerationProbeRequest(descriptor) {
  return {
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
    type: "parent_generation_probe",
    worktreeRoot: descriptor.worktreeRoot,
    channel: descriptor.channel,
    capability: descriptor.capability,
    expectedSupervisor: descriptor.supervisor,
    expectedLaunch: descriptor.launch,
    ...(descriptor.frontend !== undefined
      ? { expectedFrontend: descriptor.frontend }
      : {}),
    expectedSourceGeneration: descriptor.sourceGeneration,
  };
}

function validateParentGenerationProbeRequest(request, descriptor) {
  if (
    !request ||
    request.schemaVersion !== DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION ||
    request.protocolVersion !== DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION ||
    request.type !== "parent_generation_probe" ||
    request.capability !== descriptor.capability ||
    request.worktreeRoot !== descriptor.worktreeRoot ||
    request.channel !== descriptor.channel ||
    descriptor.state !== "ready" ||
    !sameDevLaunchGeneration(
      request.expectedSupervisor,
      descriptor.supervisor,
    ) ||
    !sameDevLaunchGeneration(request.expectedLaunch, descriptor.launch) ||
    !sameOptionalDevLaunchGeneration(
      request.expectedFrontend,
      descriptor.frontend,
    ) ||
    request.expectedSourceGeneration !== descriptor.sourceGeneration
  ) {
    throw new Error(
      "dev launch parent generation probe does not match current authority",
    );
  }
}

function parentGenerationFrame(descriptor) {
  return {
    schemaVersion: DEV_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    protocolVersion: DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
    type: "parent_generation",
    worktreeRoot: descriptor.worktreeRoot,
    channel: descriptor.channel,
    supervisor: descriptor.supervisor,
    launch: descriptor.launch,
    ...(descriptor.frontend !== undefined
      ? { frontend: descriptor.frontend }
      : {}),
    sourceGeneration: descriptor.sourceGeneration,
  };
}

function validateParentGenerationFrame(response, descriptor) {
  if (
    !responseProtocolMatches(response) ||
    response.type !== "parent_generation" ||
    response.worktreeRoot !== descriptor.worktreeRoot ||
    response.channel !== descriptor.channel ||
    !sameDevLaunchIdentity(response.supervisor, descriptor.supervisor) ||
    !sameDevLaunchIdentity(response.launch, descriptor.launch) ||
    !sameOptionalDevLaunchIdentity(response.frontend, descriptor.frontend) ||
    response.sourceGeneration !== descriptor.sourceGeneration
  ) {
    throw new Error(
      "activated parent endpoint does not serve the target generation",
    );
  }
}

export function redactDevLaunchCapability(capability) {
  parseDevLaunchGeneration(capability, "capability");
  return createHash("sha256").update(capability).digest("hex");
}


export {
  CHILD_IDENTITY_TIMEOUT_MS,
  CHILD_KILL_TIMEOUT_MS,
  CHILD_STOP_TIMEOUT_MS,
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_PARENT_RELOAD_TIMEOUT_MS,
  DEFAULT_RESTART_SETTLEMENT_TIMEOUT_MS,
  FRONTEND_ACTIVATION_TIMEOUT_MS,
  LEGACY_DEV_LAUNCH_SUPERVISOR_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  MAX_STATUS_CONNECTION_FAILURES,
  MAX_RESTART_TRANSACTIONS,
  PARENT_RELOAD_CAPABILITY,
  RESTART_STATUS_POLL_MS,
  RESTART_STATUS_REQUEST_TIMEOUT_MS,
  RESTART_SETTLEMENT_RECOVERY_MS,
  TERMINAL_ACK_CONNECTION_TIMEOUT_MS,
  TERMINAL_RETENTION_GRACE_MS,
  exactDescriptor,
  descriptorOwnedLaunchIdentities,
  isPreparingParentReloadSuccessor,
  parentReloadReceiptFromDescriptor,
  parseDevLaunchGeneration,
  parseDevLaunchIdentity,
  exactParentHandoff,
  parentGenerationFrame,
  parentGenerationProbeRequest,
  randomIdentity,
  responseProtocolMatches,
  sameDevLaunchIdentity,
  sameDevLaunchGeneration,
  sameOptionalDevLaunchIdentity,
  sameOptionalDevLaunchGeneration,
  validateParentGenerationFrame,
  validateParentGenerationProbeRequest,
};
