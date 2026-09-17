import { parseClientPresentation, boundedString, MAX_SPACE_QUERY_SPACES, MAX_SPACE_QUERY_PANES_PER_SPACE, MAX_SPACE_QUERY_TOTAL_PANES } from "./client-presentation-state.mjs";
export { parseClientPresentation, MAX_SPACE_QUERY_SPACES, MAX_SPACE_QUERY_PANES_PER_SPACE, MAX_SPACE_QUERY_TOTAL_PANES } from "./client-presentation-state.mjs";
import {
  collectSessionQuery,
  MAX_SESSION_QUERY_OUTPUT_BYTES,
} from "./session-query.mjs";

import { selectSpace } from "./space-selection.mjs";

export const SPACE_QUERY_SCHEMA_VERSION = 1;
function sessionKey(workspaceId, sessionId) {
  return `${workspaceId}\u0000${sessionId}`;
}

function runtimeState(session) {
  if (session.liveness.exactGeneration) return "current";
  return session.liveness.health === "generation_changed"
    ? "stale"
    : "unavailable";
}

function backendBindingTarget(source) {
  if (source.kind === "backend_profile" && source.transport === "ssh") {
    return { source: "ssh", hostId: source.profileId };
  }
  return { source: "local", hostId: "local" };
}

function agentProjection(pane, session) {
  const projection = session.clientProjection;
  const matching = pane.agentId
    ? projection.agents.filter((agent) => agent.id === pane.agentId)
    : projection.agents;
  return {
    state:
      pane.agentId && matching.length === 0
        ? "unavailable"
        : projection.state,
    clientId: projection.clientId,
    observedAtMs: projection.observedAtMs,
    sourceAgeMs: projection.sourceAgeMs,
    requestedAgentId: pane.agentId,
    candidates: matching,
  };
}

function unavailableRuntime(state, reason, binding) {
  return {
    state,
    reason,
    binding,
    session: null,
    agentProjection: null,
  };
}

function projectPane(pane, sessionsByIdentity, expectedTarget, sessionsPartial) {
  if (!pane.binding) {
    return {
      ...pane,
      runtime: unavailableRuntime(
        "unavailable",
        "session_binding_unavailable",
        null,
      ),
    };
  }
  if (
    pane.binding.source !== expectedTarget.source ||
    pane.binding.hostId !== expectedTarget.hostId
  ) {
    return {
      ...pane,
      runtime: unavailableRuntime(
        "unavailable",
        "backend_target_mismatch",
        pane.binding,
      ),
    };
  }
  const candidates =
    sessionsByIdentity.get(
      sessionKey(pane.binding.workspaceId, pane.binding.sessionId),
    ) ?? [];
  if (candidates.length === 0) {
    return {
      ...pane,
      runtime: unavailableRuntime(
        sessionsPartial ? "unavailable" : "stale",
        sessionsPartial
          ? "runtime_snapshot_partial"
          : "bound_session_absent",
        pane.binding,
      ),
    };
  }
  if (candidates.length !== 1) {
    return {
      ...pane,
      runtime: unavailableRuntime(
        "ambiguous",
        "bound_session_ambiguous",
        pane.binding,
      ),
    };
  }
  const session = candidates[0];
  const state = runtimeState(session);
  return {
    ...pane,
    runtime: {
      state,
      reason:
        state === "current"
          ? null
          : state === "stale"
            ? "runtime_generation_changed"
            : "runtime_generation_unverified",
      binding: pane.binding,
      session: {
        sessionId: session.sessionId,
        workspaceId: session.workspaceId,
        generation: session.runtime.generation,
        provider: session.provider,
        liveness: session.liveness,
        cwd: session.cwd,
      },
      agentProjection: agentProjection(pane, session),
    },
  };
}

function stateCounts(panes) {
  const counts = {
    current: 0,
    stale: 0,
    ambiguous: 0,
    unavailable: 0,
  };
  for (const pane of panes) counts[pane.runtime.state] += 1;
  return counts;
}

function errorReport(action, code, context = {}, detail = {}) {
  const observedAtMs = Date.now();
  return {
    schemaVersion: SPACE_QUERY_SCHEMA_VERSION,
    apiVersion: "dure.spaces/v1",
    kind: "dure.spaces.error",
    action,
    complete: false,
    partial: false,
    observedAtMs,
    durationMs: context.durationMs ?? 0,
    source:
      context.source ??
      ({ kind: "client_projection", appDaemonRequired: false }),
    client: context.client ?? null,
    limits: context.limits ?? null,
    error: { code, ...detail },
  };
}

