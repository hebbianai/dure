import { describe, expect, it } from "vitest";
import {
	agentRuntimeTransitionBackendProfileId,
	projectNativeCliTransition,
	projectRuntimeTransition,
	projectStructuredChatTransition,
	resolveAgentRuntimeProjectionProject,
	supportsStructuredChatTransition,
	supportsStructuredRuntimeTransition,
} from "@/lib/agents/agentRuntimeProfileSwitch";
import { normalizePersistedAgents } from "@/lib/persistence/persistedAgents";
import { remoteHmuxManagedBinding } from "@/lib/terminal/terminalBinding";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";
import type { Agent, AgentRuntimeBindingV1, Project } from "@/types";

const project: Project = {
	id: "project-1",
	name: "Project",
	path: "/workspace",
	kind: "local",
	isRepo: true,
};

const defaultLaunchSelection = {
	model: null,
	effort: null,
	permissionMode: "default" as const,
};

const skipPermissionsLaunchSelection = {
	...defaultLaunchSelection,
	permissionMode: "skip_permissions" as const,
};

function localManagedBinding(credentialId?: string): AgentRuntimeBindingV1 {
	return {
		schemaVersion: 1,
		runtime: "hmux_managed_v1",
		source: "local",
		hostId: "local",
		sessionId: "session-1",
		workspaceId: "workspace-1",
		credentialId,
	};
}

function nativeClaude(): Agent {
	return {
		id: "agent-1",
		name: "agent-1",
		provider: "claude",
		projectId: project.id,
		worktreePath: "/workspace",
		branch: "main",
		sessionId: "session-1",
		sessionKind: "pty",
		runtimeBinding: localManagedBinding("account-a"),
		executionProfile: {
			kind: "credential_reference",
			reference_id: "account-a",
			credential_generation: "credential-a-7",
		},
		accountId: "account-a",
		credentialId: "account-a",
		pendingCredentialSwitch: {
			schemaVersion: 1,
			requestId: "credential-switch-1",
			targetCredentialId: "account-b",
			targetCredentialDirectory: "claude-account-b",
			sourceSessionId: "session-1",
			sourceWorkspaceId: "workspace-1",
			sourceConversationId: "conversation-1",
			sourceCredentialId: "account-a",
			sourceCreateIdempotencyKey: "create-1",
			sourceCredentialGeneration: null,
			sourceTerminalEpoch: "terminal-1",
			baselineRuntimeRevision: "3",
			baselineTurnCompletedCount: "1",
			panelId: "pane-1",
			requestedAtMs: 1,
		},
	};
}

const localProjectionContext = {
	schemaVersion: 1 as const,
	identity: { kind: "registered" as const },
	agent: {
		agentId: "agent-1",
		workspaceId: "workspace-domain-1",
		providerId: "claude" as const,
	},
	workspace: {
		workspaceId: "workspace-domain-1",
		projectId: "project-1",
		rootPath: "/workspace",
	},
	project: {
		projectId: "project-1",
		rootPath: "/workspace",
	},
};

function localRecoveryOptions() {
	return {
		projectionContext: localProjectionContext,
		routeAuthority: testDureBackendRouteAuthority("dure-local", "generation-1"),
		sshHosts: [],
	};
}

