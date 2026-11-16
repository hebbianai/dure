import { randomUUID } from "node:crypto";
import { collectAgentRuntimeCommand } from "./agent-runtime-command.mjs";
import { backendRequestFailure } from "./backend-request-failure.mjs";
import { agentDisplayName, loadSessionClientProjection, matchingAgents } from "./client-registry.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";
import {
  classifySourceSession, hostAbsentOperationId, readSourceSession, supportsHostAbsentStart,
} from "./managed-rehost-source-host.mjs";
import { collectManagedRehostStatus, observeManagedRehostSource } from "./managed-rehost-status.mjs";
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

/** Wait on one exact operation Hmux holds, then publish it once; never admits another operation. */
export const managedRehostFinishCommand = ({ agentId, operationId, sourceSessionId, sourceWorkspaceId, backendId }) => [
  "hmux", "rehost", "finish", agentId, "--from-session", sourceSessionId, "--workspace", sourceWorkspaceId,
  "--operation-id", operationId, "--confirm-restart", "--backend", backendId, "--json"];

/**
 * The rehost Hmux already holds for this exact source. Hmux refuses a second
 * operation for a source, and the Agent's binding names that source until the
 * held operation is published, so recovery continues it instead of proposing
 * another. Undefined when Hmux holds none or gave no exact answer; its own
 * admission fence still refuses a second operation then.
 */
async function heldManagedRehost({ sessionId, workspaceId, command, run }) {
  const held = await observeManagedRehostSource({ sessionId, workspaceId, command, run });
  if (!held || held.state === "not_found") return undefined;
  const unconfirmed = { unconfirmed: held.state === "resolved" ? held.operationIds : [held.operationId] };
  // A completed edge from this source that its binding never named.
  if (held.state === "resolved") {
    return held.operationIds.length === 1 ? { operationId: held.operationIds[0], nativeState: "completed" } : unconfirmed;
  }
  // Latest-successor resolution stops at the first pending edge, which may
  // belong to a later generation. Continue only this source's own operation.
  try {
    const exact = await collectManagedRehostStatus({ sessionId, workspaceId, operationId: held.operationId, command, run });
    if (exact.ok && exact.result.state !== "not_found") {
      return { operationId: held.operationId, nativeState: exact.result.state === "resolved" ? "completed" : "running" };
    }
  } catch {
    /* Refuse below: an unconfirmed operation is never replaced. */
  }
  return unconfirmed;
}

/**
 * The selected source's Host when Hmux observes that exact generation no
 * longer answering, with the conversation to continue (null when none was
 * recorded). Undefined for a running, replaced or unobservable Host: the
 * native rehost then asks the Host itself, as before.
 */
async function absentSourceHost({ source, sessionId, workspaceId, conversationId, command, run }) {
  const session = await readSourceSession({ command, run, sessionId, workspaceId });
  if (!session) return undefined;
  const decision = classifySourceSession(session, { source, conversationId }, { includeExited: false });
  if (decision.outcome === "restore" && decision.requireHostAbsent) return { conversationId: decision.conversationId };
  return decision.reason === "no_conversation_id" ? { conversationId: null } : undefined;
}