export async function collectSpaceQuery({
  action,
  spaceId,
  registry,
  sessionQuery = {},
  collectSessions = collectSessionQuery,
} = {}) {
  if (
    !["list", "show"].includes(action) ||
    (action === "show" && !boundedString(spaceId))
  ) {
    return errorReport(action, "dure_space_query_invalid");
  }
  const client = {
    id: registry?.clientId ?? null,
    state: registry?.state ?? "absent",
    observedAtMs: registry?.updatedAtMs ?? null,
    sourceAgeMs:
      Number.isSafeInteger(registry?.updatedAtMs) && registry.updatedAtMs >= 0
        ? Math.max(0, Date.now() - registry.updatedAtMs)
        : null,
  };
  const presentation = parseClientPresentation(registry?.clientPresentation);
  if (!presentation) {
    return errorReport(
      action,
      registry?.clientPresentation === null ||
        registry?.clientPresentation === undefined
        ? "dure_space_client_projection_absent"
        : "dure_space_client_projection_invalid",
      {
        source: { kind: "client_projection", appDaemonRequired: false },
        client,
        limits: {
          maxSpaces: MAX_SPACE_QUERY_SPACES,
          maxPanesPerSpace: MAX_SPACE_QUERY_PANES_PER_SPACE,
          maxTotalPanes: MAX_SPACE_QUERY_TOTAL_PANES,
          maxOutputBytes: MAX_SESSION_QUERY_OUTPUT_BYTES,
        },
      },
    );
  }
  const selection = action === "show" ? selectSpace(presentation, spaceId) : null;
  if (selection?.error) {
    return errorReport(
      action,
      selection.error === "selector_invalid" ? "dure_space_query_invalid" : `dure_space_${selection.error}`,
      { client },
      { spaceId },
    );
  }
  const sessionsReport = await collectSessions({
    ...sessionQuery,
    action: "list",
    registry,
  });
  if (sessionsReport.kind === "dure.sessions.error") {
    return errorReport(
      action,
      sessionsReport.error.code,
      {
        durationMs: sessionsReport.durationMs,
        source: sessionsReport.source,
        client,
        limits: sessionsReport.limits,
      },
      {
        upstream: "sessions.list",
        ...(sessionsReport.error.profileId
          ? { profileId: sessionsReport.error.profileId }
          : {}),
        ...(sessionsReport.error.remoteCode
          ? { remoteCode: sessionsReport.error.remoteCode }
          : {}),
        ...(sessionsReport.error.capability
          ? { capability: sessionsReport.error.capability }
          : {}),
      },
    );
  }
  const sessionsByIdentity = new Map();
  for (const session of sessionsReport.sessions) {
    const key = sessionKey(session.workspaceId, session.sessionId);
    const candidates = sessionsByIdentity.get(key) ?? [];
    candidates.push(session);
    sessionsByIdentity.set(key, candidates);
  }
  const expectedTarget = backendBindingTarget(sessionsReport.source);
  const projectedSpaces = presentation.spaces.map((space) => {
    const panes = space.panes.map((pane) =>
      projectPane(
        pane,
        sessionsByIdentity,
        expectedTarget,
        sessionsReport.partial,
      ),
    );
    return {
      id: space.id,
      name: space.name,
      kind: space.kind,
      paneCount: panes.length,
      runtimeStates: stateCounts(panes),
      panes,
    };
  });
  const selected = action === "show"
    ? projectedSpaces.find((space) => space.id === selection.space.id)
    : null;
  const base = {
    schemaVersion: SPACE_QUERY_SCHEMA_VERSION,
    apiVersion: "dure.spaces/v1",
    kind: `dure.spaces.${action}`,
    complete:
      sessionsReport.complete && presentation.complete && registry.state === "available",
    partial:
      sessionsReport.partial || !presentation.complete || registry.state !== "available",
    observedAtMs: Date.now(),
    durationMs: sessionsReport.durationMs,
    source: sessionsReport.source,
    client,
    limits: {
      ...sessionsReport.limits,
      maxSpaces: MAX_SPACE_QUERY_SPACES,
      maxPanesPerSpace: MAX_SPACE_QUERY_PANES_PER_SPACE,
      maxTotalPanes: MAX_SPACE_QUERY_TOTAL_PANES,
      maxOutputBytes: MAX_SESSION_QUERY_OUTPUT_BYTES,
    },
    truncation: {
      runtimeSessions: sessionsReport.truncation,
      clientSpaces: presentation.truncation,
    },
  };
  const report =
    action === "list"
      ? {
          ...base,
          spaces: projectedSpaces.map(({ panes: _panes, ...space }) => space),
        }
      : { ...base, space: selected };
  if (
    Buffer.byteLength(JSON.stringify(report), "utf8") >
    MAX_SESSION_QUERY_OUTPUT_BYTES
  ) {
    return errorReport(
      action,
      "dure_space_query_output_limit",
      {
        durationMs: sessionsReport.durationMs,
        source: sessionsReport.source,
        client,
        limits: base.limits,
      },
    );
  }
  return report;
}

export function spaceQueryExitCode(report) {
  return report.kind === "dure.spaces.error" ? 2 : 0;
}

export function formatSpaceQuery(report) {
  if (report.kind === "dure.spaces.error") {
    return `${report.error.code}${report.error.spaceId ? `: ${report.error.spaceId}` : ""}`;
  }
  if (report.kind === "dure.spaces.list") {
    return report.spaces.length === 0
      ? "(no spaces)"
      : report.spaces
          .map(
            (space) =>
              `${space.id}\t${space.name}\t${space.paneCount} pane\t${space.runtimeStates.current} current`,
          )
          .join("\n");
  }
  return report.space.panes.length === 0
    ? `${report.space.id}\t${report.space.name}\t(no panes)`
    : report.space.panes
        .map(
          (pane) =>
            `${pane.id}\t${pane.type}\t${pane.title ?? ""}\t${pane.runtime.state}${pane.runtime.session ? `\t${pane.runtime.session.workspaceId}/${pane.runtime.session.sessionId}` : ""}`,
        )
        .join("\n");
}
