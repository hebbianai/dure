import { describe, expect, it, vi } from "vitest";
import {
	presentStructuredRun,
	presentStructuredRunInBackground,
	projectStructuredRunAgent,
	type StructuredRunPresentationDependencies,
} from "@/lib/agents/structuredRunPresentation";
import type { CliManagedRunPresentationState } from "@/lib/cli/managedRunPresentationModel";
import type { DureStructuredAgentRunResultV1 } from "@/lib/ipc/dureAgentRun";
import type { Project } from "@/types";

const project: Project = {
	id: "project-1",
	name: "Project",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

const run: DureStructuredAgentRunResultV1 = {
	schemaVersion: 1,
	backend: { id: "dure-local", generation: "generation-1" },
	operationId: "spawn-1",
	agentId: "agent-1",
	agentName: "claude-chat-1",
	projectId: "project-1",
	providerId: "claude",
	executionProfile: { kind: "provider_default" },
	providerConversationRef: null,
	workspaceId: "workspace-1",
	worktree: { kind: "project_root" },
	permissionMode: "default",
	interactionProfile: "structured_protocol",
	backendProfileId: "local",
	interactionSessionId: "interaction-1",
};

function state(): CliManagedRunPresentationState {
	return {
		agents: [],
		projects: [project],
		sshHosts: [],
		spaces: [],
		agentActivity: {},
		sessionCwd: {},
		stats: { agentsStarted: 0, prsCreated: 0, activeMs: 0, since: 0 },
	};
}

describe("projectStructuredRunAgent", () => {
	it("projects the backend-owned Chat profile without a Terminal binding", () => {
		const projected = projectStructuredRunAgent(state(), run, project);

		expect(projected.agent).toMatchObject({
			id: "agent-1",
			canonicalSpawn: {
				schemaVersion: 1,
				backendProfileId: "local",
				operationId: "spawn-1",
			},
			sessionId: "agent-1",
			started: true,
			executionProfile: { kind: "provider_default" },
			interactionProfile: {
				kind: "structured_protocol",
				backendProfileId: "local",
				interactionSessionId: "interaction-1",
			},
		});
		expect(projected.agent.runtimeBinding).toBeUndefined();
		expect(projected.patch.sessionCwd).toEqual({ "agent-1": "/repo" });
	});

	it("converges the same interaction and preserves its pinned credential", () => {
		const credentialRun: DureStructuredAgentRunResultV1 = {
			...run,
			executionProfile: {
				kind: "credential_reference",
				reference_id: "acc-work",
				credential_generation: "credential-v1",
			},
		};
		const first = projectStructuredRunAgent(state(), credentialRun, project);
		const next = state();
		next.agents = [first.agent];

		const replay = projectStructuredRunAgent(next, credentialRun, project);

		expect(replay.outcome).toBe("reused");
		expect(replay.agent).toMatchObject({
			canonicalSpawn: {
				backendProfileId: "local",
				operationId: "spawn-1",
			},
			accountId: "acc-work",
			credentialId: "acc-work",
			executionProfile: {
				kind: "credential_reference",
				reference_id: "acc-work",
				credential_generation: "credential-v1",
			},
		});
	});

	it("backfills legacy projection provenance but refuses another spawn", () => {
		const first = projectStructuredRunAgent(state(), run, project);
		const { canonicalSpawn: _canonicalSpawn, ...legacy } = first.agent;
		const legacyState = state();
		legacyState.agents = [legacy];

		const backfilled = projectStructuredRunAgent(legacyState, run, project);
		expect(backfilled.agent.canonicalSpawn).toEqual({
			schemaVersion: 1,
			backendProfileId: "local",
			operationId: "spawn-1",
		});

		const successorState = state();
		successorState.agents = [backfilled.agent];
		expect(() =>
			projectStructuredRunAgent(
				successorState,
				{ ...run, operationId: "spawn-2" },
				project,
			),
		).toThrow("structured Agent identity");
	});

	it("projects the backend-owned dedicated worktree directory verbatim", () => {
		const projected = projectStructuredRunAgent(
			state(),
			{
				...run,
				worktree: {
					kind: "dedicated",
					branch: "agent/backend-name",
					directoryName: "backend-owned-directory",
				},
			},
			project,
		);

		expect(projected.agent.worktreePath).toBe(
			"/repo/.worktrees/backend-owned-directory",
		);
	});

	it("presents an exact resumed conversation in the source Agent's workspace", () => {
		const source = {
			...projectStructuredRunAgent(state(), run, project).agent,
			id: "agent-source",
			name: "source",
			worktreePath: "/repo/.worktrees/source",
			branch: "agent/source",
		};
		const current = state();
		current.agents = [source];

		const projected = projectStructuredRunAgent(
			current,
			{
				...run,
				agentId: "agent-history",
				interactionSessionId: "interaction-history",
				providerConversationRef: "threads/2026-08-30:turn_1",
				workspaceId: "workspace-source",
				worktree: {
					kind: "existing_workspace",
					sourceAgentId: source.id,
					rootPath: source.worktreePath,
				},
			},
			project,
		);

		expect(projected.agent).toMatchObject({
			id: "agent-history",
			worktreePath: source.worktreePath,
			branch: source.branch,
			conversationId: "threads/2026-08-30:turn_1",
			interactionProfile: { kind: "structured_protocol" },
		});
	});

	it("projects an SSH Chat run onto the uniquely mapped remote project", async () => {
		const remoteProject: Project = {
			...project,
			id: "project-remote",
			path: "/srv/repo",
			kind: "ssh",
			sshHostId: "registered-host",
		};
		let current: CliManagedRunPresentationState = {
			...state(),
			projects: [remoteProject],
			sshHosts: [
				{
					id: "registered-host",
					name: "Remote",
					host: "dev.example.test",
					port: 2222,
					user: "dev",
					auth: "auto",
				},
			],
		};
		const ensureProject = vi.fn(async () => remoteProject);
		const dependencies: StructuredRunPresentationDependencies = {
			windowLabel: () => "main",
			readState: () => current,
			setState: (producer) => {
				current = { ...current, ...producer(current) };
			},
			ensureProject,
			requestSpaceMount: vi.fn(),
			waitForSpace: vi.fn(async () => ({})),
			resolveReference: vi.fn(),
			openAgent: vi.fn(() => "presented-pane"),
		};

		const agent = await presentStructuredRunInBackground(
			{
				...run,
				projectId: remoteProject.id,
				backendProfileId: "remote-a",
			},
			{
				projectPath: remoteProject.path,
				executionTarget: {
					source: "ssh",
					hostId: "remote-a",
					remote: { host: "dev.example.test", port: 2222, user: "dev" },
				},
			},
			dependencies,
		);

		expect(ensureProject).toHaveBeenCalledWith(
			remoteProject.path,
			remoteProject.sshHostId,
		);
		expect(agent).toMatchObject({
			projectId: remoteProject.id,
			sessionKind: "ssh",
			interactionProfile: { backendProfileId: "remote-a" },
		});
	});
});

describe("presentStructuredRun", () => {
	it("keeps the resumed workspace snapshot when the source is removed while the Space mounts", async () => {
		const source = {
			...projectStructuredRunAgent(state(), run, project).agent,
			id: "agent-source",
			name: "source",
			worktreePath: "/repo/.worktrees/source",
			branch: "agent/source",
		};
		let current: CliManagedRunPresentationState = {
			...state(),
			agents: [source],
			spaces: [{ id: "space-1", name: "Build" }],
		};
		const openAgent = vi.fn(() => "presented-pane");
		const dependencies: StructuredRunPresentationDependencies = {
			windowLabel: () => "main",
			readState: () => current,
			setState: (producer) => {
				current = { ...current, ...producer(current) };
			},
			ensureProject: vi.fn(async () => project),
			requestSpaceMount: vi.fn(),
			waitForSpace: vi.fn(async () => {
				current = { ...current, agents: [] };
				return {};
			}),
			resolveReference: vi.fn(),
			openAgent,
		};
		const resumed = {
			...run,
			agentId: "agent-history",
			interactionSessionId: "interaction-history",
			workspaceId: "workspace-source",
			worktree: {
				kind: "existing_workspace" as const,
				sourceAgentId: source.id,
				rootPath: source.worktreePath,
			},
		};

		const presented = await presentStructuredRun(
			resumed,
			{
				projectPath: project.path,
				spaceId: "space-1",
				windowLabel: "main",
			},
			dependencies,
		);
		expect(presented.pane.panelId).toBe("presented-pane");

		expect(openAgent).toHaveBeenCalledWith(
			"space-1",
			expect.objectContaining({
				id: resumed.agentId,
				worktreePath: source.worktreePath,
				branch: source.branch,
			}),
			undefined,
			undefined,
		);
	});

	it.each([false, true])(
		"uses adaptive caller placement unless a drop is explicit: %s",
		async (explicitDrop) => {
			let current: CliManagedRunPresentationState = {
				...state(),
				spaces: [{ id: "space-1", name: "Build" }],
			};
			const openAgent = vi.fn(() => "presented-pane");
			const resolveReference = vi.fn(async () => ({
				desktopId: "space-1",
				panelId: "caller-pane",
			}));
			const dependencies: StructuredRunPresentationDependencies = {
				windowLabel: () => "main",
				readState: () => current,
				setState: (producer) => {
					current = { ...current, ...producer(current) };
				},
				ensureProject: vi.fn(async () => project),
				requestSpaceMount: vi.fn(),
				waitForSpace: vi.fn(async () => ({})),
				resolveReference,
				openAgent,
			};
			const position = { floating: { x: 40, y: 60, width: 700 } };

			await presentStructuredRun(
				run,
				{
					projectPath: project.path,
					spaceId: "space-1",
					windowLabel: "main",
					referencePanelId: "caller-pane",
					position: explicitDrop ? position : undefined,
				},
				dependencies,
			);

			expect(openAgent).toHaveBeenCalledWith(
				"space-1",
				expect.objectContaining({ id: run.agentId }),
				explicitDrop ? position : undefined,
				explicitDrop ? undefined : "caller-pane",
			);
			if (explicitDrop) expect(resolveReference).not.toHaveBeenCalled();
			else expect(resolveReference).toHaveBeenCalledWith("caller-pane");
		},
	);
});
