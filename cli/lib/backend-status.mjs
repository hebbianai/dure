import { spawnSync } from "node:child_process";
import { inspectSelectedControlPlane } from "./backend-status-control-plane.mjs";

export const BACKEND_STATUS_SCHEMA_VERSION = 1;
export const BACKEND_STATUS_CAPABILITY = "runtime_status_v1";
export const DEFAULT_BACKEND_DEADLINE_MS = 3_000;
export const MAX_BACKEND_DEADLINE_MS = 10_000;
export const MAX_BACKEND_OUTPUT_BYTES = 256 * 1024;

const VALID_HMUX_STATES = new Set(["ready", "degraded", "unreachable"]);
const VALID_SESSION_STATES = new Set([
  "ready",
  "degraded",
  "outdated",
  "stale",
  "unreachable",
]);
const VALID_SESSION_HEALTH = new Set([
  "healthy",
  "degraded",
  "outdated",
  "stale",
  "exited",
]);
const VALID_NEGOTIATION_STATES = new Set([
  "accepted",
  "capability_outdated",
  "incompatible",
  "unavailable",
  "generation_changed",
  "deadline_exhausted",
  "not_applicable",
]);
const VALID_PROBE_STATES = new Set(["fresh", "stale", "unknown", "stopped"]);
const VALID_RESOURCE_STATES = new Set(["available", "unavailable"]);
const VALID_RESOURCE_LEVELS = new Set([
  "normal",
  "elevated",
  "critical",
  "unknown",
]);
const REASON_CODE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

function elapsedMs(started) {
  return Math.round(Number(process.hrtime.bigint() - started) / 1_000_000);
}

function remainingMs(deadlineAt) {
  return Math.max(0, deadlineAt - Date.now());
}

function typedError(code, message, source = "hmux_cli") {
  return { code, message, source };
}

function runCaptured({ command, args, deadlineAt, execute }) {
  const timeout = remainingMs(deadlineAt);
  if (timeout === 0) {
    return {
      kind: "timeout",
      durationMs: 0,
      error: typedError(
        "hmux_runtime_timeout",
        "the Hmux runtime observation exceeded the backend deadline",
      ),
    };
  }
  const started = process.hrtime.bigint();
  const result = execute(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
    maxBuffer: MAX_BACKEND_OUTPUT_BYTES,
    killSignal: "SIGKILL",
    windowsHide: true,
  });
  const durationMs = elapsedMs(started);
  if (result.error?.code === "ETIMEDOUT") {
    return {
      kind: "timeout",
      durationMs,
      error: typedError(
        "hmux_runtime_timeout",
        "the Hmux runtime observation exceeded the backend deadline",
      ),
    };
  }
  if (result.error?.code === "ENOBUFS") {
    return {
      kind: "output_limit",
      durationMs,
      error: typedError(
        "hmux_runtime_output_limit_exceeded",
        "the Hmux runtime observation exceeded its output bound",
      ),
    };
  }
  if (result.error) {
    return {
      kind: "unavailable",
      durationMs,
      error: typedError(
        "hmux_cli_unavailable",
        "the Hmux CLI could not be executed",
      ),
    };
  }
  return {
    kind: result.status === 0 ? "success" : "nonzero",
    status: result.status,
    stdout: result.stdout || "",
    durationMs,
  };
}

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasOnlyReasonCodes(value) {
  return (
    Array.isArray(value) &&
    value.every((reason) => typeof reason === "string" && REASON_CODE.test(reason))
  );
}

function validCounts(value) {
  if (!value || typeof value !== "object") return false;
  return [
    "total",
    "active",
    "exited",
    "healthy",
    "degraded",
    "outdated",
    "stale",
  ].every((field) => isNonnegativeInteger(value[field]));
}

function validString(value) {
  return typeof value === "string" && value.length > 0;
}

function validOptionalString(value) {
  return value === null || validString(value);
}

function validStringArray(value) {
  return Array.isArray(value) && value.every(validString);
}

function projectStringArray(value) {
  return [...value];
}

function validCountMap(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.entries(value).every(
      ([key, count]) => validString(key) && isNonnegativeInteger(count),
    )
  );
}

function projectCountMap(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function validProtocolVersion(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    isNonnegativeInteger(value.major) &&
    isNonnegativeInteger(value.minor)
  );
}

function projectProtocolVersion(value) {
  return { major: value.major, minor: value.minor };
}

