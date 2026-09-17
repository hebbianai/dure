import { describe, expect, it } from "vitest";
import { normalizePersistedAgents } from "@/lib/persistence/persistedAgents";
import type { Agent, ProviderConversationIdentityBindingV1 } from "@/types";

const agent = {
	id: "agent-1",
	name: "Agent",
	provider: "codex",
	projectId: "project-1",
	worktreePath: "/tmp/project",
	branch: "main",
	sessionId: "session-1",
	sessionKind: "pty",
} satisfies Agent;

const provenance = {
	schemaVersion: 1,
	workspaceId: "workspace-1",
	sessionId: "session-1",
	runnerPrincipal: "local-user",
	runnerInstance: "runner-1",
	channelEpoch: "1",
	hostInstanceId: "host-1",
	terminalEpoch: "terminal-1",
	revision: "1",
	observedThroughOutputSeq: "4",
	providerId: "codex",
	conversationId: "conversation-1",
	source: "provider_event",
} satisfies ProviderConversationIdentityBindingV1;

function managedBinding(
	conversationIdentity: unknown = provenance,
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		runtime: "hmux_managed_v1",
		source: "local",
		hostId: "local",
		sessionId: "session-1",
		workspaceId: "workspace-1",
		conversationIdentity,
	};
}

describe("normalizePersistedAgents", () => {
	it("returns no agents for non-array persisted input", () => {
		expect(normalizePersistedAgents({})).toEqual([]);
	});

	it("normalizes the optional display name without changing the launch name", () => {
		const [renamed, reset] = normalizePersistedAgents([
			{ ...agent, displayName: "  Release QA  " },
			{ ...agent, id: "agent-2", displayName: "Agent" },
		]);

		expect(renamed).toMatchObject({ name: "Agent", displayName: "Release QA" });
		expect(reset).toMatchObject({ name: "Agent" });
		expect(reset.displayName).toBeUndefined();
	});

	it("drops invalid canonical provenance instead of downgrading it to legacy", () => {
		const normalized = normalizePersistedAgents([
			{
				...agent,
				canonicalSpawn: {
					schemaVersion: 1,
					backendProfileId: "local",
					operationId: "spawn-operation-1",
				},
			},
			{
				...agent,
				id: "agent-2",
				canonicalSpawn: {
					schemaVersion: 1,
					backendProfileId: "local",
					operationId: "spawn-operation-1",
					backendGeneration: "stale",
				},
			},
			{
				...agent,
				id: "agent-future",
				canonicalSpawn: {
					schemaVersion: 2,
					backendProfileId: "local",
					operationId: "spawn-future",
				},
			},
			{ ...agent, id: "agent-3" },
		]);
		const [exact, legacy] = normalized;

		expect(exact.canonicalSpawn).toEqual({
			schemaVersion: 1,
			backendProfileId: "local",
			operationId: "spawn-operation-1",
		});
		expect(normalized.map((entry) => entry.id)).toEqual(["agent-1", "agent-3"]);
		expect("canonicalSpawn" in legacy).toBe(false);
	});

	it("preserves an exact remote managed binding across restart", () => {
		const [normalized] = normalizePersistedAgents([
			{
				...agent,
				sessionKind: "ssh",
				conversationId: "remote-conversation",
				runtimeBinding: {
					schemaVersion: 1,
					runtime: "hmux_managed_v1",
					source: "ssh",
					hostId: "host-remote",
					sessionId: "session-1",
					workspaceId: "workspace-remote",
					createIdempotencyKey: "create-remote",
					commandBridgeNonce: "bridge-remote",
					backendProfileId: "remote-a",
				},
			},
		]);

		expect(normalized.runtimeBinding).toEqual({
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "host-remote",
			sessionId: "session-1",
			workspaceId: "workspace-remote",
			createIdempotencyKey: "create-remote",
			commandBridgeNonce: "bridge-remote",
			backendProfileId: "remote-a",
		});
		expect(normalized.conversationId).toBe("remote-conversation");
	});

	it("keeps a remote Host report coherent with its convenience id", () => {
		const remoteProvenance = {
			...provenance,
			workspaceId: "workspace-remote",
			runnerPrincipal: "remote-user",
		};
		const [normalized] = normalizePersistedAgents([
			{
				...agent,
				sessionKind: "ssh",
				conversationId: "conversation-1",
				runtimeBinding: {
					schemaVersion: 1,
					runtime: "hmux_managed_v1",
					source: "ssh",
					hostId: "host-remote",
					sessionId: "session-1",
					workspaceId: "workspace-remote",
					createIdempotencyKey: "create-remote",
					commandBridgeNonce: "bridge-remote",
					stopFence: {
						runnerPrincipal: remoteProvenance.runnerPrincipal,
						runnerInstance: remoteProvenance.runnerInstance,
						channelEpoch: remoteProvenance.channelEpoch,
						hostInstanceId: remoteProvenance.hostInstanceId,
						terminalEpoch: remoteProvenance.terminalEpoch,
					},
					conversationIdentity: remoteProvenance,
				},
			},
		]);

		expect(normalized.conversationId).toBe("conversation-1");
		expect(normalized.runtimeBinding).toMatchObject({
			conversationIdentity: remoteProvenance,
		});
	});

	it("keeps coherent Host provenance and its matching convenience id", () => {
		const [normalized] = normalizePersistedAgents([
			{
				...agent,
				conversationId: "conversation-1",
				runtimeBinding: managedBinding(),
			},
		]);
		const binding = normalized.runtimeBinding;

		expect(normalized.conversationId).toBe("conversation-1");
		expect(binding?.runtime).toBe("hmux_managed_v1");
		if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "local") {
			throw new Error("expected managed binding");
		}
		expect(binding.conversationIdentity).toEqual(provenance);
	});

	it("clears both values when persisted provenance and convenience id differ", () => {
		const [normalized] = normalizePersistedAgents([
			{
				...agent,
				conversationId: "conversation-stale",
				runtimeBinding: managedBinding(),
			},
		]);
		const binding = normalized.runtimeBinding;

		expect(normalized.conversationId).toBeUndefined();
		if (binding?.runtime !== "hmux_managed_v1" || binding.source !== "local") {
			throw new Error("expected managed binding");
		}
		expect(binding.conversationIdentity).toBeUndefined();
	});

	it("clears malformed explicit provenance without discarding legacy ids", () => {
		const [malformed, legacy] = normalizePersistedAgents([
			{
				...agent,
				conversationId: "conversation-1",
				runtimeBinding: managedBinding({
					...provenance,
					channelEpoch: "0",
				}),
			},
			{
				...agent,
				id: "agent-2",
				conversationId: "legacy-conversation",
			},
		]);

		expect(malformed.conversationId).toBeUndefined();
		expect(legacy.conversationId).toBe("legacy-conversation");
	});

	it("keeps only complete deferred credential replacement fences", () => {
		const pendingCredentialSwitch = {
			schemaVersion: 1 as const,
			requestId: "deferred-1",
			targetCredentialId: "account-crispy",
			targetCredentialDirectory: "/profiles/codex-crispy",
			sourceSessionId: "session-1",
			sourceWorkspaceId: "workspace-1",
			sourceConversationId: "conversation-1",
			sourceCredentialId: null,
			sourceCreateIdempotencyKey: "create-1",
			sourceCredentialGeneration: null,
			sourceTerminalEpoch: "terminal-1",
			baselineRuntimeRevision: "9",
			baselineTurnCompletedCount: "4",
			panelId: "agent:agent-1",
			requestedAtMs: 1234,
		};
		const [
			valid,
			replayable,
			legacyReason,
			malformed,
			partialCheckpoint,
			orphanReason,
		] = normalizePersistedAgents([
			{ ...agent, pendingCredentialSwitch },
			{
				...agent,
				id: "agent-replayable",
				pendingCredentialSwitch: {
					...pendingCredentialSwitch,
					completionRuntimeRevision: "10",
					completionTurnCompletedCount: "4",
					completionReason: "user_requested",
				},
			},
			{
				...agent,
				id: "agent-legacy-reason",
				pendingCredentialSwitch: {
					...pendingCredentialSwitch,
					completionRuntimeRevision: "10",
					completionTurnCompletedCount: "4",
					completionReason: "credential_unavailable",
				},
			},
			{
				...agent,
				id: "agent-2",
				pendingCredentialSwitch: {
					...pendingCredentialSwitch,
					baselineTurnCompletedCount: "not-a-counter",
				},
			},
			{
				...agent,
				id: "agent-3",
				pendingCredentialSwitch: {
					...pendingCredentialSwitch,
					completionRuntimeRevision: "10",
				},
			},
			{
				...agent,
				id: "agent-4",
				pendingCredentialSwitch: {
					...pendingCredentialSwitch,
					completionReason: "user_requested",
				},
			},
		]);

		expect(valid.pendingCredentialSwitch).toEqual(pendingCredentialSwitch);
		expect(replayable.pendingCredentialSwitch).toMatchObject({
			completionReason: "user_requested",
		});
		expect(legacyReason.pendingCredentialSwitch).toBeUndefined();
		expect(malformed.pendingCredentialSwitch).toBeUndefined();
		expect(partialCheckpoint.pendingCredentialSwitch).toBeUndefined();
		expect(orphanReason.pendingCredentialSwitch).toBeUndefined();
	});

	it("keeps only a complete workflow Dispatch generation link", () => {
		const digest = "d".repeat(64);
		const [valid, malformed] = normalizePersistedAgents([
			{
				...agent,
				workflowDispatch: {
					schemaVersion: 1,
					taskId: `task.${digest}`,
					dispatchId: `dispatch.${digest}`,
					generation: 1,
				},
			},
			{
				...agent,
				id: "agent-2",
				workflowDispatch: {
					schemaVersion: 1,
					taskId: `task.${digest}`,
					dispatchId: `dispatch.${digest}`,
					generation: 0,
				},
			},
		]);

		expect(valid.workflowDispatch).toMatchObject({ generation: 1 });
		expect(malformed.workflowDispatch).toBeUndefined();
	});

	it("keeps only an exact non-secret execution profile projection", () => {
		const [exact, malformed, legacy] = normalizePersistedAgents([
			{
				...agent,
				executionProfile: {
					kind: "credential_reference",
					reference_id: "account-work",
					credential_generation: "credential-v1",
				},
			},
			{
				...agent,
				id: "agent-2",
				executionProfile: {
					kind: "credential_reference",
					reference_id: "account-work",
				},
			},
			{ ...agent, id: "agent-3" },
		]);

		expect(exact.executionProfile).toEqual({
			kind: "credential_reference",
			reference_id: "account-work",
			credential_generation: "credential-v1",
		});
		expect(malformed.executionProfile).toBeUndefined();
		expect(legacy.executionProfile).toBeUndefined();
	});

	it("keeps only a non-conflicting structured Chat projection", () => {
		const [structured, malformed] = normalizePersistedAgents(
			[
				{
					...agent,
					provider: "claude",
					interactionProfile: {
						schemaVersion: 1,
						kind: "structured_protocol",
						backendProfileId: "local",
						interactionSessionId: "interaction-1",
					},
				},
				{
					...agent,
					id: "agent-malformed-chat",
					interactionProfile: {
						schemaVersion: 1,
						kind: "structured_protocol",
						backendProfileId: "local",
						interactionSessionId: "interaction-1",
						providerSocket: "/tmp/private.sock",
					},
				},
			],
			[
				{
					id: "project-1",
					name: "repo",
					path: "/tmp/project",
					kind: "local",
					isRepo: true,
				},
			],
		);

		expect(structured.interactionProfile).toEqual({
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId: "local",
			interactionSessionId: "interaction-1",
		});
		expect(structured.runtimeBinding).toBeUndefined();
		expect(malformed.interactionProfile).toBeUndefined();
	});
});

