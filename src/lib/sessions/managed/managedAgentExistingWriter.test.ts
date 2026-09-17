import { describe, expect, it } from "vitest";
import {
	type ManagedAgentDurableSuccessorSource,
	managedAgentDurableSuccessorSyncPayload,
} from "@/lib/sessions/managed/managedAgentExistingWriter";
import type { ManagedAgentRehostInspection } from "@/lib/sessions/managed/managedAgentRehostInspection";
import { managedBindingFixture } from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const stopFence = {
	runnerPrincipal: "local-user",
	runnerInstance: "runner-existing",
	channelEpoch: "1",
	hostInstanceId: "host-existing",
	terminalEpoch: "terminal-existing",
};

const inspection = {
	agentId: "agent-1",
	agentName: "uiux-scroll-probe",
	projectId: "project-1",
	providerId: "codex",
	sourceBinding: managedBindingFixture({
		sessionId: "session-dead",
		workspaceId: "workspace-1",
		createIdempotencyKey: "create-dead",
	}),
	sourceConversationId: "conversation-1",
	sourceLifecycle: "exited",
	sourcePaneState: "present",
	conversationId: "conversation-1",
	cwd: "/repo/uiux-scroll-probe",
	desktopId: "space-1",
	panelId: "agent:agent-1",
	permissionMode: "bypass_approvals",
	sourcePermissionMode: "bypass_approvals",
	credentialId: "credential-1",
	terminalEnvironment: {},
	backendRouteAuthority: testDureBackendRouteAuthority(
		"dure-local",
		"generation-1",
	),
	accounts: [],
	plan: {
		sessionId: "session-dead",
		sourceBuildId: "old-build",
		targetBuildId: "current-build",
		action: "replace_ai_provider_with_explicit_conversation",
		allowed: true,
		requiresConfirmation: true,
	},
} as ManagedAgentRehostInspection & ManagedAgentDurableSuccessorSource;

const writer = {
	session: {
		sessionId: "session-existing",
		workspaceId: "workspace-1",
		sessionClass: "managed" as const,
		lifecycle: "ready" as const,
		health: "compatible_old_healthy" as const,
		hostBuildVersion: "old-build",
		inputAllowed: true,
		detachOnly: false,
		terminalEpoch: "terminal-existing",
		stopFence,
		outputSeq: "80",
		capabilities: [],
	},
	idempotencyKey: "create-existing",
	conversationId: "conversation-1",
	launchReference: "credential-opaque-1",
	permissionMode: "bypass_approvals" as const,
};

const target = {
	writer,
	launchKind: "exact_resume" as const,
	launchReference: "credential-opaque-1",
	providerConversationRef: "conversation-1",
	targetCredentialId: "credential-1",
};

describe("managed Agent existing writer handoff", () => {
	it("projects the ledger and Host authority into one exact pane binding", () => {
		const payload = managedAgentDurableSuccessorSyncPayload(
			inspection,
			target,
			"rehost-operation-1",
		);

		expect(payload).toMatchObject({
			agentId: "agent-1",
			conversationId: "conversation-1",
			binding: {
				sessionId: "session-existing",
				workspaceId: "workspace-1",
				createIdempotencyKey: "create-existing",
				credentialId: "credential-1",
				stopFence,
			},
		});
	});

	it("refuses a healthy-looking target whose exact conversation changed", () => {
		expect(() =>
			managedAgentDurableSuccessorSyncPayload(
				inspection,
				{
					...target,
					providerConversationRef: "conversation-other",
				},
				"rehost-operation-1",
			),
		).toThrow("existing managed writer lost its exact runtime identity");
	});
});
