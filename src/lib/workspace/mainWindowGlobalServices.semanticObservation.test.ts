import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const listeners = new Set<(state: unknown, previous: unknown) => void>();
	const managedAgent = {
		id: "agent-background",
		name: "background",
		provider: "codex",
		projectId: "project-a",
		worktreePath: "/repo/background",
		branch: "agent/background",
		sessionId: "session-background",
		sessionKind: "pty",
		runtimeBinding: {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "local",
			hostId: "local",
			sessionId: "session-background",
			workspaceId: "workspace-background",
			createIdempotencyKey: "create-background",
			stopFence: {
				runnerPrincipal: "runner-a",
				runnerInstance: "instance-a",
				channelEpoch: "7",
				hostInstanceId: "host-a",
				terminalEpoch: "terminal-a",
			},
		},
	};
	const setSessionAgentRuntimeState = vi.fn();
	const setState = vi.fn();
	const state = {
		agents: [managedAgent],
		sshHosts: [],
		hmuxSessionMetadata: {},
		setSessionAgentRuntimeState,
		beginSessionAgentRuntimeObservation: vi.fn((sessionId: string) => ({
			publish: (state: unknown) => setSessionAgentRuntimeState(sessionId, state),
			dispose: vi.fn(),
		})),
	};
	return {
		appendDiagnostics: vi.fn(async () => undefined),
		attachStructured: vi.fn(),
		detachStructured: vi.fn(async () => undefined),
		setSessionAgentRuntimeState,
		setState,
		state,
		startRegistry: vi.fn(() => () => undefined),
		subscribe: vi.fn(
			(listener: (state: unknown, previous: unknown) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		),
	};
});

vi.mock("@/lib/agents/agentAttentionNotifier", () => ({
	installAgentAttentionNotifier: () => () => undefined,
}));
vi.mock("@/lib/agents/providerConversationMetadataRuntime", () => ({
	installProviderConversationMetadataRuntime: () => () => undefined,
}));
vi.mock("@/lib/persistence/registry", () => ({
	startRegistrySync: mocks.startRegistry,
}));
vi.mock("@/lib/settings/notificationActivation", () => ({
	installNotificationActivationHandler: () => () => undefined,
}));
vi.mock("@/lib/spaces/localProjectReconciliation", () => ({
	reconcilePersistedLocalProjects: async () => undefined,
}));
vi.mock("@/store", () => ({
	useStore: {
		getState: () => mocks.state,
		setState: mocks.setState,
		subscribe: mocks.subscribe,
	},
}));
vi.mock("@/lib/ipc", () => ({
	hmux: {
		appendConnectionDiagnostics: mocks.appendDiagnostics,
		detachStructuredTerminal: mocks.detachStructured,
	},
}));
vi.mock("@/lib/terminal/structuredTerminalRecordAdapter", () => ({
	attachStructuredTerminalRecords: mocks.attachStructured,
}));

import type { StructuredTerminalCarrierRecord } from "@/lib/terminal/structuredTerminalRecord";
import { startMainWindowGlobalServices } from "@/lib/workspace/mainWindowGlobalServices";

const working = {
	terminalEpoch: "terminal-a",
	revision: "1",
	observedThroughOutputSeq: "8",
	lifecycle: "running",
	activity: "working",
	attention: "none",
	source: "controller_input",
	turnCompletedCount: "0",
} as const;
const conversationIdentity = {
	sessionId: "session-background",
	workspaceId: "workspace-background",
	runnerPrincipal: "runner-a",
	runnerInstance: "instance-a",
	channelEpoch: "7",
	hostInstanceId: "host-a",
	terminalEpoch: "terminal-a",
	revision: "1",
	observedThroughOutputSeq: "8",
	providerId: "codex",
	conversationId: "conversation-background",
	source: "provider_event",
} as const;

let resolveLiveRecord:
	| ((record: StructuredTerminalCarrierRecord) => void)
	| undefined;

function adapterRecord(
	record: Extract<StructuredTerminalCarrierRecord, { kind: "adapter" }>["record"],
): StructuredTerminalCarrierRecord {
	return { kind: "adapter", record, encodedByteLength: 1 };
}

beforeEach(() => {
	vi.clearAllMocks();
	resolveLiveRecord = undefined;
	const initialRecords = [
		adapterRecord({ kind: "agent_runtime_state", state: working }),
		adapterRecord({
			kind: "provider_conversation_identity",
			identity: conversationIdentity,
		}),
	];
	mocks.attachStructured.mockResolvedValue({
		terminalEpoch: "terminal-a",
		throughOutputSeq: "8",
		stateRevision: "1",
		initialDeliveryRecordCount: initialRecords.length,
		selectedCapabilities: [
			"terminal_state_binary_v1",
			"terminal_viewport_projection_v1",
			"agent_runtime_state_v1",
			"provider_conversation_identity_v1",
		],
		session: {
			sessionId: "session-background",
			workspaceId: "workspace-background",
			sessionClass: "managed",
			lifecycle: "ready",
			terminalEpoch: "terminal-a",
			stopFence: mocks.state.agents[0].runtimeBinding.stopFence,
			outputSeq: "8",
			capabilities: [],
		},
		startDelivery: () => initialRecords,
		readRecord: () =>
			new Promise<StructuredTerminalCarrierRecord>((resolve) => {
				resolveLiveRecord = resolve;
			}),
	});
});

it("observes semantic completion for a managed agent without a mounted pane", async () => {
	const stop = startMainWindowGlobalServices();

	await vi.waitFor(() => expect(resolveLiveRecord).toBeTypeOf("function"));
	expect(mocks.attachStructured).toHaveBeenCalledWith(
		expect.objectContaining({ access: "read_only" }),
	);
	expect(mocks.setSessionAgentRuntimeState).toHaveBeenCalledWith(
		"session-background",
		working,
	);
	expect(mocks.setState).toHaveBeenCalledOnce();
	const converge = mocks.setState.mock.calls[0]?.[0] as (
		state: typeof mocks.state,
	) => { agents?: Array<Record<string, unknown>> };
	const converged = converge(mocks.state);
	expect(converged.agents?.[0]).toMatchObject({
		conversationId: "conversation-background",
		runtimeBinding: {
			conversationIdentity: {
				schemaVersion: 1,
				...conversationIdentity,
			},
		},
	});

	const completed = {
		...working,
		revision: "2",
		observedThroughOutputSeq: "14",
		activity: "waiting",
		source: "provider_event",
		turnCompletedCount: "1",
	} as const;
	const resolve = resolveLiveRecord;
	resolveLiveRecord = undefined;
	resolve?.(
		adapterRecord({ kind: "agent_runtime_state", state: completed }),
	);
	await vi.waitFor(() =>
		expect(mocks.setSessionAgentRuntimeState).toHaveBeenLastCalledWith(
			"session-background",
			completed,
		),
	);

	stop();
	await vi.waitFor(() => expect(mocks.detachStructured).toHaveBeenCalledOnce());
});

it("retires queued semantic observation after main-window startup fails", async () => {
	const failure = new Error("registry installation failed");
	mocks.startRegistry.mockImplementationOnce(() => {
		throw failure;
	});
	expect(startMainWindowGlobalServices).toThrow(failure);
	// Start is deferred by the real observer runtime until the next microtask.
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(mocks.attachStructured).not.toHaveBeenCalled();
	expect(mocks.setSessionAgentRuntimeState).not.toHaveBeenCalled();
	expect(mocks.setState).not.toHaveBeenCalled();
	expect(mocks.detachStructured).not.toHaveBeenCalled();
});
