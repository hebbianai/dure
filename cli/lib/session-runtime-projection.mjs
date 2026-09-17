export const SESSION_QUERY_SCHEMA_VERSION = 1;
export const MAX_ID_BYTES = 512;
const MAX_PATH_BYTES = 4_096;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

export function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function boundedString(value, maximum = MAX_ID_BYTES) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function decimal(value) {
  return boundedString(value, 32) && DECIMAL.test(value);
}

export function decimalAtMost(value, maximum) {
  return decimal(value) && decimal(maximum) && BigInt(value) <= BigInt(maximum);
}

export function workingDirectory(value, generation, outputSequence) {
  if (
    !record(value) ||
    value.terminal_epoch !== generation.terminalEpoch ||
    !decimalAtMost(value.observed_through_output_seq, outputSequence) ||
    !boundedString(value.path, MAX_PATH_BYTES) ||
    !["launch_fallback", "osc7", "process_inspection"].includes(value.source)
  ) {
    return null;
  }
  return {
    path: value.path,
    terminalEpoch: value.terminal_epoch,
    observedThroughOutputSeq: value.observed_through_output_seq,
    source: value.source,
  };
}

// Project the Host's observation; terminal output and client state never infer it.
export function agentRuntimeState(value, generation, outputSequence) {
  if (
    !record(value) ||
    value.terminal_epoch !== generation.terminalEpoch ||
    !decimalAtMost(value.observed_through_output_seq, outputSequence) ||
    !decimal(value.revision) ||
    !decimal(value.turn_completed_count) ||
    !["starting", "running", "exited"].includes(value.lifecycle) ||
    !["working", "waiting"].includes(value.activity) ||
    !["none", "input_required", "approval_required", "error"].includes(value.attention) ||
    !(value.attention_id === null || boundedString(value.attention_id)) ||
    !["provider_event", "orchestration_event", "controller_input", "process_lifecycle"].includes(value.source)
  ) {
    return null;
  }
  return {
    terminalEpoch: value.terminal_epoch,
    revision: value.revision,
    observedThroughOutputSeq: value.observed_through_output_seq,
    lifecycle: value.lifecycle,
    activity: value.activity,
    attention: value.attention,
    attentionId: value.attention_id,
    source: value.source,
    turnCompletedCount: value.turn_completed_count,
  };
}

const SESSION_HEALTH = new Set([
  "healthy",
  "stale_transport",
  "incompatible_protocol",
  "exited",
  "generation_changed",
  "unprobed",
]);
const SESSION_CLASS = new Set(["managed", "standalone"]);
const SESSION_LIFECYCLE = new Set(["ready", "exited"]);
const EFFECTIVE_LIFECYCLE = new Set([
  "ready",
  "stale",
  "incompatible",
  "exited",
  "unprobed",
]);
const SESSION_FAILURE_PHASE = new Set([
  "conversation_identity",
  "provider_runtime",
]);
const SESSION_FAILURE_EXIT_KIND = new Set([
  "normal",
  "usage_limit",
  "authentication_failed",
  "provider_error",
  "signaled",
]);
const SESSION_FAILURE_CODE = /^[a-z][a-z0-9_]{2,127}$/;
export const GENERATION_FIELDS = Object.freeze([
  ["runnerPrincipal", "runner_principal"],
  ["runnerInstance", "runner_instance"],
  ["channelEpoch", "channel_epoch"],
  ["hostInstanceId", "host_instance_id"],
  ["terminalEpoch", "terminal_epoch"],
]);

function processDescriptor(value) {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.process_id) ||
    value.process_id < 1 ||
    !boundedString(value.start_marker, 256)
  ) {
    return null;
  }
  return { pid: value.process_id, startMarker: value.start_marker };
}

function runtimeGeneration(value) {
  const generation = {};
  for (const [projected, source] of GENERATION_FIELDS) {
    if (!boundedString(value[source], 256)) return null;
    generation[projected] = value[source];
  }
  return generation;
}

export function sameGeneration(left, right) {
  return GENERATION_FIELDS.every(
    ([projected]) => left[projected] === right[projected],
  );
}

