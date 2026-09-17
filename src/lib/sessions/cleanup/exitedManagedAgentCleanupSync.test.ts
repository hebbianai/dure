import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableProjectionRemovalRequest } from "@/lib/agents/durableAgentRemoval";
import type { HmuxSessionSummary } from "@/lib/ipc";
import { exitedManagedAgentCleanupCompensations, type CleanupCompensationStorage } from "@/lib/sessions/cleanup/exitedManagedAgentCleanupCompensation";
import { reconcileExitedManagedAgentCleanupCompensations } from "@/lib/sessions/cleanup/exitedManagedAgentCleanupCompensationRuntime";
import { applyExitedManagedAgentCleanupSync } from "@/lib/sessions/cleanup/exitedManagedAgentCleanupRuntime";
import { useStore } from "@/store";
import {
	agentFixture,
	hmuxSessionSummaryFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";
import type { Agent, Project } from "@/types";

const mocks = vi.hoisted(() => ({
	durableRemove: vi.fn(),
	mountedDockviewEntries: vi.fn(() => [] as unknown[]),
	getDockview: vi.fn(() => undefined as unknown),
	openAgentPanel: vi.fn(),
}));

vi.mock("@/lib/agents/durableAgentRemoval", () => ({
	removeAgentProjectionDurably: mocks.durableRemove,
}));

vi.mock("@/lib/workspace/dock", () => ({
	openAgentPanel: mocks.openAgentPanel,
}));
vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/workspace/dock/dockRegistry")>()),
	mountedDockviewEntries: mocks.mountedDockviewEntries,
	getDockview: mocks.getDockview,
}));

