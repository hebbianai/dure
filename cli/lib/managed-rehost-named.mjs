import { loadSessionClientProjection } from "./client-registry.mjs";
import { collectManagedRehostCommand } from "./managed-rehost-command.mjs";
import { collectManagedRehostPreview, formatManagedRecoveryCommands, formatNameCandidates } from "./managed-rehost-preview.mjs";
import { collectManagedRehostPublication } from "./managed-rehost-publication.mjs";
import { collectAgentRuntimeCommand } from "./agent-runtime-command.mjs";
import { ManagedRuntimeRecoveryIncompleteError, wakeManagedRuntime } from "./managed-runtime-recovery.mjs";

export const MANAGED_REHOST_RUNNING_GUIDANCE =
  "Hmux is still applying this rehost; nothing new was submitted. Check Status until it reports completed, then run Publish once. Do not start another operation.";

/** Still applying is neither finished nor failed (sysexits EX_TEMPFAIL), so a
 * caller that checks only the exit status cannot act on an unfinished restart. */
export const MANAGED_REHOST_RUNNING_EXIT_CODE = 75;

/** A restart is finished only after its native rehost and its binding publication. */
export function managedRecoveryExitCode(report, failureCode) {
  if (report.ok) return 0;
  return report.state === "running" ? MANAGED_REHOST_RUNNING_EXIT_CODE : failureCode;
}

/** Compose the existing owners once; publication failure never repeats native execution. */
export async function collectManagedRehostNamed({
  opts, registry, agentId, resolveBackend, requestBackend, command, run, settle,
}) {
  let backend;
  const prepared = await collectManagedRehostPreview({
    opts, registry, agentId, requestBackend,
    resolveBackend: async () => {
      backend = await resolveBackend();
      return backend;
    },
  });
  if (!prepared.ok) return { ...prepared, publication: "not_requested" };
  if (prepared.continuation.kind === "runtime_restart") {
    if (!opts.confirmRestart) return { ...prepared, publication: "not_requested" };
    const { targetInteractionProfile, expectedSourceRevision, requestId } = prepared.continuation;
    const report = await collectAgentRuntimeCommand({
      args: ["switch", prepared.agentId, targetInteractionProfile === "native_cli" ? "terminal" : "chat"],
      expectedRevision: expectedSourceRevision, requestId,
      resolveBackend: async () => backend, requestBackend,
    });
    const receipt = report.ok ? report.result.receipt : undefined;
    if (!receipt || receipt.authority?.interactionProfile !== targetInteractionProfile ||
        receipt.selectionRevision <= expectedSourceRevision) {
      return { ...prepared, ok: false, state: "unknown", backendExecution: "unconfirmed", publication: "unconfirmed",
        error: report.ok ? { code: "rehost_restart_unconfirmed",
          message: "The backend did not confirm the restarted runtime. Inspect with the retained status command before retrying the original request." }
          : report.error };
    }
    return { ...prepared, state: "completed", backendExecution: "completed", publication: "published",
      conversationId: receipt.providerConversationRef ?? null, result: report.result };
  }
  if (prepared.continuation.kind === "runtime_wake") {
    if (!opts.confirmRestart) return { ...prepared, publication: "not_requested" };
    const { operationId, expectedJournalRevision, requestId } = prepared.continuation;
    try {
      const result = await wakeManagedRuntime({ ...prepared.observation, state: "dormant" }, {
        wake: async () => {
          const report = await collectAgentRuntimeCommand({
            args: ["wake", prepared.agentId], operationId,
            expectedRevision: expectedJournalRevision, requestId,
            resolveBackend: async () => backend, requestBackend,
          });
          if (!report.ok) throw report.error;
          return report.result;
        },
      });
      return { ...prepared, state: "completed", backendExecution: "completed",
        publication: "published", result };
    } catch (error) {
      if (error instanceof ManagedRuntimeRecoveryIncompleteError) {
        return { ...prepared, ok: false, state: error.observation.state,
          backendExecution: "unconfirmed", publication: "unconfirmed", result: error.observation,
          error: { code: "rehost_wake_incomplete",
            message: "The backend has not confirmed a stable resumed runtime. Inspect with the retained status command before retrying the original wake request." } };
      }
      return { ...prepared, ok: false, state: "unknown", backendExecution: "unknown",
        publication: "unconfirmed", error };
    }
  }
  const { operationId, sourceSessionId, sourceWorkspaceId } = prepared.continuation;
  const execution = await collectManagedRehostCommand({
    action: "start", sessionId: sourceSessionId, workspaceId: sourceWorkspaceId,
    operationId, confirmRestart: opts.confirmRestart, command, run, settle,
  });
  if (!execution.ok) {
    return { ...prepared, ok: false, state: "unknown", nativeExecution: "unknown",
      publication: "not_requested", error: execution.error };
  }
  if (execution.state === "running") {
    // Publication needs the native completion; the retained commands finish it.
    // Until then the Agent's binding still names the retired source, so this is
    // not a finished restart.
    return { ...prepared, ok: false, state: "running", nativeExecution: "running",
      publication: "not_requested", nativeObservation: execution.observation,
      error: { code: "rehost_still_running",
        message: "The restart is not finished: Hmux is still applying the native rehost, and the Agent binding is not published yet." } };
  }
  const publication = await collectManagedRehostPublication({
    opts: {
      rest: ["rehost", "publish", prepared.agentId], operationId,
      fromSession: sourceSessionId, workspace: sourceWorkspaceId,
    },
    resolveBackend: async () => backend, requestBackend,
  });
  // The native rehost is complete either way; the restart is finished only
  // once the Agent binding names its successor.
  return {
    ...prepared, ok: publication.ok, state: "completed", nativeExecution: "completed", receipt: execution.receipt,
    publication: publication.publication,
    ...(publication.ok
      ? { publicationResult: publication.result }
      : { publicationError: publication.error, error: publication.error }),
  };
}

export async function runManagedRehostNamed(opts, registryPath, resolveBackend, command) {
  const report = await collectManagedRehostNamed({
    opts, registry: loadSessionClientProjection({ registryPath }), resolveBackend, command,
  });
  const output = opts.json ? JSON.stringify(report) : [
    report.state === "running"
      ? `${report.agentId}: rehost still running\n${MANAGED_REHOST_RUNNING_GUIDANCE}`
      : report.ok
        ? report.continuation?.kind?.startsWith("runtime_")
          ? `${report.agentId}: ${report.continuation.kind === "runtime_wake" ? "wake" : "restart"} ${report.state}` +
            (report.conversationId ? ` (conversation ${report.conversationId})` : "")
          : `${report.agentId}: rehost completed (${report.receipt.sourceStopReceipt.sessionId} -> ${report.receipt.replacementReceipt.sessionId})`
        : [`${report.error.remoteCode ?? report.error.code}: ${report.error.message}`,
          ...formatNameCandidates(report.error.candidates)].join("\n"),
    `${report.continuation?.kind?.startsWith("runtime_") ? `Backend execution: ${report.backendExecution ?? "not_requested"}` : `Native execution: ${report.nativeExecution}`}. Binding publication: ${report.publication}.`,
    ...(report.publicationError
      ? [`Publication is unconfirmed: ${report.publicationError.remoteCode ?? report.publicationError.code}. Retry publication only; the native rehost already completed.`]
      : []),
    ...formatManagedRecoveryCommands(report.continuation),
  ].join("\n");
  (report.ok || report.state === "running" ? process.stdout : process.stderr).write(`${output}\n`);
  process.exitCode = managedRecoveryExitCode(report, 1);
}
