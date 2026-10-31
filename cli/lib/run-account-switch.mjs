import { randomUUID } from "node:crypto";
import { collectAgentRuntimeCommand } from "./agent-runtime-command.mjs";
import { rehostCommandLine } from "./managed-rehost-preview.mjs";
import { readRegisteredAccountProfiles, registeredAccountUnavailableMessage } from "./registered-account-profiles.mjs";
import { agentRuntimeRestartableClosedSource, agentRuntimeSourceUnavailableReason } from "./contracts/agent-runtime.mjs";
import { isSourceBusyRefusal, refusalLabel, withSourceBusyGuidance } from "./runtime-source-busy.mjs";

/** Prepare an exact invocation of the existing UI/backend transition. This
 * adapter owns no credential registry, process replacement, or retry policy. */
export async function collectRunAccountSwitch({ run, observation, account, confirmRestart, backend, requestBackend }) {
  // A stopped close is restarted from its retained source with the selected
  // account; the backend resumes that source's conversation, as in the app.
  const closed = agentRuntimeRestartableClosedSource(observation);
  const source = closed ? undefined : observation.receipt;
  const mode = closed?.interactionProfile ?? source?.authority?.interactionProfile;
  const sourceRevision = closed?.selectionRevision ?? source?.selectionRevision;
  const base = { agentId: run.agentId, providerId: run.providerId, account,
    conversationId: closed ? null : source?.providerConversationRef, execution: "not_requested",
    ...(closed ? { source: "stopped" } : {}) };
  const failure = (code, message) => ({ ...base, ok: false, error: { code, message } });
  if (closed ? observation.projectionContext?.agent?.providerId !== run.providerId
    : observation.state !== "stable" || source.providerId !== run.providerId ||
      !["native_cli", "structured_protocol"].includes(mode) ||
      typeof source.providerConversationRef !== "string" || !source.providerConversationRef.trim()) {
    return failure("account_switch_source_unavailable", observation.state === "stable"
      ? "Account switching requires an exact provider conversation, and this runtime has none to preserve."
      : `Account switching requires a stable or stopped runtime. ${agentRuntimeSourceUnavailableReason(observation)}`);
  }
  let credentialGeneration;
  if (account !== "default") {
    const profiles = await readRegisteredAccountProfiles({ providerId: run.providerId, backend, requestBackend });
    if (!profiles) {
      return failure("account_switch_profiles_invalid", "The backend returned invalid credential profile handles.");
    }
    const matches = profiles.filter((profile) => profile.referenceId === account);
    if (matches.length !== 1) {
      return failure("account_switch_account_unavailable", registeredAccountUnavailableMessage({
        providerId: run.providerId, account, profiles, backendId: backend.profile.id }));
    }
    credentialGeneration = matches[0].credentialGeneration;
  }
  const requestId = randomUUID();
  const target = mode === "native_cli" ? "terminal" : "chat";
  const start = ["runtime", "switch", run.agentId, target, "--account", account,
    ...(credentialGeneration ? ["--credential-generation", credentialGeneration] : []),
    "--expected-revision", String(sourceRevision), "--idempotency-key", requestId,
    "--backend", backend.profile.id, "--json"];
  const prepared = { ...base, ok: true, state: "preview", continuation: {
    requestId, start, retry: [...start],
    status: ["runtime", "get", run.agentId, "--backend", backend.profile.id, "--json"],
  } };
  if (!confirmRestart) return prepared;
  const report = await collectAgentRuntimeCommand({
    args: ["switch", run.agentId, target], account, credentialGeneration,
    expectedRevision: sourceRevision, requestId,
    resolveBackend: async () => backend, requestBackend,
  });
  // Busy is refused before admission: nothing changed, and the same retry
  // command remains valid once the session is idle.
  if (isSourceBusyRefusal(report.error)) {
    return { ...prepared, ok: false, state: "refused", execution: "refused",
      error: withSourceBusyGuidance(report.error, run.providerId) };
  }
  if (!report.ok) return { ...prepared, ok: false, state: "unconfirmed", execution: "unconfirmed", error: report.error };
  const receipt = report.result.receipt;
  // The backend binds a stopped source's successor to that source's
  // conversation; the CLI cannot observe it before the restart.
  if (receipt.providerId !== run.providerId || (closed
    ? receipt.selectionRevision <= sourceRevision
    : receipt.providerConversationRef !== source.providerConversationRef)) {
    return { ...prepared, ok: false, state: "unconfirmed", execution: "unconfirmed",
      error: { code: "account_switch_receipt_mismatch", message: "Inspect the retained status command; the requested conversation was not confirmed." } };
  }
  return { ...prepared, state: "completed", execution: "completed",
    conversationId: receipt.providerConversationRef ?? null, result: report.result };
}

export function formatRunAccountSwitch(report) {
  return [
    `${report.agentId}: account ${report.account} (${report.state ?? "unavailable"})`,
    ...(report.source === "stopped" && report.state === "preview"
      ? ["This Agent is stopped. Apply restarts it with this account and its retained conversation."] : []),
    ...(report.state === "completed" && report.conversationId ? [`Conversation: ${report.conversationId}`] : []),
    ...(report.error ? [`${refusalLabel(report.error)}: ${report.error.message ?? "Account switch failed"}`] : []),
    ...(report.continuation ? [
      `${report.state === "preview" ? "Apply" : "Retry"}: ${rehostCommandLine(report.continuation.start)}`,
      `Status: ${rehostCommandLine(report.continuation.status)}`,
      report.state === "refused"
        ? "Retry this exact command once the session is idle; do not repeat a name-based switch."
        : "After an uncertain response, inspect status and retain the exact retry command; do not repeat a name-based switch.",
    ] : []),
  ].join("\n");
}
