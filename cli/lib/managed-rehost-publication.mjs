import { randomUUID } from "node:crypto";
import { backendRequestFailure } from "./backend-request-failure.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { parseAgentRuntimeTransitionEnvelope } from "./contracts/agent-runtime.mjs";

export const REHOST_PUBLICATION_HELP =
  "dure hmux rehost publish <agent-id> --from-session <original-session-id> --workspace ID --operation-id ID [--backend ID] [--json]";

/** Publish native completion only. The backend owns receipt lookup and the Agent CAS. */
export async function collectManagedRehostPublication({
  opts, resolveBackend, requestBackend = performBackendProfileRequest,
}) {
  const agentId = opts.rest[2];
  const operationId = opts.operationId;
  const base = {
    schemaVersion: 1, agentId, operationId, nativeExecution: "not_requested",
  };
  const failure = (error) => ({ ...base, ok: false, publication: "unconfirmed", error });
  if (
    opts.rest.length !== 3 ||
    ![agentId, operationId, opts.fromSession, opts.workspace].every(
      (id) => typeof id === "string" && id.trim(),
    ) ||
    opts.confirmRestart || opts.fresh || opts.name || opts.agent ||
    opts.permissionMode !== undefined || opts.existingSessionId !== undefined ||
    opts.conversationId !== undefined || opts.credentialReference !== undefined ||
    opts.credentialGeneration !== undefined || opts.targetPanelId !== undefined ||
    opts.provider !== undefined || opts.cwd !== undefined
  ) {
    return failure({ code: "rehost_publication_request_invalid", message: REHOST_PUBLICATION_HELP });
  }
  let backend;
  try {
    backend = await resolveBackend();
    if (!backend?.profile || backend.error) {
      return failure(backendRequestFailure(backend?.error, backend?.profile));
    }
    const operation = "agent_runtime.native_rehost.reconcile";
    const response = await requestBackend(backend.profile, {
      requestId: randomUUID(), operation, requiredCapabilities: [operation],
      body: {
        schemaVersion: 1, agentId, operationId,
        sourceSessionId: opts.fromSession, sourceWorkspaceId: opts.workspace,
      },
    }, backend.transportOptions);
    const result = parseAgentRuntimeTransitionEnvelope(response.result, agentId);
    if (!result) return failure({ code: "rehost_publication_response_invalid" });
    return { ...base, ok: true, publication: "published", backend: response.backend, result };
  } catch (error) {
    return failure(backendRequestFailure(error, backend?.profile));
  }
}

export async function runManagedRehostPublication(opts, resolveBackend) {
  const report = await collectManagedRehostPublication({ opts, resolveBackend });
  const inspect = `dure runtime get ${report.agentId ?? "<agent-id>"}${opts.backend ? ` --backend ${opts.backend}` : ""}`;
  const recovery = report.error?.remoteCode === "agent_runtime_native_rehost_explicit_recovery_required"
    ? "Another failed replacement needs explicit runtime recovery; publication will not stop it."
    : "Inspect the Agent before retrying this same publish command.";
  const output = opts.json ? JSON.stringify(report) : report.ok
    ? `${report.agentId}: published ${report.operationId} (binding revision ${report.result.receipt.selectionRevision})\nNo runtime execution or pane change was requested.`
    : `${report.error.remoteCode ?? report.error.code}: ${report.error.message ?? "Publication is unconfirmed"}\nNative execution was not requested. ${recovery}\nInspect: ${inspect}`;
  (report.ok ? process.stdout : process.stderr).write(`${output}\n`);
  if (!report.ok) process.exitCode = 1;
}
