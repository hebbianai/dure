import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	inspect: vi.fn(),
	transition: vi.fn(),
	register: vi.fn(),
}));

vi.mock("@/lib/ipc/dureAgentRuntime", async (original) => ({
	...(await original<object>()),
	createDureAgentRuntimeClient: () => ({
		inspect: mocks.inspect,
		inspectExact: mocks.inspect,
		transition: mocks.transition,
	}),
}));
vi.mock("@/lib/ipc/dureBackend", async (original) => ({
	...(await original<object>()),
	assertDureBackendRouteAuthority: async () => undefined,
}));
vi.mock("@/lib/ipc/dureProviderCredentialProfile", () => ({
	registerDureProviderCredentialProfile: mocks.register,
}));
vi.mock("@/lib/sessions/managed/managedAgentRehostConvergence", () => ({
	convergeManagedAgentRehost: async () => null,
}));

import { requestAgentCredentialTransition } from "@/lib/agents/agentCredentialTransition";
import {
	projectRuntimeTransition,
	resolveAgentRuntimeProjectionProject,
} from "@/lib/agents/agentRuntimeProfileSwitch";
import { useStore } from "@/store";
import {
	agentFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import { testDureBackendRouteAuthority } from "@/test/dureBackendRouteFixtures";

const project = {
	id: "ide-project",
	name: "Repo",
	path: "/repo",
	kind: "local" as const,
	isRepo: true,
};
const agent = agentFixture({
	projectId: project.id,
	runtimeBinding: managedBindingFixture({
		backendProfileId: "local",
		stopFence: stopFenceFixture(),
	}),
	executionProfile: { kind: "provider_default" },
	conversationId: "conversation-1",
});
const projectionContext = {
	schemaVersion: 1 as const,
	identity: { kind: "registered" as const },
	agent: {
		agentId: agent.id,
		providerId: agent.provider,
		workspaceId: "workspace-1",
	},
	workspace: {
		workspaceId: "workspace-1",
		projectId: "backend-project",
		rootPath: agent.worktreePath,
	},
	project: { projectId: "backend-project", rootPath: project.path },
};
const source = {
	state: "stable" as const,
	agentId: agent.id,
	providerId: agent.provider,
	interactionProfile: "native_cli" as const,
	backend: { id: "dure-local", generation: "generation-1" },
	backendProfileId: "local",
	routeAuthority: testDureBackendRouteAuthority("dure-local", "generation-1"),
	selectionRevision: 12,
	executionProfile: { kind: "provider_default" as const },
	launchSelection: {
		model: null,
		effort: null,
		permissionMode: "default" as const,
	},
	providerConversationRef: "conversation-1",
	sessionId: "session-1",
	workspaceId: "workspace-1",
	launchIdempotencyKey: "create-1",
	stopFence: stopFenceFixture(),
	projectionContext,
};
const targetProfile = {
	kind: "credential_reference" as const,
	reference_id: "account-b",
	credential_generation: "credential-b-1",
};
const target = {
	...source,
	selectionRevision: 13,
	sessionId: "session-2",
	launchIdempotencyKey: "create-2",
	stopFence: stopFenceFixture({
		terminalEpoch: "terminal-2",
		hostInstanceId: "host-2",
	}),
	executionProfile: targetProfile,
};

beforeEach(() => {
	vi.resetAllMocks();
	useStore.setState({
		agents: [agent],
		projects: [project],
		accounts: [
			{
				id: "account-b",
				provider: "codex",
				name: "B",
				dir: "/profiles/codex-b",
			},
		],
		sshHosts: [],
		agentRuntimeLaunchPresentation: {},
	});
	mocks.inspect.mockResolvedValue(source);
	mocks.transition.mockResolvedValue(target);
	mocks.register.mockResolvedValue(targetProfile);
});

const switchAccount = () =>
	requestAgentCredentialTransition({
		agentId: agent.id,
		targetCredentialId: "account-b",
		sourcePanelId: `agent:${agent.id}`,
	});

describe("runtime actions with separate IDE and backend project identities", () => {
	it.each([
		["codex", "bootstrap-workspace", agent.worktreePath],
		["codex", "workspace-1", agent.worktreePath],
		["claude", "bootstrap-workspace", agent.worktreePath],
		["claude", "workspace-1", agent.worktreePath],
		["codex", "bootstrap-workspace", "/repo/.worktrees/first-adopted-agent"],
		["codex", "workspace-1", "/repo/.worktrees/first-adopted-agent"],
		["claude", "bootstrap-workspace", "/repo/.worktrees/first-adopted-agent"],
		["claude", "workspace-1", "/repo/.worktrees/first-adopted-agent"],
	] as const)(
		"switches %s credentials from %s with bootstrap project root %s",
		async (provider, sourceWorkspaceId, bootstrapProjectRoot) => {
			const bootstrapContext = {
				...projectionContext,
				identity: {
					kind: "checkpoint_bootstrap" as const,
					runtimeWorkspaceId: "bootstrap-workspace",
				},
				agent: { ...projectionContext.agent, providerId: provider },
				project: {
					...projectionContext.project,
					rootPath: bootstrapProjectRoot,
				},
			};
			useStore.setState({
				agents: [
					{
						...agent,
						provider,
						runtimeBinding: managedBindingFixture({
							backendProfileId: "local",
							workspaceId: sourceWorkspaceId,
							stopFence: source.stopFence,
						}),
					},
				],
				accounts: [
					{
						id: "account-b",
						provider,
						name: "B",
						dir: `/profiles/${provider}-b`,
					},
				],
			});
			mocks.inspect.mockResolvedValue({
				...source,
				providerId: provider,
				workspaceId: sourceWorkspaceId,
				projectionContext: bootstrapContext,
			});
			mocks.transition.mockResolvedValue({ ...target, providerId: provider });

			await expect(switchAccount()).resolves.toEqual({
				kind: "completed",
				conversationId: "conversation-1",
			});
			expect(mocks.transition).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					agentId: agent.id,
					targetExecutionProfile: targetProfile,
					expectedSourceRevision: source.selectionRevision,
				}),
			);
			expect(useStore.getState().agents[0]).toMatchObject({
				projectId: project.id,
				sessionId: target.sessionId,
				credentialId: "account-b",
				conversationId: "conversation-1",
				runtimeBinding: {
					workspaceId: target.workspaceId,
					stopFence: target.stopFence,
				},
			});
		},
	);

	it("rejects bootstrap provenance for a different Agent worktree before preparing credentials", async () => {
		mocks.inspect.mockResolvedValue({
			...source,
			projectionContext: {
				...projectionContext,
				identity: {
					kind: "checkpoint_bootstrap",
					runtimeWorkspaceId: source.workspaceId,
				},
				project: { ...projectionContext.project, rootPath: agent.worktreePath },
				workspace: {
					...projectionContext.workspace,
					rootPath: "/other/worktree",
				},
			},
		});
		await expect(switchAccount()).rejects.toThrow(
			"client_agent_runtime_transition_conflict",
		);
		expect(mocks.register).not.toHaveBeenCalled();
		expect(mocks.transition).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		"switches credentials and keeps IDE membership when the backend project is also displayed: %s",
		async (backendProjectDisplayed) => {
			const projects = backendProjectDisplayed
				? [project, { ...project, id: projectionContext.project.projectId }]
				: [project];
			useStore.setState({ projects });
			await expect(switchAccount()).resolves.toEqual({
				kind: "completed",
				conversationId: "conversation-1",
			});
			expect(mocks.transition).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({
					agentId: agent.id,
					targetExecutionProfile: targetProfile,
					expectedSourceRevision: 12,
				}),
			);
			expect(useStore.getState().agents[0]).toMatchObject({
				projectId: project.id,
				sessionId: "session-2",
				credentialId: "account-b",
				conversationId: "conversation-1",
			});
			expect(useStore.getState().projects).toEqual(projects);
		},
	);

	it.each([
		[
			"repository",
			{ project: { ...projectionContext.project, rootPath: "/other" } },
		],
		[
			"agent",
			{ agent: { ...projectionContext.agent, agentId: "other-agent" } },
		],
		[
			"provider",
			{ agent: { ...projectionContext.agent, providerId: "claude" } },
		],
	])(
		"rejects a different %s before preparing credentials",
		async (_name, changed) => {
			mocks.inspect.mockResolvedValue({
				...source,
				projectionContext: { ...projectionContext, ...changed },
			});
			await expect(switchAccount()).rejects.toThrow(
				"client_agent_runtime_transition_conflict",
			);
			expect(mocks.register).not.toHaveBeenCalled();
			expect(mocks.transition).not.toHaveBeenCalled();
			expect(useStore.getState().agents[0]).toEqual(agent);
		},
	);

	it("rejects a different backend route before preparing credentials", async () => {
		mocks.inspect.mockResolvedValue({
			...source,
			backendProfileId: "other-backend",
			routeAuthority: { ...source.routeAuthority, profileId: "other-backend" },
		});
		await expect(switchAccount()).rejects.toThrow(
			"client_agent_runtime_transition_conflict",
		);
		expect(mocks.register).not.toHaveBeenCalled();
		expect(mocks.transition).not.toHaveBeenCalled();
	});

	it("projects an SSH alias only through the exact registered host", () => {
		const remoteProject = {
			...project,
			kind: "ssh" as const,
			sshHostId: "saved-host",
		};
		const routeAuthority = testDureBackendRouteAuthority(
			"remote",
			"generation-1",
			"remote-profile",
		);
		const host = {
			id: "saved-host",
			name: "Remote",
			host: "backend.example.test",
			port: 22,
			user: "dure",
			auth: "auto" as const,
		};
		const remoteAgent = {
			...agent,
			runtimeBinding: undefined,
			interactionProfile: {
				schemaVersion: 1 as const,
				kind: "structured_protocol" as const,
				backendProfileId: "remote-profile",
				interactionSessionId: "interaction-1",
			},
		};
		const resolved = resolveAgentRuntimeProjectionProject(
			remoteAgent,
			[remoteProject],
			projectionContext,
			routeAuthority,
			[host],
		);
		const receipt = {
			...target,
			interactionProfile: "structured_protocol" as const,
			interactionSessionId: "interaction-2",
		};
		const options = { projectionContext, routeAuthority, sshHosts: [host] };
		expect(
			projectRuntimeTransition(
				remoteAgent,
				receipt,
				"remote-profile",
				resolved,
				options,
			),
		).toMatchObject({
			projectId: project.id,
			credentialId: "account-b",
			interactionProfile: { interactionSessionId: "interaction-2" },
		});
		expect(() =>
			projectRuntimeTransition(
				remoteAgent,
				receipt,
				"remote-profile",
				resolved,
				{
					...options,
					sshHosts: [{ ...host, host: "another.example.test" }],
				},
			),
		).toThrow("client_agent_runtime_transition_conflict");
	});
});