function validTypedError(value) {
  return (
    value === null ||
    (value !== null &&
      typeof value === "object" &&
      typeof value.code === "string" &&
      REASON_CODE.test(value.code) &&
      validString(value.message) &&
      validString(value.source))
  );
}

function projectTypedError(value) {
  return value === null
    ? null
    : { code: value.code, message: value.message, source: value.source };
}

function validNullableNumber(value) {
  return value === null || (Number.isFinite(value) && value >= 0);
}

function expectedProbeCoverageBasisPoints(value) {
  if (value.snapshotId === null) return 0;
  if (value.active === 0) return 10_000;
  return Math.floor((value.probed * 10_000) / value.active);
}

function validProducer(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    value.state === "ready" &&
    validString(value.packageVersion) &&
    validString(value.buildId) &&
    validProtocolVersion(value.protocol?.minimum) &&
    validProtocolVersion(value.protocol?.maximum) &&
    validStringArray(value.protocol?.capabilities) &&
    value.protocol.capabilities.includes(BACKEND_STATUS_CAPABILITY) &&
    validStringArray(value.protocol?.requiredHostCapabilities) &&
    validString(value.host?.id) &&
    validOptionalString(value.host?.name) &&
    validString(value.host?.os) &&
    validString(value.host?.architecture) &&
    isNonnegativeInteger(value.observedAtMs) &&
    isNonnegativeInteger(value.sourceAgeMs)
  );
}

function projectProducer(value) {
  return {
    state: value.state,
    packageVersion: value.packageVersion,
    buildId: value.buildId,
    protocol: {
      minimum: projectProtocolVersion(value.protocol.minimum),
      maximum: projectProtocolVersion(value.protocol.maximum),
      capabilities: projectStringArray(value.protocol.capabilities),
      requiredHostCapabilities: projectStringArray(
        value.protocol.requiredHostCapabilities,
      ),
    },
    host: {
      id: value.host.id,
      name: value.host.name,
      os: value.host.os,
      architecture: value.host.architecture,
    },
    observedAtMs: value.observedAtMs,
    sourceAgeMs: value.sourceAgeMs,
  };
}

function validProcessGeneration(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    isNonnegativeInteger(value.processId) &&
    validString(value.startMarker)
  );
}

function validSampleHost(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    validString(value.sessionId) &&
    validString(value.workspaceId) &&
    ["managed", "standalone"].includes(value.sessionClass) &&
    ["ready", "exited"].includes(value.lifecycle) &&
    VALID_SESSION_HEALTH.has(value.health) &&
    validString(value.providerId) &&
    validOptionalString(value.host?.runtimeHost) &&
    validString(value.host?.runnerPrincipal) &&
    validString(value.host?.runnerInstance) &&
    validString(value.host?.channelEpoch) &&
    validString(value.host?.hostInstanceId) &&
    validString(value.host?.terminalEpoch) &&
    validProcessGeneration(value.process?.host) &&
    validProcessGeneration(value.process?.provider) &&
    ["unix_socket", "windows_named_pipe"].includes(value.endpoint?.kind) &&
    validString(value.endpoint?.id) &&
    validProtocolVersion(value.protocol?.minimum) &&
    validProtocolVersion(value.protocol?.maximum) &&
    validStringArray(value.protocol?.capabilities) &&
    VALID_NEGOTIATION_STATES.has(value.protocol?.negotiation) &&
    validStringArray(value.protocol?.missingCapabilities) &&
    VALID_PROBE_STATES.has(value.probe?.state) &&
    (value.probe?.observedAtMs === null ||
      isNonnegativeInteger(value.probe?.observedAtMs)) &&
    (value.probe?.ageMs === null || isNonnegativeInteger(value.probe?.ageMs)) &&
    (value.manifestLifecycleAgeMs === null ||
      isNonnegativeInteger(value.manifestLifecycleAgeMs)) &&
    validTypedError(value.observationError)
  );
}

