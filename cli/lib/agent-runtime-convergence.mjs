import { performBackendProfileRequest } from "./backend-transport.mjs";
import { collectSessionQuery } from "./session-query.mjs";
import {
  findAgentPane,
  parseClientPresentation,
} from "./client-presentation-state.mjs";

const AGENT_RUNTIME_CONVERGENCE_SCHEMA_VERSION = 1;
const AGENT_RUNTIME_CONVERGENCE_API_VERSION =
  "dure.agent-runtime-convergence/v1";

const GENERATION_FIELDS = Object.freeze([
  "runnerPrincipal",
  "runnerInstance",
  "channelEpoch",
  "hostInstanceId",
  "terminalEpoch",
]);
const MAX_ID_BYTES = 512;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value, maximum = MAX_ID_BYTES) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function generation(value) {
  if (!record(value)) return null;
  const parsed = {};
  for (const field of GENERATION_FIELDS) {
    if (!boundedString(value[field], 256)) return null;
    parsed[field] = value[field];
  }
  return parsed;
}

function sameGeneration(left, right) {
  return (
    left !== null &&
    right !== null &&
    GENERATION_FIELDS.every((field) => left[field] === right[field])
  );
}

function errorReport(agentId, code, upstreamCode, now) {
  return {
    schemaVersion: AGENT_RUNTIME_CONVERGENCE_SCHEMA_VERSION,
    apiVersion: AGENT_RUNTIME_CONVERGENCE_API_VERSION,
    kind: "dure.agent_runtime.convergence_error",
    complete: false,
    ok: false,
    observedAtMs: now(),
    agentId,
    error: {
      code,
      ...(boundedString(upstreamCode, 128) ? { upstreamCode } : {}),
    },
  };
}

function upstreamErrorCode(error) {
  return error?.details?.code ?? error?.code;
}

function parseStableAuthority(response) {
  const result = response?.result;
  if (!record(result) || result.schemaVersion !== 1) {
    return { kind: "invalid" };
  }
  if (result.state !== "stable") {
    return {
      kind: "not_stable",
      state: boundedString(result.state, 64) ? result.state : "invalid",
    };
  }
  const receipt = result.receipt;
  const selected = receipt?.authority;
  const runtime = selected?.authority;
  const binding = runtime?.binding;
  const execution = receipt?.executionProfile;
  const runtimeGeneration = generation(runtime);
  if (
    !record(receipt) ||
    receipt.schemaVersion !== 1 ||
    !boundedString(receipt.agentId) ||
    !boundedString(receipt.providerId, 128) ||
    !Number.isSafeInteger(receipt.selectionRevision) ||
    receipt.selectionRevision < 1 ||
    !record(selected) ||
    !boundedString(selected.interactionProfile, 64) ||
    !record(runtime) ||
    runtime.schemaVersion !== 1 ||
    runtimeGeneration === null ||
    !record(binding) ||
    !boundedString(binding.agentId) ||
    !Number.isSafeInteger(binding.bindingGeneration) ||
    binding.bindingGeneration < 1 ||
    !boundedString(binding.sessionId) ||
    !boundedString(runtime.runtimeWorkspaceId) ||
    !boundedString(binding.runtimeKindId, 128) ||
    !boundedString(binding.credentialReferenceId) ||
    !boundedString(binding.providerConversationId) ||
    !record(execution) ||
    execution.kind !== "credential_reference" ||
    !boundedString(execution.reference_id) ||
    !boundedString(execution.credential_generation) ||
    !boundedString(receipt.providerConversationRef)
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "stable",
    authority: {
      agentId: receipt.agentId,
      providerId: receipt.providerId,
      interactionProfile: selected.interactionProfile,
      selectionRevision: receipt.selectionRevision,
      bindingGeneration: binding.bindingGeneration,
      sessionId: binding.sessionId,
      workspaceId: runtime.runtimeWorkspaceId,
      runtimeKindId: binding.runtimeKindId,
      credentialId: execution.reference_id,
      bindingCredentialId: binding.credentialReferenceId,
      credentialGeneration: execution.credential_generation,
      conversationId: receipt.providerConversationRef,
      bindingConversationId: binding.providerConversationId,
      generation: runtimeGeneration,
    },
  };
}

function projectedAgent(registry, agentId) {
  const matches = Array.isArray(registry?.agents)
    ? registry.agents.filter((agent) => agent?.id === agentId)
    : [];
  return matches.length === 1 ? matches[0] : null;
}

