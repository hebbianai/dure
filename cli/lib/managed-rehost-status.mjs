import { runBoundedCommand } from "./bounded-command.mjs";
import { MANAGED_REHOST_SOURCE_GUIDANCE, managedRehostIdentity, matchesManagedRehostSource } from "./managed-rehost-identity.mjs";

export const REHOST_STATUS_HELP =
  "dure hmux rehost status [<original-session-id> --workspace ID] --operation-id ID [--json]";

/** Observe an exact local operation. Reconciliation and pane repair are commands, not reads. */
export async function collectManagedRehostStatus({
  sessionId,
  workspaceId,
  operationId,
  command,
  run = runBoundedCommand,
}) {
  const failure = (code, message) => ({
    ok: false,
    operationId,
    error: { code, message },
  });
  const identity = managedRehostIdentity({ sessionId, workspaceId, operationId });
  if (!identity) {
    return failure("rehost_status_request_invalid", REHOST_STATUS_HELP);
  }
  const response = await run(
    [
      command,
      "managed-rehost-resolve",
      ...identity.args,
      "--json",
    ],
    { timeoutMs: 5_000, maxCaptureBytes: 1024 * 1024 },
  );
  if (response.kind !== "success") {
    return failure(
      `rehost_status_${response.kind}`,
      `Operation outcome is unknown; no recovery was executed. Retry this status command when Hmux is available; do not submit a new operation. ${identity.source ? "" : `${MANAGED_REHOST_SOURCE_GUIDANCE}\n`}${(response.stderr || response.message || "").trim()}`,
    );
  }
  let result;
  try {
    result = JSON.parse(response.stdout);
  } catch {
    return failure(
      "rehost_status_response_invalid",
      "Hmux returned an unreadable observation; no recovery was executed.",
    );
  }
  const source =
    result?.state === "resolved" ? result.sourceGeneration : result?.source;
  const exactResult =
    result?.state === "resolved"
      ? Array.isArray(result.operationIds) &&
        result.operationIds.length === 1 &&
        result.operationIds[0] === operationId &&
        typeof result.currentGeneration?.sessionId === "string" &&
        typeof result.currentGeneration?.workspaceId === "string"
      : (result?.state === "not_found" && identity.source !== null) ||
        (result?.state === "retry_required" &&
          result.operationId === operationId);
  if (
    result?.schema !== "hmux-managed-rehost-resolution-v1" ||
    result.schemaVersion !== 1 ||
    !matchesManagedRehostSource(identity, source) ||
    !exactResult
  ) {
    return failure(
      "rehost_status_response_invalid",
      "Hmux did not return this exact operation observation; no recovery was executed.",
    );
  }
  return { ok: true, operationId, result };
}

export function formatManagedRehostStatus(report) {
  if (!report.ok) return `${report.error.code}: ${report.error.message}`;
  const { result, operationId } = report;
  if (result.state === "resolved") {
    return `${operationId}: completed (${result.sourceGeneration.sessionId} -> ${result.currentGeneration.sessionId})\nThis is the recorded operation result, not current process liveness. No pane was changed.`;
  }
  if (result.state === "retry_required") {
    return `${operationId}: pending; no durable completion is available. No recovery was executed.`;
  }
  return `${operationId}: no record was found for this exact source. This does not prove execution failed. No recovery was executed.`;
}

export async function runManagedRehostStatus(opts, command) {
  const unsupported =
    ![2, 3].includes(opts.rest.length) ||
    opts.backend !== undefined ||
    opts.confirmRestart ||
    opts.fresh ||
    opts.permissionMode !== undefined ||
    opts.existingSessionId !== undefined ||
    opts.conversationId !== undefined;
  const report = unsupported
    ? {
        ok: false,
        error: {
          code: "rehost_status_request_invalid",
          message: `${REHOST_STATUS_HELP}\nRead-only local observation; backend routing and mutation options are not supported.`,
        },
      }
    : await collectManagedRehostStatus({
        sessionId: opts.rest[2],
        workspaceId: opts.workspace,
        operationId: opts.operationId,
        command,
      });
  const output = opts.json
    ? JSON.stringify(report.ok ? report.result : report)
    : formatManagedRehostStatus(report);
  (report.ok ? process.stdout : process.stderr).write(`${output}\n`);
  if (!report.ok) process.exitCode = 1;
}
