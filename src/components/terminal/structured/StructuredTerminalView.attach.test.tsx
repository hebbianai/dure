// @vitest-environment jsdom

import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HmuxSessionFailureError } from "@/lib/hmux/failure/sessionFailure";
import { t } from "@/lib/i18n";
import { DureBackendRequestError } from "@/lib/ipc/dureBackend";
import { hasSessionAgentRuntimeObservation } from "@/lib/sessions/runtime/sessionRuntimeStoreSlice";
import { useStore } from "@/store";
import {
	clearHmuxPaneHealth,
	getHmuxPaneHealth,
} from "@/lib/terminal/hmuxPaneHealthStore";
import { STRUCTURED_TERMINAL_INITIAL_DELIVERY_TIMEOUT_MS } from "@/lib/terminal/structuredTerminalRecordAdapter";
import { hmuxManagedBinding, remoteHmuxStandaloneBinding } from "@/lib/terminal/terminalBinding";
import { hmuxSessionSummaryFixture, stopFenceFixture } from "@/test/agentFixtures";
import {
	invokePaneAction,
	paneActionSnapshot,
} from "@/lib/workspace/pane/paneActionRegistry";
import {
	getWorkspacePerformanceSnapshot,
	workspacePerformance,
} from "@/lib/workspace/performance/workspacePerformance";
import {
	hmuxPaneBinding as binding,
	closedRecord,
	executionMarkerRecord,
	inputReceiptRecord,
	resizeAppliedReceiptRecord,
	viewportFrameRecord,
} from "@/test/terminalRecordFixtures";
import { StructuredTerminalRecoveryStatus } from "./StructuredTerminalRecoveryStatus";
import { StructuredTerminalView } from "./StructuredTerminalView";
import {
	attachReceipt,
	bootTerminal,
	bootTerminalWithFrame,
	createWindowFocusProbe,
	deliverRecord,
	deliverRecords,
	deliverViewportFrame,
	flushFrames,
	frames,
	installAttachMock,
	installDeferredAttachMock,
	mocks,
	pressEnter,
	protocolMocks,
	registerStructuredTerminalView,
	renderTerminalView,
	resetStructuredTerminalHarness,
	restoreStructuredTerminalHarness,
	semanticResizeCalls,
	sentInputIntents,
	sentRecords,
	sizeStructuredHost,
	structuredObserverId,
	terminalElement,
	terminalInput,
	terminalViewport,
	visibleTerminalText,
} from "./structuredTerminalTestHarness";

const TERMINAL_CONNECTION_FAILURE = "터미널에 연결하지 못했습니다.";

vi.mock(
	"@/lib/terminal/protocol/terminalStateProtocol",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("@/lib/terminal/protocol/terminalStateProtocol")
			>();
		return {
			...actual,
			decodeTerminalStateRecord: (
				...args: Parameters<typeof actual.decodeTerminalStateRecord>
			) => {
				protocolMocks.decodeCalls += 1;
				return actual.decodeTerminalStateRecord(...args);
			},
		};
	},
);

vi.mock("@/components/workspace/WorkspaceRuntimeContext", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).workspaceRuntimeContextMockFactory(),
);

vi.mock("@/lib/workspace/window/largeViewReturnSourceRuntime", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).largeViewReturnSourceRuntimeMockFactory(),
);

vi.mock("@/lib/workspace/window/currentWindowFocus", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).currentWindowFocusMockFactory(),
);

vi.mock("@/lib/ipc", async () =>
	(await import("./structuredTerminalTestHarness")).ipcMockFactory(),
);

vi.mock("@/store", async () =>
	(await import("./structuredTerminalTestHarness")).storeMockFactory(),
);

vi.mock("@tauri-apps/plugin-clipboard-manager", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).clipboardManagerMockFactory(),
);

vi.mock("@/lib/toast", async () =>
	(await import("./structuredTerminalTestHarness")).toastMockFactory(),
);

vi.mock("@/components/terminal/TerminalViewChrome", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).terminalViewChromeMockFactory(),
);

vi.mock("./TerminalCanvasRenderer", async () =>
	(
		await import("./structuredTerminalTestHarness")
	).terminalCanvasRendererMockFactory(),
);

registerStructuredTerminalView(StructuredTerminalView);

beforeEach(() => {
	clearHmuxPaneHealth("desktop-a:agent:agent-a");
	resetStructuredTerminalHarness();
});

afterEach(() => {
	restoreStructuredTerminalHarness();
});

const remoteManagedStartedMarker = {
	schemaVersion: 1,
	event: "managed_started",
	bridgeNonce: "bridge_nonce",
	sourceSessionId: "standalone_source",
	sourceWorkspaceId: "workspace_source",
	target: {
		sessionId: "managed_target",
		workspaceId: "workspace_target",
		sessionClass: "managed",
		lifecycle: "ready",
		providerId: "codex",
		runnerPrincipal: "user",
		runnerInstance: "runner",
		channelEpoch: "1",
		hostInstanceId: "host",
		terminalEpoch: "terminal",
	},
} as const;

function commandBridgeOscPayload(value: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `dure-hmux-command-bridge-v1;${btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "")}`;
}