const project: Project = {
	id: "project-1",
	name: "Dure",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

const stopFence = stopFenceFixture({
	hostInstanceId: "host-1",
	terminalEpoch: "terminal-1",
});

const agent: Agent = agentFixture({
	name: "exited-agent",
	projectId: project.id,
	worktreePath: "/repo/.worktrees/exited-agent",
	branch: "agent/exited-agent",
	runtimeBinding: managedBindingFixture({
		credentialId: "account-1",
		credentialGeneration: 2,
		stopFence,
	}),
});

describe("exited managed Agent cleanup synchronization", () => {
	let storage: CleanupCompensationStorage;

	beforeEach(() => {
		vi.clearAllMocks();
		const values = new Map<string, string>();
		storage = {
			getItem: (key) => values.get(key) ?? null,
			setItem: (key, value) => values.set(key, value),
			removeItem: (key) => values.delete(key),
		};
		useStore.setState({
			projects: [project],
			agents: [agent],
			agentActivity: { "agent-1": "exited" },
			sessionAgentRuntimeState: {},
		});
		mocks.durableRemove.mockImplementation(
			async (request: DurableProjectionRemovalRequest) => {
				const state = useStore.getState();
				const target = request.agents[0];
				const current = state.agents.find(
					(candidate) => candidate.id === target?.agentId,
				);
				if (
					current &&
					target &&
					!target.applies(current, state.projects, state.sshHosts)
				) {
					return false;
				}
				if (target) {
					useStore.setState((current) => ({
						agents: current.agents.filter(
							(candidate) => candidate.id !== target.agentId,
						),
					}));
				}
				return true;
			},
		);
		mocks.mountedDockviewEntries.mockReturnValue([]);
		mocks.getDockview.mockReturnValue(undefined);
		useStore.setState({ layouts: {} });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("removes only the exact persisted managed binding", async () => {
		const payload = {
			schemaVersion: 3,
			agentId: "agent-1",
			sessionId: "session-1",
			workspaceId: "workspace-1",
			createIdempotencyKey: "create-1",
			credentialId: "account-1",
			credentialGeneration: 2,
			stopFence,
			sourceTerminalEpoch: "terminal-1",
		};
		await expect(
			applyExitedManagedAgentCleanupSync(payload, { storage }),
		).resolves.toBe(true);

		expect(mocks.durableRemove).toHaveBeenCalledOnce();
		expect(useStore.getState().agents).toEqual([]);

		const canonical = {
			...agent,
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: "local",
				operationId: "spawn-canonical",
			},
		};
		useStore.setState({ agents: [canonical] });
		mocks.durableRemove.mockClear();
		await expect(
			applyExitedManagedAgentCleanupSync(payload, { storage }),
		).resolves.toBe(false);
		expect(mocks.durableRemove).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([canonical]);
	});

	it.each([
		{
			name: "Project identity",
			successor: {
				...agent,
				projectId: "project-2",
			},
			projects: [
				project,
				{
					...project,
					id: "project-2",
					name: "Successor",
					path: "/successor",
				},
			],
		},
		{
			name: "worktree identity",
			successor: {
				...agent,
				worktreePath: "/repo/.worktrees/successor",
			},
			projects: [project],
		},
		{
			name: "top-level session identity",
			successor: {
				...agent,
				sessionId: "successor-session",
			},
			projects: [project],
		},
	])(
		"preserves a same-binding successor with changed $name",
		async (testCase) => {
			mocks.durableRemove.mockImplementationOnce(
				async (request: DurableProjectionRemovalRequest) => {
					useStore.setState({
						agents: [testCase.successor],
						projects: testCase.projects,
					});
					const state = useStore.getState();
					const target = request.agents[0];
					if (
						!target?.applies(
							testCase.successor,
							state.projects,
							state.sshHosts,
						)
					) {
						return false;
					}
					useStore.setState({ agents: [] });
					return true;
				},
			);

			await expect(
				applyExitedManagedAgentCleanupSync(
					{
						schemaVersion: 3,
						agentId: "agent-1",
						sessionId: "session-1",
						workspaceId: "workspace-1",
						createIdempotencyKey: "create-1",
						credentialId: "account-1",
						credentialGeneration: 2,
						stopFence,
						sourceTerminalEpoch: "terminal-1",
					},
					{ storage },
				),
			).resolves.toBe(false);

			expect(mocks.durableRemove).toHaveBeenCalledOnce();
			expect(useStore.getState().agents).toEqual([testCase.successor]);
		},
	);

	it("refuses a cleanup event from an older binding generation", async () => {
		await expect(
			applyExitedManagedAgentCleanupSync(
				{
					schemaVersion: 3,
					agentId: "agent-1",
					sessionId: "session-1",
					workspaceId: "workspace-1",
					createIdempotencyKey: "create-1",
					credentialId: "account-1",
					credentialGeneration: 1,
					stopFence,
					sourceTerminalEpoch: "terminal-1",
				},
				{ storage },
			),
		).resolves.toBe(false);

		expect(mocks.durableRemove).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([agent]);
	});

	it("refuses a delayed cleanup event for a newer Host generation", async () => {
		await expect(
			applyExitedManagedAgentCleanupSync(
				{
					schemaVersion: 3,
					agentId: "agent-1",
					sessionId: "session-1",
					workspaceId: "workspace-1",
					createIdempotencyKey: "create-1",
					credentialId: "account-1",
					credentialGeneration: 2,
					stopFence: { ...stopFence, terminalEpoch: "terminal-old" },
					sourceTerminalEpoch: "terminal-old",
				},
				{ storage },
			),
		).resolves.toBe(false);

		expect(mocks.durableRemove).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([agent]);
	});

	it("fails closed before removal when compensation cannot be persisted", async () => {
		const unavailable: CleanupCompensationStorage = {
			getItem: () => null,
			setItem: () => {
				throw new Error("quota exceeded");
			},
			removeItem: () => {},
		};
		await expect(
			applyExitedManagedAgentCleanupSync(
				{
					schemaVersion: 3,
					agentId: "agent-1",
					sessionId: "session-1",
					workspaceId: "workspace-1",
					createIdempotencyKey: "create-1",
					credentialId: "account-1",
					credentialGeneration: 2,
					stopFence,
					sourceTerminalEpoch: "terminal-1",
				},
				{ storage: unavailable },
			),
		).resolves.toBe(false);
		expect(mocks.durableRemove).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([agent]);
	});

	it("removes only an exact remote never-created registration", async () => {
		const remoteProject: Project = {
			id: "remote-project",
			name: "Remote",
			path: "/srv/repo",
			kind: "ssh",
			sshHostId: "remote-host",
			isRepo: true,
		};
		const remoteAgent: Agent = {
			...agent,
			projectId: remoteProject.id,
			worktreePath: "/srv/repo/.worktrees/exited-agent",
			sessionKind: "ssh",
			started: false,
			runtimeBinding: {
				schemaVersion: 1,
				runtime: "hmux_managed_v1",
				source: "ssh",
				hostId: "remote-host",
				sessionId: "session-1",
				workspaceId: "remote-project",
				createIdempotencyKey: "remote-create",
				commandBridgeNonce: "remote-bridge",
			},
		};
		useStore.setState({
			projects: [remoteProject],
			sshHosts: [
				{
					id: "remote-host",
					name: "host",
					host: "remote.test",
					port: 22,
					user: "agent",
					auth: "key",
					keyPath: "/keys/remote",
				},
			],
			agents: [remoteAgent],
		});
		const payload = {
			schemaVersion: 4,
			source: "ssh",
			agentId: remoteAgent.id,
			hostId: "remote-host",
			sessionId: "session-1",
			workspaceId: "remote-project",
			createIdempotencyKey: "remote-create",
			commandBridgeNonce: "remote-bridge",
		};

		await expect(
			applyExitedManagedAgentCleanupSync(payload, { storage }),
		).resolves.toBe(true);
		expect(useStore.getState().agents).toEqual([]);

		useStore.setState({ agents: [remoteAgent] });
		await expect(
			applyExitedManagedAgentCleanupSync(
				{
					schemaVersion: 4,
					source: "ssh",
					agentId: remoteAgent.id,
					hostId: "remote-host",
					sessionId: "session-1",
					workspaceId: "remote-project",
					createIdempotencyKey: "remote-create",
					commandBridgeNonce: "stale-bridge",
				},
				{ storage },
			),
		).resolves.toBe(false);
		expect(useStore.getState().agents).toEqual([remoteAgent]);

		const canonical = {
			...remoteAgent,
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: "remote-1",
				operationId: "spawn-remote",
			},
		};
		useStore.setState({ agents: [canonical] });
		mocks.durableRemove.mockClear();
		await expect(
			applyExitedManagedAgentCleanupSync(payload, { storage }),
		).resolves.toBe(false);
		expect(mocks.durableRemove).not.toHaveBeenCalled();
		expect(useStore.getState().agents).toEqual([canonical]);
	});

	it.each(["agent:agent-1", "slot", "launcher:previous", "agent:previous"])("restores only Agent authority for a newer cross-window generation in %s", async (panelId) => {
		let panelParams: Record<string, unknown> = {
			agentRef: { agentId: agent.id },
			agentId: "agent-1",
			binding: agent.runtimeBinding,
		};
		const updateParameters = vi.fn((next: Record<string, unknown>) => {
			panelParams = next;
			panel.params = next;
		});
		const panel = {
			id: panelId,
			params: panelParams,
			api: {
				component: "agent",
				getParameters: () => panelParams,
				updateParameters,
			},
		};
		const api = {
			panels: [panel],
			getPanel: (id: string) => id === panelId ? panel : undefined,
			toJSON: () => ({
				panels: { [panelId]: { contentComponent: "agent", params: panelParams } },
			}),
		};
		mocks.mountedDockviewEntries.mockReturnValue([["desktop-1", api]] as never);
		mocks.getDockview.mockReturnValue(api as never);
		vi.stubGlobal("localStorage", storage);
		useStore.setState({
			spaces: [{ id: "desktop-1", name: "Operate" }],
			layouts: {
				"desktop-1": {
					panels: { [panelId]: { contentComponent: "agent", params: panelParams } },
				},
			},
		});
		await expect(
			applyExitedManagedAgentCleanupSync(
				{
					schemaVersion: 3,
					agentId: "agent-1",
					sessionId: "session-1",
					workspaceId: "workspace-1",
					createIdempotencyKey: "create-1",
					credentialId: "account-1",
					credentialGeneration: 2,
					stopFence,
					sourceTerminalEpoch: "terminal-1",
				},
				{ storage },
			),
		).resolves.toBe(true);
		expect(useStore.getState().agents).toEqual([]);

		expect(exitedManagedAgentCleanupCompensations(storage)[0]?.desktopIds).toEqual(["desktop-1"]);

		const sameGeneration: HmuxSessionSummary = hmuxSessionSummaryFixture({
			manifestLifecycle: "ready",
			inputAllowed: true,
			terminalEpoch: "terminal-1",
			stopFence,
		});
		expect(
			reconcileExitedManagedAgentCleanupCompensations([sameGeneration]),
		).toEqual([]);
		expect(useStore.getState().agents).toEqual([]);

		const replacementFence = {
			...stopFence,
			runnerInstance: "runner-2",
			channelEpoch: "8",
			hostInstanceId: "host-2",
			terminalEpoch: "terminal-2",
		};
		const replacement = {
			...sameGeneration,
			terminalEpoch: "terminal-2",
			stopFence: replacementFence,
		};
		const canonicalSuccessor = {
			...agent,
			canonicalSpawn: {
				schemaVersion: 1 as const,
				backendProfileId: "local",
				operationId: "spawn-successor",
			},
		};
		useStore.setState({ agents: [canonicalSuccessor] });
		expect(
			reconcileExitedManagedAgentCleanupCompensations([replacement]),
		).toEqual([
			expect.objectContaining({ agentId: "agent-1", outcome: "refused" }),
		]);
		expect(useStore.getState().agents).toEqual([canonicalSuccessor]);
		expect(mocks.openAgentPanel).not.toHaveBeenCalled();

		useStore.setState({ agents: [] });
		expect(
			reconcileExitedManagedAgentCleanupCompensations([replacement]),
		).toEqual([
			expect.objectContaining({ agentId: "agent-1", outcome: "restored" }),
		]);
		expect(useStore.getState().agents[0]?.runtimeBinding).toMatchObject({
			runtime: "hmux_managed_v1",
			stopFence: replacementFence,
		});
		expect(updateParameters).not.toHaveBeenCalled();
		expect(panelParams).toMatchObject({
			agentId: "agent-1",
			binding: expect.objectContaining({ stopFence }),
		});
	});
});
