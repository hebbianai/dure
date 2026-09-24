import {
  AppControlClientError,
  publicAppControlIdentity,
  requestAppControl,
} from "./app-control-client.mjs";
import {
  agentSpawnLaunchProjection,
} from "./agent-spawn-query.mjs";
export { resolveClientSpaceTarget as resolveRunPresentationTarget } from "./space-selection.mjs";
import { validProjectPath } from "./project-contract.mjs";
import { checkoutRegistrationMatches } from "./contracts/agent-spawn-worktree.mjs";

const API_VERSION = "dure.run-presentation/v1";
const SAFE_TOKEN = /^[A-Za-z0-9._:+-]{1,512}$/;

export class RunPresentationError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "RunPresentationError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new RunPresentationError(code, message);
}

function runtimeSource(profile) {
  if (!SAFE_TOKEN.test(profile?.id ?? "")) {
    fail(
      "client_backend_target_invalid",
      "Could not connect the selected backend to the Dure client.",
    );
  }
  if (profile?.transport?.kind === "local") {
    return { source: "local", hostId: "local" };
  }
  if (profile?.transport?.kind === "ssh") {
    const host = profile.transport.host;
    const user = profile.transport.user;
    const port = profile.transport.port;
    if (
      !SAFE_TOKEN.test(profile.id ?? "") ||
      typeof host !== "string" ||
      !host ||
      typeof user !== "string" ||
      !user ||
      !Number.isInteger(port)
    ) {
      fail(
        "client_backend_target_invalid",
        "Could not connect the selected SSH backend to the Dure client.",
      );
    }
    return {
      source: "ssh",
      hostId: profile.id,
      remote: { host, port, user },
    };
  }
  fail(
    "client_backend_target_invalid",
    "Could not connect the selected backend transport to the Dure client.",
  );
}

function sameExecutionProfile(left, right) {
  if (left?.kind !== right?.kind) return false;
  if (left?.kind === "provider_default") return true;
  return (
    left?.kind === "credential_reference" &&
    left.reference_id === right.reference_id &&
    left.credential_generation === right.credential_generation
  );
}

function presentableRunPlan(report) {
  const receipt = report?.receipt;
  const plan = receipt?.plan;
  const request = plan?.request;
  const workspaceEvidence = receipt?.completed?.find(
    (stage) => stage?.stage === "worktree",
  )?.evidence;
  const projection = agentSpawnLaunchProjection(plan, workspaceEvidence);
  const launch = projection?.launch;
  let workspace = projection?.workspace ?? null;
  if (workspace?.kind === "existing_checkout" &&
      !checkoutRegistrationMatches(request.worktree, receipt?.checkoutRegistration)) workspace = null;
  if (workspace?.kind === "dedicated") {
    const rootPath = receipt?.checkoutRegistration?.instance?.canonicalPath;
    if (validProjectPath(rootPath)) workspace = { ...workspace, rootPath };
    else if (request.worktree.checkout_path !== undefined) workspace = null;
  }
  if (
    report?.kind !== "dure.agent_spawn.apply" ||
    !SAFE_TOKEN.test(receipt.operationId ?? "") ||
    !SAFE_TOKEN.test(plan?.agentId ?? "") ||
    !SAFE_TOKEN.test(plan?.workspaceId ?? "") ||
    !SAFE_TOKEN.test(plan?.authority?.projectId ?? "") ||
    !SAFE_TOKEN.test(request?.agentName ?? "") ||
    !SAFE_TOKEN.test(request?.providerId ?? "") ||
    !["native_cli", "structured_protocol"].includes(
      launch?.interactionProfile,
    ) ||
    workspace === null ||
    !["default", "auto_edit", "skip_permissions"].includes(
      request?.permissionMode,
    )
  ) {
    fail(
      "client_run_receipt_invalid",
      "Could not verify the exact runtime identity of the Run.",
    );
  }
  if (launch.interactionProfile === "native_cli") {
    const runtimeEvidence = receipt.completed.find(
      (stage) => stage?.stage === "runtime_launch",
    )?.evidence;
    const runtimeGeneration = runtimeEvidence?.session;
    const preparedLaunchIdempotencyKey = `spawn-runtime:${receipt.operationId}`;
    const launchIdempotencyKey = runtimeEvidence?.launch_idempotency_key ??
      (runtimeGeneration?.sessionId === launch.sessionId
        ? preparedLaunchIdempotencyKey
        : null);
    if (
      !SAFE_TOKEN.test(launch.sessionId ?? "") ||
      !SAFE_TOKEN.test(launchIdempotencyKey ?? "") ||
      (runtimeGeneration?.sessionId === launch.sessionId) !==
        (launchIdempotencyKey === preparedLaunchIdempotencyKey) ||
      runtimeGeneration?.workspaceId !== plan.workspaceId ||
      runtimeGeneration?.providerId !== request.providerId ||
      !SAFE_TOKEN.test(runtimeGeneration?.runnerPrincipal ?? "") ||
      !SAFE_TOKEN.test(runtimeGeneration?.runnerInstance ?? "") ||
      !SAFE_TOKEN.test(runtimeGeneration?.channelEpoch ?? "") ||
      !SAFE_TOKEN.test(runtimeGeneration?.hostInstanceId ?? "") ||
      !SAFE_TOKEN.test(runtimeGeneration?.terminalEpoch ?? "")
    ) {
      fail(
        "client_run_receipt_invalid",
        "Could not verify the exact runtime identity of the Run.",
      );
    }
    return {
      interactionProfile: "native_cli",
      receipt,
      plan,
      request,
      launch,
      launchIdempotencyKey,
      runtimeGeneration,
      workspace,
    };
  }
  const binding = receipt.completed.find(
    (stage) => stage?.stage === "structured_launch",
  )?.evidence?.binding;
  if (
    launch.interactionProfile !== "structured_protocol" ||
    !SAFE_TOKEN.test(binding?.interactionSessionId ?? "") ||
    binding?.agentId !== plan.agentId ||
    binding?.providerId !== request.providerId ||
    !sameExecutionProfile(binding?.executionProfile, request.executionProfile) ||
    !SAFE_TOKEN.test(binding?.runtime?.runtimeGeneration ?? "") ||
    !SAFE_TOKEN.test(binding?.runtime?.providerEpoch ?? "")
  ) {
    fail(
      "client_run_receipt_invalid",
      "Could not verify the exact runtime identity of the Run.",
    );
  }
  return {
    interactionProfile: "structured_protocol",
    receipt,
    plan,
    request,
    launch,
    binding,
    workspace,
  };
}

