// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getDockview: vi.fn(),
	isPanelApiInView: vi.fn(() => false),
	notifyPrefs: vi.fn(),
	systemNotify: vi.fn(async () => ({ accepted: true })),
}));

vi.mock("@tauri-apps/api/webviewWindow", () => ({
	getCurrentWebviewWindow: () => ({ label: "main" }),
}));
vi.mock("@/lib/settings/notify", () => ({
	notifyPrefs: mocks.notifyPrefs,
	systemNotify: mocks.systemNotify,
}));
vi.mock("@/lib/workspace/layout/agentPaneLocations", async (original) => ({
	...(await original<typeof import("@/lib/workspace/layout/agentPaneLocations")>()),
	isPanelApiInView: mocks.isPanelApiInView,
}));
vi.mock("@/lib/workspace/dock/dockRegistry", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("@/lib/workspace/dock/dockRegistry")
	>()),
	getDockview: mocks.getDockview,
	mountedDockviewEntries: () => [],
}));
vi.mock("@/lib/workspace/window/windows", () => ({
	isMainWindow: () => true,
}));

import { installAgentAttentionNotifier } from "@/lib/agents/agentAttentionNotifier";
import { useAgentAttention } from "@/lib/agents/agentAttentionStore";
import { installAgentAttentionWatch } from "@/lib/agents/agentAttentionWatch";
import type {
	ManagedAgentSemanticObserverClient,
	ManagedAgentSemanticObserverConnection,
} from "@/lib/agents/managedAgentSemanticObserverClient";
import { installManagedAgentSemanticObserverRuntime } from "@/lib/agents/managedAgentSemanticObserverRuntime";
import { HmuxSessionFailureError } from "@/lib/hmux/failure/sessionFailure";
import { HmuxStructuredTerminalAttachError } from "@/lib/hmux/failure/structuredTerminalAttachFailure";
import { hmuxSessionMetadataKey } from "@/lib/hmux/identity/hmuxSessionMetadata";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import { useStore } from "@/store";
import {
	agentFixture,
	hmuxSessionSummaryFixture,
	managedBindingFixture,
	stopFenceFixture,
} from "@/test/agentFixtures";

const agent = agentFixture({
	id: "agent-background",
	name: "background",
	projectId: "project-background",
	sessionId: "session-background",
	runtimeBinding: managedBindingFixture({
		sessionId: "session-background",
		workspaceId: "workspace-background",
		stopFence: stopFenceFixture({ terminalEpoch: "terminal-a" }),
	}),
});

const working: HmuxAgentRuntimeState = {
	terminalEpoch: "terminal-a",
	revision: "1",
	observedThroughOutputSeq: "8",
	lifecycle: "running",
	activity: "working",
	attention: "none",
	source: "controller_input",
	turnCompletedCount: "0",
};

interface FakeConnection extends ManagedAgentSemanticObserverConnection {
	closed: boolean;
	disconnect(): void;
	emit(state: HmuxAgentRuntimeState): void;
	forceEmit(state: HmuxAgentRuntimeState): void;
}

