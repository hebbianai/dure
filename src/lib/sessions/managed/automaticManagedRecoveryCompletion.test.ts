// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TauriCoreModule } from "@/lib/ipc/core";

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	observe: vi.fn(),
	reconcile: vi.fn(),
	inspect: vi.fn(),
	execute: vi.fn(),
	resolvePane: vi.fn(),
	emit: vi.fn(async () => {}),
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
	...(await original<TauriCoreModule>()),
	invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({ emit: mocks.emit }));
vi.mock("@/lib/workspace/dock", () => ({ resolvePaneById: mocks.resolvePane }));
vi.mock("@/lib/agents/agentAttentionNotifier", () => ({
	notifyAgentEvent: vi.fn(),
}));
vi.mock(
	"@/lib/sessions/managed/managedControlPlaneObservation",
	async (original) => ({
		...(await original<
			typeof import("@/lib/sessions/managed/managedControlPlaneObservation")
		>()),
		observeManagedControlPlane: mocks.observe,
	}),
);
vi.mock("@/lib/sessions/managed/managedAgentRehost", async (original) => ({
	...(await original<
		typeof import("@/lib/sessions/managed/managedAgentRehost")
	>()),
	reconcileManagedAgentRehost: mocks.reconcile,
	inspectDisconnectedManagedAgentRecovery: mocks.inspect,
	executeUnavailableManagedAgentRecovery: mocks.execute,
}));

import { installAgentTracker } from "@/lib/agents/agentTracker";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import { resetFrameBudgetSchedulerForTest } from "@/lib/scheduling/frameBudgetScheduler";
import { installAutomaticManagedRehostService } from "@/lib/sessions/managed/automaticManagedRehostService";
import type { ManagedAgentRehostInspection } from "@/lib/sessions/managed/managedAgentRehostInspection";
import { MANAGED_AGENT_REHOSTED_EVENT } from "@/lib/sessions/managed/managedAgentRehostSyncContract";
import {
	applyCommittedManagedAgentRehostProjection,
	commitManagedAgentRehostReceipt,
} from "@/lib/sessions/managed/managedAgentRehostSynchronization";
import type { ManagedAgentRecoveryResult } from "@/lib/sessions/managed/managedAgentRuntimeState";
import { clearHmuxPaneHealth } from "@/lib/terminal/hmuxPaneHealthStore";
import { durableAppStorage, useStore } from "@/store";
import {
	createNativeRehostBackendFixture,
	nativeResumeCreateFixture,
	nativeResumePayloadFixture,
} from "@/test/managedNativeRehostFixtures";
import { managedRehostAgentFixture } from "@/test/managedRehostFixtures";

function payload(generation: number) {
	return {
		...nativeResumePayloadFixture(generation),
		launchKind: "exact_resume" as const,
		sourceConversationId: "conversation-0",
		conversationId: "conversation-0",
	};
}

const first = payload(1);
const replacement = nativeResumeCreateFixture(1).session;
const recovery: ManagedAgentRecoveryResult = {
	permissionMode: "default",
	conversationId: "conversation-0",
	createIdempotencyKey: "create-1",
	backendRouteAuthority: first.backendRouteAuthority,
	replacement,
	receipt: {
		sourceSessionId: "session-0",
		operationId: first.operationId,
		action: "replace_ai_provider_with_explicit_conversation",
		outcome: "replaced",
		replayed: false,
	},
};
const inspection: ManagedAgentRehostInspection = {
	agentId: first.agentId,
	agentName: first.agentName,
	projectId: first.projectId,
	providerId: first.providerId,
	sourceBinding: first.sourceBinding,
	sourceConversationId: first.sourceConversationId,
	sourceLifecycle: "unavailable",
	sourcePaneState: "present",
	conversationId: first.conversationId,
	cwd: first.cwd,
	desktopId: first.desktopId,
	panelId: first.panelId,
	permissionMode: "default",
	terminalEnvironment: {},
	plan: {
		sessionId: "session-0",
		sourceBuildId: "old-build",
		action: "replace_ai_provider_with_explicit_conversation",
		allowed: true,
		requiresConfirmation: false,
	},
};

