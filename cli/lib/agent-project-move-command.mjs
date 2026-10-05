import { randomUUID } from "node:crypto";
import { backendRequestFailure } from "./backend-request-failure.mjs";
import { isDureDomainIdV1 } from "./contracts/protocol-identity.mjs";
import { rehostCommandLine } from "./managed-rehost-preview.mjs";

function validPlan(plan, agentId, projectId) {
  const move = plan?.workspaceMove;
  return plan?.schemaVersion === 1 && plan.source?.agentId === agentId &&
    Number.isSafeInteger(plan.source.revision) && plan.source.revision > 0 &&
    isDureDomainIdV1(plan.operationId) && isDureDomainIdV1(plan.idempotencyKey) &&
    plan.source.providerId === "codex" && plan.targetInteractionProfile === "native_cli" &&
    typeof plan.providerConversationRef === "string" && plan.providerConversationRef.length > 0 &&
    move?.sourceAgent?.agentId === agentId && move.targetProject?.projectId === projectId &&
    move.targetWorkspace?.projectId === projectId && isDureDomainIdV1(move.targetWorkspace.workspaceId) &&
    typeof move.targetWorkspace.rootPath === "string" && move.targetWorkspace.rootPath.length > 0;
}

/** The backend previews and journals the move. This adapter carries the exact
 * reviewed plan on retry; neither run provenance nor pane state is rewritten. */
export async function collectAgentProjectMove({ agentId, projectId, movePlan, confirmRestart, backend, requestBackend }) {
  const base = { agentId, projectId, execution: "not_requested" };
  let prepared;
  try {
    let plan;
    if (movePlan) {
      if (!confirmRestart || movePlan.length > 32768 || !/^[A-Za-z0-9_-]+$/.test(movePlan)) {
        throw Object.assign(new Error("Apply requires the exact preview plan and --confirm-restart."), { code: "project_move_plan_invalid" });
      }
      const envelope = JSON.parse(Buffer.from(movePlan, "base64url").toString("utf8"));
      if (envelope.backendId !== backend.profile.id) throw Object.assign(new Error("Keep the owning backend from preview."), { code: "project_move_backend_changed" });
      plan = envelope.plan;
    } else {
      if (confirmRestart) throw Object.assign(new Error("Preview first, then use its exact Apply command."), { code: "project_move_preview_required" });
      const { result } = await requestBackend(backend.profile, {
        operation: "agent_runtime.project_move.preview.v1", requiredCapabilities: ["agent_runtime.project_move.preview.v1", "agent_runtime.project_move.apply.v1"],
        body: { schemaVersion: 1, agentId, projectId, idempotencyKey: randomUUID() },
      }, backend.transportOptions);
      if (result?.schemaVersion !== 1 || result.requiresRestartConfirmation !== true) throw Object.assign(new Error("Invalid move preview."), { code: "project_move_response_invalid" });
      plan = result.plan;
    }
    if (!validPlan(plan, agentId, projectId)) throw Object.assign(new Error("Invalid move plan."), { code: "project_move_plan_invalid" });
    const encoded = Buffer.from(JSON.stringify({ backendId: backend.profile.id, plan })).toString("base64url");
    const apply = ["runs", "move", agentId, "--project", projectId, "--move-plan", encoded, "--confirm-restart", "--backend", backend.profile.id, "--json"];
    prepared = { ...base, ok: true, state: "preview", plan, continuation: {
      apply, retry: [...apply], rollback: ["runtime", "switch", agentId, "terminal", "--expected-revision", String(plan.source.revision),
        "--idempotency-key", `rollback-${plan.idempotencyKey}`, "--backend", backend.profile.id, "--json"], status: ["runtime", "get", agentId, "--backend", backend.profile.id, "--json"],
    } };
    if (!confirmRestart) return prepared;
    const { result } = await requestBackend(backend.profile, {
      requestId: plan.idempotencyKey, operation: "agent_runtime.project_move.apply.v1",
      requiredCapabilities: ["agent_runtime.project_move.apply.v1"],
      body: { schemaVersion: 1, plan, confirmRestart: true },
    }, backend.transportOptions);
    const receipt = result?.receipt;
    if (result?.schemaVersion !== 1 || receipt?.agentId !== agentId ||
        receipt.providerConversationRef !== plan.providerConversationRef ||
        receipt.authority?.authority?.runtimeWorkspaceId !== plan.workspaceMove.targetWorkspace.workspaceId) {
      throw Object.assign(new Error("Inspect the retained status command; the move was not confirmed."), { code: "project_move_receipt_mismatch" });
    }
    return { ...prepared, state: "completed", execution: "completed", result };
  } catch (error) {
    return { ...(prepared ?? base), ok: false, state: prepared && confirmRestart ? "unconfirmed" : "refused",
      execution: prepared && confirmRestart ? "unconfirmed" : "not_requested",
      error: backendRequestFailure(error, backend.profile) };
  }
}

export function formatAgentProjectMove(report) {
  const move = report.plan?.workspaceMove;
  return [
    `${report.agentId}: project move ${report.state}`,
    ...(move ? [`From: ${move.sourceWorkspace.projectId} — ${move.sourceWorkspace.rootPath}`,
      `To: ${move.targetProject.projectId} — ${move.targetWorkspace.rootPath}`,
      `Conversation: ${report.plan.providerConversationRef}`, "Project files are preserved. This resumes the stopped provider in the destination folder."] : []),
    ...(report.error ? [`${report.error.remoteCode ?? report.error.code}: ${report.error.message ?? "Move refused"}`] : []),
    ...(report.continuation ? [`Apply/retry: ${rehostCommandLine(report.continuation.apply)}`,
      `Status: ${rehostCommandLine(report.continuation.status)}`,
      `If status reports repair_required, resume in the source folder: ${rehostCommandLine(report.continuation.rollback)}`,
      "After response loss, inspect status and retain this exact plan; do not create another move."] : []),
  ].join("\n");
}
