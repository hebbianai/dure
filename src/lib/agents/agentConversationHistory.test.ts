import { describe, expect, it } from "vitest";
import {
	conversationHistoryCredentialProfile,
	conversationHistorySourceAuthority,
	managedLiveConversationHistoryAvailable,
	sameConversationHistorySourceAuthority,
} from "@/lib/agents/agentConversationHistory";
import { agentCredentialReferenceId } from "@/lib/agents/agentLaunchCredential";
import {
	hmuxManagedBinding,
	hmuxStandaloneBinding,
	remoteHmuxManagedBinding,
} from "@/lib/terminal/terminalBinding";
import type { Agent, Project } from "@/types";

describe("conversation history credential profile", () => {
	const agent = {
		provider: "codex" as const,
		executionProfile: {
			kind: "credential_reference" as const,
			reference_id: "credential-1",
			credential_generation: "generation-1",
		},
	};
	const accounts = [
		{
			id: "credential-1",
			provider: "codex" as const,
			name: "Work",
			dir: "/private/accounts/codex-work",
		},
	];

	it("resolves the committed profile for local and remote provider history", () => {
		const input = {
			agent,
			accounts,
		};

		expect(
			conversationHistoryCredentialProfile({ ...input, remote: false }),
		).toEqual({
			referenceId: "credential-1",
			directory: "/private/accounts/codex-work",
		});
		expect(
			conversationHistoryCredentialProfile({ ...input, remote: true }),
		).toEqual({
			referenceId: "credential-1",
			directory: ".dure/accounts/codex-work",
		});
	});

	it("uses provider default only when the runtime committed provider default", () => {
		expect(
			conversationHistoryCredentialProfile({
				agent: {
					...agent,
					executionProfile: { kind: "provider_default" },
					credentialId: "credential-1",
				},
				accounts,
				remote: false,
			}),
		).toBeUndefined();
	});

	it("uses the exact persisted SSH profile directory before account registry mapping", () => {
		expect(
			conversationHistoryCredentialProfile({
				agent: {
					...agent,
					runtimeBinding: remoteHmuxManagedBinding(
						"session-1",
						"workspace-1",
						"host-1",
						"bridge-1",
						"create-1",
						undefined,
						"credential-1",
						".dure/accounts/exact-generation-root",
					),
				},
				accounts: [],
				remote: true,
			}),
		).toEqual({
			referenceId: "credential-1",
			directory: ".dure/accounts/exact-generation-root",
		});
	});

	it("recovers the exact credential reference for a persisted pre-profile pane", () => {
		const legacyAgent = {
			provider: "codex" as const,
			credentialId: "credential-1",
		};
		expect(agentCredentialReferenceId(legacyAgent)).toBe("credential-1");
		expect(
			conversationHistoryCredentialProfile({
				agent: legacyAgent,
				accounts,
				remote: false,
			}),
		).toEqual({
			referenceId: "credential-1",
			directory: "/private/accounts/codex-work",
		});
	});

	it("does not fall back when the committed credential reference is absent", () => {
		expect(() =>
			conversationHistoryCredentialProfile({
				agent: {
					...agent,
					executionProfile: {
						kind: "credential_reference",
						reference_id: "missing",
						credential_generation: null,
					},
				},
				accounts,
				remote: false,
			}),
		).toThrow("credential_reference_unavailable");
	});

	it("does not resolve a profile for providers without conversation listing", () => {
		expect(
			conversationHistoryCredentialProfile({
				agent: {
					provider: "kimi",
					executionProfile: {
						kind: "credential_reference",
						reference_id: "missing-kimi-profile",
						credential_generation: "generation-1",
					},
				},
				accounts: [],
				remote: false,
			}),
		).toBeUndefined();
	});
});

describe("managed live conversation history", () => {
	it("is available only for a live local managed source with exact history", () => {
		expect(
			managedLiveConversationHistoryAvailable({
				activity: "waiting",
				binding: hmuxManagedBinding("session", "workspace"),
				projectKind: "local",
				provider: "codex",
			}),
		).toBe(true);
		expect(
			managedLiveConversationHistoryAvailable({
				activity: "exited",
				binding: hmuxManagedBinding("session", "workspace"),
				projectKind: "local",
				provider: "codex",
			}),
		).toBe(false);
		expect(
			managedLiveConversationHistoryAvailable({
				activity: "waiting",
				binding: hmuxStandaloneBinding("session", "workspace"),
				projectKind: "local",
				provider: "codex",
			}),
		).toBe(false);
		expect(
			managedLiveConversationHistoryAvailable({
				activity: "waiting",
				binding: hmuxManagedBinding("session", "workspace"),
				projectKind: "local",
				provider: "amp",
			}),
		).toBe(false);
	});

	it("uses the same provider policy for a live structured source", () => {
		expect(
			managedLiveConversationHistoryAvailable({
				activity: "waiting",
				binding: undefined,
				interactionProfile: {
					schemaVersion: 1,
					kind: "structured_protocol",
					backendProfileId: "local",
					interactionSessionId: "interaction-1",
				},
				projectKind: "local",
				provider: "codex",
			}),
		).toBe(true);
		expect(
			managedLiveConversationHistoryAvailable({
				activity: "waiting",
				binding: undefined,
				interactionProfile: {
					schemaVersion: 1,
					kind: "structured_protocol",
					backendProfileId: "local",
					interactionSessionId: "interaction-1",
				},
				projectKind: "local",
				provider: "amp",
			}),
		).toBe(false);
	});
});

describe("conversation history source authority", () => {
	const project: Project = {
		id: "project-1",
		name: "Project",
		path: "/repo",
		kind: "local",
		isRepo: true,
	};
	const source: Agent = {
		id: "agent-source",
		name: "source",
		displayName: "Before rename",
		provider: "claude",
		projectId: project.id,
		worktreePath: "/repo/.worktrees/source",
		branch: "agent/source",
		sessionId: "agent-source",
		sessionKind: "pty",
		interactionProfile: {
			schemaVersion: 1,
			kind: "structured_protocol",
			backendProfileId: "local",
			interactionSessionId: "interaction-source",
		},
		executionProfile: {
			kind: "credential_reference",
			reference_id: "credential-1",
			credential_generation: "credential-generation-3",
		},
		credentialId: "credential-1",
		conversationId: "conversation-source",
		started: true,
	};

	it("accepts a cloned projection and display-only rename", () => {
		const before = conversationHistorySourceAuthority(source, project);
		const cloned = structuredClone(source);
		cloned.displayName = "After rename";

		expect(
			sameConversationHistorySourceAuthority(
				before,
				conversationHistorySourceAuthority(cloned, { ...project }),
			),
		).toBe(true);
	});

	it("rejects provider, workspace, backend, interaction, and credential-generation changes", () => {
		const before = conversationHistorySourceAuthority(source, project);
		const changes: Agent[] = [
			{ ...source, provider: "codex" },
			{ ...source, worktreePath: "/repo/.worktrees/other" },
			{
				...source,
				interactionProfile: {
					...source.interactionProfile!,
					backendProfileId: "other-backend",
				},
			},
			{
				...source,
				interactionProfile: {
					...source.interactionProfile!,
					interactionSessionId: "interaction-other",
				},
			},
			{
				...source,
				executionProfile: {
					kind: "credential_reference",
					reference_id: "credential-1",
					credential_generation: "credential-generation-4",
				},
			},
		];

		for (const changed of changes) {
			expect(
				sameConversationHistorySourceAuthority(
					before,
					conversationHistorySourceAuthority(changed, project),
				),
			).toBe(false);
		}
	});
});