let backend: ReturnType<typeof createNativeRehostBackendFixture>;
let presentations: Array<() => void>;
let stops: Array<() => void>;
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
	vi.useFakeTimers();
	resetFrameBudgetSchedulerForTest();
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		value: "visible",
	});
	backend = createNativeRehostBackendFixture();
	backend.prepare(first);
	presentations = [];
	stops = [];
	mocks.emit.mockClear();
	mocks.invoke.mockReset().mockImplementation(backend.handleRequest);
	mocks.resolvePane
		.mockReset()
		.mockImplementation(
			() => new Promise((resolve) => presentations.push(() => resolve(null))),
		);
	mocks.reconcile.mockReset().mockResolvedValue(null);
	mocks.inspect.mockReset().mockResolvedValue(inspection);
	mocks.execute.mockReset().mockResolvedValue({ recovery });
	mocks.observe.mockReset().mockResolvedValue({
		sessions: [
			{
				...nativeResumeCreateFixture(0).session,
				lifecycle: "unavailable",
				manifestLifecycle: "ready",
				health: "stale_transport",
				hostProcessAlive: false,
			},
		],
		visibleDesktopIds: new Set([first.desktopId]),
	});
	clearHmuxPaneHealth(`${first.desktopId}:${first.panelId}`);
	useStore.setState({
		agents: [managedRehostAgentFixture(0)],
		accounts: [],
		projects: [
			{
				id: "project-1",
				name: "Project",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		spaces: [{ id: first.desktopId, name: "Desktop" }],
		activeSpaceId: first.desktopId,
		layouts: {
			[first.desktopId]: {
				panels: { [first.panelId]: { contentComponent: "agent", params: {} } },
			},
		},
		agentActivity: {},
		sessionAgentRuntimeState: {},
		hmuxSessionMetadata: {},
		agentRuntimeLaunchPresentation: {},
		sessionCwd: {},
		sshHosts: [],
	});
	stops.push(installAgentTracker());
});

afterEach(async () => {
	for (const stop of stops.reverse()) stop();
	// Complete owned fake response/presentation boundaries so the real
	// coordinator releases its in-flight promise between scenarios.
	for (let index = 0; index < 3; index += 1) {
		for (const response of backend.pending) response.reply();
		for (const finish of presentations) finish();
		await flush();
	}
	resetFrameBudgetSchedulerForTest();
	vi.useRealTimers();
	await durableAppStorage.flush();
});

async function start(branch: "execute" | "reconcile") {
	if (branch === "reconcile") {
		mocks.reconcile.mockResolvedValueOnce({
			payload: first,
			replacement,
			conversationId: first.conversationId,
		});
	}
	stops.push(installAutomaticManagedRehostService());
	await vi.advanceTimersByTimeAsync(2_300);
	expect(backend.pending).toHaveLength(1);
	expect(mocks.execute).toHaveBeenCalledTimes(branch === "execute" ? 1 : 0);
}

async function begin(branch: "execute" | "reconcile") {
	await start(branch);
	backend.pending[0].reply();
	await flush();
	expect(presentations).toHaveLength(1);
	expect(useStore.getState().agents[0].sessionId).toBe("session-1");
	expect(useStore.getState().agentActivity["agent-1"]).toBe("connecting");
}

function observe(activity: "working" | "waiting" | "exited", generation = 1) {
	useStore.getState().setSessionAgentRuntimeState(`session-${generation}`, {
		terminalEpoch: `terminal-${generation}`,
		revision: "1",
		observedThroughOutputSeq: "42",
		lifecycle: activity === "exited" ? "exited" : "running",
		activity: activity === "exited" ? "waiting" : activity,
		attention: "none",
		source: "controller_input",
		turnCompletedCount: "0",
	});
}

