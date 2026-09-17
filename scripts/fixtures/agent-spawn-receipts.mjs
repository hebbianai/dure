import { createHash } from "node:crypto";

export const promptDigest =
  "sha256:b20d718d5209f296c0822a7892100de99261243f280399898e79df07f4a7432e";

export function worktree() {
  return {
    kind: "dedicated",
    base_commit_sha: "a".repeat(40),
    branch: "agent/codex-1",
  };
}

export function adoptExistingCheckout(value) {
  const instance = {
    schemaVersion: 1,
    canonicalPath: "/repo/preexisting-checkout",
    gitCommonDir: "/repo/.git",
    gitDir: "/repo/.git/worktrees/preexisting-checkout",
    instanceToken: `dwt1_${"a".repeat(32)}`,
  };
  value.plan.request.worktree = {
    kind: "existing_checkout", instance, branch: "user/work", base_commit_sha: "a".repeat(40),
  };
  value.checkoutRegistration = { repositoryPath: "/repo", instance };
  value.completed[0].inputs.policy = value.plan.request.worktree;
  value.completed[0].evidence = {
    stage: "worktree", workspace_id: value.plan.workspaceId, disposition: "adopted_existing",
  };
  return value;
}

export function request(overrides = {}) {
  return {
    schemaVersion: 1,
    idempotencyKey: "spawn-request-1",
    projectId: "dure",
    providerId: "codex",
    agentName: "codex-1",
    worktree: worktree(),
    promptDigest,
    ...overrides,
  };
}

export function receipt(spawnIntent = request(), inheritedPermissionMode = "default") {
  const operationId = "spawn-0123456789abcdef0123456789abcdef";
  const recordedAtMs = 1_700_000_000_000;
  const permissionOverride = spawnIntent.permissionOverride ?? null;
  const spawnRequest = {
    ...spawnIntent,
    providerConversationRef: spawnIntent.providerConversationRef ?? null,
    permissionMode:
      spawnIntent.permissionMode ??
      (permissionOverride === "require_approvals"
        ? "default"
        : permissionOverride === "auto_edit"
          ? "auto_edit"
          : permissionOverride === "bypass_approvals"
            ? "skip_permissions"
            : inheritedPermissionMode),
  };
  delete spawnRequest.permissionOverride;
  return {
    schemaVersion: 1,
    operationId,
    plan: {
      schemaVersion: 1,
      operationId,
      authority: {
        backendId: "remote-a-backend",
        backendGeneration: "remote-a-generation-1",
        projectId: "dure",
        rootId: "root_0123456789abcdef0123456789abcdef",
        repositoryId: "repo_fedcba9876543210fedcba9876543210",
      },
      request: spawnRequest,
      agentId: "agent-0123456789abcdef0123456789abcdef",
      workspaceId: "workspace-0123456789abcdef0123456789abcdef",
      sessionId: "session-0123456789abcdef0123456789abcdef",
      runtime: {
        runtimeKindId: "runtime.hmux",
        requiredCapabilities: ["provider-launch", "session-create"],
      },
      providerLaunchDefaults: {
        schemaVersion: 1,
        revision: 0,
        fingerprint: `sha256:${"c".repeat(64)}`,
        permissionOverride,
      },
      planToken: `sha256:${"b".repeat(64)}`,
    },
    state: "applying",
    lastSequence: 1,
    completed: [],
    recovery: { kind: "continue", stage: "worktree", next_attempt: 1 },
    terminalCode: null,
    createdAtMs: recordedAtMs,
    updatedAtMs: recordedAtMs,
  };
}

export function canonicalNativeReceipt(spawnIntent = request()) {
  const value = receipt(spawnIntent);
  const { sessionId, runtime } = value.plan;
  delete value.plan.sessionId;
  delete value.plan.runtime;
  value.plan.launch = { interactionProfile: "native_cli", sessionId, runtime };
  value.plan.request.executionProfile = { kind: "provider_default" };
  return value;
}

export function dedicatedWorkspaceEvidence(plan) {
  return {
    stage: "worktree",
    workspace_id: plan.workspaceId,
    disposition: "created_dure_owned",
    lease: {
      lease_id: `workspace-lease:${plan.workspaceId}`,
      directory_name: "codex-1",
      retirement_id: `workspace-retire:${plan.workspaceId}`,
    },
  };
}

