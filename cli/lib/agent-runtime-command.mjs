import { randomUUID } from "node:crypto";
import { backendRequestFailure } from "./backend-request-failure.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { isDureBackendProfileIdV1 } from "./contracts/protocol-identity.mjs";
import {
  agentRuntimeHibernateBody,
  agentRuntimeIdleConfigureBody,
  agentRuntimeTransitionBody,
  agentRuntimeWakeBody,
  agentRuntimeWakeTarget,
  parseAgentRuntimeInspectionEnvelope,
  parseAgentRuntimeIdleInspection,
  parseRuntimeReclamation,
  parseAgentRuntimeTransitionEnvelope,
} from "./contracts/agent-runtime.mjs";

export const RUNTIME_HELP = `Usage:
  dure runtime idle [--backend ID] [--json]
  dure runtime idle set <milliseconds> --expected-revision N [--backend ID] [--json]
  dure runtime idle disable --expected-revision N [--backend ID] [--json]
  dure runtime get <agent-id> [--backend ID] [--json]
  dure runtime switch <agent-id> chat|terminal [--backend ID] [--json]
    [--idempotency-key KEY] [--deadline-ms MS]
  dure runtime hibernate <agent-id> --expected-revision N [--backend ID] [--json]
  dure runtime wake <agent-id> --operation-id ID --expected-revision N
    [--conversation-id ID] [--backend ID] [--json] [--idempotency-key KEY] [--deadline-ms MS]

Uses the backend directly; no open Dure window is required.
Idle shows retained observations for a bounded page, not a complete session census.
Journal outcomes cover hibernations among the latest 64 runtime transition admissions.
Confirmed source stops do not measure reclaimed memory or every auxiliary process.
Automatic hibernation defaults off. Idle set persists a backend policy across
restarts (1000..2592000000 milliseconds); idle disable persists an opt-out.
Use idle to read the policy revision before configuring. Host-measured idle time
survives policy changes; enabling can admit an already-idle source after fresh checks.
Legacy backend-observed intervals restart when the policy revision changes.
DURE_SESSION_IDLE_AFTER_MS seeds only a missing policy; saved settings take precedence.
Switch preserves the conversation and selected credential. A busy source is
retained; this command never discards active work. Failed stopped targets are
replaced through the same backend transition as the app.
Hibernate stops only a quiescent, resumable runtime; wake retains its conversation.
Wake --conversation-id checks the saved conversation before launch; it never selects another.
Use get to obtain the selection revision for hibernate, or the operation ID and
journal revision for wake. These commands do not enable automatic cleanup.
After response loss, inspect with get before taking another action. Reusing
--idempotency-key replays the original request, not a new replacement.`;

const PROFILES = { chat: "structured_protocol", terminal: "native_cli" };

/** A command is an intent plus a formatter. The service owns admission,
 * replacement, and replay; local and SSH use the same transport contract. */
export async function collectAgentRuntimeCommand({
  args,
  resolveBackend,
  requestId = randomUUID(),
  deadlineMs = 45_000,
  expectedRevision,
  operationId,
  conversationId,
  requestBackend = performBackendProfileRequest,
}) {
  const [action, agentId, target] = args;
  const idle = action === "idle";
  const idleConfigure = idle && args.length > 1;
  const idleBody = idleConfigure
    ? agentRuntimeIdleConfigureBody({ command: agentId, afterMs: target, expectedRevision })
    : undefined;
  const base = { schemaVersion: 1, action, ...(idle ? {} : { agentId }), requestId };
  const failure = (error) => ({ ...base, ok: false, error });
  const lifecycle = action === "hibernate" || action === "wake";
  const lifecycleBody = action === "hibernate"
    ? agentRuntimeHibernateBody({ agentId, expectedSourceRevision: expectedRevision })
    : action === "wake"
      ? agentRuntimeWakeBody({ agentId, operationId, expectedJournalRevision: expectedRevision,
          expectedProviderConversationRef: conversationId })
      : undefined;
  if (
    (!idle && !agentId) ||
    !(
      (idle && args.length === 1) ||
      (idleConfigure && idleBody && args.length === (agentId === "set" ? 3 : 2)) ||
      (action === "get" && args.length === 2) ||
      (action === "switch" &&
        args.length === 3 &&
        Object.hasOwn(PROFILES, target)) ||
      (lifecycle && args.length === 2 && lifecycleBody &&
        (action !== "hibernate" || operationId === undefined))
    ) ||
    (!lifecycle && (operationId !== undefined || (!idleConfigure && expectedRevision !== undefined))) ||
    (action !== "wake" && conversationId !== undefined) ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1
  ) {
    return failure({ code: "runtime_command_invalid", message: RUNTIME_HELP });
  }
  const backend = await resolveBackend();
  if (!backend?.profile || backend.error) {
    return failure(backendRequestFailure(backend?.error, backend?.profile));
  }
  if (isDureBackendProfileIdV1(backend.profile.id)) base.backendProfileId = backend.profile.id;
  const operation =
    idle ? `agent_runtime.idle.${idleConfigure ? "configure" : "inspect"}` : action === "get" ? "agent_runtime.projection.inspect" :
      action === "switch" ? "agent_runtime.transition" : `agent_runtime.${action}`;
  try {
    const response = await requestBackend(
      { ...backend.profile, deadlineMs },
      {
        requestId,
        operation,
        requiredCapabilities: [operation],
        body: action === "switch"
          ? agentRuntimeTransitionBody({
              agentId,
              targetInteractionProfile: PROFILES[target],
            })
          : idleBody ?? lifecycleBody ?? (idle ? { schemaVersion: 1 } : { schemaVersion: 1, agentId }),
      },
      { ...backend.transportOptions, deadlineMs },
    );
    const result = idle ? parseAgentRuntimeIdleInspection(response.result) : action !== "switch"
      ? parseAgentRuntimeInspectionEnvelope(response.result, agentId)
      : parseAgentRuntimeTransitionEnvelope(response.result, agentId);
    if (!result || (idleConfigure && (result.policyRevision !== expectedRevision + 1 ||
        result.configuration !== (idleBody.policy.mode === "enabled" ? "enabled" : "disabled") ||
        result.afterMs !== (idleBody.policy.afterMs ?? null)))) {
      return failure({ code: "runtime_response_invalid" });
    }
    return { ...base, ok: true, backend: response.backend, result };
  } catch (error) {
    return failure(backendRequestFailure(error, backend.profile));
  }
}

