export { loadSessionClientProjection } from "./client-registry.mjs";
import { backendRequestFailure } from "./backend-request-failure.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { runBoundedCommand } from "./bounded-command.mjs";
import {
  findAgentPane,
  parseClientPresentation,
} from "./client-presentation-state.mjs";
import { supportsHmuxCapability } from "./runtime-diagnostics.mjs";
import {
  GENERATION_FIELDS,
  MAX_ID_BYTES,
  SESSION_QUERY_SCHEMA_VERSION,
  boundedString,
  decimal,
  projectSession,
  projectedGeneration,
  record,
  sameGeneration,
} from "./session-runtime-projection.mjs";

export { SESSION_QUERY_SCHEMA_VERSION } from "./session-runtime-projection.mjs";
export const DEFAULT_SESSION_QUERY_DEADLINE_MS = 2_500;
export const MAX_SESSION_QUERY_DEADLINE_MS = 10_000;
export const DEFAULT_SESSION_PROBE_BUDGET_MS = 1_000;
export const MAX_SESSION_QUERY_ITEMS = 128;
export const MAX_SESSION_QUERY_OUTPUT_BYTES = 1024 * 1024;
const MAX_HMUX_SESSION_CATALOG_BYTES = 960 * 1024;
const BOUNDED_BACKEND_SESSION_CATALOG_CAPABILITY =
  "sessions.list.bounded_catalog_v1";
const BOUNDED_HMUX_SESSION_CATALOG_CAPABILITY =
  "bounded_session_catalog_query_v1";
const HMUX_CAPABILITY_OUTPUT_BYTES = 64 * 1024;
const LOCAL_HMUX_PROBE_PROCESS_GRACE_MS = 100;
const MAX_SESSION_QUERY_TRANSPORT_BYTES =
  MAX_SESSION_QUERY_OUTPUT_BYTES + 64 * 1024;

function matchingBinding(
  binding,
  sessionId,
  workspaceId,
  bindingSource,
  bindingHostId,
) {
  return (
    record(binding) &&
    binding.runtime === "hmux_managed_v1" &&
    binding.source === bindingSource &&
    binding.hostId === bindingHostId &&
    binding.sessionId === sessionId &&
    binding.workspaceId === workspaceId
  );
}

function bindingIdentity(binding, bindingSource, bindingHostId) {
  if (
    !record(binding) ||
    binding.source !== bindingSource ||
    binding.hostId !== bindingHostId ||
    !boundedString(binding.workspaceId) ||
    !boundedString(binding.sessionId)
  ) {
    return null;
  }
  return `${binding.workspaceId}\u0000${binding.sessionId}`;
}