describe("legacy runtime retirement", () => {
	it("promotes a bindingless native record when its project still exists", () => {
		const projects = [
			{
				id: "project-1",
				name: "repo",
				path: "/tmp/project",
				kind: "local" as const,
				isRepo: true,
			},
		];
		const [local] = normalizePersistedAgents(
			[
				{
					...agent,
					conversationId: "conversation-1",
				},
			],
			projects,
		);

		expect(local.runtimeBinding).toMatchObject({
			runtime: "hmux_managed_v1",
			source: "local",
			workspaceId: "project-1",
			sessionId: "session-1",
			createIdempotencyKey: "session-1",
		});
		expect(local.conversationId).toBe("conversation-1");
	});

	it("promotes persisted legacy records onto the managed runtime for their project", () => {
		const projects = [
			{
				id: "project-1",
				name: "repo",
				path: "/tmp/project",
				kind: "local" as const,
				isRepo: true,
			},
			{
				id: "project-ssh",
				name: "remote",
				path: "/srv/repo",
				kind: "ssh" as const,
				sshHostId: "host-1",
				isRepo: true,
			},
		];
		const [local, ssh] = normalizePersistedAgents(
			[
				{
					...agent,
					runtimeBinding: {
						schemaVersion: 1,
						runtime: "legacy_session_v1",
						source: "local",
						hostId: "local",
						sessionId: "session-1",
					},
				},
				{
					...agent,
					id: "agent-ssh",
					projectId: "project-ssh",
					sessionId: "session-ssh",
					sessionKind: "ssh",
					runtimeBinding: {
						schemaVersion: 1,
						runtime: "legacy_ssh_session_v1",
						source: "ssh",
						hostId: "host-1",
						sessionId: "session-ssh",
					},
				},
			],
			projects,
		);

		expect(local.runtimeBinding).toMatchObject({
			runtime: "hmux_managed_v1",
			source: "local",
			workspaceId: "project-1",
			sessionId: "session-1",
			createIdempotencyKey: "session-1",
		});
		expect(ssh.runtimeBinding).toMatchObject({
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "host-1",
			workspaceId: "project-ssh",
			commandBridgeNonce: "bridge_session-ssh",
		});
	});

	it("leaves a record without a resolvable project unbound", () => {
		const [orphan] = normalizePersistedAgents(
			[
				{
					...agent,
					projectId: "project-gone",
					runtimeBinding: {
						schemaVersion: 1,
						runtime: "legacy_session_v1",
						source: "local",
						hostId: "local",
						sessionId: "session-1",
					},
				},
			],
			[],
		);
		expect(orphan.runtimeBinding).toBeUndefined();
	});
});
