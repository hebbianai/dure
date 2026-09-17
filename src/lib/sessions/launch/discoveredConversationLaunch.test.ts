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
	openAgentPanel: vi.fn(),
	resolveOwnership: vi.fn(),
	assertPermit: vi.fn(),
	revalidatePermit: vi.fn(),
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
vi.mock("@/lib/sessions/managed/managedConversationOwnership", () => ({
	ManagedConversationOwnershipUnavailableError: class extends Error {},
	resolveManagedConversationOwnership: mocks.resolveOwnership,
	assertManagedConversationLaunchPermit: mocks.assertPermit,
	revalidateManagedConversationLaunchPermit: mocks.revalidatePermit,
}));

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
	mocks.resolveOwnership.mockReset();
	mocks.assertPermit.mockReset();
	mocks.revalidatePermit.mockReset();
	mocks.revalidatePermit.mockResolvedValue(undefined);
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
	mocks.resolveOwnership.mockImplementation(
		async ({ providerId, conversationId }) => {
			const active = useStore
				.getState()
				.agents.find(
					(candidate) =>
						candidate.provider === providerId &&
						candidate.conversationId?.trim() === conversationId,
				);
			return active
				? { state: "active", agent: active }
				: {
						state: "vacant",
						permit: {
							schemaVersion: 1,
							providerId,
							conversationId,
							candidateFingerprints: [],
						},
					};
		},
	);
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