function projectSampleHost(value) {
  return {
    sessionId: value.sessionId,
    workspaceId: value.workspaceId,
    sessionClass: value.sessionClass,
    lifecycle: value.lifecycle,
    health: value.health,
    providerId: value.providerId,
    host: {
      runtimeHost: value.host.runtimeHost,
      runnerPrincipal: value.host.runnerPrincipal,
      runnerInstance: value.host.runnerInstance,
      channelEpoch: value.host.channelEpoch,
      hostInstanceId: value.host.hostInstanceId,
      terminalEpoch: value.host.terminalEpoch,
    },
    process: {
      host: {
        processId: value.process.host.processId,
        startMarker: value.process.host.startMarker,
      },
      provider: {
        processId: value.process.provider.processId,
        startMarker: value.process.provider.startMarker,
      },
    },
    endpoint: { kind: value.endpoint.kind, id: value.endpoint.id },
    protocol: {
      minimum: projectProtocolVersion(value.protocol.minimum),
      maximum: projectProtocolVersion(value.protocol.maximum),
      capabilities: projectStringArray(value.protocol.capabilities),
      negotiation: value.protocol.negotiation,
      missingCapabilities: projectStringArray(value.protocol.missingCapabilities),
    },
    probe: {
      state: value.probe.state,
      observedAtMs: value.probe.observedAtMs,
      ageMs: value.probe.ageMs,
    },
    manifestLifecycleAgeMs: value.manifestLifecycleAgeMs,
    observationError: projectTypedError(value.observationError),
  };
}

function validSessionHosts(value) {
  if (!value || typeof value !== "object") return false;
  const completenessFields = [
    "complete",
    "snapshotId",
    "probeBudgetMs",
    "probed",
    "unprobed",
  ];
  const hasCompleteness = completenessFields.some((field) =>
    Object.hasOwn(value, field),
  );
  const validCompleteness =
    !hasCompleteness ||
    (completenessFields.every((field) => Object.hasOwn(value, field)) &&
      typeof value.complete === "boolean" &&
      (value.snapshotId === null ||
        (typeof value.snapshotId === "string" && value.snapshotId.length > 0)) &&
      isNonnegativeInteger(value.probeBudgetMs) &&
      isNonnegativeInteger(value.probed) &&
      isNonnegativeInteger(value.unprobed) &&
      (!Object.hasOwn(value, "probeCoverageBasisPoints") ||
        (isNonnegativeInteger(value.probeCoverageBasisPoints) &&
          value.probeCoverageBasisPoints <= 10_000 &&
          value.probeCoverageBasisPoints ===
            expectedProbeCoverageBasisPoints(value))) &&
      value.probed + value.unprobed === value.active &&
      (value.complete
        ? value.unprobed === 0 && value.snapshotId !== null
        : value.unprobed > 0 || value.snapshotId === null));
  return (
    validCounts(value) &&
    validCompleteness &&
    VALID_SESSION_STATES.has(value.state) &&
    value.total === value.active + value.exited &&
    value.active ===
      value.healthy + value.degraded + value.outdated + value.stale &&
    validCountMap(value.providerCounts) &&
    validCountMap(value.buildCounts) &&
    value.buildCountBasis === "active_ready" &&
    validCountMap(value.reasonCounts) &&
    typeof value.buildSkew === "boolean" &&
    isNonnegativeInteger(value.observedAtMs) &&
    isNonnegativeInteger(value.manifestMaxLifecycleAgeMs)
  );
}

function projectSessionHosts(value) {
  return {
    state: value.state,
    complete: value.complete === true,
    snapshotId:
      typeof value.snapshotId === "string" && value.snapshotId.length > 0
        ? value.snapshotId
        : null,
    probeBudgetMs: isNonnegativeInteger(value.probeBudgetMs)
      ? value.probeBudgetMs
      : null,
    total: value.total,
    active: value.active,
    exited: value.exited,
    probed: isNonnegativeInteger(value.probed) ? value.probed : null,
    unprobed: isNonnegativeInteger(value.unprobed) ? value.unprobed : null,
    probeCoverageBasisPoints: isNonnegativeInteger(
      value.probeCoverageBasisPoints,
    )
      ? value.probeCoverageBasisPoints
      : null,
    healthy: value.healthy,
    degraded: value.degraded,
    outdated: value.outdated,
    stale: value.stale,
    providerCounts: projectCountMap(value.providerCounts),
    buildCounts: projectCountMap(value.buildCounts),
    buildCountBasis: value.buildCountBasis,
    reasonCounts: projectCountMap(value.reasonCounts),
    buildSkew: value.buildSkew,
    observedAtMs: value.observedAtMs,
    manifestMaxLifecycleAgeMs: value.manifestMaxLifecycleAgeMs,
  };
}

