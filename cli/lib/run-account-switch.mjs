import { randomUUID } from "node:crypto";
import { collectAgentRuntimeCommand } from "./agent-runtime-command.mjs";
import { rehostCommandLine } from "./managed-rehost-preview.mjs";
import { readRegisteredAccountProfiles, registeredAccountUnavailableMessage } from "./registered-account-profiles.mjs";

/** Prepare an exact invocation of the existing UI/backend transition. This
 * adapter owns no credential registry, process replacement, or retry policy. */
export async function collectRunAccountSwitch({ run, observation, account, confirmRestart, backend, requestBackend }) {
  const source = observation.receipt;
  const mode = source?.authority?.interactionProfile;
  const base = { agentId: run.agentId, providerId: run.providerId, account,
    conversationId: source?.providerConversationRef, execution: "not_requested" };
  const failure = (code, message) => ({ ...base, ok: false, error: { code, message } });
  if (observation.state !== "stable" || source.providerId !== run.providerId ||
      !["native_cli", "structured_protocol"].includes(mode) ||
      typeof source.providerConversationRef !== "string" || !source.providerConversationRef.trim()) {
    return failure("account_switch_source_unavailable",
      "Inspect or recover this Agent first; account switching requires a stable runtime selection and an exact conversation.");
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
    "--expected-revision", String(source.selectionRevision), "--idempotency-key", requestId,
    "--backend", backend.profile.id, "--json"];
  const prepared = { ...base, ok: true, state: "preview", continuation: {
    requestId, start, retry: [...start],
    status: ["runtime", "get", run.agentId, "--backend", backend.profile.id, "--json"],
  } };
  if (!confirmRestart) return prepared;
  const report = await collectAgentRuntimeCommand({
    args: ["switch", run.agentId, target], account, credentialGeneration,
    expectedRevision: source.selectionRevision, requestId,
    resolveBackend: async () => backend, requestBackend,
  });
  if (!report.ok) return { ...prepared, ok: false, state: "unconfirmed", execution: "unconfirmed", error: report.error };
  if (report.result.receipt.providerId !== run.providerId ||
      report.result.receipt.providerConversationRef !== source.providerConversationRef) {
    return { ...prepared, ok: false, state: "unconfirmed", execution: "unconfirmed",
      error: { code: "account_switch_receipt_mismatch", message: "Inspect the retained status command; the requested conversation was not confirmed." } };
  }
  return { ...prepared, state: "completed", execution: "completed", result: report.result };
}

export function formatRunAccountSwitch(report) {
  return [
    `${report.agentId}: account ${report.account} (${report.state ?? "unavailable"})`,
    ...(report.error ? [`${report.error.remoteCode ?? report.error.code}: ${report.error.message ?? "Account switch failed"}`] : []),
    ...(report.continuation ? [
      `${report.state === "preview" ? "Apply" : "Retry"}: ${rehostCommandLine(report.continuation.start)}`,
      `Status: ${rehostCommandLine(report.continuation.status)}`,
      "After an uncertain response, inspect status and retain the exact retry command; do not repeat a name-based switch.",
    ] : []),
  ].join("\n");
}