/** A retained spawn receipt locates the Run; current backend selection supplies
 * its runtime. Never attach the predecessor merely because its launch succeeded. */
export function currentRunPresentationPlan(report, inspection) {
  const projected = presentableRunPlan({ ...report, kind: "dure.agent_spawn.apply" });
  const current = inspection?.receipt;
  const context = inspection?.projectionContext;
  if (inspection?.state !== "stable" || current?.agentId !== projected.plan.agentId ||
      current.providerId !== projected.request.providerId ||
      context?.agent?.agentId !== projected.plan.agentId ||
      context.agent.workspaceId !== projected.plan.workspaceId ||
      context.workspace?.projectId !== projected.plan.authority.projectId ||
      (projected.workspace.rootPath !== undefined && context.workspace?.rootPath !== projected.workspace.rootPath) ||
      !validProjectPath(context.project?.rootPath)) {
    fail("client_run_runtime_unavailable", "Inspect this Run's current runtime before opening it.");
  }
  const selected = current.authority;
  const request = { ...projected.request, executionProfile: current.executionProfile,
    permissionMode: current.permissionMode };
  if (selected?.interactionProfile !== projected.interactionProfile ||
      !sameExecutionProfile(current.executionProfile, projected.request.executionProfile) ||
      current.permissionMode !== projected.request.permissionMode) {
    fail("client_run_runtime_changed", "The Run's interaction or launch profile has changed; use its current runtime controls.");
  }
  if (selected.interactionProfile === "structured_protocol") {
    const binding = selected.binding;
    if (binding?.agentId !== current.agentId || binding?.providerId !== current.providerId ||
        !SAFE_TOKEN.test(binding?.interactionSessionId ?? "")) {
      fail("client_run_runtime_invalid", "The current conversation binding is invalid.");
    }
    return { ...projected, request, binding };
  }
  const source = selected.authority;
  const binding = source?.binding;
  const sessionId = binding?.sessionId;
  const launchIdempotencyKey = current.launchIdempotencyKey ??
    (sessionId === projected.runtimeGeneration.sessionId ? projected.launchIdempotencyKey : undefined);
  const runtimeGeneration = {
    sessionId, workspaceId: source?.runtimeWorkspaceId, providerId: current.providerId,
    ...Object.fromEntries(["runnerPrincipal", "runnerInstance", "channelEpoch", "hostInstanceId", "terminalEpoch"]
      .map((key) => [key, source?.[key]])),
  };
  if (binding?.agentId !== current.agentId || binding.runtimeKindId !== "runtime.hmux" ||
      source.runtimeWorkspaceId !== projected.plan.workspaceId ||
      !SAFE_TOKEN.test(launchIdempotencyKey ?? "") ||
      Object.values(runtimeGeneration).some((value) => typeof value !== "string" || !SAFE_TOKEN.test(value))) {
    fail("client_run_runtime_invalid", "The current native runtime binding is invalid.");
  }
  return { ...projected, request, runtimeGeneration, launchIdempotencyKey,
    providerConversationRef: current.providerConversationRef ?? null };
}