function validResourcePressure(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    VALID_RESOURCE_STATES.has(value.state) &&
    VALID_RESOURCE_LEVELS.has(value.level) &&
    value.basis === "load_average_per_logical_core" &&
    validNullableNumber(value.oneMinuteLoad) &&
    validNullableNumber(value.loadPerLogicalCore) &&
    (value.logicalCores === null || isNonnegativeInteger(value.logicalCores)) &&
    (value.physicalMemoryBytes === null ||
      isNonnegativeInteger(value.physicalMemoryBytes)) &&
    (value.producerPeakResidentBytes === null ||
      isNonnegativeInteger(value.producerPeakResidentBytes)) &&
    isNonnegativeInteger(value.observedAtMs) &&
    isNonnegativeInteger(value.sourceAgeMs)
  );
}

function projectResourcePressure(value) {
  return {
    state: value.state,
    level: value.level,
    basis: value.basis,
    oneMinuteLoad: value.oneMinuteLoad,
    loadPerLogicalCore: value.loadPerLogicalCore,
    logicalCores: value.logicalCores,
    physicalMemoryBytes: value.physicalMemoryBytes,
    producerPeakResidentBytes: value.producerPeakResidentBytes,
    observedAtMs: value.observedAtMs,
    sourceAgeMs: value.sourceAgeMs,
  };
}

function parseRuntimeStatus(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  const sample = value?.sessionHostSample;
  const sampleLimit = value?.sessionHostSampleLimit;
  if (
    value?.schemaVersion !== 1 ||
    value?.kind !== "hmux.runtime_status" ||
    !VALID_HMUX_STATES.has(value?.status) ||
    !hasOnlyReasonCodes(value?.reasonCodes) ||
    !isNonnegativeInteger(value?.observedAtMs) ||
    !validProducer(value?.hmuxCli) ||
    !validSessionHosts(value?.sessionHosts) ||
    !Array.isArray(sample) ||
    !isNonnegativeInteger(sampleLimit) ||
    sampleLimit > 16 ||
    sample.length > sampleLimit ||
    typeof value?.sessionHostSampleHasMore !== "boolean" ||
    !isNonnegativeInteger(value?.sessionHostSampleOmittedCount) ||
    value.sessionHostSampleHasMore !==
      (value.sessionHostSampleOmittedCount > 0) ||
    sample.length + value.sessionHostSampleOmittedCount !==
      value.sessionHosts.total ||
    !sample.every(validSampleHost) ||
    !validTypedError(value.representativeError) ||
    !validResourcePressure(value.resourcePressure)
  ) {
    return null;
  }
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    status: value.status,
    reasonCodes: projectStringArray(value.reasonCodes),
    observedAtMs: value.observedAtMs,
    hmuxCli: projectProducer(value.hmuxCli),
    sessionHosts: projectSessionHosts(value.sessionHosts),
    sessionHostSample: sample.map(projectSampleHost),
    sessionHostSampleLimit: value.sessionHostSampleLimit,
    sessionHostSampleHasMore: value.sessionHostSampleHasMore,
    sessionHostSampleOmittedCount: value.sessionHostSampleOmittedCount,
    representativeError: projectTypedError(value.representativeError),
    resourcePressure: projectResourcePressure(value.resourcePressure),
  };
}

