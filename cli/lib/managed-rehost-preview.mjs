import { randomUUID } from "node:crypto";
import { collectAgentRuntimeCommand } from "./agent-runtime-command.mjs";
import { backendRequestFailure } from "./backend-request-failure.mjs";
import { agentDisplayName, loadSessionClientProjection, matchingAgents } from "./client-registry.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";
import {
  agentRuntimeRestartableClosedSource,
  agentRuntimeSourceUnavailableReason,
  agentRuntimeWakeTarget,
} from "./contracts/agent-runtime.mjs";

const RUNTIME_TARGETS = { native_cli: "terminal", structured_protocol: "chat" };

/** Name candidates carry exact selectors: project/name when that is unique,
 * and the Agent ID, which runs resume accepts with or without a Run record. */
function nameCandidates(agents, name) {
  return agents.map((agent) => {
    const display = agentDisplayName(agent);
    const qualified = typeof agent.project === "string" && display ? `${agent.project}/${display}` : undefined;
    const unique = qualified && agents.filter((other) =>
      other.project === agent.project && agentDisplayName(other) === display).length === 1;
    return { agentId: agent.id, name: display ?? name, project: agent.project ?? null,
      providerId: agent.provider ?? null, sessionId: agent.sessionId ?? null,
      retry: unique && qualified !== name ? ["hmux", "rehost", "--name", qualified] : ["runs", "resume", agent.id] };
  });
}

/** Initial same-launch requests share recovery planning; advanced modes retain their owner. */
export function isManagedRehostNameRequest(opts) {
  return Boolean(opts.name || opts.rest[1]) && opts.rest.length <= (opts.name ? 1 : 2) &&
    !opts.fresh &&
    ["operationId", "permissionMode", "conversationId", "existingSessionId", "targetPanelId",
      "fromSession", "workspace", "credentialReference", "credentialGeneration", "provider",
      "cwd", "agentName", "spaceId", "desktopId", "windowLabel", "to"].every(
      (key) => opts[key] === undefined,
    );
}

/** The client owns the name; the backend supplies the source. This does not admit an operation. */
export async function collectManagedRehostPreview({ opts, registry, agentId: durableAgentId, resolveBackend, requestBackend }) {
  const name = (opts.name || opts.rest[1]).trim();
  const base = { schemaVersion: 1, name, nativeExecution: "not_requested" };
  const failure = (error, details = {}) => ({ ...base, ok: false, error, ...details });
  if (durableAgentId === undefined && registry.state !== "available") {
    return failure({ code: "rehost_name_projection_unavailable",
      message: "The complete client name projection is unavailable. Inspect an exact Agent with dure runtime get <agent-id>." });
  }
  const matches = durableAgentId === undefined ? matchingAgents(registry, name) : [{ id: durableAgentId }];
  if (matches.length === 0) {
    return failure({ code: "rehost_name_not_found",
      message: `No Agent named ${name} is in the app's name projection. A closed or dispatched Agent can leave it; ` +
        "find its Agent ID with dure runs list or dure ls and preview recovery with dure runs resume <agent-id>." });
  }
  if (matches.length !== 1 || !isDureDomainIdV1(matches[0]?.id)) {
    return failure({ code: "rehost_name_not_unique", candidates: nameCandidates(matches, name),
      message: `${matches.length} Agents match ${name}. Retry with one exact selector:` });
  }
  const agentId = matches[0].id;
  const backend = await resolveBackend();
  if (!backend?.profile || backend.error) {
    return failure(backendRequestFailure(backend?.error, backend?.profile), { agentId });
  }
  if (backend.profile.transport.kind !== "local") {
    return failure({ code: "rehost_preview_local_only",
      message: "Native start/status run on their execution host. Remote rehost planning is not supported here." }, { agentId });
  }
  const report = await collectAgentRuntimeCommand({
    args: ["get", agentId], resolveBackend: async () => backend, requestBackend,
  });
  if (!report.ok) return failure(report.error, { agentId });
  const observation = report.result;
  const wake = agentRuntimeWakeTarget(observation);
  if (wake && observation.targetInteractionProfile === "native_cli") {
    const requestId = randomUUID();
    const start = ["runtime", "wake", agentId, "--operation-id", wake.operationId,
      "--expected-revision", String(wake.expectedJournalRevision),
      "--idempotency-key", requestId, "--backend", backend.profile.id, "--json"];
    return {
      ...base, ok: true, state: "preview", backendExecution: "not_requested",
      agentId, backend: report.backend, observation,
      continuation: {
        kind: "runtime_wake", ...wake, requestId, start, retry: [...start],
        status: ["runtime", "get", agentId, "--backend", backend.profile.id, "--json"],
      },
    };
  }
  const stopped = agentRuntimeRestartableClosedSource(observation);
  if (stopped) {
    // The same successor transition the app uses to restart a closed Agent.
    // The backend resumes the stopped source's retained conversation.
    const requestId = randomUUID();
    const start = ["runtime", "switch", agentId, RUNTIME_TARGETS[stopped.interactionProfile],
      "--expected-revision", String(stopped.selectionRevision),
      "--idempotency-key", requestId, "--backend", backend.profile.id, "--json"];
    return {
      ...base, ok: true, state: "preview", backendExecution: "not_requested",
      agentId, backend: report.backend, observation,
      continuation: {
        kind: "runtime_restart", targetInteractionProfile: stopped.interactionProfile,
        expectedSourceRevision: stopped.selectionRevision, requestId, start, retry: [...start],
        status: ["runtime", "get", agentId, "--backend", backend.profile.id, "--json"],
      },
    };
  }
  const selected = observation.receipt?.authority;
  const source = selected?.authority;
  const binding = source?.binding;
  if (observation.state !== "stable" || selected?.interactionProfile !== "native_cli" ||
      binding?.runtimeKindId !== "runtime.hmux" || binding.agentId !== agentId ||
      ![binding.sessionId, source.runtimeWorkspaceId].every((id) => typeof id === "string" && id.length > 0)) {
    return failure({ code: "rehost_native_source_unavailable",
      message: `This observation does not provide a native source. ${agentRuntimeSourceUnavailableReason(observation)}` },
    { agentId, observation });
  }
  const operationId = randomUUID();
  const sourceSessionId = binding.sessionId;
  const sourceWorkspaceId = source.runtimeWorkspaceId;
  const identity = [sourceSessionId, "--workspace", sourceWorkspaceId, "--operation-id", operationId];
  return {
    ...base, ok: true, state: "preview", agentId, backend: report.backend, observation,
    continuation: {
      operationId, sourceSessionId, sourceWorkspaceId,
      start: ["hmux", "rehost", "start", ...identity, "--confirm-restart", "--json"],
      retry: ["hmux", "rehost", "retry", ...identity, "--confirm-restart", "--json"],
      status: ["hmux", "rehost", "status", ...identity, "--json"],
      publish: ["hmux", "rehost", "publish", agentId, "--from-session", ...identity,
        "--backend", backend.profile.id, "--json"],
    },
  };
}

