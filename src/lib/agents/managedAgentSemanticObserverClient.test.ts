import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	appendDiagnostics: vi.fn(async () => undefined),
	attachStructured: vi.fn(),
	detachStructured: vi.fn(async () => undefined),
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

import { hmuxManagedAgentSemanticObserverClient } from "@/lib/agents/managedAgentSemanticObserverClient";
import { HmuxSessionFailureError } from "@/lib/hmux/failure/sessionFailure";
import { HmuxStructuredTerminalAttachError } from "@/lib/hmux/failure/structuredTerminalAttachFailure";
import type { HmuxAgentRuntimeState } from "@/lib/ipc";
import type { StructuredTerminalCarrierRecord } from "@/lib/terminal/structuredTerminalRecord";
import { managedBindingFixture, stopFenceFixture } from "@/test/agentFixtures";
import type { AgentRuntimeBindingV1 } from "@/types";

const fence = stopFenceFixture({ terminalEpoch: "terminal-a" });
const requiredCapabilities = [
	"terminal_state_binary_v1",
	"terminal_viewport_projection_v1",
	"agent_runtime_state_v1",
	"provider_conversation_identity_v1",
];
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
const conversationIdentity = {
	sessionId: "session-a",
	workspaceId: "workspace-a",
	...fence,
	revision: "1",
	observedThroughOutputSeq: "8",
	providerId: "codex",
	conversationId: "conversation-a",
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

function structuredAttachment(options?: {
	initialRecords?: readonly StructuredTerminalCarrierRecord[];
	selectedCapabilities?: readonly string[];
	terminalEpoch?: string;
	includeSession?: boolean;
	sessionFence?: typeof fence;
}) {
	const terminalEpoch = options?.terminalEpoch ?? "terminal-a";
	const initialRecords = [
		...(options?.initialRecords ?? [
			adapterRecord({ kind: "agent_runtime_state", state: working }),
		]),
	];
	let deliveryStarted = false;
	return {
		terminalEpoch,
		throughOutputSeq: "8",
		stateRevision: "1",
		initialDeliveryRecordCount: initialRecords.length,
		selectedCapabilities: [
			...(options?.selectedCapabilities ?? requiredCapabilities),
		],
		...(options?.includeSession === false
			? {}
			: {
					session: {
						sessionId: "session-a",
						workspaceId: "workspace-a",
						sessionClass: "managed",
						lifecycle: "ready",
						terminalEpoch,
						stopFence: options?.sessionFence ?? {
							...fence,
							terminalEpoch,
						},
						outputSeq: "8",
						capabilities: [...requiredCapabilities],
					},
				}),
		startDelivery: vi.fn(() => {
			if (deliveryStarted) return [];
			deliveryStarted = true;
			return initialRecords;
		}),
		readRecord: vi.fn(
			() =>
				new Promise<StructuredTerminalCarrierRecord>((resolve) => {
					resolveLiveRecord = resolve;
				}),
		),
	};
}

async function emitLiveRecord(record: StructuredTerminalCarrierRecord) {
	await vi.waitFor(() => expect(resolveLiveRecord).toBeTypeOf("function"));
	const resolve = resolveLiveRecord;
	resolveLiveRecord = undefined;
	resolve?.(record);
}

beforeEach(() => {
	vi.clearAllMocks();
	resolveLiveRecord = undefined;
	mocks.attachStructured.mockResolvedValue(structuredAttachment());
});

describe("hmuxManagedAgentSemanticObserverClient", () => {
	it("consumes the shared structured stream with read-only authority", async () => {
		const onRuntimeState = vi.fn();
		const onConversationIdentity = vi.fn();
		const onDisconnected = vi.fn();
		const binding = managedBindingFixture({
			sessionId: "session-a",
			workspaceId: "workspace-a",
			stopFence: fence,
		});
		const connection = await hmuxManagedAgentSemanticObserverClient.connect({
			binding,
			sshHosts: [],
			onRuntimeState,
			onConversationIdentity,
			onDisconnected,
		});

		expect(mocks.attachStructured).toHaveBeenCalledWith(
			expect.objectContaining({
				access: "read_only",
				binding,
				sshHosts: [],
			}),
		);
		expect(onRuntimeState).toHaveBeenCalledWith(working);
		const completed = {
			...working,
			revision: "2",
			activity: "waiting",
			source: "provider_event",
			turnCompletedCount: "1",
		} as const;
		await emitLiveRecord(
			adapterRecord({ kind: "agent_runtime_state", state: completed }),
		);
		await emitLiveRecord(
			adapterRecord({
				kind: "agent_runtime_state",
				state: { ...completed, terminalEpoch: "terminal-stale" },
			}),
		);
		await emitLiveRecord(
			adapterRecord({
				kind: "provider_conversation_identity",
				identity: conversationIdentity,
			}),
		);
		await emitLiveRecord(
			adapterRecord({
				kind: "provider_conversation_identity",
				identity: { ...conversationIdentity, terminalEpoch: "terminal-stale" },
			}),
		);
		await vi.waitFor(() => {
			expect(onRuntimeState.mock.calls).toEqual([[working], [completed]]);
			expect(onConversationIdentity).toHaveBeenCalledOnce();
			expect(onConversationIdentity).toHaveBeenCalledWith(conversationIdentity);
		});

		await emitLiveRecord(
			adapterRecord({
				kind: "closed",
				code: "hmux_transport_closed",
				message: "Host closed the stream",
				retryDirective: "reconnect",
			}),
		);
		await vi.waitFor(() => expect(onDisconnected).toHaveBeenCalledOnce());
		await connection.close();
		expect(mocks.detachStructured).toHaveBeenCalledOnce();
		expect(mocks.appendDiagnostics).not.toHaveBeenCalled();
	});

	it("rejects a local receipt from a replaced Host generation", async () => {
		mocks.attachStructured.mockResolvedValueOnce(
			structuredAttachment({
				sessionFence: stopFenceFixture({
					terminalEpoch: "terminal-replaced",
				}),
			}),
		);

		await expect(
			hmuxManagedAgentSemanticObserverClient.connect({
				binding: managedBindingFixture({
					sessionId: "session-a",
					workspaceId: "workspace-a",
					stopFence: fence,
				}),
				sshHosts: [],
				onRuntimeState: vi.fn(),
				onConversationIdentity: vi.fn(),
				onDisconnected: vi.fn(),
			}),
		).rejects.toThrow("managed_agent_semantic_attach_generation_changed");
		expect(mocks.detachStructured).toHaveBeenCalledOnce();
		expect(mocks.appendDiagnostics).toHaveBeenCalledWith([
			expect.objectContaining({
				code: "managed_agent_semantic_attach_generation_changed",
			}),
		]);
	});

	it("fails explicitly when an old Host lacks the structured semantic profile", async () => {
		mocks.attachStructured.mockResolvedValueOnce(
			structuredAttachment({
				selectedCapabilities: ["terminal_state_binary_v1"],
			}),
		);

		await expect(
			hmuxManagedAgentSemanticObserverClient.connect({
				binding: managedBindingFixture({
					sessionId: "session-a",
					workspaceId: "workspace-a",
					stopFence: fence,
				}),
				sshHosts: [],
				onRuntimeState: vi.fn(),
				onConversationIdentity: vi.fn(),
				onDisconnected: vi.fn(),
			}),
		).rejects.toThrow("managed_agent_semantic_projection_unavailable");
		expect(mocks.detachStructured).toHaveBeenCalledOnce();
	});

	it("rejects write authority on the semantic lane", async () => {
		mocks.attachStructured.mockResolvedValueOnce(
			structuredAttachment({
				selectedCapabilities: [
					...requiredCapabilities,
					"terminal_input_intent_v1",
				],
			}),
		);

		await expect(
			hmuxManagedAgentSemanticObserverClient.connect({
				binding: managedBindingFixture({
					sessionId: "session-a",
					workspaceId: "workspace-a",
					stopFence: fence,
				}),
				sshHosts: [],
				onRuntimeState: vi.fn(),
				onConversationIdentity: vi.fn(),
				onDisconnected: vi.fn(),
			}),
		).rejects.toThrow("managed_agent_semantic_attach_authority_mismatch");
	});

	it("records only the failed structured attach phase for an opaque error", async () => {
		mocks.attachStructured.mockRejectedValueOnce(new Error("opaque failure"));

		await expect(
			hmuxManagedAgentSemanticObserverClient.connect({
				binding: managedBindingFixture({
					sessionId: "session-a",
					workspaceId: "workspace-a",
					stopFence: fence,
				}),
				sshHosts: [],
				onRuntimeState: vi.fn(),
				onConversationIdentity: vi.fn(),
				onDisconnected: vi.fn(),
			}),
		).rejects.toThrow("opaque failure");
		expect(mocks.appendDiagnostics).toHaveBeenCalledWith([
			expect.objectContaining({
				code: "managed_agent_semantic_attach_failed",
				details: {
					phase: "attach",
					errorType: "Error",
					observationScope: "background",
				},
			}),
		]);
	});

	it("preserves typed attach evidence when the message has no machine code", async () => {
		mocks.attachStructured.mockRejectedValueOnce(
			new HmuxStructuredTerminalAttachError({
				code: "hmux_session_not_found",
				message: 'Hmux session "session-a" was not found in workspace "workspace-a"',
				retryDirective: "never",
			}),
		);

		await expect(
			hmuxManagedAgentSemanticObserverClient.connect({
				binding: managedBindingFixture({
					sessionId: "session-a",
					workspaceId: "workspace-a",
					stopFence: fence,
				}),
				sshHosts: [],
				onRuntimeState: vi.fn(),
				onConversationIdentity: vi.fn(),
				onDisconnected: vi.fn(),
			}),
		).rejects.toBeInstanceOf(HmuxStructuredTerminalAttachError);
		expect(mocks.appendDiagnostics).toHaveBeenCalledWith([
			expect.objectContaining({
				code: "hmux_session_not_found",
				paneId: "main-window-semantic-observer",
				details: {
					phase: "attach",
					errorType: "HmuxStructuredTerminalAttachError",
					retryDirective: "never",
					observationScope: "background",
				},
			}),
		]);
	});

	it("records the canonical failure code and correlation instead of unknown", async () => {
		mocks.attachStructured.mockRejectedValueOnce(
			new HmuxSessionFailureError({
				correlationId: "failure_0123456789abcdef",
				sessionId: "session-a",
				workspaceId: "workspace-a",
				terminalEpoch: "terminal-a",
				code: "provider_exited_before_conversation_identity",
				phase: "conversation_identity",
				summary:
					"Managed provider exited before conversation identity was established.",
				exitKind: "provider_error",
				exitCode: 1,
				occurredUnixMs: "3000",
				retryPosture: "never",
			}),
		);

		await expect(
			hmuxManagedAgentSemanticObserverClient.connect({
				binding: managedBindingFixture({
					sessionId: "session-a",
					workspaceId: "workspace-a",
					stopFence: fence,
				}),
				sshHosts: [],
				onRuntimeState: vi.fn(),
				onConversationIdentity: vi.fn(),
				onDisconnected: vi.fn(),
			}),
		).rejects.toBeInstanceOf(HmuxSessionFailureError);
		expect(mocks.appendDiagnostics).toHaveBeenCalledWith([
			expect.objectContaining({
				code: "provider_exited_before_conversation_identity",
				details: {
					phase: "conversation_identity",
					errorType: "HmuxSessionFailureError",
					observationScope: "background",
					correlationId: "failure_0123456789abcdef",
					occurredUnixMs: "3000",
				},
			}),
		]);
	});

	it("uses the same read-only record contract for an SSH managed Host", async () => {
		const remoteBinding: Extract<
			AgentRuntimeBindingV1,
			{ runtime: "hmux_managed_v1"; source: "ssh" }
		> = {
			schemaVersion: 1,
			runtime: "hmux_managed_v1",
			source: "ssh",
			hostId: "host-a",
			sessionId: "session-a",
			workspaceId: "workspace-a",
			createIdempotencyKey: "create-a",
			commandBridgeNonce: "bridge-a",
			stopFence: fence,
		};
		const sshHosts = [
			{
				id: "host-a",
				name: "Host A",
				host: "host.example",
				port: 22,
				user: "user",
				auth: "key" as const,
				keyPath: "/tmp/key",
			},
		];
		mocks.attachStructured.mockResolvedValueOnce(
			structuredAttachment({ includeSession: false }),
		);
		const onRuntimeState = vi.fn();
		const connection = await hmuxManagedAgentSemanticObserverClient.connect({
			binding: remoteBinding,
			sshHosts,
			onRuntimeState,
			onConversationIdentity: vi.fn(),
			onDisconnected: vi.fn(),
		});

		expect(mocks.attachStructured).toHaveBeenCalledWith(
			expect.objectContaining({
				access: "read_only",
				binding: remoteBinding,
				sshHosts,
			}),
		);
		expect(onRuntimeState).toHaveBeenCalledWith(working);
		await connection.close();
		expect(mocks.detachStructured).toHaveBeenCalledOnce();
	});
});