export function succeededStructuredReceipt(spawnIntent = request()) {
  const value = receipt(spawnIntent);
  const plan = value.plan;
  delete plan.sessionId;
  delete plan.runtime;
  plan.launch = { interactionProfile: "structured_protocol" };
  plan.request.executionProfile = { kind: "provider_default" };
  const runtime = {
    runtimeGeneration: "runtime-generation-1",
    providerEpoch: "provider-epoch-1",
  };
  const interactionSessionId = "interaction-session-1";
  const promptToken = createHash("sha256")
    .update(`dure.agent_spawn.structured-prompt/v1\0${plan.operationId}`)
    .digest("hex")
    .slice(0, 24);
  const worktreeStage = {
    stage: "worktree",
    attempt: 1,
    inputs: {
      stage: "worktree",
      workspace_id: plan.workspaceId,
      project_root_id: plan.authority.rootId,
      repository_id: plan.authority.repositoryId,
      policy: plan.request.worktree,
    },
    evidence: {
      ...dedicatedWorkspaceEvidence(plan),
    },
  };
  const binding = {
    schemaVersion: 1,
    interactionSessionId,
    agentId: plan.agentId,
    providerId: plan.request.providerId,
    executionProfile: plan.request.executionProfile,
    providerConversationRef: plan.request.providerConversationRef,
    runtime,
    timelineEpoch: "timeline-epoch-1",
    bindingRevision: 1,
    historyComplete: true,
    createdAtMs: value.createdAtMs,
    updatedAtMs: value.createdAtMs,
  };
  value.completed = [
    worktreeStage,
    {
      stage: "structured_launch",
      attempt: 1,
      inputs: {
        stage: "structured_launch",
        agent_id: plan.agentId,
        workspace_id: plan.workspaceId,
        provider_id: plan.request.providerId,
        execution_profile: plan.request.executionProfile,
        provider_conversation_ref: plan.request.providerConversationRef,
      },
      evidence: { stage: "structured_launch", binding },
    },
    {
      stage: "structured_prompt_delivery",
      attempt: 1,
      inputs: {
        stage: "structured_prompt_delivery",
        interaction_session_id: interactionSessionId,
        runtime,
        turn_id: `spawn-turn-${promptToken}`,
        client_message_id: `spawn-message-${promptToken}`,
        prompt_digest: plan.request.promptDigest,
      },
      evidence: {
        stage: "structured_prompt_delivery",
        interaction_session_id: interactionSessionId,
        runtime,
        turn_id: `spawn-turn-${promptToken}`,
        client_message_id: `spawn-message-${promptToken}`,
      },
    },
  ];
  value.state = "succeeded";
  value.lastSequence = 8;
  value.recovery = { kind: "none" };
  value.updatedAtMs += 7;
  return value;
}

export function succeededNativeReceipt({
  sessionId,
  launchIdempotencyKey,
  omitLaunchIdempotencyKey = false,
  initialPromptAccepted = false,
} = {}) {
  const value = canonicalNativeReceipt();
  const plan = value.plan;
  const effectiveSessionId = sessionId ?? plan.launch.sessionId;
  const effectiveLaunchIdempotencyKey = launchIdempotencyKey ??
    `spawn-runtime:${plan.operationId}`;
  const runtimeSession = {
    sessionId: effectiveSessionId,
    workspaceId: plan.workspaceId,
    providerId: plan.request.providerId,
    runnerPrincipal: "runner-principal-1",
    runnerInstance: "runner-instance-1",
    channelEpoch: "1",
    hostInstanceId: "host-instance-1",
    terminalEpoch: "terminal-epoch-1",
  };
  value.completed = [{
    stage: "worktree",
    attempt: 1,
    inputs: {
      stage: "worktree",
      workspace_id: plan.workspaceId,
      project_root_id: plan.authority.rootId,
      repository_id: plan.authority.repositoryId,
      policy: plan.request.worktree,
    },
    evidence: dedicatedWorkspaceEvidence(plan),
  }, {
    stage: "runtime_launch",
    attempt: 1,
    inputs: {
      stage: "runtime_launch",
      agent_id: plan.agentId,
      workspace_id: plan.workspaceId,
      session_id: plan.launch.sessionId,
      runtime_kind_id: plan.launch.runtime.runtimeKindId,
      provider_id: plan.request.providerId,
      provider_conversation_ref: plan.request.providerConversationRef,
      permission_mode: plan.request.permissionMode,
    },
    evidence: {
      stage: "runtime_launch",
      session: runtimeSession,
      ...(omitLaunchIdempotencyKey
        ? {}
        : { launch_idempotency_key: effectiveLaunchIdempotencyKey }),
      ...(initialPromptAccepted ? { initial_prompt_accepted: true } : {}),
    },
  }, {
    stage: "prompt_delivery",
    attempt: 1,
    inputs: {
      stage: "prompt_delivery",
      session_id: effectiveSessionId,
      prompt_digest: plan.request.promptDigest,
    },
    evidence: {
      stage: "prompt_delivery",
      session_id: effectiveSessionId,
      delivery_id: "delivery-1",
    },
  }];
  value.state = "succeeded";
  value.lastSequence = 8;
  value.recovery = { kind: "none" };
  value.updatedAtMs += 7;
  return value;
}