function currentClientBindingTargets(registry, bindingSource, bindingHostId) {
  const targets = new Map();
  const add = (binding) => {
    const identity = bindingIdentity(binding, bindingSource, bindingHostId);
    if (!identity || targets.has(identity)) return;
    targets.set(identity, {
      sessionId: binding.sessionId,
      workspaceId: binding.workspaceId,
    });
  };
  for (const agent of registry.agents ?? []) add(agent?.runtimeBinding);
  const spaces = registry.clientPresentation?.spaces;
  if (Array.isArray(spaces)) {
    for (const space of spaces) {
      if (!Array.isArray(space?.panes)) continue;
      for (const pane of space.panes) add(pane?.binding);
    }
  }
  return [...targets.values()]
    .sort((left, right) => {
      const leftKey = `${left.workspaceId}\u0000${left.sessionId}`;
      const rightKey = `${right.workspaceId}\u0000${right.sessionId}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
}

function sessionIdentity(session) {
  const workspaceId = session.workspaceId ?? session.workspace_id;
  const sessionId = session.sessionId ?? session.session_id;
  return boundedString(workspaceId) && boundedString(sessionId)
    ? `${workspaceId}\u0000${sessionId}`
    : null;
}

function prioritizeCurrentClientBindings(
  sessions,
  registry,
  bindingSource,
  bindingHostId,
) {
  const identities = new Set(
    currentClientBindingTargets(registry, bindingSource, bindingHostId).map(
      ({ workspaceId, sessionId }) => `${workspaceId}\u0000${sessionId}`,
    ),
  );
  if (identities.size === 0) return sessions;
  const current = [];
  const remaining = [];
  for (const session of sessions) {
    const identity = sessionIdentity(session);
    (identities.has(identity) ? current : remaining).push(session);
  }
  return [...current, ...remaining];
}

function exactBindingGeneration(binding, generation) {
  for (const candidate of [
    binding?.conversationIdentity,
    binding?.stopFence,
    binding,
  ]) {
    const projected = projectedGeneration(candidate);
    if (projected && sameGeneration(generation, projected)) return true;
  }
  return false;
}

function clientAgentProjection(agent, presentation) {
  const id = boundedString(agent.id) ? agent.id : null;
  const candidate = findAgentPane(presentation, id);
  const binding = agent.runtimeBinding;
  const pane = candidate && matchingBinding(
    candidate.binding,
    binding.sessionId,
    binding.workspaceId,
    binding.source,
    binding.hostId,
  )
    ? candidate
    : null;
  return {
    id,
    name: boundedString(agent.name) ? agent.name : null,
    displayName: boundedString(agent.displayName) ? agent.displayName : null,
    project: boundedString(agent.project) ? agent.project : null,
    pane: pane
      ? { id: pane.id, state: "observed" }
      : { id: null, state: "unavailable" },
  };
}

function clientProjection(
  registry,
  presentation,
  sessionId,
  workspaceId,
  generation,
  exactRuntimeGeneration,
  observedAtMs,
  bindingSource,
  bindingHostId,
) {
  const source = {
    clientId: registry.clientId,
    observedAtMs: registry.updatedAtMs,
    sourceAgeMs:
      Number.isSafeInteger(registry.updatedAtMs) && registry.updatedAtMs >= 0
        ? Math.max(0, observedAtMs - registry.updatedAtMs)
        : null,
  };
  if (registry.state !== "available") {
    return { state: registry.state, ...source, agents: [] };
  }
  const candidates = registry.agents.filter((agent) =>
    matchingBinding(
      agent.runtimeBinding,
      sessionId,
      workspaceId,
      bindingSource,
      bindingHostId,
    ),
  );
  if (candidates.length === 0) {
    return { state: "absent", ...source, agents: [] };
  }
  if (!exactRuntimeGeneration) {
    return {
      state: "runtime_unknown",
      ...source,
      agents: candidates.slice(0, 8).map(
        (agent) => clientAgentProjection(agent, presentation),
      ),
    };
  }
  const exact = candidates.filter((agent) =>
    exactBindingGeneration(agent.runtimeBinding, generation),
  );
  if (exact.length === 0) {
    return {
      state: "stale",
      ...source,
      agents: candidates.slice(0, 8).map(
        (agent) => clientAgentProjection(agent, presentation),
      ),
    };
  }
  return {
    state: exact.length === 1 ? "current" : "ambiguous",
    ...source,
    agents: exact.slice(0, 8).map(
      (agent) => clientAgentProjection(agent, presentation),
    ),
  };
}

function boundedMilliseconds(value, fallback, minimum = 1) {
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(MAX_SESSION_QUERY_DEADLINE_MS, Math.max(minimum, value));
}

function validRequestedMilliseconds(value, minimum) {
  return (
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= MAX_SESSION_QUERY_DEADLINE_MS
  );
}

function commandErrorCode(result) {
  if (result.kind === "timeout" || result.kind === "aborted") {
    return "hmux_session_query_timeout";
  }
  if (result.kind === "output_limit") return "hmux_session_query_output_limit";
  if (result.kind === "unavailable") return "hmux_session_query_unavailable";
  return "hmux_session_query_failed";
}

function errorReport(
  action,
  code,
  observedAtMs,
  durationMs,
  limits,
  detail = {},
  sourceKind = "local_hmux",
) {
  return {
    schemaVersion: SESSION_QUERY_SCHEMA_VERSION,
    apiVersion: "dure.sessions/v1",
    kind: "dure.sessions.error",
    action,
    complete: false,
    partial: false,
    observedAtMs,
    durationMs,
    source: { kind: sourceKind, appDaemonRequired: false },
    limits,
    error: { code, ...detail },
  };
}

function parsePayload(result, action) {
  let payload;
  try {
    payload = JSON.parse(result.stdout || "");
  } catch {
    return { error: "hmux_session_payload_invalid" };
  }
  if (action === "list") {
    if (record(payload) && payload.complete === false) {
      return { error: "hmux_session_census_incomplete" };
    }
    if (
      !exactKeys(
        payload,
        new Set([
          "schemaVersion",
          "complete",
          "prioritizedItems",
          "sessions",
          "truncation",
        ]),
      ) ||
      payload.schemaVersion !== SESSION_QUERY_SCHEMA_VERSION ||
      payload.complete !== true ||
      !Array.isArray(payload.sessions) ||
      payload.sessions.length > MAX_SESSION_QUERY_ITEMS ||
      !Number.isSafeInteger(payload.prioritizedItems) ||
      payload.prioritizedItems < 0 ||
      payload.prioritizedItems > payload.sessions.length ||
      !record(payload.truncation) ||
      !exactKeys(payload.truncation, new Set(["items", "omittedCount"])) ||
      typeof payload.truncation.items !== "boolean" ||
      !Number.isSafeInteger(payload.truncation.omittedCount) ||
      payload.truncation.omittedCount < 0 ||
      payload.truncation.items !== (payload.truncation.omittedCount > 0)
    ) {
      return { error: "hmux_session_payload_invalid" };
    }
    return {
      sessions: payload.sessions,
      omittedCount: payload.truncation.omittedCount,
    };
  }
  return record(payload)
    ? { sessions: [payload] }
    : { error: "hmux_session_payload_invalid" };
}

function exactKeys(value, expected) {
  return (
    record(value) &&
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
}

const PROBE_LIVENESS_BY_STATUS = new Map([
  ["healthy", "alive"],
  ["stale_transport", "dead"],
  ["incompatible_protocol", "dead"],
  ["exited", "dead"],
  ["not_found", "dead"],
  ["generation_changed", "unknown"],
  ["lookup_failed", "unknown"],
  ["unprobed", "unknown"],
]);
const PROBE_STATUSES_WITH_GENERATION = new Set([
  "healthy",
  "stale_transport",
  "incompatible_protocol",
  "exited",
  "generation_changed",
]);

function parseProbeBatchPayload(result, targets) {
  let payload;
  try {
    payload = JSON.parse(result.stdout || "");
  } catch {
    return null;
  }
  if (
    !exactKeys(payload, new Set(["schemaVersion", "complete", "results"])) ||
    payload.schemaVersion !== 1 ||
    typeof payload.complete !== "boolean" ||
    !Array.isArray(payload.results) ||
    payload.results.length !== targets.length
  ) {
    return null;
  }
  const allowed = new Set([
    "sessionId",
    "workspaceId",
    "liveness",
    "status",
    "errorCode",
    ...GENERATION_FIELDS.map(([field]) => field),
  ]);
  for (let index = 0; index < payload.results.length; index += 1) {
    const receipt = payload.results[index];
    const target = targets[index];
    if (
      !record(receipt) ||
      Object.keys(receipt).some((key) => !allowed.has(key)) ||
      receipt.sessionId !== target.sessionId ||
      receipt.workspaceId !== target.workspaceId ||
      PROBE_LIVENESS_BY_STATUS.get(receipt.status) !== receipt.liveness ||
      (receipt.errorCode !== undefined && !boundedString(receipt.errorCode, 256))
    ) {
      return null;
    }
    const withGeneration = PROBE_STATUSES_WITH_GENERATION.has(receipt.status);
    if (
      GENERATION_FIELDS.some(
        ([field]) =>
          withGeneration
            ? !boundedString(receipt[field], 256)
            : receipt[field] !== undefined,
      )
    ) {
      return null;
    }
  }
  if (
    payload.complete !==
    payload.results.every((receipt) => receipt.liveness !== "unknown")
  ) {
    return null;
  }
  return payload.results;
}

function probeGenerationMatches(session, receipt) {
  return GENERATION_FIELDS.every(
    ([projected, source]) => session[source] === receipt[projected],
  );
}

function applyProbeReceipt(session, receipt) {
  const status =
    PROBE_STATUSES_WITH_GENERATION.has(receipt.status) &&
    !probeGenerationMatches(session, receipt)
      ? "generation_changed"
      : receipt.status;
  const health =
    status === "not_found" || status === "generation_changed"
      ? "generation_changed"
      : status === "lookup_failed" || status === "unprobed"
        ? "unprobed"
        : status;
  const effectiveLifecycle =
    health === "healthy"
      ? "ready"
      : health === "stale_transport" || health === "generation_changed"
        ? "stale"
        : health === "incompatible_protocol"
          ? "incompatible"
          : health;
  return { ...session, effectiveLifecycle, health };
}

function parseBackendPayload(result, action) {
  if (action === "list") {
    const allowed = new Set([
      "schemaVersion",
      "complete",
      "sessions",
      "truncation",
    ]);
    if (
      !record(result) ||
      Object.keys(result).some((key) => !allowed.has(key)) ||
      result.schemaVersion !== SESSION_QUERY_SCHEMA_VERSION ||
      result.complete !== true ||
      !Array.isArray(result.sessions) ||
      result.sessions.length > MAX_SESSION_QUERY_ITEMS
    ) {
      return { error: "dure_session_backend_payload_invalid" };
    }
    if (result.truncation === undefined) {
      return { sessions: result.sessions, omittedCount: 0 };
    }
    if (
      !record(result.truncation) ||
      !exactKeys(result.truncation, new Set(["items", "omittedCount"])) ||
      result.truncation.items !== true ||
      !Number.isSafeInteger(result.truncation.omittedCount) ||
      result.truncation.omittedCount < 1
    ) {
      return { error: "dure_session_backend_payload_invalid" };
    }
    return {
      sessions: result.sessions,
      omittedCount: result.truncation.omittedCount,
    };
  }
  if (
    !exactKeys(result, new Set(["schemaVersion", "session"])) ||
    result.schemaVersion !== SESSION_QUERY_SCHEMA_VERSION ||
    !record(result.session)
  ) {
    return { error: "dure_session_backend_payload_invalid" };
  }
  return { sessions: [result.session] };
}

function backendErrorReport(action, error, profile, startedAt, limits) {
  const observedAtMs = Date.now();
  const { code, ...detail } = backendRequestFailure(error, profile);
  return errorReport(
    action,
    code,
    observedAtMs,
    Math.max(0, observedAtMs - startedAt),
    limits,
    {
      ...(profile ? { profileId: profile.id } : {}),
      ...detail,
    },
    "backend_profile",
  );
}

export async function collectSessionQuery({
  action,
  hmuxCommand = "hmux",
  sessionId,
  workspaceId,
  registry = { state: "absent", clientId: null, updatedAtMs: null, agents: [] },
  deadlineMs = DEFAULT_SESSION_QUERY_DEADLINE_MS,
  probeBudgetMs = DEFAULT_SESSION_PROBE_BUDGET_MS,
  backend = null,
  execute = runBoundedCommand,
  requestBackend = performBackendProfileRequest,
} = {}) {
  if (
    !validRequestedMilliseconds(deadlineMs, 1) ||
    !validRequestedMilliseconds(probeBudgetMs, 0)
  ) {
    const limits = {
      deadlineMs: DEFAULT_SESSION_QUERY_DEADLINE_MS,
      probeBudgetMs: DEFAULT_SESSION_PROBE_BUDGET_MS,
      maxItems: MAX_SESSION_QUERY_ITEMS,
      maxOutputBytes: MAX_SESSION_QUERY_OUTPUT_BYTES,
    };
    return errorReport(action, "dure_session_query_invalid", Date.now(), 0, limits);
  }
  const deadline = boundedMilliseconds(deadlineMs, DEFAULT_SESSION_QUERY_DEADLINE_MS);
  const probeBudget = Math.min(
    deadline,
    boundedMilliseconds(probeBudgetMs, DEFAULT_SESSION_PROBE_BUDGET_MS, 0),
  );
  const limits = {
    deadlineMs: deadline,
    probeBudgetMs: probeBudget,
    maxItems: MAX_SESSION_QUERY_ITEMS,
    maxOutputBytes: MAX_SESSION_QUERY_OUTPUT_BYTES,
  };
  const startedAt = Date.now();
  if (
    !["list", "show"].includes(action) ||
    (action === "show" && !boundedString(sessionId)) ||
    (workspaceId !== undefined && !boundedString(workspaceId))
  ) {
    return errorReport(action, "dure_session_query_invalid", Date.now(), 0, limits);
  }
  let parsed;
  let source;
  let bindingSource = "local";
  let bindingHostId = "local";
  if (backend) {
    const profile = backend.profile;
    if (backend.error || !profile) {
      return backendErrorReport(
        action,
        backend.error,
        profile,
        startedAt,
        limits,
      );
    }
    let response;
    try {
      const boundedCatalog =
        profile.expected?.capabilities?.includes(
          BOUNDED_BACKEND_SESSION_CATALOG_CAPABILITY,
        ) === true;
      const prioritized = boundedCatalog
        ? currentClientBindingTargets(
            registry,
            profile.transport.kind === "ssh" ? "ssh" : "local",
            profile.transport.kind === "ssh" ? profile.id : "local",
          ).slice(0, MAX_SESSION_QUERY_ITEMS)
        : [];
      response = await requestBackend(
        profile,
        {
          body:
            action === "list"
              ? {
                  schemaVersion: SESSION_QUERY_SCHEMA_VERSION,
                  probeBudgetMs: probeBudget,
                  maxItems: MAX_SESSION_QUERY_ITEMS,
                  ...(boundedCatalog ? { prioritized } : {}),
                }
              : {
                  schemaVersion: SESSION_QUERY_SCHEMA_VERSION,
                  sessionId,
                  ...(workspaceId === undefined ? {} : { workspaceId }),
                },
          operation: `sessions.${action}`,
          requiredCapabilities: [`sessions.${action}`],
        },
        {
          ...backend.transportOptions,
          deadlineMs: deadline,
          maxResponseBytes: MAX_SESSION_QUERY_TRANSPORT_BYTES,
        },
      );
    } catch (error) {
      return backendErrorReport(action, error, profile, startedAt, limits);
    }
    parsed = parseBackendPayload(response.result, action);
    source = {
      kind: "backend_profile",
      appDaemonRequired: false,
      profileId: profile.id,
      transport: profile.transport.kind,
      backend: response.backend,
    };
    bindingSource = profile.transport.kind === "ssh" ? "ssh" : "local";
    bindingHostId = profile.transport.kind === "ssh" ? profile.id : "local";
  } else {
    const prioritized =
      action === "list"
        ? currentClientBindingTargets(
            registry,
            bindingSource,
            bindingHostId,
          ).slice(0, MAX_SESSION_QUERY_ITEMS)
        : [];
    if (action === "list") {
      const capability = await execute(
        [hmuxCommand, "capabilities", "--json"],
        {
          timeoutMs: deadline,
          maxCaptureBytes: HMUX_CAPABILITY_OUTPUT_BYTES,
        },
      );
      const capabilityObservedAtMs = Date.now();
      const capabilityDurationMs = Math.max(
        0,
        capabilityObservedAtMs - startedAt,
      );
      if (capability.kind !== "success") {
        return errorReport(
          action,
          commandErrorCode(capability),
          capabilityObservedAtMs,
          capabilityDurationMs,
          limits,
        );
      }
      let manifest;
      try {
        manifest = JSON.parse(capability.stdout || "");
      } catch {}
      if (
        !supportsHmuxCapability(
          manifest,
          BOUNDED_HMUX_SESSION_CATALOG_CAPABILITY,
        )
      ) {
        return errorReport(
          action,
          "dure_session_hmux_incompatible",
          capabilityObservedAtMs,
          capabilityDurationMs,
          limits,
          { capability: BOUNDED_HMUX_SESSION_CATALOG_CAPABILITY },
        );
      }
    }
    const argv =
      action === "list"
        ? [
            hmuxCommand,
            "--json",
            "session",
            "list",
            "--no-probe",
            "--catalog-query-json",
            JSON.stringify({
              schemaVersion: SESSION_QUERY_SCHEMA_VERSION,
              maxItems: MAX_SESSION_QUERY_ITEMS,
              maxOutputBytes: MAX_HMUX_SESSION_CATALOG_BYTES,
              prioritized,
            }),
          ]
        : [hmuxCommand, "--json", "session", "show", sessionId];
    if (action === "show" && workspaceId !== undefined) {
      argv.push("--workspace", workspaceId);
    }
    let commandTimeoutMs = deadline;
    if (action === "list") {
      commandTimeoutMs = Math.max(
        0,
        deadline - Math.max(0, Date.now() - startedAt),
      );
      if (commandTimeoutMs === 0) {
        return errorReport(
          action,
          "hmux_session_query_timeout",
          Date.now(),
          Math.max(0, Date.now() - startedAt),
          limits,
        );
      }
    }
    const result = await execute(argv, {
      timeoutMs: commandTimeoutMs,
      maxCaptureBytes: MAX_SESSION_QUERY_OUTPUT_BYTES,
    });
    const observedAtMs = Date.now();
    const durationMs = Math.max(0, observedAtMs - startedAt);
    if (result.kind !== "success") {
      return errorReport(
        action,
        commandErrorCode(result),
        observedAtMs,
        durationMs,
        limits,
      );
    }
    parsed = parsePayload(result, action);
    source = { kind: "local_hmux", appDaemonRequired: false };
    if (action === "list" && !parsed.error) {
      const prioritized = prioritizeCurrentClientBindings(
        parsed.sessions,
        registry,
        bindingSource,
        bindingHostId,
      );
      const identities = prioritized.map(sessionIdentity);
      if (
        identities.some((identity) => identity === null) ||
        new Set(identities).size !== identities.length
      ) {
        parsed = { error: "hmux_session_payload_invalid" };
      } else {
        const selected = prioritized.slice(0, MAX_SESSION_QUERY_ITEMS);
        const targets = selected.map((session) => ({
          sessionId: session.session_id,
          workspaceId: session.workspace_id,
        }));
        const remainingMs = Math.max(0, deadline - durationMs);
        const probeWindowMs = Math.min(
          probeBudget,
          Math.max(0, remainingMs - LOCAL_HMUX_PROBE_PROCESS_GRACE_MS),
        );
        if (targets.length > 0 && probeWindowMs > 0) {
          const batchResult = await execute(
            [
              hmuxCommand,
              "--json",
              "session",
              "probe-batch",
              "--targets-json",
              JSON.stringify(targets),
              "--probe-budget-ms",
              String(probeWindowMs),
            ],
            {
              timeoutMs: Math.max(1, remainingMs),
              maxCaptureBytes: MAX_SESSION_QUERY_OUTPUT_BYTES,
            },
          );
          if (batchResult.kind !== "success") {
            parsed = { ...parsed, sessions: prioritized };
          } else {
            const receipts = parseProbeBatchPayload(batchResult, targets);
            if (!receipts) {
              parsed = { ...parsed, sessions: prioritized };
            } else {
              parsed = {
                ...parsed,
                sessions: [
                  ...selected.map((session, index) =>
                    applyProbeReceipt(session, receipts[index]),
                  ),
                  ...prioritized.slice(MAX_SESSION_QUERY_ITEMS),
                ],
              };
            }
          }
        } else {
          parsed = { ...parsed, sessions: prioritized };
        }
      }
    }
  }
  const observedAtMs = Date.now();
  const durationMs = Math.max(0, observedAtMs - startedAt);
  if (parsed.error) {
    return errorReport(
      action,
      parsed.error,
      observedAtMs,
      durationMs,
      limits,
      backend?.profile ? { profileId: backend.profile.id } : {},
      source.kind,
    );
  }
  const presentation = parseClientPresentation(registry.clientPresentation);
  const projected = parsed.sessions.map((session) => {
    const result = projectSession(session, observedAtMs);
    if (result) {
      result.clientProjection = clientProjection(
        registry,
        presentation,
        result.sessionId,
        result.workspaceId,
        result.runtime.generation,
        result.liveness.exactGeneration,
        observedAtMs,
        bindingSource,
        bindingHostId,
      );
    }
    return result;
  });
  if (projected.some((session) => session === null)) {
    return errorReport(
      action,
      "hmux_session_payload_invalid",
      observedAtMs,
      durationMs,
      limits,
      {
        itemIndex: projected.indexOf(null),
        ...(backend?.profile ? { profileId: backend.profile.id } : {}),
      },
      source.kind,
    );
  }
  if (
    action === "show" &&
    (projected.length !== 1 ||
      projected[0].sessionId !== sessionId ||
      (workspaceId !== undefined && projected[0].workspaceId !== workspaceId))
  ) {
    return errorReport(
      action,
      "dure_session_query_identity_mismatch",
      observedAtMs,
      durationMs,
      limits,
      backend?.profile ? { profileId: backend.profile.id } : {},
      source.kind,
    );
  }
  const prioritized = prioritizeCurrentClientBindings(
    projected,
    registry,
    bindingSource,
    bindingHostId,
  );
  const omittedCount =
    (parsed.omittedCount ?? 0) +
    Math.max(0, prioritized.length - MAX_SESSION_QUERY_ITEMS);
  const sessions = prioritized.slice(0, MAX_SESSION_QUERY_ITEMS);
  const observationIncomplete = sessions.some(
    (session) => session.liveness.health === "unprobed",
  );
  const base = {
    schemaVersion: SESSION_QUERY_SCHEMA_VERSION,
    apiVersion: "dure.sessions/v1",
    kind: `dure.sessions.${action}`,
    complete: true,
    partial: omittedCount > 0 || observationIncomplete,
    observedAtMs,
    durationMs,
    source,
    limits,
    truncation: { items: omittedCount > 0, omittedCount },
  };
  const report = action === "list"
    ? { ...base, sessions }
    : { ...base, session: sessions[0] };
  if (Buffer.byteLength(JSON.stringify(report), "utf8") > MAX_SESSION_QUERY_OUTPUT_BYTES) {
    return errorReport(
      action,
      "dure_session_query_output_limit",
      observedAtMs,
      durationMs,
      limits,
      backend?.profile ? { profileId: backend.profile.id } : {},
      source.kind,
    );
  }
  return report;
}

export function sessionQueryExitCode(report) {
  return report.kind === "dure.sessions.error" ? 2 : 0;
}

export function formatSessionQuery(report) {
  if (report.kind === "dure.sessions.error") {
    return `Dure sessions unavailable: ${report.error.code}`;
  }
  const sessions = report.kind === "dure.sessions.list" ? report.sessions : [report.session];
  if (sessions.length === 0) return "No Dure sessions.";
  const lines = [
    "SESSION\tWORKSPACE\tPROVIDER\tPID\tLIVE\tCWD\tAGENTS\tFAILURE",
  ];
  for (const session of sessions) {
    lines.push(
      [
        session.sessionId,
        session.workspaceId,
        session.provider.id,
        session.provider.pid,
        session.liveness.state,
        session.cwd ?? "-",
        session.clientProjection.agents
          .map((agent) => agent.displayName ?? agent.name ?? agent.id ?? "?")
          .join(",") || "-",
        session.failure
          ? `${session.failure.code} (${session.failure.correlationId})`
          : "-",
      ].join("\t"),
    );
  }
  return lines.join("\n");
}
