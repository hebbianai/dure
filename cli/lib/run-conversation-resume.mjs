import { randomUUID } from "node:crypto";
import { collectAgentSpawnQuery } from "./agent-spawn-query.mjs";
import { defaultAgentRunName, resolveAgentRunAccount } from "./agent-run.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { isDureProviderConversationRefV1 } from "./contracts/protocol-identity.mjs";
import { rehostCommandLine } from "./managed-rehost-preview.mjs";
import { runReceiptSummary } from "./run-presentation.mjs";

/** The Hmux create refusal for a conversation another managed session holds. */
export const CONVERSATION_WRITER_CONFLICT = "hmux_managed_conversation_writer_conflict";

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

/** Start a new Agent on an exact provider conversation that no Agent the
 * backend holds can resume. This composes the backend's existing Run creation
 * unchanged: the conversation reaches the provider's resume launch and the Hmux
 * create as its single-writer identity, so a conversation another live session
 * holds is refused there and that session is never stopped. The terminal
 * surface is pinned because only the Hmux create takes that reservation. */
export async function collectRunConversationResume({
  conversationId, providerId, projectId, projectPath, agentName, account, idempotencyKey,
  confirmRestart, backend, descriptor, requestBackend = performBackendProfileRequest,
  resolveAccount = resolveAgentRunAccount,
}) {
  const requestId = idempotencyKey ?? `resume-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const name = agentName ?? defaultAgentRunName(`${providerId}-resume`, requestId);
  const base = { providerId, conversationId, agentName: name, execution: "not_requested" };
  const failure = (error, details = {}) => ({ ...base, ok: false, state: "unavailable", ...details, error });
  if (!isDureProviderConversationRefV1(conversationId) || !TOKEN.test(requestId)) {
    return failure({ code: "runs_request_invalid", message: "The conversation ID or retry key is not a valid identifier." });
  }
  let executionProfile;
  try {
    executionProfile = await resolveAccount({ descriptor, providerId, backendProfileId: backend.profile.id,
      account, backend, requestBackend });
  } catch (error) {
    return failure({ code: error?.code ?? "agent_launch_account_unavailable", message: error?.message });
  }
  const spawn = (action, extra) => collectAgentSpawnQuery({ action, backend, requestBackend, ...extra });
  const preview = await spawn("preview", {
    projectId, projectPath, providerId, agentName: name, worktree: { kind: "project_root" },
    executionProfile, interactionPreference: "native_cli", providerConversationRef: conversationId,
    idempotencyKey: requestId,
  });
  if (preview.kind === "dure.agent_spawn.error" || !preview.receipt) {
    return failure(preview.error ?? { code: "agent_spawn_receipt_unavailable" });
  }
  const planned = preview.receipt;
  const backendId = backend.profile.id;
  // The Apply names the resolved project and account, so a retry cannot
  // follow a changed directory or app account selection to another plan.
  const resolvedProject = planned.plan.request.projectId;
  const resolvedAccount = executionProfile.kind === "credential_reference" ? executionProfile.reference_id : "default";
  const prepared = {
    ...base, ok: true, state: "preview", agentId: planned.plan.agentId, operationId: planned.operationId,
    projectId: resolvedProject, account: resolvedAccount,
    continuation: {
      requestId,
      apply: ["runs", "resume", "--conversation", conversationId, "--provider", providerId,
        "--project", resolvedProject, "--name", name, "--account", resolvedAccount,
        "--idempotency-key", requestId, "--confirm-restart", "--backend", backendId, "--json"],
      status: ["spawn", "status", "--operation-id", planned.operationId, "--backend", backendId, "--json"],
    },
  };
  if (!confirmRestart) return prepared;
  // A replayed key returns its durable plan; a lost successful response is
  // reported from that receipt instead of launching again.
  const report = planned.state === "succeeded" ? preview : await spawn("apply", {
    operationId: planned.operationId, planToken: planned.plan.planToken,
    expectedLastSequence: planned.lastSequence,
  });
  if (report.kind === "dure.agent_spawn.error" || !report.receipt) {
    return { ...prepared, ok: false, state: "unconfirmed", execution: "unconfirmed",
      error: report.error ?? { code: "agent_spawn_receipt_unavailable" } };
  }
  const receipt = report.receipt;
  const summary = runReceiptSummary(report);
  if (receipt.state === "succeeded") {
    return { ...prepared, state: "completed", execution: "completed", sessionId: summary.sessionId, receipt };
  }
  const code = receipt.terminalCode ?? receipt.recovery?.error_code ?? "agent_spawn_incomplete";
  if (code === CONVERSATION_WRITER_CONFLICT) {
    return { ...prepared, ok: false, state: "refused", execution: "refused", receipt, error: { code,
      message: "Another session still holds this conversation, so nothing started and that session was " +
        "left running. Continue it with its own Agent (dure ls), or run this Apply again after it exits." } };
  }
  return { ...prepared, ok: false, state: "unconfirmed", execution: receipt.state, receipt,
    error: { code, message: `The new Agent's launch is ${receipt.state}. Inspect status before retrying this Apply.` } };
}

export function formatRunConversationResume(report) {
  const head = `${report.providerId} conversation ${report.conversationId}: ${report.state}`;
  return [
    head,
    ...(report.agentId ? [`Agent: ${report.agentId} (${report.agentName}) in project ${report.projectId}`] : []),
    ...(report.state === "preview" ? [
      "Apply starts a new terminal Agent on this conversation in the project's root folder, with account " +
        `${report.account}. It refuses a conversation another session still holds and never stops that session.`,
    ] : []),
    ...(report.sessionId ? [`Session: ${report.sessionId}`, `Open: dure runs open ${report.agentId} --space <space-id>`] : []),
    ...(report.error ? [`${report.error.remoteCode ?? report.error.code}: ${report.error.message ?? "Resume failed"}`] : []),
    ...(report.continuation && report.state !== "completed" ? [
      `${report.state === "preview" ? "Apply" : "Retry"}: ${rehostCommandLine(report.continuation.apply)}`,
      `Status: ${rehostCommandLine(report.continuation.status)}`,
    ] : []),
  ].join("\n");
}