function expectedRoute(profile) {
  return profile.transport.kind === "ssh"
    ? { source: "ssh", hostId: profile.id }
    : { source: "local", hostId: "local" };
}

/** Compare complete observations only. The backend remains runtime authority;
 * Hmux and the client registry are read-only projections checked against it. */
function assessAgentRuntimeConvergence({
  agentId,
  sourceSessionId,
  expectedCredentialId,
  expectedConversationId,
  authority,
  sessionReport,
  registry,
  profile,
  now = Date.now,
}) {
  const route = expectedRoute(profile);
  const session = sessionReport?.session ?? null;
  const agent = projectedAgent(registry, agentId);
  const pane = findAgentPane(
    parseClientPresentation(registry?.clientPresentation),
    agentId,
  );
  const binding = agent?.runtimeBinding;
  const projected = session?.clientProjection;
  const runtimeGeneration = generation(session?.runtime?.generation);
  const agentGeneration = generation(binding?.stopFence);
  const failed = [
    ["backend_successor_not_replaced", authority.sessionId === sourceSessionId],
    ["backend_agent_mismatch", authority.agentId !== agentId],
    [
      "backend_interaction_profile_mismatch",
      authority.interactionProfile !== "native_cli",
    ],
    ["backend_runtime_kind_mismatch", authority.runtimeKindId !== "runtime.hmux"],
    [
      "backend_credential_mismatch",
      authority.credentialId !== expectedCredentialId ||
        authority.bindingCredentialId !== expectedCredentialId,
    ],
    [
      "backend_conversation_mismatch",
      authority.conversationId !== expectedConversationId ||
        authority.bindingConversationId !== expectedConversationId,
    ],
    [
      "hmux_session_identity_mismatch",
      !session ||
        session.sessionId !== authority.sessionId ||
        session.workspaceId !== authority.workspaceId,
    ],
    [
      "hmux_conversation_mismatch",
      session?.conversationId !== expectedConversationId,
    ],
    [
      "hmux_generation_mismatch",
      !sameGeneration(authority.generation, runtimeGeneration),
    ],
    [
      "hmux_runtime_identity_mismatch",
      session?.runtime?.sessionClass !== "managed" ||
        session?.provider?.id !== authority.providerId,
    ],
    [
      "hmux_runtime_unhealthy",
      session?.liveness?.state !== "alive" ||
        session?.liveness?.health !== "healthy" ||
        session?.liveness?.exactGeneration !== true,
    ],
    [
      "client_runtime_projection_not_current",
      projected?.state !== "current" ||
        !projected.agents?.some((candidate) => candidate.id === agentId),
    ],
    [
      "client_agent_projection_mismatch",
      !agent ||
        agent.credentialId !== expectedCredentialId ||
        agent.conversationId !== expectedConversationId ||
        binding?.sessionId !== authority.sessionId ||
        binding?.workspaceId !== authority.workspaceId ||
        binding?.credentialId !== expectedCredentialId ||
        binding?.backendProfileId !== profile.id ||
        binding?.source !== route.source ||
        binding?.hostId !== route.hostId ||
        !sameGeneration(authority.generation, agentGeneration) ||
        binding?.conversationIdentity?.conversationId !==
          expectedConversationId,
    ],
    [
      "client_pane_projection_mismatch",
      !pane ||
        pane.binding?.sessionId !== authority.sessionId ||
        pane.binding?.workspaceId !== authority.workspaceId ||
        pane.binding?.source !== route.source ||
        pane.binding?.hostId !== route.hostId,
    ],
  ];
  const failures = failed
    .filter(([, mismatch]) => mismatch)
    .map(([code]) => ({ code }));

  return {
    schemaVersion: AGENT_RUNTIME_CONVERGENCE_SCHEMA_VERSION,
    apiVersion: AGENT_RUNTIME_CONVERGENCE_API_VERSION,
    kind: "dure.agent_runtime.convergence",
    complete: true,
    ok: failures.length === 0,
    observedAtMs: now(),
    agentId,
    expected: {
      sourceSessionId,
      credentialId: expectedCredentialId,
      conversationId: expectedConversationId,
    },
    authority,
    runtime: session
      ? {
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          providerId: session.provider?.id ?? null,
          sessionClass: session.runtime?.sessionClass ?? null,
          conversationId: session.conversationId,
          generation: runtimeGeneration,
          liveness: session.liveness ?? null,
        }
      : null,
    projection: {
      runtimeState: projected?.state ?? null,
      agentId: agent?.id ?? null,
      credentialId: agent?.credentialId ?? null,
      conversationId: agent?.conversationId ?? null,
      agentBinding: binding
        ? {
            sessionId: binding.sessionId,
            workspaceId: binding.workspaceId,
            credentialId: binding.credentialId,
            backendProfileId: binding.backendProfileId,
            source: binding.source,
            hostId: binding.hostId,
            generation: agentGeneration,
            conversationId:
              binding.conversationIdentity?.conversationId ?? null,
          }
        : null,
      paneId: pane?.id ?? null,
      paneBinding: pane?.binding ?? null,
    },
    failures,
  };
}