function fakeClient(initialState: () => HmuxAgentRuntimeState): {
	client: ManagedAgentSemanticObserverClient;
	connections: FakeConnection[];
} {
	const connections: FakeConnection[] = [];
	const client: ManagedAgentSemanticObserverClient = {
		connect: vi.fn(async (request) => {
			const initial = initialState();
			const connection: FakeConnection = {
				terminalEpoch: initial.terminalEpoch,
				closed: false,
				close: vi.fn(async () => {
					connection.closed = true;
				}),
				disconnect: () => {
					if (!connection.closed) request.onDisconnected();
				},
				emit: (state) => {
					if (!connection.closed) request.onRuntimeState(state);
				},
				forceEmit: request.onRuntimeState,
			};
			connections.push(connection);
			request.onRuntimeState(initial);
			return connection;
		}),
	};
	return { client, connections };
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function resetAttentionStore(): void {
	useAgentAttention.setState({
		episodes: {},
		acks: {},
		episodeKinds: {},
		episodeIds: {},
		displayStates: {},
		armedCompletions: {},
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	mocks.notifyPrefs.mockReturnValue({
		enabled: true,
		agentDone: true,
		approvalRequired: true,
		agentExited: true,
		suppressWhenVisible: false,
	});
	mocks.getDockview.mockReturnValue(undefined);
	mocks.isPanelApiInView.mockReturnValue(false);
	useStore.setState({
		agents: [agent],
		projects: [
			{
				id: "project-background",
				name: "Background Project",
				path: "/repo",
				kind: "local",
				isRepo: true,
			},
		],
		sshHosts: [],
		agentActivity: { [agent.id]: "working" },
		sessionAgentRuntimeState: {},
		sessionAgentRuntimeObservers: {},
		hmuxSessionMetadata: {},
	});
	resetAttentionStore();
});

afterEach(() => {
	vi.useRealTimers();
	useStore.setState({
		agents: [],
		projects: [],
		sshHosts: [],
		agentActivity: {},
		sessionAgentRuntimeState: {},
		sessionAgentRuntimeObservers: {},
		hmuxSessionMetadata: {},
	});
	resetAttentionStore();
});

it("turns one background Host completion into exactly one allowed desktop notification", async () => {
	let reconnectSnapshot = working;
	const { client, connections } = fakeClient(() => reconnectSnapshot);
	const stopWatch = installAgentAttentionWatch();
	const stopNotifier = installAgentAttentionNotifier();
	let stopRuntime = installManagedAgentSemanticObserverRuntime(client);
	await flushMicrotasks();

	expect(connections).toHaveLength(1);
	expect(mocks.systemNotify).not.toHaveBeenCalled();
	const completed: HmuxAgentRuntimeState = {
		...working,
		revision: "2",
		observedThroughOutputSeq: "14",
		activity: "waiting",
		source: "provider_event",
		turnCompletedCount: "1",
	};
	connections[0].emit(completed);

	expect(useAgentAttention.getState().episodes[agent.id]).toBe(1);
	expect(mocks.systemNotify).toHaveBeenCalledTimes(1);
	expect(mocks.systemNotify).toHaveBeenCalledWith(
		"background · Background Project",
		expect.any(String),
		expect.objectContaining({
			eventId: "hmux:session-background:terminal-a:turn:1",
		}),
	);

	// Duplicate reports and a reconnect snapshot carry the same revision/count.
	connections[0].emit(completed);
	reconnectSnapshot = completed;
	connections[0].disconnect();
	await vi.advanceTimersByTimeAsync(1_000);
	await flushMicrotasks();
	expect(connections).toHaveLength(2);
	expect(useAgentAttention.getState().episodes[agent.id]).toBe(1);
	expect(mocks.systemNotify).toHaveBeenCalledTimes(1);

	// Reinstalling the main-window runtime models a frontend reload. The exact
	// attach snapshot is a baseline, not a second completion episode.
	stopRuntime();
	await flushMicrotasks();
	stopRuntime = installManagedAgentSemanticObserverRuntime(client);
	await flushMicrotasks();
	expect(connections).toHaveLength(3);
	expect(useAgentAttention.getState().episodes[agent.id]).toBe(1);
	expect(mocks.systemNotify).toHaveBeenCalledTimes(1);

	stopRuntime();
	stopNotifier();
	stopWatch();
});

it("withdraws a disconnected working observation until the same Host delivers its current state", async () => {
	let snapshot = working;
	const { client, connections } = fakeClient(() => snapshot);
	const stopWatch = installAgentAttentionWatch();
	const stopRuntime = installManagedAgentSemanticObserverRuntime(client);
	try {
		await flushMicrotasks();
		expect(useAgentAttention.getState().displayStates[agent.id]).toBe(
			"working",
		);
		connections[0].disconnect();
		// The Host fact and completion counter remain available for fencing,
		// but an unavailable observer cannot claim that fact is still current.
		expect(
			useStore.getState().sessionAgentRuntimeState[agent.sessionId],
		).toEqual(working);
		expect(useAgentAttention.getState().displayStates[agent.id]).toBe(
			"unknown",
		);
		expect(useAgentAttention.getState().episodes[agent.id]).toBeUndefined();
		snapshot = {
			...working,
			revision: "2",
			activity: "waiting",
			source: "provider_event",
			turnCompletedCount: "1",
		};
		await vi.advanceTimersByTimeAsync(1_000);
		await flushMicrotasks();
		expect(connections).toHaveLength(2);
		expect(useAgentAttention.getState().displayStates[agent.id]).toBe(
			"waiting",
		);
		expect(useAgentAttention.getState().episodes[agent.id]).toBe(1);
	} finally {
		stopRuntime();
		stopWatch();
	}
});

it("does not keep a former working display when the next observation cannot attach", async () => {
	const { client, connections } = fakeClient(() => working);
	const stopWatch = installAgentAttentionWatch();
	const stopRuntime = installManagedAgentSemanticObserverRuntime(client);
	try {
		await flushMicrotasks();
		vi.mocked(client.connect).mockRejectedValue(
			new Error("hmux_endpoint_unavailable"),
		);
		connections[0].disconnect();
		await vi.advanceTimersByTimeAsync(300_000);
		await flushMicrotasks();
		expect(useAgentAttention.getState().displayStates[agent.id]).toBe(
			"unknown",
		);
		expect(useAgentAttention.getState().episodes[agent.id]).toBeUndefined();
		expect(
			useStore.getState().sessionAgentRuntimeState[agent.sessionId],
		).toEqual(working);
	} finally {
		stopRuntime();
		stopWatch();
	}
});

it("keeps a live pane observation when the background stream fails, rejecting retired callbacks", async () => {
	const { client, connections } = fakeClient(() => working);
	const stopWatch = installAgentAttentionWatch();
	const stopRuntime = installManagedAgentSemanticObserverRuntime(client);
	await flushMicrotasks();
	const pane = useStore
		.getState()
		.beginSessionAgentRuntimeObservation(agent.sessionId);
	try {
		pane.publish({ ...working, revision: "2", activity: "waiting" });
		connections[0].disconnect();
		connections[0].forceEmit({ ...working, revision: "99" });
		expect(useAgentAttention.getState().displayStates[agent.id]).toBe(
			"waiting",
		);
		expect(
			useStore.getState().sessionAgentRuntimeState[agent.sessionId].revision,
		).toBe("2");
		pane.dispose();
		expect(useAgentAttention.getState().displayStates[agent.id]).toBe(
			"unknown",
		);
		expect(useAgentAttention.getState().episodes[agent.id]).toBeUndefined();
	} finally {
		pane.dispose();
		stopRuntime();
		stopWatch();
	}
});

it("does not repeat an approval episode across a disconnected observation", async () => {
	let snapshot = working;
	const { client, connections } = fakeClient(() => snapshot);
	const stopWatch = installAgentAttentionWatch();
	const stopRuntime = installManagedAgentSemanticObserverRuntime(client);
	await flushMicrotasks();
	try {
		snapshot = {
			...working,
			revision: "2",
			activity: "waiting",
			attention: "approval_required",
			attentionId: "approval-a",
		};
		connections[0].emit(snapshot);
		expect(useAgentAttention.getState().episodes[agent.id]).toBe(1);
		connections[0].disconnect();
		expect(useAgentAttention.getState().displayStates[agent.id]).toBe(
			"unknown",
		);
		await vi.advanceTimersByTimeAsync(1_000);
		await flushMicrotasks();
		expect(useAgentAttention.getState().displayStates[agent.id]).toBe(
			"blocked",
		);
		expect(useAgentAttention.getState().episodes[agent.id]).toBe(1);
	} finally {
		stopRuntime();
		stopWatch();
	}
});

it("does not retry semantic attachment for a session the catalog proves absent", async () => {
	// A binding whose session no longer exists in any discovery root can never
	// attach. Live daily driver 2026-08-24: 28 such zombie bindings replayed the
	// full 11-attempt cycle every boot (~300 failed attaches per boot) and made
	// hmux-connection-diagnostics 508/512 one code. The catalog's typed verdict
	// (hmux_session_not_found) must terminate the observation on first sight.
	const connect = vi.fn(async () => {
		throw new HmuxStructuredTerminalAttachError({
			code: "hmux_session_not_found",
			message:
				'Hmux session "session-background" was not found in workspace "workspace-background"',
			retryDirective: "never",
		});
	});
	const refreshRuntimeProjection = vi.fn();
	const stopRuntime = installManagedAgentSemanticObserverRuntime(
		{ connect },
		refreshRuntimeProjection,
	);
	await flushMicrotasks();

	expect(connect).toHaveBeenCalledTimes(1);
	expect(refreshRuntimeProjection).toHaveBeenCalledWith({
		agentId: agent.id,
		evidence: expect.stringContaining("semantic_source_retired"),
	});
	await vi.advanceTimersByTimeAsync(120_000);
	await flushMicrotasks();
	expect(connect).toHaveBeenCalledTimes(1);

	stopRuntime();
});

it("uses the typed retry directive as the observer retry authority", async () => {
	const neverConnect = vi.fn(async () => {
		throw new HmuxStructuredTerminalAttachError({
			code: "hmux_backend_state_conflict",
			message: "opaque terminal attach refusal",
			retryDirective: "never",
		});
	});
	const stopNever = installManagedAgentSemanticObserverRuntime({
		connect: neverConnect,
	});
	await flushMicrotasks();
	await vi.advanceTimersByTimeAsync(120_000);
	await flushMicrotasks();
	expect(neverConnect).toHaveBeenCalledTimes(1);
	stopNever();

	const resyncConnect = vi.fn(async () => {
		throw new HmuxStructuredTerminalAttachError({
			code: "hmux_descriptor_unavailable",
			message: "opaque terminal attach refusal",
			retryDirective: "retry_after_resync",
		});
	});
	const refreshRuntimeProjection = vi.fn();
	const stopResync = installManagedAgentSemanticObserverRuntime(
		{ connect: resyncConnect },
		refreshRuntimeProjection,
	);
	await flushMicrotasks();
	expect(refreshRuntimeProjection).toHaveBeenCalledWith({
		agentId: agent.id,
		evidence: expect.stringContaining("semantic_attach_resync_requested"),
	});
	await vi.advanceTimersByTimeAsync(1_000);
	await flushMicrotasks();
	expect(resyncConnect).toHaveBeenCalledTimes(2);
	stopResync();
});

it("retires an unavailable observer when census proves its exact generation exited", async () => {
	const connect = vi.fn(async () => {
		throw new Error("hmux_endpoint_unavailable");
	});
	const stopRuntime = installManagedAgentSemanticObserverRuntime({ connect });
	await flushMicrotasks();

	expect(connect).toHaveBeenCalledTimes(1);
	const binding = agent.runtimeBinding;
	if (binding?.runtime !== "hmux_managed_v1" || !binding.stopFence) {
		throw new Error("expected exact managed fixture binding");
	}
	const exited = hmuxSessionSummaryFixture({
		sessionId: binding.sessionId,
		workspaceId: binding.workspaceId,
		lifecycle: "exited",
		manifestLifecycle: "exited",
		health: "exited",
		hostProcessAlive: false,
		terminalEpoch: binding.stopFence.terminalEpoch,
		stopFence: binding.stopFence,
	});
	useStore.setState({
		hmuxSessionMetadata: {
			[hmuxSessionMetadataKey(exited.workspaceId, exited.sessionId)]: exited,
		},
	});
	await flushMicrotasks();
	await vi.advanceTimersByTimeAsync(120_000);
	await flushMicrotasks();

	expect(connect).toHaveBeenCalledTimes(1);
	stopRuntime();
});

it("reconciles an SSH source whose managed generation was replaced", async () => {
	const remoteAgent = agentFixture({
		id: "agent-remote",
		projectId: "project-remote",
		sessionId: "session-remote",
		sessionKind: "ssh",
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "ssh-profile",
			sessionId: "session-remote",
			workspaceId: "workspace-remote",
			createIdempotencyKey: "create-remote",
			commandBridgeNonce: "bridge-remote",
			backendProfileId: "ssh-profile",
			stopFence: stopFenceFixture(),
		},
	});
	useStore.setState({
		agents: [remoteAgent],
		projects: [
			{
				id: "project-remote",
				name: "Remote Project",
				path: "/repo",
				kind: "ssh",
				sshHostId: "ssh-profile",
				isRepo: true,
			},
		],
		sshHosts: [
			{
				id: "ssh-profile",
				name: "Remote",
				host: "backend.example.test",
				port: 22,
				user: "dure",
				auth: "auto",
			},
		],
	});
	const connect = vi.fn(async (request) => {
		expect(request.binding.source).toBe("ssh");
		throw new Error("remote_hmux_managed_attach_generation_changed");
	});
	const refreshRuntimeProjection = vi.fn();
	const stopRuntime = installManagedAgentSemanticObserverRuntime(
		{ connect },
		refreshRuntimeProjection,
	);
	await flushMicrotasks();

	expect(connect).toHaveBeenCalledTimes(1);
	expect(refreshRuntimeProjection).toHaveBeenCalledWith({
		agentId: remoteAgent.id,
		evidence: expect.stringContaining("semantic_source_retired"),
	});
	await vi.advanceTimersByTimeAsync(120_000);
	await flushMicrotasks();
	expect(connect).toHaveBeenCalledTimes(1);

	stopRuntime();
});

it("publishes an exited native generation as a projection refresh hint", async () => {
	const { client, connections } = fakeClient(() => working);
	const refreshRuntimeProjection = vi.fn();
	const stopRuntime = installManagedAgentSemanticObserverRuntime(
		client,
		refreshRuntimeProjection,
	);
	await flushMicrotasks();

	connections[0].emit({
		...working,
		revision: "2",
		observedThroughOutputSeq: "12",
		lifecycle: "exited",
		source: "process_lifecycle",
	});

	expect(refreshRuntimeProjection).toHaveBeenCalledWith({
		agentId: agent.id,
		evidence: expect.stringContaining("semantic_runtime_exited"),
	});
	stopRuntime();
});

it("does not retry semantic attachment after the runtime reports a terminal failure", async () => {
	const connect = vi.fn(async () => {
		throw new HmuxSessionFailureError({
			correlationId: "failure_0123456789abcdef",
			sessionId: "session-background",
			workspaceId: "workspace-background",
			terminalEpoch: "terminal-a",
			code: "provider_exited_before_conversation_identity",
			phase: "conversation_identity",
			summary:
				"Managed provider exited before conversation identity was established.",
			exitKind: "provider_error",
			exitCode: 1,
			occurredUnixMs: "3000",
			retryPosture: "never",
		});
	});
	const stopRuntime = installManagedAgentSemanticObserverRuntime({ connect });
	await flushMicrotasks();

	expect(connect).toHaveBeenCalledTimes(1);
	await vi.advanceTimersByTimeAsync(120_000);
	await flushMicrotasks();
	expect(connect).toHaveBeenCalledTimes(1);

	stopRuntime();
});

it("rejects reports from a replaced binding and from the wrong terminal epoch", async () => {
	let initial = working;
	const { client, connections } = fakeClient(() => initial);
	const stopWatch = installAgentAttentionWatch();
	const stopNotifier = installAgentAttentionNotifier();
	const stopRuntime = installManagedAgentSemanticObserverRuntime(client);
	await flushMicrotasks();

	const successorBinding = managedBindingFixture({
		sessionId: "session-successor",
		workspaceId: "workspace-background",
		createIdempotencyKey: "create-successor",
		stopFence: stopFenceFixture({ terminalEpoch: "terminal-b" }),
	});
	initial = {
		...working,
		terminalEpoch: "terminal-b",
		revision: "1",
		observedThroughOutputSeq: "0",
		activity: "waiting",
		source: "provider_event",
	};
	useStore.setState((state) => ({
		agents: state.agents.map((candidate) =>
			candidate.id === agent.id
				? {
						...candidate,
						sessionId: "session-successor",
						runtimeBinding: successorBinding,
					}
				: candidate,
		),
	}));
	await flushMicrotasks();

	expect(connections).toHaveLength(2);
	expect(connections[0].closed).toBe(true);
	const staleCompletion: HmuxAgentRuntimeState = {
		...working,
		revision: "99",
		activity: "waiting",
		source: "provider_event",
		turnCompletedCount: "99",
	};
	connections[0].forceEmit(staleCompletion);
	connections[1].forceEmit(staleCompletion);

	expect(
		useStore.getState().sessionAgentRuntimeState["session-successor"],
	).toEqual(initial);
	expect(useAgentAttention.getState().episodes[agent.id]).toBeUndefined();
	expect(mocks.systemNotify).not.toHaveBeenCalled();

	stopRuntime();
	stopNotifier();
	stopWatch();
});