/** The client owns the name; the backend supplies the source. This does not admit an operation. */
export async function collectManagedRehostPreview({
  opts, registry, agentId: durableAgentId, resolveBackend, requestBackend, command, run,
}) {
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
  const sourceSessionId = binding.sessionId;
  const sourceWorkspaceId = source.runtimeWorkspaceId;
  const held = await heldManagedRehost({ sessionId: sourceSessionId, workspaceId: sourceWorkspaceId, command, run });
  if (held?.unconfirmed) {
    return failure({ code: "rehost_source_operation_unconfirmed",
      message: `Hmux already holds a restart for this Agent's source (operation ${held.unconfirmed.join(", ")}) ` +
        "that this command cannot continue exactly. Nothing was started or published. Inspect it with " +
        `dure hmux rehost status --operation-id ${held.unconfirmed[0]} and dure runtime get ${agentId}; ` +
        "do not start another operation." }, { agentId, observation });
  }
  // A held operation already carries its own inputs. Otherwise a Host that is
  // gone, as after a reboot, cannot report its conversation, so the restart
  // carries the recorded one behind the native Host-absence fence.
  const hostAbsent = held ? undefined : await absentSourceHost({
    source, sessionId: sourceSessionId, workspaceId: sourceWorkspaceId,
    conversationId: binding.providerConversationId ?? observation.receipt?.providerConversationRef ?? null,
    command, run,
  });
  if (hostAbsent && !hostAbsent.conversationId) {
    return failure({ code: "rehost_conversation_unknown",
      message: "This Agent's Hmux Host is gone, for example after a reboot, and no provider conversation ID was " +
        "saved, so it cannot be resumed exactly. Nothing was started. Open its pane to choose a conversation, or " +
        "start one with dure runs resume --conversation ID --provider ID." }, { agentId, observation });
  }
  if (hostAbsent && !await supportsHostAbsentStart({ command, run })) {
    return failure({ code: "rehost_runtime_update_required",
      message: "This Agent's Hmux Host is gone, and this Hmux runtime cannot prove that before replacing it. " +
        "Update Dure and retry; nothing was started." }, { agentId, observation });
  }
  const operationId = held?.operationId ??
    (hostAbsent ? hostAbsentOperationId({ source, sessionId: sourceSessionId, workspaceId: sourceWorkspaceId }) : randomUUID());
  const identity = [sourceSessionId, "--workspace", sourceWorkspaceId, "--operation-id", operationId];
  const retry = ["hmux", "rehost", "retry", ...identity, "--confirm-restart", "--json"];
  return {
    ...base, ok: true, state: "preview", agentId, backend: report.backend, observation,
    continuation: {
      operationId, sourceSessionId, sourceWorkspaceId,
      ...(hostAbsent ? { sourceHost: "absent", expectedConversationId: hostAbsent.conversationId } : {}),
      // Continuing a held operation never admits another one. The Host-absent
      // inputs are not hmux rehost start options; resume derives the same operation.
      start: held ? [...retry] : hostAbsent
        ? ["runs", "resume", agentId, "--confirm-restart", "--backend", backend.profile.id, "--json"]
        : ["hmux", "rehost", "start", ...identity, "--confirm-restart", "--json"],
      retry,
      status: ["hmux", "rehost", "status", ...identity, "--json"],
      publish: ["hmux", "rehost", "publish", agentId, "--from-session", ...identity,
        "--backend", backend.profile.id, "--json"],
      ...(held ? {
        retained: held,
        finish: managedRehostFinishCommand({ agentId, operationId, sourceSessionId, sourceWorkspaceId,
          backendId: backend.profile.id }),
      } : {}),
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
  const held = continuation.retained;
  return [
    wake
      ? "The backend owns wake and binding publication. Retain this exact operation, revision and request key."
      : restart
        ? "This Agent is stopped. The backend restarts it with its retained conversation through the app's transition. Retain this exact revision and request key."
        : held?.nativeState === "running"
          ? `Hmux is still applying a restart of this Agent (operation ${held.operationId}). Finish waits for it and publishes it once; do not start another operation.`
          : held
            ? `Hmux already restarted this Agent (operation ${held.operationId}), but its binding is not published yet. Finish publishes it once without restarting again.`
            : continuation.sourceHost === "absent"
              ? `This Agent's Hmux Host is gone, for example after a reboot. The restart starts a replacement on conversation ${continuation.expectedConversationId} once Hmux proves the old Host is gone; it never contacts that Host.`
              : "Retain these exact commands for this attempt; another name request proposes a different operation.",
    ...(continuation.finish ? [`Finish: ${rehostCommandLine(continuation.finish)}`] : []),
    // A held operation's start is its retry; print it once.
    ...(held ? [] : [`${wake ? "Wake" : restart ? "Restart" : "Start"}: ${rehostCommandLine(continuation.start)}`]),
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

export async function runManagedRehostPreview(opts, registryPath, resolveBackend, command) {
  const report = await collectManagedRehostPreview({
    opts, registry: loadSessionClientProjection({ registryPath }), resolveBackend, command,
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
