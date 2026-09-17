import { describe, expect, it } from "vitest";
import type { DureAgentRuntimeTransitionResultV1 } from "@/lib/ipc/dureAgentRuntime";
import type { ManagedAgentRehostSyncPayload } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import { committedManagedAgentRehostPayload } from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import { managedBindingFixture, stopFenceFixture } from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const routeAuthority = testDureBackendRouteAuthority(
	"backend-final",
	"generation-final",
);
const targetFence = stopFenceFixture({
	runnerPrincipal: "target-principal",
	runnerInstance: "target-runner",
	channelEpoch: "8",
	hostInstanceId: "target-host",
	terminalEpoch: "target-terminal",
});

function payload(
	patch: Partial<ManagedAgentRehostSyncPayload> = {},
): ManagedAgentRehostSyncPayload {
	return {
		schemaVersion: 2,
		operationId: "rehost-operation-1",
		launchKind: "fresh",
		sourcePermissionMode: "default",
		permissionMode: "default",
		agentId: "agent-1",
		agentName: "worker",
		projectId: "project-1",
		providerId: "codex",
		sourceBinding: managedBindingFixture({ sessionId: "session-source" }),
		sourceConversationId: null,
		cwd: "/repo/worktree",
		conversationId: null,
		desktopId: "desktop-1",
		panelId: "agent:agent-1",
		binding: managedBindingFixture({
			sessionId: "session-target",
			credentialId: "account-stale",
			credentialGeneration: 4,
			stopFence: targetFence,
		}),
		targetCredentialId: "account-stale",
		...patch,
	};
}

function backendReceipt(): DureAgentRuntimeTransitionResultV1 {
	return {
		agentId: "agent-1",
		providerId: "codex",
		interactionProfile: "native_cli",
		executionProfile: {
			kind: "credential_reference",
			reference_id: "account-final",
			credential_generation: "credential-generation-final",
		},
		providerConversationRef: "conversation-live",
		sessionId: "session-target",
		workspaceId: "workspace-1",
		launchIdempotencyKey: "create-target",
		stopFence: targetFence,
		backend: routeAuthority.backend,
		backendProfileId: routeAuthority.profileId,
		routeAuthority,
		selectionRevision: 3,
		launchSelection: {
			model: null,
			effort: null,
			permissionMode: "default",
		},
	};
}

describe("managed Agent rehost synchronization projection", () => {
	it("materializes the Control Plane conversation and canonical credential", () => {
		const committed = committedManagedAgentRehostPayload(
			payload(),
			routeAuthority,
			backendReceipt(),
		);

		expect(committed).toMatchObject({
			backendRouteAuthority: routeAuthority,
			conversationId: "conversation-live",
			targetCredentialId: "account-final",
			binding: {
				credentialId: "account-final",
			},
		});
		expect(committed.binding).not.toHaveProperty("credentialGeneration");
	});

	it("preserves a legacy checkpoint binding while materializing its route", () => {
		const requested = payload({
			launchKind: "exact_resume",
			sourceConversationId: "conversation-1",
			conversationId: "conversation-1",
		});

		expect(
			committedManagedAgentRehostPayload(requested, routeAuthority, undefined),
		).toEqual({ ...requested, backendRouteAuthority: routeAuthority });
	});
});