export function formatAgentRuntimeCommand(report) {
  const backendOption = report.backendProfileId ? ` --backend ${report.backendProfileId}` : "";
  if (!report.ok) {
    const code = report.error.remoteCode ?? report.error.code;
    return `${code}: ${report.error.message ?? "Runtime request failed"}\nRequest: ${report.requestId}\nInspect: dure runtime ${report.action === "idle" ? "idle" : `get ${report.agentId}`}${backendOption}`;
  }
  if (report.action === "idle") {
    const status = report.result;
    return [
      `Automatic session hibernation: ${status.configuration}${status.afterMs === null ? "" : ` (after ${status.afterMs} ms)`}`,
      `Policy revision: ${status.policyRevision ?? "unavailable"}`,
      `Observed: ${status.observedAtMs === null ? "not yet sampled" : new Date(status.observedAtMs).toISOString()}`,
      `Scope: ${status.partial ? "partial page" : "last scan page"} (${status.agents.length} agents)`,
      ...(status.reasonCode ? [`Reason: ${status.reasonCode}`] : []),
      ...status.agents.map((agent) => `${agent.agentId}: ${agent.state}${agent.reasonCode ? ` · ${agent.reasonCode}` : ""}${agent.observedIdleMs === null ? "" : ` · ${agent.observedIdleMs} ms observed idle`}`),
      ...formatReclamation(status.reclamation),
      `Request: ${report.requestId}`,
    ].join("\n");
  }
  const profile = report.result.receipt?.authority?.interactionProfile;
  const wakeTarget = agentRuntimeWakeTarget(report.result);
  return [
    `${report.agentId}: ${wakeTarget ? "dormant" : report.result.state ?? "stable"}${profile ? ` (${profile})` : ""}`,
    ...(report.result.stage ? [`Stage: ${report.result.stage}`] : []),
    ...(report.result.operationId
      ? [`Operation: ${report.result.operationId}`]
      : []),
    ...(report.result.receipt?.selectionRevision ? [`Selection revision: ${report.result.receipt.selectionRevision}`] : []),
    ...(report.result.journalRevision ? [`Journal revision: ${report.result.journalRevision}`] : []),
    ...(wakeTarget ? [`Wake: dure runtime wake ${report.agentId} --operation-id ${wakeTarget.operationId} --expected-revision ${wakeTarget.expectedJournalRevision}${backendOption}`] : []),
    `Request: ${report.requestId}`,
  ].join("\n");
}

function formatReclamation(value) {
  const evidence = parseRuntimeReclamation(value);
  if (!evidence || evidence.state !== "available") {
    return [`Source-stop outcomes: unavailable (${evidence?.reasonCode ?? "not supplied by producer"})`];
  }
  return [
    `Journal: ${evidence.entries.length} hibernation outcomes among ${evidence.scanned} latest runtime admissions${evidence.partial ? "; older admissions omitted" : ""}`,
    `Journal observed: ${new Date(evidence.observedAtMs).toISOString()}`,
    ...evidence.entries.map((entry) => `${entry.operationId}: source stop ${entry.stopState}; wake ${entry.wakeState} · ${entry.agentId} · revision ${entry.journalRevision} · ${entry.stage}${entry.reasonCode ? ` · ${entry.reasonCode}` : ""}`),
    "Memory bytes and auxiliary-process release: unmeasured",
  ];
}