export function projectedGeneration(value) {
  if (!record(value)) return null;
  const generation = {};
  for (const [field] of GENERATION_FIELDS) {
    if (!boundedString(value[field], 256)) return null;
    generation[field] = value[field];
  }
  return generation;
}

function conversationIdentity(value, session, generation, outputSequence) {
  if (!record(value)) return null;
  const projected = {
    sessionId: value.session_id,
    workspaceId: value.workspace_id,
    runnerPrincipal: value.runner_principal,
    runnerInstance: value.runner_instance,
    channelEpoch: value.channel_epoch,
    hostInstanceId: value.host_instance_id,
    terminalEpoch: value.terminal_epoch,
  };
  if (
    projected.sessionId !== session.session_id ||
    projected.workspaceId !== session.workspace_id ||
    !sameGeneration(generation, projected) ||
    value.provider_id !== session.provider_id ||
    !boundedString(value.conversation_id, MAX_ID_BYTES) ||
    !decimal(value.revision) ||
    !decimalAtMost(value.observed_through_output_seq, outputSequence) ||
    !["launch_request", "provider_event"].includes(value.source)
  ) {
    return null;
  }
  return {
    ...projected,
    revision: value.revision,
    observedThroughOutputSeq: value.observed_through_output_seq,
    providerId: value.provider_id,
    conversationId: value.conversation_id,
    source: value.source,
  };
}

function recoveredPresentation(value) {
  if (value === null || value === undefined) return null;
  if (
    !record(value) ||
    !boundedString(value.source_session_id) ||
    !boundedString(value.source_host_instance_id, 256) ||
    !boundedString(value.source_terminal_epoch, 256) ||
    !decimal(value.source_sequence_through) ||
    !decimal(value.captured_unix_ms) ||
    typeof value.truncated !== "boolean"
  ) {
    return null;
  }
  return {
    sourceSessionId: value.source_session_id,
    sourceHostInstanceId: value.source_host_instance_id,
    sourceTerminalEpoch: value.source_terminal_epoch,
    sourceSequenceThrough: value.source_sequence_through,
    capturedUnixMs: value.captured_unix_ms,
    truncated: value.truncated,
  };
}

function normalizedSessionExitKind(value) {
  if (value === "usagelimit") return "usage_limit";
  if (value === "authenticationfailed") return "authentication_failed";
  if (value === "providererror") return "provider_error";
  return value;
}

function sessionFailure(value, session, generation) {
  if (value === null || value === undefined) return undefined;
  if (
    !record(value) ||
    value.session_id !== session.session_id ||
    value.workspace_id !== session.workspace_id ||
    value.terminal_epoch !== generation.terminalEpoch ||
    !boundedString(value.correlation_id, 256) ||
    !boundedString(value.code, 128) ||
    !SESSION_FAILURE_CODE.test(value.code) ||
    !SESSION_FAILURE_PHASE.has(value.phase) ||
    !boundedString(value.summary, 512) ||
    !SESSION_FAILURE_EXIT_KIND.has(value.exit_kind) ||
    (value.exit_code !== null && !Number.isSafeInteger(value.exit_code)) ||
    !decimal(value.occurred_unix_ms) ||
    value.retry_posture !== "never" ||
    !record(session.exit) ||
    normalizedSessionExitKind(session.exit.kind) !== value.exit_kind ||
    session.exit.exit_code !== value.exit_code
  ) {
    return null;
  }
  return {
    correlationId: value.correlation_id,
    sessionId: value.session_id,
    workspaceId: value.workspace_id,
    terminalEpoch: value.terminal_epoch,
    code: value.code,
    phase: value.phase,
    summary: value.summary,
    exitKind: value.exit_kind,
    exitCode: value.exit_code,
    occurredUnixMs: value.occurred_unix_ms,
    retryPosture: value.retry_posture,
  };
}

// These fields describe the foreground process observed by the Host, not the
// transport used by this client to reach that Host.
function processObservation(value, generation, outputSequence) {
  if (
    !record(value) ||
    value.terminal_epoch !== generation.terminalEpoch ||
    !decimalAtMost(value.observed_through_output_seq, outputSequence) ||
    value.source !== "process_inspection"
  ) {
    return null;
  }
  return {
    terminalEpoch: value.terminal_epoch,
    observedThroughOutputSeq: value.observed_through_output_seq,
    source: value.source,
  };
}

