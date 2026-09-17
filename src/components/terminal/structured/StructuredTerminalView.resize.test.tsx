// @vitest-environment jsdom

import {
	act,
	fireEvent,
	render,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MouseTrackingMode,
	ResizeRefusalReason,
} from "@/contracts/terminalStateProtocol";
import {
	beginTerminalDocumentResize,
	finishTerminalDocumentResize,
	subscribeTerminalDocumentResizeLifecycle,
	terminalDocumentResizePhase,
} from "@/lib/terminal/geometry/terminalDocumentResizeTransaction";
import {
	bindTerminalNativeWindowResize,
} from "@/lib/terminal/geometry/terminalNativeWindowResize";
import { collectTerminalGeometryDiagnostics } from "@/lib/terminal/geometry/terminalGeometryDiagnostics";
import {
	decodeTerminalStateRecord,
} from "@/lib/terminal/protocol/terminalStateProtocol";
import {
	structuredTerminalAttachmentRetired,
} from "@/lib/terminal/structuredTerminalAttachPreparation";
import {
	closedRecord,
	inputReceiptRecord,
	resizeAppliedReceiptRecord,
	resizeFailureReceiptRecord,
	resizeHostExitingReceiptRecord,
	resizeRefusedReceiptRecord,
	viewportFrameRecord,
} from "@/test/terminalRecordFixtures";
import { StructuredTerminalView } from "./StructuredTerminalView";
import {
	createWindowFocusProbe,
	deliverRecord,
	deliverRecords,
	deliverViewportFrame,
	expectSingleSemanticResize,
	flushFrames,
	installAttachMock,
	installCanvasPresentationProbe,
	installDeferredAttachMock,
	mocks,
	pointerEvent,
	pressEnter,
	registerStructuredTerminalView,
	renderTerminalBesideOutsideButton,
	renderTerminalView,
	resetStructuredTerminalHarness,
	resizeObservers,
	restoreStructuredTerminalHarness,
	semanticResizeCalls,
	sentInputIntents,
	sentRecords,
	settleInitialResize,
	sizeStructuredHost,
	structuredObserverId,
	terminalElement,
	terminalInput,
	terminalViewport,
	visibleTerminalText,
} from "./structuredTerminalTestHarness";

vi.mock("@/components/workspace/WorkspaceRuntimeContext", async () =>
	(await import("./structuredTerminalTestHarness")).workspaceRuntimeContextMockFactory(),
);

vi.mock("@/lib/workspace/window/largeViewReturnSourceRuntime", async () =>
	(await import("./structuredTerminalTestHarness")).largeViewReturnSourceRuntimeMockFactory(),
);

vi.mock("@/lib/workspace/window/currentWindowFocus", async () =>
	(await import("./structuredTerminalTestHarness")).currentWindowFocusMockFactory(),
);

vi.mock("@/lib/ipc", async () =>
	(await import("./structuredTerminalTestHarness")).ipcMockFactory(),
);

vi.mock("@/store", async () =>
	(await import("./structuredTerminalTestHarness")).storeMockFactory(),
);

vi.mock("@tauri-apps/plugin-clipboard-manager", async () =>
	(await import("./structuredTerminalTestHarness")).clipboardManagerMockFactory(),
);

vi.mock("@/lib/toast", async () =>
	(await import("./structuredTerminalTestHarness")).toastMockFactory(),
);

vi.mock("@/components/terminal/TerminalViewChrome", async () =>
	(await import("./structuredTerminalTestHarness")).terminalViewChromeMockFactory(),
);

vi.mock("./TerminalCanvasRenderer", async () =>
	(await import("./structuredTerminalTestHarness")).terminalCanvasRendererMockFactory(),
);

registerStructuredTerminalView(StructuredTerminalView);

const TERMINAL_CONNECTION_FAILURE = "터미널에 연결하지 못했습니다.";

beforeEach(() => {
	resetStructuredTerminalHarness();
});

afterEach(() => {
	restoreStructuredTerminalHarness();
});