describe("launchDiscoveredLocalConversationPane", () => {
	it.each(["working", "exited", undefined] as const)(
		"resumes Codex app history without borrowing a same-folder Agent whose activity is %s",
		async (activity) => {
			const unrelated = managedAgentFixture({
				id: "unrelated-agent",
				provider: "codex",
				projectId: project.id,
				worktreePath: "/repo",
				conversationId: "unrelated-conversation",
			});
			useStore.setState({
				projects: [project],
				agents: [unrelated],
				agentActivity: activity ? { [unrelated.id]: activity } : {},
				layouts: {},
			});
			const state = useStore.getState();
			const item = projectRecentWork({
				entries: [
					{
						provider: "codex",
						id: "01a0a8ea-ebbe-7211-8ae5-c92419eec917",
						title: "Test Dure chat session resume",
						mtime: 100,
						cwd: "/repo/packages/app",
						repositoryRoot: "/repo",
						resumeCapability: "exact",
						executionLocation: "local",
					},
				],
				agents: state.agents,
				projects: state.projects,
				activity: state.agentActivity,
				nowSeconds: 100,
			}).groups[0].items[0];
			const payload = recentSessionDragPayload(item);
			if (!payload) throw new Error("expected resumable history");

			const opened = await launchRecentSessionPane(payload, {
				desktopId: "desktop-active",
			});

			expect(opened).toMatchObject({
				provider: "codex",
				conversationId: item.conversationId,
				worktreePath: "/repo/packages/app",
				started: true,
			});
			expect(useStore.getState().agents).toEqual([unrelated, opened]);
			expect(mocks.ensureManagedAgentRuntime).toHaveBeenCalledOnce();
			expect(mocks.inspectSelectedProjection).not.toHaveBeenCalled();
			expect(mocks.revalidatePermit).toHaveBeenCalledOnce();
		},
	);

	it("registers one exact managed pane without an import desktop or seed Agent", async () => {
		const agent = await launchDiscoveredLocalConversationPane({
			provider: "claude",
			conversationId: "conversation-1",
			cwd: "/repo/packages/app",
			workspaceRoot: "/repo",
			desktopId: "desktop-active",
		});

		expect(useStore.getState().ensureProjectForPath).toHaveBeenCalledWith(
			"/repo",
		);
		expect(agent).toMatchObject({
			provider: "claude",
			projectId: project.id,
			worktreePath: "/repo/packages/app",
			started: true,
			conversationId: "conversation-1",
			runtimeBinding: {
				runtime: "hmux_managed_v1",
				source: "local",
				hostId: "local",
				workspaceId: project.id,
			},
		});
		expect(useStore.getState().agents).toEqual([agent]);
		expect(useStore.getState().stats.agentsStarted).toBe(1);
		expect(mocks.openAgentPanel).toHaveBeenCalledWith("desktop-active", agent);
	});

	it("registers a canonical path-shaped provider conversation identity", async () => {
		const conversationId = "threads/2026-08-30:turn_1";

		const agent = await launchDiscoveredLocalConversationPane({
			provider: "claude",
			conversationId,
			cwd: "/repo",
			workspaceRoot: "/repo",
			desktopId: "desktop-active",
		});

		expect(agent.conversationId).toBe(conversationId);
		expect(mocks.resolveOwnership).toHaveBeenCalledWith({
			providerId: "claude",
			conversationId,
		});
		expect(mocks.ensureManagedAgentRuntime).toHaveBeenCalledOnce();
	});

	it.each(["conversation+alias", `/${"a".repeat(160)}`])(
		"rejects a non-canonical discovered conversation identity: %s",
		async (conversationId) => {
			await expect(
				launchDiscoveredLocalConversationPane({
					provider: "claude",
					conversationId,
					cwd: "/repo",
					workspaceRoot: "/repo",
					desktopId: "desktop-active",
				}),
			).rejects.toThrow("invalid_conversation_identity");

			expect(mocks.resolveOwnership).not.toHaveBeenCalled();
			expect(mocks.ensureManagedAgentRuntime).not.toHaveBeenCalled();
		},
	);

	it("fails closed when the exact conversation became active during the click", async () => {
		const existing: Agent = {
			id: "existing-agent",
			name: "existing",
			provider: "claude",
			projectId: project.id,
			worktreePath: project.path,
			branch: "",
			sessionId: "existing-agent",
			sessionKind: "pty",
			started: true,
			conversationId: "conversation-1",
		};
		useStore.setState({
			projects: [project],
			agents: [existing],
			agentActivity: { [existing.id]: "waiting" },
		});

		await expect(
			launchDiscoveredLocalConversationPane({
				provider: "claude",
				conversationId: "conversation-1",
				cwd: "/repo",
				workspaceRoot: "/repo",
				desktopId: "desktop-active",
			}),
		).rejects.toMatchObject({ code: "conversation_already_active" });
		expect(useStore.getState().agents).toEqual([existing]);
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();
	});

	it("returns an exact live owner for a Recent Sessions activation", async () => {
		const existing: Agent = {
			id: "existing-agent",
			name: "existing",
			provider: "claude",
			projectId: project.id,
			worktreePath: project.path,
			branch: "",
			sessionId: "existing-agent",
			sessionKind: "pty",
			started: true,
			conversationId: "conversation-1",
		};
		useStore.setState({ projects: [project], agents: [existing] });

		await expect(
			launchDiscoveredLocalConversationPane({
				provider: "claude",
				conversationId: "conversation-1",
				cwd: "/repo",
				workspaceRoot: "/repo",
				desktopId: "desktop-active",
				existingOwner: "return",
			}),
		).resolves.toEqual(existing);
		expect(useStore.getState().ensureProjectForPath).not.toHaveBeenCalled();
		expect(mocks.ensureManagedAgentRuntime).not.toHaveBeenCalled();
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();
	});

	it("rolls back the staged registration when exact create admission is refused", async () => {
		const refusal = new Error("managed Hmux recovery was refused");
		mocks.ensureManagedAgentRuntime.mockRejectedValue(refusal);

		await expect(
			launchDiscoveredLocalConversationPane({
				provider: "claude",
				conversationId: "conversation-1",
				cwd: "/repo",
				workspaceRoot: "/repo",
				desktopId: "desktop-active",
			}),
		).rejects.toBe(refusal);

		expect(useStore.getState().agents).toEqual([]);
		expect(useStore.getState().agentActivity).toEqual({});
		expect(useStore.getState().stats.agentsStarted).toBe(0);
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();
	});
});