describe("agent runtime profile switch", () => {
	it("converges stale workspace metadata to the registered backend identity", () => {
		const agent = { ...nativeClaude(), worktreePath: "/old/workspace" };
		const cachedProject = { ...project, path: "/old/project" };
		const options = localRecoveryOptions();
		const resolved = resolveAgentRuntimeProjectionProject(
			agent, [cachedProject], localProjectionContext, options.routeAuthority,
		);
		const projected = projectRuntimeTransition(
			agent,
			{
				agentId: agent.id,
				providerId: "claude",
				interactionProfile: "structured_protocol",
				launchSelection: defaultLaunchSelection,
				executionProfile: { kind: "provider_default" },
				providerConversationRef: "conversation-1",
				interactionSessionId: "interaction-1",
			},
			"local", resolved, options,
		);

		expect(projected).toMatchObject({
			id: agent.id, projectId: "project-1", worktreePath: "/workspace",
			interactionProfile: { interactionSessionId: "interaction-1" },
		});
		expect(resolved?.path).toBe("/workspace");
		expect(cachedProject.path).toBe("/old/project");
	});

	it("resolves project identity from a registered route-less projection", () => {
		const routeLess = {
			...nativeClaude(),
			projectId: undefined,
			worktreePath: undefined,
		} as unknown as Agent;

		expect(
			resolveAgentRuntimeProjectionProject(
				routeLess,
				[project],
				localProjectionContext,
				localRecoveryOptions().routeAuthority,
			),
		).toEqual(project);
		expect(
			resolveAgentRuntimeProjectionProject(
				routeLess,
				[],
				localProjectionContext,
				testDureBackendRouteAuthority("dure-local", "generation-1"),
			),
		).toEqual({
			id: project.id,
			path: project.path,
			kind: "local",
		});
		expect(
			resolveAgentRuntimeProjectionProject(
				routeLess,
				[],
				{
					...localProjectionContext,
					identity: {
						kind: "checkpoint_bootstrap",
						runtimeWorkspaceId: "workspace-1",
					},
				},
				testDureBackendRouteAuthority("dure-local", "generation-1"),
			),
		).toBeUndefined();
	});

	it("recovers the same route-less Agent from backend-owned project identity", () => {
		const routeLess = {
			...nativeClaude(),
			projectId: undefined,
			worktreePath: undefined,
			runtimeBinding: null,
			conversationId: "conversation-1",
		} as unknown as Agent;
		const authoritative = {
			agentId: "agent-1",
			providerId: "claude" as const,
			interactionProfile: "structured_protocol" as const,
			launchSelection: defaultLaunchSelection,
			executionProfile: {
				kind: "credential_reference" as const,
				reference_id: "hebbian98",
				credential_generation: "credential-hebbian98-2",
			},
			providerConversationRef: "conversation-1",
			interactionSessionId: "interaction-1",
		};
		const recovered = projectRuntimeTransition(
			routeLess,
			authoritative,
			"local",
			project,
			localRecoveryOptions(),
		);

		expect(recovered).toMatchObject({
			id: "agent-1",
			projectId: "project-1",
			worktreePath: "/workspace",
			conversationId: "conversation-1",
			credentialId: "hebbian98",
			interactionProfile: {
				kind: "structured_protocol",
				backendProfileId: "local",
				interactionSessionId: "interaction-1",
			},
		});
	});

	it("keeps route-less recovery closed on missing or mismatched canonical identity", () => {
		const routeLess = {
			...nativeClaude(),
			projectId: undefined,
			worktreePath: undefined,
			runtimeBinding: null,
		} as unknown as Agent;
		const stable = {
			agentId: "agent-1",
			providerId: "claude" as const,
			interactionProfile: "structured_protocol" as const,
			launchSelection: defaultLaunchSelection,
			executionProfile: { kind: "provider_default" as const },
			providerConversationRef: "conversation-1",
			interactionSessionId: "interaction-1",
		};

		expect(() =>
			projectRuntimeTransition(
				routeLess,
				stable,
				"local",
				undefined,
				localRecoveryOptions(),
			),
		).toThrow("client_agent_runtime_transition_conflict");
		expect(() =>
			projectRuntimeTransition(
				{ ...routeLess, provider: "codex" },
				stable,
				"local",
				project,
				localRecoveryOptions(),
			),
		).toThrow("client_agent_runtime_transition_conflict");
		expect(() =>
			projectRuntimeTransition(
				routeLess,
				stable,
				"local",
				{ ...project, path: "/other" },
				localRecoveryOptions(),
			),
		).toThrow("client_agent_runtime_transition_conflict");
		expect(() =>
			projectRuntimeTransition(
				{
					...routeLess,
					runtimeBinding: localManagedBinding(),
					interactionProfile: {
						schemaVersion: 1,
						kind: "structured_protocol",
						backendProfileId: "other",
						interactionSessionId: "interaction-other",
					},
				},
				stable,
				"local",
				project,
				localRecoveryOptions(),
			),
		).toThrow("client_agent_runtime_transition_conflict");
	});

	it("rejects a projection addressed to a different Agent", () => {
		expect(() =>
			projectRuntimeTransition(
				nativeClaude(),
				{
					agentId: "agent-1",
					providerId: "claude",
					interactionProfile: "structured_protocol",
					launchSelection: defaultLaunchSelection,
					executionProfile: { kind: "provider_default" },
					providerConversationRef: "conversation-1",
					interactionSessionId: "interaction-1",
				},
				"local",
				project,
				{
					...localRecoveryOptions(),
					projectionContext: {
						...localProjectionContext,
						agent: {
							...localProjectionContext.agent,
							agentId: "another-agent",
						},
					},
				},
			),
		).toThrow("client_agent_runtime_transition_conflict");
	});

	it("recovers a route-less SSH pane only through its exact registered host", () => {
		const remoteProject: Project = {
			...project,
			id: "project-remote",
			path: "/srv/repo",
			kind: "ssh",
			sshHostId: "registered-host",
		};
		const routeLess = {
			...nativeClaude(),
			projectId: undefined,
			worktreePath: undefined,
			runtimeBinding: null,
			sessionKind: "ssh",
		} as unknown as Agent;
		const routeAuthority = testDureBackendRouteAuthority(
			"dure-remote",
			"generation-1",
			"remote-a",
		);
		const projectionContext = {
			...localProjectionContext,
			workspace: {
				workspaceId: "workspace-domain-1",
				projectId: "project-remote",
				rootPath: "/srv/repo/.worktrees/agent-1",
			},
			project: {
				projectId: "project-remote",
				rootPath: "/srv/repo",
			},
		};
		const registeredHost = {
			id: "registered-host",
			name: "Remote",
			host: "backend.example.test",
			port: 22,
			user: "dure",
			auth: "auto" as const,
		};
		const actionProject = resolveAgentRuntimeProjectionProject(
			routeLess,
			[],
			projectionContext,
			routeAuthority,
			[registeredHost],
		);
		expect(actionProject).toEqual({
			id: remoteProject.id,
			path: remoteProject.path,
			kind: "ssh",
			sshHostId: registeredHost.id,
		});

		const recovered = projectRuntimeTransition(
			routeLess,
			{
				agentId: "agent-1",
				providerId: "claude",
				interactionProfile: "structured_protocol",
				launchSelection: defaultLaunchSelection,
				executionProfile: { kind: "provider_default" },
				providerConversationRef: "conversation-remote-1",
				interactionSessionId: "interaction-remote-1",
			},
			"remote-a",
			actionProject,
			{
				projectionContext,
				routeAuthority,
				sshHosts: [registeredHost],
			},
		);

		expect(recovered).toMatchObject({
			id: "agent-1",
			projectId: "project-remote",
			worktreePath: "/srv/repo/.worktrees/agent-1",
			interactionProfile: {
				kind: "structured_protocol",
				backendProfileId: "remote-a",
			},
		});
		expect(() =>
			resolveAgentRuntimeProjectionProject(
				routeLess,
				[],
				projectionContext,
				routeAuthority,
				[],
			),
		).toThrow("client_agent_runtime_transition_conflict");
	});

	it("discovers the managed route without trusting stale credential projections", () => {
		const agent = nativeClaude();
		expect(supportsStructuredChatTransition(agent, project)).toBe(true);
		expect(
			supportsStructuredChatTransition(
				{
					...agent,
					executionProfile: { kind: "provider_default" },
					accountId: null,
					credentialId: undefined,
					runtimeBinding: localManagedBinding(),
				},
				project,
			),
		).toBe(true);
		expect(
			supportsStructuredChatTransition(
				{ ...agent, provider: "codex" },
				project,
			),
		).toBe(true);
		expect(
			supportsStructuredChatTransition(agent, { ...project, kind: "ssh" }),
		).toBe(false);
		expect(
			supportsStructuredChatTransition(
				{
					...agent,
					credentialId: "account-b",
					runtimeBinding: localManagedBinding("account-b"),
				},
				project,
			),
		).toBe(true);
		expect(
			supportsStructuredChatTransition(
				{
					...agent,
					executionProfile: {
						kind: "credential_reference",
						reference_id: "account-a",
						credential_generation: null,
					},
				},
				project,
			),
		).toBe(true);
	});

	it("lets a stable backend snapshot heal stale credential projections", () => {
		const stale = {
			...nativeClaude(),
			accountId: "account-stale",
			credentialId: "account-stale",
			executionProfile: {
				kind: "credential_reference" as const,
				reference_id: "account-stale",
				credential_generation: null,
			},
			runtimeBinding: localManagedBinding("account-a"),
		};
		const authoritativeExecution = {
			kind: "credential_reference" as const,
			reference_id: "account-b",
			credential_generation: "credential-b-9",
		};

		const projected = projectRuntimeTransition(
			stale,
			{
				agentId: stale.id,
				providerId: "claude",
				interactionProfile: "native_cli",
				launchSelection: skipPermissionsLaunchSelection,
				executionProfile: authoritativeExecution,
				providerConversationRef: "conversation-1",
				sessionId: "session-authoritative",
				workspaceId: "workspace-1",
				launchIdempotencyKey: "launch-authoritative",
				stopFence: {
					runnerPrincipal: "runner-1",
					runnerInstance: "instance-1",
					channelEpoch: "2",
					hostInstanceId: "host-1",
					terminalEpoch: "terminal-2",
				},
			},
			"local",
			project,
		);

		expect(projected.executionProfile).toEqual(authoritativeExecution);
		expect(projected.skipPermissions).toBe(true);
		expect(projected.credentialId).toBe("account-b");
		expect(projected.runtimeBinding).toMatchObject({
			credentialId: "account-b",
			sessionId: "session-authoritative",
		});
	});

	it("converges the same Agent pane on the backend-selected Chat binding", () => {
		const projected = projectStructuredChatTransition(
			nativeClaude(),
			{
				agentId: "agent-1",
				providerId: "claude",
				interactionProfile: "structured_protocol",
				launchSelection: skipPermissionsLaunchSelection,
				executionProfile: {
					kind: "credential_reference",
					reference_id: "account-a",
					credential_generation: "credential-a-7",
				},
				interactionSessionId: "interaction-1",
				providerConversationRef: "conversation-1",
			},
			"local",
		);

		expect(projected.interactionProfile).toEqual({
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId: "local",
			interactionSessionId: "interaction-1",
		});
		expect(projected.runtimeBinding).toBeUndefined();
		expect(projected.executionProfile).toEqual({
			kind: "credential_reference",
			reference_id: "account-a",
			credential_generation: "credential-a-7",
		});
		expect(projected.credentialId).toBe("account-a");
		expect(projected.accountId).toBe("account-a");
		expect(projected.conversationId).toBe("conversation-1");
		expect(projected.pendingCredentialSwitch).toBeUndefined();
		expect(projected.skipPermissions).toBe(true);

		const [rehydrated] = normalizePersistedAgents([projected], [project]);
		expect(rehydrated.interactionProfile).toEqual(projected.interactionProfile);
		expect(rehydrated.runtimeBinding).toBeUndefined();
	});

	it("keeps one Chat interaction and conversation while projecting a credential replacement", () => {
		const source = projectStructuredChatTransition(
			nativeClaude(),
			{
				agentId: "agent-1",
				providerId: "claude",
				interactionProfile: "structured_protocol",
				launchSelection: defaultLaunchSelection,
				executionProfile: {
					kind: "credential_reference",
					reference_id: "account-a",
					credential_generation: "credential-a-7",
				},
				interactionSessionId: "interaction-1",
				providerConversationRef: "conversation-1",
			},
			"local",
		);
		expect(supportsStructuredRuntimeTransition(source, project)).toBe(true);
		expect(
			supportsStructuredRuntimeTransition(
				{
					...source,
					executionProfile: { kind: "provider_default" },
					accountId: null,
					credentialId: undefined,
				},
				project,
			),
		).toBe(true);

		const replaced = projectStructuredChatTransition(
			source,
			{
				agentId: "agent-1",
				providerId: "claude",
				interactionProfile: "structured_protocol",
				launchSelection: defaultLaunchSelection,
				executionProfile: {
					kind: "credential_reference",
					reference_id: "account-b",
					credential_generation: "credential-b-9",
				},
				interactionSessionId: "interaction-1",
				providerConversationRef: "conversation-1",
			},
			"local",
		);

		expect(replaced.interactionProfile).toEqual(source.interactionProfile);
		expect(replaced.conversationId).toBe("conversation-1");
		expect(replaced.executionProfile).toEqual({
			kind: "credential_reference",
			reference_id: "account-b",
			credential_generation: "credential-b-9",
		});
		expect(replaced.credentialId).toBe("account-b");
		expect(replaced.accountId).toBe("account-b");
	});

	it("projects the backend-learned conversation onto the same Terminal pane", () => {
		const source = projectStructuredChatTransition(
			nativeClaude(),
			{
				agentId: "agent-1",
				providerId: "claude",
				interactionProfile: "structured_protocol",
				launchSelection: defaultLaunchSelection,
				executionProfile: {
					kind: "credential_reference",
					reference_id: "account-a",
					credential_generation: "credential-a-7",
				},
				interactionSessionId: "interaction-1",
				providerConversationRef: "conversation-1",
			},
			"local",
		);
		expect(supportsStructuredRuntimeTransition(source, project)).toBe(true);

		const projected = projectNativeCliTransition(
			{ ...source, conversationId: undefined },
			{
				agentId: "agent-1",
				providerId: "claude",
				interactionProfile: "native_cli",
				launchSelection: defaultLaunchSelection,
				executionProfile: source.executionProfile!,
				providerConversationRef: "conversation-1",
				sessionId: "runtime-native-1",
				workspaceId: "workspace-1",
				launchIdempotencyKey: "runtime-native-launch-1",
				stopFence: {
					runnerPrincipal: "runner-1",
					runnerInstance: "instance-1",
					channelEpoch: "2",
					hostInstanceId: "host-1",
					terminalEpoch: "terminal-2",
				},
			},
			"local",
			project,
		);

		expect(projected.interactionProfile).toBeUndefined();
		expect(projected.sessionId).toBe("runtime-native-1");
		expect(projected.runtimeBinding).toEqual({
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "local",
			hostId: "local",
			sessionId: "runtime-native-1",
			workspaceId: "workspace-1",
			createIdempotencyKey: "runtime-native-launch-1",
			backendProfileId: "local",
			credentialId: "account-a",
			stopFence: expect.objectContaining({ terminalEpoch: "terminal-2" }),
		});
		expect(projected.conversationId).toBe("conversation-1");

		const [rehydrated] = normalizePersistedAgents([projected], [project]);
		expect(rehydrated.interactionProfile).toBeUndefined();
		expect(rehydrated.sessionId).toBe("runtime-native-1");
		expect(rehydrated.runtimeBinding).toEqual(projected.runtimeBinding);
	});

	it("converges a lost transition response onto the committed native authority", () => {
		const source = { ...nativeClaude(), skipPermissions: true };
		const projected = projectRuntimeTransition(
			source,
			{
				agentId: source.id,
				providerId: "claude",
				interactionProfile: "native_cli",
				launchSelection: defaultLaunchSelection,
				executionProfile: source.executionProfile!,
				providerConversationRef: "conversation-1",
				sessionId: "session-committed-2",
				workspaceId: "workspace-1",
				launchIdempotencyKey: "runtime-native-launch-2",
				stopFence: {
					runnerPrincipal: "runner-2",
					runnerInstance: "instance-2",
					channelEpoch: "2",
					hostInstanceId: "host-2",
					terminalEpoch: "terminal-2",
				},
			},
			"local",
			project,
		);

		expect(projected.sessionId).toBe("session-committed-2");
		expect(projected.runtimeBinding).toMatchObject({
			sessionId: "session-committed-2",
			createIdempotencyKey: "runtime-native-launch-2",
		});
		expect(projected.skipPermissions).toBe(false);
	});

	it("refuses to fabricate native launch authority from a session id", () => {
		const stopFence = {
			runnerPrincipal: "runner-1",
			runnerInstance: "instance-1",
			channelEpoch: "2",
			hostInstanceId: "host-1",
			terminalEpoch: "terminal-2",
		};

		expect(() =>
			projectNativeCliTransition(
				nativeClaude(),
				{
					agentId: "agent-1",
					providerId: "claude",
					interactionProfile: "native_cli",
					launchSelection: defaultLaunchSelection,
					executionProfile: { kind: "provider_default" },
					providerConversationRef: "conversation-1",
					sessionId: "runtime-native-2",
					workspaceId: "workspace-1",
					launchIdempotencyKey: null,
					stopFence,
				},
				"local",
				project,
			),
		).toThrow("client_agent_runtime_transition_conflict");
	});

	it("reuses an existing launch key only for the same exact native generation", () => {
		const stopFence = {
			runnerPrincipal: "runner-1",
			runnerInstance: "instance-1",
			channelEpoch: "2",
			hostInstanceId: "host-1",
			terminalEpoch: "terminal-2",
		};
		const source = {
			...nativeClaude(),
			sessionId: "runtime-native-2",
			runtimeBinding: {
				schemaVersion: 1 as const,
				runtime: "hmux_managed_v1" as const,
				source: "local" as const,
				hostId: "local" as const,
				sessionId: "runtime-native-2",
				workspaceId: "workspace-1",
				createIdempotencyKey: "launch-exact-2",
				stopFence,
			},
		};

		const projected = projectRuntimeTransition(
			source,
			{
				agentId: "agent-1",
				providerId: "claude",
				interactionProfile: "native_cli",
				launchSelection: defaultLaunchSelection,
				executionProfile: { kind: "provider_default" },
				providerConversationRef: "conversation-1",
				sessionId: "runtime-native-2",
				workspaceId: "workspace-1",
				launchIdempotencyKey: null,
				stopFence,
			},
			"local",
			project,
			localRecoveryOptions(),
		);

		expect(projected.runtimeBinding).toMatchObject({
			createIdempotencyKey: "launch-exact-2",
			stopFence,
		});
	});

	it("preserves the exact SSH bridge and credential profile during checkpoint adoption", () => {
		const remoteProject: Project = {
			...project,
			id: "project-remote",
			path: "/srv/repo",
			kind: "ssh",
			sshHostId: "registered-host",
		};
		const stopFence = {
			runnerPrincipal: "remote-user",
			runnerInstance: "runner-1",
			channelEpoch: "8",
			hostInstanceId: "host-remote-1",
			terminalEpoch: "terminal-remote-1",
		};
		const source: Agent = {
			...nativeClaude(),
			projectId: remoteProject.id,
			worktreePath: remoteProject.path,
			sessionId: "session-remote-1",
			sessionKind: "ssh",
			runtimeBinding: remoteHmuxManagedBinding(
				"session-remote-1",
				"workspace-remote-1",
				"registered-host",
				"exact-bridge-nonce",
				"create-remote-1",
				stopFence,
				"account-a",
				".dure/accounts/claude-account-a",
				"remote-a",
			),
		};

		const projected = projectRuntimeTransition(
			source,
			{
				agentId: source.id,
				providerId: "claude",
				interactionProfile: "native_cli",
				launchSelection: skipPermissionsLaunchSelection,
				executionProfile: {
					kind: "credential_reference",
					reference_id: "account-a",
					credential_generation: null,
				},
				providerConversationRef: "conversation-1",
				sessionId: "session-remote-1",
				workspaceId: "workspace-remote-1",
				launchIdempotencyKey: null,
				stopFence,
			},
			"remote-a",
			remoteProject,
			{
				projectionContext: {
					...localProjectionContext,
					identity: {
						kind: "checkpoint_bootstrap",
						runtimeWorkspaceId: "workspace-remote-1",
					},
					workspace: { ...localProjectionContext.workspace, rootPath: remoteProject.path },
					project: { ...localProjectionContext.project, rootPath: remoteProject.path },
				},
				routeAuthority: testDureBackendRouteAuthority("dure-remote", "generation-1", "remote-a"),
				sshHosts: [{
					id: "registered-host", name: "Remote", host: "backend.example.test",
					port: 22, user: "dure", auth: "auto",
				}],
			},
		);

		expect(projected.runtimeBinding).toMatchObject({
			commandBridgeNonce: "exact-bridge-nonce",
			createIdempotencyKey: "create-remote-1",
			credentialId: "account-a",
			credentialProfileDirectory: ".dure/accounts/claude-account-a",
			stopFence,
		});
		expect(projected.skipPermissions).toBe(true);
	});

	it("projects a corrected Native profile and credential after its source stopped", () => {
		const source = projectStructuredChatTransition(
			nativeClaude(),
			{
				agentId: "agent-1",
				providerId: "claude",
				interactionProfile: "structured_protocol",
				launchSelection: defaultLaunchSelection,
				executionProfile: {
					kind: "credential_reference",
					reference_id: "account-a",
					credential_generation: "credential-a-7",
				},
				interactionSessionId: "interaction-1",
				providerConversationRef: "conversation-1",
			},
			"local",
		);
		const correctedExecution = {
			kind: "credential_reference" as const,
			reference_id: "account-b",
			credential_generation: "credential-b-9",
		};

		const projected = projectRuntimeTransition(
			source,
			{
				agentId: source.id,
				providerId: "claude",
				interactionProfile: "native_cli",
				launchSelection: defaultLaunchSelection,
				executionProfile: correctedExecution,
				providerConversationRef: "conversation-1",
				sessionId: "session-corrected-2",
				workspaceId: "workspace-1",
				launchIdempotencyKey: "runtime-native-corrected-2",
				stopFence: {
					runnerPrincipal: "runner-2",
					runnerInstance: "instance-2",
					channelEpoch: "2",
					hostInstanceId: "host-2",
					terminalEpoch: "terminal-2",
				},
			},
			"local",
			project,
		);

		expect(projected.interactionProfile).toBeUndefined();
		expect(projected.executionProfile).toEqual(correctedExecution);
		expect(projected.credentialId).toBe("account-b");
		expect(projected.runtimeBinding).toMatchObject({
			sessionId: "session-corrected-2",
			credentialId: "account-b",
		});
	});

	it("rejects a receipt for a different logical Agent", () => {
		expect(() =>
			projectStructuredChatTransition(
				nativeClaude(),
				{
					agentId: "agent-other",
					providerId: "claude",
					interactionProfile: "structured_protocol",
					launchSelection: defaultLaunchSelection,
					executionProfile: { kind: "provider_default" },
					interactionSessionId: "interaction-other",
					providerConversationRef: "conversation-other",
				},
				"local",
			),
		).toThrow("client_agent_runtime_transition_conflict");
	});

	it("round-trips one SSH Agent through Chat without losing its backend route", () => {
		const remoteProject: Project = {
			...project,
			id: "project-remote",
			path: "/srv/repo",
			kind: "ssh",
			sshHostId: "registered-host",
		};
		const remoteBinding = remoteHmuxManagedBinding(
			"session-remote-1",
			"workspace-remote-1",
			"registered-host",
			"bridge-agent-1",
			"create-remote-1",
			undefined,
			"account-a",
			undefined,
			"remote-a",
		);
		const source: Agent = {
			...nativeClaude(),
			projectId: remoteProject.id,
			worktreePath: remoteProject.path,
			sessionKind: "ssh",
			runtimeBinding: remoteBinding,
		};
		expect(agentRuntimeTransitionBackendProfileId(source, remoteProject)).toBe(
			"remote-a",
		);
		expect(supportsStructuredChatTransition(source, remoteProject)).toBe(true);
		expect(
			supportsStructuredChatTransition(
				{
					...source,
					runtimeBinding: {
						...remoteBinding,
						backendProfileId: undefined,
					},
				},
				remoteProject,
			),
		).toBe(false);

		const chat = projectStructuredChatTransition(
			source,
			{
				agentId: source.id,
				providerId: "claude",
				interactionProfile: "structured_protocol",
				launchSelection: defaultLaunchSelection,
				executionProfile: source.executionProfile!,
				interactionSessionId: "interaction-remote-1",
				providerConversationRef: "conversation-remote-1",
			},
			"remote-a",
		);
		expect(supportsStructuredRuntimeTransition(chat, remoteProject)).toBe(true);
		const [rehydratedChat] = normalizePersistedAgents([chat], [remoteProject]);
		expect(rehydratedChat.interactionProfile).toEqual(chat.interactionProfile);
		expect(rehydratedChat.runtimeBinding).toBeUndefined();
		expect(rehydratedChat.id).toBe(source.id);
		expect(rehydratedChat.conversationId).toBe("conversation-remote-1");

		const terminal = projectNativeCliTransition(
			rehydratedChat,
			{
				agentId: rehydratedChat.id,
				providerId: "claude",
				interactionProfile: "native_cli",
				launchSelection: defaultLaunchSelection,
				executionProfile: rehydratedChat.executionProfile!,
				providerConversationRef: "conversation-remote-1",
				sessionId: "runtime-remote-2",
				workspaceId: "workspace-remote-1",
				launchIdempotencyKey: "launch-remote-2",
				stopFence: {
					runnerPrincipal: "remote-user",
					runnerInstance: "runner-2",
					channelEpoch: "2",
					hostInstanceId: "host-2",
					terminalEpoch: "terminal-2",
				},
			},
			"remote-a",
			remoteProject,
		);

		expect([source.id, chat.id, terminal.id]).toEqual([
			"agent-1",
			"agent-1",
			"agent-1",
		]);
		expect(chat.conversationId).toBe("conversation-remote-1");
		expect(terminal.conversationId).toBe("conversation-remote-1");
		expect(terminal).toMatchObject({
			sessionId: "runtime-remote-2",
			sessionKind: "ssh",
			runtimeBinding: {
				source: "ssh",
				hostId: "registered-host",
				backendProfileId: "remote-a",
				credentialId: "account-a",
			},
		});
		const [rehydrated] = normalizePersistedAgents([terminal], [remoteProject]);
		expect(rehydrated.id).toBe(source.id);
		expect(rehydrated.conversationId).toBe("conversation-remote-1");
		expect(rehydrated.runtimeBinding).toEqual(terminal.runtimeBinding);
	});
});