it.each(["fresh", "exact_resume"] as const)(
	"initializes legacy %s activity at installation without repeating it on replay",
	(launchKind) => {
		const legacy = {
			...first,
			launchKind,
			conversationId: launchKind === "fresh" ? null : first.conversationId,
		};
		useStore.setState({ agentActivity: { "agent-1": "exited" } });
		expect(applyCommittedManagedAgentRehostProjection(legacy)).toBe(true);
		expect(useStore.getState().agentActivity["agent-1"]).toBe("connecting");
		observe("working");
		expect(applyCommittedManagedAgentRehostProjection(legacy)).toBe(true);
		expect(useStore.getState().agentActivity["agent-1"]).toBe("working");
	},
);

describe.each(["execute", "reconcile"] as const)(
	"automatic %s completion",
	(branch) => {
		it("finishes normally with the shared projector's initial activity", async () => {
			await begin(branch);
			presentations[0]();
			await flush();
			expect(useStore.getState().agentActivity["agent-1"]).toBe("connecting");
			expect(mocks.emit).toHaveBeenCalledWith(
				MANAGED_AGENT_REHOSTED_EVENT,
				expect.objectContaining({ operationId: first.operationId }),
			);
			expect(backend.pending).toHaveLength(1);
			expect(mocks.execute).toHaveBeenCalledTimes(branch === "execute" ? 1 : 0);
		});

		it.each(["working", "waiting", "exited"] as const)(
			"preserves the newer %s semantic observation",
			async (activity) => {
				await begin(branch);
				observe(activity);
				expect(useStore.getState().agentActivity["agent-1"]).toBe(activity);
				presentations[0]();
				await flush();
				expect(mocks.emit).toHaveBeenCalledWith(
					MANAGED_AGENT_REHOSTED_EVENT,
					expect.objectContaining({ operationId: first.operationId }),
				);
				expect(useStore.getState().agentActivity["agent-1"]).toBe(activity);
			},
		);

		it("retains census metadata received during pane presentation", async () => {
			await begin(branch);
			useStore
				.getState()
				.setHmuxSessionMetadata({ ...replacement, outputSeq: "42" });
			const key = hmuxSessionMetadataKey("workspace-1", "session-1");
			const current = useStore.getState().hmuxSessionMetadata[key];
			presentations[0]();
			await flush();
			expect(mocks.emit).toHaveBeenCalledWith(
				MANAGED_AGENT_REHOSTED_EVENT,
				expect.objectContaining({ operationId: first.operationId }),
			);
			expect(useStore.getState().hmuxSessionMetadata[key]).toBe(current);
		});

		it("retains census metadata received while the commit response is delayed", async () => {
			await start(branch);
			useStore
				.getState()
				.setHmuxSessionMetadata({ ...replacement, outputSeq: "42" });
			const key = hmuxSessionMetadataKey("workspace-1", "session-1");
			const current = useStore.getState().hmuxSessionMetadata[key];
			backend.pending[0].reply();
			await flush();
			presentations[0]();
			await flush();
			expect(mocks.emit).toHaveBeenCalledWith(
				MANAGED_AGENT_REHOSTED_EVENT,
				expect.objectContaining({ operationId: first.operationId }),
			);
			expect(useStore.getState().hmuxSessionMetadata[key]).toBe(current);
		});

		it("does not recreate activity after Agent removal", async () => {
			await begin(branch);
			useStore.setState({ agents: [], agentActivity: {} });
			presentations[0]();
			await flush();
			expect(mocks.emit).toHaveBeenCalledWith(
				MANAGED_AGENT_REHOSTED_EVENT,
				expect.objectContaining({ operationId: first.operationId }),
			);
			expect(useStore.getState().agents).toEqual([]);
			expect(useStore.getState().agentActivity).toEqual({});
		});

		it("does not reset a newer successor when its old presentation completes", async () => {
			await begin(branch);
			const next = payload(2);
			backend.prepare(next);
			const completed = commitManagedAgentRehostReceipt(next, {
				activate: false,
			});
			await flush();
			expect(backend.pending).toHaveLength(2);
			backend.pending[1].reply();
			await flush();
			expect(presentations).toHaveLength(2);
			presentations[1]();
			await completed;
			observe("working", 2);
			presentations[0]();
			await flush();
			expect(useStore.getState().agents[0].sessionId).toBe("session-2");
			expect(useStore.getState().agentActivity["agent-1"]).toBe("working");
		});
	},
);
