import { createHash } from "node:crypto";
import { AppControlClientError, requestAppControl } from "./app-control-client.mjs";
import {
  agentSpawnQueryExitCode,
  collectAgentSpawnQuery,
  formatAgentSpawnQuery,
} from "./agent-spawn-query.mjs";

export function defaultAgentRunName(providerId, idempotencyKey) {
  const suffix = createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 12);
  const provider = providerId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return `${provider}-${suffix}`;
}

/** Resolve new CLI panes through the app's existing preference authority. */
export async function resolveAgentRunInteractionPreference(
  clientDescriptor,
  requestClient = requestAppControl,
) {
  if (
    !Array.isArray(clientDescriptor?.capabilities) ||
    !clientDescriptor.capabilities.includes("agent.launch_preference_v1")
  ) {
    return "native_cli";
  }
  const preference = await requestClient({
    descriptor: clientDescriptor,
    path: "/agent/launch-preference",
  });
  if (
    preference?.ok !== true ||
    preference.schemaVersion !== 1 ||
    !["native_cli", null].includes(preference.interactionPreference)
  ) {
    throw new AppControlClientError(
      "client_response_invalid",
      "The Dure client returned an invalid Agent pane preference.",
    );
  }
  return preference.interactionPreference ?? undefined;
}

/** Resolve a non-secret, generation-pinned credential before Run preview. */
export async function resolveAgentRunAccount({ descriptor, providerId, backendProfileId, account,
  requestClient = requestAppControl }) {
  if (account === "default") return { kind: "provider_default" };
  if (!descriptor?.capabilities?.includes("agent.launch_account_v1")) {
    if (account !== undefined) throw new AppControlClientError("client_account_unavailable",
      "Selecting an account requires a connected app with agent.launch_account_v1 support.");
    return { kind: "provider_default" };
  }
  const response = await requestClient({ descriptor, path: "/agent/launch-account",
    body: { providerId, backendProfileId, ...(account === undefined ? {} : { account }) } });
  const profile = response?.executionProfile;
  if (response?.ok !== true || response.schemaVersion !== 1 || !profile ||
      (profile.kind !== "provider_default" && (profile.kind !== "credential_reference" ||
        typeof profile.reference_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(profile.reference_id) ||
        typeof profile.credential_generation !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(profile.credential_generation))) ||
      (account !== undefined && profile.reference_id !== account)) {
    throw new AppControlClientError("client_account_response_invalid", "The app did not confirm the requested Run account.");
  }
  return profile;
}

export async function collectAgentRun({
  projectId,
  projectPath,
  providerId,
  agentName,
  prompt,
  idempotencyKey,
  worktree = { kind: "project_root" },
  permissionOverride,
  model,
  effort,
  executionProfile,
  setupCommand,
  includePresentationProject,
  backend,
  deadlineMs,
  requestBackend,
  interactionPreference,
} = {}) {
  const preview = await collectAgentSpawnQuery({
    action: "preview",
    projectId,
    projectPath,
    providerId,
    agentName,
    worktree,
    permissionOverride,
    model,
    effort,
    executionProfile,
    interactionPreference,
    setupCommand,
    includePresentationProject,
    prompt,
    idempotencyKey,
    backend,
    deadlineMs,
    requestBackend,
  });
  const { presentationProject, ...previewReport } = preview;
  if (agentSpawnQueryExitCode(previewReport) !== 0 || !previewReport.receipt) {
    return { report: previewReport, presentationProject: null };
  }

  const report = await collectAgentSpawnQuery({
    action: "apply",
    operationId: previewReport.receipt.operationId,
    planToken: previewReport.receipt.plan.planToken,
    expectedLastSequence: previewReport.receipt.lastSequence,
    prompt,
    backend,
    deadlineMs,
    requestBackend,
  });
  return { report, presentationProject: presentationProject ?? null };
}

export const agentRunExitCode = agentSpawnQueryExitCode;
export const formatAgentRun = formatAgentSpawnQuery;