function executionLocation(value, generation, outputSequence) {
  const observation = processObservation(value, generation, outputSequence);
  if (!observation || !record(value.location)) return null;
  if (value.location.kind === "local") {
    return { ...observation, location: { kind: "local" } };
  }
  if (value.location.kind === "ssh" && boundedString(value.location.target)) {
    return { ...observation, location: { kind: "ssh", target: value.location.target } };
  }
  return null;
}

function agentIdentity(value, generation, outputSequence) {
  const observation = processObservation(value, generation, outputSequence);
  // An observed ordinary shell has agent: null; a missing observation is unknown.
  if (!observation || !(value.agent === null || boundedString(value.agent, 128))) {
    return null;
  }
  return { ...observation, agent: value.agent };
}

function livenessState(health) {
  if (health === "healthy") return "alive";
  if (health === "exited") return "exited";
  return "unknown";
}

export function projectSession(value, observedAtMs) {
  if (
    !record(value) ||
    value.schema_version !== 1 ||
    !boundedString(value.session_id) ||
    !boundedString(value.workspace_id) ||
    !SESSION_CLASS.has(value.session_class) ||
    !SESSION_LIFECYCLE.has(value.lifecycle) ||
    !boundedString(value.provider_id, 128) ||
    !decimal(value.output_seq) ||
    !SESSION_HEALTH.has(value.health) ||
    !SESSION_LIFECYCLE.has(value.manifestLifecycle) ||
    !EFFECTIVE_LIFECYCLE.has(value.effectiveLifecycle)
  ) {
    return null;
  }
  const generation = runtimeGeneration(value);
  const hostProcess = processDescriptor(value.host_process);
  const providerProcess = processDescriptor(value.provider_process);
  if (!generation || !hostProcess || !providerProcess) return null;
  const exactGeneration = value.health === "healthy" || value.health === "exited";
  const directory = exactGeneration
    ? workingDirectory(value.workingDirectory, generation, value.output_seq)
    : null;
  const conversation = exactGeneration
    ? conversationIdentity(
        value.providerConversationIdentity,
        value,
        generation,
        value.output_seq,
      )
    : null;
  const recovered = exactGeneration
    ? recoveredPresentation(value.recoveredPresentation)
    : null;
  const failure = exactGeneration
    ? sessionFailure(value.failure, value, generation)
    : undefined;
  if (failure === null) return null;
  return {
    schemaVersion: SESSION_QUERY_SCHEMA_VERSION,
    sessionId: value.session_id,
    workspaceId: value.workspace_id,
    conversationId: conversation?.conversationId ?? null,
    forkedFrom: null,
    cwd: directory?.path ?? null,
    fieldSources: {
      conversationId: conversation ? "hmux_host" : "unavailable",
      forkedFrom: "unavailable",
      cwd: directory ? "hmux_host" : "unavailable",
    },
    provider: {
      id: value.provider_id,
      pid: providerProcess.pid,
      process: providerProcess,
    },
    failure: failure ?? null,
    liveness: {
      state: livenessState(value.health),
      health: value.health,
      exactGeneration,
      manifestLifecycle: value.manifestLifecycle,
      effectiveLifecycle: value.effectiveLifecycle,
      observedAtMs,
    },
    runtime: {
      source: "hmux_host",
      sessionClass: value.session_class,
      generation,
      hostProcess,
      providerProcess,
      outputSequence: value.output_seq,
      workingDirectory: directory,
      agentRuntimeState: exactGeneration
        ? agentRuntimeState(value.agentRuntimeState, generation, value.output_seq)
        : null,
      executionLocation: exactGeneration
        ? executionLocation(value.executionLocation, generation, value.output_seq)
        : null,
      agentIdentity: exactGeneration
        ? agentIdentity(value.agentIdentity, generation, value.output_seq)
        : null,
      conversationIdentity: conversation,
      recoveredPresentation: recovered,
    },
  };
}
