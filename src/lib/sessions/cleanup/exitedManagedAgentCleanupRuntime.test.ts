import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type {
	HmuxRetireExitedGeneration,
	HmuxRetireExitedReceipt,
	HmuxSessionSummary,
} from "@/lib/ipc";
import {
	type ExitedManagedAgentCleanupRuntime,
	executeExitedManagedAgentCleanup,
	previewExitedManagedAgentCleanup,
} from "@/lib/sessions/cleanup/exitedManagedAgentCleanupRuntime";
import {
	agentFixture,
	hmuxSessionSummaryFixture,
	managedBindingFixture,
} from "@/test/agentFixtures";
import type { Agent, Project } from "@/types";

const project: Project = {
	id: "project-1",
	name: "Dure",
	path: "/repo",
	kind: "local",
	isRepo: true,
};

function generation(sessionId = "session-1"): HmuxRetireExitedGeneration {
	return {
		fence: {
			workspaceId: "workspace-1",
			sessionId,
			runnerPrincipal: "runner",
			runnerInstance: "runner-1",
			channelEpoch: "1",
			hostInstanceId: `host-${sessionId}`,
			terminalEpoch: "terminal-1",
		},
		hostProcess: { processId: 100, startMarker: `start-${sessionId}` },
	};
}

function agent(sessionId = "session-1"): Agent {
	return agentFixture({
		name: "exited-agent",
		projectId: project.id,
		worktreePath: "/repo/.worktrees/exited-agent",
		branch: "agent/exited-agent",
		sessionId,
		runtimeBinding: managedBindingFixture({ sessionId }),
	});
}

function summary(patch: Partial<HmuxSessionSummary> = {}): HmuxSessionSummary {
	return hmuxSessionSummaryFixture({
		sessionName: "exited-agent",
		lifecycle: "exited",
		manifestLifecycle: "exited",
		health: "exited",
		inputAllowed: false,
		runtimeHost: "localhost",
		hostBuildVersion: "build-1",
		terminalEpoch: "terminal-1",
		...patch,
	});
}