function parseCapabilities(stdout) {
  try {
    const value = JSON.parse(stdout);
    if (
      !isNonnegativeInteger(value?.schemaVersion) ||
      !Array.isArray(value?.capabilities) ||
      !value.capabilities.every((item) => typeof item === "string")
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function failedOutcome(kind, error, durationMs) {
  return {
    state: kind === "outdated" ? "outdated" : "unreachable",
    reasonCodes: [error.code],
    payload: null,
    error,
    durationMs,
  };
}

function inspectHmux({ command, probeBudgetMs, deadlineAt, execute }) {
  const args = ["--json", "runtime", "status"];
  if (probeBudgetMs !== undefined) {
    args.push("--probe-budget-ms", String(probeBudgetMs));
  }
  const statusResult = runCaptured({
    command,
    args,
    deadlineAt,
    execute,
  });
  if (statusResult.kind === "success") {
    const payload = parseRuntimeStatus(statusResult.stdout);
    if (!payload) {
      return failedOutcome(
        "unreachable",
        typedError(
          "hmux_runtime_contract_invalid",
          "the Hmux runtime returned an invalid bounded status contract",
        ),
        statusResult.durationMs,
      );
    }
    return {
      state: payload.status,
      reasonCodes: payload.reasonCodes,
      payload,
      error: payload.representativeError ?? null,
      durationMs: statusResult.durationMs,
    };
  }
  if (statusResult.kind !== "nonzero") {
    return failedOutcome(
      "unreachable",
      statusResult.error,
      statusResult.durationMs,
    );
  }

  const capabilityResult = runCaptured({
    command,
    args: ["capabilities", "--json"],
    deadlineAt,
    execute,
  });
  const totalDurationMs = statusResult.durationMs + capabilityResult.durationMs;
  if (capabilityResult.kind === "success") {
    const capabilities = parseCapabilities(capabilityResult.stdout);
    if (capabilities && !capabilities.capabilities.includes(BACKEND_STATUS_CAPABILITY)) {
      return failedOutcome(
        "outdated",
        typedError(
          "hmux_runtime_status_capability_outdated",
          "the Hmux CLI does not provide the runtime status capability",
        ),
        totalDurationMs,
      );
    }
  }
  if (capabilityResult.kind === "timeout") {
    return failedOutcome(
      "unreachable",
      capabilityResult.error,
      totalDurationMs,
    );
  }
  return failedOutcome(
    "unreachable",
    typedError(
      "hmux_runtime_command_failed",
      "the Hmux runtime status command failed",
    ),
    totalDurationMs,
  );
}

function unavailableCensus(state, observedAtMs) {
  return {
    state,
    complete: false,
    snapshotId: null,
    probeBudgetMs: null,
    total: null,
    active: null,
    exited: null,
    probed: null,
    unprobed: null,
    probeCoverageBasisPoints: null,
    healthy: null,
    degraded: null,
    outdated: null,
    stale: null,
    providerCounts: {},
    buildCounts: {},
    buildCountBasis: "active_ready",
    reasonCounts: {},
    buildSkew: null,
    observedAtMs: null,
    sourceAgeMs: null,
    aggregateObservedAtMs: observedAtMs,
  };
}

function sourceAge(observedAtMs, nowMs) {
  return isNonnegativeInteger(observedAtMs)
    ? Math.max(0, nowMs - observedAtMs)
    : null;
}

export async function collectBackendStatus({
  environment = process.env,
  hmuxCommand = "hmux",
  deadlineMs = DEFAULT_BACKEND_DEADLINE_MS,
  probeBudgetMs,
  execute = spawnSync,
  inspectControlPlane = inspectSelectedControlPlane,
  view = "status",
} = {}) {
  const boundedDeadlineMs = Math.min(
    MAX_BACKEND_DEADLINE_MS,
    Math.max(1, deadlineMs),
  );
  const boundedProbeBudgetMs =
    probeBudgetMs === undefined
      ? undefined
      : Math.min(
          MAX_BACKEND_DEADLINE_MS,
          Math.max(0, probeBudgetMs),
          boundedDeadlineMs,
        );
  const started = process.hrtime.bigint();
  const deadlineAt = Date.now() + boundedDeadlineMs;
  const hmux = inspectHmux({
    command: hmuxCommand,
    probeBudgetMs: boundedProbeBudgetMs,
    deadlineAt,
    execute,
  });
  const controlPlane = await inspectControlPlane({
    deadlineMs: remainingMs(deadlineAt),
    environment,
  });
  const observedAtMs = Date.now();
  const reasonCodes = [
    ...new Set([
      ...hmux.reasonCodes,
      ...(controlPlane.reasonCode ? [controlPlane.reasonCode] : []),
    ]),
  ].sort();
  const payload = hmux.payload;
  const terminalObservedAtMs = payload?.observedAtMs ?? observedAtMs;
  const terminalSourceAgeMs = sourceAge(terminalObservedAtMs, observedAtMs);
  const sessionHosts = payload
    ? {
        ...payload.sessionHosts,
        sourceAgeMs: sourceAge(payload.sessionHosts.observedAtMs, observedAtMs),
      }
    : unavailableCensus(hmux.state, observedAtMs);
  const resourcePressure = payload
    ? {
        ...payload.resourcePressure,
        sourceAgeMs: sourceAge(
          payload.resourcePressure.observedAtMs,
          observedAtMs,
        ),
      }
    : {
        state: "unavailable",
        level: "unknown",
        basis: "load_average_per_logical_core",
        oneMinuteLoad: null,
        loadPerLogicalCore: null,
        logicalCores: null,
        physicalMemoryBytes: null,
        producerPeakResidentBytes: null,
        observedAtMs: null,
        sourceAgeMs: null,
      };
  const sessionReasonCode = payload
    ? payload.representativeError?.code ??
      Object.keys(sessionHosts.reasonCounts).sort()[0] ??
      null
    : hmux.reasonCodes[0];
  const resourceSource = payload
    ? resourcePressure.state !== "available"
      ? {
          state: "unavailable",
          reasonCode: "hmux_resource_pressure_unavailable",
        }
      : resourcePressure.level === "critical"
        ? {
            state: "degraded",
            reasonCode: "hmux_resource_pressure_critical",
          }
        : { state: "ready", reasonCode: null }
    : { state: "unavailable", reasonCode: hmux.reasonCodes[0] };
  const status =
    hmux.state === "unreachable" || controlPlane.state === "unreachable"
      ? "unreachable"
      : hmux.state === "outdated" || controlPlane.state === "outdated"
        ? "outdated"
        : hmux.state === "ready" && controlPlane.state === "ready"
          ? "ready"
          : "degraded";
  const representativeError =
    (hmux.state === status ? hmux.error : null) ??
    (controlPlane.state === status ? controlPlane.lastTypedError : null) ??
    hmux.error ??
    controlPlane.lastTypedError;
  const report = {
    schemaVersion: BACKEND_STATUS_SCHEMA_VERSION,
    apiVersion: "dure.backend/v1",
    kind: "dure.backend.status",
    view,
    status,
    reasonCodes,
    partial: status !== "ready" || !sessionHosts.complete,
    observedAtMs,
    sourceAgeMs: 0,
    durationMs: 0,
    deadlineMs: boundedDeadlineMs,
    target: controlPlane.target,
    terminalRuntime: {
      state: hmux.state,
      source: "hmux_cli",
      producer: payload?.hmuxCli ?? null,
      reasonCodes: hmux.reasonCodes,
      observedAtMs: terminalObservedAtMs,
      sourceAgeMs: terminalSourceAgeMs,
      durationMs: hmux.durationMs,
    },
    sessionHosts,
    sessionHostSample: payload?.sessionHostSample ?? [],
    sessionHostSampleLimit: payload?.sessionHostSampleLimit ?? 16,
    sessionHostSampleHasMore: payload?.sessionHostSampleHasMore ?? false,
    sessionHostSampleOmittedCount:
      payload?.sessionHostSampleOmittedCount ?? 0,
    controlPlane,
    resourcePressure,
    representativeError,
    sources: [
      {
        name: "hmux_cli",
        state: payload?.hmuxCli.state ?? hmux.state,
        observedAtMs: terminalObservedAtMs,
        sourceAgeMs: terminalSourceAgeMs,
        durationMs: hmux.durationMs,
        reasonCode: hmux.payload ? null : hmux.reasonCodes[0],
      },
      {
        name: "session_hosts",
        state: sessionHosts.state,
        observedAtMs: sessionHosts.observedAtMs,
        sourceAgeMs: sessionHosts.sourceAgeMs,
        durationMs: null,
        reasonCode: sessionHosts.state === "ready" ? null : sessionReasonCode,
      },
      {
        name: "resource_pressure",
        state: resourceSource.state,
        observedAtMs: resourcePressure.observedAtMs,
        sourceAgeMs: resourcePressure.sourceAgeMs,
        durationMs: null,
        reasonCode: resourceSource.reasonCode,
      },
      {
        name: "control_plane",
        state: controlPlane.state,
        observedAtMs: controlPlane.observedAtMs,
        sourceAgeMs: controlPlane.sourceAgeMs,
        durationMs: controlPlane.durationMs,
        reasonCode: controlPlane.reasonCode,
      },
    ],
  };
  report.durationMs = elapsedMs(started);
  return report;
}

export function backendHealthExitCode(report) {
  if (report.status === "ready") return 0;
  if (report.status === "unreachable") return 2;
  return 1;
}

export function formatBackendStatus(report) {
  const sessions = report.sessionHosts.complete
    ? `${report.sessionHosts.active}/${report.sessionHosts.total} active`
    : isNonnegativeInteger(report.sessionHosts.probed) &&
        isNonnegativeInteger(report.sessionHosts.unprobed)
      ? `${report.sessionHosts.probed}/${report.sessionHosts.active} probed (${report.sessionHosts.unprobed} unprobed)`
      : "unavailable";
  return [
    `Dure backend: ${report.status}`,
    `  terminal runtime: ${report.terminalRuntime.state}`,
    `  control plane: ${report.controlPlane.state}`,
    `  sessions: ${sessions}`,
    `  duration: ${report.durationMs}ms`,
    `  reasons: ${report.reasonCodes.join(",") || "none"}`,
  ].join("\n");
}