describe("StructuredTerminalView resize transaction", () => {
	it("records one fenced initial attach with its native command duration", async () => {
		const before = workspacePerformance.snapshot();
		const { onRecords, resolveAttach } = installDeferredAttachMock();
		const view = renderTerminalView();

		try {
			await waitFor(() => expect(onRecords[0]).toBeTypeOf("function"));
			onRecords[0]?.(
				viewportFrameRecord({ texts: ["counted initial frame"] })
					.buffer as ArrayBuffer,
			);
			resolveAttach({
				initialDeliveryRecordCount: 1,
				backendCommandUs: 42_000,
			});

			await waitFor(() =>
				expect(visibleTerminalText(view.container)).toContain(
					"counted initial frame",
				),
			);
			const after = workspacePerformance.snapshot();
			const samples = after.terminalAttaches.slice(
				before.terminalAttaches.length,
			);
			expect(samples).toHaveLength(1);
			expect(samples[0]).toMatchObject({
				frontendInvokeMs: expect.any(Number),
				backendCommandMs: 42,
				receiptToBarrierMs: expect.any(Number),
				barrierToPaintMs: expect.any(Number),
			});
			expect(after.terminalAttachIntegrity).toEqual(
				before.terminalAttachIntegrity,
			);
		} finally {
			view.unmount();
		}
	});

	it("records the first canvas paint for its registered performance surface", async () => {
		const onRecords = installAttachMock();
		const markTerminalPaint = vi.spyOn(
			workspacePerformance,
			"markTerminalPaint",
		);
		const view = renderTerminalView();

		try {
			await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
			await deliverViewportFrame(onRecords[0]);
			expect(markTerminalPaint).toHaveBeenCalledOnce();
			expect(markTerminalPaint).toHaveBeenCalledWith("pane-a");
		} finally {
			view.unmount();
			markTerminalPaint.mockRestore();
		}
	});

	it("registers only the live attached production surface", async () => {
		mocks.desktopId = "desk-a";
		mocks.attach.mockResolvedValue(attachReceipt());
		const originalRegisterTerminal =
			workspacePerformance.registerTerminal.bind(workspacePerformance);
		const disposeTerminal = vi.fn();
		const registerTerminal = vi
			.spyOn(workspacePerformance, "registerTerminal")
			.mockImplementation((terminal) => {
				const registration = originalRegisterTerminal(terminal);
				return {
					...registration,
					dispose: () => {
						disposeTerminal();
						registration.dispose();
					},
				};
			});
		const view = renderTerminalView({ presentationRole: "background" });

		try {
			await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
			await waitFor(() => expect(registerTerminal).toHaveBeenCalledOnce());
			await waitFor(() =>
				expect(getWorkspacePerformanceSnapshot().totals).toMatchObject({
					terminalSurfaces: 1,
					hmuxObservers: 1,
				}),
			);
			expect(getWorkspacePerformanceSnapshot().workspaces).toContainEqual(
				expect.objectContaining({
					desktopId: "desk-a",
					terminalSurfaces: 1,
					visibleTerminalSurfaces: 1,
					hmuxObservers: 1,
				}),
			);

			view.rerender(
				<StructuredTerminalView
					sessionId="session-a"
					surfaceId="pane-a"
					binding={binding("session-a")}
					presentationRole="foreground"
				/>,
			);
			expect(registerTerminal).toHaveBeenCalledOnce();
			expect(disposeTerminal).not.toHaveBeenCalled();

			view.unmount();
			expect(disposeTerminal).toHaveBeenCalledOnce();
			expect(getWorkspacePerformanceSnapshot().totals).toMatchObject({
				terminalSurfaces: 0,
				hmuxObservers: 0,
			});
		} finally {
			view.unmount();
			registerTerminal.mockRestore();
		}
	});

	it("contains each structured grid so one pane paint cannot dirty sibling layout", () => {
		mocks.attach.mockResolvedValue(attachReceipt());
		const view = renderTerminalView();

		const host = view.getByTestId("structured-host");
		expect(host.classList.contains("structured-terminal-host")).toBe(true);
		expect(host.classList.contains("terminal-host")).toBe(true);
	});

	it("supplies the rendered defaults through the fenced viewport stream", async () => {
		const onRecords = installAttachMock(() => ({
			selectedCapabilities: ["terminal_default_colors_v1"],
		}));
		renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		expect(sentRecords("viewportIntent")).toHaveLength(0);

		await deliverViewportFrame(onRecords[0]);
		await waitFor(() => {
			const colors = sentRecords("viewportIntent").filter(
				({ record }) =>
					record.body.case === "viewportIntent" &&
					record.body.value.intent.case === "terminalDefaultColors",
			);
			expect(colors).toHaveLength(1);
			const [sent] = colors;
			expect(sent?.metadata.protocolMinor).toBe(6);
			if (
				sent?.record.body.case !== "viewportIntent" ||
				sent.record.body.value.intent.case !== "terminalDefaultColors"
			) {
				throw new Error("expected terminal default colors intent");
			}
			expect(sent.record.body.value.intent.value).toMatchObject({
				foregroundRgb: 0xe5e5e5,
				// The host is seeded with what the terminal actually paints —
				// glass/pane, not the app's derivation anchor. This is the value
				// OSC 11 answers, so an agent CLI derives its own chrome from it.
				backgroundRgb: 0x242424,
			});
		});
	});

	it("projects the authoritative viewport title into session presentation state", async () => {
		const onRecords = installAttachMock();
		renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		mocks.setSessionTitle.mockClear();

		await deliverViewportFrame(onRecords[0], {
			title: "Review authentication flow",
		});

		expect(mocks.setSessionTitle).toHaveBeenCalledOnce();
		expect(mocks.setSessionTitle).toHaveBeenLastCalledWith(
			"session-a",
			"Review authentication flow",
		);

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 2n,
			title: "Review authentication flow",
		});
		expect(mocks.setSessionTitle).toHaveBeenCalledOnce();

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 3n,
			title: "Ship authentication flow",
		});
		expect(mocks.setSessionTitle).toHaveBeenCalledTimes(2);
		expect(mocks.setSessionTitle).toHaveBeenLastCalledWith(
			"session-a",
			"Ship authentication flow",
		);
	});

	it("projects an empty viewport title on the first complete frame", async () => {
		const onRecords = installAttachMock();
		renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		mocks.setSessionTitle.mockClear();

		await deliverViewportFrame(onRecords[0], { title: "" });

		expect(mocks.setSessionTitle).toHaveBeenCalledOnce();
		expect(mocks.setSessionTitle).toHaveBeenCalledWith("session-a", "");
	});

	it("decodes a pre-attach complete frame exactly once at the carrier boundary", async () => {
		const { onRecords, resolveAttach } = installDeferredAttachMock();
		const view = renderTerminalView();
		await waitFor(() => expect(onRecords[0]).toBeTypeOf("function"));

		protocolMocks.decodeCalls = 0;
		const staged = viewportFrameRecord({ texts: ["typed preattach"] });
		onRecords[0]?.(staged.buffer as ArrayBuffer);
		expect(protocolMocks.decodeCalls).toBe(0);

		resolveAttach({ initialDeliveryRecordCount: 1 });
		await flushFrames();
		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toContain("typed preattach"),
		);
		expect(protocolMocks.decodeCalls).toBe(1);
	});

	it("forwards the initial and live Host conversation identity projections", async () => {
		const initialIdentity = {
			sessionId: "session-a",
			workspaceId: "workspace-a",
			runnerPrincipal: "runner-user",
			runnerInstance: "runner-instance",
			channelEpoch: "7",
			hostInstanceId: "host-instance",
			terminalEpoch: "terminal-a",
			revision: "1",
			observedThroughOutputSeq: "0",
			providerId: "codex",
			conversationId: "conversation-123",
			source: "launch_request",
		} as const;
		const onRecords = installAttachMock(() => ({
			selectedCapabilities: [],
			providerConversationIdentity: initialIdentity,
		}));
		const onProviderConversationIdentity = vi.fn();
		renderTerminalView({ onProviderConversationIdentity });

		await waitFor(() =>
			expect(onProviderConversationIdentity).toHaveBeenCalledWith(
				initialIdentity,
				binding("session-a"),
			),
		);
		const liveIdentity = {
			...initialIdentity,
			revision: "2",
			observedThroughOutputSeq: "9",
			source: "provider_event",
		} as const;
		const liveRecord = new TextEncoder().encode(
			JSON.stringify({
				kind: "provider_conversation_identity",
				identity: liveIdentity,
			}),
		);
		await act(async () => {
			onRecords[0]?.(liveRecord.buffer as ArrayBuffer);
			await Promise.resolve();
		});

		await waitFor(() =>
			expect(onProviderConversationIdentity.mock.calls).toEqual([
				[initialIdentity, binding("session-a")],
				[liveIdentity, binding("session-a")],
			]),
		);
	});

	it("installs initial and live Host runtime state into the exact attached session", async () => {
		const initialRuntime = {
			terminalEpoch: "terminal-a",
			revision: "1",
			observedThroughOutputSeq: "0",
			lifecycle: "running",
			activity: "working",
			attention: "none",
			source: "provider_event",
			turnCompletedCount: "0",
		} as const;
		const onRecords = installAttachMock(() => ({
			initialDeliveryRecordCount: 0,
			selectedCapabilities: ["agent_runtime_state_v1"],
			agentRuntimeState: initialRuntime,
		}));
		const view = renderTerminalView();
		const observed = () => {
			const state = useStore.getState();
			return hasSessionAgentRuntimeObservation(
				state.sessionAgentRuntimeState["session-a"],
				state.sessionAgentRuntimeObservers["session-a"],
			);
		};

		await waitFor(() =>
			expect(mocks.setSessionAgentRuntimeState).toHaveBeenCalledWith(
				"session-a",
				initialRuntime,
			),
		);
		const liveRuntime = {
			...initialRuntime,
			revision: "2",
			observedThroughOutputSeq: "9",
			activity: "waiting",
		} as const;
		const liveRecord = new TextEncoder().encode(
			JSON.stringify({
				kind: "agent_runtime_state",
				state: liveRuntime,
			}),
		);
		await act(async () => {
			onRecords[0]?.(liveRecord.buffer as ArrayBuffer);
			await Promise.resolve();
		});

		await waitFor(() =>
			expect(mocks.setSessionAgentRuntimeState.mock.calls).toEqual([
				["session-a", initialRuntime],
				["session-a", liveRuntime],
			]),
		);
		expect(observed()).toBe(true);
		view.unmount();
		expect(observed()).toBe(false);
		expect(useStore.getState().sessionAgentRuntimeState["session-a"]).toEqual(liveRuntime);
	});

	it("switches the same pane between agent and shell from Host identity", async () => {
		const initialIdentity = {
			terminalEpoch: "terminal-a",
			observedThroughOutputSeq: "0",
			agent: "codex",
			source: "process_inspection",
		} as const;
		const onRecords = installAttachMock(() => ({
			initialDeliveryRecordCount: 0,
			selectedCapabilities: ["agent_identity_projection_v1"],
			agentIdentity: initialIdentity,
		}));
		renderTerminalView();

		await waitFor(() =>
			expect(mocks.setSessionAgent.mock.calls).toEqual([
				["session-a", "codex"],
			]),
		);
		const shellIdentity = {
			...initialIdentity,
			observedThroughOutputSeq: "1",
			agent: null,
		};
		const liveRecord = new TextEncoder().encode(
			JSON.stringify({ kind: "agent_identity", identity: shellIdentity }),
		);
		await act(async () => {
			onRecords[0]?.(liveRecord.buffer as ArrayBuffer);
			await Promise.resolve();
		});

		await waitFor(() => {
			expect(mocks.setSessionAgent.mock.calls).toEqual([
				["session-a", "codex"],
				["session-a", null],
			]);
			expect(mocks.setSessionAgentPin.mock.calls).toEqual([
				["session-a", null],
				["session-a", null],
			]);
		});
	});

	it("commits Host working-directory projections into the session cwd", async () => {
		const onWorkingDirectory = vi.fn();
		const onRecords = installAttachMock(() => ({
			initialDeliveryRecordCount: 0,
			selectedCapabilities: ["working_directory_frame_v1"],
		}));
		renderTerminalView({ onWorkingDirectory });
		await waitFor(() => expect(onRecords).toHaveLength(1));

		const liveRecord = new TextEncoder().encode(
			JSON.stringify({
				kind: "working_directory",
				workingDirectory: {
					terminalEpoch: "terminal-a",
					observedThroughOutputSeq: "1",
					path: "/Users/dev/project",
					source: "process_inspection",
				},
			}),
		);
		await act(async () => {
			onRecords[0]?.(liveRecord.buffer as ArrayBuffer);
			await Promise.resolve();
		});

		await waitFor(() =>
			expect(mocks.setSessionCwd.mock.calls).toEqual([
				["session-a", "/Users/dev/project"],
			]),
		);
		expect(onWorkingDirectory).toHaveBeenCalledWith(
			{
				terminalEpoch: "terminal-a",
				observedThroughOutputSeq: "1",
				path: "/Users/dev/project",
				source: "process_inspection",
			},
			binding("session-a"),
		);
	});

	it("rejects runtime state from a retired structured attachment token", async () => {
		const onRecords: Array<(record: ArrayBuffer) => void> = [];
		mocks.attach.mockImplementation(
			async (request: {
				sessionId: string;
				onRecord(record: ArrayBuffer): void;
			}) => {
				onRecords.push(request.onRecord);
				const suffix = request.sessionId === "session-a" ? "a" : "b";
				return {
					terminalEpoch: `terminal-${suffix}`,
					throughOutputSeq: "0",
					stateRevision: "1",
					initialDeliveryRecordCount: 0,
					selectedCapabilities: ["agent_runtime_state_v1"],
					agentRuntimeState: {
						terminalEpoch: `terminal-${suffix}`,
						revision: "1",
						observedThroughOutputSeq: "0",
						lifecycle: "running",
						activity: "working",
						attention: "none",
						source: "provider_event",
					},
				};
			},
		);
		const view = renderTerminalView();
		await waitFor(() =>
			expect(mocks.setSessionAgentRuntimeState).toHaveBeenCalledWith(
				"session-a",
				expect.objectContaining({ terminalEpoch: "terminal-a" }),
			),
		);

		view.rerender(terminalElement("session-b"));
		await waitFor(() =>
			expect(mocks.setSessionAgentRuntimeState).toHaveBeenCalledWith(
				"session-b",
				expect.objectContaining({ terminalEpoch: "terminal-b" }),
			),
		);
		mocks.setSessionAgentRuntimeState.mockClear();

		const retiredRecord = new TextEncoder().encode(
			JSON.stringify({
				kind: "agent_runtime_state",
				state: {
					terminalEpoch: "terminal-a",
					revision: "99",
					observedThroughOutputSeq: "99",
					lifecycle: "running",
					activity: "waiting",
					attention: "none",
					source: "provider_event",
				},
			}),
		);
		act(() => onRecords[0]?.(retiredRecord.buffer as ArrayBuffer));

		expect(mocks.setSessionAgentRuntimeState).not.toHaveBeenCalled();
	});

	it("hands one remote OSC 778 managed-start marker to the pane transition", async () => {
		const onRecords = installAttachMock();
		const onRemoteManagedStarted = vi.fn();
		render(
			<StructuredTerminalView
				sessionId="standalone_source"
				surfaceId="pane-remote"
				binding={remoteHmuxStandaloneBinding(
					"standalone_source",
					"workspace_source",
					"host-rts",
					"bridge_nonce",
				)}
				onRemoteManagedStarted={onRemoteManagedStarted}
			/>,
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], { throughEventId: 40n });
		const record = executionMarkerRecord(
			41n,
			commandBridgeOscPayload(remoteManagedStartedMarker),
		);
		await deliverRecords(onRecords[0], record, record);

		expect(onRemoteManagedStarted).toHaveBeenCalledExactlyOnceWith(
			remoteManagedStartedMarker,
		);
	});

	it("prepares the exact managed session before opening its terminal stream", async () => {
		const calls: string[] = [];
		const ensure = vi.fn(async () => {
			calls.push("prepare");
		});
		mocks.attach.mockImplementation(async () => {
			calls.push("attach");
			return attachReceipt();
		});

		renderTerminalView({ ensure });

		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		expect(ensure).toHaveBeenCalledOnce();
		expect(calls).toEqual(["prepare", "attach"]);
	});

	it("keeps retrying a retry-same backend preparation until the existing service recovers", async () => {
		const ensure = vi.fn(async () => {
			if (ensure.mock.calls.length <= 2) {
				throw new DureBackendRequestError(
					"agent_runtime_native_rehost_unavailable",
					"credential registry is temporarily unavailable",
					{ kind: "operation", disposition: "retry_same" },
				);
			}
		});
		mocks.attach.mockResolvedValue(attachReceipt());
		const view = renderTerminalView({ ensure });

		await waitFor(() => expect(ensure).toHaveBeenCalledTimes(3), {
			timeout: 3_000,
		});
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		expect(
			view.queryByText(/credential registry is temporarily unavailable/),
		).toBeNull();
	});

	it("recovers a Host close that declares reconnect under a non-transport code", async () => {
		// The Host's subscriber-output backlog frame carries
		// ErrorCode::ResourceLimit with RetryPosture::Reconnect and the message
		// "requires snapshot recovery" — which is exactly what a successor
		// attach performs. Keying recoverability off the code string instead of
		// the posture parks this pane with a permanent error.
		const paneHealthId = "desktop-a:agent:agent-a";
		const onRecords = installAttachMock((attach) => ({
			initialDeliveryRecordCount: attach === 2 ? 1 : 0,
		}));
		const view = renderTerminalView({ paneHealthId });

		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], { throughOutputSeq: 42n });
		await waitFor(() =>
			expect(getHmuxPaneHealth(paneHealthId)).toMatchObject({
				state: "live",
			}),
		);

		await deliverRecord(
			onRecords[0],
			closedRecord(
				"hmux_resource_limit",
				"Hmux subscriber output backlog requires snapshot recovery",
				"reconnect",
			),
		);

		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		expect(getHmuxPaneHealth(paneHealthId)).toMatchObject({
			state: "recovering",
			reason: "structured_terminal_reattach",
		});
		expect(view.queryByText(/subscriber output backlog/)).toBeNull();
	});


	it("publishes exact pane attachment health through a bounded reconnect", async () => {
		mocks.desktopId = "desktop-a";
		const paneHealthId = "desktop-a:agent:agent-a";
		const onRecords = installAttachMock((attach) => ({
			initialDeliveryRecordCount: attach === 2 ? 1 : 0,
		}));
		const view = renderTerminalView({ paneHealthId });

		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await waitFor(() =>
			expect(getWorkspacePerformanceSnapshot().totals).toMatchObject({
				terminalSurfaces: 1,
				hmuxObservers: 1,
			}),
		);
		expect(getHmuxPaneHealth(paneHealthId)).toMatchObject({
			state: "connecting",
			reason: "structured_terminal_initial_attach",
		});

		await deliverViewportFrame(onRecords[0], { throughOutputSeq: 42n });
		await waitFor(() =>
			expect(getHmuxPaneHealth(paneHealthId)).toMatchObject({
				state: "live",
				terminalEpoch: "terminal-a",
				receivedSequence: "42",
				presentedSequence: "42",
			}),
		);

		await deliverRecord(
			onRecords[0],
			closedRecord(
				"hmux_transport_closed",
				"temporary carrier close",
				"reconnect",
			),
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		expect(getHmuxPaneHealth(paneHealthId)).toMatchObject({
			state: "recovering",
			reason: "structured_terminal_reattach",
			receivedSequence: "42",
			presentedSequence: "42",
		});
		await flushFrames();
		const commitsBeforeRetiredFrame =
			workspacePerformance.snapshot().terminalPresentation.total.commits;
		await deliverViewportFrame(onRecords[0], { throughOutputSeq: 99n });
		expect(
			workspacePerformance.snapshot().terminalPresentation.total.commits,
		).toBe(commitsBeforeRetiredFrame);

		const commitsBeforeReplacementFrame =
			workspacePerformance.snapshot().terminalPresentation.total.commits;
		await deliverViewportFrame(onRecords[1], { throughOutputSeq: 43n });
		await waitFor(() =>
			expect(getHmuxPaneHealth(paneHealthId)).toMatchObject({
				state: "live",
				receivedSequence: "43",
				presentedSequence: "43",
			}),
		);
		const presentation = workspacePerformance.snapshot().terminalPresentation;
		expect(presentation.total.commits - commitsBeforeReplacementFrame).toBe(1);
		expect(presentation.perSurface).toHaveLength(1);
		expect(getWorkspacePerformanceSnapshot().totals).toMatchObject({
			terminalSurfaces: 1,
			hmuxObservers: 1,
		});

		view.unmount();
		expect(getWorkspacePerformanceSnapshot().totals).toMatchObject({
			terminalSurfaces: 0,
			hmuxObservers: 0,
		});
		expect(getHmuxPaneHealth(paneHealthId)).toMatchObject({
			state: "live",
			receivedSequence: "43",
			presentedSequence: "43",
		});
	});

	it("keeps an exact session attached while full transcript opens and closes", async () => {
		const session = {
			sessionId: "session-a",
			workspaceId: "workspace-a",
			sessionClass: "managed" as const,
			lifecycle: "ready" as const,
			manifestLifecycle: "ready" as const,
			health: "current_healthy" as const,
			hostBuildVersion: "current-build",
			clientSelection: "direct_rust" as const,
			inputAllowed: true,
			detachOnly: false,
			terminalEpoch: "terminal-a",
			outputSeq: "1",
			capabilities: ["terminal_state_binary_v1"],
		};
		const onRecords = installAttachMock(() => ({
			session,
		}));
		const view = renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], { texts: ["ready"] });

		const input = terminalInput(view);
		fireEvent.keyDown(input, { key: "t", code: "KeyT", ctrlKey: true });
		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 2n,
			texts: ["TRANSCR partial history", "PgUp for earlier"],
		});
		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toContain(
				"TRANSCR partial history",
			),
		);

		fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(2));
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 3n,
			texts: ["ready"],
		});

		expect(visibleTerminalText(view.container)).toContain("ready");
		expect(mocks.attach).toHaveBeenCalledOnce();
		expect(mocks.detach).not.toHaveBeenCalled();
		expect(mocks.setHmuxSessionMetadata).toHaveBeenCalledOnce();
		expect(mocks.setHmuxSessionMetadata).toHaveBeenCalledWith(session);
	});

	it("reports retirement only after a pending attach settles and the observer detaches", async () => {
		const { resolveAttach } = installDeferredAttachMock();
		const { probe } = createWindowFocusProbe();
		const onSurfaceRetirement = vi.fn();
		const onSurfaceAttachmentStarted = vi.fn();
		const observingProbe = Object.assign(probe, {
			onSurfaceAttachmentStarted,
			onSurfaceRetirement,
		});
		let retirement: Promise<void> | undefined;
		const view = renderTerminalView({
			windowFocusProbe: observingProbe,
			onStructuredSurfaceRetirement: (pending) => {
				retirement = pending;
			},
		});
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		expect(onSurfaceAttachmentStarted).toHaveBeenCalledWith(
			structuredObserverId(1),
		);

		view.unmount();
		expect(retirement).toBeInstanceOf(Promise);
		expect(onSurfaceRetirement).toHaveBeenCalledWith(
			structuredObserverId(1),
			retirement,
		);
		expect(mocks.detach).toHaveBeenCalledOnce();
		let retired = false;
		void retirement?.then(() => {
			retired = true;
		});
		await act(async () => Promise.resolve());
		expect(retired).toBe(false);

		resolveAttach();
		await expect(retirement).resolves.toBeUndefined();
		// A late successful attach must confirm detachment after its reservation.
		expect(mocks.detach).toHaveBeenCalledTimes(2);
		expect(mocks.detach).toHaveBeenCalledWith(structuredObserverId(1));
	});

	it("reports one attachment start and retirement to the same probe generation", async () => {
		mocks.attach.mockResolvedValue(attachReceipt());
		const firstStarted = vi.fn();
		const firstRetired = vi.fn();
		const secondStarted = vi.fn();
		const secondRetired = vi.fn();
		const firstProbe = Object.assign(createWindowFocusProbe().probe, {
			onSurfaceAttachmentStarted: firstStarted,
			onSurfaceRetirement: firstRetired,
		});
		const secondProbe = Object.assign(createWindowFocusProbe().probe, {
			onSurfaceAttachmentStarted: secondStarted,
			onSurfaceRetirement: secondRetired,
		});
		const view = renderTerminalView({ windowFocusProbe: firstProbe });
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		expect(firstStarted).toHaveBeenCalledWith(structuredObserverId(1));

		view.rerender(
			<StructuredTerminalView
				sessionId="session-a"
				surfaceId="pane-a"
				binding={binding("session-a")}
				windowFocusProbe={secondProbe}
			/>,
		);
		expect(mocks.attach).toHaveBeenCalledOnce();
		expect(secondStarted).not.toHaveBeenCalled();

		view.unmount();
		expect(firstRetired).toHaveBeenCalledWith(
			structuredObserverId(1),
			expect.any(Promise),
		);
		expect(secondRetired).not.toHaveBeenCalled();
	});

	it("aborts a missing counted seed so retirement can detach", async () => {
		mocks.attach.mockResolvedValue(
			attachReceipt({ initialDeliveryRecordCount: 1 }),
		);
		let retirement: Promise<void> | undefined;
		const view = renderTerminalView({
			onStructuredSurfaceRetirement: (pending) => {
				retirement = pending;
			},
		});
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await act(async () => {
			await Promise.resolve();
		});

		view.unmount();

		expect(retirement).toBeInstanceOf(Promise);
		await expect(retirement).resolves.toBeUndefined();
		expect(mocks.detach).toHaveBeenCalledOnce();
		expect(mocks.detach).toHaveBeenCalledWith(structuredObserverId(1));
	});

	it("keeps a managed rehost retirement close silent until the exact successor frame is current", async () => {
		const onRecords = installAttachMock((attach) => ({
			terminalEpoch: attach === 1 ? "terminal-source" : "terminal-successor",
			initialDeliveryRecordCount: attach === 2 ? 1 : 0,
		}));
		const view = renderTerminalView({ sessionId: "retired-source" });
		sizeStructuredHost(view, 800, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			terminalEpoch: "terminal-source",
			projectionRevision: 1n,
			texts: ["healthy source frame", ...Array(19).fill("")],
		});
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		const [sourceResize] = sentRecords("inputIntent");
		await deliverRecord(
			onRecords[0],
			resizeAppliedReceiptRecord(
				sourceResize?.metadata.recordId ?? 0n,
				80,
				20,
				"terminal-source",
			),
		);
		mocks.send.mockClear();

		await deliverRecord(
			onRecords[0],
			closedRecord(
				"hmux_transport_closed",
				"retired source transport closed",
				"reconnect",
			),
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));

		expect(visibleTerminalText(view.container)).toContain(
			"healthy source frame",
		);
		expect(view.queryByText(/retired source transport closed/)).toBeNull();
		expect(terminalInput(view).disabled).toBe(true);

		await deliverViewportFrame(onRecords[1], {
			terminalEpoch: "terminal-successor",
			projectionRevision: 2n,
			throughOutputSeq: 1n,
			texts: ["exact successor frame", ...Array(19).fill("")],
		});
		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toContain(
				"exact successor frame",
			),
		);
		expect(view.queryByText(/retired source transport closed/)).toBeNull();

		mocks.send.mockClear();
		pressEnter(terminalInput(view));
		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));
		expect(mocks.send.mock.calls[0]?.[0]).toBe(structuredObserverId(2));
		expect(sentInputIntents("key")[0]?.record.terminalEpoch).toBe(
			"terminal-successor",
		);
	});

	it("shows a connection summary when the bounded successor also closes", async () => {
		const paneHealthId = "desktop-a:agent:agent-a";
		const onRecords = installAttachMock((attach) => ({
			initialDeliveryRecordCount: attach === 2 ? 1 : 0,
		}));
		const view = renderTerminalView({ paneHealthId });
		sizeStructuredHost(view, 800, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			texts: ["retained source", ...Array(19).fill("")],
		});
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));

		await deliverRecord(
			onRecords[0],
			closedRecord(
				"hmux_transport_closed",
				"source transport closed",
				"reconnect",
			),
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		expect(view.queryByText(/source transport closed/)).toBeNull();

		await deliverRecord(
			onRecords[1],
			closedRecord(
				"hmux_transport_closed",
				"replacement transport closed",
				"reconnect",
			),
		);

		await waitFor(() =>
			expect(view.getByText(TERMINAL_CONNECTION_FAILURE)).toBeTruthy(),
		);
		expect(view.queryByText(/source transport closed/)).toBeNull();
		expect(mocks.attach).toHaveBeenCalledTimes(2);
		expect(getHmuxPaneHealth(paneHealthId)).toMatchObject({
			state: "error",
			reason: "replacement transport closed",
		});
	});

	it("recovers again after the replacement advances its complete-frame high-water", async () => {
		const onRecords = installAttachMock((attach) => ({
			initialDeliveryRecordCount: attach > 1 ? 1 : 0,
		}));
		const view = renderTerminalView();
		sizeStructuredHost(view, 800, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			throughOutputSeq: 400n,
			texts: ["source complete frame", ...Array(19).fill("")],
		});

		await deliverRecord(
			onRecords[0],
			closedRecord(
				"hmux_transport_closed",
				"source carrier closed",
				"reconnect",
			),
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		expect(visibleTerminalText(view.container)).toContain(
			"source complete frame",
		);
		expect(view.queryByText(/source carrier closed/)).toBeNull();

		await act(async () => {
			await Promise.resolve();
			onRecords[1]?.(
				viewportFrameRecord({
					projectionRevision: 40n,
					throughOutputSeq: 403n,
					texts: ["replacement seed", ...Array(19).fill("")],
				}).buffer as ArrayBuffer,
			);
		});
		await flushFrames();
		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toContain("replacement seed"),
		);

		await deliverViewportFrame(onRecords[1], {
			projectionRevision: 41n,
			throughOutputSeq: 404n,
			texts: ["replacement progressed", ...Array(19).fill("")],
		});
		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toContain(
				"replacement progressed",
			),
		);
		expect(sentInputIntents("key")).toHaveLength(0);

		await deliverRecord(
			onRecords[1],
			closedRecord(
				"hmux_transport_closed",
				"progressed replacement carrier closed",
				"reconnect",
			),
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(3));
		expect(visibleTerminalText(view.container)).toContain(
			"replacement progressed",
		);
		expect(
			view.queryByText(/progressed replacement carrier closed/),
		).toBeNull();
		expect(terminalInput(view).disabled).toBe(true);

		await act(async () => {
			await Promise.resolve();
			onRecords[2]?.(
				viewportFrameRecord({
					projectionRevision: 42n,
					throughOutputSeq: 404n,
					texts: ["third exact seed", ...Array(19).fill("")],
				}).buffer as ArrayBuffer,
			);
		});
		await flushFrames();
		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toContain("third exact seed"),
		);
		expect(
			view.queryByText(/progressed replacement carrier closed/),
		).toBeNull();
		expect(mocks.attach).toHaveBeenCalledTimes(3);
	});

	it("keeps a replay-only replacement bounded at its exact close", async () => {
		const onRecords = installAttachMock((attach) => ({
			initialDeliveryRecordCount: attach === 2 ? 1 : 0,
		}));
		const view = renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			texts: ["source before replay", ...Array(19).fill("")],
		});

		await deliverRecord(
			onRecords[0],
			closedRecord(
				"hmux_transport_closed",
				"source before replay closed",
				"reconnect",
			),
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));

		const replay = viewportFrameRecord({
			projectionRevision: 9n,
			texts: ["replacement replay", ...Array(19).fill("")],
		});
		await act(async () => {
			await Promise.resolve();
			onRecords[1]?.(replay.buffer as ArrayBuffer);
		});
		await flushFrames();
		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toContain(
				"replacement replay",
			),
		);
		await deliverRecord(onRecords[1], replay);
		await flushFrames();

		const replacementClose = closedRecord(
			"hmux_transport_closed",
			"exact replay-only replacement close",
			"reconnect",
		);
		await deliverRecords(onRecords[1], replacementClose, replacementClose);

		await waitFor(() =>
			expect(view.getByText(TERMINAL_CONNECTION_FAILURE)).toBeTruthy(),
		);
		expect(mocks.attach).toHaveBeenCalledTimes(2);
	});

	it("clears the attach failure once the recovery attach delivers a complete frame", async () => {
		// An untyped rejection: the adapter's typed failures take the reconnect
		// or terminal branches, so this is the shape that reaches
		// reportRecoverableFailure(attachment, "attach", ...).
		const onRecords = installAttachMock((attach) =>
			attach === 1
				? Promise.reject(new Error("structured terminal attach unavailable"))
				: undefined,
		);
		const view = renderTerminalView();

		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		expect(view.getByText(TERMINAL_CONNECTION_FAILURE)).toBeTruthy();

		await deliverViewportFrame(onRecords[1], {
			texts: ["recovered after retry", ...Array(19).fill("")],
		});

		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toContain(
				"recovered after retry",
			),
		);
		// A pane that is serving frames again must not keep reporting the
		// failure it already recovered from. Leaving it up is why an
		// already-healthy pane reads as a fresh recurrence.
		expect(view.queryByText(TERMINAL_CONNECTION_FAILURE)).toBeNull();
	});

	it("clears a carrier failure once the successor attach delivers a complete frame", async () => {
		const onRecords = installAttachMock();
		const view = renderTerminalView();

		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverRecord(
			onRecords[0],
			closedRecord(
				"hmux_transport_closed",
				"carrier closed before any frame",
				"reconnect",
			),
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		expect(view.getByText(TERMINAL_CONNECTION_FAILURE)).toBeTruthy();

		await deliverViewportFrame(onRecords[1], {
			texts: ["carrier recovered", ...Array(19).fill("")],
		});

		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toContain(
				"carrier recovered",
			),
		);
		expect(view.queryByText(TERMINAL_CONNECTION_FAILURE)).toBeNull();
	});

	it("shows an attach failure immediately when no complete frame belongs to that binding", async () => {
		mocks.attach
			.mockRejectedValueOnce(new Error("initial terminal attach unavailable"))
			.mockImplementation(() => new Promise(() => {}));
		const view = renderTerminalView();

		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		expect(view.getByText(TERMINAL_CONNECTION_FAILURE)).toBeTruthy();
		expect(view.queryByText(/initial terminal attach unavailable/)).toBeNull();
		fireEvent.click(view.getByRole("button", { name: "오류 상세 복사" }));
		const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
		await waitFor(() =>
			expect(vi.mocked(writeText)).toHaveBeenCalledWith(
				expect.stringContaining("initial terminal attach unavailable"),
			),
		);
	});

	it("self-heals once, automatically, when recovery is marked automatic", async () => {
		// Red on the click-only tree: the user had to press resume on every
		// dead pane by hand (2026-09-01 review).
		mocks.attach
			.mockRejectedValueOnce(new Error("connect to Hmux Host failed"))
			.mockImplementation(() => new Promise(() => {}));
		const resume = vi.fn(() => new Promise<void>(() => {}));
		const view = renderTerminalView({
			attachRecovery: {
				intent: "resume",
				ownerKey: "fixture-runtime",
				automatic: true,
				resume,
				context: "pane=p-1",
			},
		});
		await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
		await waitFor(() =>
			expect(view.getByText("세션을 다시 여는 중…")).toBeTruthy(),
		);
		expect(view.queryAllByRole("button")).toEqual([]);
		expect(resume).toHaveBeenCalledTimes(1);
	});

	it("restores manual recovery only after the automatic attempt fails", async () => {
		let rejectResume: (reason: Error) => void = () => {};
		const resume = vi.fn(
			() =>
				new Promise<void>((_resolve, reject) => {
					rejectResume = reject;
				}),
		);
		const paneId = "pending-recovery-pane";
		const view = render(
			<StructuredTerminalRecoveryStatus
				paneId={paneId}
				error="attach unavailable"
				attachRecovery={{
					intent: "resume",
					ownerKey: "fixture-runtime",
					automatic: true,
					resume,
					context: paneId,
				}}
			/>,
		);
		await waitFor(() => expect(resume).toHaveBeenCalledOnce());
		expect(view.queryAllByRole("button")).toEqual([]);
		expect(paneActionSnapshot(paneId)?.actions).toEqual([]);
		expect(await invokePaneAction(paneId, "resume")).toMatchObject({
			ok: false,
			error: { code: "pane_action_unavailable" },
		});
		expect(resume).toHaveBeenCalledOnce();

		await act(async () => rejectResume(new Error("resume failed")));
		const retry = await view.findByRole("button", { name: "세션 이어서 재개" });
		expect(paneActionSnapshot(paneId)?.actions).toEqual(["resume"]);
		fireEvent.click(retry);
		await waitFor(() => expect(resume).toHaveBeenCalledTimes(2));
		expect(view.queryAllByRole("button")).toEqual([]);
		expect(paneActionSnapshot(paneId)?.actions).toEqual([]);
	});

	it("offers resume and copyable details when an attach fails with recovery wired", async () => {
		// Red before the recovery affordance existed: a dead session's pane
		// showed only a passive error pill, and every fix path lived outside
		// the pane (2026-09-01 socket-reap outage).
		mocks.attach
			.mockRejectedValueOnce(new Error("connect to Hmux Host failed"))
			.mockImplementation(() => new Promise(() => {}));
		let resolveResume: () => void = () => {};
		const resume = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveResume = resolve;
				}),
		);
		const onAttachRecoveryPresentationChange = vi.fn();
		const view = renderTerminalView({
			attachRecovery: {
				intent: "resume",
				ownerKey: "fixture-runtime",
				resume,
				context: "agent=a-1 pane=p-1 session=s-1",
			},
			onAttachRecoveryPresentationChange,
		});
		await waitFor(() =>
			expect(
				view.getByRole("button", { name: "세션 이어서 재개" }),
			).toBeTruthy(),
		);
		expect(onAttachRecoveryPresentationChange).toHaveBeenCalledWith(true);
		fireEvent.click(view.getByRole("button", { name: "오류 상세 보기" }));
		expect(view.getByText(/connect to Hmux Host failed/)).toBeTruthy();

		fireEvent.click(view.getByRole("button", { name: "오류 상세 복사" }));
		const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
		await waitFor(() => expect(vi.mocked(writeText)).toHaveBeenCalled());
		const calls = vi.mocked(writeText).mock.calls;
		const copied = calls[calls.length - 1]?.[0] ?? "";
		expect(copied).toContain("agent=a-1 pane=p-1 session=s-1");
		expect(copied).toContain("connect to Hmux Host failed");

		fireEvent.click(view.getByRole("button", { name: "세션 이어서 재개" }));
		expect(resume).toHaveBeenCalledTimes(1);
		await waitFor(() =>
			expect(view.getByText("세션을 다시 여는 중…")).toBeTruthy(),
		);
		expect(view.queryAllByRole("button")).toEqual([]);
		resolveResume();
		view.unmount();
		expect(onAttachRecoveryPresentationChange).toHaveBeenLastCalledWith(false);
	});

	it("offers to recreate a missing worktree before resuming the exact conversation", async () => {
		mocks.attach
			.mockRejectedValueOnce(new Error("connect to Hmux Host failed"))
			.mockImplementation(() => new Promise(() => {}));
		const transitions: string[] = [];
		const inspect = vi.fn(async () => {
			transitions.push("inspect");
			return "missing" as const;
		});
		const recreate = vi.fn(async () => {
			transitions.push("recreate");
		});
		const resume = vi.fn(async () => {
			transitions.push("resume");
		});
		const view = renderTerminalView({
			attachRecovery: {
				intent: "resume",
				ownerKey: "fixture-runtime",
				automatic: true,
				resume,
				context: "agent=a-1 pane=p-1 session=s-1",
				worktree: {
					path: "/repo/.worktrees/agent-a",
					branch: "agent/agent-a",
					inspect,
					recreate,
				},
			},
		});

		await waitFor(() =>
			expect(
				view.getByRole("button", { name: "워크트리 다시 만들고 재개" }),
			).toBeTruthy(),
		);
		expect(view.getByText(/agent\/agent-a/)).toBeTruthy();
		expect(resume).not.toHaveBeenCalled();

		fireEvent.click(
			view.getByRole("button", { name: "워크트리 다시 만들고 재개" }),
		);
		await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
		expect(recreate).toHaveBeenCalledTimes(1);
		expect(transitions).toEqual(["inspect", "recreate", "resume"]);
	});

	it("never makes worktree inspection an admission check for manual Resume", async () => {
		mocks.attach
			.mockRejectedValueOnce(new Error("connect to Hmux Host failed"))
			.mockImplementation(() => new Promise(() => {}));
		const resume = vi.fn().mockResolvedValue(undefined);
		const view = renderTerminalView({
			attachRecovery: {
				intent: "resume",
				ownerKey: "fixture-runtime",
				automatic: true,
				resume,
				context: "agent=a-1 pane=p-1 session=s-1",
				worktree: {
					path: "/repo/.worktrees/agent-a",
					branch: "agent/agent-a",
					inspect: () => new Promise(() => {}),
					recreate: vi.fn(),
				},
			},
		});

		const resumeButton = await view.findByRole("button", {
			name: "세션 이어서 재개",
		});
		fireEvent.click(resumeButton);
		await waitFor(() => expect(resume).toHaveBeenCalledTimes(1));
	});

	it.each(["reconnect", "retry_after_resync"] as const)("keeps %s within its budget until a frame arrives", async (retryDirective) => {
		const retryableRefusal = () =>
			Object.assign(
				new Error(
					"Hmux Host refused attach (TransportClosed): structured terminal projection is inconsistent",
				),
				{
					code: "hmux_transport_closed",
					retryDirective,
				},
			);
		const onRecords = installAttachMock((attach) =>
			attach <= 2 ? Promise.reject(retryableRefusal()) : undefined,
		);
		const view = renderTerminalView();

		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(3), {
			timeout: 2_500,
		});
		await deliverViewportFrame(onRecords[2], {
			texts: ["reconnected current Host"],
		});

		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toContain(
				"reconnected current Host",
			),
		);
		expect(
			view.queryByText(/structured terminal projection is inconsistent/),
		).toBeNull();
	});


	it.each(["unknown", "retry_after_resync"] as const)("reattaches a failed %s surface when its exact Host becomes healthy again", async (retryDirective) => {
		const stopFence = stopFenceFixture({ terminalEpoch: "terminal-a" });
		const props = {
			sessionId: "session-health-recovery",
			surfaceId: "pane-a",
			binding: hmuxManagedBinding("session-health-recovery", "workspace-a", undefined, undefined, stopFence),
		};
		const summary = hmuxSessionSummaryFixture({
			sessionId: props.sessionId, workspaceId: "workspace-a",
			terminalEpoch: "terminal-a", stopFence, manifestLifecycle: "ready",
		});
		const state = useStore.getState();
		const previousMetadata = state.hmuxSessionMetadata;
		let accepting = false;
		const failure = retryDirective === "unknown"
			? new Error("transport unavailable")
			: Object.assign(new Error("endpoint unavailable"), {
				code: "hmux_endpoint_unavailable", retryDirective,
			});
		const failedAttempts = retryDirective === "unknown" ? 2 : 11;
		const onRecords = installAttachMock(() => accepting ? undefined : Promise.reject(failure));
		if (retryDirective !== "unknown") vi.useFakeTimers();
		const view = render(<StructuredTerminalView {...props} />);
		const publish = (next: typeof summary) => {
			act(() => state.setHmuxSessionsMetadata([next]));
			// This suite's store factory is intentionally non-reactive; rerender
			// delivers the changed observation through the real component hooks.
			view.rerender(<StructuredTerminalView {...props} />);
		};
		try {
			if (retryDirective !== "unknown") {
				for (let attempt = 0; attempt < failedAttempts; attempt += 1) {
					await act(() => vi.advanceTimersByTimeAsync(4_000));
				}
				vi.useRealTimers();
			}
			await view.findByText(TERMINAL_CONNECTION_FAILURE);
			expect(mocks.attach).toHaveBeenCalledTimes(failedAttempts);
			publish({ ...summary, terminalEpoch: "other", stopFence: { ...stopFence, terminalEpoch: "other" } });
			expect(mocks.attach).toHaveBeenCalledTimes(failedAttempts);
			accepting = true;
			publish(summary);
			await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(failedAttempts + 1));
			await deliverViewportFrame(onRecords[failedAttempts], { texts: ["same Host recovered"] });
			await waitFor(() => expect(visibleTerminalText(view.container)).toContain("same Host recovered"));
			expect(view.queryByText(TERMINAL_CONNECTION_FAILURE)).toBeNull();
			publish({ ...summary, health: "stale_transport" });
			publish(summary);
			expect(mocks.attach).toHaveBeenCalledTimes(failedAttempts + 1);
		} finally {
			view.unmount();
			vi.useRealTimers();
			state.hmuxSessionMetadata = previousMetadata;
		}
	});

	it("resyncs a vanished local endpoint without presenting the transient connect error", async () => {
		const endpointUnavailable = Object.assign(
			new Error(
				"connect to Hmux Host failed: No such file or directory (os error 2)",
			),
			{
				code: "hmux_endpoint_unavailable",
				retryDirective: "retry_after_resync" as const,
			},
		);
		const onRecords = installAttachMock((attach) =>
			attach === 1 ? Promise.reject(endpointUnavailable) : undefined,
		);
		const view = renderTerminalView();

		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		expect(view.queryByText(/No such file or directory/)).toBeNull();

		await deliverViewportFrame(onRecords[1], {
			texts: ["lifecycle resynced"],
		});
		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toContain(
				"lifecycle resynced",
			),
		);
		expect(view.queryByText(/No such file or directory/)).toBeNull();
	});

	// A session that exited while unattached (its Host gone, socket unlinked)
	// refuses attach with hmux_session_exited. That is the same session fact a
	// live stream reports as an exit record, so it must converge through the
	// same exit receipt — not strand the pane on a permanent attach error the
	// exited-recovery UI can never see past.
	it("converges a session-exited attach refusal to the exit receipt", async () => {
		const sessionExited = Object.assign(
			new Error(
				"The exited Hmux session's Host is gone; only its records remain",
			),
			{
				code: "hmux_session_exited",
				retryDirective: "never" as const,
			},
		);
		installAttachMock(() => Promise.reject(sessionExited));
		const onHmuxSessionExit = vi.fn();
		const view = renderTerminalView({ onHmuxSessionExit });

		await waitFor(() => expect(onHmuxSessionExit).toHaveBeenCalledOnce());
		expect(onHmuxSessionExit).toHaveBeenCalledWith({
			reason: "The exited Hmux session's Host is gone; only its records remain",
		});
		// The exit presentation owns this state — no raw failure banner, and no
		// futile reattach loop against a Host that no longer exists.
		expect(view.queryByText(/only its records remain/)).toBeNull();
		await act(
			() => new Promise((resolve) => globalThis.setTimeout(resolve, 300)),
		);
		expect(mocks.attach).toHaveBeenCalledOnce();
	});

	// A surface that consumes no exit receipts (the dedicated agent-session
	// window) must not lose the exit fact to a silent no-op — it falls back to
	// the visible failure the recovery pill can present.
	it("presents the session-exited refusal when no exit consumer exists", async () => {
		const sessionExited = Object.assign(
			new Error(
				"The exited Hmux session's Host is gone; only its records remain",
			),
			{
				code: "hmux_session_exited",
				retryDirective: "never" as const,
			},
		);
		installAttachMock(() => Promise.reject(sessionExited));
		const view = renderTerminalView();

		await view.findByText(TERMINAL_CONNECTION_FAILURE);
		expect(mocks.attach).toHaveBeenCalledOnce();
	});

	// A standalone shell has no exited presentation to converge into — its
	// exited-session recovery is the error-driven respawn, which needs the
	// failure to stay visible instead of vanishing into an exit receipt.
	it("keeps the visible failure for a standalone session-exited refusal", async () => {
		const sessionExited = Object.assign(
			new Error(
				"The exited Hmux session's Host is gone; only its records remain",
			),
			{
				code: "hmux_session_exited",
				retryDirective: "never" as const,
			},
		);
		installAttachMock(() => Promise.reject(sessionExited));
		const onHmuxSessionExit = vi.fn();
		const view = renderTerminalView({
			binding: {
				...binding("session-a"),
				runtime: "hmux_standalone_v1",
			},
			onHmuxSessionExit,
		});

		await view.findByText(TERMINAL_CONNECTION_FAILURE);
		expect(onHmuxSessionExit).not.toHaveBeenCalled();
	});

	it("does not reconnect a Host-declared terminal attach refusal", async () => {
		const terminalRefusal = Object.assign(
			new Error("structured terminal attach is permanently refused"),
			{
				code: "hmux_authorization_denied",
				retryDirective: "never" as const,
			},
		);
		installAttachMock(() => Promise.reject(terminalRefusal));
		const view = renderTerminalView();

		await view.findByText(TERMINAL_CONNECTION_FAILURE);
		await act(
			() => new Promise((resolve) => globalThis.setTimeout(resolve, 300)),
		);

		expect(mocks.attach).toHaveBeenCalledOnce();
	});

	it("cancels a delayed attach reconnect when the pane binding is replaced", async () => {
		const retryableRefusal = Object.assign(
			new Error("legacy viewport seed transport closed"),
			{
				code: "hmux_transport_closed",
				retryDirective: "reconnect" as const,
			},
		);
		const onRecords = installAttachMock((_attach, request) =>
			request.sessionId === "session-a"
				? Promise.reject(retryableRefusal)
				: { terminalEpoch: "terminal-b" },
		);
		const view = render(terminalElement("session-a"));
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());

		view.rerender(terminalElement("session-b"));
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		await act(
			() => new Promise((resolve) => globalThis.setTimeout(resolve, 300)),
		);
		expect(mocks.attach).toHaveBeenCalledTimes(2);

		await deliverViewportFrame(onRecords[1], {
			terminalEpoch: "terminal-b",
			texts: ["replacement binding current"],
		});
		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toContain(
				"replacement binding current",
			),
		);
	});

	it("shows one complete terminal failure without retrying the exited session", async () => {
		const paneHealthId = "desktop-a:agent:agent-a";
		mocks.attach.mockRejectedValue(
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
		const view = renderTerminalView({ paneHealthId });

		const summary = await view.findByText(
			/Managed provider exited before conversation identity was established.*failure_0123456789abcdef/,
		);
		expect(view.queryByRole("button", { name: t("common.close") })).toBeNull();
		expect(mocks.attach).toHaveBeenCalledTimes(1);
		expect(summary.classList.contains("truncate")).toBe(false);
		expect(getHmuxPaneHealth(paneHealthId)).toMatchObject({
			state: "error",
			reason: expect.stringContaining(
				"Managed provider exited before conversation identity was established.",
			),
		});
	});

	it("summarizes an invalid carrier record before replacing the attachment", async () => {
		const onRecords = installAttachMock((attach) =>
			attach === 1 ? undefined : new Promise(() => {}),
		);
		const view = renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0]);

		const invalid = new TextEncoder().encode("not a control record");
		await deliverRecord(onRecords[0], invalid);

		expect(view.getByText(TERMINAL_CONNECTION_FAILURE)).toBeTruthy();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
	});

	// Regression: a reconnectable close while a keystroke was unacknowledged
	// used to surface at once as "the session process is gone", and Resume
	// then replaced a live provider mid-turn. The Host's posture alone decides;
	// the pane reattaches silently whether input or a wheel intent is pending.
	for (const pendingKind of ["input", "wheel"] as const) {
		it(`silently recovers a carrier close when ${pendingKind} is unresolved beside resize`, async () => {
			const onRecords = installAttachMock((attach) => {
				if (attach > 1) return new Promise(() => {});
				return { selectedCapabilities: ["terminal_viewport_wheel_v1"] };
			});
			const view = renderTerminalView();
			sizeStructuredHost(view, 800, 400);
			await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
			await deliverRecord(
				onRecords[0],
				viewportFrameRecord({ texts: Array(20).fill("pending operation") }),
			);
			await flushFrames();
			await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
			mocks.send.mockClear();

			if (pendingKind === "input") {
				pressEnter(terminalInput(view));
				await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));
			} else {
				fireEvent.wheel(terminalViewport(view.container), { deltaY: -120 });
				await flushFrames();
				await waitFor(() =>
					expect(sentRecords("viewportIntent")).toHaveLength(1),
				);
			}

			const closed = closedRecord(
				"hmux_transport_closed",
				`connection closed with pending ${pendingKind}`,
				"reconnect",
			);
			await deliverRecord(onRecords[0], closed);

			expect(
				view.queryByText(
					new RegExp(`connection closed with pending ${pendingKind}`),
				),
			).toBeNull();
			expect(view.queryByText(TERMINAL_CONNECTION_FAILURE)).toBeNull();
			await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		});
	}

	it("reports a pending-input close only once the replacement attach also fails", async () => {
		const onRecords = installAttachMock((attach) => ({
			initialDeliveryRecordCount: attach === 1 ? 1 : 0,
		}));
		const view = renderTerminalView();
		sizeStructuredHost(view, 800, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0]);
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		mocks.send.mockClear();
		pressEnter(terminalInput(view));
		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));

		await deliverRecord(
			onRecords[0],
			closedRecord(
				"hmux_resource_limit",
				"Hmux subscriber output backlog requires snapshot recovery",
				"reconnect",
			),
		);

		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(view.getByText(TERMINAL_CONNECTION_FAILURE)).toBeTruthy(),
		);
		expect(
			view.queryByText(/output backlog requires snapshot recovery/),
		).toBeNull();
	});

	it("shows the replacement missing-frame failure after a deferred close", async () => {
		const onRecords = installAttachMock(() => ({
			initialDeliveryRecordCount: 0,
		}));
		const view = renderTerminalView();
		sizeStructuredHost(view, 800, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0]);
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		await deliverRecord(
			onRecords[0],
			closedRecord(
				"hmux_transport_closed",
				"recover with an initial frame",
				"reconnect",
			),
		);

		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		expect(view.getByText(TERMINAL_CONNECTION_FAILURE)).toBeTruthy();
		expect(view.queryByText(/recover with an initial frame/)).toBeNull();
		expect(mocks.attach).toHaveBeenCalledTimes(2);
		await waitFor(() =>
			expect(mocks.detach).toHaveBeenCalledWith(structuredObserverId(2)),
		);
	});

	it("shows the replacement timeout after a deferred close", async () => {
		const onRecords = installAttachMock((attach) => ({
			initialDeliveryRecordCount: attach === 1 ? 0 : 1,
		}));
		const view = renderTerminalView();
		sizeStructuredHost(view, 800, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({ texts: Array(20).fill("retained deadline") }),
		);
		await flushFrames();
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		const closed = closedRecord(
			"hmux_transport_closed",
			"temporary resize transport failure",
			"reconnect",
		);

		vi.useFakeTimers();
		try {
			await act(async () => {
				onRecords[0]?.(closed.buffer as ArrayBuffer);
				await Promise.resolve();
			});
			expect(mocks.attach).toHaveBeenCalledTimes(2);
			expect(
				view.queryByText(/structured_terminal_attach_initial_delivery_timeout/),
			).toBeNull();

			await act(async () => {
				await vi.advanceTimersByTimeAsync(
					STRUCTURED_TERMINAL_INITIAL_DELIVERY_TIMEOUT_MS,
				);
				await Promise.resolve();
			});

			expect(view.getByText(TERMINAL_CONNECTION_FAILURE)).toBeTruthy();
			expect(view.queryByText(/temporary resize transport failure/)).toBeNull();
			expect(mocks.attach).toHaveBeenCalledTimes(2);
			expect(visibleTerminalText(view.container)).toContain(
				"retained deadline",
			);
			expect(mocks.detach).toHaveBeenCalledWith(structuredObserverId(2));
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not let an old binding frame hide a replacement receipt with no initial frame", async () => {
		const onRecords = installAttachMock((attach) => {
			if (attach > 2) return new Promise(() => {});
			return { terminalEpoch: attach === 1 ? "terminal-a" : "terminal-b" };
		});
		const terminal = terminalElement;
		const view = render(terminal("session-a"));
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				terminalEpoch: "terminal-a",
				texts: ["binding A retained frame"],
			}),
		);
		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toContain(
				"binding A retained frame",
			),
		);

		view.rerender(terminal("session-b"));

		await waitFor(() =>
			expect(view.getByText(TERMINAL_CONNECTION_FAILURE)).toBeTruthy(),
		);
		expect(visibleTerminalText(view.container)).toContain(
			"binding A retained frame",
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(3));
	});

	it("ignores a late source send failure after an exact-token binding replacement", async () => {
		Object.defineProperty(globalThis.crypto, "randomUUID", {
			configurable: true,
			value: () => "00000000-0000-4000-8000-000000000099",
		});
		const onRecords = installAttachMock((attach, request) => {
			if (attach === 2) {
				const replacementSeed = viewportFrameRecord({
					terminalEpoch: "terminal-b",
					texts: ["replacement B remains current"],
				});
				request.onRecord(replacementSeed.buffer as ArrayBuffer);
			}
			return { terminalEpoch: attach === 1 ? "terminal-a" : "terminal-b" };
		});
		const terminal = terminalElement;
		const view = render(terminal("session-a"));
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({ terminalEpoch: "terminal-a" }),
		);
		mocks.send.mockClear();
		let rejectSourceSend!: (cause: Error) => void;
		mocks.send.mockImplementationOnce(
			() =>
				new Promise((_resolve, reject) => {
					rejectSourceSend = reject;
				}),
		);
		pressEnter(terminalInput(view));
		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));

		view.rerender(terminal("session-b"));
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toContain(
				"replacement B remains current",
			),
		);

		await act(async () => {
			rejectSourceSend(new Error("late attachment A send failure"));
		});

		expect(view.queryByText(/late attachment A send failure/)).toBeNull();
		expect(mocks.attach).toHaveBeenCalledTimes(2);
		expect(visibleTerminalText(view.container)).toContain(
			"replacement B remains current",
		);
	});

	it("does not loop when the replacement receives only an initial frame", async () => {
		const { onRecords, view } = await bootTerminalWithFrame();
		mocks.send.mockClear();
		const input = terminalInput(view);
		pressEnter(input);
		await waitFor(() => expect(sentRecords("inputIntent")).toHaveLength(1));
		const [retiredIntent] = sentRecords("inputIntent");
		expect(retiredIntent).toBeDefined();
		const closed = closedRecord(
			"hmux_stream_desynchronized",
			"the Hmux stream is no longer frame-aligned",
			"never",
		);

		await deliverRecords(
			onRecords[0],
			closed,
			inputReceiptRecord(retiredIntent?.metadata.recordId ?? 0n),
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));

		await deliverViewportFrame(onRecords[1]);
		await deliverRecord(onRecords[1], closed);
		expect(mocks.attach).toHaveBeenCalledTimes(2);
	});

	it("paints only the latest complete frame held behind the attach receipt", async () => {
		const { onRecords, resolveAttach } = installDeferredAttachMock();
		const view = renderTerminalView();
		await waitFor(() => expect(onRecords[0]).toBeTypeOf("function"));
		const viewport = terminalViewport(view.container);
		const replaceChildren = viewport.replaceChildren.bind(viewport);
		const presentedTexts: string[] = [];
		vi.spyOn(viewport, "replaceChildren").mockImplementation((...nodes) => {
			replaceChildren(...nodes);
			presentedTexts.push(visibleTerminalText(view.container));
		});
		await act(async () => {
			for (const [revision, text] of [
				[1n, "first"],
				[2n, "discarded"],
				[3n, "latest"],
			] as const) {
				onRecords[0]?.(
					viewportFrameRecord({
						projectionRevision: revision,
						texts: [text],
					}).buffer as ArrayBuffer,
				);
			}
		});
		expect(visibleTerminalText(view.container)).toBe("");
		expect(presentedTexts).toEqual([]);

		await act(async () => {
			resolveAttach({ throughOutputSeq: "1" });
		});
		await flushFrames();

		expect(visibleTerminalText(view.container)).toBe("latest");
		expect(presentedTexts.filter(Boolean)).toEqual(["latest"]);
	});

	it("keeps the last complete frame inert until an ordinary binding replacement paints once", async () => {
		const { onRecords, resolveAttach: resolveReplacement } =
			installDeferredAttachMock(2, (attach) => ({
				terminalEpoch: attach === 1 ? "terminal-a" : "terminal-b",
			}));
		const terminal = terminalElement;
		const view = render(terminal("session-a"));
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			terminalEpoch: "terminal-a",
			texts: ["attachment A complete"],
		});
		expect(visibleTerminalText(view.container)).toBe("attachment A complete");
		const viewport = terminalViewport(view.container);
		const replaceChildren = viewport.replaceChildren.bind(viewport);
		const replacements: string[] = [];
		vi.spyOn(viewport, "replaceChildren").mockImplementation((...nodes) => {
			replaceChildren(...nodes);
			replacements.push(visibleTerminalText(view.container));
		});
		const retiredInput = terminalInput(view);
		mocks.send.mockClear();

		view.rerender(terminal("session-b"));
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));

		expect(visibleTerminalText(view.container)).toBe("attachment A complete");
		expect(retiredInput.disabled).toBe(true);
		pressEnter(retiredInput);
		expect(sentRecords("inputIntent")).toHaveLength(0);
		expect(replacements).toEqual([]);

		await act(async () => {
			onRecords[1]?.(
				viewportFrameRecord({
					terminalEpoch: "terminal-b",
					texts: ["attachment B complete"],
				}).buffer as ArrayBuffer,
			);
			resolveReplacement({ terminalEpoch: "terminal-b" });
		});
		await flushFrames();

		expect(visibleTerminalText(view.container)).toBe("attachment B complete");
		expect(replacements).toEqual(["attachment B complete"]);
	});

	it("keeps the last complete frame inert across a failed replacement attach retry", async () => {
		const { onRecords, resolveAttach: resolveRetry } =
			installDeferredAttachMock(3, (attach) => {
				if (attach === 2) {
					return Promise.reject(new Error("replacement transport unavailable"));
				}
				return { terminalEpoch: attach === 1 ? "terminal-a" : "terminal-b" };
			});
		const terminal = terminalElement;
		const view = render(terminal("session-a"));
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			terminalEpoch: "terminal-a",
			texts: ["last complete attachment A"],
		});
		expect(visibleTerminalText(view.container)).toBe(
			"last complete attachment A",
		);
		mocks.send.mockClear();

		view.rerender(terminal("session-b"));
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(3));
		await flushFrames();

		expect(visibleTerminalText(view.container)).toBe(
			"last complete attachment A",
		);
		expect(view.getByText(TERMINAL_CONNECTION_FAILURE)).toBeTruthy();
		const retiredInput = terminalInput(view);
		expect(retiredInput.disabled).toBe(true);
		pressEnter(retiredInput);
		expect(sentRecords("inputIntent")).toHaveLength(0);

		await act(async () => {
			onRecords[2]?.(
				viewportFrameRecord({
					terminalEpoch: "terminal-b",
					texts: ["replacement attachment B"],
				}).buffer as ArrayBuffer,
			);
			resolveRetry({ terminalEpoch: "terminal-b" });
		});
		await flushFrames();

		expect(visibleTerminalText(view.container)).toBe(
			"replacement attachment B",
		);
		expect(terminalInput(view).disabled).toBe(false);
	});

	it("reattaches again only after the replacement proves a current round trip", async () => {
		const { onRecords, view } = await bootTerminal();
		const closed = closedRecord(
			"hmux_stream_desynchronized",
			"the Hmux stream is no longer frame-aligned",
			"never",
		);

		await deliverRecord(onRecords[0], closed);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		await deliverViewportFrame(onRecords[1]);
		mocks.send.mockClear();
		const input = terminalInput(view);
		pressEnter(input);
		await waitFor(() => expect(sentRecords("inputIntent")).toHaveLength(1));
		const [replacementIntent] = sentRecords("inputIntent");
		expect(replacementIntent).toBeDefined();
		const replacementReceipt = inputReceiptRecord(
			replacementIntent?.metadata.recordId ?? 0n,
		);
		await deliverRecords(onRecords[1], replacementReceipt, closed);

		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(3));
		await act(async () => {
			const thirdSeed = viewportFrameRecord();
			onRecords[2]?.(thirdSeed.buffer as ArrayBuffer);
			onRecords[1]?.(replacementReceipt.buffer as ArrayBuffer);
		});
		await flushFrames();
		await deliverRecord(onRecords[2], closed);
		expect(mocks.attach).toHaveBeenCalledTimes(3);
	});

	it("reattaches once instead of starting client snapshot recovery", async () => {
		const { onRecords } = await bootTerminal();
		const divergent = viewportFrameRecord({ terminalEpoch: "terminal-b" });

		await deliverRecord(onRecords[0], divergent);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));

		await deliverRecord(onRecords[0], divergent);
		expect(mocks.attach).toHaveBeenCalledTimes(2);
	});

	it("consumes one Host exit without a follow-on close pull or recovery", async () => {
		mocks.desktopId = "desk-a";
		const onExit = vi.fn();
		const onRecords = installAttachMock();
		const view = renderTerminalView({ onHmuxSessionExit: onExit });
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await waitFor(() =>
			expect(getWorkspacePerformanceSnapshot().totals).toMatchObject({
				terminalSurfaces: 1,
				hmuxObservers: 1,
			}),
		);
		await deliverViewportFrame(onRecords[0], { texts: ["before exit"] });
		await waitFor(() =>
			expect(
				[...mocks.pullWaiters.values()].reduce(
					(count, waiters) => count + waiters.length,
					0,
				),
			).toBe(1),
		);

		const exit = new TextEncoder().encode(
			JSON.stringify({ kind: "control", body: { kind: "exit" } }),
		);
		await deliverRecord(onRecords[0], exit);
		await waitFor(() => expect(onExit).toHaveBeenCalledOnce());
		await waitFor(() => expect(mocks.detach).toHaveBeenCalledOnce());
		expect(getWorkspacePerformanceSnapshot().totals).toMatchObject({
			terminalSurfaces: 0,
			hmuxObservers: 0,
		});
		await deliverRecord(
			onRecords[0],
			closedRecord(
				"hmux_transport_closed",
				"must remain unread after exit",
				"reconnect",
			),
		);
		await Promise.resolve();

		expect(onExit).toHaveBeenCalledOnce();
		expect(mocks.attach).toHaveBeenCalledOnce();
		expect(view.queryByText(/must remain unread after exit/)).toBeNull();
		expect(
			[...mocks.pullWaiters.values()].reduce(
				(count, waiters) => count + waiters.length,
				0,
			),
		).toBe(0);
		view.unmount();
		expect(mocks.detach).toHaveBeenCalledOnce();
		expect(getWorkspacePerformanceSnapshot().totals).toMatchObject({
			terminalSurfaces: 0,
			hmuxObservers: 0,
		});
	});

	it("delivers the Host exit receipt's code to the session-exit callback", async () => {
		const onExit = vi.fn();
		const onRecords = installAttachMock();
		renderTerminalView({ onHmuxSessionExit: onExit });
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], { texts: ["before exit"] });

		const exit = new TextEncoder().encode(
			JSON.stringify({
				kind: "control",
				body: {
					kind: "exit",
					payload: {
						final_output_seq: "7",
						exit_code: 3,
						platform_status: null,
						reason: "complete",
					},
				},
			}),
		);
		await deliverRecord(onRecords[0], exit);
		await waitFor(() => expect(onExit).toHaveBeenCalledOnce());
		expect(onExit).toHaveBeenCalledWith(
			expect.objectContaining({ exitCode: 3, reason: "complete" }),
		);
	});

	it("drops retired attachment callbacks and a pre-resize projection even when canonical state advanced", async () => {
		const { onRecords, resolveAttach: resolveReplacement } =
			installDeferredAttachMock(2, (attach) => ({
				terminalEpoch: attach === 1 ? "terminal-a" : "terminal-b",
			}));
		const view = renderTerminalView();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await flushFrames();
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 1n,
				appliedIntentSeq: 0n,
				stateRevision: 1n,
				throughOutputSeq: 0n,
				texts: ["attachment A"],
			}),
		);
		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 2n,
				texts: ["pending attachment A"],
			}),
		);
		const pendingPresentationFrame = [...frames.keys()][0];
		expect(pendingPresentationFrame).toBeDefined();
		view.rerender(terminalElement("session-b"));
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		expect(frames.has(pendingPresentationFrame ?? -1)).toBe(false);
		await flushFrames();
		expect(visibleTerminalText(view.container)).toBe("attachment A");
		await act(async () => {
			const resized = viewportFrameRecord({
				terminalEpoch: "terminal-b",
				projectionRevision: 3n,
				appliedIntentSeq: 0n,
				stateRevision: 10n,
				throughOutputSeq: 10n,
				texts: ["attachment B after resize"],
			});
			onRecords[1]?.(resized.buffer as ArrayBuffer);
			resolveReplacement({ terminalEpoch: "terminal-b" });
		});
		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toBe(
				"attachment B after resize",
			),
		);

		await deliverRecord(
			onRecords[0],
			viewportFrameRecord({
				projectionRevision: 99n,
				appliedIntentSeq: 0n,
				stateRevision: 99n,
				throughOutputSeq: 99n,
				texts: ["retired attachment A"],
			}),
		);
		expect(visibleTerminalText(view.container)).toBe(
			"attachment B after resize",
		);

		await deliverRecord(
			onRecords[1],
			viewportFrameRecord({
				terminalEpoch: "terminal-b",
				projectionRevision: 2n,
				appliedIntentSeq: 0n,
				stateRevision: 11n,
				throughOutputSeq: 11n,
				texts: ["attachment B before resize"],
			}),
		);

		expect
			.soft(visibleTerminalText(view.container))
			.toBe("attachment B after resize");
	});
});
