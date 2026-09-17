import { beforeEach, describe, expect, it, vi } from "vitest";
import { launchDiscoveredLocalConversationPane } from "@/lib/sessions/launch/discoveredConversationLaunch";
import { launchRecentSessionPane } from "@/lib/sessions/launch/recentSessionPaneLaunch";
import { recentSessionDragPayload } from "@/lib/sessions/recentSessionDrag";
import { projectRecentWork } from "@/lib/sessions/recentWork";
import { useStore } from "@/store";
import { managedAgentFixture } from "@/test/agentFixtures";
import type { Agent, Project } from "@/types";

const mocks = vi.hoisted(() => ({
	ensureManagedAgentRuntime: vi.fn(),
	inspectSession: vi.fn(),
	resolveSuccessor: vi.fn(),
	inspectWriter: vi.fn(),
	openAgentPanel: vi.fn(),
	inspectSelectedProjection: vi.fn(),
}));

vi.mock("@/lib/workspace/dock", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock")>()),
	openAgentPanel: mocks.openAgentPanel,
	openAgentPanelOnDesktop: mocks.openAgentPanel,
}));
vi.mock("@/lib/agents/agentRuntimeProjectionRecovery", () => ({
	inspectSelectedAgentRuntimeProjection: mocks.inspectSelectedProjection,
}));
vi.mock("@/lib/sessions/managed/managedAgentRuntime", () => ({
	ensureManagedAgentRuntime: mocks.ensureManagedAgentRuntime,
	MANAGED_BOOTSTRAP_GEOMETRY: { columns: 120, rows: 30 },
}));
vi.mock("@/lib/hmux/identity/exactHmuxSessionInspection", () => ({
	inspectHmuxSessionExact: mocks.inspectSession,
}));
vi.mock("@/lib/ipc", async (importOriginal) => {
	const original = await importOriginal<typeof import("@/lib/ipc")>();
	return {
		...original,
		hmux: {
			...original.hmux,
			resolveManagedRehost: mocks.resolveSuccessor,
			inspectExistingManagedWriter: mocks.inspectWriter,
		},
	};
});

import { ManagedCreateRetrySameError } from "@/lib/hmux/managed/managedCreateResolution";

const project: Project = {
	id: "project-repo",
	name: "repo",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

beforeEach(() => {
	mocks.openAgentPanel.mockReset();
	mocks.openAgentPanel.mockReturnValue(true);
	mocks.ensureManagedAgentRuntime.mockReset();
	mocks.inspectSelectedProjection.mockReset();
	mocks.inspectSelectedProjection.mockResolvedValue({ state: "unmanaged" });
	useStore.setState((state) => ({
		projects: [],
		agents: [],
		agentActivity: {},
		accounts: [],
		activeAccounts: {},
		stats: { ...state.stats, agentsStarted: 0 },
		ensureProjectForPath: vi.fn(async () => {
			useStore.setState({ projects: [project] });
			return project;
		}),
	}));
	mocks.ensureManagedAgentRuntime.mockImplementation(
		async (agent: Agent, options) => {
			await options.beforeCreate?.();
			useStore.setState((state) => ({
				agents: state.agents.map((candidate) =>
					candidate.id === agent.id
						? { ...candidate, started: true }
						: candidate,
				),
			}));
			const committed = useStore
				.getState()
				.agents.find((candidate) => candidate.id === agent.id);
			if (!committed) throw new Error("local test commit was lost");
			return { agent: committed };
		},
	);
});

const input = {
	provider: "codex" as const,
	conversationId: "01a0a8ea-ebbe-7211-8ae5-c92419eec917",
	cwd: "/repo/packages/app",
	workspaceRoot: "/repo",
	desktopId: "desktop-active",
	existingOwner: "return" as const,
};
function prepareRuntime() {
	mocks.inspectSession.mockReset().mockResolvedValue(undefined);
	mocks.inspectWriter.mockReset();
	mocks.resolveSuccessor
		.mockReset()
		.mockImplementation(async (sessionId, workspaceId) => ({
			schema: "hmux-managed-rehost-resolution-v1",
			schemaVersion: 1,
			state: "not_found",
			source: { sessionId, workspaceId },
		}));
}
describe("discovered local conversation recovery", () => {
	it("preserves the original registration when a resumed create is refused again", async () => {
		prepareRuntime();
		const transient = new ManagedCreateRetrySameError(
			"authority_unavailable",
			"review_authority_unavailable",
			"retry the exact identity",
		);
		mocks.ensureManagedAgentRuntime.mockRejectedValueOnce(transient);
		await expect(launchDiscoveredLocalConversationPane(input)).rejects.toBe(
			transient,
		);
		const retained = useStore.getState().agents[0];
		const refusal = new Error("provider_setup_required");
		mocks.ensureManagedAgentRuntime.mockRejectedValueOnce(refusal);
		await expect(launchDiscoveredLocalConversationPane(input)).rejects.toBe(
			refusal,
		);
		expect(useStore.getState().agents).toEqual([retained]);
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();
	});

	it("retries a transiently retained local create when the authority recovers", async () => {
		prepareRuntime();
		const transient = new ManagedCreateRetrySameError(
			"authority_unavailable",
			"review_authority_unavailable",
			"retry the exact identity",
		);
		mocks.ensureManagedAgentRuntime.mockRejectedValueOnce(transient);
		await expect(launchDiscoveredLocalConversationPane(input)).rejects.toBe(
			transient,
		);
		expect(useStore.getState().agents).toHaveLength(1);
		expect(useStore.getState().agents[0].started).toBe(false);
		const retained = useStore.getState().agents[0];
		// The native authority is available again; continue the same create identity.
		await expect(
			launchDiscoveredLocalConversationPane(input),
		).resolves.toMatchObject({ started: true });
		expect(mocks.ensureManagedAgentRuntime).toHaveBeenCalledTimes(2);
		expect(mocks.ensureManagedAgentRuntime.mock.calls[1][0]).toBe(retained);
		expect(useStore.getState().agents).toHaveLength(1);
		expect(useStore.getState().agents[0].id).toBe(retained.id);
	});
	it("resumes local history even when the same ID is registered on a different SSH host", async () => {
		prepareRuntime();
		const remote = managedAgentFixture({
			id: "other-host-agent",
			provider: "codex",
			projectId: "ssh-project",
			conversationId: input.conversationId,
			sessionKind: "ssh",
			worktreePath: "/srv/repo",
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: "other-host",
				sessionId: "remote-session",
				workspaceId: "ssh-project",
				createIdempotencyKey: "remote-create",
				commandBridgeNonce: "remote-bridge",
			},
		});
		useStore.setState({
			agents: [remote],
			projects: [
				{ ...project, id: "ssh-project", kind: "ssh", sshHostId: "other-host" },
			],
		});
		const state = useStore.getState();
		const item = projectRecentWork({
			entries: [
				{
					provider: "codex",
					id: input.conversationId,
					title: "Local copy",
					mtime: 100,
					cwd: input.cwd,
					repositoryRoot: input.workspaceRoot,
					resumeCapability: "exact",
					executionLocation: "local",
				},
			],
			agents: state.agents,
			projects: state.projects,
			activity: {},
			nowSeconds: 100,
		}).groups[0].items[0];
		const payload = recentSessionDragPayload(item);
		if (!payload) throw new Error("expected local resume action");
		await expect(
			launchRecentSessionPane(payload, { desktopId: input.desktopId }),
		).resolves.toMatchObject({
			started: true,
			runtimeBinding: { source: "local" },
		});
	});
});