describe("StructuredTerminalView resize transaction", () => {
	it("uses the fractional drawing box for launch and resize instead of rounded client dimensions", async () => {
		const ensure = vi.fn(async () => undefined);
		const onRecords = installAttachMock();
		const view = renderTerminalView({ ensure });
		sizeStructuredHost(view, 799.75, 399.75);

		await waitFor(() => expect(ensure).toHaveBeenCalledOnce());
		expect(ensure).toHaveBeenCalledWith(79, 19);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], { texts: Array(20).fill("x") });
		expectSingleSemanticResize(79, 19);
		await settleInitialResize(onRecords[0], 79, 19, {
			projectionRevision: 2n,
			texts: Array(19).fill("x"),
		});
		expect(collectTerminalGeometryDiagnostics(document).surfaces[0]?.fit).toEqual({
			columns: 79,
			rows: 19,
		});
	});

	it("silently retires an attach whose preparation replaced the pane binding", async () => {
		const ensure = vi.fn(async () =>
			structuredTerminalAttachmentRetired("binding_replaced"),
		);
		const view = renderTerminalView({ ensure });
		sizeStructuredHost(view, 800, 400);

		await waitFor(() => expect(ensure).toHaveBeenCalledOnce());

		expect(mocks.attach).not.toHaveBeenCalled();
		expect(
			view.queryByText(/structured_terminal_attach_retired/),
		).toBeNull();
	});

	it("silently retires an attach whose source was proven absent", async () => {
		const ensure = vi.fn(async () =>
			structuredTerminalAttachmentRetired("source_absent"),
		);
		const view = renderTerminalView({ ensure });
		sizeStructuredHost(view, 800, 400);

		await waitFor(() => expect(ensure).toHaveBeenCalledOnce());

		expect(mocks.attach).not.toHaveBeenCalled();
		expect(
			view.queryByText(/structured_terminal_attach_retired/),
		).toBeNull();
	});

	it("reuses ResizeObserver dimensions instead of forcing layout for every output frame", async () => {
		const onRecords = installAttachMock();
		const view = renderTerminalView();
		sizeStructuredHost(view, 800, 400);
		const surface = terminalViewport(view.container);
		const readLiveBounds = vi.spyOn(surface, "getBoundingClientRect");
		await act(async () => {
			const observer = new ResizeObserver(() => {});
			resizeObservers[0]?.callback(
				[
					{
						borderBoxSize: [{ inlineSize: 800, blockSize: 400 }],
						contentBoxSize: [],
						contentRect: new DOMRect(0, 0, 800, 400),
						devicePixelContentBoxSize: [],
						target: view.getByTestId("structured-host"),
					},
				],
				observer,
			);
		});
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			texts: ["first output"],
		});
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 2n,
			texts: ["second output"],
		});

		expect(readLiveBounds).not.toHaveBeenCalled();
	});

	it("recommits canonical geometry once when font metrics change inside unchanged pane bounds", async () => {
		mocks.measure.mockImplementation(
			(
				width: number,
				height: number,
				_fontFamily: string,
				fontSize: number,
			) => {
				const cellWidth = fontSize === 14 ? 10 : 20;
				const rowHeight = fontSize === 14 ? 20 : 25;
				return {
					cellWidth,
					rowHeight,
					columns: Math.max(1, Math.floor(width / cellWidth)),
					rows: Math.max(1, Math.floor(height / rowHeight)),
					asciiRunCapability: "fixed_cell_advance" as const,
				};
			},
		);
		const onRecords = installAttachMock();
		const terminal = () => terminalElement("session-a");
		const view = render(terminal());
		const host = sizeStructuredHost(view, 800, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], { texts: Array(20).fill("x") });
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		expect(semanticResizeCalls()[0]).toMatchObject({ columns: 80, rows: 20 });
		mocks.send.mockClear();

		mocks.terminalFontSize = 28;
		view.rerender(terminal());
		await flushFrames();

		expect(host.clientWidth).toBe(800);
		expect(host.clientHeight).toBe(400);
		expectSingleSemanticResize(40, 16);
	});

	it("recommits canonical geometry when line height changes inside unchanged pane bounds", async () => {
		mocks.measure.mockImplementation(
			(
				width: number,
				height: number,
				_fontFamily: string,
				_fontSize: number,
				lineHeight: number,
			) => {
				const rowHeight = lineHeight * 10;
				return {
					cellWidth: 10,
					rowHeight,
					columns: Math.max(1, Math.floor(width / 10)),
					rows: Math.max(1, Math.floor(height / rowHeight)),
					asciiRunCapability: "fixed_cell_advance" as const,
				};
			},
		);
		const onRecords = installAttachMock();
		const terminal = () => terminalElement("session-a");
		const view = render(terminal());
		const host = sizeStructuredHost(view, 800, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], { texts: Array(32).fill("x") });
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		expect(semanticResizeCalls()[0]).toMatchObject({ columns: 80, rows: 32 });
		mocks.send.mockClear();

		mocks.terminalLineHeight = 1.5;
		view.rerender(terminal());
		await flushFrames();

		expect(host.clientWidth).toBe(800);
		expect(host.clientHeight).toBe(400);
		expectSingleSemanticResize(80, 26);
	});

	it("keeps one complete presentation visible through an ordinary container resize", async () => {
		const onRecords = installAttachMock();
		let size = { width: 800, height: 400 };
		const view = renderTerminalView();
		sizeStructuredHost(
			view,
			() => size.width,
			() => size.height,
		);
		installCanvasPresentationProbe(view.container, () => size);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			columns: 80,
			texts: ["old complete frame", ...Array(19).fill("")],
		});
		await settleInitialResize(onRecords[0], 80, 20, {
			projectionRevision: 2n,
			texts: ["old complete frame", ...Array(19).fill("")],
		});
		mocks.send.mockClear();

		size = { width: 1_000, height: 600 };
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
			onRecords[0]?.(
				viewportFrameRecord({
					projectionRevision: 3n,
					columns: 80,
					texts: ["new output on old geometry", ...Array(19).fill("")],
				}).buffer as ArrayBuffer,
			);
		});
		await flushFrames();

		expectSingleSemanticResize(100, 30);
		expect(visibleTerminalText(view.container)).toContain("old complete frame");
		expect(visibleTerminalText(view.container)).not.toContain(
			"new output on old geometry",
		);
		const [resize] = sentRecords("inputIntent");
		expect(resize).toBeDefined();

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 4n,
			columns: 100,
			texts: ["matching before receipt", ...Array(29).fill("")],
		});
		expect(visibleTerminalText(view.container)).toContain("old complete frame");
		expect(visibleTerminalText(view.container)).not.toContain(
			"matching before receipt",
		);

		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		await flushFrames();
		expect(visibleTerminalText(view.container)).toContain("old complete frame");
		expect(visibleTerminalText(view.container)).not.toContain(
			"matching before receipt",
		);

		await deliverRecord(
			onRecords[0],
			resizeAppliedReceiptRecord(resize?.metadata.recordId ?? 0n, 100, 30),
		);
		await flushFrames();
		expect(visibleTerminalText(view.container)).toContain("old complete frame");
		expect(visibleTerminalText(view.container)).not.toContain(
			"matching before receipt",
		);

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 5n,
			columns: 100,
			texts: ["matching complete frame", ...Array(29).fill("")],
		});
		expect(visibleTerminalText(view.container)).toContain(
			"matching complete frame",
		);
	});

	it("keeps the exact attachment live through a failed resize and a newer generation", async () => {
		const ensure = vi.fn(async () => undefined);
		const { probe, qaSurface } = createWindowFocusProbe(vi.fn());
		const onRecords = installAttachMock();
		const view = renderTerminalView({ ensure, windowFocusProbe: probe });
		let width = 800;
		sizeStructuredHost(view, () => width, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await waitFor(() => expect(probe.connect).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			texts: ["previous complete frame", ...Array(19).fill("")],
		});
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		mocks.send.mockClear();
		const keyboardInput = terminalInput(view);
		keyboardInput.focus();
		expect(document.activeElement).toBe(keyboardInput);
		const resizeTransaction = beginTerminalDocumentResize(document, "pane-a");
		keyboardInput.blur();
		expect(document.activeElement).toBe(document.body);
		width = 1_000;
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
			finishTerminalDocumentResize(document, "blur", resizeTransaction);
		});
		await waitFor(() =>
			expect(terminalDocumentResizePhase(document)).toBe("idle"),
		);
		await flushFrames();
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		expect(semanticResizeCalls()[0]).toMatchObject({ columns: 100, rows: 20 });
		const [resize] = sentRecords("inputIntent");
		expect(resize).toBeDefined();

		await act(async () => {
			const failed = resizeFailureReceiptRecord(
				resize?.metadata.recordId ?? 0n,
			);
			onRecords[0]?.(failed.buffer as ArrayBuffer);
		});

		expect(view.getByText(/terminal resize failed/)).toBeTruthy();
		expect(visibleTerminalText(view.container)).toContain(
			"previous complete frame",
		);
		expect(mocks.attach).toHaveBeenCalledOnce();
		expect(mocks.detach).not.toHaveBeenCalled();
		expect(ensure).toHaveBeenCalledOnce();
		mocks.send.mockClear();
		await flushFrames();
		expect(semanticResizeCalls()).toHaveLength(0);
		expect(document.activeElement).toBe(keyboardInput);
		pressEnter(document.activeElement as Element);
		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));
		const [physicalInput] = sentInputIntents("key");
		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(physicalInput?.metadata.recordId ?? 0n),
		);
		mocks.send.mockClear();
		fireEvent.wheel(terminalViewport(view.container), { deltaY: -120 });
		await flushFrames();
		await waitFor(() => expect(sentRecords("viewportIntent")).toHaveLength(1));
		mocks.send.mockClear();

		width = 1_100;
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		await flushFrames();
		expectSingleSemanticResize(110, 20);
		const [newerResize] = sentRecords("inputIntent");
		expect(newerResize).toBeDefined();

		await deliverRecords(
			onRecords[0],
			resizeFailureReceiptRecord(resize?.metadata.recordId ?? 0n),
			resizeAppliedReceiptRecord(newerResize?.metadata.recordId ?? 0n, 110, 20),
		);
		expect(view.getByText(/terminal resize failed/)).toBeTruthy();
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 2n,
			throughOutputSeq: 1n,
			columns: 110,
			texts: ["output after resize failure", ...Array(19).fill("")],
		});
		expect(visibleTerminalText(view.container)).toContain(
			"output after resize failure",
		);
		expect(view.queryByText(/terminal resize failed/)).toBeNull();

		mocks.send.mockClear();
		const inputAcknowledgement = qaSurface().writeMarker(
			"HMUX_RESIZE_FAILURE_LIVENESS",
		);
		await waitFor(() => expect(sentInputIntents("text")).toHaveLength(1));
		const [input] = sentInputIntents("text");
		await deliverRecord(
			onRecords[0],
			inputReceiptRecord(input?.metadata.recordId ?? 0n),
		);
		await expect(inputAcknowledgement).resolves.toMatchObject({
			requestId: String(input?.metadata.recordId),
			state: "written_to_pty",
		});
		expect(input?.record.terminalEpoch).toBe("terminal-a");

		const competingControl = document.createElement("button");
		document.body.append(competingControl);
		keyboardInput.focus();
		const competingTransaction = beginTerminalDocumentResize(document, "pane-a");
		competingControl.focus();
		finishTerminalDocumentResize(document, "blur", competingTransaction);
		await waitFor(() =>
			expect(terminalDocumentResizePhase(document)).toBe("idle"),
		);
		expect(document.activeElement).toBe(competingControl);
		competingControl.remove();
		expect(mocks.attach).toHaveBeenCalledOnce();
		expect(mocks.detach).not.toHaveBeenCalled();
	});

	it("keeps a resize transport recovery silent while the last complete frame remains visible", async () => {
		const onRecords = installAttachMock((attach) => ({
			initialDeliveryRecordCount: attach === 2 ? 1 : 0,
		}));
		let width = 800;
		const view = renderTerminalView();
		sizeStructuredHost(view, () => width, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			columns: 80,
			texts: ["last complete frame", ...Array(19).fill("")],
		});
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		mocks.send.mockClear();

		width = 1_000;
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		await flushFrames();
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));

		await deliverRecord(
			onRecords[0],
			closedRecord(
				"hmux_transport_closed",
				"temporary resize transport failure",
				"reconnect",
			),
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));

		expect(visibleTerminalText(view.container)).toContain(
			"last complete frame",
		);
		expect(terminalInput(view).disabled).toBe(true);
		expect(view.queryByText(/temporary resize transport failure/)).toBeNull();
		const delayedSeed = viewportFrameRecord({
			projectionRevision: 2n,
			throughOutputSeq: 1n,
			columns: 100,
			texts: Array(20).fill("seed".repeat(25)),
		});
		expect(delayedSeed.byteLength).toBeGreaterThan(1_024);
		await act(async () => {
			await Promise.resolve();
			onRecords[1]?.(delayedSeed.buffer as ArrayBuffer);
		});

		mocks.send.mockClear();
		await flushFrames();
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		expect(view.queryByText(/temporary resize transport failure/)).toBeNull();
		const [replacementResize] = sentRecords("inputIntent");
		expect(replacementResize).toBeDefined();

		await deliverRecords(
			onRecords[1],
			resizeAppliedReceiptRecord(
				replacementResize?.metadata.recordId ?? 0n,
				100,
				20,
			),
			viewportFrameRecord({
				projectionRevision: 3n,
				throughOutputSeq: 2n,
				columns: 100,
				texts: ["replacement complete frame", ...Array(19).fill("")],
			}),
		);
		await flushFrames();

		await waitFor(() =>
			expect(visibleTerminalText(view.container)).toContain(
				"replacement complete frame",
			),
		);
		expect(view.queryByText(/temporary resize transport failure/)).toBeNull();
	});

	it("recovers a native document resize close before its deferred semantic resize", async () => {
		const onRecords = installAttachMock((attach) => ({
			initialDeliveryRecordCount: attach === 2 ? 1 : 0,
		}));
		let width = 800;
		const view = renderTerminalView();
		sizeStructuredHost(view, () => width, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			columns: 80,
			texts: ["last complete frame", ...Array(19).fill("")],
		});
		await settleInitialResize(onRecords[0], 80, 20, {
			projectionRevision: 2n,
			throughOutputSeq: 1n,
			columns: 80,
			texts: ["last complete frame", ...Array(19).fill("")],
		});
		mocks.send.mockClear();

		let nativeResize!: (phase: "begin" | "end") => void;
		const disposeNativeResize = bindTerminalNativeWindowResize(
			document,
			"pane-a",
			async (listener) => {
				nativeResize = listener;
				return () => {};
			},
		);
		await Promise.resolve();
		nativeResize("begin");
		width = 1_000;
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		await flushFrames();
		expect(semanticResizeCalls()).toHaveLength(0);

		const closed = closedRecord(
			"hmux_transport_closed",
			"native resize transport closed",
			"reconnect",
		);
		await deliverRecord(onRecords[0], closed);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));

		expect(visibleTerminalText(view.container)).toContain(
			"last complete frame",
		);
		expect(view.queryByText(/native resize transport closed/)).toBeNull();
		expect(terminalInput(view).disabled).toBe(true);

		await act(async () => {
			onRecords[1]?.(
				viewportFrameRecord({
					projectionRevision: 3n,
					throughOutputSeq: 2n,
					columns: 100,
					texts: ["replacement complete frame", ...Array(19).fill("")],
				}).buffer as ArrayBuffer,
			);
			await Promise.resolve();
		});
		await flushFrames();
		expect(visibleTerminalText(view.container)).toContain(
			"last complete frame",
		);
		expect(view.queryByText(/native resize transport closed/)).toBeNull();

		nativeResize("end");
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		const [replacementResize] = sentRecords("inputIntent");
		expect(semanticResizeCalls()[0]?.observerId).toBe(structuredObserverId(2));
		await deliverRecords(
			onRecords[1],
			resizeAppliedReceiptRecord(
				replacementResize?.metadata.recordId ?? 0n,
				100,
				20,
			),
			viewportFrameRecord({
				projectionRevision: 4n,
				throughOutputSeq: 3n,
				columns: 100,
				texts: ["replacement current frame", ...Array(19).fill("")],
			}),
		);
		await flushFrames();
		expect(view.queryByText(/native resize transport closed/)).toBeNull();
		expect(mocks.attach).toHaveBeenCalledTimes(2);
		expect(visibleTerminalText(view.container)).toContain(
			"replacement current frame",
		);

		mocks.send.mockClear();
		pressEnter(terminalInput(view));
		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));
		expect(mocks.send.mock.calls[0]?.[0]).toBe(structuredObserverId(2));
		disposeNativeResize();
	});

	it("shows the bounded replacement attach failure after a resize send recovery", async () => {
		let rejectReplacement!: (cause: Error) => void;
		const onRecords = installAttachMock((attach) => {
			if (attach === 1) return undefined;
			return new Promise((_resolve, reject) => {
				rejectReplacement = reject;
			});
		});
		let width = 800;
		const view = renderTerminalView();
		sizeStructuredHost(view, () => width, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			columns: 80,
			texts: ["retained resize frame", ...Array(19).fill("")],
		});
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		mocks.send.mockClear();
		mocks.send.mockRejectedValueOnce(
			new Error("resize transport send unavailable"),
		);

		width = 1_000;
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		await flushFrames();
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));

		expect(visibleTerminalText(view.container)).toContain(
			"retained resize frame",
		);
		expect(view.queryByText(/resize transport send unavailable/)).toBeNull();
		expect(terminalInput(view).disabled).toBe(true);

		await act(async () => {
			rejectReplacement(new Error("replacement attach unavailable"));
		});
		await waitFor(() =>
			expect(view.getByText(TERMINAL_CONNECTION_FAILURE)).toBeTruthy(),
		);
		expect(view.queryByText(/replacement attach unavailable/)).toBeNull();
		expect(view.queryByText(/resize transport send unavailable/)).toBeNull();
		expect(mocks.attach).toHaveBeenCalledTimes(2);
	});

	for (const pendingKind of ["input", "wheel"] as const) {
		it(`${pendingKind === "input" ? "keeps" : "silently recovers"} a rejected resize send while ${pendingKind} is unresolved`, async () => {
			const onRecords = installAttachMock((attach) => {
				if (attach > 1) return new Promise(() => {});
				return { selectedCapabilities: ["terminal_viewport_wheel_v1"] };
			});
			let width = 800;
			const view = renderTerminalView();
			sizeStructuredHost(view, () => width, 400);
			await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
			await deliverViewportFrame(onRecords[0], {
				texts: [`pending ${pendingKind}`, ...Array(19).fill("")],
			});
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
			mocks.send.mockRejectedValueOnce(
				new Error(`resize transport failed with pending ${pendingKind}`),
			);

			width = 1_000;
			await act(async () => {
				resizeObservers[0]?.callback([], {} as ResizeObserver);
			});
			await flushFrames();

			await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
			const resizeFailure = new RegExp(
				`resize transport failed with pending ${pendingKind}`,
			);
			if (pendingKind === "input") {
				expect(view.getByText(resizeFailure)).toBeTruthy();
			} else {
				expect(view.queryByText(resizeFailure)).toBeNull();
			}
			expect(visibleTerminalText(view.container)).toContain(
				`pending ${pendingKind}`,
			);
		});
	}

	it("releases the resize hold after a correlated Host refusal and paints later output", async () => {
		const onRecords = installAttachMock();
		let width = 800;
		const view = renderTerminalView();
		sizeStructuredHost(view, () => width, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			columns: 80,
			texts: ["before refused resize", ...Array(19).fill("")],
		});
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		mocks.send.mockClear();

		beginTerminalDocumentResize(document, "pane-a");
		width = 1_000;
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		await flushFrames();
		expect(semanticResizeCalls()).toHaveLength(0);
		finishTerminalDocumentResize(document, "blur");
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		const [resize] = sentRecords("inputIntent");
		expect(resize).toBeDefined();

		await deliverRecord(
			onRecords[0],
			resizeHostExitingReceiptRecord(resize?.metadata.recordId ?? 0n),
		);
		expect(view.getByText(/terminal resize refused/)).toBeTruthy();

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 2n,
			columns: 80,
			texts: ["output after refused resize", ...Array(19).fill("")],
		});

		expect(visibleTerminalText(view.container).split("\n")[0]).toBe(
			"output after refused resize",
		);
		expect(view.getByText(/terminal resize refused/)).toBeTruthy();
		expect(mocks.attach).toHaveBeenCalledOnce();
		expect(mocks.detach).not.toHaveBeenCalled();
		mocks.send.mockClear();
		pressEnter(terminalInput(view));
		await waitFor(() => expect(sentRecords("inputIntent")).toHaveLength(1));
		expect(mocks.send.mock.calls[0]?.[0]).toBe(structuredObserverId(1));
		expect(sentRecords("inputIntent")[0]?.record.terminalEpoch).toBe(
			"terminal-a",
		);
	});

	it("retries the same measured geometry after a transient Host resource refusal", async () => {
		const onRecords = installAttachMock();
		const view = renderTerminalView();
		sizeStructuredHost(view, 1_000, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			columns: 40,
			texts: ["recovered at 40 columns", ...Array(19).fill("")],
		});
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		const first = sentRecords("inputIntent")[0];
		expect(first).toBeDefined();

		await deliverRecord(
			onRecords[0],
			resizeRefusedReceiptRecord(
				first?.metadata.recordId ?? 0n,
				ResizeRefusalReason.RESOURCE_LIMIT,
			),
		);
		expect(view.queryByText(/terminal resize refused/)).toBeNull();
		await flushFrames();
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(2));
		const second = sentRecords("inputIntent")[1];
		expect(second?.metadata.recordId).toBeGreaterThan(
			first?.metadata.recordId ?? 0n,
		);
		expect(semanticResizeCalls()).toEqual([
			{ observerId: expect.any(String), columns: 100, rows: 20 },
			{ observerId: expect.any(String), columns: 100, rows: 20 },
		]);

		await deliverRecord(
			onRecords[0],
			resizeAppliedReceiptRecord(second?.metadata.recordId ?? 0n, 100, 20),
		);
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 2n,
			columns: 100,
			texts: ["recovered at full width", ...Array(19).fill("")],
		});

		expect(visibleTerminalText(view.container).split("\n")[0]).toBe(
			"recovered at full width",
		);
		expect(view.queryByText(/terminal resize refused/)).toBeNull();
	});

	it("does not retry invalid dimensions and names the refusal", async () => {
		const onRecords = installAttachMock();
		const view = renderTerminalView();
		sizeStructuredHost(view, 1_000, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			columns: 40,
			texts: ["invalid resize remains visible", ...Array(19).fill("")],
		});
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		const resize = sentRecords("inputIntent")[0];

		await deliverRecord(
			onRecords[0],
			resizeRefusedReceiptRecord(
				resize?.metadata.recordId ?? 0n,
				ResizeRefusalReason.INVALID_TERMINAL_DIMENSIONS,
			),
		);
		await flushFrames();

		expect(semanticResizeCalls()).toHaveLength(1);
		expect(
			view.getByText(/terminal resize refused: invalid_terminal_dimensions/),
		).toBeTruthy();
		expect(view.queryByText(/terminal resize refused: 4/)).toBeNull();
	});

	it("waits for attach before publishing the first observed geometry", async () => {
		const geometryObserved = vi.fn();
		const { onRecords, resolveAttach } = installDeferredAttachMock();
		const view = renderTerminalView({ onGeometryObserved: geometryObserved });
		sizeStructuredHost(view, 800, 400);

		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		await flushFrames();
		expect(semanticResizeCalls()).toHaveLength(0);

		await act(async () => {
			resolveAttach();
		});
		await flushFrames();
		expect(semanticResizeCalls()).toHaveLength(0);
		expect(geometryObserved).not.toHaveBeenCalled();

		await deliverViewportFrame(onRecords[0]);
		expectSingleSemanticResize(80, 20);
		expect(geometryObserved).toHaveBeenCalledOnce();
	});

	it("retries ordinary geometry when the attach receipt precedes the first complete frame", async () => {
		const { onRecords, resolveAttach } = installDeferredAttachMock();
		const view = renderTerminalView();
		sizeStructuredHost(view, 800, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());

		await act(async () => {
			resolveAttach();
		});
		await flushFrames();
		expect(semanticResizeCalls()).toHaveLength(0);

		await deliverViewportFrame(onRecords[0]);
		expectSingleSemanticResize(80, 20);
	});

	it("publishes geometry through semantic records without a legacy resize path", async () => {
		installAttachMock((_attach, request) => {
			request.onRecord(viewportFrameRecord().buffer as ArrayBuffer);
			return undefined;
		});
		const view = renderTerminalView();
		sizeStructuredHost(view, 800, 400);

		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await flushFrames();
		await waitFor(() => expect(mocks.send).toHaveBeenCalledOnce());

		const records = mocks.send.mock.calls.map(([, encoded]) =>
			decodeTerminalStateRecord(encoded as Uint8Array),
		);
		expect(
			records.some(
				({ record }) =>
					record.body.case === "viewportIntent" &&
					record.body.value.intent.case === "setViewportRows",
			),
		).toBe(false);
		expect(
			records.some(
				({ record }) =>
					record.body.case === "inputIntent" &&
					record.body.value.intent.case === "resize" &&
					record.body.value.intent.value.columns === 80 &&
					record.body.value.intent.value.rows === 20 &&
					record.body.value.intent.value.geometryGeneration === 1n,
			),
		).toBe(true);
		expect(semanticResizeCalls()).toHaveLength(1);
	});

	it("keeps canonical geometry silent while its desktop is hidden and publishes it on reveal", async () => {
		// A warm desktop attaches its terminals while hidden (prewarm); the
		// skipped subtree measures 0x0, which must never reach the Host.
		mocks.workspaceActive = false;
		const { onRecords, resolveAttach } = installDeferredAttachMock();
		const view = renderTerminalView();
		let width = 0;
		let height = 0;
		sizeStructuredHost(view, () => width, () => height);
		await waitFor(() => expect(onRecords[0]).toBeTypeOf("function"));
		await act(async () => {
			onRecords[0]?.(
				viewportFrameRecord({ texts: ["hello"] }).buffer as ArrayBuffer,
			);
			resolveAttach();
		});
		await flushFrames();
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		await flushFrames();
		expect(semanticResizeCalls()).toHaveLength(0);
		expect(visibleTerminalText(view.container)).toContain("hello");

		width = 800;
		height = 400;
		mocks.workspaceActive = true;
		await act(async () => {
			view.rerender(terminalElement("session-a"));
		});
		await flushFrames();
		// The skipped subtree never delivered a real box: the reveal waits for
		// the ResizeObserver instead of forcing a layout.
		expect(semanticResizeCalls()).toHaveLength(0);
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		await flushFrames();
		expectSingleSemanticResize(80, 20);
	});

	it("reconfirms an unchanged grid silently when a retained desktop reveals", async () => {
		const { onRecords, resolveAttach } = installDeferredAttachMock();
		const view = renderTerminalView();
		let width = 800;
		let height = 400;
		sizeStructuredHost(view, () => width, () => height);
		await waitFor(() => expect(onRecords[0]).toBeTypeOf("function"));
		await act(async () => {
			onRecords[0]?.(viewportFrameRecord().buffer as ArrayBuffer);
			resolveAttach();
		});
		await flushFrames();
		await settleInitialResize(onRecords[0], 80, 20, { texts: ["hello"] });
		mocks.send.mockClear();

		mocks.workspaceActive = false;
		await act(async () => {
			view.rerender(terminalElement("session-a"));
		});
		width = 0;
		height = 0;
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		await flushFrames();
		expect(semanticResizeCalls()).toHaveLength(0);

		width = 800;
		height = 400;
		mocks.workspaceActive = true;
		await act(async () => {
			view.rerender(terminalElement("session-a"));
		});
		await flushFrames();
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		await flushFrames();
		expect(semanticResizeCalls()).toHaveLength(0);
	});

	it("retains the complete bitmap through drag observations and commits only the final grid", async () => {
		const { onRecords, resolveAttach } = installDeferredAttachMock();
		const view = renderTerminalView();
		let width = 800;
		sizeStructuredHost(view, () => width, 400);
		await waitFor(() => expect(onRecords[0]).toBeTypeOf("function"));
		await act(async () => {
			const initial = viewportFrameRecord();
			onRecords[0]?.(initial.buffer as ArrayBuffer);
			resolveAttach();
		});
		await flushFrames();
		expect(semanticResizeCalls()).toContainEqual({
			observerId: structuredObserverId(1),
			columns: 80,
			rows: 20,
		});
		mocks.send.mockClear();

		const sash = document.createElement("div");
		sash.className = "dv-sash";
		document.body.appendChild(sash);
		sash.dispatchEvent(pointerEvent("pointerdown"));
		width = 900;
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		width = 1_000;
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		await flushFrames();
		expect(semanticResizeCalls()).toHaveLength(0);
		document.body.dispatchEvent(pointerEvent("pointerup"));
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		expectSingleSemanticResize(100, 20);
		sash.remove();
	});

	it("paints the first complete frame on a fresh surface before holding later native-resize frames", async () => {
		const { onRecords, resolveAttach } = installDeferredAttachMock();
		beginTerminalDocumentResize(document, "pane-a");
		const firstPaint = vi.fn();
		const view = renderTerminalView({ onFirstPaint: firstPaint });
		sizeStructuredHost(view, 800, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());

		await act(async () => {
			resolveAttach();
		});
		await flushFrames();

		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			columns: 120,
			texts: ["first large-view frame", ...Array(19).fill("")],
		});
		expect(firstPaint).toHaveBeenCalledOnce();
		expect(visibleTerminalText(view.container).split("\n")[0]).toBe(
			"first large-view frame",
		);
		expect(semanticResizeCalls()).toHaveLength(0);
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 2n,
			columns: 120,
			texts: ["latest held frame", ...Array(19).fill("")],
		});

		finishTerminalDocumentResize(document, "blur");
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		await flushFrames();
		expect(firstPaint).toHaveBeenCalledOnce();
		expect(visibleTerminalText(view.container).split("\n")[0]).toBe(
			"latest held frame",
		);
	});

	it("finishes a fresh large-view transaction from the first current attachment frame and sends one large geometry", async () => {
		const { onRecords, resolveAttach } = installDeferredAttachMock();
		const resizeGeneration = beginTerminalDocumentResize(document, "pane-a");
		const geometryObserved = vi.fn(() =>
			finishTerminalDocumentResize(document, "surface_ready", resizeGeneration),
		);
		const view = renderTerminalView({ onGeometryObserved: geometryObserved });
		sizeStructuredHost(view, 1_200, 600);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());

		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
			resolveAttach({ throughOutputSeq: "1" });
			const initial = viewportFrameRecord({
				projectionRevision: 1n,
				columns: 80,
				texts: ["source-sized first frame", ...Array(19).fill("")],
			});
			onRecords[0]?.(initial.buffer as ArrayBuffer);
		});
		await flushFrames();

		expect(geometryObserved).toHaveBeenCalledOnce();
		await waitFor(() =>
			expect(terminalDocumentResizePhase(document)).toBe("idle"),
		);
		expectSingleSemanticResize(120, 30);
	});

	it("retains live Host frames without painting until a native resize commits its final geometry", async () => {
		const { onRecords, resolveAttach } = installDeferredAttachMock();
		const { view, outside } = renderTerminalBesideOutsideButton();
		let width = 800;
		sizeStructuredHost(view, () => width, 400);
		await waitFor(() => expect(onRecords[0]).toBeTypeOf("function"));
		await act(async () => {
			const initial = viewportFrameRecord({
				projectionRevision: 1n,
				texts: ["anchored before native resize", ...Array(19).fill("")],
				followTail: false,
				hasMoreBefore: true,
			});
			onRecords[0]?.(initial.buffer as ArrayBuffer);
			resolveAttach({ throughOutputSeq: "1" });
		});
		await flushFrames();
		await settleInitialResize(onRecords[0], 80, 20, {
			projectionRevision: 2n,
			texts: ["anchored before native resize", ...Array(19).fill("")],
			followTail: false,
			hasMoreBefore: true,
		});
		mocks.send.mockClear();
		let finishLifecycle!: () => void;
		const unsubscribeLifecycle = subscribeTerminalDocumentResizeLifecycle(
			document,
			{
				begin: () => {},
				settle: () =>
					new Promise<void>((resolve) => {
						finishLifecycle = resolve;
					}),
			},
		);

		beginTerminalDocumentResize(document, "pane-a");
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 3n,
			columns: 80,
			texts: ["live output before geometry", ...Array(19).fill("")],
			followTail: false,
			hasMoreBefore: true,
		});
		for (const [index, observedWidth] of [900, 1_200, 1_600].entries()) {
			width = observedWidth;
			await act(async () => {
				resizeObservers[0]?.callback([], {} as ResizeObserver);
				const intermediate = viewportFrameRecord({
					projectionRevision: BigInt(index + 4),
					columns: 80,
					texts: [`live output ${index + 1}`, ...Array(19).fill("")],
					followTail: false,
					hasMoreBefore: true,
				});
				onRecords[0]?.(intermediate.buffer as ArrayBuffer);
			});
			await flushFrames();
		}

		expect(semanticResizeCalls()).toHaveLength(0);
		expect(document.activeElement).toBe(outside);

		finishTerminalDocumentResize(document, "blur");
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		expectSingleSemanticResize(160, 20);
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		const [finalResize] = sentRecords("inputIntent");

		await deliverRecords(
			onRecords[0],
			resizeAppliedReceiptRecord(finalResize?.metadata.recordId ?? 0n, 200, 20),
			viewportFrameRecord({
				projectionRevision: 7n,
				columns: 200,
				texts: ["anchored after native resize", ...Array(19).fill("")],
				followTail: false,
				hasMoreBefore: true,
			}),
		);
		await flushFrames();

		finishLifecycle();
		await flushFrames();
		expect(visibleTerminalText(view.container).split("\n")[0]).toBe(
			"anchored after native resize",
		);
		expect(document.activeElement).toBe(outside);
		unsubscribeLifecycle();
	});

	it("repaints the latest retained frame once when a resize ends on the same grid", async () => {
		const onRecords = installAttachMock();
		vi.stubGlobal("devicePixelRatio", 2);
		const view = renderTerminalView();
		let size = { width: 800.25, height: 400.25 };
		sizeStructuredHost(
			view,
			() => size.width,
			() => size.height,
		);
		const presentation = installCanvasPresentationProbe(
			view.container,
			() => size,
		);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await deliverViewportFrame(onRecords[0], {
			projectionRevision: 1n,
			texts: ["before same-grid resize"],
		});
		await settleInitialResize(onRecords[0], 80, 20, {
			projectionRevision: 2n,
			texts: ["before same-grid resize", ...Array(19).fill("")],
		});
		mocks.send.mockClear();

		beginTerminalDocumentResize(document);
		size = { width: 805.75, height: 403.75 };
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
			const latest = viewportFrameRecord({
				projectionRevision: 3n,
				texts: ["latest same-grid output"],
			});
			onRecords[0]?.(latest.buffer as ArrayBuffer);
		});
		await flushFrames();
		expect(semanticResizeCalls()).toHaveLength(0);
		expect(presentation.rect()).toMatchObject({
			width: 800.25,
			height: 400.25,
			top: 3.5,
		});
		finishTerminalDocumentResize(document, "blur");
		await flushFrames();
		expect(semanticResizeCalls()).toHaveLength(0);
		expect(visibleTerminalText(view.container)).toBe("latest same-grid output");
	});

	it("keeps the rehosted complete frame interactive while final geometry is pending", async () => {
		const onRecords = installAttachMock((attach, request) => {
			if (attach === 1) {
				const initial = viewportFrameRecord({
					texts: ["painted attachment A"],
					mouseTracking: MouseTrackingMode.ANY,
				});
				request.onRecord(initial.buffer as ArrayBuffer);
			} else {
				const rehostSeed = viewportFrameRecord({
					terminalEpoch: "terminal-b",
					projectionRevision: 1n,
					throughOutputSeq: 0n,
					columns: 80,
					texts: ["rehost before final geometry", ...Array(19).fill("")],
				});
				request.onRecord(rehostSeed.buffer as ArrayBuffer);
			}
			return { terminalEpoch: attach === 1 ? "terminal-a" : "terminal-b" };
		});
		const view = renderTerminalView();
		let width = 800;
		sizeStructuredHost(view, () => width, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await flushFrames();
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		mocks.send.mockClear();

		const sash = document.createElement("div");
		sash.className = "dv-sash";
		document.body.appendChild(sash);
		sash.dispatchEvent(pointerEvent("pointerdown"));
		width = 1_100;
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		view.rerender(terminalElement("session-b"));
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		await flushFrames();
		expect(semanticResizeCalls()).toHaveLength(0);

		document.body.dispatchEvent(pointerEvent("pointerup"));
		await flushFrames();
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		expectSingleSemanticResize(110, 20, 2);
		const [rehostResize] = sentRecords("inputIntent");
		expect(rehostResize).toBeDefined();
		mocks.send.mockClear();
		const rehostInput = terminalInput(view);
		expect(visibleTerminalText(view.container)).toContain(
			"rehost before final geometry",
		);
		expect(rehostInput.disabled).toBe(false);
		fireEvent.focus(rehostInput);
		pressEnter(rehostInput);
		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));
		mocks.send.mockClear();

		await deliverRecords(
			onRecords[1],
			resizeAppliedReceiptRecord(
				rehostResize?.metadata.recordId ?? 0n,
				110,
				20,
				"terminal-b",
			),
			viewportFrameRecord({
				terminalEpoch: "terminal-b",
				projectionRevision: 2n,
				throughOutputSeq: 1n,
				columns: 110,
				texts: ["rehost at final geometry", ...Array(19).fill("")],
			}),
		);
		await flushFrames();
		expect(visibleTerminalText(view.container)).toContain(
			"rehost at final geometry",
		);
		expect(rehostInput.disabled).toBe(false);
		sash.remove();
	});

	it("does not let a stale resize failure keep an exact-resume attachment inert", async () => {
		const onRecords = installAttachMock((attach, request) => {
			const terminalEpoch = attach === 1 ? "terminal-a" : "terminal-b";
			const seed = viewportFrameRecord({
				terminalEpoch,
				projectionRevision: 1n,
				throughOutputSeq: 0n,
				columns: 80,
				texts: [
					attach === 1 ? "source before failed rehost" : "exact resume seed",
					...Array(19).fill(""),
				],
			});
			request.onRecord(seed.buffer as ArrayBuffer);
			return { terminalEpoch };
		});
		const view = renderTerminalView();
		let width = 800;
		sizeStructuredHost(view, () => width, 400);
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledOnce());
		await flushFrames();
		await settleInitialResize(onRecords[0], 80, 20, {
			projectionRevision: 2n,
			throughOutputSeq: 1n,
			columns: 80,
			texts: ["source settled", ...Array(19).fill("")],
		});
		mocks.send.mockClear();

		const transaction = beginTerminalDocumentResize(document, "pane-a");
		width = 1_100;
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		view.rerender(terminalElement("session-b"));
		await waitFor(() => expect(mocks.attach).toHaveBeenCalledTimes(2));
		await flushFrames();
		finishTerminalDocumentResize(document, "blur", transaction);
		await flushFrames();
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(1));
		const [olderResize] = sentRecords("inputIntent");

		width = 1_200;
		await act(async () => {
			resizeObservers[0]?.callback([], {} as ResizeObserver);
		});
		await flushFrames();
		await waitFor(() => expect(semanticResizeCalls()).toHaveLength(2));
		const newerResize = sentRecords("inputIntent")[1];
		await deliverRecord(
			onRecords[1],
			resizeFailureReceiptRecord(
				olderResize?.metadata.recordId ?? 0n,
				"terminal-b",
			),
		);
		await flushFrames();

		expect(view.getByText(/terminal resize failed/)).toBeTruthy();
		expect(semanticResizeCalls()).toHaveLength(2);
		expect(visibleTerminalText(view.container)).toContain("exact resume seed");
		const input = terminalInput(view);
		expect(input.disabled).toBe(false);
		mocks.send.mockClear();
		pressEnter(input);
		await waitFor(() => expect(sentInputIntents("key")).toHaveLength(1));
		const [key] = sentInputIntents("key");
		await deliverRecords(
			onRecords[1],
			inputReceiptRecord(key?.metadata.recordId ?? 0n, "terminal-b"),
			resizeAppliedReceiptRecord(
				newerResize?.metadata.recordId ?? 0n,
				120,
				20,
				"terminal-b",
			),
			viewportFrameRecord({
				terminalEpoch: "terminal-b",
				projectionRevision: 2n,
				throughOutputSeq: 1n,
				columns: 120,
				texts: ["exact resume final output", ...Array(19).fill("")],
			}),
		);
		await flushFrames();
		await flushFrames();
		expect(visibleTerminalText(view.container)).toContain(
			"exact resume final output",
		);
		expect(mocks.attach).toHaveBeenCalledTimes(2);
	});
});
