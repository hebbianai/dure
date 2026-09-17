import { randomUUID } from "node:crypto";
import { collectAgentRuntimeCommand } from "./agent-runtime-command.mjs";
import { backendRequestFailure } from "./backend-request-failure.mjs";
import { loadSessionClientProjection, matchingAgents } from "./client-registry.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";

/** Initial same-launch requests share the native path; advanced modes retain their owner. */
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
export async function collectManagedRehostPreview({ opts, registry, resolveBackend, requestBackend }) {
  const name = (opts.name || opts.rest[1]).trim();
  const base = { schemaVersion: 1, name, nativeExecution: "not_requested" };
  const failure = (error, details = {}) => ({ ...base, ok: false, error, ...details });
  if (registry.state !== "available") {
    return failure({ code: "rehost_name_projection_unavailable",
      message: "The complete client name projection is unavailable. Inspect an exact Agent with dure runtime get <agent-id>." });
  }
  const matches = matchingAgents(registry, name);
  if (matches.length !== 1 || !isDureDomainIdV1(matches[0]?.id)) {
    return failure({ code: "rehost_name_not_unique",
      message: "Select one exact Agent name or project/name from dure ls." });
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
  const selected = observation.receipt?.authority;
  const source = selected?.authority;
  const binding = source?.binding;
  if (observation.state !== "stable" || selected?.interactionProfile !== "native_cli" ||
      binding?.runtimeKindId !== "runtime.hmux" || binding.agentId !== agentId ||
      ![binding.sessionId, source.runtimeWorkspaceId].every((id) => typeof id === "string" && id.length > 0)) {
    return failure({ code: "rehost_native_source_unavailable",
      message: "This observation does not provide a native source. Inspect the Agent's current runtime before choosing recovery." },
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

export async function runManagedRehostPreview(opts, registryPath, resolveBackend) {
  const report = await collectManagedRehostPreview({
    opts, registry: loadSessionClientProjection({ registryPath }), resolveBackend,
  });
  const output = opts.json ? JSON.stringify(report) : report.ok
    ? [
      `Preview: ${report.agentId} (${report.continuation.sourceSessionId})`,
      "Nothing was started or reserved. This is not proof of liveness or a recoverable conversation.",
      "Retain these commands for this attempt; another name preview proposes a different operation.",
      "Run native commands in this backend's local Hmux context. After successful start, publish the binding.",
      `Start: ${rehostCommandLine(report.continuation.start)}`,
      `Status after uncertain execution: ${rehostCommandLine(report.continuation.status)}`,
      `Publish completion: ${rehostCommandLine(report.continuation.publish)}`,
    ].join("\n")
    : `${report.error.remoteCode ?? report.error.code}: ${report.error.message}\nNo runtime execution was requested.`;
  (report.ok ? process.stdout : process.stderr).write(`${output}\n`);
  if (!report.ok) process.exitCode = 1;
}