export function hasPresentableAgentRuntime(report) {
  try {
    presentableRunPlan(report);
    return true;
  } catch {
    return false;
  }
}

function managedRunPresentationRequestFromPlan(
  projected,
  { target, profile, projectPath },
) {
  if (target?.state !== "requested" && target?.state !== "background") {
    fail("client_space_target_invalid", "A Space is required to open the pane.");
  }
  const {
    receipt,
    plan,
    request,
    launch,
    launchIdempotencyKey,
    runtimeGeneration,
    workspace,
  } = projected;
  const runtime = runtimeSource(profile);
  const isPreparedRuntime =
    runtimeGeneration.sessionId === launch.sessionId &&
    launchIdempotencyKey === `spawn-runtime:${receipt.operationId}`;
  return {
    schemaVersion: 1,
    runtime: "hmux_managed_v1",
    ...runtime,
    backendProfileId: profile.id,
    operationId: receipt.operationId,
    agentId: plan.agentId,
    agentName: request.agentName,
    projectId: plan.authority.projectId,
    providerId: request.providerId,
    executionProfile: request.executionProfile,
    ...(projected.providerConversationRef === undefined ? {} : { providerConversationRef: projected.providerConversationRef }),
    sessionId: runtimeGeneration.sessionId,
    ...(isPreparedRuntime
      ? {}
      : {
          preparedSessionId: launch.sessionId,
          launchIdempotencyKey,
        }),
    workspaceId: plan.workspaceId,
    worktree: workspace,
    generation: {
      runnerPrincipal: runtimeGeneration.runnerPrincipal,
      runnerInstance: runtimeGeneration.runnerInstance,
      channelEpoch: runtimeGeneration.channelEpoch,
      hostInstanceId: runtimeGeneration.hostInstanceId,
      terminalEpoch: runtimeGeneration.terminalEpoch,
    },
    permissionMode: request.permissionMode,
    ...(target.state === "background" ? {} : { spaceId: target.spaceId, windowLabel: target.windowLabel }),
    ...(target.referencePanelId
      ? { referencePanelId: target.referencePanelId }
      : {}),
    ...(projectPath ? { projectPath } : {}),
  };
}

export function managedRunPresentationRequest(options) {
  const projected = presentableRunPlan(options.report);
  if (projected.interactionProfile !== "native_cli") {
    fail("client_run_receipt_invalid", "Run does not own a native CLI runtime.");
  }
  return managedRunPresentationRequestFromPlan(projected, options);
}

function structuredRunPresentationRequestFromPlan(
  projected,
  { target, profile, projectPath },
) {
  if (target?.state !== "requested" && target?.state !== "background") {
    fail("client_space_target_invalid", "A Space is required to open the pane.");
  }
  const { receipt, plan, request, binding, workspace } = projected;
  const runtime = runtimeSource(profile);
  return {
    schemaVersion: 1,
    interactionProfile: "structured_protocol",
    backendProfileId: profile.id,
    ...runtime,
    backend: {
      id: plan.authority.backendId,
      generation: plan.authority.backendGeneration,
    },
    operationId: receipt.operationId,
    agentId: plan.agentId,
    agentName: request.agentName,
    projectId: plan.authority.projectId,
    providerId: request.providerId,
    executionProfile: request.executionProfile,
    interactionSessionId: binding.interactionSessionId,
    workspaceId: plan.workspaceId,
    worktree: workspace,
    permissionMode: request.permissionMode,
    ...(target.state === "background" ? { presentation: "background" } : { spaceId: target.spaceId }),
    windowLabel: target.windowLabel,
    ...(target.referencePanelId
      ? { referencePanelId: target.referencePanelId }
      : {}),
    ...(projectPath ? { projectPath } : {}),
  };
}

export function structuredRunPresentationRequest(options) {
  const projected = presentableRunPlan(options.report);
  if (projected.interactionProfile !== "structured_protocol") {
    fail("client_run_receipt_invalid", "Run does not own a structured runtime.");
  }
  return structuredRunPresentationRequestFromPlan(projected, options);
}