describe("exited managed Agent cleanup execution", () => {
	let agents: Agent[];
	let sessions: HmuxSessionSummary[];
	let absentEligible: Set<string>;
	let retire: Mock<ExitedManagedAgentCleanupRuntime["retireExitedSessions"]>;
	let cleanupStale: Mock<
		ExitedManagedAgentCleanupRuntime["cleanupStaleSessions"]
	>;
	let forget: Mock<ExitedManagedAgentCleanupRuntime["forget"]>;
	let reconcileReplacement: Mock<
		ExitedManagedAgentCleanupRuntime["reconcileReplacement"]
	>;
	let runtime: ExitedManagedAgentCleanupRuntime;

	beforeEach(() => {
		agents = [agent()];
		sessions = [];
		absentEligible = new Set(["agent-1"]);
		retire = vi.fn<ExitedManagedAgentCleanupRuntime["retireExitedSessions"]>();
		cleanupStale =
			vi.fn<ExitedManagedAgentCleanupRuntime["cleanupStaleSessions"]>();
		forget = vi.fn<ExitedManagedAgentCleanupRuntime["forget"]>((candidate) => {
			agents = agents.filter((current) => current.id !== candidate.agentId);
			return true;
		});
		reconcileReplacement = vi.fn<
			ExitedManagedAgentCleanupRuntime["reconcileReplacement"]
		>(() => false);
		runtime = {
			listSessions: vi.fn(async () => sessions),
			retireExitedSessions: retire,
			cleanupStaleSessions: cleanupStale,
			currentAgents: () => agents,
			currentProjects: () => [project],
			absentEligibleAgentIds: () => absentEligible,
			forget,
			reconcileReplacement,
		};
	});

	it("forgets an exact absent binding without touching discovery", async () => {
		const plan = await previewExitedManagedAgentCleanup(runtime);
		const receipts = await executeExitedManagedAgentCleanup(
			plan.candidates,
			runtime,
		);

		expect(receipts).toEqual([
			expect.objectContaining({
				agentId: "agent-1",
				outcome: "cleaned",
				sourceState: "absent",
			}),
		]);
		expect(retire).not.toHaveBeenCalled();
		expect(cleanupStale).not.toHaveBeenCalled();
		expect(forget).toHaveBeenCalledOnce();
		expect(agents).toEqual([]);
	});

	it("previews and retires an exact exited generation before forgetting", async () => {
		sessions = [summary()];
		runtime.absentEligibleAgentIds = () => new Set();
		retire
			.mockResolvedValueOnce([
				{
					workspaceId: "workspace-1",
					sessionId: "session-1",
					outcome: "retirable",
					generation: generation(),
				},
			] satisfies HmuxRetireExitedReceipt[])
			.mockImplementationOnce(async () => {
				sessions = [];
				return [
					{
						workspaceId: "workspace-1",
						sessionId: "session-1",
						outcome: "retired",
					},
				] satisfies HmuxRetireExitedReceipt[];
			});

		const plan = await previewExitedManagedAgentCleanup(runtime);
		const receipts = await executeExitedManagedAgentCleanup(
			plan.candidates,
			runtime,
		);

		expect(retire).toHaveBeenNthCalledWith(
			1,
			[
				{
					workspaceId: "workspace-1",
					sessionId: "session-1",
					terminalEpoch: "terminal-1",
				},
			],
			false,
		);
		expect(retire).toHaveBeenNthCalledWith(2, expect.any(Array), true);
		expect(retire.mock.calls[1]?.[0]?.[0]).toMatchObject({
			generation: generation(),
		});
		expect(receipts[0]).toMatchObject({
			outcome: "cleaned",
			sourceState: "retired",
		});
	});

	it.each(["preview", "apply"] as const)(
		"preserves the native refusal reason from the exact retirement %s",
		async (phase) => {
			sessions = [summary()];
			const refusal: HmuxRetireExitedReceipt = {
				workspaceId: "workspace-1",
				sessionId: "session-1",
				outcome: "skipped",
				reason: "lifetime_busy",
				message: "source maintenance lease is busy",
			};
			if (phase === "apply")
				retire.mockResolvedValueOnce([
					{
						workspaceId: "workspace-1",
						sessionId: "session-1",
						outcome: "retirable",
						generation: generation(),
					},
				]);
			retire.mockResolvedValueOnce([refusal]);
			const plan = await previewExitedManagedAgentCleanup(runtime);
			const receipts = await executeExitedManagedAgentCleanup(
				plan.candidates,
				runtime,
			);
			expect(receipts[0]).toMatchObject({
				outcome: "skipped",
				reason: "retire_refused",
				hmuxReason: refusal.reason,
				message: refusal.message,
			});
			expect(forget).not.toHaveBeenCalled();
			expect(retire).toHaveBeenCalledTimes(phase === "preview" ? 1 : 2);
		},
	);

	it.each(["preview", "apply"] as const)(
		"does not attribute a different session's %s refusal to the selected Agent",
		async (phase) => {
			sessions = [summary()];
			if (phase === "apply")
				retire.mockResolvedValueOnce([
					{
						workspaceId: "workspace-1",
						sessionId: "session-1",
						outcome: "retirable",
						generation: generation(),
					},
				]);
			retire.mockResolvedValueOnce([
				{
					workspaceId: "workspace-1",
					sessionId: "other",
					outcome: "skipped",
					reason: "lifetime_busy",
					message: "other session's refusal",
				},
			]);
			const plan = await previewExitedManagedAgentCleanup(runtime);
			const receipts = await executeExitedManagedAgentCleanup(
				plan.candidates,
				runtime,
			);
			expect(receipts[0]).toMatchObject({
				outcome: "skipped",
				reason: "retire_refused",
			});
			expect(receipts[0].hmuxReason).toBeUndefined();
			expect(receipts[0].message).toBeUndefined();
			expect(forget).not.toHaveBeenCalled();
		},
	);

	it("does not retire a candidate replaced by a canonical Agent", async () => {
		sessions = [summary()];
		runtime.absentEligibleAgentIds = () => new Set();
		const plan = await previewExitedManagedAgentCleanup(runtime);
		agents = [
			{
				...agent(),
				canonicalSpawn: {
					schemaVersion: 1,
					backendProfileId: "local",
					operationId: "spawn-successor",
				},
			},
		];

		const receipts = await executeExitedManagedAgentCleanup(
			plan.candidates,
			runtime,
		);

		expect(receipts[0]).toMatchObject({
			outcome: "skipped",
			reason: "binding_changed",
		});
		expect(retire).not.toHaveBeenCalled();
		expect(cleanupStale).not.toHaveBeenCalled();
		expect(forget).not.toHaveBeenCalled();
	});

	it("treats an idempotent source archive retry as retired", async () => {
		sessions = [summary()];
		runtime.absentEligibleAgentIds = () => new Set();
		retire
			.mockResolvedValueOnce([
				{
					workspaceId: "workspace-1",
					sessionId: "session-1",
					outcome: "retirable",
					generation: generation(),
				},
			])
			.mockImplementationOnce(async () => {
				sessions = [];
				return [
					{
						workspaceId: "workspace-1",
						sessionId: "session-1",
						outcome: "already_retired",
					},
				];
			});

		const plan = await previewExitedManagedAgentCleanup(runtime);
		const receipts = await executeExitedManagedAgentCleanup(
			plan.candidates,
			runtime,
		);

		expect(receipts[0]).toMatchObject({
			outcome: "cleaned",
			sourceState: "retired",
		});
		expect(forget).toHaveBeenCalledOnce();
	});

	it("fails closed when an absent preview gains any discovery generation", async () => {
		const plan = await previewExitedManagedAgentCleanup(runtime);
		sessions = [summary()];

		const receipts = await executeExitedManagedAgentCleanup(
			plan.candidates,
			runtime,
		);

		expect(receipts[0]).toMatchObject({
			outcome: "skipped",
			reason: "generation_changed",
		});
		expect(retire).not.toHaveBeenCalled();
		expect(forget).not.toHaveBeenCalled();
		expect(agents).toHaveLength(1);
	});

	it("fails closed when positive runtime evidence appears after preview", async () => {
		const plan = await previewExitedManagedAgentCleanup(runtime);
		absentEligible = new Set();

		const receipts = await executeExitedManagedAgentCleanup(
			plan.candidates,
			runtime,
		);

		expect(receipts[0]).toMatchObject({
			outcome: "skipped",
			reason: "binding_changed",
		});
		expect(forget).not.toHaveBeenCalled();
		expect(agents).toHaveLength(1);
	});

	it("fails closed when a generation appears immediately before registry cleanup", async () => {
		const listSessions = vi
			.fn<() => Promise<HmuxSessionSummary[]>>()
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([summary()]);
		runtime.listSessions = listSessions;

		const plan = await previewExitedManagedAgentCleanup(runtime);
		const receipts = await executeExitedManagedAgentCleanup(
			plan.candidates,
			runtime,
		);

		expect(receipts[0]).toMatchObject({
			outcome: "skipped",
			reason: "generation_changed",
		});
		expect(forget).not.toHaveBeenCalled();
	});

	it("compensates when a replacement appears after the final liveness check", async () => {
		forget.mockImplementation(async (candidate) => {
			agents = agents.filter((current) => current.id !== candidate.agentId);
			sessions = [
				summary({
					lifecycle: "ready",
					manifestLifecycle: "ready",
					health: "current_healthy",
					inputAllowed: true,
					terminalEpoch: "terminal-2",
					stopFence: {
						runnerPrincipal: "runner",
						runnerInstance: "runner-2",
						channelEpoch: "2",
						hostInstanceId: "host-replacement",
						terminalEpoch: "terminal-2",
					},
				}),
			];
			return true;
		});
		reconcileReplacement.mockImplementation((replacement) => {
			agents = [
				{
					...agent(),
					started: true,
					runtimeBinding: managedBindingFixture({
						sessionId: replacement.sessionId,
						workspaceId: replacement.workspaceId,
						stopFence: replacement.stopFence,
					}),
				},
			];
			return true;
		});

		const plan = await previewExitedManagedAgentCleanup(runtime);
		const receipts = await executeExitedManagedAgentCleanup(
			plan.candidates,
			runtime,
		);

		expect(receipts[0]).toMatchObject({
			outcome: "skipped",
			reason: "generation_changed",
		});
		expect(agents).toHaveLength(1);
		expect(reconcileReplacement).toHaveBeenCalledWith(
			expect.objectContaining({ terminalEpoch: "terminal-2" }),
		);
	});

	it("keeps the registry when the binding changes after preview", async () => {
		const plan = await previewExitedManagedAgentCleanup(runtime);
		agents = [agent("replacement-session")];

		const receipts = await executeExitedManagedAgentCleanup(
			plan.candidates,
			runtime,
		);

		expect(receipts[0]).toMatchObject({
			outcome: "skipped",
			reason: "binding_changed",
		});
		expect(forget).not.toHaveBeenCalled();
	});

	it("removes the exact stale generation after recovery refusal without leaving registration state", async () => {
		sessions = [
			summary({
				lifecycle: "unavailable",
				manifestLifecycle: "ready",
				health: "stale_transport",
				inputAllowed: false,
			}),
		];
		runtime.absentEligibleAgentIds = () => new Set();
		cleanupStale
			.mockResolvedValueOnce([
				{
					workspaceId: "workspace-1",
					sessionId: "session-1",
					outcome: "retirable",
					generation: generation(),
				},
			])
			.mockImplementationOnce(async () => {
				sessions = [];
				return [
					{
						workspaceId: "workspace-1",
						sessionId: "session-1",
						outcome: "retired",
					},
				];
			});

		const plan = await previewExitedManagedAgentCleanup(runtime);
		const receipts = await executeExitedManagedAgentCleanup(
			plan.candidates,
			runtime,
		);

		expect(cleanupStale).toHaveBeenNthCalledWith(
			1,
			[
				{
					workspaceId: "workspace-1",
					sessionId: "session-1",
					terminalEpoch: "terminal-1",
				},
			],
			false,
		);
		expect(cleanupStale).toHaveBeenNthCalledWith(2, expect.any(Array), true);
		expect(cleanupStale.mock.calls[1]?.[0]?.[0]).toMatchObject({
			generation: generation(),
		});
		expect(receipts[0]).toMatchObject({
			outcome: "cleaned",
			sourceState: "stale_removed",
		});
		expect(retire).not.toHaveBeenCalled();
		expect(forget).toHaveBeenCalledOnce();
		expect(agents).toEqual([]);
	});

	it("treats a stale source that disappears at cleanup preview as idempotently absent", async () => {
		sessions = [
			summary({
				lifecycle: "unavailable",
				manifestLifecycle: "ready",
				health: "stale_transport",
				inputAllowed: false,
			}),
		];
		runtime.absentEligibleAgentIds = () => new Set();
		cleanupStale.mockImplementationOnce(async () => {
			sessions = [];
			return [
				{
					workspaceId: "workspace-1",
					sessionId: "session-1",
					outcome: "skipped",
					reason: "not_found",
				},
			];
		});

		const plan = await previewExitedManagedAgentCleanup(runtime);
		const receipts = await executeExitedManagedAgentCleanup(
			plan.candidates,
			runtime,
		);

		expect(receipts[0]).toMatchObject({
			outcome: "cleaned",
			sourceState: "absent",
		});
		expect(cleanupStale).toHaveBeenCalledOnce();
		expect(forget).toHaveBeenCalledOnce();
		expect(agents).toEqual([]);
	});

	it("keeps the pane registration when a live generation refuses stale cleanup", async () => {
		sessions = [
			summary({
				lifecycle: "unavailable",
				manifestLifecycle: "ready",
				health: "stale_transport",
				inputAllowed: false,
			}),
		];
		runtime.absentEligibleAgentIds = () => new Set();
		cleanupStale.mockResolvedValue([
			{
				workspaceId: "workspace-1",
				sessionId: "session-1",
				outcome: "skipped",
				reason: "lifetime_busy",
			},
		]);

		const plan = await previewExitedManagedAgentCleanup(runtime);
		const receipts = await executeExitedManagedAgentCleanup(
			plan.candidates,
			runtime,
		);

		expect(receipts[0]).toMatchObject({
			outcome: "skipped",
			reason: "stale_cleanup_refused",
			hmuxReason: "lifetime_busy",
		});
		expect(cleanupStale).toHaveBeenCalledOnce();
		expect(forget).not.toHaveBeenCalled();
		expect(agents).toHaveLength(1);
	});

	it("preserves a pending recovery reason for the canonical stop path", async () => {
		sessions = [
			summary({
				lifecycle: "unavailable",
				manifestLifecycle: "ready",
				health: "stale_transport",
				inputAllowed: false,
			}),
		];
		runtime.absentEligibleAgentIds = () => new Set();
		cleanupStale.mockResolvedValue([
			{
				workspaceId: "workspace-1",
				sessionId: "session-1",
				outcome: "skipped",
				reason: "recovery_pending",
			},
		]);

		const plan = await previewExitedManagedAgentCleanup(runtime);
		const receipts = await executeExitedManagedAgentCleanup(
			plan.candidates,
			runtime,
		);

		expect(receipts[0]).toMatchObject({
			outcome: "skipped",
			reason: "stale_cleanup_refused",
			hmuxReason: "recovery_pending",
		});
		expect(forget).not.toHaveBeenCalled();
		expect(agents).toHaveLength(1);
	});
});
