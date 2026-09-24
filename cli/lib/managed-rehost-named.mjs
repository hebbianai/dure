import { loadSessionClientProjection } from "./client-registry.mjs";
import { collectManagedRehostCommand } from "./managed-rehost-command.mjs";
import { collectManagedRehostPreview, rehostCommandLine } from "./managed-rehost-preview.mjs";
import { collectManagedRehostPublication } from "./managed-rehost-publication.mjs";

/** Compose the existing owners once; publication failure never repeats native execution. */
export async function collectManagedRehostNamed({
  opts, registry, agentId, resolveBackend, requestBackend, command, run,
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
  const { operationId, sourceSessionId, sourceWorkspaceId } = prepared.continuation;
  const execution = await collectManagedRehostCommand({
    action: "start", sessionId: sourceSessionId, workspaceId: sourceWorkspaceId,
    operationId, confirmRestart: opts.confirmRestart, command, run,
  });
  if (!execution.ok) {
    return { ...prepared, ok: false, state: "unknown", nativeExecution: "unknown",
      publication: "not_requested", error: execution.error };
  }
  const publication = await collectManagedRehostPublication({
    opts: {
      rest: ["rehost", "publish", prepared.agentId], operationId,
      fromSession: sourceSessionId, workspace: sourceWorkspaceId,
    },
    resolveBackend: async () => backend, requestBackend,
  });
  return {
    ...prepared, state: "completed", nativeExecution: "completed", receipt: execution.receipt,
    publication: publication.publication,
    ...(publication.ok
      ? { publicationResult: publication.result }
      : { publicationError: publication.error }),
  };
}

export async function runManagedRehostNamed(opts, registryPath, resolveBackend, command) {
  const report = await collectManagedRehostNamed({
    opts, registry: loadSessionClientProjection({ registryPath }), resolveBackend, command,
  });
  const output = opts.json ? JSON.stringify(report) : [
    report.ok
      ? `${report.agentId}: rehost completed (${report.receipt.sourceStopReceipt.sessionId} -> ${report.receipt.replacementReceipt.sessionId})`
      : `${report.error.remoteCode ?? report.error.code}: ${report.error.message}`,
    `Native execution: ${report.nativeExecution}. Binding publication: ${report.publication}.`,
    ...(report.publicationError
      ? [`Publication is unconfirmed: ${report.publicationError.remoteCode ?? report.publicationError.code}. Retry publication only; the native rehost already completed.`]
      : []),
    ...(report.continuation ? [
      "Retain these exact commands. Repeating the name request starts a new operation.",
      `Status: ${rehostCommandLine(report.continuation.status)}`,
      `Retry the original operation: ${rehostCommandLine(report.continuation.retry)}`,
      `Publish completion: ${rehostCommandLine(report.continuation.publish)}`,
    ] : []),
  ].join("\n");
  (report.ok ? process.stdout : process.stderr).write(`${output}\n`);
  if (!report.ok) process.exitCode = 1;
}