/** Quote every token: names and backend identity must never become shell syntax. */
export const rehostCommandLine = (args) =>
  "dure " + args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");

export function formatManagedRecoveryCommands(continuation) {
  if (!continuation) return [];
  const wake = continuation.kind === "runtime_wake";
  const restart = continuation.kind === "runtime_restart";
  return [
    wake
      ? "The backend owns wake and binding publication. Retain this exact operation, revision and request key."
      : restart
        ? "This Agent is stopped. The backend restarts it with its retained conversation through the app's transition. Retain this exact revision and request key."
        : "Retain these exact commands for this attempt; another name request proposes a different operation.",
    `${wake ? "Wake" : restart ? "Restart" : "Start"}: ${rehostCommandLine(continuation.start)}`,
    `Status: ${rehostCommandLine(continuation.status)}`,
    `Retry the original request after inspection: ${rehostCommandLine(continuation.retry)}`,
    ...(continuation.publish ? [`Publish: ${rehostCommandLine(continuation.publish)}`] : []),
  ];
}

export function formatNameCandidates(candidates = []) {
  return candidates.flatMap((candidate) => [
    `  ${candidate.agentId}\t${candidate.name}\t${candidate.project ?? "-"}\t${candidate.providerId ?? "-"}\t${candidate.sessionId ?? "-"}`,
    `    ${rehostCommandLine(candidate.retry)}`,
  ]);
}

export async function runManagedRehostPreview(opts, registryPath, resolveBackend) {
  const report = await collectManagedRehostPreview({
    opts, registry: loadSessionClientProjection({ registryPath }), resolveBackend,
  });
  const output = opts.json ? JSON.stringify(report) : report.ok
    ? [
      `Preview: ${report.agentId} (${report.continuation.kind === "runtime_wake" ? "dormant runtime"
        : report.continuation.kind === "runtime_restart" ? "stopped runtime" : report.continuation.sourceSessionId})`,
      "Nothing was started or reserved. This is not proof of liveness or a recoverable conversation.",
      ...formatManagedRecoveryCommands(report.continuation),
    ].join("\n")
    : [`${report.error.remoteCode ?? report.error.code}: ${report.error.message}`,
      ...formatNameCandidates(report.error.candidates), "No runtime execution was requested."].join("\n");
  (report.ok ? process.stdout : process.stderr).write(`${output}\n`);
  if (!report.ok) process.exitCode = 1;
}
