import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

export function agentRuntimeProjectionContext(agentId = "agent-1", providerId = "claude") {
	return {
		schemaVersion: 1,
		identity: { kind: "registered" },
		agent: { agentId, workspaceId: "workspace-domain-1", providerId },
		workspace: {
			workspaceId: "workspace-domain-1",
			projectId: "project-1",
			rootPath: "/repo/.worktrees/agent-1",
		},
		project: { projectId: "project-1", rootPath: "/repo" },
	};
}

export function agentRuntimeBackendEnvelope(overrides?: { agentId?: string }) {
	const agentId = overrides?.agentId ?? "agent-1";
	const executionProfile = {
		kind: "credential_reference" as const,
		reference_id: "account-a",
		credential_generation: "credential-a-7",
	};
	return {
		schemaVersion: 1,
		backendId: "dure-local",
		backendGeneration: "backend-1",
		routeAuthority: testDureBackendRouteAuthority("dure-local", "backend-1"),
		result: {
			schemaVersion: 1,
			receipt: {
				schemaVersion: 1,
				agentId,
				selectionRevision: 1,
				providerId: "claude",
				executionProfile,
				permissionMode: "default",
				providerConversationRef: "conversation-1",
				launchIdempotencyKey: null,
				authority: {
					interactionProfile: "structured_protocol",
					binding: {
						schemaVersion: 1,
						interactionSessionId: "interaction-1",
						agentId,
						providerId: "claude",
						executionProfile,
						providerConversationRef: "conversation-1",
						runtime: {
							runtimeGeneration: "runtime-1",
							providerEpoch: "provider-1",
						},
						timelineEpoch: "timeline-1",
						bindingRevision: 1,
						historyComplete: true,
						createdAtMs: 1,
						updatedAtMs: 1,
					},
				},
			},
		},
	};
}

export function nativeRuntimeReceipt(
	executionProfile:
		| { kind: "provider_default" }
		| {
				kind: "credential_reference";
				reference_id: string;
				credential_generation: string | null;
		  },
	selectionRevision = 1,
	launchIdempotencyKey: string | null = null,
) {
	return {
		schemaVersion: 1,
		agentId: "agent-1",
		selectionRevision,
		providerId: "claude",
		executionProfile,
		permissionMode: "default",
		providerConversationRef: "conversation-1",
		launchIdempotencyKey,
		authority: {
			interactionProfile: "native_cli",
			authority: {
				schemaVersion: 1,
				binding: {
					agentId: "agent-1",
					runtimeKindId: "runtime.hmux",
					sessionId: "runtime-native-1",
					providerConversationId: "conversation-1",
					credentialReferenceId:
						executionProfile.kind === "credential_reference"
							? executionProfile.reference_id
							: null,
					bindingGeneration: 1,
					boundAtMs: 1,
				},
				runtimeWorkspaceId: "workspace-1",
				runnerPrincipal: "runner-1",
				runnerInstance: "instance-1",
				channelEpoch: "1",
				hostInstanceId: "host-1",
				terminalEpoch: "terminal-1",
				updatedAtMs: 1,
			},
		},
	};
}