function publicPane(payload, expected) {
  const pane = payload?.pane;
  const projectedSpaceId = pane?.spaceId;
  const legacySpaceId = pane?.desktopId;
  const spaceId = projectedSpaceId ?? legacySpaceId;
  const commonInvalid =
    !pane ||
    typeof pane !== "object" ||
    !SAFE_TOKEN.test(spaceId ?? "") ||
    !SAFE_TOKEN.test(pane.panelId ?? "") ||
    !SAFE_TOKEN.test(pane.agentId ?? "") ||
    !["created", "reused"].includes(pane.outcome) ||
    (projectedSpaceId !== undefined &&
      legacySpaceId !== undefined &&
      projectedSpaceId !== legacySpaceId) ||
    spaceId !== expected.spaceId ||
    pane.agentId !== expected.agentId;
  const structured = expected.interactionProfile === "structured_protocol";
  const profileInvalid = structured
    ? !SAFE_TOKEN.test(pane?.interactionSessionId ?? "") ||
      pane?.interactionProfile !== "structured_protocol" ||
      pane?.interactionSessionId !== expected.interactionSessionId
    : !SAFE_TOKEN.test(pane?.sessionId ?? "") ||
      !SAFE_TOKEN.test(pane?.workspaceId ?? "") ||
      pane?.runtime !== "hmux_managed_v1" ||
      pane?.sessionId !== expected.sessionId ||
      pane?.workspaceId !== expected.workspaceId;
  if (commonInvalid || profileInvalid) {
    throw new AppControlClientError(
      "client_response_invalid",
      "The Dure client Agent pane receipt is invalid.",
    );
  }
  if (structured) {
    return {
      spaceId,
      panelId: pane.panelId,
      agentId: pane.agentId,
      interactionSessionId: pane.interactionSessionId,
      interactionProfile: pane.interactionProfile,
      outcome: pane.outcome,
    };
  }
  return {
    spaceId,
    panelId: pane.panelId,
    agentId: pane.agentId,
    sessionId: pane.sessionId,
    workspaceId: pane.workspaceId,
    runtime: pane.runtime,
    outcome: pane.outcome,
  };
}

/** Register local native Runs for the existing durable Agent recovery lifecycle. */
export async function registerAgentRunInBackground({report,profile,projectPath,descriptor,fetchImpl=globalThis.fetch}) {
  if (!descriptor?.capabilities?.includes("agent.run_background_v1") || profile?.transport?.kind !== "local") return undefined;
  const projected = presentableRunPlan(report);
  if (projected.interactionProfile !== "native_cli") return undefined;
  const body = managedRunPresentationRequestFromPlan(projected, {target:{state:"background"},profile,projectPath});
  const payload = await requestAppControl({descriptor,path:"/agent/run-background",body,fetchImpl});
  if (payload?.agent?.agentId !== body.agentId || payload.agent.sessionId !== body.sessionId) {
    fail("client_response_invalid", "The client did not register the exact Run.");
  }
  return {state:"registered",agentId:body.agentId,sessionId:body.sessionId};
}

export async function presentAgentRunRuntime({
  report,
  currentRuntime,
  target,
  profile,
  projectPath,
  descriptor,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (target?.state === "headless") {
    return {
      schemaVersion: 1,
      apiVersion: API_VERSION,
      state: "headless",
      reason: target.reason,
    };
  }
  const projected = currentRuntime
    ? currentRunPresentationPlan(report, currentRuntime)
    : presentableRunPlan(report);
  const structured = projected.interactionProfile === "structured_protocol";
  const body = structured
    ? structuredRunPresentationRequestFromPlan(projected, {
        target,
        profile,
        projectPath,
      })
    : managedRunPresentationRequestFromPlan(projected, {
        target,
        profile,
        projectPath,
      });
  const payload = await requestAppControl({
    descriptor,
    path: structured ? "/agent/present" : "/hmux/attach",
    body,
    fetchImpl,
  });
  if (target.state === "background") {
    if (payload?.agent?.agentId !== body.agentId || payload.agent.interactionSessionId !== body.interactionSessionId) {
      fail("client_response_invalid", "The client did not register the requested conversation.");
    }
    return { schemaVersion: 1, apiVersion: API_VERSION, state: "background", client: publicAppControlIdentity(descriptor), agent: payload.agent };
  }
  return {
    schemaVersion: 1,
    apiVersion: API_VERSION,
    state: "opened",
    reason: target.reason,
    client: publicAppControlIdentity(descriptor),
    pane: publicPane(payload, body),
  };
}

export function failedRunPresentation(error, requested = true) {
  return {
    schemaVersion: 1,
    apiVersion: API_VERSION,
    state: requested ? "failed" : "headless",
    reason: requested ? "client_request_failed" : "source_pane_unavailable",
    ...(requested
      ? {
          error: {
            code:
              typeof error?.code === "string"
                ? error.code
                : "client_presentation_failed",
          },
        }
      : {}),
  };
}

export function formatRunPresentation(presentation) {
  if (presentation.state === "opened") {
    return `pane\t${presentation.pane.spaceId}/${presentation.pane.panelId}`;
  }
  if (presentation.state === "failed") {
    return `pane\tfailed (${presentation.error.code}); the Run continues headlessly.`;
  }
  return "pane\theadless";
}