export async function collectAgentRuntimeConvergence({
  agentId,
  sourceSessionId,
  expectedCredentialId,
  expectedConversationId,
  profile,
  registry,
  transportOptions = {},
  requestBackend = performBackendProfileRequest,
  collectSessions = collectSessionQuery,
  now = Date.now,
}) {
  if (
    !boundedString(agentId) ||
    !boundedString(sourceSessionId) ||
    !boundedString(expectedCredentialId) ||
    !boundedString(expectedConversationId) ||
    !record(profile) ||
    !boundedString(profile.id, 64) ||
    !record(profile.transport)
  ) {
    return errorReport(
      boundedString(agentId) ? agentId : null,
      "agent_runtime_convergence_request_invalid",
      undefined,
      now,
    );
  }

  let response;
  try {
    response = await requestBackend(
      profile,
      {
        operation: "agent_runtime.inspect",
        body: { schemaVersion: 1, agentId },
        requiredCapabilities: ["agent_runtime.inspect"],
      },
      transportOptions,
    );
  } catch (error) {
    return errorReport(
      agentId,
      "agent_runtime_convergence_backend_failed",
      upstreamErrorCode(error),
      now,
    );
  }

  const parsed = parseStableAuthority(response);
  if (parsed.kind === "invalid") {
    return errorReport(
      agentId,
      "agent_runtime_convergence_backend_response_invalid",
      undefined,
      now,
    );
  }
  if (parsed.kind === "not_stable") {
    return {
      schemaVersion: AGENT_RUNTIME_CONVERGENCE_SCHEMA_VERSION,
      apiVersion: AGENT_RUNTIME_CONVERGENCE_API_VERSION,
      kind: "dure.agent_runtime.convergence",
      complete: true,
      ok: false,
      observedAtMs: now(),
      agentId,
      expected: {
        sourceSessionId,
        credentialId: expectedCredentialId,
        conversationId: expectedConversationId,
      },
      authority: null,
      runtime: null,
      projection: null,
      failures: [
        {
          code: "backend_runtime_not_stable",
          expected: "stable",
          observed: parsed.state,
        },
      ],
    };
  }

  const sessionReport = await collectSessions({
    action: "show",
    sessionId: parsed.authority.sessionId,
    workspaceId: parsed.authority.workspaceId,
    registry,
    backend: { profile, transportOptions },
  });
  if (sessionReport?.kind !== "dure.sessions.show") {
    return errorReport(
      agentId,
      "agent_runtime_convergence_session_query_failed",
      sessionReport?.error?.remoteCode ?? sessionReport?.error?.code,
      now,
    );
  }

  return assessAgentRuntimeConvergence({
    agentId,
    sourceSessionId,
    expectedCredentialId,
    expectedConversationId,
    authority: parsed.authority,
    sessionReport,
    registry,
    profile,
    now,
  });
}

export function agentRuntimeConvergenceExitCode(report) {
  if (report?.kind === "dure.agent_runtime.convergence_error") return 2;
  return report?.ok === true ? 0 : 1;
}

export function formatAgentRuntimeConvergence(report) {
  if (report?.kind === "dure.agent_runtime.convergence_error") {
    const upstream = report.error.upstreamCode
      ? ` (${report.error.upstreamCode})`
      : "";
    return `Agent runtime convergence unavailable: ${report.error.code}${upstream}`;
  }
  if (report.ok) {
    return [
      `Agent ${report.agentId} converged`,
      `credential: ${report.expected.credentialId}`,
      `conversation: ${report.expected.conversationId}`,
      `source session: ${report.expected.sourceSessionId}`,
      `successor session: ${report.authority.sessionId}`,
      `workspace: ${report.authority.workspaceId}`,
      `selection revision: ${report.authority.selectionRevision}`,
    ].join("\n");
  }
  return [
    `Agent ${report.agentId} has not converged`,
    ...report.failures.map((item) => `- ${item.code}`),
  ].join("\n");
}
