import { createHash } from "node:crypto";
import { AppControlClientError, requestAppControl } from "./app-control-client.mjs";
import {
  agentSpawnErrorReport,
  agentSpawnQueryExitCode,
  collectAgentSpawnQuery,
  formatAgentSpawnQuery,
} from "./agent-spawn-query.mjs";
import { performBackendProfileRequest } from "./backend-transport.mjs";
import { readRegisteredAccountProfiles, registeredAccountUnavailableMessage } from "./registered-account-profiles.mjs";
import { appAdoptsBackgroundRuns } from "./run-presentation.mjs";

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

/**
 * Resolve a new Run's interface through the app's existing preference authority.
 * An undefined result leaves no pin, so the backend starts the provider's
 * structured runtime when it has one and plans a terminal session otherwise.
 */
export async function resolveAgentRunInteractionPreference(
  { descriptor, presenting, profile },
  requestClient = requestAppControl,
) {
  if (!descriptor) return undefined;
  if (!presenting) {
    // The app's background lifecycle adopts only native Runs.
    return appAdoptsBackgroundRuns(descriptor, profile) ? "native_cli" : undefined;
  }
  if (
    !Array.isArray(descriptor.capabilities) ||
    !descriptor.capabilities.includes("agent.launch_preference_v1")
  ) {
    return "native_cli";
  }
  const preference = await requestClient({
    descriptor,
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

/**
 * Resolve a new Run's interface. An explicit runtime wins wherever the command
 * runs: terminal pins a terminal session and chat requires the provider's chat
 * runtime. Without one, the app's preference applies, and a Terminal default
 * may start in chat when the execution host has no terminal integration, unless
 * the presenting app is too old to show a chat Run.
 */
export async function resolveAgentRunInterface(
  { runtime, descriptor, presenting, profile },
  requestClient = requestAppControl,
) {
  if (runtime === "terminal") return { runtime, interactionPreference: "native_cli", chatFallback: false };
  if (runtime === "chat") return { runtime, interactionPreference: undefined, chatFallback: false };
  const interactionPreference = await resolveAgentRunInteractionPreference(
    { descriptor, presenting, profile },
    requestClient,
  );
  return {
    runtime: undefined,
    interactionPreference,
    chatFallback: interactionPreference === "native_cli" &&
      (!presenting || descriptor?.capabilities?.includes("agent.launch_preference_v1") === true),
  };
}

function refusedForTerminalIntegration(report) {
  return report.kind === "dure.agent_spawn.error" &&
    report.error?.remoteCode === "agent_spawn_provider_preflight_failed" &&
    report.error.reasonCode === "provider_runtime_integration_unavailable";
}

function plannedInteractionProfile(receipt) {
  const plan = receipt?.plan;
  if (plan?.launch?.interactionProfile !== undefined) return plan.launch.interactionProfile;
  // Backends before canonical launch plans only planned terminal sessions.
  return plan?.sessionId !== undefined ? "native_cli" : null;
}

/** Resolve a non-secret, generation-pinned credential before Run preview. */
export async function resolveAgentRunAccount({ descriptor, providerId, backendProfileId, account, backend,
  requestBackend = performBackendProfileRequest, requestClient = requestAppControl }) {
  if (account === "default") return { kind: "provider_default" };
  let appError = new AppControlClientError("client_account_unavailable",
    "Selecting an account requires a connected app with agent.launch_account_v1 support.");
  if (descriptor?.capabilities?.includes("agent.launch_account_v1")) {
    try {
      return await resolveAppRunAccount({ descriptor, providerId, backendProfileId, account, requestClient });
    } catch (error) {
      if (account === undefined || error?.code !== "agent_launch_account_unavailable") throw error;
      appError = error;
    }
  } else if (account === undefined) return { kind: "provider_default" };
  // runs switch-account launches any account registered on the backend, so a
  // Run accepts the same IDs even when the app lists the account under another.
  if (!backend?.profile) throw appError;
  let profiles;
  try {
    profiles = await readRegisteredAccountProfiles({ providerId, backend, requestBackend });
  } catch {
    throw appError;
  }
  if (!profiles) throw new AppControlClientError("agent_launch_account_profiles_invalid",
    "The backend returned invalid credential profile handles.");
  const matches = profiles.filter((profile) => profile.referenceId === account);
  if (matches.length === 1) {
    return { kind: "credential_reference", reference_id: account, credential_generation: matches[0].credentialGeneration };
  }
  throw new AppControlClientError("agent_launch_account_unavailable", registeredAccountUnavailableMessage({
    providerId, account, profiles, backendId: backend.profile.id }));
}

async function resolveAppRunAccount({ descriptor, providerId, backendProfileId, account, requestClient }) {
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
  runtime,
  chatFallback = false,
  parent,
  verbose = false,
} = {}) {
  const startedAt = Date.now();
  const preview = (selectedPreference) => collectAgentSpawnQuery({
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
    interactionPreference: selectedPreference,
    parent,
    setupCommand,
    includePresentationProject,
    prompt,
    idempotencyKey,
    backend,
    deadlineMs,
    requestBackend,
    verbose,
  });
  let planned = await preview(interactionPreference);
  // A refused plan records nothing, so the same key can ask the backend for
  // its default interface: the provider's chat runtime when it has one.
  const fellBackToChat = chatFallback && interactionPreference === "native_cli" &&
    setupCommand === undefined && refusedForTerminalIntegration(planned);
  if (fellBackToChat) planned = await preview(undefined);
  const interactionFallback = fellBackToChat
    ? { from: "native_cli", to: "structured_protocol", reasonCode: "provider_runtime_integration_unavailable" }
    : undefined;
  const { presentationProject, ...previewReport } = planned;
  if (agentSpawnQueryExitCode(previewReport) !== 0 || !previewReport.receipt) {
    return { report: previewReport, presentationProject: null, interactionFallback };
  }
  if (runtime === "chat" && plannedInteractionProfile(previewReport.receipt) !== "structured_protocol") {
    const observedAtMs = Date.now();
    return {
      report: agentSpawnErrorReport("preview", "agent_run_chat_runtime_unavailable", observedAtMs,
        Math.max(0, observedAtMs - startedAt), {
          ...(deadlineMs === undefined ? {} : { deadlineMs }),
          ...(backend?.profile ? { profileId: backend.profile.id } : {}),
          disposition: "terminal",
          message: `The execution host has no chat runtime for ${providerId} with these options, so nothing was started. ` +
            "Retry with --runtime terminal to start a terminal session instead.",
        }),
      presentationProject: null,
      interactionFallback,
    };
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
    verbose,
  });
  return { report, presentationProject: presentationProject ?? null, interactionFallback };
}

export const agentRunExitCode = agentSpawnQueryExitCode;
export const formatAgentRun = formatAgentSpawnQuery;
