import { describe, expect, it, vi } from "vitest";
import { presentManagedRunInBackground } from "@/lib/cli/managedRunBackgroundPresentation";
import type { DureNativeAgentRunResultV1 } from "@/lib/ipc/dureAgentRun";
import { hmuxManagedBinding } from "@/lib/terminal/terminalBinding";
import type { Agent, Project } from "@/types";

const project: Project = {
	id: "p1",
	name: "P",
	path: "/tmp/p",
	kind: "local",
	isRepo: true,
};

const run: DureNativeAgentRunResultV1 = {
	schemaVersion: 1,
	backend: { id: "backend-1", generation: "1" } as never,
	operationId: "op-1",
	agentId: "agent-1",
	agentName: "fix-x",
	projectId: "p1",
	providerId: "claude",
	executionProfile: { kind: "provider_default" },
	providerConversationRef: null,
	interactionProfile: "native_cli",
	preparedSessionId: "s1",
	sessionId: "s1",
	launchIdempotencyKey: "spawn-runtime:op-1",
	workspaceId: "w1",
	worktree: {
		kind: "dedicated",
		branch: "agent/fix-x",
		directoryName: "fix-x",
	},
	generation: {
		runnerPrincipal: "runner-principal",
		runnerInstance: "runner-instance",
		channelEpoch: "1",
		hostInstanceId: "host-instance",
		terminalEpoch: "terminal-epoch",
	},
	permissionMode: "default",
};

interface FakeState {
	agents: Agent[];
	projects: Project[];
	sshHosts: never[];
	spaces: never[];
	agentActivity: Record<string, string>;
	sessionCwd: Record<string, string>;
	stats: { agentsStarted: number };
}

function makeDeps(initialAgents: Agent[] = []) {
	// A `let` reassigned on every setState — not an object mutated in place —
	// mirrors real Zustand: `useStore.setState(...)` replaces the state
	// object, it does not patch the previous one. That distinction is what
	// makes the "fresh state after ensureProject" test below meaningful: a
	// reference captured before a later setState call stays observably
	// stale, exactly as it would against the real store.
	let state: FakeState = {
		agents: initialAgents,
		projects: [project],
		sshHosts: [],
		spaces: [],
		agentActivity: {},
		sessionCwd: {},
		stats: { agentsStarted: 0 },
	};
	const setState = vi.fn((producer: (s: FakeState) => Partial<FakeState>) => {
		state = { ...state, ...producer(state) };
	});
	return {
		getState: () => state,
		deps: {
			inspectBinding: vi.fn().mockResolvedValue({
				...hmuxManagedBinding(run.sessionId, run.workspaceId),
				createIdempotencyKey: `spawn-runtime:${run.operationId}`,
			}),
			ensureProject: vi.fn().mockResolvedValue(project),
			readState: () => state,
			setState,
		},
	};
}

describe("presentManagedRunInBackground", () => {
	it("projects the agent into the store without any pane step", async () => {
		const { getState, deps } = makeDeps();
		const agent = await presentManagedRunInBackground(
			run,
			{ projectPath: project.path },
			deps as never,
		);
		expect(agent.id).toBe("agent-1");
		expect(agent.accountId).toBeNull();
		expect(agent.runtimeBinding).not.toHaveProperty("credentialId");
		expect(getState().agents).toHaveLength(1);
		expect(getState().agentActivity["agent-1"]).toBe("connecting");
	});

	it("projects the backend-selected credential into the Agent and native binding", async () => {
		const { getState, deps } = makeDeps();
		const credentialRun: DureNativeAgentRunResultV1 = {
			...run,
			executionProfile: {
				kind: "credential_reference",
				reference_id: "account-work",
				credential_generation: "credential-v2",
			},
		};

		const agent = await presentManagedRunInBackground(
			credentialRun,
			{ projectPath: project.path },
			deps as never,
		);

		expect(agent).toMatchObject({
			accountId: "account-work",
			credentialId: "account-work",
			runtimeBinding: { credentialId: "account-work" },
		});
		expect(getState().agents[0]).toEqual(agent);
	});

	it("projects an exact resumed native run into the source Agent's workspace", async () => {
		const source: Agent = {
			id: "agent-source",
			name: "source",
			provider: "claude",
			projectId: project.id,
			worktreePath: "/tmp/p/.worktrees/source",
			branch: "agent/source",
			sessionId: "source-session",
			sessionKind: "pty",
			started: true,
		};
		const { getState, deps } = makeDeps([source]);
		deps.inspectBinding.mockResolvedValue({
			...hmuxManagedBinding(run.sessionId, "workspace-source"),
			createIdempotencyKey: `spawn-runtime:${run.operationId}`,
		});
		const agent = await presentManagedRunInBackground(
			{
				...run,
				providerConversationRef: "threads/2026-08-30:turn_1",
				workspaceId: "workspace-source",
				worktree: {
					kind: "existing_workspace",
					sourceAgentId: source.id,
					rootPath: source.worktreePath,
				},
			},
			{ projectPath: project.path },
			deps as never,
		);

		expect(agent).toMatchObject({
			worktreePath: source.worktreePath,
			branch: source.branch,
			conversationId: "threads/2026-08-30:turn_1",
		});
		expect(getState().agents).toContainEqual(source);
	});

	it("keeps the resumed workspace snapshot when the source is removed during inspection", async () => {
		const source: Agent = {
			id: "agent-source",
			name: "source",
			provider: "claude",
			projectId: project.id,
			worktreePath: "/tmp/p/.worktrees/source",
			branch: "agent/source",
			sessionId: "source-session",
			sessionKind: "pty",
			started: true,
		};
		const { getState, deps } = makeDeps([source]);
		deps.inspectBinding.mockImplementation(async () => {
			deps.setState(() => ({ agents: [] }));
			return {
				...hmuxManagedBinding(run.sessionId, "workspace-source"),
				createIdempotencyKey: `spawn-runtime:${run.operationId}`,
			};
		});

		const agent = await presentManagedRunInBackground(
			{
				...run,
				workspaceId: "workspace-source",
				worktree: {
					kind: "existing_workspace",
					sourceAgentId: source.id,
					rootPath: source.worktreePath,
				},
			},
			{ projectPath: project.path },
			deps as never,
		);

		expect(agent).toMatchObject({
			worktreePath: source.worktreePath,
			branch: source.branch,
		});
		expect(getState().agents).toEqual([agent]);
	});

	it("projects a self-contained resumed workspace after the source is already gone", async () => {
		const { getState, deps } = makeDeps();
		const presentationWorktree = {
			kind: "existing_workspace" as const,
			sourceAgentId: "agent-source",
			rootPath: "/tmp/p/.worktrees/source",
			branch: "agent/source",
		};

		const agent = await presentManagedRunInBackground(
			{
				...run,
				workspaceId: "workspace-source",
				worktree: {
					kind: "existing_workspace",
					sourceAgentId: presentationWorktree.sourceAgentId,
					rootPath: presentationWorktree.rootPath,
				},
			},
			{ projectPath: project.path, presentationWorktree },
			deps as never,
		);

		expect(agent).toMatchObject({
			worktreePath: presentationWorktree.rootPath,
			branch: presentationWorktree.branch,
		});
		expect(getState().agents).toEqual([agent]);
	});

	it("reads fresh state after ensureProject before projecting, not a reference captured before it ran", async () => {
		const { getState, deps } = makeDeps();
		// Stand in for the real ensureProjectForPath, which itself calls the
		// store's setState and so can change state observed elsewhere before
		// it resolves. Bump a field the projection reads straight through
		// `state` (stats.agentsStarted), to a value distinguishable from the
		// initial 0.
		deps.ensureProject.mockImplementation(async () => {
			deps.setState(() => ({ stats: { agentsStarted: 999 } }));
			return project;
		});
		const agent = await presentManagedRunInBackground(
			run,
			{ projectPath: project.path },
			deps as never,
		);
		// projectManagedRunPresentationAgent's "created" patch spreads the
		// state it was handed and increments agentsStarted by one. An
		// implementation that captured readState() once BEFORE calling
		// ensureProject and reused that stale object for projection would
		// still see 0 here, landing on 1 (0 + 1). Only a readState() call made
		// AFTER ensureProject observes the 999 that ensureProject caused, and
		// lands on 1000 (999 + 1).
		expect(agent.id).toBe("agent-1");
		expect(getState().stats.agentsStarted).toBe(1000);
	});

	it("reuses the exact projection when pane attachment failed and the session has since exited", async () => {
		const binding = {
			...hmuxManagedBinding(
				run.sessionId,
				run.workspaceId,
				undefined,
				undefined,
				run.generation,
				"local",
			),
			createIdempotencyKey: run.launchIdempotencyKey,
		};
		const projected: Agent = {
			id: run.agentId,
			canonicalSpawn: {
				schemaVersion: 1,
				backendProfileId: "local",
				operationId: run.operationId,
			},
			name: run.agentName,
			provider: run.providerId,
			projectId: project.id,
			worktreePath: "/tmp/p/.worktrees/fix-x",
			branch: "agent/fix-x",
			sessionId: run.sessionId,
			sessionKind: "pty",
			runtimeBinding: binding,
			started: true,
		};
		const { deps } = makeDeps([projected]);
		deps.inspectBinding.mockRejectedValue(
			new Error("managed Run session is no longer ready"),
		);

		await expect(
			presentManagedRunInBackground(
				run,
				{ projectPath: project.path },
				deps as never,
			),
		).resolves.toBe(projected);
		expect(deps.inspectBinding).not.toHaveBeenCalled();
		expect(deps.setState).not.toHaveBeenCalled();
	});
});
